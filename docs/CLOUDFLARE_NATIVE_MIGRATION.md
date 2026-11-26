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

A Node 22 GitHub Actions smoke-test workflow and nine tests were added to this branch. The suite also mocks OAuth authorization and the upstream fetch in isolation to verify all three cron inspection calls remain fixed-host GET-only, invalid job IDs fail before any upstream request, and the API key is not returned in tool responses. The GitHub Actions runs endpoint currently reports zero runs for the branch, so CI has not yet supplied an independent pass/fail result.

### Live Render/cron inventory attempt

- Render connector confirms the legacy service still exists as a Free web service and is `not_suspended`.
- Latest visible live deploy is `dep-dc3ahgjrjlhs73fau06g`, status `live`, started 2026-11-25T09:22:10Z, finished 2026-11-25T09:23:03Z, deployed commit `ce816d7a6edfcc5493f005a90e1e6269f3a77baa`.
- The existing Render Cron MCP connector still fails with: tunnel-client has not been seen for 300 seconds.
- The existing Cloudflare wake relay attempt returned after 180 seconds with upstream HTTP 502 (25 attempts); no successful wake was observed.
- A later unfiltered Render app-log inspection found one inbound `GET /health` at `2026-11-25T10:31:36Z`; the same instance logged application shutdown at `10:46:36Z`, exactly 15 minutes later. Render's official Free-service documentation says Free web services spin down after 15 minutes without inbound HTTP/WebSocket traffic. This strongly supports idle spin-down as the reason the Render tunnel disappears; the source IP of that one request was not attributed, so it is not proof that cron-job.org was the caller or that its schedule is active.
- The tunnel-client logs show startup initialization eventually succeeded, then OAuth Protected Resource Metadata discovery failed because the local MCP server returned 404 for both `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource`. The log records Harpoon `target_count=0`; this concerns the Harpoon target catalog, not proof that the main MCP channel had zero tools. The Render app uses a static Bearer credential via `MCP_EXTRA_HEADERS`; tunnel-client v0.0.20 documents `MCP_OAUTH_DISCOVERY=disabled` for static-credential MCP servers. This is a candidate Render-side configuration correction only; it has not been applied, and no Render configuration was changed.
- Render request logs still do not establish the live cron-job.org account inventory or prove that the documented 10-minute keep-alive is enabled.
- Therefore the live cron-job.org job list and history remain unavailable. No cron job was changed or deleted, and no secret was read or exposed.

### Next safe action

Do not restart/redeploy the legacy Render service or delete any cron-job.org job merely to obtain the inventory. Continue the Cloudflare branch work and seek an authenticated, non-secret-exposing path to inspect the account. Production cutover remains blocked on live Worker/OAuth/connector verification and the actual cron job inventory.


### Additional Render runtime evidence (2026-11-26)

The Render app logs now provide a stronger explanation for the stale tunnel symptom:

- The app received one observed `GET /health` at `2026-11-25T10:31:36Z`.
- The same instance began shutdown at `2026-11-25T10:46:36Z`, exactly 15 minutes later.
- Render's official Free-service documentation confirms that a Free web service spins down after 15 minutes without inbound HTTP requests or WebSocket messages: https://render.com/docs/free
- This timing strongly supports Free-tier idle spin-down as the cause of the lost Render tunnel. The caller of the single observed health request is not identified; this does not establish whether the cron-job.org keep-alive exists or is enabled.
- Tunnel-client logs show successful MCP initialization after its initial connection-refused retries, but OAuth metadata discovery returns 404 because the static-Bearer MCP app does not publish OAuth Protected Resource Metadata. Harpoon reports `target_count=0`; this is its OAuth-discovered target registry, not the main MCP tool catalogue.
- OpenAI tunnel-client v0.0.20 documents `MCP_OAUTH_DISCOVERY=disabled` for MCP servers using static credentials, with `MCP_EXTRA_HEADERS` supplying the upstream credential: https://github.com/openai/tunnel-client/blob/master/docs/configuration.md
- This is a possible correction if the Render tunnel is intentionally retained. It is not being applied because the migration objective is to remove Render from the runtime path, and no Render service configuration change is authorized in this phase.

The next priority remains Cloudflare live verification and a safe way to read the actual cron-job.org inventory. Do not infer that there are no cron jobs from missing logs, and do not delete or disable any job until its live details have been reviewed.


### GitHub Actions smoke-test failure and repair (2026-11-26)

The existing draft/working migration PR is PR #1 (`cloudflare-native-migration` -> `main`); it was already open before this continuation. Its head initially ran GitHub Actions workflow run #11 (`45678409561`), which failed all nine tests for one common harness setup error: `loadWorker()` searched for `export default {` only at the beginning of `src/index.js` using the anchored regular expression `/^export default\\s*\\{/`, while the export is at the end of the module. The Worker source itself was not the cause of those nine failures.

