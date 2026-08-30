# Share MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server for the Share
expense tracker. It exposes the existing TypeScript backend (accounts, groups,
members, expenses, balances, settlements) as MCP tools, so any MCP-compatible
agent — Claude Desktop, Claude Code, Cursor, VS Code Copilot, etc. — can read
and write the same data as the web app and REST API.

The MCP server does not duplicate the backend: it compiles the repository's
`src/` services directly and drives them through the same service layer and
SQLite database the HTTP server uses. The domain rules (integer paise,
transactional writes, actor checks, balance re-derivation) apply identically.

## Quick start

```bash
npm install           # in this folder (mcp-server/)
npm run build         # compiles repo src/ + this folder into dist/
npm test              # in-memory end-to-end tests over the MCP protocol
npm run smoke         # wire-level stdio smoke test against the built server
```

Run the server (stdio is the default transport):

```bash
npm start             # stdio
npm run start:http    # streamable HTTP on :8081
npm run start:sse     # legacy HTTP+SSE
npm run dev           # tsx watch, stdio
npm run dev:http      # tsx watch, HTTP
```

Point any MCP client at the command `node /path/to/share/mcp-server/dist/mcp-server/src/index.js`
(or `npm start` with the working directory set to `mcp-server/`).

## Transports

| Transport            | How to enable                 | Typical use                                   |
| -------------------- | ----------------------------- | --------------------------------------------- |
| `stdio` (default)    | `MCP_TRANSPORT=stdio`         | Claude Desktop, Claude Code, Cursor, VS Code  |
| Streamable HTTP      | `MCP_TRANSPORT=http`          | Remote clients, MCP Inspector                 |
| HTTP + SSE (legacy)  | `MCP_TRANSPORT=sse`           | Clients that only speak the 2024 SSE protocol |

Environment variables:

| Variable                  | Default                      | Notes                                      |
| ------------------------- | ---------------------------- | ------------------------------------------ |
| `MCP_TRANSPORT`           | `stdio`                      | `stdio`, `http`, or `sse`                  |
| `MCP_PORT`                | `8081`                       | HTTP/SSE listening port                    |
| `HOST`                    | `0.0.0.0`                    | HTTP/SSE bind address                      |
| `DATABASE_FILE`           | `<repo>/data/mcp-share.db`   | SQLite file; `:memory:` for a throwaway DB |
| `MIGRATIONS_DIRECTORY`    | `<repo>/db/migrations`       | Override only for testing                  |
| `LOG_LEVEL`               | `info`                       | `debug`, `info`, `warn`, or `error`        |
| `LOG_FORMAT`              | pretty on a TTY, else `json` | `json` or `pretty`; always written to stderr |

Logs never go to stdout (stdio JSON-RPC owns that stream). Each line is a
structured record: server start, database open, HTTP requests, session
open/close, and every tool call (`tool.done` / `tool.rejected` / `tool.failed`)
with duration. Set `LOG_LEVEL=debug` to also see tool arguments. The server
advertises the MCP `logging` capability and forwards the same tool events as
`notifications/message` to connected clients.

```bash
LOG_LEVEL=debug npm start                 # verbose stdio
LOG_LEVEL=info npm run start:http         # streamable HTTP on :8081
```

The server applies the same SQL migrations as the web backend on startup.

> **One writer per database file.** Like the web API, the MCP server loads the
> SQLite file into memory and saves it back, so it must be the only process
> using that file. It defaults to its own `data/mcp-share.db` so the web app
> (which uses `data/share.db`) can keep running. If you want the MCP server to
> be the *only* backend, point both at the same file with `DATABASE_FILE`.

## Tools

| Tool                   | Description                                              |
| ---------------------- | -------------------------------------------------------- |
| `list_users`           | People registered in the app                             |
| `create_user`          | Register a person (`email`, `display_name`, `timezone?`) |
| `list_groups`          | Groups a user belongs to (`user_id`)                     |
| `create_group`         | New group with the owner as first member                 |
| `list_members`         | Roster of a group (`group_id`)                           |
| `add_member`           | Add an existing user to a group (owner only)             |
| `list_expenses`        | Expenses in a group (`group_id`, `limit?`)               |
| `create_expense`       | Equal or exact split expense                             |
| `get_balances`         | Who owes whom + suggested transfers (`group_id`)         |
| `list_settlements`     | Recorded payments in a group (`group_id`, `limit?`)      |
| `create_settlement`    | Record a payment between two members                     |

Every tool's input schema is described in the server itself; run `tools/list`
against any transport to inspect it. Amounts are integer **paise**
(₹1 = 100 paise) everywhere, matching the REST API. Writes take
`actor_member_id` — the *member* (not user) performing the action, as returned
by `create_group` (`owner_member_id`) or `add_member`/`list_members`
(`member_id`).

The server also publishes `instructions` on initialization, which good MCP
clients surface to the agent automatically.

## Client configuration

### Any JSON-config MCP client (Cursor, VS Code Copilot, Claude Code, …)

Add to your project's `.mcp.json` (a ready-made one sits in the repository root):

```json
{
  "mcpServers": {
    "share": {
      "command": "node",
      "args": ["mcp-server/dist/mcp-server/src/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "LOG_LEVEL": "info",
        "LOG_FORMAT": "json"
      }
    }
  }
}
```

Run `npm run build` inside `mcp-server/` once before the client starts it.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "share": {
      "command": "node",
      "args": ["/absolute/path/to/share/mcp-server/dist/mcp-server/src/index.js"]
    }
  }
}
```

### Remote (HTTP) client — MCP Inspector or a hosted agent

```bash
MCP_TRANSPORT=http MCP_PORT=8081 npm start
```

then connect to `http://<host>:8081/mcp`. A landing page with the tool list and
a health check live at `http://<host>:8081/` and `/healthz`. Sessions are
stateful per the Streamable HTTP spec (`Mcp-Session-Id` header), with CORS
enabled for browser-based clients.

## How it works

```
MCP client (agent)
   │  JSON-RPC over stdio / HTTP / SSE
   ▼
mcp-server/src/index.ts        transports + per-session McpServer wiring
mcp-server/src/server.ts       11 tool definitions (zod schemas + handlers)
mcp-server/src/log.ts          structured stderr logger (JSON or pretty)
mcp-server/src/format.ts       snake_case serializers matching the REST API
   │
   ▼  (same service layer as the web app — no duplication)
src/services/accounts|groups|expenses|balance|settlements.ts
src/db/database.ts             sql.js adapter + checksummed migrations
   ▼
data/mcp-share.db              SQLite
```

Handlers call the services synchronously inside the same process, so a tool
call is a single transaction with the same invariants as `POST /v1/...`.
Domain failures (validation, not-found, conflict, forbidden) are returned as
MCP `isError` tool results with the same messages the REST API returns.

## Tests

```bash
npm test
```

The suite runs a real MCP client/server pair over in-memory transports and
covers the full happy path (user → group → member → expense → balances →
settlement), the complete tool inventory, domain-error surfacing, structured
logging, and the advertised MCP `logging` capability.

`npm run smoke` (or `node scripts/smoke-stdio.js`) spawns the *built* server and speaks raw
newline-delimited JSON-RPC over stdin/stdout, proving wire compatibility with
real clients such as Claude Desktop.

## Roadmap ideas

- Prompts (e.g. a "settle up" prompt that reads balances and drafts a plan)
- Read-only resource endpoints (`share://groups/{id}/balances`)
- MCP Server Sent Notifications (activity events → `notifications/resources/updated`)
- OAuth for the HTTP transport
