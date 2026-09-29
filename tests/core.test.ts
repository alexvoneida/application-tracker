import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, Vault } from "../server/store.ts";
import {
  Tracker,
  matchApplication,
  parseFileEntries,
  canAdvance,
} from "../server/tracker.ts";
import {
  canonicalUrl,
  isPublicAddress,
  publicRequest,
} from "../server/network.ts";
import {
  classifyRules,
  parseJobPage,
  stripQuoted,
  Extractor,
} from "../server/extraction.ts";
import { messageText, Gmail } from "../server/gmail.ts";
import {
  claudeCodeExtract,
  parseJsonObject,
  resetClaudeCode,
  resultText,
  stopClaudeCode,
} from "../server/claude-code.ts";
import {
  dateSchema,
  emailSchema,
  jobSchema,
  type Settings,
} from "../shared/model.ts";
import { csvExport } from "../server/api.ts";

const defaults: Settings = {
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
};
const jobHtml = `<html><script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "Software Engineer", hiringOrganization: { name: "Juniper Labs" }, identifier: { value: "ENG-123" }, description: "<h2>Responsibilities</h2><p>Build reliable distributed systems and collaborate with product teams to deliver high quality software for customers.</p>", jobLocationType: "TELECOMMUTE", applicantLocationRequirements: { name: "United States" }, baseSalary: { currency: "USD", value: { minValue: 140000, maxValue: 180000, unitText: "YEAR" } } })}</script></html>`;
function fixture(t: TestContext, overrides: Partial<Settings> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "fieldwork-test-"));
  const store = new Store(directory);
  const vault = new Vault(directory);
  const tracker = new Tracker(
    store,
    vault,
    { ...defaults, ...overrides },
    async (url) => ({
      status: 200,
      text: jobHtml,
      url,
      headers: { "content-type": "text/html" },
    }),
  );
  t.after(async () => {
    tracker.stop();
    await tracker.idle();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, vault, tracker };
}
const email = (extra: Record<string, unknown> = {}) =>
  emailSchema.parse({
    relevant: true,
    company: "Juniper Labs",
    title: "Software Engineer",
    postingId: "",
    url: "",
    eventType: "application_confirmed",
    confidence: 0.99,
    occurredAt: "",
    dueAt: "",
    timeZone: "",
    explanation: "",
    multipleRoles: false,
    ...extra,
  });
const message = (
  id: string,
  body = "Thank you for applying to Juniper Labs.",
  date = "2026-01-05T15:00:00.000Z",
) => ({
  account: "test@example.com",
  messageId: id,
  threadId: "thread-one",
  subject: "Application update",
  from: "jobs@example.com",
  receivedAt: date,
  body,
});

