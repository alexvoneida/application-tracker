import { randomUUID, createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  applicationInput,
  jobSchema,
  stageForEvent,
  stageRank,
  terminal,
  eventLabel,
  localDate,
  type Application,
  type EmailExtraction,
  type Event,
  type Settings,
  type Source,
  type SyncState,
  type BackfillState,
  type Stage,
} from "../shared/model.ts";
import { Store, Vault } from "./store.ts";
import { canonicalUrl, publicRequest } from "./network.ts";
import {
  Extractor,
  parseJobPage,
  classifyRules,
  stripQuoted,
} from "./extraction.ts";

const now = () => new Date().toISOString();
const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export function matchApplication(
  extraction: EmailExtraction,
  apps: Application[],
  threadApps: string[] = [],
) {
  const matches: { id: string; score: number }[] = [];
  for (const app of apps) {
    let score = 0;
    const sameCompany =
      !!extraction.company &&
      normalized(extraction.company) === normalized(app.company);
    try {
      if (
        extraction.url &&
        app.canonicalUrl &&
        canonicalUrl(extraction.url) === app.canonicalUrl
      )
        score = 1;
    } catch {
      /* malformed extracted URL */
    }
    if (
      sameCompany &&
      extraction.postingId &&
      extraction.postingId === app.postingId
    )
      score = 1;
    if (threadApps.includes(app.id)) score = Math.max(score, 0.99);
    if (
      sameCompany &&
      extraction.title &&
      normalized(extraction.title) === normalized(app.title)
    )
      score = Math.max(score, 0.85);
    if (sameCompany) score = Math.max(score, 0.5);
    if (score) matches.push({ id: app.id, score });
  }
  matches.sort((a, b) => b.score - a.score);
  return {
    candidates: matches.map((m) => m.id),
    confidence: matches[0]?.score || 0,
    unambiguous:
      matches.length > 0 &&
      (matches.length === 1 || matches[0].score > matches[1].score),
  };
}
export function canAdvance(app: Application, next: Stage, occurredAt: string) {
  if (app.manualStatusAt && occurredAt <= app.manualStatusAt) return false;
  if (terminal.has(app.stage)) return false;
  if (occurredAt < app.statusAt) return false;
  return terminal.has(next) || stageRank[next] >= stageRank[app.stage];
}
export function parseFileEntries(text: string) {
  const entries: { url: string; date: string; line: number }[] = [];
  const errors: string[] = [];
  text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) return;
      const parts = line.split("|").map((s) => s.trim());
      try {
        if (parts.length > 2)
          throw new Error("Use one URL, optionally prefixed with YYYY-MM-DD |");
        let date = "";
        const url = parts[parts.length - 1];
        if (parts.length === 2) {
          date = applicationInput.shape.appliedAt.parse(parts[0]);
          if (!date) throw new Error("Date is empty.");
        }
        canonicalUrl(url);
        entries.push({ url, date, line: i + 1 });
      } catch {
        errors.push(`Line ${i + 1}: use a valid URL or YYYY-MM-DD | URL.`);
      }
    });
  return { entries, errors };
}

