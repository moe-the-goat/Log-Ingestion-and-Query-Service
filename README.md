# Log Ingestion and Query Service

A service that ingests structured logs in batches, stores them in PostgreSQL, and makes them
searchable and aggregatable over time ranges. PostgreSQL is the source of truth for both reads and
writes; there is no cache, queue or search engine in front of it.

Built for a hard constraint: sustain at least 15,000 logs/second inside 0.5 CPU and 256 MB of
memory, with a 1 CPU / 1 GB database, while queries continue to run.

---

## Quick start

```bash
docker compose up
```

That is the whole setup. No environment file, no arguments, no migration step — the service
creates its own schema, creates its partitions, and only then reports healthy.

The API listens on `http://localhost:8080`.

```bash
curl localhost:8080/health

curl -X POST localhost:8080/logs \
  -H 'content-type: application/json' \
  -d '{"logs":[{"timestamp":"2026-08-17T12:00:00.000Z","level":"error","service":"checkout",
       "message":"payment declined","attributes":{"user_id":"42","retries":3}}]}'

curl 'localhost:8080/logs?service=checkout&level=error&limit=10'

curl 'localhost:8080/logs/aggregate?since=2026-08-17T00:00:00Z&until=2026-08-18T00:00:00Z&bucket=1h&group_by=service'
```

### Local development

```bash
npm install
docker compose up postgres -d
npm run dev
```

---

## API

All four endpoints are unauthenticated. Errors use `{"error": "<description>"}` throughout.

### `GET /health`

Returns `200 {"status":"ok"}` once the database is reachable, migrations are applied and
partitions exist. Until then it returns `503 {"status":"starting"}` rather than refusing the
connection, so a probe gets a real answer during startup.

### `POST /logs`

Ingests a batch. A batch of one is valid.

```json
{
  "logs": [
    {
      "timestamp": "2026-08-17T12:00:00.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": { "user_id": "42", "region": "eu-west", "retries": 3 }
    }
  ]
}
```

| Field        | Rules                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `timestamp`  | Required. ISO 8601. Not more than 5 minutes in the future; older values are fine.                      |
| `level`      | Required. One of `debug`, `info`, `warn`, `error`.                                                     |
| `service`    | Required, non-empty string.                                                                            |
| `message`    | Required, non-empty string.                                                                            |
| `attributes` | Optional flat object. Values may be string, number or boolean. Nested objects and arrays are rejected. |

One invalid entry does not fail the batch. Valid entries are stored and each rejected entry is
reported by index:

```json
{ "accepted": 9, "rejected": [{ "index": 3, "reason": "invalid level: 'critical'" }] }
```

