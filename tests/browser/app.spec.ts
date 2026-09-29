import { test, expect } from "@playwright/test";
import { Store } from "../../server/store";
import { emailSchema } from "../../shared/model";
import { jobSchema } from "../../shared/model";
import { jobIdentity } from "../../server/discovery-providers";

test("capture, edit, filter, inspect snapshots, and export a role", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your search, in perspective." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add application", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Company", exact: true })
    .fill("Juniper Labs");
  await page
    .getByRole("textbox", { name: "Job title", exact: true })
    .fill("Software Engineer");
  await page
    .getByLabel("Job description (optional)")
    .fill(
      "Build reliable software and collaborate with designers and engineers. Full-time remote position in the United States. USD 140,000 to 180,000 base salary per year.",
    );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add application", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Juniper Labs", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByLabel("Stage", { exact: true })
    .selectOption("Interviewing");
  await page
    .getByRole("dialog")
    .getByLabel("Compensation as posted")
    .fill("USD 140,000–180,000 / year");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save changes" })
    .click();
  await expect(
    page.getByText("Changes saved. Your edits take priority"),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Status corrected: Applied → Interviewing",
    }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Saved description" }).click();
  await expect(page.locator(".description-text")).toContainText(
    "Build reliable software",
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByLabel("Search applications").fill("Juniper");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Filter stage").selectOption("Rejected");
  await expect(
    page.getByRole("heading", { name: "No matching applications" }),
  ).toBeVisible();
  await page.getByLabel("Filter stage").selectOption("Interviewing");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export CSV" }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("applications.csv");
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/desktop.png", fullPage: true });
});

