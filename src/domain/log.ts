export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type AttributeValue = string | number | boolean;

export type Attributes = Record<string, AttributeValue>;

// Epoch milliseconds so each writer encodes the timestamp once, in the form it needs.
export interface LogRecord {
  timestampMs: number;
  level: LogLevel;
  service: string;
  message: string;
  attributes: Attributes;
}
