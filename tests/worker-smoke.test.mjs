import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../src/index.js"), "utf8");
const workerSource = source.replace(/^export default\s*\{/, "return {");
assert.notEqual(workerSource, source, "Worker module export must be found");
const worker = new Function(workerSource)();
const origin = "https://worker-smoke.test";

async function request(path, { method = "GET", body, headers = {} } = {}) {
  return worker.fetch(new Request(origin + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body })
  }), {});
}

async function rpc(payload) {
  return request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

test("health endpoint reports migration version and no Render wake feature", async () => {
  const response = await request("/health");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.version, "1.3.0");
  assert.deepEqual(body.features, [
    "cron_list_jobs",
    "cron_get_job",
    "cron_get_history",
    "ping"
  ]);
  assert.equal(body.features.includes("wake_render"), false);
});

test("MCP initialize negotiates the expected protocol", async () => {
  const response = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "worker-smoke-test", version: "1.0.0" }
    }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.protocolVersion, "2025-06-18");
  assert.equal(body.result.serverInfo.version, "1.3.0");
});

test("tools/list exposes only the four retained MCP tools", async () => {
  const response = await rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.result.tools.map((tool) => tool.name),
    ["ping", "cron_list_jobs", "cron_get_job", "cron_get_history"]
  );
  assert.equal(JSON.stringify(body).includes("wake_render"), false);
});

test("MCP tool calls remain OAuth-protected", async () => {
  const response = await rpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "ping", arguments: {} }
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, -32001);
});

test("malformed JSON is rejected", async () => {
  const response = await request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{"
  });
  assert.equal(response.status, 400);
});

test("MCP endpoint rejects unsupported HTTP methods", async () => {
  const response = await request("/mcp");
  assert.equal(response.status, 405);
  assert.match(response.headers.get("Allow") || "", /POST/);
});

test("unknown paths return 404", async () => {
  const response = await request("/not-a-route");
  assert.equal(response.status, 404);
});
