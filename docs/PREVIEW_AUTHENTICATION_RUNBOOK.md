# Preview authentication and connector acceptance runbook

Updated: 2026-11-26

## Current verified state

- Migration branch: `cloudflare-native-migration`
- Current branch head at runbook creation: `52f8a7f74a6f36acaca5f832a36f54dfbf01de4a`
- Pull request: #1, open, not merged.
- Latest Cloudflare Workers Preview deployment: build and deployment succeeded for commit `52f8a7f`.
- Preview URL: `https://cloudflare-native-migration-render-on-demand-wake-relay.gpt791451.workers.dev`
- Latest GitHub Actions run #35 (`45739127857`): 18/18 passed (14 isolated tests + 4 live Preview tests).
- Production remains untouched.

## Why an additional Preview secret is required

Worker Previews are isolated from Production and do not inherit Production secrets. The Worker OAuth authorization/password check and HMAC token signing both use `RELAY_ACCESS_TOKEN`. Therefore the Preview needs its own independent value before authenticated OAuth can be exercised.

Do not copy, read, print, or reuse the Production `RELAY_ACCESS_TOKEN`. Do not send any secret value through chat, GitHub, issue comments, logs, or source files.

## Set only the migration Preview secret

Run from a trusted terminal that is authenticated to the correct Cloudflare account, with this repository checked out on branch `cloudflare-native-migration`:

```bash
npx wrangler preview secret put RELAY_ACCESS_TOKEN --name cloudflare-native-migration --worker-name render-on-demand-wake-relay
```

Wrangler prompts for the secret value without requiring it in the command line. Generate a new random value with at least 32 characters and enter it only at the local prompt. Never reuse the Production secret.

The command targets the Preview named `cloudflare-native-migration`; it is not `wrangler secret put` and must not be replaced with that Production command.

After setting it, verify only the secret name (not its value):

```bash
npx wrangler preview secret list --name cloudflare-native-migration --worker-name render-on-demand-wake-relay
```

The expected list includes `RELAY_ACCESS_TOKEN`. Do not paste the full output if it contains anything beyond secret names.

Cloudflare reference: https://developers.cloudflare.com/workers/previews/configuration/

## Authenticated Preview test sequence

Once the Preview-only secret exists:

1. Open the Preview MCP server in a separate temporary ChatGPT custom connector; do not edit the existing Production connector.
2. Use the Preview MCP endpoint:
   `https://cloudflare-native-migration-render-on-demand-wake-relay.gpt791451.workers.dev/mcp`
3. Select OAuth authentication if prompted. The Worker uses dynamic client registration, Authorization Code + PKCE (S256), and refresh tokens.
4. On the Worker authorization page, enter the Preview-only password locally. Never send it in chat.
5. Confirm ChatGPT completes the callback and discovers the four tools: `ping`, `cron_list_jobs`, `cron_get_job`, and `cron_get_history`.
6. Call only `ping` first. Expected result: `status=ok`, service `cloudflare-cron-job-org-mcp`, mode `read-only`. `cronApiConfigured=false` is acceptable for this OAuth gate.
7. Verify refresh by allowing the access token to expire or using the connector's supported refresh flow; confirm a new access token is issued and authenticated `ping` still works.

The first authenticated E2E must not call the cron-job.org upstream API. It does not need a Preview `CRON_JOB_ORG_API_KEY`.

## Cron API key gate (separate)

Do not copy Production `CRON_JOB_ORG_API_KEY` into Preview. Do not add a Preview key merely to make the first OAuth test pass.

Only if the owner chooses to test live read-only cron-job.org calls, create/use a separate Preview credential and set it only on this Preview. If an isolated Preview credential is unavailable, leave the cron API calls untested and record that limitation. No job mutation tools exist in this Worker.

## Acceptance gates before production cutover

- [x] Preview Build + Deployment succeeded for current branch head.
- [x] Isolated Worker/OAuth tests passed.
- [x] Live Preview health and OAuth metadata returned HTTP 200.
- [x] Live Preview MCP initialize and tools/list returned HTTP 200.
- [x] Unauthenticated MCP tools/call returned HTTP 401.
- [ ] Preview-only authenticated OAuth Authorization Code + PKCE succeeds live.
- [ ] Preview refresh-token exchange succeeds live.
- [ ] ChatGPT connects to the separate Preview connector and calls authenticated `ping`.
- [ ] Confirm live cron-job.org inventory and decide whether any non-keepalive jobs must be migrated or retained.
- [ ] Review final diff, security, rollback, and production compatibility.

Do not merge PR #1, deploy Production, change Production secrets, or retire any existing service until every applicable gate is satisfied and explicitly reviewed.

## Important architecture boundary

This Worker is an edge-hosted MCP endpoint with four specific tools. It is not a general-purpose mobile-device/Termux control plane. This migration proves the Cloudflare-hosted MCP route and its current read-only cron inspection tools; additional device or system tools would require a separately designed and secured bridge.
