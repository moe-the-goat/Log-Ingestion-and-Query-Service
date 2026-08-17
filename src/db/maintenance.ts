import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import { dropExpiredPartitions, ensurePartitions } from './partitions.js';
import type { PartitionOptions } from './partitions.js';

export interface MaintenanceOptions extends PartitionOptions {
  intervalMs: number;
}

export interface Maintenance {
  runOnce(): Promise<void>;
  stop(): void;
}

export function startMaintenance(
  pool: Pool,
  options: MaintenanceOptions,
  logger: Logger,
): Maintenance {
  const runOnce = async (): Promise<void> => {
    await ensurePartitions(pool, options, logger);
    await dropExpiredPartitions(pool, options, logger);
  };

  // A failure must not stop the service: the default partition still accepts every timestamp.
  const timer = setInterval(() => {
    void runOnce().catch((error: unknown) => {
      logger.error('partition maintenance failed', { error });
    });
  }, options.intervalMs);
  timer.unref();

  return {
    runOnce,
    stop: () => {
      clearInterval(timer);
    },
  };
}
