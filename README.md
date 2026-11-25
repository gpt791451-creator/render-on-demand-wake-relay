# Cloudflare-hosted MCP Worker

This repository contains the Cloudflare Worker that serves the existing ChatGPT MCP connection.

- MCP endpoint: `/mcp` (Streamable HTTP)
- Health endpoint: `/health`
- OAuth metadata and authorization endpoints remain on this Worker.
- Current MCP tools: `ping`, `cron_list_jobs`, `cron_get_job`, and `cron_get_history`.

## Cloudflare-native migration branch

The `cloudflare-native-migration` branch removes the legacy Render wake-up path from the Worker source:

- The `wake_render` MCP tool and its long-polling implementation are removed.
- The `RENDER_HEALTH_URL` Worker variable is removed.
- The Worker no longer calls the Render service.
- The existing public Worker name, URL, MCP route, OAuth routes, and OAuth secrets are preserved for compatibility.
- The cron-job.org tools remain read-only during transition. They still require the existing `CRON_JOB_ORG_API_KEY` secret.

No Cloudflare Cron Trigger, KV, or D1 binding is added at this stage. The only recurring task documented in the legacy Render repository is a cron-job.org GET ping to Render's `/health` endpoint every 10 minutes. That keep-alive becomes unnecessary when Render is retired. A scheduled trigger must be added only if the live account inventory identifies a separate recurring workload that still needs to run.

See [docs/CLOUDFLARE_NATIVE_MIGRATION.md](docs/CLOUDFLARE_NATIVE_MIGRATION.md) for the source audit, architecture decision, validation gates, and rollback plan.

## Secrets and deployment safety

- Keep `RELAY_ACCESS_TOKEN` configured as a Cloudflare Worker secret. It is used by the existing OAuth authorization and token-signing flow.
- Keep `CRON_JOB_ORG_API_KEY` configured until the live cron-job.org job inventory is reviewed and the external dependency is explicitly retired.
- Never put secret values in source control, logs, URLs, or chat.
- This branch is not production. Do not deploy or merge it until health, OAuth, MCP protocol, authenticated tool calls, and ChatGPT connector end-to-end tests pass.
- Keep the current production Worker version and legacy Render service available for rollback until cutover acceptance.
