# Render On-demand Wake Relay

A small Cloudflare Worker that exposes one authenticated Streamable HTTP MCP tool, `wake_render`. It sends an inbound GET to the Render `/health` endpoint and waits for the service readiness response. It does not proxy MCP traffic and does not modify jobs, schedules, deployments, or secrets.

## Why this is separate

The existing Render MCP connection uses OpenAI Secure MCP Tunnel. That tunnel can be unavailable while its tunnel client is asleep with the Render Free service. The relay is a separate, always-available HTTPS MCP endpoint. Call `wake_render` first, then call the existing Render MCP tools.

## Deploy on Cloudflare Workers Free

1. In Cloudflare Dashboard, open **Workers & Pages** and create a Worker from the Git repository `gpt791451-creator/render-cron-mcp-poc`.
2. Set the root directory to `wake-relay`, entry point to `src/index.js`, and deploy the branch `feature/cloudflare-wake-relay`.
3. In Worker **Settings → Variables and Secrets**, add secret `RELAY_ACCESS_TOKEN`. Generate a random secret of at least 32 characters. Never put it in Git or chat.
4. Confirm the deployed `/health` endpoint returns `{"status":"ok","service":"render-on-demand-wake-relay"}`.
5. In ChatGPT, add a Custom MCP connection to `https://<worker-name>.<account-subdomain>.workers.dev/mcp` using Bearer authentication with the same token, entered in the connection UI. Keep the existing Render MCP connection unchanged.
6. Test `wake_render`. It should return `status: ready`. Then test the existing Render MCP `ping`.

## Security and behavior

- Every MCP request requires Bearer auth. The public health route reveals only the relay's own fixed service name.
- The upstream URL is pinned to the exact Render service hostname and `/health` path; redirects are rejected.
- The upstream health payload is checked for the expected service name and `mcpAccessConfigured=true`.
- The relay never reads or returns Render secrets, cron-job.org credentials, job contents, or MCP access tokens.
- Wake attempts stop after 55 seconds and return a bounded error.
- No scheduled triggers, keep-alive requests, or paid services are configured.
- Cloudflare Workers Free currently includes 100,000 requests/day; Cloudflare plan limits can change. Check the current official limits before deployment.

## Local checks

Use Node.js to syntax-check `src/index.js`. For a full deployment test, deploy to a non-production Worker first, add the secret through Cloudflare, then run MCP Inspector or connect it as a Custom MCP server.
