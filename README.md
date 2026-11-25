# Render On-demand Wake Relay

A Cloudflare Worker exposing one Streamable HTTP MCP tool, `wake_render`, for waking the approved Render Free service before using the separate Render Cron MCP connector.

## Authentication

The Worker implements a minimal OAuth 2.1 authorization-code flow with PKCE (S256), dynamic client registration, signed short-lived access tokens, and refresh tokens. It uses the existing Cloudflare secret `RELAY_ACCESS_TOKEN` as the private authorization password and HMAC signing key; no third-party identity provider, external API key, database, or paid service is required.

- Protected-resource metadata: `/.well-known/oauth-protected-resource`
- Authorization-server metadata: `/.well-known/oauth-authorization-server`
- Dynamic client registration: `/oauth/register`
- Authorization endpoint: `/oauth/authorize`
- Token endpoint: `/oauth/token`
- MCP endpoint: `/mcp`

When ChatGPT starts OAuth linking, the browser displays a login page. Enter the same private relay password stored as the Cloudflare Worker secret `RELAY_ACCESS_TOKEN`. Do not share that password in chat or put it in GitHub.

The authorization endpoint accepts only HTTPS ChatGPT callback URLs. The authorization code is short-lived (5 minutes), access tokens last 15 minutes, and refresh tokens last 30 days. Tokens are signed with HMAC-SHA256 using the Worker secret and checked for issuer, audience, expiry, client, PKCE, and scope.

## Deploy on Cloudflare Workers Free

1. Connect this repository to Cloudflare Workers with root directory `/`, entry point `src/index.js`, and deploy command `npx wrangler deploy`.
2. In Worker **Settings → Variables and Secrets**, keep the Production secret `RELAY_ACCESS_TOKEN` (random, at least 32 characters). It is both the OAuth login password and token-signing secret. Never put it in Git or chat.
3. Keep the existing variable `RENDER_HEALTH_URL` set to `https://render-cron-mcp-poc.onrender.com/health`.
4. Confirm `/health`, `/.well-known/oauth-protected-resource`, and `/.well-known/oauth-authorization-server` return JSON.
5. In ChatGPT, add a custom MCP server at `https://render-on-demand-wake-relay.gpt791451.workers.dev/mcp`, choose **OAuth**, acknowledge the risk warning, and create the plugin.
6. When ChatGPT launches authorization, enter the private `RELAY_ACCESS_TOKEN` in the Worker login page. Then install the plugin and test `wake_render`.
7. After `wake_render` returns `status: ready`, call `ping` on the separate existing Render Cron MCP connector to verify the tunnel is connected.

## Behavior and safety

- `wake_render` makes an inbound HTTPS request to the fixed Render health endpoint and waits up to 55 seconds for the expected service readiness payload.
- The relay does not proxy MCP traffic, read cron jobs, or modify jobs, schedules, deployments, or secrets.
- The upstream hostname and path are pinned; redirects are rejected.
- Only the `wake` scope is issued.
- No scheduled triggers, keep-alive requests, third-party identity provider, or paid services are configured.

## Local checks

Run a JavaScript syntax check on `src/index.js` with Node.js before deploying. Test OAuth discovery and authorization-code + PKCE with an MCP/OAuth inspector before production use.
