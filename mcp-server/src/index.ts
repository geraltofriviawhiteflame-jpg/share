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

function readOptions(): Options {
  const transportRaw = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transportRaw !== "stdio" && transportRaw !== "http" && transportRaw !== "sse") {
    throw new Error(
      `MCP_TRANSPORT must be one of "stdio", "http", "sse"; got "${transportRaw}"`,
    );
  }
  return {
    transport: transportRaw,
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
async function createApp(options: Options): Promise<App> {
  const database = await openDatabase(options.databaseFile);
  applyMigrations(database, options.migrationsDirectory);
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

async function runStdio(app: App, options: Options): Promise<void> {
  const server = createShareMcpServer(app.services);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} (stdio) ready; database: ${options.databaseFile}`,
  );
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

async function runHttp(app: App, options: Options): Promise<void> {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  const server = createServer(async (request, response) => {
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
      const server = createShareMcpServer(app.services);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server });
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) {
          sessions.delete(id);
        }
        void server.close().catch(() => undefined);
      };
      await server.connect(transport);
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

  server.listen(options.port, options.host, () => {
    console.log(
      `${SERVER_NAME} v${SERVER_VERSION} (streamable HTTP) listening on http://${options.host}:${options.port}/mcp`,
    );
  });

  async function shutdown(signal: string): Promise<void> {
    console.log(`${signal} received; shutting down`);
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

async function runSse(app: App, options: Options): Promise<void> {
  const sessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();

  const server = createServer(async (request, response) => {
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
      const server = createShareMcpServer(app.services);
      const transport = new SSEServerTransport("/mcp/message", response);
      sessions.set(transport.sessionId, { transport, server });
      response.on("close", () => {
        sessions.delete(transport.sessionId);
        void server.close().catch(() => undefined);
      });
      await server.connect(transport);
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

  server.listen(options.port, options.host, () => {
    console.log(
      `${SERVER_NAME} v${SERVER_VERSION} (SSE) listening on http://${options.host}:${options.port}/mcp`,
    );
  });

  async function shutdown(signal: string): Promise<void> {
    console.log(`${signal} received; shutting down`);
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
  const options = readOptions();
  const app = await createApp(options);
  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} starting; transport=${options.transport} database=${options.databaseFile}`,
  );
  if (options.transport === "stdio") {
    await runStdio(app, options);
  } else if (options.transport === "http") {
    await runHttp(app, options);
  } else {
    await runSse(app, options);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
