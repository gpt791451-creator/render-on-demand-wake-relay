const PROTOCOL_VERSION = "2025-06-18";
const MCP_PATH = "/mcp";
const SCOPE = "wake";
const ACCESS_TTL = 15 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}
function b64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromB64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
function encodeJson(value) {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}
async function hmacKey(env) {
  const secret = (env.RELAY_ACCESS_TOKEN || "").trim();
  if (secret.length < 32) throw new Error("OAuth signing secret is not configured.");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signToken(payload, env) {
  const head = encodeJson({ alg: "HS256", typ: "JWT" });
  const body = encodeJson(payload);
  const input = head + "." + body;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(input));
  return input + "." + b64url(new Uint8Array(signature));
}
async function verifyToken(token, env) {
  if (typeof token !== "string" || token.length > 8192) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const input = parts[0] + "." + parts[1];
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), fromB64url(parts[2]), new TextEncoder().encode(input));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
    if (!payload || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
function randomId(bytes = 24) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return b64url(value);
}
function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id",
    "Access-Control-Expose-Headers": "MCP-Protocol-Version, MCP-Session-Id, WWW-Authenticate",
    "Vary": "Origin"
  };
}
function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function validRedirect(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol !== "https:" || u.username || u.password || u.hash) return false;
    return u.hostname === "chatgpt.com" &&
      (u.pathname === "/connector_platform_oauth_redirect" || u.pathname.startsWith("/connector/oauth/"));
  } catch {
    return false;
  }
}
function validResource(value, origin) {
  return value === origin || value === origin + "/";
}
function oauthMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: origin + "/oauth/authorize",
    token_endpoint: origin + "/oauth/token",
    registration_endpoint: origin + "/oauth/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true
  };
}
function resourceMetadata(origin) {
  return {
    resource: origin,
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"]
  };
}
function oauthError(error, description, status = 400) {
  return json({ error, error_description: description }, status, { "Cache-Control": "no-store" });
}
async function handleRegister(request) {
  let body;
  try { body = await request.json(); } catch { return oauthError("invalid_client_metadata", "Expected a JSON registration request."); }
  const redirects = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
  if (!redirects.length || redirects.length > 5 || redirects.some(uri => !validRedirect(uri))) {
    return oauthError("invalid_redirect_uri", "Only the official ChatGPT HTTPS OAuth callback URLs are accepted.");
  }
  if (body.response_types && !body.response_types.includes("code")) return oauthError("invalid_client_metadata", "Only authorization code flow is supported.");
  if (body.grant_types && body.grant_types.some(x => !["authorization_code", "refresh_token"].includes(x))) {
    return oauthError("invalid_client_metadata", "Unsupported grant type.");
  }
  return json({
    client_id: "wake-" + randomId(18),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 120) : "ChatGPT",
    redirect_uris: redirects,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none"
  }, 201);
}
function authorizeParams(params, origin) {
  const redirectUri = params.get("redirect_uri") || "";
  const challenge = params.get("code_challenge") || "";
  return {
    response_type: params.get("response_type") || "",
    client_id: params.get("client_id") || "",
    redirect_uri: redirectUri,
    state: params.get("state") || "",
    scope: params.get("scope") || SCOPE,
    resource: params.get("resource") || "",
    code_challenge: challenge,
    code_challenge_method: params.get("code_challenge_method") || ""
  };
}
function validAuthorize(p, origin) {
  return p.response_type === "code" &&
    p.client_id.length > 0 && p.client_id.length <= 512 &&
    validRedirect(p.redirect_uri) &&
    p.code_challenge_method === "S256" &&
    /^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge) &&
    p.scope.split(/\s+/).includes(SCOPE) &&
    validResource(p.resource, origin);
}
function loginPage(p, errorText = "") {
  const hidden = Object.entries(p).map(([key, value]) =>
    '<input type="hidden" name="' + key + '" value="' + htmlEscape(value) + '">').join("");
  const error = errorText ? '<p role="alert" style="color:#b42318">' + htmlEscape(errorText) + "</p>" : "";
  const page = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Authorize Render Wake Relay</title><body style="font:16px system-ui;max-width:440px;margin:8vh auto;padding:24px;color:#222">' +
    '<h2>Connect Render Wake Relay</h2><p>Enter the private relay access password you created in Cloudflare to authorize ChatGPT to wake your Render service.</p>' +
    error + '<form method="post" action="/oauth/authorize">' + hidden +
    '<label for="password">Relay access password</label><br><input id="password" name="password" type="password" autocomplete="current-password" required style="box-sizing:border-box;width:100%;padding:12px;margin:10px 0 18px">' +
    '<button type="submit" style="padding:12px 18px">Authorize</button></form>' +
    '<p style="font-size:12px;color:#666">The password is checked by this Worker and is never returned to ChatGPT.</p></body></html>';
  return new Response(page, { status: errorText ? 400 : 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
}
async function handleAuthorize(request, env, url) {
  if (request.method === "GET") {
    const p = authorizeParams(url.searchParams, url.origin);
    if (!validAuthorize(p, url.origin)) return oauthError("invalid_request", "The authorization request is missing required OAuth or PKCE parameters.");
    return loginPage(p);
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  const form = await request.formData();
  const p = authorizeParams(new URLSearchParams(Object.fromEntries([...form.entries()].filter(([k]) => k !== "password"))), url.origin);
  if (!validAuthorize(p, url.origin)) return oauthError("invalid_request", "The authorization request is invalid.");
  const supplied = String(form.get("password") || "");
  const expected = (env.RELAY_ACCESS_TOKEN || "").trim();
  if (expected.length < 32 || supplied.length !== expected.length || !constantTimeEqual(supplied, expected)) {
    return loginPage(p, "Incorrect relay access password.");
  }
  const now = Math.floor(Date.now() / 1000);
  const code = await signToken({
    typ: "code", iss: url.origin, aud: url.origin, sub: p.client_id,
    redirect_uri: p.redirect_uri, challenge: p.code_challenge,
    scope: p.scope, resource: p.resource, state: p.state,
    iat: now, exp: now + 300, jti: randomId(12)
  }, env);
  const redirect = new URL(p.redirect_uri);
  redirect.searchParams.set("code", code);
  if (p.state) redirect.searchParams.set("state", p.state);
  redirect.searchParams.set("iss", url.origin);
  // Some in-app browsers do not follow a POST 302 reliably. Show an explicit,
  // one-tap continuation link to the validated ChatGPT callback as a fallback.
  const callback = htmlEscape(redirect.toString());
  const successPage = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Authorization successful</title><body style="font:16px system-ui;max-width:440px;margin:8vh auto;padding:24px;color:#222">' +
    '<h2>Authorization successful</h2><p>Your Render Wake Relay access has been approved. Continue back to ChatGPT to finish connecting.</p>' +
    '<p><a href="' + callback + '" style="display:inline-block;padding:12px 18px;background:#2563eb;color:white;border-radius:8px;text-decoration:none">Continue to ChatGPT</a></p>' +
    '<p style="font-size:12px;color:#666">This link contains a short-lived, single-use authorization code.</p></body></html>';
  return new Response(successPage, { status: 200, headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  } });
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function handleToken(request, env, url) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/x-www-form-urlencoded")) return oauthError("invalid_request", "Expected form-encoded token request.");
  const form = new URLSearchParams(await request.text());
  const grant = form.get("grant_type");
  const resource = form.get("resource") || "";
  if (!validResource(resource, url.origin)) return oauthError("invalid_target", "The resource parameter does not match this MCP server.");
  const clientId = form.get("client_id") || "";
  const now = Math.floor(Date.now() / 1000);
  if (grant === "authorization_code") {
    const code = await verifyToken(form.get("code") || "", env);
    const verifier = form.get("code_verifier") || "";
    if (!code || code.typ !== "code" || code.iss !== url.origin || code.aud !== url.origin ||
        code.sub !== clientId || code.redirect_uri !== form.get("redirect_uri") ||
        code.resource !== resource || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
      return oauthError("invalid_grant", "The authorization code or PKCE verifier is invalid.");
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    if (b64url(new Uint8Array(digest)) !== code.challenge) return oauthError("invalid_grant", "PKCE verification failed.");
    const access = await signToken({ typ: "access", iss: url.origin, aud: url.origin, sub: clientId, scope: code.scope, iat: now, exp: now + ACCESS_TTL, jti: randomId(12) }, env);
    const refresh = await signToken({ typ: "refresh", iss: url.origin, aud: url.origin, sub: clientId, scope: code.scope, iat: now, exp: now + REFRESH_TTL, jti: randomId(16) }, env);
    return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: code.scope });
  }
  if (grant === "refresh_token") {
    const old = await verifyToken(form.get("refresh_token") || "", env);
    if (!old || old.typ !== "refresh" || old.iss !== url.origin || old.aud !== url.origin || old.sub !== clientId) {
      return oauthError("invalid_grant", "The refresh token is invalid or expired.");
    }
    const access = await signToken({ typ: "access", iss: url.origin, aud: url.origin, sub: clientId, scope: old.scope, iat: now, exp: now + ACCESS_TTL, jti: randomId(12) }, env);
    const refresh = await signToken({ typ: "refresh", iss: url.origin, aud: url.origin, sub: clientId, scope: old.scope, iat: now, exp: now + REFRESH_TTL, jti: randomId(16) }, env);
    return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: old.scope });
  }
  return oauthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
}
async function validAccess(request, env, origin) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = await verifyToken(header.slice(7), env);
  if (!token || token.typ !== "access" || token.iss !== origin || token.aud !== origin || !token.scope?.split(/\s+/).includes(SCOPE)) return null;
  return token;
}
async function wakeRender(env) {
  const base = (env.RENDER_HEALTH_URL || "").trim();
  if (!/^https:\/\/render-cron-mcp-poc\.onrender\.com\/health\/?$/.test(base)) {
    throw new Error("Render health URL is not the approved service endpoint.");
  }
  // Render Free cold starts can exceed the former 55-second window.
  // Keep polling bounded, with per-request timeouts and backoff.
  const started = Date.now();
  const deadline = started + 180000;
  let last = "NO_RESPONSE";
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const response = await fetch(base, {
        method: "GET",
        headers: { "Accept": "application/json", "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(20000),
        redirect: "error"
      });
      if (response.ok) {
        let data = null;
        try { data = await response.json(); } catch { last = "INVALID_JSON"; }
        // /health is only the wake/readiness gate. MCP tunnel readiness is
        // verified separately by the Render Cron MCP ping after this returns.
        if (data && data.status === "ok" && data.service === "render-cron-mcp-poc") {
          return {
            status: "ready",
            service: data.service,
            mcpAccessConfigured: data.mcpAccessConfigured === true,
            cronApiConfigured: data.cronApiConfigured === true,
            attempts: attempt,
            elapsedMs: Date.now() - started,
            checkedAt: new Date().toISOString(),
            nextStep: "Health endpoint is ready. Call the separate Render Cron MCP ping to verify the tunnel."
          };
        }
        if (data) last = "READINESS_PAYLOAD_MISMATCH";
      } else {
        last = "UPSTREAM_HTTP_" + response.status;
        try { await response.body?.cancel(); } catch {}
      }
    } catch (error) {
      last = error && error.name === "TimeoutError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_NETWORK_ERROR";
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const delay = Math.min(8000, 2000 + attempt * 1000, remaining);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error("Render not ready after 180 seconds; diagnostic=" + last + "; attempts=" + attempt + ". Retry once later; do not expose upstream details.");
}
async function handleRpc(request, env, url) {
  let body;
  try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") return json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request" } });
  const id = body.id;
  if (body.method === "notifications/initialized" || body.method === "notifications/cancelled") return new Response(null, { status: 202 });
  if (body.method === "initialize") {
    return json({ jsonrpc: "2.0", id, result: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "render-on-demand-wake-relay", version: "1.1.0" },
      instructions: "Authorize this MCP server using OAuth. Call wake_render before calling the separate Render Cron MCP connector. This tool only wakes and verifies Render; it does not read or change cron jobs."
    }});
  }
  if (body.method === "ping") return json({ jsonrpc: "2.0", id, result: {} });
  if (body.method === "tools/list") {
    return json({ jsonrpc: "2.0", id, result: { tools: [{
      name: "wake_render",
      description: "Wake the approved Render Free service and wait for its health endpoint to report ready. Requires OAuth authorization. Call before using the separate Render Cron MCP connector after idle time. Does not modify jobs, schedules, deployments, or secrets.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      securitySchemes: [{ type: "oauth2", scopes: [SCOPE] }]
    }]}});
  }
  if (body.method === "tools/call") {
    const auth = await validAccess(request, env, url.origin);
    if (!auth) {
      const metadata = url.origin + "/.well-known/oauth-protected-resource";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message: "OAuth authorization is required." } }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "WWW-Authenticate": 'Bearer resource_metadata="' + metadata + '", scope="' + SCOPE + '"' }
      });
    }
    const params = body.params || {};
    if (params.name !== "wake_render") return json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } });
    try {
      const result = await wakeRender(env);
      return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false }});
    } catch (error) {
      const result = { status: "not_ready", message: error.message };
      return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true }});
    }
  }
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: "Method not found" } });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (url.pathname === "/health" && request.method === "GET") return json({ status: "ok", service: "render-on-demand-wake-relay" }, 200, corsHeaders(request));
    if (url.pathname === "/.well-known/oauth-protected-resource" && request.method === "GET") return json(resourceMetadata(url.origin), 200, corsHeaders(request));
    if (url.pathname === "/.well-known/oauth-authorization-server" && request.method === "GET") return json(oauthMetadata(url.origin), 200, corsHeaders(request));
    if (url.pathname === "/oauth/register") return request.method === "POST" ? handleRegister(request) : new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    if (url.pathname === "/oauth/authorize") return handleAuthorize(request, env, url);
    if (url.pathname === "/oauth/token") return handleToken(request, env, url);
    if (url.pathname !== MCP_PATH) return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Streamable HTTP MCP endpoint accepts POST requests.", { status: 405, headers: { Allow: "POST, OPTIONS" } });
    const response = await handleRpc(request, env, url);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(request))) headers.set(key, value);
    headers.set("MCP-Protocol-Version", PROTOCOL_VERSION);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  }
};