test("settings save, secrets remain hidden, and a role can be deleted", async ({
  page,
}) => {
  const state = await (await page.request.get("/api/state")).json();
  await page.request.post("/api/applications", {
    headers: { "X-Tracker-Token": state.csrf },
    data: { company: "Delete me", title: "Test application" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Sync interval (minutes)").fill("10");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByText("Settings saved.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Sync interval (minutes)")).toHaveValue("10");
  await page.getByRole("button", { name: "My applications" }).click();
  await page
    .getByRole("button", { name: "Open Delete me", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete application", exact: true })
    .click();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open Delete me", exact: true }),
  ).toHaveCount(0);
});

test("mobile layout remains usable with keyboard-accessible dialogs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll("*")]
      .filter(
        (e) =>
          e.getBoundingClientRect().right > 391 &&
          getComputedStyle(e).position !== "absolute",
      )
      .map((e) => ({
        tag: e.tagName,
        class: e.className,
        width: e.getBoundingClientRect().width,
        right: e.getBoundingClientRect().right,
        overflow: getComputedStyle(e).overflow,
      })),
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    JSON.stringify(overflow),
  ).toBeLessThanOrEqual(390);
  await page
    .getByRole("button", { name: "Add application", exact: true })
    .click();
  await expect(page.getByLabel("Job link", { exact: true })).toBeFocused();
  await page
    .getByRole("textbox", { name: "Company", exact: true })
    .fill("Local test");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A few things to connect." }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
});

test("review edits survive refresh, attaching an OA creates an action, and completion records history", async ({
  page,
}) => {
  const initial = await (await page.request.get("/api/state")).json();
  const application = await (
    await page.request.post("/api/applications", {
      headers: { "X-Tracker-Token": initial.csrf },
      data: {
        company: "Cedar Systems",
        title: "Backend Engineer",
        stage: "Unknown",
      },
    })
  ).json();
  const store = new Store(process.env.TRACKER_E2E_DIR!);
  store.put("sources", {
    id: "fixture:oa",
    account: "fixture@example.com",
    messageId: "oa",
    threadId: "fixture-thread",
    subject: "Your coding assessment",
    from: "Careers <careers@example.com>",
    excerpt:
      "Please complete the coding assessment by October 1. This message is fixture data.",
    receivedAt: new Date(Date.now() - 60000).toISOString(),
    extraction: emailSchema.parse({
      relevant: true,
      company: "Cedar Systems",
      title: "Backend Engineer",
      postingId: "",
      url: "",
      eventType: "assessment_invited",
      confidence: 0.95,
      occurredAt: "",
      dueAt: "2026-10-01",
      timeZone: "",
      explanation: "An assessment invitation.",
      multipleRoles: false,
    }),
    method: "ai",
    state: "review",
    reason: "Confirm this role match.",
    applicationId: "",
    candidates: [application.id],
    matchConfidence: 0.85,
  });
  store.close();
  await page.goto("/");
  await page.getByRole("button", { name: "Review inbox", exact: true }).click();
  await page
    .getByLabel("Company (for a new record)", { exact: true })
    .fill("Edited extraction");
  await page.waitForResponse(
    (r) => r.url().endsWith("/api/state") && r.status() === 200,
  );
  await expect(
    page.getByLabel("Company (for a new record)", { exact: true }),
  ).toHaveValue("Edited extraction");
  await page.getByLabel("Time zone", { exact: true }).fill("America/Denver");
  await page.getByRole("button", { name: "Attach event", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Attached to Cedar Systems — Backend Engineer" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "You’re all caught up." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next actions", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Assessment invited" }),
  ).toBeVisible();
  await expect(page.getByText("2026-10-01 · America/Denver")).toBeVisible();
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A little breathing room." }),
  ).toBeVisible();
  const detail = await (
    await page.request.get(`/api/applications/${application.id}`)
  ).json();
  expect(detail.application.stage).toBe("Assessment");
  expect(detail.application.appliedAt).toBe("");
  expect(
    detail.events.some((e: any) => e.type === "assessment_completed"),
  ).toBe(true);
});

test("review lists oldest email first and confirms a dismissal before removing it", async ({
  page,
}) => {
  const store = new Store(process.env.TRACKER_E2E_DIR!);
  for (const [id, receivedAt] of [
    ["newer", "2020-01-02T12:00:00.000Z"],
    ["older", "2020-01-01T12:00:00.000Z"],
  ])
    store.put("sources", {
      id: `fixture:order:${id}`,
      account: "fixture@example.com",
      messageId: `order-${id}`,
      threadId: `order-${id}`,
      subject: `Order fixture ${id}`,
      from: "Careers <careers@example.com>",
      excerpt: "Thank you for applying.",
      receivedAt,
      extraction: emailSchema.parse({
        relevant: true,
        company: "Order Labs",
        title: "Software Engineer",
        postingId: "",
        url: "",
        eventType: "application_confirmed",
        confidence: 0.6,
        occurredAt: "",
        dueAt: "",
        timeZone: "",
        explanation: "Confirmation",
        multipleRoles: false,
      }),
      method: "rules",
      state: "review",
      reason: "Choose a role.",
      applicationId: "",
      candidates: [],
      matchConfidence: 0,
    });
  store.close();
  await page.goto("/");
  await page.getByRole("button", { name: "Review inbox", exact: true }).click();
  const headings = page.locator(".review-item h3");
  await expect(headings.filter({ hasText: "Order fixture" })).toHaveText([
    "Order fixture older",
    "Order fixture newer",
  ]);
  const older = page.locator(".review-item").filter({
    has: page.getByRole("heading", {
      name: "Order fixture older",
      exact: true,
    }),
  });
  await older
    .getByRole("button", { name: "Dismiss unrelated email", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: /^Dismissed$/ }),
  ).toHaveCount(1);
  await expect(older).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Order fixture newer", exact: true }),
  ).toBeVisible();
});

