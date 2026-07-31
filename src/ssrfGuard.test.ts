/**
 * The outbound boundary, which is the one part of this server that stands
 * between a URL the model chose and the network the server sits on.
 *
 * It had no tests, and the cost showed: the IPv6 branch was a pair of string
 * prefixes that let NAT64, 6to4, the IPv4-compatible form and all of multicast
 * through, while the IPv4 branch beside it checked fourteen ranges properly.
 * The `dnsLookup` parameter exists so this file can be written at all — nothing
 * here touches a resolver or a socket.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type DnsLookup, resolvePublicUrl, SsrfError } from "./ssrfGuard.js";

/** No host reaches DNS in these tests unless the case is about DNS. */
const noLookup: DnsLookup = async () => [];
const resolvesTo =
  (...addresses: string[]): DnsLookup =>
  async () =>
    addresses.map((address) => ({ address }));

async function blocked(url: string, lookup: DnsLookup = noLookup): Promise<string> {
  try {
    await resolvePublicUrl(url, lookup);
  } catch (error) {
    assert.ok(error instanceof SsrfError, `${url} threw ${String(error)}, not SsrfError`);
    return error.message;
  }
  throw new assert.AssertionError({ message: `${url} was allowed and should not have been` });
}

async function allowed(url: string, lookup: DnsLookup = noLookup): Promise<string[]> {
  const { addresses } = await resolvePublicUrl(url, lookup);
  return addresses;
}

test("only http and https are dispatched to", async () => {
  for (const url of ["file:///etc/passwd", "gopher://x/", "ftp://example.com/", "data:text/html,x"]) {
    assert.match(await blocked(url), /Unsupported URL scheme/);
  }
  assert.deepEqual(await allowed("http://93.184.216.34/"), ["93.184.216.34"]);
});

test("a URL that does not parse is refused rather than guessed at", async () => {
  assert.match(await blocked("not a url"), /Invalid URL/);
});

test("credentials in the URL are refused", async () => {
  // They would be forwarded on the wire, and the redirect handling reasons about
  // origins on the assumption that there is nothing to leak across one.
  assert.match(await blocked("http://user:pass@93.184.216.34/"), /credentials are not allowed/);
  assert.match(await blocked("http://user@93.184.216.34/"), /credentials are not allowed/);
});

test("reserved IPv4 literals are blocked", async () => {
  const reserved = [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1", // carrier-grade NAT
    "127.0.0.1",
    "169.254.169.254", // cloud metadata
    "172.16.0.1",
    "172.31.255.254",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1", // deprecated 6to4 relay anycast
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1", // multicast
    "255.255.255.255",
  ];
  for (const address of reserved) {
    assert.match(await blocked(`http://${address}/`), /private or reserved address/, address);
  }
});

test("an obfuscated loopback literal is normalised before it is judged", async () => {
  // The URL parser folds these to 127.0.0.1, so the guard never sees the
  // original spelling — pinned because that is load-bearing, not incidental.
  for (const spelling of ["2130706433", "0177.0.0.1", "127.1"]) {
    assert.match(await blocked(`http://${spelling}/`), /private or reserved address/, spelling);
  }
});

test("public IPv4 is allowed", async () => {
  for (const address of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1"]) {
    assert.deepEqual(await allowed(`http://${address}/`), [address], address);
  }
});

test("reserved IPv6 literals are blocked", async () => {
  const reserved = [
    "::1", // loopback
    "::", // unspecified
    "fe80::1", // link-local
    "febf::1", // link-local, upper end of fe80::/10
    "fec0::1", // site-local: deprecated, but old networks still answer on it
    "fc00::1", // unique-local
    "fd12:3456::1", // unique-local
    "ff02::1", // multicast — the IPv4 equivalent was blocked, this was not
    "100::1", // discard-only
    "2001:db8::1", // documentation
    "2001::1", // Teredo
    "64:ff9b:1::1", // local-use NAT64
  ];
  for (const address of reserved) {
    assert.match(await blocked(`http://[${address}]/`), /private or reserved address/, address);
  }
});

test("an IPv4 address embedded in an IPv6 one is judged on the IPv4 address", async () => {
  // The regression this file was written for. Each of these reaches a reserved
  // IPv4 address through an IPv6 range that is itself globally routable.
  const reserved = [
    "::ffff:169.254.169.254", // IPv4-mapped, dotted
    "::ffff:a9fe:a9fe", // the same address as the URL parser normalises it
    "::ffff:127.0.0.1",
    "::ffff:0:127.0.0.1", // IPv4-translated: the marker sits one hextet earlier
    "::ffff:0:a9fe:a9fe",
    "::7f00:1", // IPv4-compatible, deprecated but still parsed
    "64:ff9b::a9fe:a9fe", // NAT64 well-known prefix → cloud metadata
    "64:ff9b::169.254.169.254",
    "2002:7f00:1::", // 6to4 carrying 127.0.0.1
  ];
  for (const address of reserved) {
    assert.match(await blocked(`http://[${address}]/`), /private or reserved address/, address);
  }
});

test("the same embedded forms still allow public addresses through", async () => {
  // Blocking these ranges outright would take most of the internet with them.
  for (const address of ["::ffff:8.8.8.8", "::ffff:0:8.8.8.8", "64:ff9b::8.8.8.8", "2002:5db8:d822::"]) {
    await allowed(`http://[${address}]/`);
  }
});

test("an address that does not parse cleanly is refused, not read as far as it goes", async () => {
  // `isIP` accepts a zone id, and parsing a hextet with `parseInt` stops at the
  // `%` rather than failing — so the address would be judged on a prefix of
  // itself. A resolver does return these for a link-local answer.
  for (const address of ["2606:2800:220:1:248:1893:25c8:1946%eth0", "fe80::1%eth0"]) {
    assert.match(
      await blocked("https://x.example.com/", resolvesTo(address)),
      /private or reserved address/,
      address,
    );
  }
});

test("public IPv6 is allowed", async () => {
  assert.deepEqual(await allowed("http://[2606:2800:220:1:248:1893:25c8:1946]/"), [
    "2606:2800:220:1:248:1893:25c8:1946",
  ]);
});

test("a host is judged on what it resolves to, not on its name", async () => {
  assert.match(
    await blocked("https://totally-public.example.com/", resolvesTo("10.0.0.5")),
    /private or reserved address: totally-public\.example\.com/,
  );
  assert.match(
    await blocked("https://x.example.com/", resolvesTo("64:ff9b::a9fe:a9fe")),
    /private or reserved address/,
  );
});

test("one private answer among several is enough to refuse", async () => {
  // A rebinding host answers with both; taking the first would be a coin flip.
  assert.match(
    await blocked("https://x.example.com/", resolvesTo("93.184.216.34", "127.0.0.1")),
    /private or reserved address/,
  );
});

test("a host that does not resolve is refused, not dispatched", async () => {
  assert.match(await blocked("https://nx.example.com/"), /Cannot resolve host/);
});

test("the resolved addresses come back so the connection can be pinned to one", async () => {
  // publicFetch pins the socket to what was checked here. If this returned the
  // name instead, every check above would be advisory.
  assert.deepEqual(await allowed("https://x.example.com/", resolvesTo("93.184.216.34")), [
    "93.184.216.34",
  ]);
});
