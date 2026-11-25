import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../src/index.js"), "utf8");

function loadWorker({ authorize = false, fetchImpl = async () => {
  throw new Error("Unexpected outbound fetch in this test");
} } = {}) {
  let code = source.replace(/export default\s*\{/, "return {");
  assert.notEqual(code, source, "Worker module export must be found");
  if (authorize) {
    code = code.replace(
      /async function validAccess\(request, env, origin\) \{[\s\S]*?\n\}/,
      "async function validAccess() { return { scope: 'mcp:read' }; }"
    );
    assert.notEqual(code, source.replace(/^export default\s*\{/, "return {"),
      "Authorization stub must be injected only in isolated tests");
  }
  return new Function("fetch", code)(fetchImpl);
}

const origin = "https://worker-smoke.test";

async function request(worker, path, { method = "GET", body, headers = {}, env = {} } = {}) {
  return worker.fetch(new Request(origin + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body })
  }), env);
}

async function rpc(worker, payload, env = {}) {
  return request(worker, "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    env
  });
}

test("health endpoint reports migration version and no Render wake feature", async () => {
  const worker = loadWorker();
  const response = await request(worker, "/health");
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
  const worker = loadWorker();
  const response = await rpc(worker, {
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
  const worker = loadWorker();
  const response = await rpc(worker, {
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
  const worker = loadWorker();
  const response = await rpc(worker, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "ping", arguments: {} }
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, -32001);
});

test("cron inspection tools use only fixed-host GET requests", async () => {
  const requests = [];
  const mockFetch = async (url, options) => {
    requests.push({ url: String(url), method: options.method, authorization: options.headers.Authorization });
    let payload;
    if (String(url) === "https://api.cron-job.org/jobs") {
      payload = { jobs: [], someFailed: false };
    } else if (String(url) === "https://api.cron-job.org/jobs/42") {
      payload = { jobDetails: { jobId: 42, title: "test" } };
    } else if (String(url) === "https://api.cron-job.org/jobs/42/history") {
      payload = { history: [], predictions: [] };
    } else {
      throw new Error("Unexpected upstream URL");
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const worker = loadWorker({ authorize: true, fetchImpl: mockFetch });
  const env = { CRON_JOB_ORG_API_KEY: "TEST_ONLY_SECRET" };
  const outputBodies = [];
  const calls = [
    ["cron_list_jobs", {}],
    ["cron_get_job", { job_id: 42 }],
    ["cron_get_history", { job_id: 42 }]
  ];
  for (let i = 0; i < calls.length; i++) {
    const response = await rpc(worker, {
      jsonrpc: "2.0",
      id: 10 + i,
      method: "tools/call",
      params: { name: calls[i][0], arguments: calls[i][1] }
    }, env);
    assert.equal(response.status, 200);
    const body = await response.json();
    outputBodies.push(body);
    assert.equal(body.result.isError, false);
  }
  assert.deepEqual(requests.map((r) => r.url), [
    "https://api.cron-job.org/jobs",
    "https://api.cron-job.org/jobs/42",
    "https://api.cron-job.org/jobs/42/history"
  ]);
  assert.equal(requests.every((r) => r.method === "GET"), true);
  assert.equal(requests.every((r) => r.authorization === "Bearer TEST_ONLY_SECRET"), true);
  assert.equal(JSON.stringify(outputBodies).includes("TEST_ONLY_SECRET"), false);
});

test("invalid cron job IDs fail before any upstream request", async () => {
  let outboundCalls = 0;
  const worker = loadWorker({
    authorize: true,
    fetchImpl: async () => {
      outboundCalls++;
      throw new Error("Upstream must not be called for invalid IDs");
    }
  });
  const response = await rpc(worker, {
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: { name: "cron_get_job", arguments: { job_id: 0 } }
  }, { CRON_JOB_ORG_API_KEY: "TEST_ONLY_SECRET" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.isError, true);
  assert.equal(body.result.structuredContent.code, "INVALID_JOB_ID");
  assert.equal(outboundCalls, 0);
});

test("malformed JSON is rejected", async () => {
  const worker = loadWorker();
  const response = await request(worker, "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{"
  });
  assert.equal(response.status, 400);
});

test("MCP endpoint rejects unsupported HTTP methods", async () => {
  const worker = loadWorker();
  const response = await request(worker, "/mcp");
  assert.equal(response.status, 405);
  assert.match(response.headers.get("Allow") || "", /POST/);
});

test("unknown paths return 404", async () => {
  const worker = loadWorker();
  const response = await request(worker, "/not-a-route");
  assert.equal(response.status, 404);
});
