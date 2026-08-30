import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLogger,
  parseLogFormat,
  parseLogLevel,
  serializeError,
  silentLogger,
} from "./log";

function capturing() {
  const chunks: string[] = [];
  const logger = createLogger({
    name: "test-logger",
    level: "debug",
    format: "json",
    stream: { write: (chunk) => chunks.push(String(chunk)) },
    clock: () => new Date("2026-08-30T00:00:00.000Z"),
  });
  return { chunks, logger };
}

test("parseLogLevel accepts aliases and defaults to info", () => {
  assert.equal(parseLogLevel(undefined), "info");
  assert.equal(parseLogLevel("DEBUG"), "debug");
  assert.equal(parseLogLevel("trace"), "debug");
  assert.equal(parseLogLevel("warning"), "warn");
  assert.equal(parseLogLevel("fatal"), "error");
  assert.equal(parseLogLevel("nope"), "info");
});

test("parseLogFormat prefers a TTY for pretty output", () => {
  assert.equal(parseLogFormat(undefined, true), "pretty");
  assert.equal(parseLogFormat(undefined, false), "json");
  assert.equal(parseLogFormat("text", false), "pretty");
  assert.equal(parseLogFormat("json", true), "json");
});

test("json logger writes one stderr-style line per call and drops below-level records", () => {
  const chunks: string[] = [];
  const logger = createLogger({
    name: "test-logger",
    level: "info",
    format: "json",
    stream: { write: (chunk) => chunks.push(String(chunk)) },
    clock: () => new Date("2026-08-30T00:00:00.000Z"),
  });
  logger.debug("tool.call", { tool: "list_users" });
  logger.info("tool.done", { tool: "list_users", duration_ms: 4, ok: true });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(chunks[0] ?? "{}"), {
    ts: "2026-08-30T00:00:00.000Z",
    level: "info",
    name: "test-logger",
    msg: "tool.done",
    tool: "list_users",
    duration_ms: 4,
    ok: true,
  });
});

test("pretty logger renders a single-line human-readable record", () => {
  const chunks: string[] = [];
  const logger = createLogger({
    name: "share-mcp-server",
    level: "info",
    format: "pretty",
    stream: { write: (chunk) => chunks.push(String(chunk)) },
    clock: () => new Date("2026-08-30T00:00:00.000Z"),
  });
  logger.warn("tool.rejected", { tool: "create_user", kind: "validation" });
  assert.equal(
    chunks[0],
    '2026-08-30T00:00:00.000Z WARN  share-mcp-server tool.rejected tool="create_user" kind="validation"\n',
  );
});

test("child loggers bind extra fields onto every record", () => {
  const { chunks, logger } = capturing();
  logger.child({ transport: "http" }).info("http.listening", { port: 8081 });
  assert.deepEqual(JSON.parse(chunks[0] ?? "{}"), {
    ts: "2026-08-30T00:00:00.000Z",
    level: "info",
    name: "test-logger",
    msg: "http.listening",
    transport: "http",
    port: 8081,
  });
});

test("serializeError preserves DomainError-style kind and Error stacks", () => {
  const error = new Error("boom");
  const serialized = serializeError(error);
  assert.equal(serialized.name, "Error");
  assert.equal(serialized.message, "boom");
  assert.equal(typeof serialized.stack, "string");
  assert.deepEqual(serializeError("nope"), { message: "nope" });
});

test("silentLogger never writes", () => {
  const logger = silentLogger();
  logger.debug("a");
  logger.info("b");
  logger.warn("c");
  logger.error("d");
  logger.child({ x: 1 }).info("e");
});

test("createLogger reads LOG_LEVEL from the environment", () => {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "error";
  try {
    const chunks: string[] = [];
    const logger = createLogger({
      format: "json",
      stream: { write: (chunk) => chunks.push(String(chunk)) },
    });
    logger.info("dropped");
    logger.error("kept");
    assert.equal(chunks.length, 1);
    assert.equal(JSON.parse(chunks[0] ?? "{}").msg, "kept");
  } finally {
    if (previous === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = previous;
    }
  }
});
