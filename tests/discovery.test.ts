import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, Vault } from "../server/store.ts";
import { Tracker } from "../server/tracker.ts";
import { Discovery, matchDiscovery } from "../server/discovery.ts";
import {
  boardFromUrl,
  parseBoard,
  parseGithub,
  jobIdentity,
  fetchSource,
  experience,
  isSoftwareRole,
} from "../server/discovery-providers.ts";
import {
  discoveryConfigSchema,
  workerConfigSchema,
  type DiscoveredJob,
} from "../shared/discovery.ts";
import {
  TelegramOutbox,
  telegramCredentialsSchema,
} from "../server/telegram.ts";
import { startCloudWorker } from "../server/cloud-worker.ts";
import type { publicRequest } from "../server/network.ts";

const board = boardFromUrl("https://jobs.ashbyhq.com/example", "Example")!;
const posting = (id: string, extra = {}) => ({
  title: "Software Engineer, New Grad",
  jobUrl: `https://jobs.ashbyhq.com/example/${id}`,
  location: "Denver, CO",
  descriptionPlain: "Build APIs. 0-2 years of professional experience.",
  employmentType: "FullTime",
  isListed: true,
  publishedAt: "2026-09-24T12:00:00Z",
  ...extra,
});
const response = (url: string, payload: unknown, status = 200) => ({
  status,
  url,
  headers: {},
  text: JSON.stringify(payload),
});
const credentials = {
  token: `123456:${"fixture".repeat(5)}`,
  chatId: "123456789",
};
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "fieldwork-discovery-"));
  const store = new Store(directory);
  const tracker = new Tracker(
    store,
    new Vault(directory),
    {
      linksFile: "",
      importAfter: "2026-01-01",
      gmailQuery: "application",
      syncMinutes: 5,
      aiEnabled: false,
      aiProvider: "openai",
      aiModel: "fixture",
      aiBaseUrl: "https://example.com",
      claudeCodePath: "",
      autoApplyAI: false,
    },
    async (url) => response(url, {}),
  );
  t.after(async () => {
    tracker.stop();
    await tracker.idle();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, tracker };
}
function due(store: Store) {
  store.db.exec(
    "UPDATE discovery_sources SET data=json_set(data, '$.nextCheck', '')",
  );
}
function job(id = "one"): DiscoveredJob {
  return {
    ...parseBoard(board, { jobs: [posting(id)] })[0],
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    baseline: false,
    sources: {},
    closed: false,
    disposition: "new",
    seenAt: "",
    alertedAt: "",
    applicationId: "",
  };
}

