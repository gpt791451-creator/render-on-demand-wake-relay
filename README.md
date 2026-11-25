# Cloudflare Cron MCP + Legacy Render Wake Relay

This Cloudflare Worker exposes a Streamable HTTP MCP endpoint at `/mcp`.

## Direct cron-job.org MCP tools

The Worker now provides these read-only tools:

- `ping` — reports Worker availability and whether `CRON_JOB_ORG_API_KEY` is configured. It does not consume cron-job.org API quota.
- `cron_list_jobs` — calls `GET https://api.cron-job.org/jobs`.
- `cron_get_job` — calls `GET /jobs/{jobId}`.
- `cron_get_history` — calls `GET /jobs/{jobId}/history`.

The Worker only makes GET requests to the fixed `api.cron-job.org` host. It does not create, update, enable, disable, delete, or manually trigger jobs. cron-job.org's documented REST API does not expose a run-now endpoint.

The API key is read only from the Cloudflare Worker secret `CRON_JOB_ORG_API_KEY`; it is never returned by a tool or written to source control. The cron-job.org API has a default daily quota of 100 requests, so use list/detail/history calls only when needed.

## Legacy Render compatibility

The existing `wake_render` tool and OAuth endpoints remain available for rollback/compatibility. The direct cron-job.org tools do not depend on Render, Render health checks, or a Tunnel Client. The Render service and its configuration are not modified by this Worker.

## Authentication

The Worker retains its OAuth 2.1 authorization-code flow with PKCE (S256), dynamic client registration, signed short-lived access tokens, and refresh tokens. It uses the existing Cloudflare secret `RELAY_ACCESS_TOKEN` as the private authorization password and HMAC signing key.

- Protected-resource metadata: `/.well-known/oauth-protected-resource`
- Authorization-server metadata: `/.well-known/oauth-authorization-server`
- Dynamic client registration: `/oauth/register`
- Authorization endpoint: `/oauth/authorize`
- Token endpoint: `/oauth/token`
- MCP endpoint: `/mcp`

Do not share either secret in chat or put them in GitHub.

## Cloudflare Workers setup

1. Keep the existing Worker deployment and existing `RELAY_ACCESS_TOKEN` secret.
2. In Worker **Settings → Variables and Secrets → Production**, add a **Secret** named `CRON_JOB_ORG_API_KEY` and paste the API key generated in cron-job.org Settings. Do not put it in `wrangler.toml`, source files, or chat.
3. Deploy the updated `main` branch (if Git integration does not deploy automatically).
4. Check `/health` and confirm it returns HTTP 200.
5. Refresh the existing ChatGPT custom MCP connection for this Worker so its tool catalogue includes `ping`, `cron_list_jobs`, `cron_get_job`, and `cron_get_history`. The endpoint remains `https://render-on-demand-wake-relay.gpt791451.workers.dev/mcp`.
6. Test `ping`, then `cron_list_jobs`. Do not call the legacy `wake_render` for normal cron-job.org access.

## Safety and limits

- Free-tier Cloudflare Worker; no scheduled trigger or keep-alive.
- Direct outbound HTTPS to the official cron-job.org REST API only.
- Read-only API methods only.
- 15-second upstream request timeout.
- API-key and upstream error details are not returned.
- No secrets are stored in this repository.
