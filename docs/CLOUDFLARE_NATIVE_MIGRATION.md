# Cloudflare-native migration plan

Status: design/audit only. This branch does not change production behavior and must not be deployed until the verification gates below pass.

## Objective

Make the Cloudflare Worker the sole public MCP entry point and remove the legacy Render wake relay and the cron-job.org dependency without interrupting the existing ChatGPT MCP connection.

## Repository and runtime audit (2026-11-26)

### Cloudflare Worker repository

Repository: `gpt791451-creator/render-on-demand-wake-relay`

The current `main` source exposes a Streamable HTTP MCP endpoint at `/mcp`, OAuth endpoints, and `/health`. Its MCP catalogue currently contains:

- `ping`
- `cron_list_jobs`
- `cron_get_job`
- `cron_get_history`
- legacy `wake_render`

The three `cron_*` tools are read-only proxy calls to `https://api.cron-job.org`. They do not create, edit, enable, disable, delete, or manually run cron jobs. `wake_render` polls the fixed Render `/health` endpoint for up to 180 seconds. `wrangler.toml` still contains `RENDER_HEALTH_URL`. There is no `scheduled()` handler, Cron Trigger, KV, or D1 binding in the current Worker.

### Legacy Render repository

Repository: `gpt791451-creator/render-cron-mcp-poc`

The Render service is an isolated Python MCP server. It exposes the same read-only cron-job.org inspection tools plus `ping`, and runs OpenAI tunnel-client. Its `/health` endpoint reports only whether the MCP and cron API secrets are configured.

The repository's setup guide documents one cron-job.org keep-alive job: HTTP GET to the Render `/health` endpoint every 10 minutes. The README describes a 48–72 hour experiment. This is repository documentation, not proof of the live cron-job.org account contents.

## Architecture decision

1. Keep the existing Cloudflare Worker URL and OAuth/MCP endpoint as the public integration surface. Do not change the ChatGPT connector URL during migration.
2. Remove Render from the runtime path. Cloudflare Workers already serve requests at the edge; they do not need a Render wake-up or a keep-alive ping.
3. Treat the documented cron-job.org `/health` ping as obsolete once the Render MCP service is retired. It must not be replaced by a Cloudflare Cron Trigger: that would only schedule a no-longer-needed keep-alive request.
4. Do not add a Cron Trigger, KV, or D1 just to imitate cron-job.org. No independent recurring business task has been identified in the source repositories so far. If an actual recurring task is discovered in the live cron-job.org account, model that task explicitly as a Cloudflare `scheduled()` handler and add a trigger only for that task.
5. Preserve read-only cron-job.org inspection tools during the transition. Removing them is a separate compatibility decision because the live ChatGPT connector may currently expose them. They can be removed only after confirming they are no longer needed.
6. Keep both existing Cloudflare secrets untouched during migration. Do not copy, print, or request either secret in chat. Remove `CRON_JOB_ORG_API_KEY` only after the live job inventory has been reviewed and the cron-job.org dependency is accepted for retirement. Keep `RELAY_ACCESS_TOKEN` because the current OAuth implementation depends on it.

## Cutover and rollback gates

### Before implementation/deployment

- [ ] Verify the deployed Worker commit/version matches the intended source revision.
- [ ] Verify live `/health`, OAuth metadata, MCP initialize, `tools/list`, authenticated `ping`, and current ChatGPT connector access.
- [ ] Read the live cron-job.org job inventory using the existing protected MCP connection, if available. Record job IDs, enabled state, target host/path, schedule, and last/next execution. Redact URL query strings and credentials.
- [ ] Confirm whether any enabled job does work other than the documented Render `/health` keep-alive.
- [ ] Confirm the Render service is no longer required by any other client or tunnel.

### Implementation on this branch

