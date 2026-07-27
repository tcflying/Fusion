import assert from "node:assert/strict";
import test from "node:test";
import {
  isLoopbackLocalHost,
  shouldDisableLocalAuth,
} from "../lib/start-local-auth.mjs";

/*
FNXC:LocalStartupAuth 2026-07-27-03:54:
Cover the user-visible auth combinations without starting the dashboard.
*/
test("local startup enables auth by default and permits explicit loopback no-auth", () => {
  assert.equal(
    shouldDisableLocalAuth({ host: "127.0.0.1" }),
    false,
  );
  assert.equal(
    shouldDisableLocalAuth({ host: "localhost", noAuth: true }),
    true,
  );
  assert.equal(
    shouldDisableLocalAuth({ host: "::1", noAuth: true }),
    true,
  );
});

test("local startup rejects no-auth on LAN, wildcard, and conflicting flags", () => {
  assert.throws(
    () => shouldDisableLocalAuth({ host: "0.0.0.0", noAuth: true }),
    /requires bearer authentication/,
  );
  assert.throws(
    () => shouldDisableLocalAuth({ host: "192.168.1.20", noAuth: true }),
    /requires bearer authentication/,
  );
  assert.throws(
    () =>
      shouldDisableLocalAuth({
        host: "127.0.0.1",
        auth: true,
        noAuth: true,
      }),
    /cannot be used together/,
  );
});

test("loopback recognition covers IPv4 aliases and rejects unresolved names", () => {
  assert.equal(isLoopbackLocalHost("127.42.0.9"), true);
  assert.equal(isLoopbackLocalHost("[::1]"), true);
  assert.equal(isLoopbackLocalHost("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackLocalHost("devbox.local"), false);
});
