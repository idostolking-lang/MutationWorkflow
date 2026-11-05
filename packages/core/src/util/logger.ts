export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

const LEVELS: Record<Exclude<LogLevel, 'silent'>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerOptions {
  level?: LogLevel;
  /** Receives formatted lines; defaults to stderr so MCP stdio transport stays clean. */
  write?: (line: string) => void;
  scope?: string;
}

/**
 * Minimal structured logger. Everything goes to stderr by default: stdout belongs to the MCP
 * protocol when the server runs over stdio, and to machine-readable CLI output otherwise.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const threshold = level === 'silent' ? Number.POSITIVE_INFINITY : LEVELS[level];

  const make = (scope: string | undefined): Logger => {
    const emit = (
      lvl: Exclude<LogLevel, 'silent'>,
      message: string,
      data?: Record<string, unknown>,
    ) => {
      if (LEVELS[lvl] < threshold) return;
      const prefix = scope ? `[${scope}] ` : '';
      const suffix = data && Object.keys(data).length > 0 ? ` ${safeJson(data)}` : '';
      write(`${new Date().toISOString()} ${lvl.padEnd(5)} ${prefix}${message}${suffix}`);
    };
    return {
      debug: (m, d) => emit('debug', m, d),
      info: (m, d) => emit('info', m, d),
      warn: (m, d) => emit('warn', m, d),
      error: (m, d) => emit('error', m, d),
      child: (childScope) => make(scope ? `${scope}:${childScope}` : childScope),
    };
  };
  return make(options.scope);
}

export const silentLogger: Logger = createLogger({ level: 'silent' });

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
