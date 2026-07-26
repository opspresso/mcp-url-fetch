/**
 * SSRF guard for operator-registered outbound URLs (MCP servers, external
 * agents). Rejects non-http(s) schemes and hosts that resolve to private,
 * loopback, link-local (incl. the 169.254.169.254 cloud metadata address), or
 * otherwise reserved ranges.
 *
 * The DNS resolver is injectable so the check stays deterministic in tests. The
 * guard is applied both at registration and at dispatch; the dispatch check
 * narrows (but cannot fully close) the DNS-rebinding window between the two.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

export type DnsLookup = (host: string) => Promise<{ address: string }[]>;

const defaultLookup: DnsLookup = (host) => lookup(host, { all: true });

/** [baseCidr, prefixBits] for IPv4 ranges that must never be dispatched to. */
const BLOCKED_IPV4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4ToLong(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inCidr(ipLong: number, baseIp: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipLong & mask) === (ipv4ToLong(baseIp) & mask);
}

function isBlockedIpv4(ip: string): boolean {
  const ipLong = ipv4ToLong(ip);
  return BLOCKED_IPV4.some(([base, bits]) => inCidr(ipLong, base, bits));
}

function isBlockedIpv6(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr === "::1" || addr === "::") {
    return true;
  }
  // IPv4-mapped (::ffff:a.b.c.d). The WHATWG URL parser normalises the tail to
  // hex (::ffff:a9fe:a9fe), so accept both the dotted and hex forms.
  if (addr.startsWith("::ffff:")) {
    const tail = addr.slice("::ffff:".length);
    if (isIP(tail) === 4) {
      return isBlockedIpv4(tail);
    }
    const hextets = tail.split(":");
    const [hi, lo] = hextets;
    if (hextets.length === 2 && hi !== undefined && lo !== undefined) {
      const high = parseInt(hi, 16);
      const low = parseInt(lo, 16);
      if (Number.isInteger(high) && Number.isInteger(low)) {
        return isBlockedIpv4(`${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`);
      }
    }
  }
  // fc00::/7 unique-local, fe80::/10 link-local.
  return /^f[cd]/.test(addr) || /^fe[89ab]/.test(addr);
}

function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return isBlockedIpv4(ip);
  }
  if (family === 6) {
    return isBlockedIpv6(ip);
  }
  return true; // unparseable → treat as unsafe
}

/**
 * Throw {@link SsrfError} if `rawUrl` is not an http(s) URL whose host resolves
 * exclusively to public addresses.
 */
export async function resolvePublicUrl(
  rawUrl: string,
  dnsLookup: DnsLookup = defaultLookup,
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`Unsupported URL scheme: ${url.protocol.replace(":", "")}`);
  }
  if (url.username || url.password) {
    throw new SsrfError("URL credentials are not allowed");
  }

  const host = url.hostname;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  let addresses: string[];
  if (isIP(bare)) {
    addresses = [bare];
  } else {
    const resolved = await dnsLookup(bare).catch(() => []);
    if (resolved.length === 0) {
      throw new SsrfError(`Cannot resolve host: ${host}`);
    }
    addresses = resolved.map((entry) => entry.address);
  }

  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new SsrfError(`URL host resolves to a private or reserved address: ${host}`);
    }
  }
  return { url, addresses };
}

export async function assertPublicUrl(
  rawUrl: string,
  dnsLookup: DnsLookup = defaultLookup,
): Promise<void> {
  await resolvePublicUrl(rawUrl, dnsLookup);
}
