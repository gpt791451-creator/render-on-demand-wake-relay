const PROTOCOL_VERSION = "2025-06-18";
const MCP_PATH = "/mcp";

function jsonRpc(id, result) {
  return Response.json({ jsonrpc: "2.0", id, result }, {
    headers: { "Cache-Control": "no-store" }
  });
}
function rpcError(id, code, message) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, {
    status: 200,
    headers: { "Cache-Control": "no-store" }
  });
}
function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id",
    "Access-Control-Expose-Headers": "MCP-Protocol-Version, MCP-Session-Id",
    "Vary": "Origin"
  };
}
function authorized(request, env) {
  const expected = (env.RELAY_ACCESS_TOKEN || "").trim();
  const supplied = request.headers.get("Authorization") || "";
  return expected.length >= 32 && supplied.startsWith("Bearer ") &&
    constantTimeEqual(supplied.slice(7), expected);
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function wakeRender(env) {
  const base = (env.RENDER_HEALTH_URL || "").trim();
  if (!/^https:\/\/render-cron-mcp-poc\.onrender\.com\/health\/?$/.test(base)) {
    throw new Error("Render health URL is not the approved service endpoint.");
  }
  const started = Date.now();
  const deadline = started + 55000;
  let last = "not reached";
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const response = await fetch(base, {
        method: "GET",
        headers: { "Accept": "application/json", "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(12000),
        redirect: "error"
      });
      const body = await response.text();
      if (response.ok) {
        let data;
        try { data = JSON.parse(body); } catch { data = null; }
        if (data && data.status === "ok" && data.service === "render-cron-mcp-poc" &&
            data.mcpAccessConfigured === true) {
          return {
            status: "ready",
            service: data.service,
            attempts: attempt,
            elapsedMs: Date.now() - started,
            checkedAt: new Date().toISOString(),
            nextStep: "Render health endpoint is responding. The existing Render MCP tunnel can now be called."
          };
        }
        last = "health endpoint responded but readiness payload did not match";
      } else {
        last = "HTTP " + response.status;
      }
    } catch (error) {
      last = error && error.name === "TimeoutError" ? "health request timed out" : "service is waking or temporarily unreachable";
    }
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  throw new Error("Render did not become ready within 55 seconds (" + last + "). Retry the wake tool once; do not expose upstream details.");
}
async function handleRpc(request, env) {
  if (!authorized(request, env)) {
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="wake-relay"' } });
  }
  let body;
  try { body = await request.json(); } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body?.id ?? null, -32600, "Invalid JSON-RPC request");
  }
  const id = body.id;
  if (body.method === "notifications/initialized" || body.method === "notifications/cancelled") {
    return new Response(null, { status: 202 });
  }
  if (body.method === "initialize") {
    return jsonRpc(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "render-on-demand-wake-relay", version: "1.0.0" },
      instructions: "Call wake_render before calling the separate Render Cron MCP connector. This tool only wakes and verifies Render; it does not read or change cron jobs."
    });
  }
  if (body.method === "ping") return jsonRpc(id, {});
  if (body.method === "tools/list") {
    return jsonRpc(id, {
      tools: [{
        name: "wake_render",
        description: "Send an inbound HTTPS request to the Render health endpoint and wait until the Render MCP service is ready. Call this before using the separate Render Cron MCP connector after idle time. Does not modify jobs, schedules, deployments, or secrets.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      }]
    });
  }
  if (body.method === "tools/call") {
    const params = body.params || {};
    if (params.name !== "wake_render") return rpcError(id, -32602, "Unknown tool");
    try {
      const result = await wakeRender(env);
      return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
    } catch (error) {
      const result = { status: "not_ready", message: error.message };
      return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true });
    }
  }
  return rpcError(id ?? null, -32601, "Method not found");
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok", service: "render-on-demand-wake-relay" }, {
        headers: { "Cache-Control": "no-store", ...corsHeaders(request) }
      });
    }
    if (url.pathname !== MCP_PATH) return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Streamable HTTP MCP endpoint accepts POST requests.", { status: 405, headers: { Allow: "POST, OPTIONS" } });
    const response = await handleRpc(request, env);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(request))) headers.set(key, value);
    headers.set("MCP-Protocol-Version", PROTOCOL_VERSION);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  }
};
