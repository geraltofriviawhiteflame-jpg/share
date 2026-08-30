#!/usr/bin/env node
/**
 * Wire-level smoke test: spawns the built MCP server over stdio and speaks
 * raw newline-delimited JSON-RPC, exactly like Claude Desktop or any MCP
 * client would. No SDK client is used, so this proves transport compatibility.
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

const serverPath = path.join(__dirname, "..", "dist", "mcp-server", "src", "index.js");
const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, MCP_TRANSPORT: "stdio", DATABASE_FILE: ":memory:" },
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
const pending = new Map();
let nextId = 1;

function send(method, params) {
  const id = nextId++;
  const message = { jsonrpc: "2.0", id, method };
  if (params !== undefined) message.params = params;
  child.stdin.write(`${JSON.stringify(message)}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  }
});

async function main() {
  const initialize = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0.0" },
  });
  if (!initialize.serverInfo || initialize.serverInfo.name !== "share-mcp-server") {
    throw new Error(`bad initialize result: ${JSON.stringify(initialize)}`);
  }
  console.log(`handshake ok: ${initialize.serverInfo.name} ${initialize.serverInfo.version}`);
  console.log(`instructions: ${initialize.instructions.slice(0, 80)}...`);

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const tools = await send("tools/list");
  const names = tools.tools.map((t) => t.name).sort();
  console.log(`tools (${names.length}): ${names.join(", ")}`);
  if (names.length !== 11) throw new Error(`expected 11 tools, got ${names.length}`);

  const user = await send("tools/call", {
    name: "create_user",
    arguments: { email: "smoke@example.com", display_name: "Smoke" },
  });
  const userId = JSON.parse(user.content[0].text).id;
  console.log(`create_user -> ${userId}`);

  const group = await send("tools/call", {
    name: "create_group",
    arguments: { owner_user_id: userId, name: "Smoke group" },
  });
  const groupId = JSON.parse(group.content[0].text).id;
  console.log(`create_group -> ${groupId}`);

  const balances = await send("tools/call", {
    name: "get_balances",
    arguments: { group_id: groupId },
  });
  console.log(`get_balances -> ${balances.content[0].text.split("\n").slice(0, 6).join(" ")}`);

  const bad = await send("tools/call", {
    name: "create_expense",
    arguments: {
      group_id: groupId,
      actor_member_id: "missing",
      description: "x",
      amount_paise: 100,
      expense_date: "2026-08-30",
      split_method: "equal",
      payer_member_id: "missing",
    },
  });
  if (!bad.isError) throw new Error("expected an error result for unknown member");
  console.log(`error surfaced: ${bad.content[0].text.slice(0, 60)}`);

  console.log("STDIO SMOKE TEST PASSED");
  child.kill();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  child.kill();
  process.exit(1);
});
