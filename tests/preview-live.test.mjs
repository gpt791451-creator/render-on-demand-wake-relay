import test from "node:test";
import assert from "node:assert/strict";

const base = process.env.PREVIEW_BASE_URL;
assert.ok(base, "PREVIEW_BASE_URL must be configured");
const preview = new URL(base);
assert.equal(preview.protocol, "https:");
assert.match(preview.hostname, /^cloudflare-native-migration-render-on-demand-wake-relay\\.gpt791451\\.workers\\.dev$/);
assert.doesNotMatch(preview.hostname, /^render-on-demand-wake-relay\\.gpt791451\\.workers\\.dev$/);

let readyPromise;
async function waitForPreview() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const deadline = Date.now() + 240_000;
      let lastError;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(new URL("/health", preview), {
            signal: AbortSignal.timeout(10_000)
          });
          if (response.ok) return response;
          lastError = new Error("Preview health returned HTTP " + response.status);
        } catch (error) {
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      throw new Error("Preview did not become healthy within 240 seconds: " + String(lastError));
    })();
  }
  return readyPromise;
}

async function rpc(payload) {
  await waitForPreview();
  return fetch(new URL("/mcp", preview), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000)
  });
}

test("live Preview health is reachable and reports the expected migration version", async () => {
  const response = await waitForPreview();
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.status, "ok");
  assert.equal(health.version, "1.3.0");
  assert.deepEqual(health.features, [
    "cron_list_jobs",
    "cron_get_job",
    "cron_get_history",
    "ping"
  ]);
});

test("live Preview OAuth discovery metadata points to the Preview origin", async () => {
  const resourceResponse = await fetch(new URL("/.well-known/oauth-protected-resource", preview));
  assert.equal(resourceResponse.status, 200);
  const resource = await resourceResponse.json();
  assert.equal(resource.resource, preview.origin);
  assert.deepEqual(resource.authorization_servers, [preview.origin]);

  const serverResponse = await fetch(new URL("/.well-known/oauth-authorization-server", preview));
  assert.equal(serverResponse.status, 200);
  const server = await serverResponse.json();
  assert.equal(server.issuer, preview.origin);
  assert.equal(server.authorization_endpoint, preview.origin + "/oauth/authorize");
  assert.equal(server.token_endpoint, preview.origin + "/oauth/token");
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
});

test("live Preview MCP initialize and tools/list expose the expected four tools", async () => {
  const initialized = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cloudflare-preview-smoke", version: "1.0.0" }
    }
  });
  assert.equal(initialized.status, 200);
  const initBody = await initialized.json();
  assert.equal(initBody.result.protocolVersion, "2025-06-18");
  assert.equal(initBody.result.serverInfo.version, "1.3.0");

  const listed = await rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });
  assert.equal(listed.status, 200);
  const listBody = await listed.json();
  assert.deepEqual(listBody.result.tools.map((tool) => tool.name), [
    "ping",
    "cron_list_jobs",
    "cron_get_job",
    "cron_get_history"
  ]);
});

test("live Preview rejects unauthenticated MCP tool calls", async () => {
  const response = await rpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "ping", arguments: {} }
  });
  assert.equal(response.status, 401);
});
