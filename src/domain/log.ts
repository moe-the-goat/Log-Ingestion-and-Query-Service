export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type AttributeValue = string | number | boolean;

export type Attributes = Record<string, AttributeValue>;

// Timestamps travel as epoch milliseconds so each writer encodes them once, in the form it
// needs: the insert path formats ISO text, the copy path converts to Postgres microseconds.
export interface LogRecord {
  timestampMs: number;
  level: LogLevel;
  service: string;
  message: string;
  attributes: Attributes;
}
