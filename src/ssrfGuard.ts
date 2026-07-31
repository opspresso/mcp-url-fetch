/**
 * SSRF guard for outbound URLs. Rejects non-http(s) schemes and hosts that
 * resolve to private, loopback, link-local (incl. the 169.254.169.254 cloud
 * metadata address), or otherwise reserved ranges.
 *
 * This started as Agent Studio's guard, where the URLs were operator-registered
 * and checked once at registration and again at dispatch. Here there is no
 * registration step: the URL comes from a tool argument the *model* chose, so
 * every call is an unreviewed address and this is the only place that judges it.
 *
 * The DNS resolver is injectable so the check stays deterministic in tests.
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
  ["192.88.99.0", 24],
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

/**
 * [prefix hextets, prefix bits] for IPv6 ranges that must never be dispatched to.
 *
 * A table rather than the string-prefix regexes this replaced, for the same
 * reason IPv4 has one: `fc00::/7` and `fe80::/10` are not hextet-aligned, so a
 * prefix match on the text is an approximation, and an approximation is what let
 * multicast and the NAT64 ranges through.
 */
const BLOCKED_IPV6: [number[], number][] = [
  // ::/96 — the unspecified address, ::1, and the deprecated IPv4-compatible form.
  [[0, 0, 0, 0, 0, 0, 0, 0], 96],
  [[0x0064, 0xff9b, 0x0001, 0, 0, 0, 0, 0], 48], // local-use NAT64
  [[0x0100, 0, 0, 0, 0, 0, 0, 0], 64], // discard-only
  [[0x2001, 0, 0, 0, 0, 0, 0, 0], 23], // IETF protocol assignments (Teredo, benchmarking)
  [[0x2001, 0x0db8, 0, 0, 0, 0, 0, 0], 32], // documentation
  [[0xfc00, 0, 0, 0, 0, 0, 0, 0], 7], // unique-local
  [[0xfe80, 0, 0, 0, 0, 0, 0, 0], 10], // link-local
  [[0xfec0, 0, 0, 0, 0, 0, 0, 0], 10], // site-local: deprecated, still assigned on old networks
  [[0xff00, 0, 0, 0, 0, 0, 0, 0], 8], // multicast
];

/**
 * Ranges that carry an IPv4 address inside them, and the hextet it starts at.
 *
 * These cannot be blocked outright — most of the public internet is reachable
 * through `::ffff:0:0/96` — so the embedded address is what gets judged.
 * `64:ff9b::/96` is the one that earns its place: on a network with NAT64,
 * `64:ff9b::a9fe:a9fe` *is* the cloud metadata endpoint.
 *
 * `::ffff:0:0:0/96` is the mapped range's trick one hextet over — SIIT's
 * translated form, which puts the `ffff` marker at hextet 4 rather than 5, so
 * neither the mapped entry nor `::/96` matches it and `::ffff:0:127.0.0.1` is
 * a loopback address written in a spelling that passed.
 */
const EMBEDDED_IPV4: [number[], number, number][] = [
  [[0, 0, 0, 0, 0, 0xffff, 0, 0], 96, 6], // ::ffff:0:0/96 IPv4-mapped
  [[0, 0, 0, 0, 0xffff, 0, 0, 0], 96, 6], // ::ffff:0:0:0/96 IPv4-translated
  [[0x0064, 0xff9b, 0, 0, 0, 0, 0, 0], 96, 6], // 64:ff9b::/96 NAT64 well-known
  [[0x2002, 0, 0, 0, 0, 0, 0, 0], 16, 1], // 2002::/16 6to4
];

/** The eight 16-bit groups of an IPv6 address, or `undefined` if it is not one. */
function hextetsOf(ip: string): number[] | undefined {
  if (isIP(ip) !== 6) {
    return undefined;
  }
  let text = ip.toLowerCase();
  // A trailing dotted quad (`::ffff:1.2.3.4`) is two hextets written in IPv4
  // notation. Rewriting it leaves the rest of this on one representation — and
  // both forms do occur: a resolver returns the dotted one, the WHATWG URL
  // parser normalises a literal to hex.
  const dotted = /:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const long = ipv4ToLong(dotted[1]);
    text = `${text.slice(0, dotted.index + 1)}${(long >>> 16).toString(16)}:${(long & 0xffff).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  if (missing < 0) {
    return undefined;
  }
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  // Each group is checked rather than handed straight to `parseInt`, which stops
  // at the first character it cannot use instead of failing: `isIP` accepts a
  // zone id, and `parseInt("1946%eth0", 16)` is 0x1946 — so
  // `2606:2800::25c8:1946%eth0` would be judged on a prefix of itself. This is a
  // security boundary; an address it cannot read has to come back `undefined`
  // and be refused, which is what the caller's `if (!hextets) return true` does.
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
    return undefined;
  }
  return groups.map((group) => parseInt(group, 16));
}

function inIpv6Prefix(hextets: number[], prefix: number[], bits: number): boolean {
  for (let index = 0; index * 16 < bits; index += 1) {
    const remaining = bits - index * 16;
    const mask = remaining >= 16 ? 0xffff : (0xffff << (16 - remaining)) & 0xffff;
    if (((hextets[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) {
      return false;
    }
  }
  return true;
}

function isBlockedIpv6(ip: string): boolean {
  const hextets = hextetsOf(ip);
  if (!hextets) {
    return true; // unparseable → treat as unsafe
  }
  for (const [prefix, bits, at] of EMBEDDED_IPV4) {
    if (inIpv6Prefix(hextets, prefix, bits)) {
      const high = hextets[at] ?? 0;
      const low = hextets[at + 1] ?? 0;
      return isBlockedIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
    }
  }
  return BLOCKED_IPV6.some(([prefix, bits]) => inIpv6Prefix(hextets, prefix, bits));
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