export class Tracker {
  extractor: Extractor;
  sync: SyncState;
  backfill: BackfillState;
  private enrichments = new Set<string>();
  private queue: (() => Promise<void>)[] = [];
  private working = false;
  private scanning = false;
  private stopped = false;
  constructor(
    public store: Store,
    public vault: Vault,
    defaults: Settings,
    private fetchPage = publicRequest,
  ) {
    const stored = store.setting<Partial<Settings> | null>("config", null);
    // Backfill settings added after this config was written. A config with no
    // aiProvider predates the setting and was an OpenAI setup, so it keeps that
    // provider rather than inheriting a default paired with a foreign model.
    store.set(
      "config",
      stored ? { ...defaults, aiProvider: "openai", ...stored } : defaults,
    );
    this.extractor = new Extractor(store, vault, () => this.settings());
    this.sync = {
      running: false,
      processed: 0,
      discovered: 0,
      lastSuccess: store.setting("lastSync", ""),
      error: "",
      fileErrors: [],
      fileLastScan: "",
    };
    this.backfill = {
      running: false,
      processed: 0,
      total: 0,
      failed: 0,
      error: "",
    };
  }
  settings() {
    return this.store.setting<Settings>("config", {} as Settings);
  }
  apps() {
    return this.store.all("applications");
  }
  app(id: string) {
    const app = this.store.get("applications", id);
    if (!app) throw new Error("Application not found.");
    return app;
  }
  detail(id: string) {
    return {
      application: this.app(id),
      events: this.store
        .all("events")
        .filter((e) => e.applicationId === id)
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
      snapshots: this.store
        .all("snapshots")
        .filter((s) => s.applicationId === id)
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)),
      sources: this.store.all("sources").filter((s) => s.applicationId === id),
      actions: this.store.all("actions").filter((a) => a.applicationId === id),
    };
  }
  create(input: unknown, basis: Application["dateBasis"] = "user") {
    const data = applicationInput.parse(input);
    const url = data.url ? canonicalUrl(data.url) : "";
    if (!data.title && !data.company && !url)
      throw new Error("Add a job URL, company, or title.");
    if (url && !data.reapply) {
      const existing = this.apps().find((a) => a.canonicalUrl === url);
      if (existing) return existing;
    }
    const time = now();
    const date =
      data.appliedAt || (basis === "file default" ? localDate() : "");
    const initialActivity =
      date && data.stage === "Applied"
        ? new Date(`${date}T00:00:00`).toISOString()
        : time;
    const manualStatusAt = !["Applied", "Unknown"].includes(data.stage)
      ? time
      : "";
    const app: Application = {
      ...jobSchema.parse(data),
      id: randomUUID(),
      url: data.url,
      canonicalUrl: url,
      stage: data.stage,
      appliedAt: date,
      dateBasis: date ? basis : "unknown",
      notes: data.notes,
      createdAt: time,
      updatedAt: time,
      lastActivity: initialActivity,
      statusAt: manualStatusAt,
      manualStatusAt,
      lockedFields: Object.keys(jobSchema.shape).filter((k) => {
        const v = data[k as keyof typeof data];
        return v && v !== "Unknown";
      }),
      enrichment: url ? "pending" : "manual",
      enrichmentError: "",
    };
    this.store.transaction(() => {
      this.store.put("applications", app);
      if (data.stage !== "Unknown")
        this.store.put("events", {
          id: randomUUID(),
          applicationId: app.id,
          type:
            data.stage === "Applied"
              ? "application_submitted"
              : "manual_status",
          stage: data.stage,
          occurredAt: initialActivity,
          timeBasis:
            date && data.stage === "Applied"
              ? `${basis} date (time unknown)`
              : "user entry",
          createdAt: time,
          sourceId: "",
          label:
            basis === "file default"
              ? "Application captured from text file"
              : `Added as ${data.stage}`,
          confidence: 1,
          matchConfidence: 1,
        });
    });
    if (data.description) this.saveDescription(app.id, data.description);
    else if (url) this.enqueueEnrichment(app.id);
    return this.app(app.id);
  }
  update(id: string, input: unknown) {
    const parsed = applicationInput.partial().parse(input);
    // Zod defaults also apply inside partial objects; only mutate explicitly supplied fields.
    const patch = Object.fromEntries(
      Object.entries(parsed).filter(([key]) =>
        Object.prototype.hasOwnProperty.call(input, key),
      ),
    ) as Partial<typeof parsed>;
    const app = this.app(id);
    const time = now();
    const updated = { ...app };
    const fields = [
      ...Object.keys(jobSchema.shape),
      "notes",
      "url",
      "appliedAt",
    ] as (keyof typeof patch)[];
    for (const field of fields)
      if (patch[field] !== undefined) {
        (updated as any)[field] = patch[field];
        if (!updated.lockedFields.includes(field))
          updated.lockedFields = [...updated.lockedFields, field];
      }
    if (patch.url !== undefined)
      updated.canonicalUrl = patch.url ? canonicalUrl(patch.url) : "";
    if (patch.appliedAt !== undefined)
      updated.dateBasis = patch.appliedAt ? "user" : "unknown";
    if (patch.stage && patch.stage !== app.stage) {
      updated.stage = patch.stage;
      updated.manualStatusAt = time;
      updated.statusAt = time;
      updated.lastActivity = time;
      this.store.put("events", {
        id: randomUUID(),
        applicationId: id,
        type: "manual_status",
        stage: patch.stage,
        occurredAt: time,
        timeBasis: "user",
        createdAt: time,
        sourceId: "",
        label: `Status corrected: ${app.stage} → ${patch.stage}`,
        confidence: 1,
        matchConfidence: 1,
      });
      if (terminal.has(patch.stage)) this.dismissActions(id);
    }
    updated.updatedAt = time;
    this.store.put("applications", updated);
    if (patch.description?.trim()) this.saveDescription(id, patch.description);
    return this.app(id);
  }
  saveDescription(id: string, text: string) {
    const app = this.app(id);
    this.store.put("snapshots", {
      id: randomUUID(),
      applicationId: id,
      text,
      url: app.url,
      capturedAt: now(),
      fields: {},
      sourceKind: "pasted",
    });
    this.store.put("applications", {
      ...app,
      enrichment: "manual",
      enrichmentError: "",
    });
    if (this.settings().aiEnabled) this.enqueueEnrichment(id, text);
  }
  enqueueEnrichment(id: string, text?: string) {
    if (this.enrichments.has(id) || this.stopped) return;
    this.enrichments.add(id);
    this.queue.push(async () => {
      try {
        await this.enrich(id, text);
      } finally {
        this.enrichments.delete(id);
      }
    });
    void this.drain();
  }
  private async drain() {
    if (this.working) return;
    this.working = true;
    while (this.queue.length && !this.stopped) {
      try {
        await this.queue.shift()!();
      } catch {
        /* each task exposes its own failure */
      }
    }
    this.working = false;
  }
  async idle() {
    while (
      this.working ||
      this.scanning ||
      this.sync.running ||
      this.backfill.running
    )
      await new Promise((r) => setTimeout(r, 20));
  }
  stop() {
    this.stopped = true;
    this.queue.length = 0;
  }
  async enrich(id: string, suppliedText?: string) {
    const original = this.store.get("applications", id);
    if (!original) return;
    this.store.put("applications", {
      ...original,
      enrichment: "pending",
      enrichmentError: "",
    });
    try {
      let text = suppliedText || "";
      let fields = jobSchema.parse({});
      if (!suppliedText) {
        if (!original.url)
          throw new Error("Add a job URL or paste a description first.");
        const result = await this.fetchPage(original.url);
        if (result.status >= 400)
          throw new Error(
            `Job page returned HTTP ${result.status}. Paste the description manually or retry later.`,
          );
        if (
          !/text\/(html|plain)|application\/xhtml/i.test(
            String(result.headers["content-type"] || ""),
          )
        )
          throw new Error(
            "Unsupported page format. Paste the job description manually.",
          );
        ({ text, fields } = parseJobPage(result.text));
        if (text.length < 80)
          throw new Error(
            "This page needs a browser or has too little text. Paste its job description.",
          );
      }
      // Preserve source text even if paid extraction subsequently fails.
      const existingSnapshot = suppliedText
        ? this.store
            .all("snapshots")
            .findLast(
              (s) =>
                s.applicationId === id &&
                s.text === suppliedText &&
                s.sourceKind === "pasted",
            )
        : undefined;
      const snapshotId = existingSnapshot?.id || randomUUID();
      if (this.store.get("applications", id) && !existingSnapshot)
        this.store.put("snapshots", {
          id: snapshotId,
          applicationId: id,
          text,
          url: original.url,
          capturedAt: now(),
          fields,
          sourceKind: suppliedText ? "pasted" : "page",
        });
      const beforeAI = this.store.get("applications", id);
      if (beforeAI) {
        for (const key of Object.keys(fields) as (keyof typeof fields)[])
          if (
            !beforeAI.lockedFields.includes(key) &&
            fields[key] &&
            fields[key] !== "Unknown"
          )
            (beforeAI as any)[key] = fields[key];
        this.store.put("applications", beforeAI);
      }
      if (this.settings().aiEnabled) {
        const ai = await this.extractor.job(text);
        for (const key of Object.keys(ai) as (keyof typeof ai)[])
          if (ai[key] && ai[key] !== "Unknown") (fields as any)[key] = ai[key];
      }
      const current = this.store.get("applications", id);
      if (!current) return;
      for (const key of Object.keys(fields) as (keyof typeof fields)[])
        if (
          !current.lockedFields.includes(key) &&
          fields[key] &&
          fields[key] !== "Unknown"
        )
          (current as any)[key] = fields[key];
      const snapshot = this.store.get("snapshots", snapshotId);
      if (snapshot) this.store.put("snapshots", { ...snapshot, fields });
      this.store.put("applications", {
        ...current,
        enrichment: "ready",
        enrichmentError: "",
        updatedAt: now(),
      });
    } catch (error) {
      const current = this.store.get("applications", id);
      if (current)
        this.store.put("applications", {
          ...current,
          enrichment: "failed",
          enrichmentError:
            error instanceof Error ? error.message : "Extraction failed.",
        });
    }
  }
  async scanFile() {
    if (this.stopped || this.scanning || !this.settings().linksFile) return;
    this.scanning = true;
    try {
      const path = this.settings().linksFile;
      if (!isAbsolute(path))
        throw new Error("Choose an absolute path for the watched text file.");
      const info = await stat(path);
      if (!info.isFile() || info.size > 2_000_000)
        throw new Error("Choose a text file smaller than 2 MB.");
      const text = await readFile(path, "utf8");
      // Wait until an editor's write has settled before importing its last line.
      if (Date.now() - info.mtimeMs < 700) return;
      const { entries, errors } = parseFileEntries(text);
      this.sync.fileErrors = errors;
      for (const entry of entries) {
        const id = createHash("sha256")
          .update(canonicalUrl(entry.url))
          .digest("hex");
        if (this.store.get("imports", id)) continue;
        const app = this.create(
          { url: entry.url, appliedAt: entry.date || localDate() },
          entry.date ? "user" : "file default",
        );
        this.store.put("imports", {
          id,
          applicationId: app.id,
          suppressed: false,
          firstSeen: now(),
          line: entry.line,
        });
      }
      this.sync.fileLastScan = now();
    } catch (error) {
      this.sync.fileErrors = [
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "Watched file not found. Create it or choose another path in Settings."
          : "Unable to read the watched file. Check its path, size, and permissions.",
      ];
    } finally {
      this.scanning = false;
    }
  }
  async ingestMessage(
    message: {
      account: string;
      messageId: string;
      threadId: string;
      subject: string;
      from: string;
      body: string;
      receivedAt: string;
    },
    retry = false,
    canceled = () => false,
  ) {
    const id = `${message.account}:${message.messageId}`;
    const existing = this.store.get("sources", id);
    if (existing && !(retry && ["failed", "review"].includes(existing.state)))
      return;
    const excerpt = stripQuoted(message.body);
    let extraction: EmailExtraction;
    let method: Source["method"] = "rules";
    let error = "";
    try {
      ({ extraction, method } = await this.extractor.email(
        message.subject,
        excerpt,
        message.receivedAt,
      ));
    } catch (e) {
      extraction = classifyRules(message.subject, excerpt);
      error = e instanceof Error ? e.message : "Extraction failed.";
    }
    if (canceled()) return;
    const threadApps = this.store
      .all("sources")
      .filter(
        (s) =>
          s.account === message.account &&
          s.threadId === message.threadId &&
          s.state === "attached",
      )
      .map((s) => s.applicationId);
    const match = matchApplication(extraction, this.apps(), threadApps);
    const source: Source = {
      ...message,
      excerpt,
      id,
      extraction,
      method,
      state: error ? "failed" : extraction.relevant ? "review" : "dismissed",
      reason:
        error ||
        (extraction.multipleRoles
          ? "Message mentions multiple roles."
          : match.unambiguous
            ? "Confirm the extracted event and role."
            : "No unique role match. Choose the correct application."),
      applicationId: "",
      candidates: match.candidates,
      matchConfidence: match.confidence,
    };
    // Do not retain unrelated message bodies or complete raw Gmail payloads.
    delete (source as any).body;
    if (!extraction.relevant) {
      source.excerpt = "";
      source.subject = "";
      source.from = "";
    }
    this.store.put("sources", source);
    const canAuto =
      !error &&
      extraction.relevant &&
      extraction.eventType &&
      !extraction.multipleRoles &&
      extraction.confidence >= 0.97 &&
      match.unambiguous &&
      match.confidence >= 0.99 &&
      (method === "rules" || this.settings().autoApplyAI);
    if (canAuto) {
      const app = this.app(match.candidates[0]);
      const next = stageForEvent[extraction.eventType!];
      if (terminal.has(app.stage) && next !== app.stage) {
        source.reason =
          "This would change a closed application. Please review.";
        this.store.put("sources", source);
      } else if (
        ["interview_rescheduled", "interview_canceled"].includes(
          extraction.eventType!,
        ) &&
        this.store
          .all("actions")
          .filter(
            (a) =>
              a.applicationId === app.id &&
              a.kind === "interview" &&
              a.status === "pending",
          ).length > 1
      ) {
        source.reason =
          "Several interviews are pending. Select the affected action.";
        this.store.put("sources", source);
      } else this.attach(source.id, app.id, extraction);
    }
  }
  // Callers must pass the complete set from a finished search; a partial set
  // would dismiss every message the search had not reached yet.
  pruneReview(account: string, matched: Set<string>) {
    let pruned = 0;
    this.store.transaction(() => {
      for (const source of this.store.all("sources")) {
        if (!["review", "failed"].includes(source.state)) continue;
        if (source.account !== account || matched.has(source.id)) continue;
        this.store.put("sources", {
          ...source,
          state: "dismissed",
          reason: "No longer matches your candidate email search.",
          excerpt: "",
        });
        pruned++;
      }
    });
    return pruned;
  }
  async backfillAI() {
    if (this.backfill.running) return;
    const pending = this.store
      .all("sources")
      .filter((s) => ["review", "failed"].includes(s.state))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    this.backfill = {
      running: true,
      processed: 0,
      total: pending.length,
      failed: 0,
      error: "",
    };
    try {
      for (const source of pending) {
        if (this.stopped) break;
        try {
          await this.ingestMessage(
            {
              account: source.account,
              messageId: source.messageId,
              threadId: source.threadId,
              subject: source.subject,
              from: source.from,
              receivedAt: source.receivedAt,
              body: source.excerpt,
            },
            true,
            () => this.stopped,
          );
        } catch (error) {
          this.backfill.failed++;
          this.backfill.error =
            error instanceof Error ? error.message : "Backfill failed.";
          break;
        }
        this.backfill.processed++;
        // ingestMessage records extraction failures on the source rather than
        // throwing, so the quota case has to be read back from it.
        const updated = this.store.get("sources", source.id);
        if (updated?.state !== "failed") continue;
        this.backfill.failed++;
        if (/usage limit/i.test(updated.reason)) {
          this.backfill.error = updated.reason;
          break;
        }
      }
    } finally {
      this.backfill.running = false;
    }
  }
  attach(
    sourceId: string,
    applicationId: string,
    extraction?: EmailExtraction,
    actionId?: string,
  ) {
    const source = this.store.get("sources", sourceId);
    if (!source || !["review", "failed"].includes(source.state))
      throw new Error(
        "This message has already been resolved or was not found.",
      );
    const data = extraction || source.extraction;
    if (!data.eventType)
      throw new Error("Choose the event type before attaching this message.");
    const app = this.app(applicationId);
    const time = now();
    const parsedTime =
      data.occurredAt && /(?:Z|[+-]\d\d:\d\d)$/.test(data.occurredAt)
        ? Date.parse(data.occurredAt)
        : NaN;
    const validTime =
      Number.isFinite(parsedTime) && parsedTime <= Date.now() + 60000;
    const occurredAt = validTime
      ? new Date(parsedTime).toISOString()
      : source.receivedAt;
    const next = stageForEvent[data.eventType];
    const pending = this.store
      .all("actions")
      .filter(
        (a) =>
          a.applicationId === applicationId &&
          a.kind === "interview" &&
          a.status === "pending",
      );
    if (
      ["interview_rescheduled", "interview_canceled"].includes(
        data.eventType,
      ) &&
      pending.length > 1 &&
      !pending.some((a) => a.id === actionId)
    )
      throw new Error("Select the interview action affected by this update.");
    this.store.transaction(() => {
      const event: Event = {
        id: `email:${sourceId}`,
        applicationId,
        type: data.eventType!,
        stage: next,
        occurredAt,
        timeBasis: validTime ? "email explicit" : "message received",
        createdAt: time,
        sourceId,
        label: eventLabel(data.eventType!),
        confidence: data.confidence,
        matchConfidence: source.matchConfidence,
      };
      this.store.put("events", event);
      if (canAdvance(app, next, occurredAt)) {
        app.stage = next;
        app.statusAt = occurredAt;
      }
      const confirmationDate = localDate(new Date(occurredAt));
      if (
        data.eventType === "application_confirmed" &&
        !app.lockedFields.includes("appliedAt") &&
        (!app.appliedAt ||
          (app.dateBasis === "file default" &&
            confirmationDate < app.appliedAt))
      ) {
        app.appliedAt = confirmationDate;
        app.dateBasis = "confirmation estimate";
      }
      const existingEvents = this.store
        .all("events")
        .filter((e) => e.applicationId === applicationId && e.id !== event.id);
      app.lastActivity =
        existingEvents.length && app.lastActivity > occurredAt
          ? app.lastActivity
          : occurredAt;
      app.updatedAt = time;
      this.store.put("applications", app);
      this.store.put("sources", {
        ...source,
        extraction: data,
        state: "attached",
        applicationId,
        reason: "",
      });
      if (terminal.has(app.stage)) this.dismissActions(applicationId);
      else this.applyAction(event, data, actionId);
    });
    return app;
  }
  private applyAction(event: Event, data: EmailExtraction, actionId?: string) {
    const kind = event.type.startsWith("assessment")
      ? "assessment"
      : event.type.startsWith("interview")
        ? "interview"
        : null;
    if (!kind) return;
    const source = this.store.get("sources", event.sourceId);
    const newerInThread = this.store
      .all("events")
      .some(
        (e) =>
          e.applicationId === event.applicationId &&
          e.type.startsWith(kind) &&
          e.occurredAt > event.occurredAt &&
          source?.threadId &&
          this.store.get("sources", e.sourceId)?.threadId === source.threadId,
      );
    if (newerInThread) return; // Backfilled invitations must not recreate already superseded actions.
    const pending = this.store
      .all("actions")
      .filter(
        (a) =>
          a.applicationId === event.applicationId &&
          a.kind === kind &&
          a.status === "pending",
      );
    const selected =
      pending.find((a) => a.id === actionId) ||
      (pending.length === 1 ? pending[0] : undefined);
    if (/completed|canceled/.test(event.type)) {
      if (selected)
        this.store.put("actions", {
          ...selected,
          status: event.type.endsWith("completed") ? "completed" : "dismissed",
        });
      return;
    }
    if (/rescheduled|scheduled/.test(event.type) && selected) {
      this.store.put("actions", {
        ...selected,
        dueAt: data.dueAt,
        timeZone: data.timeZone,
        sourceId: event.sourceId,
        title: event.label,
      });
      return;
    }
    this.store.put("actions", {
      id: randomUUID(),
      applicationId: event.applicationId,
      sourceId: event.sourceId,
      kind,
      title: event.label,
      dueAt: data.dueAt,
      timeZone: data.timeZone,
      status: "pending",
      createdAt: event.occurredAt,
    });
  }
  dismissActions(id: string) {
    for (const action of this.store.all("actions"))
      if (action.applicationId === id && action.status === "pending")
        this.store.put("actions", { ...action, status: "dismissed" });
  }
  remove(id: string) {
    this.app(id);
    this.store.transaction(() => {
      for (const table of ["events", "snapshots", "actions"] as const)
        for (const item of this.store.all(table))
          if (item.applicationId === id) this.store.remove(table, item.id);
      for (const source of this.store.all("sources"))
        if (source.applicationId === id)
          this.store.put("sources", {
            ...source,
            applicationId: "",
            state: "dismissed",
            excerpt: "",
            subject: "",
            from: "",
            extraction: classifyRules("", ""),
            candidates: [],
            reason: "Application deleted.",
          });
      for (const item of this.store.all("imports"))
        if (item.applicationId === id)
          this.store.put("imports", {
            ...item,
            applicationId: "",
            suppressed: true,
          });
      this.store.remove("applications", id);
      // Cached extraction text and merge undo may contain deleted records.
      this.store.db
        .prepare(
          "DELETE FROM settings WHERE id LIKE 'ai:%' OR id = 'mergeUndo'",
        )
        .run();
    });
  }
  merge(from: string, into: string) {
    if (from === into) throw new Error("Choose two different applications.");
    const source = this.app(from);
    const target = this.app(into);
    this.store.transaction(() => {
      this.store.set("mergeUndo", this.store.backup());
      for (const field of Object.keys(
        jobSchema.shape,
      ) as (keyof typeof jobSchema.shape)[])
        if ((!target[field] || target[field] === "Unknown") && source[field])
          (target as any)[field] = source[field];
      target.notes = [target.notes, source.notes].filter(Boolean).join("\n\n");
      if (!target.appliedAt) {
        target.appliedAt = source.appliedAt;
        target.dateBasis = source.dateBasis;
      }
      if (!target.url) {
        target.url = source.url;
        target.canonicalUrl = source.canonicalUrl;
      }
      // A terminal stage on either side may belong to an older, separate
      // attempt, so recency decides; otherwise the more advanced stage wins.
      const sourceLeads =
        terminal.has(source.stage) || terminal.has(target.stage)
          ? source.statusAt > target.statusAt
          : stageRank[source.stage] > stageRank[target.stage];
      if (sourceLeads) {
        target.stage = source.stage;
        target.statusAt = source.statusAt;
        target.manualStatusAt = source.manualStatusAt;
      }
      target.updatedAt = now();
      target.lastActivity = [target.lastActivity, source.lastActivity]
        .sort()
        .at(-1)!;
      this.store.put("applications", target);
      for (const table of [
        "events",
        "snapshots",
        "actions",
        "sources",
        "imports",
      ] as const)
        for (const item of this.store.all(table))
          if (item.applicationId === from)
            this.store.put(table, { ...item, applicationId: into } as never);
      this.store.remove("applications", from);
      if (terminal.has(target.stage)) this.dismissActions(into);
    });
    return target;
  }
  restore(backup: {
    version: number;
    tables: Record<string, { id: string }[]>;
  }) {
    this.store.transaction(() => {
      for (const table of [
        "applications",
        "events",
        "snapshots",
        "actions",
        "sources",
        "imports",
      ] as const) {
        this.store.db.exec(`DELETE FROM ${table}`);
        for (const item of backup.tables[table])
          this.store.put(table, item as never);
      }
      this.store.set("lastSync", "");
      this.store.set("mergeUndo", null);
      this.store.db.prepare("DELETE FROM settings WHERE id LIKE 'ai:%'").run();
    });
    this.sync.lastSuccess = "";
  }
}
