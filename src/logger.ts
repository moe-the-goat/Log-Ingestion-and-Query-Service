export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const severity: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function write(level: LogLevel, message: string, fields: LogFields): void {
  const line = JSON.stringify(
    { time: new Date().toISOString(), level, message, ...fields },
    replacer,
  );
  process.stdout.write(`${line}\n`);
}

export function createLogger(level: LogLevel, base: LogFields = {}): Logger {
  const threshold = severity[level];

  const emit = (at: LogLevel, message: string, fields?: LogFields): void => {
    if (severity[at] < threshold) return;
    write(at, message, fields ? { ...base, ...fields } : base);
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => createLogger(level, { ...base, ...fields }),
  };
}
