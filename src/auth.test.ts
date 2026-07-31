/**
 * Authentication has two modes and one of them lets everyone in, so the line
 * between them is worth pinning: a change that made the open mode reachable
 * while a key is configured would be silent everywhere else.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { authorizes, describeAuth } from "./auth.js";

test("with a key set, only that key as a bearer token is accepted", () => {
  assert.equal(authorizes("secret", "Bearer secret"), true);
  assert.equal(authorizes("secret", "Bearer wrong"), false);
  assert.equal(authorizes("secret", "Bearer "), false);
  assert.equal(authorizes("secret", "secret"), false);
  assert.equal(authorizes("secret", "Basic secret"), false);
  assert.equal(authorizes("secret", undefined), false);
  assert.equal(authorizes("secret", ""), false);
});

test("the scheme is matched exactly", () => {
  // Case matters: "bearer" is not the prefix this server issues instructions for,
  // and accepting variants only widens what has to be reasoned about.
  assert.equal(authorizes("secret", "bearer secret"), false);
  assert.equal(authorizes("secret", "Bearer  secret"), false);
});

test("a longer or shorter token never matches", () => {
  assert.equal(authorizes("secret", "Bearer secretx"), false);
  assert.equal(authorizes("secret", "Bearer secre"), false);
});

test("with no key configured, every caller is allowed", () => {
  assert.equal(authorizes(undefined, undefined), true);
  assert.equal(authorizes(undefined, "Bearer anything"), true);
  // An empty string is "not configured" too — an unset env var that went
  // through a shell or a Helm value arrives this way, and treating it as a
  // secret would mean the empty token authenticates.
  assert.equal(authorizes("", "Bearer anything"), true);
  assert.equal(authorizes("", undefined), true);
});

test("the startup notice names the mode", () => {
  assert.match(describeAuth("secret"), /MCP_API_KEY is set/);
  assert.match(describeAuth(undefined), /NOT set/);
  assert.match(describeAuth(undefined), /ANY caller/);
});
