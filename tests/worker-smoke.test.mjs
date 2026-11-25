import test from "node:test";
import { createHash } from "node:crypto";
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


test("OAuth discovery metadata advertises the protected resource and authorization server", async () => {
  const worker = loadWorker();
  const resourceResponse = await request(worker, "/.well-known/oauth-protected-resource");
  assert.equal(resourceResponse.status, 200);
  const resource = await resourceResponse.json();
  assert.equal(resource.resource, origin);
  assert.deepEqual(resource.authorization_servers, [origin]);
  const serverResponse = await request(worker, "/.well-known/oauth-authorization-server");
  assert.equal(serverResponse.status, 200);
  const server = await serverResponse.json();
  assert.equal(server.issuer, origin);
  assert.equal(server.authorization_endpoint, origin + "/oauth/authorize");
  assert.equal(server.token_endpoint, origin + "/oauth/token");
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
});

test("OAuth dynamic registration accepts only official ChatGPT callback URLs", async () => {
  const worker = loadWorker();
  const rejected = await request(worker, "/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://attacker.example/callback"] })
  });
  assert.equal(rejected.status, 400);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.error, "invalid_redirect_uri");

  const accepted = await request(worker, "/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT smoke test",
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"]
    })
  });
  assert.equal(accepted.status, 201);
  const acceptedBody = await accepted.json();
  assert.match(acceptedBody.client_id, /^wake-/);
  assert.deepEqual(acceptedBody.redirect_uris, ["https://chatgpt.com/connector_platform_oauth_redirect"]);
});

test("OAuth authorization page describes Cloudflare MCP and not the retired Render wake flow", async () => {
  const worker = loadWorker();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: "smoke-client",
    redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    scope: "wake",
    resource: origin
  });
  const response = await request(worker, "/oauth/authorize?" + params.toString());
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /Authorize Cloudflare MCP/);
  assert.match(page, /read-only cron-job\.org tools/);
  assert.doesNotMatch(page, /Render|wake your Render service/i);
});


test("OAuth authorization code PKCE, refresh token, and authenticated ping work end to end", async () => {
  const worker = loadWorker();
  const relayPassword = "TEST_ONLY_RELAY_ACCESS_TOKEN_0123456789";
  const env = {
    RELAY_ACCESS_TOKEN: relayPassword,
    CRON_JOB_ORG_API_KEY: "TEST_ONLY_CRON_API_KEY"
  };
  const clientId = "smoke-oauth-client";
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const verifier = "smoke-verifier-value-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeForm = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: "smoke-state",
    scope: "wake",
    resource: origin,
    code_challenge: challenge,
    code_challenge_method: "S256",
    password: relayPassword
  });
  const authorizeResponse = await request(worker, "/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: authorizeForm.toString(),
    env
  });
  assert.equal(authorizeResponse.status, 200);
  const successPage = await authorizeResponse.text();
  assert.match(successPage, /Cloudflare MCP access has been approved/);
  const callbackHref = successPage.match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  assert.ok(callbackHref, "OAuth success page must provide a ChatGPT callback link");
  const code = new URL(callbackHref).searchParams.get("code");
  assert.ok(code, "OAuth callback must include an authorization code");

  const tokenForm = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
    resource: origin
  });
  const tokenResponse = await request(worker, "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenForm.toString(),
    env
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.scope, "wake");
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);

  const refreshForm = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: tokens.refresh_token,
    resource: origin
  });
  const refreshResponse = await request(worker, "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: refreshForm.toString(),
    env
  });
  assert.equal(refreshResponse.status, 200);
  const refreshed = await refreshResponse.json();
  assert.ok(refreshed.access_token);
  assert.ok(refreshed.refresh_token);

  const pingResponse = await request(worker, "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + refreshed.access_token
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "ping", arguments: {} }
    }),
    env
  });
  assert.equal(pingResponse.status, 200);
  const pingBody = await pingResponse.json();
  assert.equal(pingBody.result.structuredContent.status, "ok");
  assert.equal(pingBody.result.structuredContent.cronApiConfigured, true);
});
