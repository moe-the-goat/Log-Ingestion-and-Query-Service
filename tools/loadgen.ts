import { parseArgs } from 'node:util';
import { Pool } from 'undici';

const LEVELS = ['debug', 'info', 'info', 'info', 'warn', 'error'];
const SERVICES = ['checkout', 'auth', 'search', 'billing', 'inventory', 'notifications'];
const REGIONS = ['eu-west', 'us-east', 'ap-south'];
const MESSAGES = [
  'payment declined',
  'payment accepted',
  'token issued',
  'token expiring',
  'cache miss',
  'upstream timeout',
  'request completed',
  'inventory reserved',
];

interface Options {
  url: string;
  durationSeconds: number;
  concurrency: number;
  connections: number;
  batchSize: number;
  warmupSeconds: number;
  label: string;
  spreadDays: number;
}

function readOptions(): Options {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'http://127.0.0.1:8080' },
      duration: { type: 'string', default: '30' },
      concurrency: { type: 'string', default: '32' },
      connections: { type: 'string', default: '16' },
      batch: { type: 'string', default: '200' },
      warmup: { type: 'string', default: '5' },
      label: { type: 'string', default: 'run' },
      'spread-days': { type: 'string', default: '0' },
    },
  });

  return {
    url: values.url ?? 'http://127.0.0.1:8080',
    durationSeconds: Number(values.duration),
    concurrency: Number(values.concurrency),
    connections: Number(values.connections),
    batchSize: Number(values.batch),
    warmupSeconds: Number(values.warmup),
    // Named by the caller: the generator runs outside the container and cannot see which
    // write path the service was started with, so guessing it would mislabel results.
    label: values.label ?? 'run',
    // Backdating entries is legal per the contract and lets a month of history be loaded
    // through the public API, so no benchmark needs the database port opened up.
    spreadDays: Number(values['spread-days']),
  };
}

// The entry bodies are built once so the generator spends its time on sockets rather than on
// JSON.stringify, which would otherwise make the client the bottleneck before the service is.
function buildFragments(): string[] {
  const fragments: string[] = [];

  for (let index = 0; index < 512; index += 1) {
    const level = LEVELS[index % LEVELS.length];
    const service = SERVICES[index % SERVICES.length];
    const message = MESSAGES[index % MESSAGES.length];
    const region = REGIONS[index % REGIONS.length];
    const attributes = `{"user_id":"${String(1000 + (index % 977))}","region":"${String(region)}","retries":${String(index % 4)},"cached":${index % 2 === 0 ? 'true' : 'false'}}`;

    fragments.push(
      `","level":"${String(level)}","service":"${String(service)}","message":"${String(message)}","attributes":${attributes}}`,
    );
  }

  return fragments;
}

function buildBody(
  fragments: string[],
  batchSize: number,
  cursor: number,
  spreadDays: number,
): string {
  const now = Date.now();
  const spreadMs = spreadDays * 24 * 60 * 60 * 1000;
  const shared = spreadMs === 0 ? new Date(now).toISOString() : '';
  const parts: string[] = new Array<string>(batchSize);

  for (let index = 0; index < batchSize; index += 1) {
    const timestamp =
      spreadMs === 0 ? shared : new Date(now - Math.floor(Math.random() * spreadMs)).toISOString();
    parts[index] =
      `{"timestamp":"${timestamp}${fragments[(cursor + index) % fragments.length] ?? ''}`;
  }

  return `{"logs":[${parts.join(',')}]}`;
}

function percentile(sorted: Float64Array, fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[rank] ?? 0;
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The service may still be starting; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('service did not become healthy');
}

async function main(): Promise<void> {
  const options = readOptions();
  const fragments = buildFragments();

  await waitForHealth(options.url);

  const pool = new Pool(options.url, {
    connections: options.connections,
    pipelining: 1,
    keepAliveTimeout: 60_000,
  });

  const latencies = new Float64Array(4_000_000);
  let samples = 0;
  let accepted = 0;
  let rejected = 0;
  let requests = 0;
  let shed = 0;
  let errors = 0;
  const statuses = new Map<number, number>();

  let cursor = 0;
  let measuring = false;
  const deadline = Date.now() + (options.warmupSeconds + options.durationSeconds) * 1000;
  const measureFrom = Date.now() + options.warmupSeconds * 1000;

  const worker = async (): Promise<void> => {
    while (Date.now() < deadline) {
      const body = buildBody(
        fragments,
        options.batchSize,
        (cursor += options.batchSize),
        options.spreadDays,
      );
      const started = process.hrtime.bigint();

      try {
        const response = await pool.request({
          path: '/logs',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });

        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
        const payload = (await response.body.json()) as { accepted?: number; rejected?: unknown[] };
        const counted = measuring;

        if (counted) {
          requests += 1;
          statuses.set(response.statusCode, (statuses.get(response.statusCode) ?? 0) + 1);
          if (samples < latencies.length) latencies[samples++] = elapsedMs;

          if (response.statusCode === 200) {
            accepted += payload.accepted ?? 0;
            rejected += payload.rejected?.length ?? 0;
          } else if (response.statusCode === 503) {
            shed += 1;
          }
        }
      } catch {
        if (measuring) errors += 1;
      }
    }
  };

  const flip = setTimeout(
    () => {
      measuring = true;
    },
    Math.max(0, measureFrom - Date.now()),
  );
  flip.unref();

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
  const wallSeconds = (Date.now() - startedAt - options.warmupSeconds * 1000) / 1000;

  await pool.close();

  const sorted = latencies.slice(0, samples).sort();
  const throughput = accepted / wallSeconds;

  process.stdout.write(
    `${JSON.stringify(
      {
        label: options.label,
        batchSize: options.batchSize,
        concurrency: options.concurrency,
        connections: options.connections,
        durationSeconds: Number(wallSeconds.toFixed(1)),
        requests,
        acceptedLogs: accepted,
        rejectedLogs: rejected,
        logsPerSecond: Math.round(throughput),
        requestsPerSecond: Math.round(requests / wallSeconds),
        shed503: shed,
        errors,
        statuses: Object.fromEntries(statuses),
        latencyMs: {
          p50: Number(percentile(sorted, 0.5).toFixed(2)),
          p95: Number(percentile(sorted, 0.95).toFixed(2)),
          p99: Number(percentile(sorted, 0.99).toFixed(2)),
          max: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
        },
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