test("dates reject invalid months/days without throwing a RangeError", () => {
  for (const s of ["2026-13-01", "2026-02-30", "today"])
    assert.equal(dateSchema.safeParse(s).success, false);
  assert.equal(dateSchema.parse("2024-02-29"), "2024-02-29");
});
test("URL normalization strips only known tracking parameters", () => {
  assert.equal(
    canonicalUrl("https://example.com/jobs?id=123&utm_source=email#apply"),
    "https://example.com/jobs?id=123",
  );
  assert.notEqual(
    canonicalUrl("https://example.com/?job=1"),
    canonicalUrl("https://example.com/?job=2"),
  );
  assert.throws(() => canonicalUrl("javascript:alert(1)"));
  assert.throws(() => canonicalUrl("https://user:pass@example.com"));
});
test("job requests reject private, mapped, and reserved addresses", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2002:7f00:1::",
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  await assert.rejects(publicRequest("http://127.0.0.1/"), /Private/);
  await assert.rejects(publicRequest("http://[::1]/"), /Private/);
});
test("text parser preserves dates and reports bad lines without losing good lines", () => {
  const parsed = parseFileEntries(
    "# comment\n\nhttps://example.com/jobs/1\n2026-09-20 | https://example.com/jobs/2\n2026-02-30 | https://example.com/jobs/3\nnot a URL",
  );
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[1].date, "2026-09-20");
  assert.equal(parsed.errors.length, 2);
});
test("watcher captures roles, is idempotent on reordering, and does not delete removed lines", async (t) => {
  const { tracker, directory } = fixture(t);
  const file = join(directory, "applications.txt");
  tracker.store.set("config", { ...defaults, linksFile: file });
  writeFileSync(
    file,
    "https://example.com/jobs/1\n2026-02-01 | https://example.com/jobs/2\n",
  );
  utimesSync(file, 0, 0);
  await tracker.scanFile();
  await tracker.idle();
  assert.equal(tracker.apps().length, 2);
  const original = tracker.apps().find((a) => a.canonicalUrl.endsWith("/1"))!;
  assert.equal(original.dateBasis, "file default");
  writeFileSync(
    file,
    "2026-02-01 | https://example.com/jobs/2\nhttps://example.com/jobs/1\n",
  );
  utimesSync(file, 0, 0);
  await tracker.scanFile();
  assert.equal(tracker.apps().length, 2);
  assert.equal(tracker.app(original.id).appliedAt, original.appliedAt);
  writeFileSync(file, "");
  utimesSync(file, 0, 0);
  await tracker.scanFile();
  assert.equal(tracker.apps().length, 2);
});
test("file deletion tombstone suppresses reimport", async (t) => {
  const { tracker, directory } = fixture(t);
  const file = join(directory, "applications.txt");
  tracker.store.set("config", { ...defaults, linksFile: file });
  writeFileSync(file, "https://example.com/jobs/1\n");
  utimesSync(file, 0, 0);
  await tracker.scanFile();
  await tracker.idle();
  tracker.remove(tracker.apps()[0].id);
  await tracker.scanFile();
  assert.equal(tracker.apps().length, 0);
});
test("repeated URL captures deduplicate, but explicit reapplication creates a separate record", async (t) => {
  const { tracker } = fixture(t);
  const first = tracker.create({
    url: "https://example.com/jobs/1?utm_source=test",
  });
  const second = tracker.create({ url: "https://example.com/jobs/1" });
  assert.equal(first.id, second.id);
  tracker.create({ url: "https://example.com/jobs/1", reapply: true });
  assert.equal(tracker.apps().length, 2);
});
test("job metadata preserves salary currency/period and remote geographic restrictions", () => {
  const parsed = parseJobPage(jobHtml);
  assert.equal(parsed.fields.salary, "USD 140000 – 180000 YEAR (base)");
  assert.equal(parsed.fields.workArrangement, "Remote");
  assert.equal(parsed.fields.location, "United States");
  assert.match(parsed.text, /distributed systems/);
  assert.equal(parseJobPage("<h1>Job</h1>").fields.salary, "");
});
test("job metadata longer than the field limits is shortened instead of failing", () => {
  const locations = Array.from({ length: 80 }, (_, index) => ({
    address: {
      addressLocality: `City ${index}`,
      addressRegion: "Region",
      addressCountry: "United States",
    },
  }));
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting",
    title: "Software Engineer",
    jobLocation: locations,
    baseSalary: {
      currency: "United States dollars (USD)",
      value: { minValue: 1, maxValue: 2, unitText: "YEAR" },
    },
  })}</script>`;
  const { fields } = parseJobPage(html);
  assert.equal(fields.location.length, 1000);
  assert.ok(fields.location.startsWith("City 0, Region, United States · "));
  assert.ok(fields.location.endsWith("…"));
  assert.equal(fields.currency.length, 20);
  assert.equal(fields.title, "Software Engineer");
});
test("job extraction saves snapshots and preserves user corrections on refresh", async (t) => {
  const { tracker, store } = fixture(t);
  const app = tracker.create({ url: "https://example.com/job/123" });
  await tracker.idle();
  assert.equal(tracker.app(app.id).company, "Juniper Labs");
  tracker.update(app.id, { title: "My corrected title", salary: "" });
  await tracker.enrich(app.id);
  assert.equal(tracker.app(app.id).title, "My corrected title");
  assert.equal(tracker.app(app.id).salary, "");
  assert.equal(store.all("snapshots").length, 2);
});
test("AI failure preserves fetched description and deterministic fields", async (t) => {
  const { tracker, store } = fixture(t, { aiEnabled: true });
  const app = tracker.create({ url: "https://example.com/job/123" });
  await tracker.idle();
  assert.equal(tracker.app(app.id).enrichment, "failed");
  assert.equal(tracker.app(app.id).title, "Software Engineer");
  assert.equal(store.all("snapshots").length, 1);
});
test("an expired job page leaves old snapshots intact", async (t) => {
  const { tracker, store } = fixture(t);
  const app = tracker.create({
    company: "Test",
    description: "Previously captured job description",
  });
  (tracker as any).fetchPage = async () => ({
    status: 404,
    text: "",
    url: "",
    headers: {},
  });
  tracker.update(app.id, { url: "https://example.com/job/1" });
  await tracker.enrich(app.id);
  assert.equal(tracker.app(app.id).enrichment, "failed");
  assert.equal(
    store.all("snapshots")[0].text,
    "Previously captured job description",
  );
});
test("unknown application dates are not inferred from interviews or rejection", async (t) => {
  const { tracker } = fixture(t);
  const app = tracker.create({ company: "Juniper Labs", stage: "Unknown" });
  await tracker.ingestMessage(
    message("reject", "We regret to inform you that you were not selected."),
  );
  tracker.attach(
    "test@example.com:reject",
    app.id,
    email({ eventType: "rejected" }),
  );
  assert.equal(tracker.app(app.id).stage, "Rejected");
  assert.equal(tracker.app(app.id).appliedAt, "");
  assert.equal(tracker.app(app.id).lastActivity, "2026-01-05T15:00:00.000Z");
});
test("ambiguous company-only match never picks between two roles", (t) => {
  const { tracker } = fixture(t);
  tracker.create({ company: "Juniper Labs", title: "Backend Engineer" });
  tracker.create({ company: "Juniper Labs", title: "Frontend Engineer" });
  const match = matchApplication(email({ title: "" }), tracker.apps());
  assert.equal(match.unambiguous, false);
  assert.equal(match.candidates.length, 2);
  assert.equal(match.confidence, 0.5);
});
test("same requisition number at different companies is not an exact match", (t) => {
  const { tracker } = fixture(t);
  tracker.create({
    company: "Other Co",
    postingId: "123",
    title: "Software Engineer",
  });
  assert.equal(
    matchApplication(email({ postingId: "123" }), tracker.apps()).candidates
      .length,
    0,
  );
});
test("job URL can identify a role and repeated threads do not duplicate match candidates", async (t) => {
  const { tracker } = fixture(t);
  const app = tracker.create({ url: "https://example.com/job/123" });
  const match = matchApplication(email({ url: app.url }), tracker.apps(), [
    app.id,
    app.id,
  ]);
  assert.equal(match.unambiguous, true);
  assert.equal(match.confidence, 1);
  assert.deepEqual(match.candidates, [app.id]);
});
test("rule classifier excludes alerts and quoted previous events", () => {
  assert.equal(
    classifyRules("Job alert", "Software engineer roles for you").relevant,
    false,
  );
  assert.equal(
    classifyRules(
      "Your application",
      "Thank you for applying.\nOn Monday somebody wrote:\nWe regret to inform you",
    ).eventType,
    "application_confirmed",
  );
  assert.equal(stripQuoted("New reply\n> old rejection"), "New reply");
});
test("rule classifier recognizes representative explicit hiring events", () => {
  const samples = [
    ["Thank you for applying to Acme", "application_confirmed"],
    ["Please complete the online assessment", "assessment_invited"],
    ["We invite you to interview", "interview_invited"],
    ["Your interview is confirmed", "interview_scheduled"],
    ["Your interview has been rescheduled", "interview_rescheduled"],
    ["Your interview has been canceled", "interview_canceled"],
    ["We are pleased to offer you the position", "offer_received"],
    ["We regret to inform you that you were not selected", "rejected"],
    ["The position has been closed", "role_closed"],
  ];
  for (const [text, type] of samples)
    assert.equal(classifyRules("", text).eventType, type, text);
});
test("rule classifier ignores confirmation boilerplate and hypothetical next steps", () => {
  const confirmations = [
    "Thanks for applying to Acme for the Software Engineer role (Job ID 12345). Unfortunately, due to the volume of applications we cannot reply to everyone.",
    "Thank you for applying to Acme. If selected, you will be asked to complete an online assessment.",
    "We received your application. If you are not selected, we will not contact you further.",
    "Thank you for applying. Should your background match the role, we will invite you to interview.",
    "Thank you for applying. Due to high volume, we may not be moving forward with all candidates, and only those selected will be contacted.",
    "Thank you for applying. Candidates who are not selected will be notified.",
    "Thank you for applying. If we decide to move forward, we will contact you to schedule an interview.",
    "Thank you for applying. If your experience is a strong match, we'll invite you to interview.",
    "Thank you for applying. As a next step, you may be asked to complete an assessment.",
    "Thank you for applying. Applicants that are chosen will be asked to complete a coding challenge.",
    "Thank you for applying. We are unable to offer visa sponsorship for this role.",
    "Thank you for applying. If you are\nselected, we will invite you to interview with the team.",
  ];
  for (const text of confirmations)
    assert.equal(
      classifyRules("", text).eventType,
      "application_confirmed",
      text,
    );
  const decisions = [
    [
      "Thank you for applying to Acme. Unfortunately, we have decided to move forward with other candidates.",
      "rejected",
    ],
    [
      "Thank you for your interest. Unfortunately, the position has been filled.",
      "rejected",
    ],
    [
      "Thank you for applying. Please complete the online assessment within 5 days.",
      "assessment_invited",
    ],
    [
      "We have decided not to move forward at this time, but should another position be a match, we will contact you.",
      "rejected",
    ],
    [
      "We will not be moving forward with your candidacy, however we will keep your resume on file and reach out if a role is a match.",
      "rejected",
    ],
    [
      "We'd like to invite you to interview, and if you are successful in that round we will discuss next steps.",
      "interview_invited",
    ],
    [
      "Unfortunately we are unable to offer you the position at this time.",
      "rejected",
    ],
    ["Unfortunately, we have chosen to pursue other candidates.", "rejected"],
    ["We have chosen to move ahead with other candidates.", "rejected"],
    ["We are going to pursue other applicants.", "rejected"],
    ["We will not be pursuing your candidacy.", "rejected"],
    ["We won't be moving forward with your application.", "rejected"],
    ["Your application was unsuccessful.", "rejected"],
    ["We have filled the position with another candidate.", "rejected"],
    ["We have decided to go with another candidate.", "rejected"],
    [
      "After careful consideration, we have decided to move forward with candidates whose experience more closely matches our needs.",
      "rejected",
    ],
    [
      "We have decided to move forward with your candidacy and would like to invite you to interview.",
      "interview_invited",
    ],
    [
      "Please share your availability for an interview. If the proposed times don't fit, let us know.",
      "interview_invited",
    ],
  ];
  for (const [text, type] of decisions)
    assert.equal(classifyRules("", text).eventType, type, text);
});
test("Gmail MIME parser prefers plain text and ignores attachments", () => {
  const enc = (s: string) => Buffer.from(s).toString("base64url");
  assert.equal(
    messageText({
      parts: [
        { mimeType: "text/html", body: { data: enc("<p>HTML</p>") } },
        { mimeType: "text/plain", body: { data: enc("Plain") } },
        {
          mimeType: "text/plain",
          filename: "attachment.txt",
          body: { data: enc("Secret attachment") },
        },
      ],
    }),
    "Plain",
  );
});
test("duplicate source imports and review attachments produce only one event", async (t) => {
  const { tracker, store } = fixture(t);
  const app = tracker.create({ company: "Juniper Labs", stage: "Unknown" });
  await tracker.ingestMessage(message("one"));
  await tracker.ingestMessage(message("one"));
  assert.equal(store.all("sources").length, 1);
  tracker.attach("test@example.com:one", app.id, email());
  assert.throws(
    () => tracker.attach("test@example.com:one", app.id, email()),
    /already/,
  );
  assert.equal(store.all("events").length, 1);
  assert.equal(tracker.app(app.id).dateBasis, "confirmation estimate");
});
test("re-running the candidate search dismisses review messages it no longer returns", async (t) => {
  const { tracker, store } = fixture(t);
  await tracker.ingestMessage(message("keep"));
  await tracker.ingestMessage(message("drop"));
  await tracker.ingestMessage({ ...message("linked"), threadId: "thread-two" });
  await tracker.ingestMessage({
    ...message("other"),
    account: "second@example.com",
  });
  const app = tracker.create({ company: "Juniper Labs", stage: "Unknown" });
  tracker.attach("test@example.com:linked", app.id, email());
  const pruned = tracker.pruneReview(
    "test@example.com",
    new Set(["test@example.com:keep"]),
  );
  assert.equal(pruned, 1);
  const dropped = store.get("sources", "test@example.com:drop")!;
  assert.equal(dropped.state, "dismissed");
  assert.equal(dropped.excerpt, "");
  assert.match(dropped.reason, /no longer matches/i);
  assert.equal(store.get("sources", "test@example.com:keep")?.state, "review");
  assert.equal(
    store.get("sources", "test@example.com:linked")?.state,
    "attached",
  );
  assert.equal(
    store.get("sources", "second@example.com:other")?.state,
    "review",
  );
  assert.equal(tracker.detail(app.id).events.length, 1);
});
test("late confirmation records history without regressing an interview", async (t) => {
  const { tracker } = fixture(t);
  const app = tracker.create({ company: "Juniper Labs", stage: "Unknown" });
  await tracker.ingestMessage(
    message(
      "interview",
      "We invite you to interview",
      "2026-02-01T15:00:00.000Z",
    ),
  );
  tracker.attach(
    "test@example.com:interview",
    app.id,
    email({ eventType: "interview_invited" }),
  );
  await tracker.ingestMessage(message("confirm"));
  assert.equal(tracker.app(app.id).stage, "Interviewing");
  assert.equal(tracker.detail(app.id).events.length, 2);
});
test("rejected application retains interview history and rejects automatic reopening", async (t) => {
  const { tracker } = fixture(t);
  const app = tracker.create({ company: "Juniper Labs", stage: "Unknown" });
  await tracker.ingestMessage(
    message("i", "We invite you to interview", "2026-01-01T15:00:00.000Z"),
  );
  tracker.attach(
    "test@example.com:i",
    app.id,
    email({ eventType: "interview_invited" }),
  );
  await tracker.ingestMessage(
    message("r", "We regret to inform you", "2026-02-01T15:00:00.000Z"),
  );
  assert.equal(tracker.app(app.id).stage, "Rejected");
  await tracker.ingestMessage(
    message("later", "We invite you to interview", "2026-03-01T15:00:00.000Z"),
  );
  assert.equal(
    tracker.store.get("sources", "test@example.com:later")?.state,
    "review",
  );
  assert.equal(tracker.app(app.id).stage, "Rejected");
  assert.ok(
    tracker.detail(app.id).events.some((e) => e.stage === "Interviewing"),
  );
});
test("manual corrections cannot be undone by reprocessing historical evidence", async (t) => {
  const { tracker } = fixture(t);
  const app = tracker.create({ company: "Test" });
  tracker.update(app.id, { stage: "Interviewing" });
  assert.equal(
    canAdvance(tracker.app(app.id), "Rejected", "2026-01-01T00:00:00.000Z"),
    false,
  );
});
test("OA invitations create pending actions, never completed assessments", async (t) => {
  const { tracker } = fixture(t);
  const app = tracker.create({ company: "Juniper Labs", stage: "Unknown" });
  await tracker.ingestMessage(
    message("oa", "Please complete the online assessment"),
  );
  tracker.attach(
    "test@example.com:oa",
    app.id,
    email({ eventType: "assessment_invited", dueAt: "2026-02-01" }),
  );
  const actions = tracker.detail(app.id).actions;
  assert.equal(actions[0].status, "pending");
  assert.equal(actions[0].timeZone, "");
  assert.equal(tracker.app(app.id).stage, "Assessment");
});
test("backfilled invitations do not resurrect a completed action in the same thread", async (t) => {
  const { tracker } = fixture(t);
  const app = tracker.create({ company: "Juniper Labs", stage: "Unknown" });
  await tracker.ingestMessage(
    message("done", "Assessment completed", "2026-02-01T15:00:00.000Z"),
  );
  tracker.attach(
    "test@example.com:done",
    app.id,
    email({ eventType: "assessment_completed" }),
  );
  await tracker.ingestMessage(
    message("old", "Please complete the online assessment"),
  );
  assert.equal(
    tracker.detail(app.id).actions.filter((a) => a.status === "pending").length,
    0,
  );
});
test("rescheduling targets a specific interview when multiple are pending", async (t) => {
  const { tracker } = fixture(t);
  const app = tracker.create({ company: "Test", stage: "Unknown" });
  for (const [id, date] of [
    ["i1", "2026-01-01"],
    ["i2", "2026-01-02"],
  ]) {
    await tracker.ingestMessage({
      ...message(id, "We invite you to interview", `${date}T12:00:00.000Z`),
      threadId: id,
    });
    tracker.attach(
      `test@example.com:${id}`,
      app.id,
      email({ eventType: "interview_invited" }),
    );
  }
  await tracker.ingestMessage({
    ...message(
      "resched",
      "Your interview has been rescheduled",
      "2026-01-03T12:00:00.000Z",
    ),
    threadId: "new-thread",
  });
  assert.throws(
    () =>
      tracker.attach(
        "test@example.com:resched",
        app.id,
        email({ eventType: "interview_rescheduled" }),
      ),
    /Select/,
  );
  const first = tracker.detail(app.id).actions[0];
  tracker.attach(
    "test@example.com:resched",
    app.id,
    email({ eventType: "interview_rescheduled", dueAt: "2026-02-01" }),
    first.id,
  );
  assert.equal(tracker.detail(app.id).actions.length, 2);
  assert.equal(tracker.store.get("actions", first.id)?.dueAt, "2026-02-01");
});
test("deleting a record clears evidence and ignores its old Gmail source", async (t) => {
  const { tracker, store } = fixture(t);
  const app = tracker.create({ company: "Juniper Labs", stage: "Unknown" });
  await tracker.ingestMessage(message("delete"));
  tracker.attach("test@example.com:delete", app.id, email());
  tracker.remove(app.id);
  await tracker.ingestMessage(message("delete"));
  assert.equal(tracker.apps().length, 0);
  assert.equal(store.all("events").length, 0);
  assert.equal(store.all("sources")[0].excerpt, "");
  assert.equal(store.all("sources")[0].state, "dismissed");
});
test("merge preserves both histories and backup supports recovery", (t) => {
  const { tracker, store } = fixture(t);
  const a = tracker.create({ company: "One", title: "Role", notes: "A" });
  const b = tracker.create({ company: "One", notes: "B" });
  tracker.merge(a.id, b.id);
  assert.equal(tracker.apps().length, 1);
  assert.equal(tracker.detail(b.id).events.length, 2);
  assert.equal(tracker.app(b.id).title, "Role");
  const backup = store.setting<any>("mergeUndo", null);
  tracker.restore(backup);
  assert.equal(tracker.apps().length, 2);
});
test("vault files are private, encrypted, and absent from portable backup", (t) => {
  const { vault, directory, store } = fixture(t);
  vault.set("aiKey", "test-secret-value");
  assert.equal(new Vault(directory).get("aiKey"), "test-secret-value");
  assert.equal(
    readFileSync(join(directory, "secrets.enc")).includes(
      Buffer.from("test-secret-value"),
    ),
    false,
  );
  assert.equal(statSync(join(directory, "secrets.key")).mode & 0o777, 0o600);
  assert.equal(
    JSON.stringify(store.backup()).includes("test-secret-value"),
    false,
  );
});
test("CSV neutralizes spreadsheet formulas and escapes quotes", (t) => {
  const { tracker } = fixture(t);
  tracker.create({ company: '=HYPERLINK("bad")', title: "A, B" });
  const csv = csvExport(tracker.apps());
  assert.match(csv, /'=HYPERLINK\(""bad""\)/);
  assert.match(csv, /"A, B"/);
});
test("Gmail sync paginates, deduplicates, and checkpoints only a successful scan", async (t) => {
  const { tracker, vault, store } = fixture(t);
  vault.set("gmailTokens", "{}");
  store.set("gmailAccount", "test@example.com");
  const gmail = new Gmail(tracker, "http://127.0.0.1:3210");
  let lists = 0;
  (gmail as any).get = async (path: string) => {
    if (path.startsWith("messages?")) {
      lists++;
      return path.includes("pageToken")
        ? { messages: [{ id: "2", threadId: "2" }] }
        : { messages: [{ id: "1", threadId: "1" }], nextPageToken: "next" };
    }
    return {
      internalDate: Date.parse("2026-03-01"),
      payload: {
        mimeType: "text/plain",
        body: {
          data: Buffer.from("Thank you for applying").toString("base64url"),
        },
        headers: [],
      },
    };
  };
  await gmail.sync();
  assert.equal(lists, 2);
  assert.equal(store.all("sources").length, 2);
  assert.ok(tracker.sync.lastSuccess);
  await gmail.sync();
  assert.equal(store.all("sources").length, 2);
});
test("failed Gmail message fetch preserves checkpoint for retry", async (t) => {
  const { tracker, vault, store } = fixture(t);
  vault.set("gmailTokens", "{}");
  store.set("gmailAccount", "test@example.com");
  const gmail = new Gmail(tracker, "http://127.0.0.1:3210");
  (gmail as any).get = async (path: string) => {
    if (path.startsWith("messages?"))
      return { messages: [{ id: "1", threadId: "1" }] };
    throw new Error("Temporary failure");
  };
  await gmail.sync();
  assert.equal(tracker.sync.lastSuccess, "");
  assert.match(tracker.sync.error, /checkpoint/);
});
test("a narrowed search prunes review only after the scan completes", async (t) => {
  const { tracker, vault, store } = fixture(t);
  vault.set("gmailTokens", "{}");
  store.set("gmailAccount", "test@example.com");
  const gmail = new Gmail(tracker, "http://127.0.0.1:3210");
  let matches = [
    { id: "1", threadId: "1" },
    { id: "2", threadId: "2" },
  ];
  let failPage = false;
  (gmail as any).get = async (path: string) => {
    if (path.startsWith("messages?")) {
      if (failPage) throw new Error("Temporary failure");
      return { messages: matches };
    }
    return {
      internalDate: Date.parse("2026-03-01"),
      payload: {
        mimeType: "text/plain",
        body: {
          data: Buffer.from("Thank you for applying").toString("base64url"),
        },
        headers: [],
      },
    };
  };
  await gmail.sync();
  assert.equal(store.all("sources").length, 2);
  failPage = true;
  await gmail.sync(true, true);
  assert.deepEqual(
    store.all("sources").map((s) => s.state),
    ["review", "review"],
  );
  failPage = false;
  matches = [{ id: "1", threadId: "1" }];
  await gmail.sync(true, true);
  assert.equal(store.get("sources", "test@example.com:1")?.state, "review");
  assert.equal(store.get("sources", "test@example.com:2")?.state, "dismissed");
});
test("Claude Code JSON is recovered from fences and preamble, and junk is rejected", () => {
  const object = { relevant: true, company: "Juniper Labs" };
  assert.deepEqual(parseJsonObject(JSON.stringify(object)), object);
  assert.deepEqual(
    parseJsonObject("```json\n" + JSON.stringify(object) + "\n```"),
    object,
  );
  assert.deepEqual(
    parseJsonObject("Here is the extraction:\n\n" + JSON.stringify(object)),
    object,
  );
  assert.throws(
    () => parseJsonObject("I cannot help with that."),
    /JSON object/,
  );
  assert.throws(() => parseJsonObject("{ not json }"), /malformed/);
  // Claude Code 2.x emits an array of events under --output-format json.
  assert.deepEqual(
    resultText(
      JSON.stringify([
        { type: "system", subtype: "init" },
        { type: "result", is_error: false, result: '{"ok":true}' },
      ]),
    ),
    '{"ok":true}',
  );
  assert.throws(
    () =>
      resultText(
        JSON.stringify({
          is_error: true,
          result: "Claude AI usage limit reached",
        }),
      ),
    /usage limit/i,
  );
  assert.throws(() => resultText("not json at all"), /unreadable/);
});
test("a config written before the provider setting keeps OpenAI and gains new keys", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fieldwork-migrate-"));
  const store = new Store(directory);
  const vault = new Vault(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const legacy = {
    linksFile: "",
    importAfter: "2026-01-01",
    gmailQuery: "application",
    syncMinutes: 5,
    aiEnabled: true,
    aiModel: "gpt-4.1-mini",
    aiBaseUrl: "https://api.openai.com/v1",
    autoApplyAI: false,
  };
  store.set("config", legacy);
  const tracker = new Tracker(store, vault, {
    ...defaults,
    aiProvider: "claude-code",
    aiModel: "claude-haiku-4-5",
  });
  const settings = tracker.settings();
  // A model from one provider must never be paired with the other's default.
  assert.equal(settings.aiProvider, "openai");
  assert.equal(settings.aiModel, "gpt-4.1-mini");
  assert.equal(settings.claudeCodePath, "");
  assert.equal(settings.aiEnabled, true);
  assert.equal(settings.gmailQuery, "application");
});
test("AI backfill re-extracts the review queue and stops when the quota is gone", async (t) => {
  const { tracker, store } = fixture(t);
  await tracker.ingestMessage(message("one"));
  await tracker.ingestMessage({ ...message("two"), threadId: "thread-two" });
  await tracker.ingestMessage({
    ...message("three"),
    threadId: "thread-three",
  });
  assert.equal(
    store.all("sources").filter((s) => s.state === "review").length,
    3,
  );
  let calls = 0;
  tracker.extractor.email = async () => {
    calls++;
    return {
      extraction: email({ company: "Rewritten" }),
      method: "ai" as const,
    };
  };
  await tracker.backfillAI();
  assert.equal(calls, 3);
  assert.equal(tracker.backfill.processed, 3);
  assert.equal(tracker.backfill.total, 3);
  assert.equal(tracker.backfill.failed, 0);
  assert.equal(tracker.backfill.running, false);
  assert.equal(
    store.get("sources", "test@example.com:one")?.extraction.company,
    "Rewritten",
  );
  tracker.extractor.email = async () => {
    throw new Error(
      "Claude Code usage limit reached. Wait for your quota window to reset.",
    );
  };
  await tracker.backfillAI();
  assert.match(tracker.backfill.error, /usage limit/i);
  assert.equal(tracker.backfill.processed, 1);
  assert.equal(tracker.backfill.running, false);
});
test("OAuth state is single-use and expired/unknown callbacks are rejected", async (t) => {
  const { tracker, vault } = fixture(t);
  vault.set("googleClientId", "example.apps.googleusercontent.com");
  const gmail = new Gmail(tracker, "http://127.0.0.1:3210");
  const url = new URL(await gmail.authorize());
  assert.equal(
    url.searchParams.get("scope"),
    "https://www.googleapis.com/auth/gmail.readonly",
  );
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  await assert.rejects(gmail.callback("code", "unknown"), /expired/);
});

test("AI extraction validates JSON and caches unchanged input without retaining keys in the cache", async (t) => {
  const { store, vault } = fixture(t);
  vault.set("aiKey", "fixture-key");
  let calls = 0;
  let sent: any;
  const extractor = new Extractor(
    store,
    vault,
    () => ({ ...defaults, aiEnabled: true }),
    async (url, options) => {
      calls++;
      sent = JSON.parse(options!.body!);
      return {
        status: 200,
        url,
        headers: {},
        text: JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  jobSchema.parse({ company: "Example", title: "Engineer" }),
                ),
              },
            },
          ],
          usage: { total_tokens: 123 },
        }),
      };
    },
  );
  const first = await extractor.job("A job description.");
  const second = await extractor.job("A job description.");
  assert.equal(first.company, "Example");
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.equal(sent.response_format.type, "json_object");
  assert.equal(JSON.stringify(sent).includes("fixture-key"), false);
  assert.equal(store.setting<any>("aiUsage", null).tokens, 123);
});
test("AI invalid output and provider failures remain recoverable without leaking provider response bodies", async (t) => {
  const { store, vault } = fixture(t);
  vault.set("aiKey", "fixture-key");
  const bad = new Extractor(
    store,
    vault,
    () => ({ ...defaults, aiEnabled: true }),
    async (url) => ({
      status: 200,
      url,
      headers: {},
      text: JSON.stringify({
        choices: [{ message: { content: '{"relevant":"not a boolean"}' } }],
      }),
    }),
  );
  await assert.rejects(
    bad.email("Your application", "Thank you for applying", "2026-01-01"),
    /invalid extraction/,
  );
  const quota = new Extractor(
    store,
    vault,
    () => ({ ...defaults, aiEnabled: true }),
    async (url) => ({
      status: 429,
      url,
      headers: {},
      text: "provider secret response",
    }),
  );
  await assert.rejects(
    quota.job("job"),
    (e) =>
      e instanceof Error &&
      /HTTP 429/.test(e.message) &&
      !e.message.includes("secret response"),
  );
});
test("explicitly clearing an application date is preserved when confirmation arrives", async (t) => {
  const { tracker } = fixture(t);
  const app = tracker.create({
    company: "Juniper Labs",
    appliedAt: "2026-01-01",
  });
  tracker.update(app.id, { appliedAt: "" });
  await tracker.ingestMessage(message("clear-date"));
  tracker.attach("test@example.com:clear-date", app.id, email());
  assert.equal(tracker.app(app.id).appliedAt, "");
});
test("an earlier confirmation improves a file-default date without overwriting a user date", async (t) => {
  const { tracker } = fixture(t);
  const app = tracker.create(
    { company: "Juniper Labs", appliedAt: "2026-02-01" },
    "file default",
  );
  await tracker.ingestMessage(message("better-date"));
  tracker.attach("test@example.com:better-date", app.id, email());
  assert.equal(tracker.app(app.id).appliedAt, "2026-01-05");
  assert.equal(tracker.app(app.id).dateBasis, "confirmation estimate");
});
test("multi-role phrases always disable rule-based automatic matching", () => {
  assert.equal(
    classifyRules(
      "Application outcome",
      "We regret to inform you about both roles you applied for.",
    ).multipleRoles,
    true,
  );
});
test("disconnect cancellation prevents an in-flight extraction from writing a new source", async (t) => {
  const { tracker, store } = fixture(t);
  await tracker.ingestMessage(message("canceled"), false, () => true);
  assert.equal(store.all("sources").length, 0);
});
test("pasted text is preserved exactly once when AI enrichment fails", async (t) => {
  const { tracker, store } = fixture(t, { aiEnabled: true });
  tracker.create({ company: "Test", description: "A pasted description" });
  await tracker.idle();
  assert.equal(store.all("snapshots").length, 1);
  assert.equal(store.all("snapshots")[0].sourceKind, "pasted");
});

test("stopping Claude Code ends a running extraction immediately", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fieldwork-claude-"));
  const path = process.env.PATH;
  t.after(() => {
    process.env.PATH = path;
    resetClaudeCode();
    rmSync(directory, { recursive: true, force: true });
  });
  const binary = join(directory, "claude");
  writeFileSync(binary, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const started = Date.now();
  const running = claudeCodeExtract("system", "content", "model", binary);
  await new Promise((resolve) => setTimeout(resolve, 200));
  stopClaudeCode();
  await assert.rejects(running);
  assert.ok(Date.now() - started < 5000);
});

test("idle waits for a running AI backfill so shutdown never closes the store under it", async (t) => {
  const { tracker } = fixture(t);
  tracker.backfill.running = true;
  let settled = false;
  const idle = tracker.idle().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(settled, false);
  tracker.backfill.running = false;
  await idle;
});
test("merging keeps the more advanced stage and the latest status time", async (t) => {
  const { tracker, store } = fixture(t);
  const applied = tracker.create({
    company: "Merge fixture",
    title: "Engineer",
    stage: "Applied",
  });
  const interviewing = tracker.create({
    company: "Merge fixture",
    title: "Engineer II",
    stage: "Interviewing",
  });
  tracker.merge(interviewing.id, applied.id);
  const merged = tracker.app(applied.id);
  assert.equal(merged.stage, "Interviewing");
  assert.equal(merged.manualStatusAt, interviewing.manualStatusAt);
  assert.equal(merged.statusAt, interviewing.statusAt);
  const rejected = tracker.create({
    company: "Old attempt",
    title: "Engineer",
    stage: "Rejected",
  });
  store.put("applications", {
    ...tracker.app(rejected.id),
    statusAt: "2020-01-01T00:00:00.000Z",
    manualStatusAt: "2020-01-01T00:00:00.000Z",
  });
  tracker.merge(rejected.id, applied.id);
  assert.equal(tracker.app(applied.id).stage, "Interviewing");
});
test("resumed enrichment reuses a pasted description instead of asking for a URL", async (t) => {
  const { tracker, store } = fixture(t);
  const app = tracker.create({ company: "Resume fixture", title: "Engineer" });
  store.put("snapshots", {
    id: "fixture:pasted",
    applicationId: app.id,
    text: "Pasted description for the resume fixture role.",
    url: "",
    capturedAt: new Date().toISOString(),
    fields: {},
    sourceKind: "pasted",
  });
  store.put("applications", { ...tracker.app(app.id), enrichment: "pending" });
  tracker.resumeEnrichment();
  await tracker.idle();
  // Without the pasted text this fails with "Add a job URL…".
  const resumed = tracker.app(app.id);
  assert.equal(resumed.enrichmentError, "");
  assert.notEqual(resumed.enrichment, "failed");
  assert.equal(
    store.all("snapshots").filter((s) => s.applicationId === app.id).length,
    1,
  );
});
