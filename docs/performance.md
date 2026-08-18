# Performance

Every number here was measured, not estimated. The method and the environment are recorded so the
runs can be repeated and disagreed with.

## Environment

| Component               | Limit                                     |
| ----------------------- | ----------------------------------------- |
| Application container   | 0.5 CPU, 256 MB                           |
| PostgreSQL 17 container | 1 CPU, 1 GB                               |
| Host                    | Windows 11, Docker Desktop (WSL2 backend) |

The load generator runs on the host, outside both containers, so it never competes for the 0.5 CPU
the application is being measured on. Limits were confirmed with `docker inspect`:
`NanoCpus=500000000, Memory=268435456` for the app and `NanoCpus=1000000000, Memory=1073741824`
for Postgres.

Target to beat: **15,000 logs/second sustained**, aggregation **p95 under 1 second**.

## Method

```bash
docker compose up --build -d
npx tsx tools/loadgen.ts --label "<name>" --duration 30 --warmup 5 --batch 200 \
  --concurrency 32 --connections 16
```

Each run discards a 5 second warmup, then measures for 30 seconds. `logs/second` counts only
entries the service answered `200` for, so anything shed or failed is excluded rather than
quietly counted. The table is truncated between runs. The write path is switched with
`INGEST_WRITER`, which defaults to `binary`.

## Write path comparison

Same rows, same buffer, same transaction boundary — only the wire encoding differs.

| Write path                    | Batch | Logs/s     | p50    | p95    | p99     | Shed | Errors |
| ----------------------------- | ----- | ---------- | ------ | ------ | ------- | ---- | ------ |
| Multi-row `INSERT` (baseline) | 200   | **24,725** | 167 ms | 559 ms | 1507 ms | 0    | 0      |
| Text `COPY`                   | 200   | **43,877** | 116 ms | 260 ms | 479 ms  | 0    | 0      |
| Binary `COPY`                 | 200   | **48,846** | 107 ms | 242 ms | 346 ms  | 0    | 0      |

Binary `COPY` is **1.98x** the `INSERT` baseline and **1.11x** text `COPY`. The jump from `INSERT`
to `COPY` is the larger one: it removes per-parameter serialisation in the driver and per-row
parsing in the server. Going from text to binary removes the remaining text formatting and
server-side parsing, and it also cuts the tail — p99 falls from 1507 ms to 346 ms, because there is
no longer a per-row parse cost that grows with batch size.

The baseline already clears 15,000/s, which is worth being honest about: the group-commit buffer,
not the encoding, is what does most of the work. Coalescing many HTTP requests into one large write
is the change that matters most; the encoding then decides how far above the target the ceiling
sits.

## Batch size sensitivity

The risk with a group-commit design is a caller that sends small batches, which would make the
service HTTP-bound before it is write-bound.

| Batch | Concurrency | Requests/s | Logs/s     |
| ----- | ----------- | ---------- | ---------- |
| 50    | 64          | 601        | **30,048** |
| 200   | 32          | 244        | **48,846** |
| 500   | 32          | 122        | **60,787** |

At batch 50 the service handles 601 requests/second and still sustains twice the target. Throughput
does fall as batches shrink — that cost is HTTP and JSON parsing per request, not the write path —
but the buffer keeps the floor well clear of 15,000/s.

## Queries while ingesting

1,989,000 rows spanning 30 days (2026-07-15 to 2026-08-14), loaded through `POST /logs`. The
primary aggregation query ran once per second for 30 seconds _while_ a 44,150 logs/s ingest was
running against the same database.

```
GET /logs/aggregate?since=<30 days ago>&until=<now+1h>&bucket=1h&group_by=service
```

| Measure                       | Result                          |
| ----------------------------- | ------------------------------- |
| Aggregation p50               | 0.593 s                         |
| Aggregation p95               | **0.997 s**                     |
| Aggregation p99               | 1.258 s                         |
| Aggregation max               | 2.331 s                         |
| Ingest during the same window | 44,150 logs/s, 0 shed, 0 errors |

Ingestion was unaffected by the query load. Aggregation p95 meets the target, but only just, and
p99 misses it.

The plan explains why:

```
Finalize HashAggregate (actual rows=4326)
  ->  Gather (Workers Launched: 2)
        ->  Partial HashAggregate (actual rows=4326 loops=3)
              ->  Parallel Seq Scan on logs_default  (actual rows=1326710 loops=3)
                    Buffers: shared hit=15061 read=64543
```

Two things are missing at this point in the build, both deliberate:

1. **No daily partitions yet**, so every row is in `logs_default` and the time range prunes
   nothing. The scan reads the whole table.
2. **No rollup table yet**, so the count is recomputed from raw rows on every request.

64,543 blocks are read from disk per query. Adding daily partitions gives the time filter something
to prune, and the per-minute rollup replaces the scan entirely for queries with no `attr.*` or `q`
filter. Both land next, and this measurement is the baseline they are judged against.

## After partitions, indexes and rollups

The same aggregation, re-measured on **1,204,000 rows across 30 days**, again at one request per
second while ingestion ran against the same database.

| Measure               | Before  | After       |
| --------------------- | ------- | ----------- |
| Aggregation p50       | 0.593 s | **0.054 s** |
| Aggregation p95       | 0.997 s | **0.084 s** |
| Aggregation p99       | 1.258 s | **0.088 s** |
| Aggregation max       | 2.331 s | **0.093 s** |
| Blocks read per query | 64,543  | 2,170       |

