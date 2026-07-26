import { Agent } from "undici";
import { resolvePublicUrl, SsrfError } from "./ssrfGuard.js";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_CACHED_AGENTS = 64;

/**
 * Dispatchers keyed by `origin|pinned address`. Reusing one keeps the
 * connection pool warm — an agent run making many MCP tool calls would
 * otherwise pay a TCP+TLS handshake per call.
 *
 * This caches transport only. `resolvePublicUrl` still runs on every request
 * and every redirect hop, so a host that starts resolving to a private address
 * is rejected before a cached dispatcher is ever reached, and a host that
 * resolves to a different address gets a different key.
 */
const agentCache = new Map<string, Agent>();

function pinnedAgent(origin: string, address: string, family: 4 | 6): Agent {
  const key = `${origin}|${address}`;
  const cached = agentCache.get(key);
  if (cached) {
    return cached;
  }
  const agent = new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        if (typeof options === "object" && options.all) {
          callback(null, [{ address, family }]);
          return;
        }
        callback(null, address, family);
      },
    },
  });
  if (agentCache.size >= MAX_CACHED_AGENTS) {
    // Map preserves insertion order: drop the oldest entry.
    const oldestKey = agentCache.keys().next().value;
    if (oldestKey !== undefined) {
      const evicted = agentCache.get(oldestKey);
      agentCache.delete(oldestKey);
      void evicted?.close();
    }
  }
  agentCache.set(key, agent);
  return agent;
}

export class PublicFetchError extends SsrfError {
  constructor(message: string) {
    super(message);
    this.name = "PublicFetchError";
  }
}

/**
 * Fetch an operator-controlled URL through one outbound security boundary.
 * Every hop is DNS-checked, redirects may not cross origins (which prevents
 * forwarding stored credentials to another host), and native auto-following
 * is disabled so redirect targets cannot bypass validation.
 */
export async function fetchPublicUrl(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  let url =
    input instanceof Request
      ? new URL(input.url)
      : input instanceof URL
        ? new URL(input.href)
        : new URL(input);
  const originalOrigin = url.origin;
  const requestBody =
    input instanceof Request && input.method !== "GET" && input.method !== "HEAD"
      ? await input.clone().arrayBuffer()
      : undefined;
  let requestInit: RequestInit = {
    ...(input instanceof Request
      ? {
          method: input.method,
          headers: input.headers,
          body: requestBody,
          signal: input.signal,
        }
      : {}),
    ...init,
    redirect: "manual",
  };

  for (let redirects = 0; ; redirects += 1) {
    const resolved = await resolvePublicUrl(url.href);
    const address = resolved.addresses[0];
    if (!address) {
      throw new PublicFetchError(`Cannot resolve host: ${url.hostname}`);
    }
    const family = address.includes(":") ? 6 : 4;
    const dispatcher = pinnedAgent(url.origin, address, family);
    const response = await fetch(url, {
      ...requestInit,
      dispatcher,
    } as RequestInit & { dispatcher: Agent });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }
    if (redirects >= MAX_REDIRECTS) {
      throw new PublicFetchError(`Too many redirects from ${originalOrigin}`);
    }
    const location = response.headers.get("location");
    if (!location) {
      return response;
    }
    await response.body?.cancel();
    const next = new URL(location, url);
    await resolvePublicUrl(next.href);
    if (next.origin !== originalOrigin) {
      throw new PublicFetchError(
        `Cross-origin redirect blocked: ${originalOrigin} -> ${next.origin}`,
      );
    }

    const method = (requestInit.method ?? "GET").toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      const headers = new Headers(requestInit.headers);
      headers.delete("content-type");
      headers.delete("content-length");
      requestInit = { ...requestInit, method: "GET", body: undefined, headers };
    }
    url = next;
  }
}
