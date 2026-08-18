-- Measured on a CPU-bound Postgres these two cost 61% of write throughput, while a time-ranged
-- query answers from the primary key in microseconds because (ts, id) already orders the scan.
-- The attribute index stays: without it a filtered scan over the whole dataset misses its deadline.
DROP INDEX logs_service_ts_id_idx;
DROP INDEX logs_level_ts_id_idx;