for (const refreshFails of [false, true]) {
  test(`review creation selects the application and waits for attachment (refresh failure: ${refreshFails})`, async ({
    page,
  }) => {
    const sourceId = `fixture:create:${refreshFails}`;
    const company = `Create review fixture ${refreshFails}`;
    const store = new Store(process.env.TRACKER_E2E_DIR!);
    store.put("sources", {
      id: sourceId,
      account: "fixture@example.com",
      messageId: sourceId,
      threadId: sourceId,
      subject: `Application received ${refreshFails}`,
      from: "Careers <careers@example.com>",
      excerpt: "Thank you for applying.",
      receivedAt: "2026-09-20T12:00:00.000Z",
      extraction: emailSchema.parse({
        relevant: true,
        company,
        title: "Software Engineer",
        postingId: "",
        url: "",
        eventType: "application_confirmed",
        confidence: 0.95,
        occurredAt: "",
        dueAt: "",
        timeZone: "",
        explanation: "Confirmation",
        multipleRoles: false,
      }),
      method: "rules",
      state: "review",
      reason: "Choose a role.",
      applicationId: "",
      candidates: [],
      matchConfidence: 0,
    });
    store.close();
    await page.goto("/");
    await page
      .getByRole("button", { name: "Review inbox", exact: true })
      .click();
    const review = page.locator(".review-item").filter({
      has: page.getByRole("heading", {
        name: `Application received ${refreshFails}`,
        exact: true,
      }),
    });
    await review
      .getByLabel("Title (for a new record)")
      .fill("Edited Software Engineer");
    let failCreation = true;
    let failRefresh = false;
    await page.route("**/api/applications", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      if (failCreation) {
        failCreation = false;
        return route.fulfill({
          status: 400,
          json: { error: "Fixture create failure. Please retry." },
        });
      }
      const response = await route.fetch();
      failRefresh = refreshFails;
      await route.fulfill({ response });
    });
    await page.route("**/api/state", async (route) => {
      if (failRefresh) {
        failRefresh = false;
        return route.fulfill({
          status: 503,
          json: { error: "Fixture refresh failure." },
        });
      }
      await route.continue();
    });
    await review
      .getByRole("button", { name: "Create new application", exact: true })
      .click();
    await expect(
      review.getByText("Fixture create failure. Please retry."),
    ).toBeVisible();
    await expect(review.getByLabel("Match to application")).toHaveValue("");
    await expect(review.getByLabel("Title (for a new record)")).toHaveValue(
      "Edited Software Engineer",
    );
    await review
      .getByRole("button", { name: "Create new application", exact: true })
      .click();
    await expect(
      review.getByRole("button", { name: "Application created", exact: true }),
    ).toBeDisabled();
    const state = await (await page.request.get("/api/state")).json();
    const created = state.applications.filter(
      (a: any) => a.company === company,
    );
    expect(created).toHaveLength(1);
    const id = created[0].id;
    await expect(review.getByLabel("Match to application")).toHaveValue(id);
    await expect(
      review.getByLabel("Match to application").locator("option:checked"),
    ).toHaveText(`${company} — Edited Software Engineer`);
    await expect(
      review.getByRole("button", { name: "Application created", exact: true }),
    ).toBeDisabled();
    expect(state.review.some((source: any) => source.id === sourceId)).toBe(
      true,
    );
    expect(state.events.some((event: any) => event.sourceId === sourceId)).toBe(
      false,
    );
    expect(created[0].appliedAt).toBe("");
    await page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/state") && response.status() === 200,
    );
    await expect(review.getByLabel("Match to application")).toHaveValue(id);
    await review
      .getByRole("button", { name: "Attach event", exact: true })
      .click();
    await expect(review).toHaveCount(0);
    const detail = await (
      await page.request.get(`/api/applications/${id}`)
    ).json();
    expect(detail.application.appliedAt).toBe("2026-09-20");
    expect(
      detail.events.filter((event: any) => event.sourceId === sourceId),
    ).toHaveLength(1);
  });
}

