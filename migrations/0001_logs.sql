CREATE TYPE log_level AS ENUM ('debug', 'info', 'warn', 'error');

-- Partitioned by day so retention is a DROP TABLE instead of a bulk DELETE, and so
-- time-ranged queries prune to the days they actually touch.
CREATE TABLE logs (
  id         bigint      NOT NULL,
  ts         timestamptz NOT NULL,
  level      log_level   NOT NULL,
  service    text        NOT NULL,
  message    text        NOT NULL,
  attributes jsonb       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (ts, id)
) PARTITION BY RANGE (ts);

-- Timestamps may legitimately fall outside the managed window; this keeps them queryable
-- instead of failing the insert. The maintenance job keeps it small.
CREATE TABLE logs_default PARTITION OF logs DEFAULT;
