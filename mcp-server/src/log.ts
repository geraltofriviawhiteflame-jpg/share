/**
 * Structured process logging for the MCP server.
 *
 * stdout is reserved for JSON-RPC when MCP_TRANSPORT=stdio, so every log line
 * is written to stderr (or an injected stream). MCP clients such as Claude
 * Desktop and Cursor collect that stream as server logs.
 *
 * Configure with:
 *   LOG_LEVEL=debug|info|warn|error   (default: info)
 *   LOG_FORMAT=json|pretty            (default: pretty on a TTY, json otherwise)
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "pretty";

export interface LogWriter {
  write(chunk: string): unknown;
}

export interface LoggerOptions {
  name?: string;
  level?: LogLevel;
  format?: LogFormat;
  stream?: LogWriter;
  bindings?: Record<string, unknown>;
  clock?: () => Date;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function parseLogLevel(raw: string | undefined): LogLevel {
  switch ((raw ?? "info").trim().toLowerCase()) {
    case "debug":
    case "trace":
      return "debug";
    case "info":
      return "info";
    case "warn":
    case "warning":
      return "warn";
    case "error":
    case "fatal":
      return "error";
    default:
      return "info";
  }
}

export function parseLogFormat(
  raw: string | undefined,
  tty = Boolean(process.stderr.isTTY),
): LogFormat {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "pretty":
    case "text":
      return "pretty";
    case "json":
      return "json";
    default:
      return tty ? "pretty" : "json";
  }
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const payload: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    if ("kind" in error && typeof (error as { kind: unknown }).kind === "string") {
      payload.kind = (error as { kind: string }).kind;
    }
    if (error.stack) {
      payload.stack = error.stack;
    }
    return payload;
  }
  return { message: String(error) };
}

export function silentLogger(): Logger {
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

function formatPrettyFields(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${value}`);
    } else if (typeof value === "string") {
      parts.push(`${key}=${JSON.stringify(value)}`);
    } else {
      parts.push(`${key}=${safeJson(value)}`);
    }
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const name = options.name ?? "share-mcp-server";
  const level = options.level ?? parseLogLevel(process.env.LOG_LEVEL);
  const format = options.format ?? parseLogFormat(process.env.LOG_FORMAT);
  const stream = options.stream ?? process.stderr;
  const bindings = options.bindings ?? {};
  const clock = options.clock ?? (() => new Date());
  const min = LEVEL_RANK[level];

  function write(recordLevel: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[recordLevel] < min) {
      return;
    }
    const rest = { ...bindings, ...(fields ?? {}) };
    const ts = clock().toISOString();
    if (format === "pretty") {
      stream.write(
        `${ts} ${recordLevel.toUpperCase().padEnd(5)} ${name} ${msg}${formatPrettyFields(rest)}\n`,
      );
      return;
    }
    stream.write(`${safeJson({ ts, level: recordLevel, name, msg, ...rest })}\n`);
  }

  const logger: Logger = {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (fields) =>
      createLogger({
        name,
        level,
        format,
        stream,
        clock,
        bindings: { ...bindings, ...fields },
      }),
  };
  return logger;
}