test("discovery filters, cloud export, and explicit applied confirmation", async ({
  page,
}) => {
  const store = new Store(process.env.TRACKER_E2E_DIR!);
  const url = "https://jobs.ashbyhq.com/fixture/discovery-one";
  const id = jobIdentity(url);
  const record = {
    ...jobSchema.parse({
      company: "Discovery fixture",
      title: "Software Engineer, New Grad",
      location: "Denver",
      employmentType: "Full-time",
    }),
    id,
    url,
    description: "Build useful software. No email credentials needed.",
    publishedAt: "",
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    baseline: false,
    entryEvidence: "Entry-level title",
    requiredYears: 0,
    annualSalaryMax: null,
    sources: {
      "github:simplify": { present: true, lastSeen: new Date().toISOString() },
    },
    closed: false,
    disposition: "new",
    seenAt: "",
    alertedAt: "",
    applicationId: "",
  };
  store.db
    .prepare("INSERT INTO discovery_jobs VALUES (?,?)")
    .run(id, JSON.stringify(record));
  store.close();
  await page.goto("/?view=discover");
  await expect(
    page.getByRole("heading", { name: "Your next opportunity." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: record.title, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(
    page.getByRole("dialog").locator(".description-text"),
  ).toContainText("Build useful software.");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByText("Search preferences & alerts", { exact: true }).click();
  await page.getByLabel("Locations", { exact: true }).fill("Boston");
  await page
    .getByRole("button", { name: "Save discovery preferences" })
    .click();
  await expect(
    page.getByRole("heading", { name: "No roles in this view yet." }),
  ).toBeVisible();
  await page.getByLabel("Locations", { exact: true }).fill("Denver");
  await page
    .getByRole("button", { name: "Save discovery preferences" })
    .click();
  await expect(
    page.getByRole("heading", { name: record.title, exact: true }),
  ).toBeVisible();
  await page
    .getByText("Always-on phone alerts · Telegram", { exact: true })
    .click();
  const exported = await (
    await page.request.get("/api/discovery/worker-config")
  ).json();
  expect(exported.config.locations).toBe("Denver");
  expect(exported.config.enabled).toBe(true);
  expect(Object.keys(exported).sort()).toEqual([
    "boards",
    "config",
    "githubEnabled",
    "version",
  ]);
  await page.getByRole("button", { name: "I applied", exact: true }).click();
  await page.getByLabel("Date applied", { exact: true }).fill("2026-09-23");
  await page
    .getByRole("button", { name: "Confirm application submitted" })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Discovery fixture", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByLabel("Application date", { exact: true }),
  ).toHaveValue("2026-09-23");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("dragging a text selection out of a dialog keeps it open", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Add application", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const company = dialog.getByRole("textbox", { name: "Company", exact: true });
  await company.fill("Drag selection fixture");
  const box = (await company.boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(3, 3, { steps: 5 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await expect(company).toHaveValue("Drag selection fixture");
  await page.mouse.click(3, 3);
  await expect(dialog).toBeHidden();
});

test("refreshing an application from its link keeps unsaved edits", async ({
  page,
}) => {
  const initial = await (await page.request.get("/api/state")).json();
  await page.request.post("/api/applications", {
    headers: { "X-Tracker-Token": initial.csrf },
    data: {
      company: "Unsaved edit fixture",
      title: "Platform Engineer",
      url: "https://example.com/jobs/unsaved-edit",
      stage: "Applied",
    },
  });
  await page.route("**/api/applications/*/enrich", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: /Unsaved edit fixture/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Location", { exact: true }).fill("Boulder, CO");
  await dialog.getByRole("tab", { name: "Saved description" }).click();
  const reloaded = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" &&
      /^\/api\/applications\/[^/]+$/.test(new URL(r.url()).pathname),
  );
  await dialog.getByRole("button", { name: "Refresh from link" }).click();
  await reloaded;
  await dialog.getByRole("tab", { name: "Role details" }).click();
  await expect(dialog.getByLabel("Location", { exact: true })).toHaveValue(
    "Boulder, CO",
  );
});

test("editing an action date starts from its current value", async ({
  page,
}) => {
  const initial = await (await page.request.get("/api/state")).json();
  const application = await (
    await page.request.post("/api/applications", {
      headers: { "X-Tracker-Token": initial.csrf },
      data: {
        company: "Reschedule fixture",
        title: "Engineer",
        stage: "Unknown",
      },
    })
  ).json();
  const store = new Store(process.env.TRACKER_E2E_DIR!);
  const action = {
    id: "fixture:reschedule",
    applicationId: application.id,
    sourceId: "",
    kind: "interview" as const,
    title: "Reschedule fixture interview",
    dueAt: "2026-10-01 14:00",
    timeZone: "America/Denver",
    status: "pending" as const,
    createdAt: new Date().toISOString(),
  };
  store.put("actions", action);
  store.close();
  await page.goto("/");
  await page.getByRole("button", { name: "Next actions", exact: true }).click();
  const card = page.locator(".action-card").filter({
    has: page.getByRole("heading", { name: "Reschedule fixture interview" }),
  });
  await expect(
    card.getByText("2026-10-01 14:00 · America/Denver"),
  ).toBeVisible();
  const patched = await page.request.patch(`/api/actions/${action.id}`, {
    headers: { "X-Tracker-Token": initial.csrf },
    data: { dueAt: "2026-10-08 09:30" },
  });
  expect(patched.ok()).toBe(true);
  // Wait for the app's 5-second state poll to deliver the server-side change.
  await expect(card.getByText("2026-10-08 09:30 · America/Denver")).toBeVisible(
    { timeout: 10000 },
  );
  await card.getByRole("button", { name: "Edit date" }).click();
  await expect(card.getByLabel("Date / time", { exact: true })).toHaveValue(
    "2026-10-08 09:30",
  );
});

test("pausing monitoring does not save unsaved search preferences", async ({
  page,
}) => {
  const saved = await (await page.request.get("/api/discovery")).json();
  const posted: any[] = [];
  await page.route("**/api/discovery/settings", async (route) => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Discover jobs", exact: true })
    .click();
  await page.getByText("Search preferences & alerts").click();
  await page
    .getByLabel("Excluded keywords", { exact: true })
    .fill("unsaved draft keyword");
  await page
    .getByRole("button", {
      name: saved.config.enabled ? "Pause monitoring" : "Start monitoring",
    })
    .click();
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0].excludeKeywords).toBe(saved.config.excludeKeywords);
  expect(posted[0].enabled).toBe(!saved.config.enabled);
  await expect(
    page.getByLabel("Excluded keywords", { exact: true }),
  ).toHaveValue("unsaved draft keyword");
});

test("saving a description snapshot leaves other unsaved edits unsaved", async ({
  page,
}) => {
  const initial = await (await page.request.get("/api/state")).json();
  const application = await (
    await page.request.post("/api/applications", {
      headers: { "X-Tracker-Token": initial.csrf },
      data: {
        company: "Snapshot fixture",
        title: "Engineer",
        stage: "Applied",
      },
    })
  ).json();
  await page.goto("/");
  await page
    .getByRole("button", { name: /Snapshot fixture/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Location", { exact: true }).fill("Austin, TX");
  await dialog.getByRole("tab", { name: "Saved description" }).click();
  await dialog
    .getByLabel("Save a new description", { exact: true })
    .fill("Build internal tools for the platform team.");
  const saved = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().includes(application.id),
  );
  await dialog.getByRole("button", { name: "Save snapshot" }).click();
  expect((await saved).ok()).toBe(true);
  const detail = await (
    await page.request.get(`/api/applications/${application.id}`)
  ).json();
  expect(detail.application.location).toBe("");
  await dialog.getByRole("tab", { name: "Role details" }).click();
  await expect(dialog.getByLabel("Location", { exact: true })).toHaveValue(
    "Austin, TX",
  );
});

test("deleting the only application on the last page shows the previous page", async ({
  page,
}) => {
  const initial = await (await page.request.get("/api/state")).json();
  const created = new Map<string, string>();
  for (let index = 0; index < 31; index++) {
    const company = `Paging fixture ${String(index).padStart(2, "0")}`;
    const application = await (
      await page.request.post("/api/applications", {
        headers: { "X-Tracker-Token": initial.csrf },
        data: { company, title: "Engineer", stage: "Applied" },
      })
    ).json();
    created.set(company, application.id);
  }
  await page.goto("/");
  await page.getByLabel("Search applications").fill("Paging fixture");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(1);
  const last = (await rows.locator("strong").textContent())!;
  const deleted = await page.request.delete(
    `/api/applications/${created.get(last)}`,
    { headers: { "X-Tracker-Token": initial.csrf }, data: {} },
  );
  expect(deleted.ok()).toBe(true);
  // Wait for the app's 5-second state poll to drop the deleted application.
  await expect(rows).toHaveCount(30, { timeout: 10000 });
});
