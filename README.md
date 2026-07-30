# mcp-image-fetch

An MCP server with one tool: `fetch_image(url)` downloads an image and returns
its **bytes**, as an MCP `image` content block.

It exists because a URL is not an image. An agent that reads a picture's address
out of another tool — a Slack avatar, a search result — cannot edit it or hand
it to an image model: the bytes were never in hand. This closes that gap, and
only that gap.

## Why not an SDK

The protocol surface is four methods. The one off-the-shelf server that fit
(`IA-Programming/mcp-images`) no longer starts against current `mcp` releases:
its tool return annotation predates structured output, and schema generation
now fails on it. A hand-written handler has no such drift.

## Safety

This server fetches URLs a model chose, which makes it a prompt-injection
target. It reuses Agent Studio's own outbound boundary verbatim
(`src/ssrfGuard.ts`, `src/publicFetch.ts`): private, loopback, link-local and
cloud-metadata addresses are rejected, DNS is re-resolved on every request and
every redirect hop, the connection is pinned to the checked address, and
cross-origin redirects are refused. On top of that: 5MB cap (declared length
checked before the body is read), `png/jpeg/gif/webp` only, 15s timeout.

`MCP_API_KEY` is required — the process exits rather than run open.

## Run

    MCP_API_KEY=<secret> PORT=3000 node dist/server.js

    POST /mcp      JSON-RPC, Authorization: Bearer <MCP_API_KEY>
    GET  /health   liveness

## Connect from an MCP client

Clients that support remote HTTP MCP servers can connect directly to `/mcp`.
The exact configuration key names vary by client, but the connection is:

```json
{
  "mcpServers": {
    "image-fetch": {
      "url": "https://<host>/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_API_KEY>"
      }
    }
  }
}
```

No `uv` or local command is required. Clients that only support local `stdio`
servers need an HTTP-to-stdio bridge.

## Register in Agent Studio

Tools → register with the public HTTPS URL ending in `/mcp` and a header
`Authorization: Bearer <MCP_API_KEY>`. A private address will not work: Agent
Studio's own SSRF guard rejects it, by design.