- [ ] Remove the legacy `wake_render` tool and its 180-second polling implementation.
- [ ] Remove `RENDER_HEALTH_URL` from `wrangler.toml` and all remaining source/documentation references.
- [ ] Update MCP instructions, tool descriptions, and health metadata to describe the Cloudflare-native service accurately.
- [ ] Retain the OAuth flow and current MCP route; do not rotate or change credentials as part of this code migration.
- [ ] Retain cron-job.org read-only tools until the account inventory and connector compatibility decision are complete.
- [ ] Add Cloudflare Cron Trigger code/configuration only if a real recurring workload is identified. A Cron Trigger must call shared internal task logic; it is not an MCP endpoint and does not itself make MCP tools callable.

### Validation before cutover

- [ ] Static syntax/build check and Worker preview.
- [ ] OAuth authorization-code + PKCE and refresh flow.
- [ ] MCP initialize, tool discovery, authenticated tool call, and ChatGPT connector end-to-end.
- [ ] Verify there are no Render outbound requests in the new Worker path.
- [ ] Verify all retained cron-job.org inspection calls, if retained, remain read-only and redact sensitive values.
- [ ] Observe the deployed version before retiring any legacy service or secret.

### Rollback

Keep the current production `main` deployment and Render service untouched until all validation gates pass. Deploy only from this migration branch after review. If validation fails, leave or restore the existing `main` Worker version and retain Render and all secrets. Do not delete repositories, services, cron jobs, or secrets as part of the initial cutover.

## Known verification limitation

The source repositories can establish intended behavior, but they cannot establish the current contents of the live cron-job.org account or prove the live Worker is serving the latest commit. The existing Worker source has a protected `cron_list_jobs` MCP tool, but this session has not yet obtained an authenticated live call. Do not mark these checks as passed until evidence is collected.


## Progress update (2026-11-26)

### Branch-local runtime smoke checks

A local V8/Fetch-compatible harness exercised the migration branch source without deploying it:

- JavaScript parse: PASS.
- `GET /health`: HTTP 200, version 1.3.0, retained feature list only.
- MCP `initialize`: HTTP 200, protocol version `2025-06-18`.
- MCP `tools/list`: HTTP 200; exactly `ping`, `cron_list_jobs`, `cron_get_job`, `cron_get_history`.
- Unauthenticated MCP `tools/call`: HTTP 401 / OAuth-required JSON-RPC error.
- Source inspection: no `wake_render`, `wakeRender()`, `RENDER_HEALTH_URL`, or Render health URL remains in the Worker source.

These are branch-local handler smoke checks with a compatibility harness, not a Cloudflare deployment, real OAuth exchange, upstream cron API call, or ChatGPT connector E2E test.

A Node 22 GitHub Actions smoke-test workflow and seven tests were added to this branch. The GitHub Actions runs endpoint currently reports zero runs for the branch, so CI has not yet supplied an independent pass/fail result.

### Live Render/cron inventory attempt

- Render connector confirms the legacy service still exists as a Free web service and is `not_suspended`.
- Latest visible live deploy is `dep-dc3ahgjrjlhs73fau06g`, status `live`, started 2026-11-25T09:22:10Z, finished 2026-11-25T09:23:03Z, deployed commit `ce816d7a6edfcc5493f005a90e1e6269f3a77baa`.
- The existing Render Cron MCP connector still fails with: tunnel-client has not been seen for 300 seconds.
- The existing Cloudflare wake relay attempt returned after 180 seconds with upstream HTTP 502 (25 attempts); no successful wake was observed.
- Render request-log queries for `/health` and `/mcp` returned no matching entries in the queried period. This is not proof of the cron-job.org account inventory.
- Therefore the live cron-job.org job list and history remain unavailable. No cron job was changed or deleted, and no secret was read or exposed.

### Next safe action

Do not restart/redeploy the legacy Render service or delete any cron-job.org job merely to obtain the inventory. Continue the Cloudflare branch work and seek an authenticated, non-secret-exposing path to inspect the account. Production cutover remains blocked on live Worker/OAuth/connector verification and the actual cron job inventory.