The test harness was corrected to locate the export anywhere in the source using `/export default\\s*\\{/`. The repair is commit `9092e9f11f46a09d8332ce0725ed3dbcddce78d3` on the migration branch. GitHub Actions run #13 (`45678810131`) completed successfully on the PR merge ref: all nine tests passed, zero failed. The job steps (checkout, Node 22 setup, smoke tests, cleanup) all completed successfully. This is independent GitHub-hosted CI evidence for the branch-local mocked Worker tests, not a Cloudflare deployment, real cron-job.org request, live OAuth exchange, or ChatGPT E2E validation.

### Cloudflare preview build status and access limitation (2026-11-26)

The already-open PR #1 contains a Cloudflare Workers & Pages bot comment for an earlier Preview build at commit `63b8e23`; that build is marked Failed and no Preview URL was produced. The comment links to the Cloudflare dashboard build record `2dc10dec-5bf2-44f5-abfc-b4f38ae9c81a`. The current GitHub connector can read the PR comment but cannot read the Cloudflare dashboard build logs. A direct Web open of the Cloudflare dashboard record and the deployed Worker's `/health` endpoint are not accessible from this session (DisabledError). A SAFE Shell `curl` request was also rejected by the host's SAFE allowlist; Full Shell was not enabled.

Cloudflare's current documentation says production-branch pushes create production builds, while non-production branches create Previews only when Preview Builds are enabled. The existing PR bot comment proves a Preview build was attempted for this branch, not that production was changed. Do not merge PR #1 or alter the production branch until the failed Preview build is diagnosed and the live Worker/OAuth/connector checks pass. The CI repair commit changed only `tests/worker-smoke.test.mjs`; it did not change Worker runtime source.


### OAuth user-facing copy and expanded CI coverage (2026-11-26)

A source scan found that the OAuth login and success pages still told users they were authorizing ChatGPT to wake a Render service, even though the Render wake tool had been removed. Updated the page title, heading, explanation, password label, and success text to describe the Cloudflare MCP and its read-only cron-job.org tools. The legacy OAuth scope string `wake` is intentionally retained for compatibility; changing it would risk breaking existing OAuth clients.

Added CI coverage for:
- OAuth protected-resource and authorization-server discovery metadata.
- Dynamic client registration accepting only official ChatGPT callback URLs and rejecting an attacker-controlled redirect.
- The Cloudflare MCP authorization page no longer mentioning the retired Render wake flow.
- Full isolated OAuth authorization-code + PKCE exchange, refresh-token exchange, and authenticated MCP `ping`, using test-only secrets and no external network call.

Latest source/test commits:
- OAuth page copy: `21d2c43d1c20856d0228179b7dc1a19948c6833b`
- OAuth metadata, registration, and login-copy tests: `53fb6a202b084aa1b94197efb5ec14337236d891`
- Full OAuth PKCE/refresh/authenticated ping test: `81a62f4e1df887d54fd2ed340a3bfe261e8c4d4d`

GitHub Actions run #20 (`45682075767`) completed successfully on Node 22: **13 tests passed, 0 failed**. This validates the Worker handler and OAuth implementation in the isolated Node test harness with test-only secrets. It is not a live Cloudflare Worker execution or ChatGPT connector end-to-end test.

The existing PR #1 is still open and the branch is 19 commits ahead of `main` with no commits behind. The only Cloudflare bot preview comment currently visible through GitHub still reports the earlier preview build for `63b8e23` as failed with no Preview URL; no successful Preview for the latest head has been evidenced. Do not merge until the Cloudflare build failure is diagnosed and live Worker/connector verification is complete.



### Cloudflare Preview build root cause and correction (2026-11-26)

The Cloudflare Workers Build Logs supplied for the failed Preview of commit `94b7111` identify the exact failure:

```
Executing user deploy command: npx wrangler preview
Wrangler 4.168.0
[ERROR] Your Wrangler configuration is missing a `previews` block to run this command.
```

This was a configuration omission, not a JavaScript, OAuth, or GitHub Actions test failure. The migration branch's `wrangler.toml` had top-level Worker settings only. Cloudflare's Worker Previews documentation explicitly requires a `previews` block and permits an empty block when no Preview-specific variables or bindings are needed.

Correction on `cloudflare-native-migration` only:
- Added `previews = {}` to `wrangler.toml`.
- Added a Node smoke test asserting the Worker name, entry point, and explicit empty Preview block.
- Updated GitHub Actions path filters so a `wrangler.toml` change runs the smoke suite.
- The Preview is not given production secrets or production bindings by this change. Do not copy `RELAY_ACCESS_TOKEN` or `CRON_JOB_ORG_API_KEY` into Preview configuration. Preview runtime authentication/upstream tools remain unverified until an isolated test-secret setup is explicitly approved.
- No production deployment, main-branch change, secret access, Render change, or cron-job mutation was performed.

The next evidence gate is a successful Cloudflare Preview build for the latest migration-branch commit, followed by non-production Preview health/OAuth/MCP checks. A successful Preview build alone is not production cutover acceptance.
