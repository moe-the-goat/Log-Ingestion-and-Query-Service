-- Filters land on a service or a level and then read newest-first, so the sort column is part
-- of the index rather than a sort applied afterwards.
CREATE INDEX logs_service_ts_id_idx ON logs (service, ts DESC, id DESC);
CREATE INDEX logs_level_ts_id_idx ON logs (level, ts DESC, id DESC);

-- jsonb_path_ops indexes only the containment operator, which is the one the attribute filter
-- compiles to. It is roughly half the size of the default operator class and cheaper to write.
CREATE INDEX logs_attributes_idx ON logs USING gin (attributes jsonb_path_ops);

-- Counts per minute, maintained in the same transaction as the rows they describe so the two
-- can never disagree. Every supported bucket (1m, 5m, 1h, 1d) is a whole number of minutes,
-- so they all roll up from this one table.
CREATE TABLE log_rollup_1m (
  bucket  timestamptz NOT NULL,
  service text        NOT NULL,
  level   log_level   NOT NULL,
  count   bigint      NOT NULL,
  PRIMARY KEY (bucket, service, level)
);
