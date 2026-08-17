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

## What is not yet measured

- Aggregation with indexes, partitions and rollups in place.
- Attribute-filtered queries and their GIN write amplification, which is the most likely ceiling
  on ingest once the attribute index exists.
- Retention: dropping an expired partition.
