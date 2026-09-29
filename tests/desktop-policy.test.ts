import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isExternalLink,
  isGoogleAuthorization,
  isLocalPage,
  settleWithin,
} from "../desktop/policy";
import { Vault } from "../server/store";
import { startServer } from "../server/runtime";

test("desktop links only allow HTTP(S) and Google auth is narrowly scoped", () => {
  for (const url of [
    "file:///tmp/secret",
    "javascript:alert(1)",
    "data:text/html,test",
    "https://user:password@example.com",
    "bad",
  ])
    assert.equal(isExternalLink(url), false);
  assert.equal(isExternalLink("https://example.com/jobs/1"), true);
  assert.equal(
    isGoogleAuthorization(
      "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
    ),
    true,
  );
  for (const url of [
    "https://accounts.google.com.evil.example/o/oauth2/v2/auth",
    "http://accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com/other",
    "https://accounts.google.com:444/o/oauth2/v2/auth",
  ])
    assert.equal(isGoogleAuthorization(url), false);
  assert.equal(
    isLocalPage(
      "http://127.0.0.1:3210/?gmail=connected",
      "http://127.0.0.1:3210",
    ),
    true,
  );
  assert.equal(
    isLocalPage("http://127.0.0.1:3211", "http://127.0.0.1:3210"),
    false,
  );
  assert.equal(
    isLocalPage("http://user@127.0.0.1:3210", "http://127.0.0.1:3210"),
    false,
  );
});

test("desktop vault accepts an OS-protected key without writing a plaintext key", () => {
  const directory = mkdtempSync(join(tmpdir(), "fieldwork-protected-vault-"));
  try {
    const key = randomBytes(32);
    new Vault(directory, key).set("aiKey", "test-key");
    assert.equal(new Vault(directory, key).get("aiKey"), "test-key");
    assert.equal(existsSync(join(directory, "secrets.key")), false);
    assert.throws(() => new Vault(directory, randomBytes(32)));
    assert.throws(
      () => new Vault(directory, randomBytes(16)),
      /Invalid vault key/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("embedded server chooses a loopback port, stops cleanly, and persists data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fieldwork-runtime-"));
  mkdirSync(join(directory, "dist"));
  writeFileSync(
    join(directory, "dist/index.html"),
    "<!doctype html><title>Test</title>",
  );
  let runtime: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    runtime = await startServer({ directory, root: directory });
    const origin = runtime.origin;
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const state = await (await fetch(`${origin}/api/state`)).json();
    const response = await fetch(`${origin}/api/applications`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tracker-Token": state.csrf,
      },
      body: JSON.stringify({
        company: "Saved across restart",
        title: "Software Engineer",
      }),
    });
    assert.equal(response.status, 201);
    await runtime.stop();
    await runtime.stop();
    await assert.rejects(fetch(`${origin}/api/state`));
    runtime = await startServer({ directory, root: directory });
    assert.equal(runtime.tracker.apps()[0].company, "Saved across restart");
  } finally {
    await runtime?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shutdown waits for pending work but gives up after the time limit", async () => {
  assert.equal(await settleWithin(Promise.resolve(), 1000), true);
  assert.equal(await settleWithin(Promise.reject(new Error("x")), 1000), true);
  const started = Date.now();
  assert.equal(await settleWithin(new Promise(() => {}), 50), false);
  assert.ok(Date.now() - started < 1000);
});