p95 improves roughly twelvefold and the whole distribution collapses: the worst request is now
faster than the old median. Ingestion during the same window held **29,505 logs/s with 0 shed and
0 errors**.

The plan shows why — the request never touches the base table:

```
HashAggregate (actual rows=4182)
  Buffers: shared hit=2170
  ->  Seq Scan on log_rollup_1m  (actual rows=248445)
```

Partition pruning and the new indexes show up on the row-level paths. A service filter over the
last day reads two partitions out of 35, by index, and stops at the limit:

```
Limit (actual rows=100)
  ->  Merge Append
        ->  Index Only Scan using logs_2026_08_16_service_ts_id_idx (actual rows=1)
        ->  Index Only Scan using logs_2026_08_17_service_ts_id_idx (actual rows=100)
```

The rollup costs 30 MB and 248,445 rows against 908 MB of base data — about 3% overhead for the
query it removes.

### The cost of the indexes

Indexes are not free on the write path, and this is the trade the project actually made:

| Configuration                                        | Logs/s     |
| ---------------------------------------------------- | ---------- |
| No indexes, no rollup, no partitions (Day 4)         | 48,846     |
| GIN + two btree indexes + rollup, current timestamps | **29,505** |
| Same, timestamps spread over 30 days                 | **15,580** |

Adding the attribute GIN index, two btree indexes and the rollup upsert costs about 40% of peak
ingest throughput. That was the risk flagged before any of it was written, and the measurement
confirms it is real but affordable: 29,505/s is still just under twice the 15,000/s target.

The spread case is the honest worst case. Writing timestamps scattered over 30 days touches 30
partitions and 30 days of index pages at random instead of appending to today's, and produces one
rollup group per minute rather than a handful. It still clears the target at 15,580/s. Real
ingestion is overwhelmingly current-timestamped, which is the 29,505/s row.

### A deadlock found by measuring

The first run after adding rollups collapsed to 2,097 logs/s with 177 requests returning 500. The
cause was `deadlock detected`: concurrent flushes upserted the same rollup rows in whatever order
each batch happened to produce, so two transactions could take the same two rows in opposite
orders. It surfaced only once timestamps were spread over many minutes, which is exactly the shape
a backfill has.

The fix is to sort every rollup group by `(bucket, service, level)` before the upsert, so all
flushes take row locks in the same order. Large flushes are also split so no statement exceeds the
65,535 parameter limit. After the fix: 0 deadlocks, 0 errors across every subsequent run.

## Platform benchmark

The Foothill benchmark CLI (`@foothill/logs-benchmark 0.2.5`) runs its own k6 generator in Docker
on a fixed CPU budget, seeds a million rows, and scores four scenarios. It enforces the resource
limits itself: application `cpus 0.5 / 256m`, postgres `cpus 1 / 1024m`.

```bash
npx @foothill/logs-benchmark --compose ./docker-compose.yml --full --seed 6122026 --generator-cpus 2
```

| Category    | Score                                                    |
| ----------- | -------------------------------------------------------- |
| Correctness | 15.0 / 15 (15/15 checks)                                 |
| Performance | 47.5 / 50 (throughput 14,981/s, errors 0.0%, p95 319 ms) |
| Queries     | 13.1 / 15 (aggregate p95 107 ms, consistency 4/4)        |
| Reliability | 20.0 / 20 (4/4 scenarios)                                |
| **Total**   | **95.6 / 100**                                           |

| Scenario   | Offered  | Achieved | Ingest p95 | Aggregate p95 | Errors |
| ---------- | -------- | -------- | ---------- | ------------- | ------ |
| load       | 15,000/s | 14,981/s | 319 ms     | 107 ms        | 0%     |
| stress     | 24,000/s | 17,543/s | 1157 ms    | 425 ms        | 0%     |
| spike      | 9,750/s  | 12,935/s | 452 ms     | 517 ms        | 0%     |
| breakpoint | 28,125/s | 15,792/s | 1689 ms    | 3322 ms       | 0%     |

Zero errors in every scenario, and every accepted record was queryable in every scenario.

### What one measurement was worth

An earlier run of the same benchmark scored 80.2. The difference was a single decision.

The rollup was originally used only when `since` and `until` fell exactly on minute boundaries,
because a range starting mid-minute would otherwise count rows the caller excluded. That was
correct, and far too strict: real callers do not send minute-aligned timestamps, so in practice
**the rollup was never used** and every aggregation scanned the base table.

Reading whole minutes from the rollup and counting only the partial minutes at each edge from the
base table keeps the answer exact and makes the fast path apply to essentially every request:

| Measure                 | Gated on alignment | Edge-corrected |
| ----------------------- | ------------------ | -------------- |
| Total score             | 80.2               | **95.6**       |
| Aggregate p95 (load)    | 475 ms             | **107 ms**     |
| Aggregate p95 (stress)  | 7685 ms            | **425 ms**     |
| Throughput (load)       | 14,531/s           | **14,981/s**   |
| Throughput (stress)     | 9,213/s            | **17,543/s**   |
| Throughput (breakpoint) | 4,205/s            | **15,792/s**   |

Throughput improved because of a query change. Aggregations were consuming the single Postgres CPU
that writes also depend on; removing that scan gave the capacity back to ingestion. Stress
throughput nearly doubled and breakpoint quadrupled without the write path changing at all.

## What is not yet measured

- Retention: dropping an expired partition under load.
- Attribute-filtered aggregation, which falls back to the base table by design.
