import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { Store, Vault } from "../server/store.ts";
import { Tracker } from "../server/tracker.ts";
import { createApi } from "../server/api.ts";
import { emailSchema } from "../shared/model.ts";

test("local API enforces trust boundary, CRUD, export, and restore validation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fieldwork-api-"));
  const store = new Store(directory);
  const vault = new Vault(directory);
  const tracker = new Tracker(store, vault, {
    linksFile: "",
    importAfter: "2026-01-01",
    gmailQuery: "application",
    syncMinutes: 5,
    aiEnabled: false,
    aiProvider: "openai",
    aiModel: "gpt-4.1-mini",
    aiBaseUrl: "https://api.openai.com/v1",
    claudeCodePath: "",
    autoApplyAI: false,
  });
  const { app, gmail } = createApi(tracker, "http://127.0.0.1:3219", true);
  const server = app.listen(3219, "127.0.0.1");
  await new Promise<void>((r, j) => {
    server.once("listening", r);
    server.once("error", j);
  });
  t.after(async () => {
    tracker.stop();
    await tracker.idle();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:3219/api";
  const stateResponse = await fetch(`${base}/state`);
  const state = (await stateResponse.json()) as any;
  assert.ok(state.csrf);
  assert.equal(stateResponse.headers.get("cache-control"), "no-store");
  assert.ok(
    !stateResponse.headers
      .get("content-security-policy")
      ?.includes("unsafe-inline"),
  );
  assert.equal(
    (
      await fetch(`${base}/state`, {
        headers: { origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const invalidHostStatus = await new Promise<number | undefined>(
    (done, fail) => {
      http
        .get(
          `${base}/state`,
          { headers: { host: "evil.example" } },
          (response) => {
            response.resume();
            done(response.statusCode);
          },
        )
        .on("error", fail);
    },
  );
  assert.equal(invalidHostStatus, 403);
  assert.equal(
    (
      await fetch(`${base}/applications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ company: "Test" }),
      })
    ).status,
    403,
  );
  const request = (path: string, method: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-tracker-token": state.csrf,
        origin: "http://127.0.0.1:3219",
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await request("/discovery/settings", "POST", { pollMinutes: 0 })).status,
    400,
  );
  assert.equal(
    (
      await request("/discovery/sources", "POST", {
        url: "https://127.0.0.1/secret",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/discovery/settings", "POST", {
        enabled: false,
        locations: "Denver",
      })
    ).status,
    200,
  );
  const workerConfig = (await (
    await fetch(`${base}/discovery/worker-config`)
  ).json()) as any;
  assert.equal(workerConfig.config.locations, "Denver");
  assert.equal(workerConfig.config.enabled, true);
  assert.deepEqual(Object.keys(workerConfig).sort(), [
    "boards",
    "config",
    "githubEnabled",
    "version",
  ]);
  const created = await request("/applications", "POST", {
    company: "Juniper",
    title: "Software Engineer",
    appliedAt: "2026-09-20",
  });
  assert.equal(created.status, 201);
  const application = (await created.json()) as any;
  assert.equal(
    (
      await request(`/applications/${application.id}`, "PATCH", {
        stage: "Interviewing",
      })
    ).status,
    200,
  );
  const detail = (await (
    await fetch(`${base}/applications/${application.id}`)
  ).json()) as any;
  assert.equal(detail.application.stage, "Interviewing");
  assert.equal(detail.events.length, 2);
  assert.equal(
    (
      await request("/applications", "POST", {
        company: "Test",
        appliedAt: "2026-02-30",
      })
    ).status,
    400,
  );
  const backup = (await (await fetch(`${base}/backup`)).json()) as any;
  assert.equal(backup.version, 1);
  assert.equal(backup.tables.applications.length, 1);
  assert.equal("settings" in backup, false);
  assert.equal((await request("/restore", "POST", backup)).status, 400);
  assert.equal(
    (await request(`/applications/${application.id}`, "DELETE", {})).status,
    200,
  );
  assert.equal((await request("/restore", "POST", backup)).status, 200);
  const csv = await (await fetch(`${base}/export.csv`)).text();
  assert.match(csv, /Juniper/);
  const notFound = await fetch(`${base}/not-found`);
  assert.equal(notFound.status, 404);
  vault.set("gmailTokens", "{}");
  const unchangedSave = (await (
    await request("/settings", "POST", { settings: state.settings })
  ).json()) as any;
  assert.equal(unchangedSave.resyncing, false);
  assert.equal(tracker.sync.running, false);
  store.set("gmailAccount", "test@example.com");
  await tracker.ingestMessage({
    account: "test@example.com",
    messageId: "stale",
    threadId: "t",
    subject: "Application update",
    from: "jobs@example.com",
    receivedAt: "2026-03-01T00:00:00.000Z",
    body: "Thank you for applying to Juniper Labs.",
  });
  assert.equal(store.get("sources", "test@example.com:stale")?.state, "review");
  (gmail as any).get = async (path: string) =>
    path.startsWith("messages?") ? { messages: [] } : {};
  const changedSave = (await (
    await request("/settings", "POST", {
      settings: { ...state.settings, gmailQuery: "interview" },
    })
  ).json()) as any;
  assert.equal(changedSave.resyncing, true);
  assert.equal(tracker.settings().gmailQuery, "interview");
  while (tracker.sync.running) await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    store.get("sources", "test@example.com:stale")?.state,
    "dismissed",
  );
  await tracker.ingestMessage({
    account: "test@example.com",
    messageId: "stale-two",
    threadId: "t",
    subject: "Application update",
    from: "jobs@example.com",
    receivedAt: "2026-03-02T00:00:00.000Z",
    body: "Thank you for applying to Juniper Labs.",
  });
  assert.equal(
    (await request("/gmail/sync", "POST", { full: true, prune: true })).status,
    202,
  );
  while (tracker.sync.running) await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    store.get("sources", "test@example.com:stale-two")?.state,
    "dismissed",
  );
  vault.set("gmailTokens", "");
});

test("review queue is returned oldest first", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fieldwork-api-"));
  const store = new Store(directory);
  const vault = new Vault(directory);
  const tracker = new Tracker(store, vault, {
    linksFile: "",
    importAfter: "2026-01-01",
    gmailQuery: "application",
    syncMinutes: 5,
    aiEnabled: false,
    aiProvider: "openai",
    aiModel: "gpt-4.1-mini",
    aiBaseUrl: "https://api.openai.com/v1",
    claudeCodePath: "",
    autoApplyAI: false,
  });
  const { app } = createApi(tracker, "http://127.0.0.1:3222", true);
  const server = app.listen(3222, "127.0.0.1");
  await new Promise<void>((r, j) => {
    server.once("listening", r);
    server.once("error", j);
  });
  t.after(async () => {
    tracker.stop();
    await tracker.idle();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const extraction = emailSchema.parse({
    relevant: true,
    company: "Juniper Labs",
    title: "Software Engineer",
    postingId: "",
    url: "",
    eventType: "application_confirmed",
    confidence: 0.6,
    occurredAt: "",
    dueAt: "",
    timeZone: "",
    explanation: "",
    multipleRoles: false,
  });
  for (const [id, receivedAt, state] of [
    ["middle", "2026-03-02T09:00:00.000Z", "review"],
    ["newest", "2026-03-03T09:00:00.000Z", "failed"],
    ["oldest", "2026-03-01T09:00:00.000Z", "review"],
  ] as const)
    store.put("sources", {
      id,
      account: "test@example.com",
      messageId: id,
      threadId: id,
      subject: id,
      from: "jobs@example.com",
      excerpt: "",
      receivedAt,
      extraction,
      method: "rules",
      state,
      reason: "",
      applicationId: "",
      candidates: [],
      matchConfidence: 0,
    });
  const state = (await (
    await fetch("http://127.0.0.1:3222/api/state")
  ).json()) as any;
  assert.deepEqual(
    state.review.map((source: any) => source.id),
    ["oldest", "middle", "newest"],
  );
});

test("creating an application from an already resolved review email adds nothing", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fieldwork-api-"));
  const store = new Store(directory);
  const vault = new Vault(directory);
  const tracker = new Tracker(store, vault, {
    linksFile: "",
    importAfter: "2026-01-01",
    gmailQuery: "application",
    syncMinutes: 5,
    aiEnabled: false,
    aiProvider: "openai",
    aiModel: "gpt-4.1-mini",
    aiBaseUrl: "https://api.openai.com/v1",
    claudeCodePath: "",
    autoApplyAI: false,
  });
  const { app } = createApi(tracker, "http://127.0.0.1:3223", true);
  const server = app.listen(3223, "127.0.0.1");
  await new Promise<void>((r, j) => {
    server.once("listening", r);
    server.once("error", j);
  });
  t.after(async () => {
    tracker.stop();
    await tracker.idle();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:3223/api";
  const { csrf } = (await (await fetch(`${base}/state`)).json()) as any;
  const extraction = emailSchema.parse({
    relevant: true,
    company: "Double click fixture",
    title: "Software Engineer",
    postingId: "",
    url: "",
    eventType: "application_confirmed",
    confidence: 0.6,
    occurredAt: "",
    dueAt: "",
    timeZone: "",
    explanation: "",
    multipleRoles: false,
  });
  store.put("sources", {
    id: "double",
    account: "test@example.com",
    messageId: "double",
    threadId: "double",
    subject: "Thanks for applying",
    from: "jobs@example.com",
    excerpt: "",
    receivedAt: "2026-03-01T09:00:00.000Z",
    extraction,
    method: "rules",
    state: "review",
    reason: "",
    applicationId: "",
    candidates: [],
    matchConfidence: 0,
  });
  const create = () =>
    fetch(`${base}/review/double`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tracker-token": csrf,
        origin: "http://127.0.0.1:3223",
      },
      body: JSON.stringify({ action: "create", extraction }),
    });
  const [first, second] = await Promise.all([create(), create()]);
  assert.equal([first, second].filter((response) => response.ok).length, 1);
  // A UserError's own wording reaches the page instead of the generic message.
  const rejected = [first, second].find((response) => !response.ok)!;
  assert.equal(
    ((await rejected.json()) as any).error,
    "that email's already sorted (or not found)",
  );
  assert.equal(tracker.apps().length, 1);
});
