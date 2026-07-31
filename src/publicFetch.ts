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
 * Fetch a URL through one outbound security boundary. Every hop is DNS-checked
 * and native auto-following is disabled, so a redirect target cannot reach the
 * network without having been judged first.
 *
 * The URL is one the *model* chose, not one an operator registered, so there is
 * no earlier point at which anyone approved the address — checking per hop is
 * not defence in depth here, it is the only check there is.
 *
 * Cross-origin redirects are refused rather than re-checked: the guard would
 * still run on the new host, but a URL that answers by pointing somewhere else
 * entirely is not the URL that was asked for, and every header the caller set
 * travels with it.
 */
export async function fetchPublicUrl(input: string | URL, init?: RequestInit): Promise<Response> {
  // A copy either way — the loop below reassigns this on every redirect hop.
  let url = new URL(input);
  const originalOrigin = url.origin;
  let requestInit: RequestInit = { ...init, redirect: "manual" };

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
    // Before any resolve, and without one of its own. A cross-origin hop is
    // refused whatever it resolves to, so resolving first only bought a DNS
    // query for a request that will not be made — and it reported a hop to a
    // private address on another host as a private address rather than as the
    // cross-origin redirect it is. The hop that survives this is resolved at the
    // top of the next iteration, before anything is sent to it.
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