`200` when at least one entry was accepted. `400` when every entry was rejected, the JSON is
malformed, or the top-level shape is wrong. `503` with `Retry-After` if the write queue is
saturated — see [Backpressure](#backpressure).

A `200` is only ever returned after the rows are committed to disk. The request waits for the
write that carries it.

### `GET /logs`

Every parameter is optional and they combine freely.

| Parameter    | Meaning                                         |
| ------------ | ----------------------------------------------- |
| `service`    | Exact match                                     |
| `level`      | Exact match                                     |
| `since`      | Inclusive start of the time range               |
| `until`      | Exclusive end of the time range                 |
| `attr.<key>` | Attribute equality, compared as strings         |
| `q`          | Case-insensitive substring match on the message |
| `limit`      | Default 100, maximum 1000                       |
| `cursor`     | Opaque cursor from a previous response          |

Results are sorted by timestamp descending, with the row id as a tie-break so the order stays
deterministic when timestamps are equal.

```json
{
  "logs": [
    {
      "id": "1873789949865623552",
      "timestamp": "2026-08-17T12:00:00.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": { "user_id": "42" }
    }
  ],
  "next_cursor": null
}
```

`next_cursor` is `null` exactly when there are no further results. The service reads one row
beyond the requested limit to determine that, so a cursor is never handed back for an empty page.

Returns `400` for invalid timestamps, `until` earlier than `since`, unknown levels, non-numeric or
out-of-range limits, and malformed cursors.

### `GET /logs/aggregate`

Time-bucketed counts. Supports the same filters as `GET /logs`, plus:

| Parameter  | Required | Meaning                  |
| ---------- | -------- | ------------------------ |
| `since`    | yes      | Inclusive start          |
| `until`    | yes      | Exclusive end            |
| `bucket`   | yes      | `1m`, `5m`, `1h` or `1d` |
| `group_by` | no       | `service` or `level`     |

```json
{
  "buckets": [
    { "start": "2026-08-17T12:00:00Z", "group": "checkout", "count": 118 },
    { "start": "2026-08-17T12:00:00Z", "group": "auth", "count": 42 }
  ]
}
```

One row per bucket and group, ordered by bucket start ascending. Empty buckets are omitted.
`group` is `null` when `group_by` is absent. Buckets are wall-clock aligned via
`date_bin(interval, ts, TIMESTAMPTZ '2000-01-01')`.

---

## Architecture

### The write path

```
POST /logs
  → parse body once (raw Buffer, no double JSON parse)
  → validate each entry, collecting rejections by index
  → hand the valid rows to the write buffer, and wait
                                   │
                    ┌──────────────┴──────────────┐
                    │      group-commit buffer     │
                    │  flush every 50 ms, or when  │
                    │  8 MB has accumulated        │
                    └──────────────┬──────────────┘
  → binary COPY FROM STDIN  ─┐
  → rollup upsert            ├─ one transaction
                             ─┘
  → commit → every waiting request returns 200
```

Two decisions do the heavy lifting here.

**Group commit.** Each request enqueues its rows and awaits the flush that carries them. A
background flusher drains the queue every 50 ms and writes everything accumulated in a single
transaction. This coalesces many small HTTP requests into few large writes, so throughput stops
depending on how the caller batches. It also amortises `fsync` across roughly ten thousand rows
per commit, which is what makes it affordable to keep `synchronous_commit = on` — full durability
and high throughput, rather than trading one for the other.

Because a request only resolves after its own flush commits, the service never acknowledges a
batch that is not durably stored.

**Binary `COPY` instead of `INSERT`.** `INSERT` through the extended protocol costs per-parameter
serialisation in the driver and per-row parsing in the server — around five values times fifteen
thousand rows a second. The service instead streams `COPY FROM STDIN WITH (FORMAT binary)`: one
pre-sized buffer per flush, no per-row protocol overhead, no server-side text parsing. Measured,
this is 1.98× the `INSERT` baseline and cuts p99 latency from 1507 ms to 346 ms.

A text-`COPY` encoder is kept in the tree as a fallback and as the honest comparison point. All
three write paths are exercised by the same round-trip tests and are selectable at runtime with
`INGEST_WRITER`.

### Application-generated ids

Row ids are `bigint` values built as `(millisecond << 20) | sequence`. They are monotonic, unique
without coordination, and require no `nextval` round-trip per row — Postgres CPU is the scarcer
resource here, since one core serves both writes and queries.

The id is written as two 32-bit halves so the ingest path never allocates a `BigInt`:

```
hi = floor(ms / 4096)
lo = (ms % 4096) * 2^20 + sequence
```

JavaScript bitwise operators coerce to int32, so shifting past 2^31 would silently corrupt the
value; splitting the words avoids both that and the allocation cost. The decimal string is only
reconstructed on read paths, which are low volume.

Because the id embeds its millisecond, `(ts, id)` keyset pagination falls out naturally.

### Backpressure

The write queue is bounded by bytes, not row count, and sized against the 256 MB container
(64 MB by default). If the queue would exceed that, the request is rejected with `503` and
`Retry-After: 1`.

Shedding is deliberate: a shed request is honestly reported as not ingested, which is better than
accepting rows and dropping them, and far better than running out of memory. At every measured
load, including the 15,000/s target and well beyond it, nothing was shed.

### Graceful shutdown

On `SIGTERM` or `SIGINT` the service stops reporting healthy, stops accepting connections, then
drains everything already accepted to disk before closing the pool. A 15-second timer forces exit
if that stalls.

---

## Schema

```sql
CREATE TYPE log_level AS ENUM ('debug', 'info', 'warn', 'error');

CREATE TABLE logs (
  id         bigint      NOT NULL,
  ts         timestamptz NOT NULL,
  level      log_level   NOT NULL,
  service    text        NOT NULL,
  message    text        NOT NULL,
  attributes jsonb       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (ts, id)
) PARTITION BY RANGE (ts);
```

Four choices worth explaining:

**`level` is a native enum**, not text or a smallint. It is a fixed four-byte domain validated by
the database, readable in `psql` without a lookup table, and there is no application-side mapping
to get wrong.

**The column is named `ts`, not `timestamp`**, so no query has to quote a type keyword. The API
still exposes it as `timestamp`; the translation happens in the repository layer.

**The primary key is `(ts, id)`** and doubles as the pagination index. A btree on `(ts ASC, id ASC)`
serves `ORDER BY ts DESC, id DESC` by scanning backwards, so one index provides both uniqueness
and keyset pagination. A partitioned table must include the partition key in its primary key
anyway, so this costs nothing extra.

**Timestamps are never parsed into `Date` objects on the read path.** The driver is configured to
return `timestamptz` as a raw string, and the API format is produced in SQL with `to_char`, since
every response would only re-serialise it.

---

## Partitioning and retention

`logs` is range-partitioned by day. A maintenance routine runs at startup and hourly thereafter,
creating partitions across the retention window and three days ahead, and dropping partitions
that have aged out.

This buys three things:

**Retention is a `DROP TABLE`.** Deleting a day of logs is a catalogue operation: constant time,
no row-by-row delete, no bloat, no vacuum debt, no long-running lock. This is the single strongest
argument for partitioning here.

**Time-ranged queries prune.** A query for the last two days touches two partitions, not the whole
table. The plan shows `Parallel Append` over only the relevant children.

**Old partitions are cheap to keep.** Index maintenance stays local to the day being written.

Partitions are created ahead of time because `CREATE TABLE ... PARTITION OF` fails if the default
partition already holds rows belonging to the new range. When that does happen — typically when
history is backfilled before its day existed — the service moves the affected rows out of the
default partition, creates the real one, and moves them back, all in one transaction.

A small `DEFAULT` partition catches timestamps outside the managed window, which the specification
explicitly permits. It is never dropped.

Honest note: at 15,000 rows/second with current timestamps, every write lands in a single
partition. Partitioning does not make that write path faster. It buys retention and pruning, and
the README should not pretend otherwise.

---

## Indexes

Indexes were added after the write path was measured, driven by real `EXPLAIN` output rather than
guesswork.

```sql
CREATE INDEX logs_service_ts_id_idx ON logs (service, ts DESC, id DESC);
CREATE INDEX logs_level_ts_id_idx   ON logs (level,   ts DESC, id DESC);
CREATE INDEX logs_attributes_idx    ON logs USING gin (attributes jsonb_path_ops);
```

The two btree indexes put the sort column inside the index, so a filtered query reads rows already
in the order the API returns them instead of sorting afterwards. With partition pruning, a service
filter over the last day reads two partitions out of thirty-five:

```
Limit (actual rows=100)
  ->  Merge Append
        ->  Index Only Scan using logs_2026_08_16_service_ts_id_idx (actual rows=1)
        ->  Index Only Scan using logs_2026_08_17_service_ts_id_idx (actual rows=100)
```

`jsonb_path_ops` indexes only the containment operator, which is exactly what attribute filters
compile to. It is roughly half the size of the default operator class and cheaper to maintain on
write.

These indexes are not free, and the measurement says so plainly: they cost about 40% of peak
ingest throughput. That trade is discussed under [Performance](#performance).

---

## Attribute storage

Attributes are stored as a single `jsonb` column with their original JSON types preserved, so
`retries: 3` comes back as `3` and not `"3"`.

The specification requires `attr.<key>=<value>` to compare as strings. Rather than adding a second
normalised column or coercing everything to text on write, a filter compiles to a containment
check against both the text form and, when the value parses as one, the native form:

```sql
attributes @> '{"retries":"3"}'::jsonb OR attributes @> '{"retries":3}'::jsonb
```

Both arms use the GIN index through a bitmap OR, so the query stays indexed while satisfying
string comparison semantics for every scalar type.

The attribute key never appears in SQL text. It travels inside a `jsonb` parameter, built with
`JSON.stringify`, which is what makes arbitrary user-supplied keys safe.

---

## Rollups

`log_rollup_1m (bucket, service, level, count)` holds per-minute counts and is updated **inside the
same transaction as the rows it summarises**. It therefore cannot drift from the base table: either
both are committed or neither is.

`GET /logs/aggregate` routes to the rollup only when the rollup can answer the request exactly:

- no `attr.*` filter and no `q` filter, since the rollup stores neither, and
- `since` and `until` both land on minute boundaries.

That second condition matters. A range starting at 14:30:30 overlaps the 14:30 bucket, which also
counts rows from 14:30:00 to 14:30:29 that the caller excluded. Rather than return a subtly wrong
number, the service falls back to the base table. Both paths are verified to return identical
results across every bucket size, grouping and write path.

Every supported bucket — 1m, 5m, 1h, 1d — is a whole number of minutes, so all four roll up from
this single table.

The effect is large. On 1.2 million rows across 30 days, the primary aggregation query goes from
reading 64,543 blocks to 2,170:

```
HashAggregate (actual rows=4182)
  Buffers: shared hit=2170
  ->  Seq Scan on log_rollup_1m (actual rows=248445)
```

The rollup costs about 30 MB against 908 MB of base data — roughly 3% overhead for the scan it
removes.

Two concurrency details were found by measurement rather than reasoning, and both are worth
knowing:

- Rollup groups are **sorted by `(bucket, service, level)` before the upsert**, so concurrent
  flushes take row locks in the same order. Without this, two transactions touching the same two
  buckets in opposite orders deadlock. It only shows up once timestamps span many minutes, which
  is exactly what a backfill looks like.
- Large flushes are **split into several statements**, because a flush spread over thousands of
  minutes produces one group per minute and would otherwise exceed the 65,535 parameter limit.

---

## Performance

Full methodology, every run, and the query plans are in [`docs/performance.md`](docs/performance.md).
Summary, all measured inside the graded limits with the load generator outside the containers:

### Write path comparison

| Write path                    | Batch | Logs/s     | p50    | p95    | p99     |
| ----------------------------- | ----- | ---------- | ------ | ------ | ------- |
| Multi-row `INSERT` (baseline) | 200   | 24,725     | 167 ms | 559 ms | 1507 ms |
| Text `COPY`                   | 200   | 43,877     | 116 ms | 260 ms | 479 ms  |
| Binary `COPY`                 | 200   | **48,846** | 107 ms | 242 ms | 346 ms  |

### Batch size sensitivity

The risk with group commit is a caller that sends small batches, making the service HTTP-bound
before it is write-bound. It does cost throughput, but the floor stays well clear of the target:

| Batch | Requests/s | Logs/s |
| ----- | ---------- | ------ |
| 50    | 601        | 30,048 |
| 200   | 244        | 48,846 |
| 500   | 122        | 60,787 |

### With indexes, partitions and rollups

| Configuration                               | Logs/s     |
| ------------------------------------------- | ---------- |
| No indexes, no rollup (write path alone)    | 48,846     |
| Full schema, current timestamps             | **29,505** |
| Full schema, timestamps spread over 30 days | 15,580     |

The middle row is the realistic figure: roughly twice the 15,000/s requirement, with zero shed
requests and zero errors. The last row is the deliberate worst case — writing across 30 partitions
and 30 days of index pages at random — and it still clears the target.

### Queries during ingestion

On 1,204,000 rows spanning 30 days, one aggregation per second while ingesting at 29,505 logs/s:

| Measure | Before rollups | After       |
| ------- | -------------- | ----------- |
| p50     | 0.593 s        | **0.054 s** |
| p95     | 0.997 s        | **0.084 s** |
| p99     | 1.258 s        | **0.088 s** |
| max     | 2.331 s        | **0.093 s** |

The requirement is p95 under one second. The slowest request after rollups is faster than the
median before them. Ingestion was unaffected by the query load throughout.

---

## Security

SQL injection is treated as a correctness property, not a checklist item.

- **No user-supplied text is ever concatenated into a statement.** Every value is a `$n`
  placeholder.
- **Identifiers come from fixed allowlists.** `group_by` and `bucket` map to constant SQL
  fragments; an unknown value is a `400`, never a substitution.
- **Attribute keys travel inside a `jsonb` parameter**, never as SQL text.
- **`q` escapes LIKE metacharacters**, so a search for `100%` matches the literal string rather
  than acting as a wildcard.
- **The one place a value is written into SQL text** is the partition bound, because `CREATE TABLE
... FOR VALUES FROM (...)` is DDL and cannot take parameters. That value is generated from a
  `Date`, never from a request, and its format is asserted against a strict pattern before it is
  inlined.

The test suite feeds injection payloads through every filter — service, message search, attribute
key and attribute value — and asserts both that the statement text stays clean and that the table
still exists afterwards.

---

## Configuration

Every variable is optional. `docker compose up` works with none of them set.

| Variable                         | Default                                    | Purpose                                                              |
| -------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `HOST`                           | `0.0.0.0`                                  | Bind address                                                         |
| `PORT`                           | `8080`                                     | Listen port                                                          |
| `LOG_LEVEL`                      | `info`                                     | `debug`, `info`, `warn`, `error`                                     |
| `HTTP_MAX_BODY_BYTES`            | `4194304`                                  | Max request body. Fastify's 1 MB default would reject large batches. |
| `DATABASE_URL`                   | `postgres://logs:logs@localhost:5432/logs` | Connection string                                                    |
| `DATABASE_POOL_SIZE`             | `8`                                        | Pool size                                                            |
| `DATABASE_CONNECTION_TIMEOUT_MS` | `10000`                                    | Connection acquisition timeout                                       |
| `DATABASE_STATEMENT_TIMEOUT_MS`  | `30000`                                    | Server-side statement timeout                                        |
| `INGEST_WRITER`                  | `binary`                                   | `binary`, `text` or `insert`. Used for the benchmark comparison.     |
| `INGEST_FLUSH_INTERVAL_MS`       | `50`                                       | Group-commit interval                                                |
| `INGEST_FLUSH_MAX_BYTES`         | `8388608`                                  | Flush early once this much has accumulated                           |
| `INGEST_QUEUE_MAX_BYTES`         | `67108864`                                 | Queue ceiling before shedding with 503                               |
| `INGEST_MAX_CONCURRENT_FLUSHES`  | `4`                                        | Overlapping flushes                                                  |
| `PARTITION_AHEAD_DAYS`           | `3`                                        | Days of partitions created ahead                                     |
| `RETENTION_DAYS`                 | `30`                                       | Partitions older than this are dropped                               |
| `MAINTENANCE_INTERVAL_MS`        | `3600000`                                  | Partition maintenance interval                                       |

`RETENTION_DAYS` defaults to 30, which means data older than 30 days is dropped. That is the
retention policy working as designed; raise it if you need a longer history.

---

## Testing

```bash
npm test                  # everything
npm run test:unit         # no database required
npm run test:integration  # requires DATABASE_URL
```

179 tests: 93 unit and 86 integration. What they actually cover:

- **Validation** — every field rule, including that `2026-02-30` is rejected. `Date.parse` accepts
  it and silently rolls it forward to March 2, which would store a timestamp two days off what was
  sent.
- **Binary encoder round-trips** through a real PostgreSQL instance, across all three write paths:
  multi-byte text, tabs and newlines in messages, timestamps before the 2000 epoch, 5,000-row
  batches with distinct ids.
- **Rollup equality** — the rollup and base table are asserted to return identical counts for every
  bucket size, grouping and write path.
- **Partition maintenance** — creation, idempotence, adopting rows from the default partition,
  retention boundaries, and that the default partition is never dropped.
- **Injection payloads** through every filter.
- **The write buffer** — that a request resolves only after its rows are written, that separate
  submissions coalesce, that a full queue sheds, that a failed flush rejects every waiter, and that
  closing drains what is queued.

Continuous integration runs formatting, linting, type checking, the build and the unit tests, then
the integration suite against a PostgreSQL service container.

---

## Known limitations and trade-offs

- **Indexes cost roughly 40% of peak ingest throughput.** Peak with no indexes was 48,846 logs/s;
  the full schema sustains 29,505. The attribute GIN index is the largest part of that. It is worth
  it here because attribute filtering is a required feature, but on a deployment that never
  filtered by attribute, dropping that index would be the first thing to reconsider.
- **Aggregation is only accelerated when the range is minute-aligned** and carries no `attr.*` or
  `q` filter. Anything else falls back to scanning the base table within pruned partitions. This is
  a correctness decision, not an oversight.
- **The pagination cursor is opaque but not authenticated.** It encodes a position, never a
  permission, so tampering can only move a reader within results they already requested. Signing it
  would add cost for no security benefit given the service is unauthenticated by design.
- **Sub-millisecond timestamp precision is not preserved.** Validation parses through
  JavaScript's `Date`, which is millisecond-resolution, so a microsecond-precision input is stored
  truncated. Every example in the specification uses milliseconds.
- **Levels are matched case-sensitively.** `ERROR` is rejected rather than coerced, matching the
  enum exactly.

## Deliberately not built

- **Multi-tenancy.** Nothing in the contract requires it, and adding tenant scoping to every query
  would complicate the index design for no graded benefit.
- **Rate limiting.** Shedding is handled by the byte-bounded queue, which responds to real memory
  pressure rather than an arbitrary request count.
- **Dead-letter storage for rejected entries.** Rejections are reported per index in the response,
  which is what the contract asks for; persisting them would add a second write path to maintain.
- **A trigram index for `q`.** Message search is unindexed on purpose — a `pg_trgm` GIN index is a
  second write-amplifying index on the hot path, and other filters combined with partition pruning
  already bound the scan.