test("board URLs are strictly allowlisted and known ATS application URLs deduplicate", () => {
  for (const url of [
    "https://jobs.ashbyhq.com.evil.test/x",
    "http://jobs.ashbyhq.com/x",
    "https://127.0.0.1/jobs",
    "https://jobs.lever.co:444/x",
    "https://user:pass@jobs.lever.co/x",
  ])
    assert.equal(boardFromUrl(url), null);
  assert.equal(
    boardFromUrl("https://jobs.eu.lever.co/acme/123")?.slug,
    "eu:acme",
  );
  assert.equal(
    jobIdentity("https://boards.greenhouse.io/acme/jobs/123?gh_src=simplify"),
    jobIdentity("https://job-boards.greenhouse.io/acme/jobs/123"),
  );
  assert.equal(
    jobIdentity("https://jobs.ashbyhq.com/acme/123/application?utm_source=x"),
    jobIdentity("https://jobs.ashbyhq.com/acme/123"),
  );
});
test("GitHub HTML table respects SWE section, continuation companies, closed jobs and locations", () => {
  const html = `## 💻 Software Engineering New Grad Roles\n<table><thead><tr><th>Company</th><th>Role</th><th>Location</th><th>Application</th></tr></thead><tbody>
    <tr><td><a>Example</a></td><td>Software Engineer</td><td>Denver<br>Remote</td><td><a href="https://jobs.ashbyhq.com/example/a">Apply</a></td></tr>
    <tr><td>↳</td><td>Backend Engineer</td><td>Boston</td><td><a href="https://jobs.ashbyhq.com/example/b">Apply</a></td></tr>
    <tr><td>Closed</td><td>Software Engineer</td><td>Remote</td><td>🔒</td></tr></tbody></table>\n## Other roles\n`;
  const jobs = parseGithub(html);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1].company, "Example");
  assert.match(jobs[0].location, /Denver.*Remote/);
  assert.equal(jobs[0].publishedAt, "");
  assert.throws(() => parseGithub("layout changed"), /Unsupported/);
});
test("public board mappings exclude unlisted jobs, preserve salaries, and don't invent publication dates", () => {
  const ashby = parseBoard(board, {
    jobs: [
      posting("a", {
        compensation: {
          summaryComponents: [
            {
              compensationType: "Salary",
              currencyCode: "USD",
              interval: "1YEAR",
              minValue: 100000,
              maxValue: 150000,
            },
          ],
        },
      }),
      posting("hidden", { isListed: false }),
    ],
  });
  assert.equal(ashby.length, 1);
  assert.equal(ashby[0].annualSalaryMax, 150000);
  assert.equal(ashby[0].currency, "USD");
  const greenhouse = parseBoard(
    boardFromUrl("https://boards.greenhouse.io/example")!,
    {
      jobs: [
        {
          id: 1,
          title: "Software Engineer I",
          absolute_url: "https://boards.greenhouse.io/example/jobs/1",
          updated_at: "2026-09-24",
          content: "<p>Build things</p>",
          location: { name: "Denver" },
        },
      ],
    },
  );
  assert.equal(greenhouse[0].publishedAt, "");
  assert.equal(greenhouse[0].description, "Build things");
  const lever = parseBoard(boardFromUrl("https://jobs.lever.co/example")!, [
    {
      id: "a",
      text: "Junior Software Engineer",
      hostedUrl: "https://jobs.lever.co/example/a",
      categories: { commitment: "Full-time", location: "Remote USA" },
      workplaceType: "remote",
      salaryRange: { currency: "USD", interval: "hour", min: 40, max: 50 },
    },
  ]);
  assert.equal(lever[0].workArrangement, "Remote");
  assert.equal(lever[0].annualSalaryMax, null);
  assert.throws(
    () => parseBoard(board, { jobs: [{ title: "Invalid" }] }),
    /required job fields/,
  );
});
test("filters handle entry-level evidence, explicit seniority, unknowns, and salary currencies", () => {
  assert.equal(
    experience(
      "Software Engineer",
      "Minimum 3 years of professional experience",
    ).requiredYears,
    3,
  );
  assert.equal(
    experience("Software Engineer I", "2 years of experience preferred")
      .requiredYears,
    null,
  );
  assert.equal(isSoftwareRole("Senior Software Engineer"), false);
  const config = discoveryConfigSchema.parse({
    locations: "Denver, Boston",
    minSalary: 100000,
    includeUnknownSalary: false,
  });
  assert.ok(
    matchDiscovery(job(), config).includes(
      "Comparable annual salary is unavailable",
    ),
  );
  assert.deepEqual(
    matchDiscovery(
      { ...job(), annualSalaryMax: 120000, currency: "USD" },
      config,
    ),
    [],
  );
  assert.ok(
    matchDiscovery({ ...job(), requiredYears: 5 }, config).some((r) =>
      r.includes("Experience"),
    ),
  );
  assert.ok(
    matchDiscovery({ ...job(), location: "Austin" }, config).some((r) =>
      r.includes("Location"),
    ),
  );
});
test("quiet baselines, alert dedup, explicit applied confirmation, closure, and failure preservation", async (t) => {
  const { store, tracker } = fixture(t);
  let payload: unknown = { jobs: [posting("old")] };
  let status = 200;
  const notifications: DiscoveredJob[] = [];
  const discovery = new Discovery(
    tracker,
    async (url) => response(url, payload, status),
    (jobs) => {
      notifications.push(...jobs);
    },
  );
  discovery.configure({ enabled: true });
  discovery.enableSource("github:simplify", false);
  discovery.addBoard(board.url, board.name);
  await discovery.tick();
  assert.equal(notifications.length, 0);
  assert.equal(discovery.jobs()[0].baseline, true);
  payload = { jobs: [posting("old"), posting("new")] };
  due(store);
  await discovery.tick();
  assert.equal(notifications.length, 1);
  const fresh = notifications[0];
  discovery.updateJob(fresh.id, "seen");
  assert.equal(tracker.apps().length, 0);
  due(store);
  await discovery.tick();
  assert.equal(notifications.length, 1);
  const app = discovery.markApplied(fresh.id, "2026-09-23");
  assert.equal(app.appliedAt, "2026-09-23");
  assert.equal(discovery.markApplied(fresh.id).id, app.id);
  assert.equal(tracker.apps().length, 1);
  payload = { unexpected: [] };
  due(store);
  await discovery.tick();
  assert.ok(discovery.jobs().every((j) => !j.closed));
  status = 429;
  due(store);
  await discovery.tick();
  assert.ok(discovery.sources().find((s) => s.id === board.id)!.failures >= 2);
  status = 200;
  payload = { jobs: [] };
  due(store);
  await discovery.tick();
  assert.ok(discovery.jobs().every((j) => j.closed));
  assert.ok(workerConfigSchema.safeParse(discovery.workerConfig()).success);
  assert.equal(
    JSON.stringify(discovery.workerConfig()).includes("applicationId"),
    false,
  );
});
test("persisted baseline survives service restart and failed outbox insertion rolls back checkpoint", async (t) => {
  const { store, tracker } = fixture(t);
  let postings = [posting("old")];
  const request: typeof publicRequest = async (url) =>
    response(url, { jobs: postings });
  const initial = new Discovery(tracker, request);
  initial.configure({ enabled: true });
  initial.enableSource("github:simplify", false);
  initial.addBoard(board.url);
  await initial.tick();
  initial.stop();
  const resumed = new Discovery(tracker, request, undefined, () => {
    throw new Error("outbox unavailable");
  });
  postings = [posting("old"), posting("new")];
  due(store);
  await resumed.tick();
  assert.equal(resumed.jobs().length, 1);
  assert.equal(resumed.sources().find((s) => s.id === board.id)!.failures, 1);
});
test("Lever pagination combines pages and preserves failure rather than partial snapshots", async () => {
  const source = boardFromUrl("https://jobs.lever.co/example")!;
  let calls = 0;
  const row = (id: number) => ({
    text: "Software Engineer I",
    hostedUrl: `https://jobs.lever.co/example/${id}`,
  });
  const request: typeof publicRequest = async (url) => {
    calls++;
    return response(
      url,
      calls === 1 ? Array.from({ length: 100 }, (_, i) => row(i)) : [row(100)],
    );
  };
  const result = await fetchSource(
    source,
    request,
    new AbortController().signal,
  );
  assert.equal(calls, 2);
  assert.equal(result.jobs.length, 101);
  calls = 0;
  await assert.rejects(
    fetchSource(
      source,
      async (url) => {
        calls++;
        return response(
          url,
          calls === 1 ? Array.from({ length: 100 }, (_, i) => row(i)) : {},
          calls === 1 ? 200 : 500,
        );
      },
      new AbortController().signal,
    ),
    /HTTP 500/,
  );
});
test("pausing discovery aborts an in-flight snapshot without writing or notifying", async (t) => {
  const { tracker } = fixture(t);
  let finish!: () => void;
  const discovery = new Discovery(tracker, async (url) => {
    await new Promise<void>((r) => {
      finish = r;
    });
    return response(url, { jobs: [posting("a")] });
  });
  discovery.configure({ enabled: true });
  discovery.enableSource("github:simplify", false);
  discovery.addBoard(board.url);
  const running = discovery.tick();
  discovery.configure({ enabled: false });
  finish();
  await running;
  assert.equal(discovery.jobs().length, 0);
});
test("Telegram outbox is durable, deduplicated, plain text, and never enables paid broadcasting", async (t) => {
  const { store } = fixture(t);
  let calls = 0;
  let body: any;
  const queue = new TelegramOutbox(store, credentials, async (url, options) => {
    calls++;
    body = JSON.parse(options!.body!);
    return response(url, { ok: true });
  });
  queue.enqueue([job(), job()]);
  await queue.tick();
  assert.equal(calls, 1);
  assert.equal(queue.items()[0].state, "sent");
  assert.equal(body.allow_paid_broadcast, false);
  assert.equal(body.parse_mode, undefined);
  assert.equal(body.reply_markup.inline_keyboard[0][0].url, job().url);
  const restarted = new TelegramOutbox(store, credentials, async () => {
    throw new Error("must not resend");
  });
  restarted.enqueue([job()]);
  store.set("telegramNextSend", 0);
  await restarted.tick();
  assert.equal(restarted.items()[0].state, "sent");
  assert.equal(
    JSON.stringify(store.backup()).includes(credentials.token),
    false,
  );
  assert.equal(
    telegramCredentialsSchema.safeParse({
      ...credentials,
      chatId: "@publicChannel",
    }).success,
    false,
  );
});
test("Telegram rate limits persist retry-after and transport errors are redacted and not blindly retried", async (t) => {
  const { store } = fixture(t);
  const queue = new TelegramOutbox(store, credentials, async (url) =>
    response(url, { ok: false, parameters: { retry_after: 120 } }, 429),
  );
  queue.enqueue([job()]);
  await queue.tick();
  assert.equal(queue.items()[0].state, "pending");
  assert.ok(queue.items()[0].next > Date.now() + 110000);
  const uncertain = new TelegramOutbox(store, credentials, async () => {
    throw new Error(credentials.token);
  });
  uncertain.enqueue([job("another")]);
  store.set("telegramNextSend", 0);
  await uncertain.tick();
  const item = uncertain.items().find((i) => i.id === job("another").id)!;
  assert.equal(item.state, "uncertain");
  assert.equal(item.error.includes(credentials.token), false);
});
test("cloud worker starts without Gmail or a vault and a second instance is rejected", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fieldwork-worker-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = {
    version: 1,
    config: { enabled: true },
    githubEnabled: false,
    boards: [{ url: board.url }],
  };
  const worker = startCloudWorker(directory, config, credentials, async (url) =>
    response(url, { jobs: [posting("old")] }),
  );
  try {
    await worker.discovery.idle();
    assert.equal(worker.discovery.jobs().length, 1);
    assert.equal(worker.outbox.items().length, 0);
    assert.throws(
      () => startCloudWorker(directory, config, credentials),
      /Another worker/,
    );
  } finally {
    await worker.stop();
  }
  const restarted = startCloudWorker(
    directory,
    config,
    credentials,
    async (url) => response(url, { jobs: [posting("old")] }),
  );
  await restarted.stop();
});

test("desktop notification failures surface their message and a later success clears it", async (t) => {
  const { store, tracker } = fixture(t);
  let payload: unknown = { jobs: [posting("old")] };
  let failure = "Allow notifications fixture.";
  const discovery = new Discovery(
    tracker,
    async (url) => response(url, payload, 200),
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (failure) throw new Error(failure);
    },
  );
  discovery.configure({ enabled: true });
  discovery.enableSource("github:simplify", false);
  discovery.addBoard(board.url, board.name);
  await discovery.tick();
  payload = { jobs: [posting("old"), posting("new")] };
  // Delivery runs off the scan loop, so wait for it rather than for tick().
  const settled = async (expected: string) => {
    for (let wait = 0; wait < 100; wait++) {
      if (discovery.notificationError === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(discovery.notificationError, expected);
  };
  due(store);
  await discovery.tick();
  await settled(failure);
  const expected = failure;
  failure = "";
  payload = { jobs: [posting("old"), posting("new"), posting("newer")] };
  due(store);
  await discovery.tick();
  assert.equal(discovery.notificationError, expected);
  await settled("");
});
