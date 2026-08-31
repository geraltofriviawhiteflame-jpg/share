#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SQLiteDatabase, applyMigrations, openDatabase } from "../../src/db/database";
import { AccountService } from "../../src/services/accounts";
import { BalanceService } from "../../src/services/balance";
import { ExpenseService } from "../../src/services/expenses";
import { GroupService } from "../../src/services/groups";
import { SettlementService } from "../../src/services/settlements";
import { createLogger, serializeError, type Logger } from "./log";
import {
  AppDependencies,
  SERVER_NAME,
  SERVER_VERSION,
  createShareMcpServer,
} from "./server";

/**
 * Find the repository root by walking up until the `db/migrations` directory
 * (and the `mcp-server` sibling) are visible. Works in both the dev layout
 * (mcp-server/src) and the built layout (mcp-server/dist/mcp-server/src).
 */
function findRepoRoot(start: string): string {
  let directory = start;
  for (let depth = 0; depth < 10; depth += 1) {
    if (
      existsSync(join(directory, "db", "migrations")) &&
      existsSync(join(directory, "mcp-server"))
    ) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error("could not locate the repository root (db/migrations)");
}

const repoRoot = findRepoRoot(__dirname);

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

function resolveDataFile(raw: string | undefined, fallbackName: string): string {
  if (!raw) {
    return resolve(repoRoot, "data", fallbackName);
  }
  if (raw === ":memory:") {
    return raw;
  }
  return raw.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(raw)
    ? raw
    : resolve(repoRoot, raw);
}

export interface Options {
  transport: "stdio" | "http" | "sse";
  host: string;
  port: number;
  databaseFile: string;
  migrationsDirectory: string;
}

function readTransport(): "stdio" | "http" | "sse" {
  const fromArg = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  const transportRaw = (fromArg ?? process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transportRaw !== "stdio" && transportRaw !== "http" && transportRaw !== "sse") {
    throw new Error(
      `MCP_TRANSPORT must be one of "stdio", "http", "sse"; got "${transportRaw}"`,
    );
  }
  return transportRaw;
}

function readOptions(): Options {
  return {
    transport: readTransport(),
    host: process.env.HOST ?? "0.0.0.0",
    port: readPort("MCP_PORT", 8081),
    databaseFile: resolveDataFile(process.env.DATABASE_FILE, "mcp-share.db"),
    migrationsDirectory:
      process.env.MIGRATIONS_DIRECTORY ?? resolve(repoRoot, "db", "migrations"),
  };
}

interface App {
  services: AppDependencies;
  database: SQLiteDatabase;
}

/** One shared database + service layer; every connection gets its own MCP server. */
async function createApp(options: Options, logger: Logger): Promise<App> {
  const database = await openDatabase(options.databaseFile);
  applyMigrations(database, options.migrationsDirectory);
  logger.info("database.ready", { file: options.databaseFile });
  return {
    services: {
      database,
      accounts: new AccountService(database),
      groups: new GroupService(database),
      expenses: new ExpenseService(database),
      balances: new BalanceService(database),
      settlements: new SettlementService(database),
    },
    database,
  };
}

function newMcpServer(app: App, logger: Logger): McpServer {
  return createShareMcpServer(app.services, { logger });
}

async function runStdio(app: App, options: Options, logger: Logger): Promise<void> {
  const server = newMcpServer(app, logger);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("transport.ready", {
    transport: "stdio",
    database: options.databaseFile,
  });
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "content-type, mcp-session-id, last-event-id, x-request-id, authorization",
  "Access-Control-Max-Age": "86400",
};

function writeCors(response: ServerResponse): void {
  for (const [name, value] of Object.entries(corsHeaders)) {
    response.setHeader(name, value);
  }
}

function attachRequestLog(
  logger: Logger,
  request: IncomingMessage,
  response: ServerResponse,
): string {
  const requestId = request.headers["x-request-id"]?.toString() || randomUUID();
  response.setHeader("X-Request-ID", requestId);
  const started = Date.now();
  const path = (request.url ?? "/").split("?")[0] || "/";
  const sessionId = request.headers["mcp-session-id"]?.toString();
  response.on("finish", () => {
    const quiet = request.method === "OPTIONS" || path === "/healthz";
    const fields = {
      request_id: requestId,
      method: request.method ?? "GET",
      path,
      status: response.statusCode,
      duration_ms: Date.now() - started,
      ...(sessionId ? { session_id: sessionId } : {}),
    };
    if (quiet) {
      logger.debug("http.request", fields);
    } else {
      logger.info("http.request", fields);
    }
  });
  return requestId;
}

function landingPage(options: Options): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${SERVER_NAME}</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 3rem auto;
             padding: 0 1rem; line-height: 1.55; color: #1a1a1a; }
      code { background: #f1f1f1; padding: 0.1rem 0.35rem; border-radius: 4px; }
      pre { background: #f6f6f6; padding: 1rem; border-radius: 8px; overflow-x: auto; }
    </style>
  </head>
  <body>
    <h1>${SERVER_NAME} v${SERVER_VERSION}</h1>
    <p>MCP server for the Share expense tracker. Connect any MCP client to
       <code>${options.transport === "http" ? "/mcp" : "/mcp (SSE)"}</code>.</p>
    <h2>Tools</h2>
    <p>list_users, create_user, list_groups, create_group, list_members,
       add_member, list_expenses, create_expense, get_balances,
       list_settlements, create_settlement.</p>
    <h2>Health</h2>
    <pre>GET /healthz</pre>
  </body>
</html>`;
}

async function runHttp(app: App, options: Options, logger: Logger): Promise<void> {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
  const httpLog = logger.child({ transport: "http" });

  const server = createServer(async (request, response) => {
    attachRequestLog(httpLog, request, response);
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "OPTIONS") {
      writeCors(response);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/") {
      writeCors(response);
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(landingPage(options));
      return;
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      writeCors(response);
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          status: "ok",
          name: SERVER_NAME,
          version: SERVER_VERSION,
          tools: 11,
          sessions: sessions.size,
        }),
      );
      return;
    }

    if (url.pathname !== "/mcp") {
      writeCors(response);
      response.statusCode = 404;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end("not found; MCP endpoint is /mcp\n");
      return;
    }

    const sessionId = request.headers["mcp-session-id"]?.toString();

    // New session: a POST without a session id must be an initialize request.
    if (!sessionId && request.method === "POST") {
      const mcp = newMcpServer(app, httpLog);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server: mcp });
          httpLog.info("session.opened", { session_id: id });
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) {
          sessions.delete(id);
          httpLog.info("session.closed", { session_id: id });
        }
        void mcp.close().catch(() => undefined);
      };
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
      return;
    }

    const session = sessionId ? sessions.get(sessionId) : undefined;
    const transport = session?.transport;

    if (!transport) {
      response.statusCode = sessionId ? 404 : 400;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: sessionId
              ? "session not found; start a new session with an initialize request"
              : "missing mcp-session-id header",
          },
          id: null,
        }),
      );
      return;
    }

    try {
      await transport.handleRequest(request, response);
    } catch (error) {
      httpLog.error("http.mcp_error", {
        session_id: sessionId,
        error: serializeError(error),
      });
      if (!response.headersSent) {
        writeCors(response);
        response.statusCode = 500;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: String(error) },
            id: null,
          }),
        );
      } else {
        response.destroy();
      }
    }
  });

  server.on("error", (error) => {
    httpLog.error("http.failed", { error: serializeError(error) });
  });

  server.listen(options.port, options.host, () => {
    httpLog.info("http.listening", {
      url: `http://${options.host}:${options.port}/mcp`,
      database: options.databaseFile,
    });
  });

  async function shutdown(signal: string): Promise<void> {
    httpLog.info("server.shutdown", { signal, sessions: sessions.size });
    for (const entry of sessions.values()) {
      await entry.transport.close().catch(() => undefined);
      await entry.server.close().catch(() => undefined);
    }
    server.close(() => {
      app.database.close();
    });
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function runSse(app: App, options: Options, logger: Logger): Promise<void> {
  const sessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();
  const sseLog = logger.child({ transport: "sse" });

  const server = createServer(async (request, response) => {
    attachRequestLog(sseLog, request, response);
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "OPTIONS") {
      writeCors(response);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      writeCors(response);
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({ status: "ok", name: SERVER_NAME, version: SERVER_VERSION }),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/mcp") {
      const mcp = newMcpServer(app, sseLog);
      const transport = new SSEServerTransport("/mcp/message", response);
      sessions.set(transport.sessionId, { transport, server: mcp });
      sseLog.info("session.opened", { session_id: transport.sessionId });
      response.on("close", () => {
        sessions.delete(transport.sessionId);
        sseLog.info("session.closed", { session_id: transport.sessionId });
        void mcp.close().catch(() => undefined);
      });
      await mcp.connect(transport);
      return;
    }

    if (request.method === "POST" && url.pathname === "/mcp/message") {
      const sessionId = request.headers["mcp-session-id"]?.toString();
      const entry = sessionId ? sessions.get(sessionId) : undefined;
      if (!entry) {
        response.statusCode = 400;
        response.end("invalid or missing mcp-session-id\n");
        return;
      }
      await entry.transport.handlePostMessage(request, response);
      return;
    }

    response.statusCode = 404;
    response.end("not found\n");
  });

  server.on("error", (error) => {
    sseLog.error("http.failed", { error: serializeError(error) });
  });

  server.listen(options.port, options.host, () => {
    sseLog.info("http.listening", {
      url: `http://${options.host}:${options.port}/mcp`,
      database: options.databaseFile,
    });
  });

  async function shutdown(signal: string): Promise<void> {
    sseLog.info("server.shutdown", { signal, sessions: sessions.size });
    for (const entry of sessions.values()) {
      await entry.transport.close().catch(() => undefined);
      await entry.server.close().catch(() => undefined);
    }
    server.close(() => {
      app.database.close();
    });
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  const logger = createLogger({ name: SERVER_NAME });
  const options = readOptions();
  logger.info("server.starting", {
    version: SERVER_VERSION,
    transport: options.transport,
    database: options.databaseFile,
    ...(options.transport === "stdio"
      ? {}
      : { host: options.host, port: options.port }),
  });
  const app = await createApp(options, logger);
  if (options.transport === "stdio") {
    await runStdio(app, options, logger);
  } else if (options.transport === "http") {
    await runHttp(app, options, logger);
  } else {
    await runSse(app, options, logger);
  }
}

main().catch((error: unknown) => {
  createLogger({ name: SERVER_NAME }).error("server.fatal", {
    error: serializeError(error),
  });
  process.exitCode = 1;
});
