import express from "express";
import { randomBytes, createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  applicationInput,
  dateSchema,
  emailSchema,
  stages,
  eventTypes,
  type Application,
} from "../shared/model.ts";
import type { Tracker } from "./tracker.ts";
import { Gmail } from "./gmail.ts";
import { Discovery } from "./discovery.ts";
import { claudeCodeStatus } from "./claude-code.ts";

const settingsSchema = z.object({
  linksFile: z
    .string()
    .max(4000)
    .refine((p) => !p || isAbsolute(p), "Use an absolute file path."),
  importAfter: dateSchema.refine(Boolean, "Choose an import start date."),
  gmailQuery: z.string().min(1).max(4000),
  syncMinutes: z.number().int().min(1).max(1440),
  aiEnabled: z.boolean(),
  aiProvider: z.enum(["openai", "claude-code"]),
  aiModel: z.string().min(1).max(100),
  aiBaseUrl: z
    .url()
    .refine(
      (s) => new URL(s).protocol === "https:",
      "Use an HTTPS API endpoint.",
    ),
  claudeCodePath: z
    .string()
    .max(4000)
    .refine((p) => !p || isAbsolute(p), "Use an absolute file path."),
  autoApplyAI: z.boolean(),
});
const record = z.object({ id: z.string().min(1).max(1000) });
const reference = record.extend({ applicationId: z.string() });
const backupSchema = z.object({
  version: z.literal(1),
  tables: z.object({
    applications: z.array(
      applicationInput.omit({ description: true, reapply: true }).extend({
        id: z.string().min(1),
        canonicalUrl: z.string(),
        dateBasis: z.enum([
          "user",
          "file default",
          "confirmation estimate",
          "unknown",
        ]),
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
        lastActivity: z.iso.datetime(),
        statusAt: z.string(),
        manualStatusAt: z.string(),
        lockedFields: z.array(z.string()),
        enrichment: z.enum(["pending", "ready", "failed", "manual"]),
        enrichmentError: z.string(),
      }),
    ),
    events: z.array(
      reference.extend({
        type: z.enum(eventTypes),
        stage: z.enum(stages),
        occurredAt: z.iso.datetime(),
        timeBasis: z.string(),
        createdAt: z.iso.datetime(),
        sourceId: z.string(),
        label: z.string(),
        confidence: z.number(),
        matchConfidence: z.number(),
      }),
    ),
    snapshots: z.array(
      reference.extend({
        text: z.string().max(150000),
        url: z.string(),
        capturedAt: z.iso.datetime(),
        fields: applicationInput.partial(),
        sourceKind: z.enum(["pasted", "page"]).optional(),
      }),
    ),
    actions: z.array(
      reference.extend({
        sourceId: z.string(),
        kind: z.enum(["assessment", "interview"]),
        title: z.string(),
        dueAt: z.string(),
        timeZone: z.string(),
        status: z.enum(["pending", "completed", "dismissed"]),
        createdAt: z.iso.datetime(),
      }),
    ),
    sources: z.array(
      reference.extend({
        account: z.string(),
        messageId: z.string(),
        threadId: z.string(),
        subject: z.string(),
        from: z.string(),
        excerpt: z.string(),
        receivedAt: z.iso.datetime(),
        extraction: emailSchema,
        method: z.enum(["rules", "ai"]),
        state: z.enum(["review", "attached", "dismissed", "failed"]),
        reason: z.string(),
        candidates: z.array(z.string()),
        matchConfidence: z.number(),
      }),
    ),
    imports: z.array(
      reference.extend({
        suppressed: z.boolean(),
        firstSeen: z.iso.datetime(),
        line: z.number().int(),
      }),
    ),
  }),
});
function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function csvExport(apps: Application[]) {
  const columns: (keyof Application)[] = [
    "company",
    "title",
    "stage",
    "appliedAt",
    "dateBasis",
    "location",
    "workArrangement",
    "salary",
    "currency",
    "salaryPeriod",
    "url",
    "postingId",
    "responsibilities",
    "requirements",
    "technologies",
    "notes",
    "lastActivity",
  ];
  return [
    columns.join(","),
    ...apps.map((a) => columns.map((c) => csvCell(a[c])).join(",")),
  ].join("\r\n");
}
const hashBackup = (tracker: Tracker) =>
  createHash("sha256")
    .update(JSON.stringify(tracker.store.backup().tables))
    .digest("hex");

export function createApi(
  tracker: Tracker,
  origin: string,
  production = false,
  onOAuthComplete?: (connected: boolean) => void,
  onDiscover?: import("./discovery").DiscoveryNotify,
) {
  const app = express();
  const gmail = new Gmail(tracker, origin);
  const discovery = new Discovery(tracker, undefined, onDiscover);
  const csrf = randomBytes(32).toString("hex");
  const ownHost = new URL(origin).host;
  const localhost = ownHost.replace("127.0.0.1", "localhost");
  const allowedOrigins = new Set([
    origin,
    origin.replace("127.0.0.1", "localhost"),
  ]);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (![ownHost, localhost].includes(req.headers.host || ""))
      return void res.status(403).json({ error: "Invalid local host." });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'${production ? "" : " 'unsafe-inline'"}; style-src 'self'${production ? "" : " 'unsafe-inline'"}; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
    if (req.path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
      if (
        req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin && !allowedOrigins.has(req.headers.origin))
      )
        return void res
          .status(403)
          .json({ error: "Cross-origin access is blocked." });
      if (
        !["GET", "HEAD"].includes(req.method) &&
        (req.headers["x-tracker-token"] !== csrf || !req.is("application/json"))
      )
        return void res
          .status(403)
          .json({ error: "Reload this page before making changes." });
    }
    next();
  });
  app.use(express.json({ limit: "20mb" }));
  const bursts: number[] = [];
  app.use("/api", (req, res, next) => {
    if (req.method !== "GET") {
      const time = Date.now();
      while (bursts[0] < time - 60000) bursts.shift();
      if (bursts.length >= 120)
        return void res
          .status(429)
          .json({ error: "Too many changes. Please wait a minute." });
      bursts.push(time);
    }
    next();
  });
  app.get("/api/state", (_req, res) =>
    res.json({
      csrf,
      applications: tracker.apps(),
      events: tracker.store.all("events"),
      actions: tracker.store.all("actions"),
      review: tracker.store
        .all("sources")
        .filter((s) => ["review", "failed"].includes(s.state))
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)),
      settings: tracker.settings(),
      sync: tracker.sync,
      backfill: tracker.backfill,
      connection: {
        account: tracker.store.setting("gmailAccount", ""),
        connected: !!tracker.vault.get("gmailTokens"),
        googleConfigured: !!(
          process.env.GOOGLE_CLIENT_ID || tracker.vault.get("googleClientId")
        ),
        aiConfigured: !!(
          process.env.OPENAI_API_KEY || tracker.vault.get("aiKey")
        ),
        aiUsage: tracker.store.setting("aiUsage", null),
      },
      canUndoMerge: !!tracker.store.setting("mergeUndo", null),
    }),
  );
  app.get("/api/applications/:id", (req, res) =>
    res.json(tracker.detail(String(req.params.id))),
  );
  app.get("/api/discovery", (_req, res) => res.json(discovery.state()));
  app.get("/api/discovery/jobs/:id", (req, res) =>
    res.json(discovery.detail(String(req.params.id))),
  );
  app.get("/api/discovery/worker-config", (_req, res) => {
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="fieldwork-worker.json"',
    );
    res.json(discovery.workerConfig());
  });
  app.post("/api/discovery/settings", (req, res) => {
    const config = discovery.configure(req.body);
    void discovery.tick();
    res.json(config);
  });
  app.post("/api/discovery/check", (_req, res) => {
    void discovery.tick();
    res.status(202).json({ ok: true });
  });
  app.post("/api/discovery/sources", (req, res) => {
    const input = z
      .object({
        url: z.string().max(4000),
        name: z.string().max(200).default(""),
      })
      .parse(req.body);
    res.json(discovery.addBoard(input.url, input.name));
  });
  app.patch("/api/discovery/sources/:id", (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    discovery.enableSource(String(req.params.id), enabled);
    res.json({ ok: true });
  });
  app.patch("/api/discovery/jobs/:id", (req, res) => {
    const { action } = z
      .object({ action: z.enum(["save", "dismiss", "restore", "seen"]) })
      .parse(req.body);
    discovery.updateJob(String(req.params.id), action);
    res.json({ ok: true });
  });
  app.post("/api/discovery/jobs/:id/applied", (req, res) => {
    const { appliedAt } = z
      .object({
        appliedAt: dateSchema.refine(
          (value) => !!value,
          "Choose an application date.",
        ),
      })
      .parse(req.body);
    res.json(discovery.markApplied(String(req.params.id), appliedAt));
  });
  app.post("/api/applications", (req, res) =>
    res.status(201).json(tracker.create(req.body)),
  );
  app.patch("/api/applications/:id", (req, res) =>
    res.json(tracker.update(String(req.params.id), req.body)),
  );
  app.delete("/api/applications/:id", (req, res) => {
    tracker.remove(String(req.params.id));
    res.json({ ok: true });
  });
  app.post("/api/applications/:id/enrich", (req, res) => {
    tracker.app(String(req.params.id));
    tracker.enqueueEnrichment(String(req.params.id));
    res.json({ ok: true });
  });
  app.post("/api/import/scan", async (_req, res) => {
    await tracker.scanFile();
    res.json({ ok: true, errors: tracker.sync.fileErrors });
  });
  app.post("/api/settings", (req, res) => {
    const settings = settingsSchema.parse(req.body.settings);
    const secrets = z
      .object({
        googleClientId: z.string().max(1000).optional(),
        googleClientSecret: z.string().max(1000).optional(),
        aiKey: z.string().max(2000).optional(),
        clearAiKey: z.boolean().optional(),
      })
      .parse(req.body.secrets || {});
    for (const name of [
      "googleClientId",
      "googleClientSecret",
      "aiKey",
    ] as const)
      if (secrets[name]?.trim()) tracker.vault.set(name, secrets[name]!.trim());
    if (secrets.clearAiKey) tracker.vault.set("aiKey", "");
    const previous = tracker.settings();
    tracker.store.set("config", settings);
    const searchChanged =
      previous.gmailQuery !== settings.gmailQuery ||
      previous.importAfter !== settings.importAfter;
    const resyncing = searchChanged && !!tracker.vault.get("gmailTokens");
    if (resyncing) void gmail.sync(true, true);
    res.json({ ok: true, resyncing });
  });
  app.post("/api/ai/backfill", (_req, res) => {
    if (!tracker.settings().aiEnabled)
      throw new Error("Enable AI extraction in Settings first.");
    void tracker.backfillAI();
    res.status(202).json({ ok: true });
  });
  app.get("/api/ai/status", async (_req, res) => {
    const settings = tracker.settings();
    if (settings.aiProvider !== "claude-code")
      return void res.json({ provider: settings.aiProvider });
    try {
      const tool = await claudeCodeStatus(settings.claudeCodePath);
      res.json({
        provider: "claude-code",
        available: !!tool?.available,
        version: tool?.version || "",
        models: tool?.models || [],
      });
    } catch (error) {
      res.json({
        provider: "claude-code",
        available: false,
        error: error instanceof Error ? error.message : "Discovery failed.",
      });
    }
  });
  app.post("/api/gmail/connect", async (_req, res) =>
    res.json({ url: await gmail.authorize() }),
  );
  app.get("/oauth/callback", async (req, res) => {
    let connected = false;
    try {
      await gmail.callback(
        String(req.query.code || ""),
        String(req.query.state || ""),
      );
      connected = true;
    } catch {
      /* No provider details or tokens are reflected to the browser. */
    }
    if (onOAuthComplete) {
      res
        .type("html")
        .send(
          `<html><head><title>Fieldwork — Gmail</title></head><body><h1>${connected ? "Gmail connected" : "Gmail connection failed"}</h1><p>Return to Fieldwork. You can close this browser tab.</p></body></html>`,
        );
      onOAuthComplete(connected);
    } else {
      res.redirect(`/?gmail=${connected ? "connected" : "failed"}`);
    }
  });
  app.post("/api/gmail/disconnect", async (_req, res) => {
    await gmail.disconnect();
    res.json({ ok: true });
  });
  app.post("/api/gmail/sync", (req, res) => {
    if (!tracker.vault.get("gmailTokens"))
      throw new Error("Connect Gmail in Settings first.");
    const { full, prune } = z
      .object({
        full: z.boolean().default(false),
        prune: z.boolean().default(false),
      })
      .parse(req.body);
    void gmail.sync(full, prune);
    res.status(202).json({ ok: true });
  });
  app.post("/api/review/:id", async (req, res) => {
    const input = z
      .object({
        action: z.enum(["dismiss", "retry", "attach", "create"]),
        applicationId: z.string().optional(),
        actionId: z.string().optional(),
        extraction: emailSchema.optional(),
      })
      .parse(req.body);
    const id = String(req.params.id);
    const source = tracker.store.get("sources", id);
    if (!source) throw new Error("Message not found.");
    if (input.action === "dismiss") {
      tracker.store.put("sources", {
        ...source,
        state: "dismissed",
        reason: "Dismissed by user.",
        excerpt: "",
      });
      res.json({ ok: true });
      return;
    }
    if (input.action === "retry") {
      await tracker.ingestMessage(
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
      );
      res.json({ ok: true });
      return;
    }
    const extraction = input.extraction || source.extraction;
    if (!extraction.eventType) throw new Error("Choose an event type.");
    let applicationId = input.applicationId;
    if (input.action === "create")
      applicationId = tracker.create({
        company: extraction.company,
        title: extraction.title,
        postingId: extraction.postingId,
        url: extraction.url,
        stage: "Unknown",
      }).id;
    if (!applicationId) throw new Error("Choose an application.");
    res.json(tracker.attach(id, applicationId, extraction, input.actionId));
  });
  app.patch("/api/actions/:id", (req, res) => {
    const data = z
      .object({
        status: z.enum(["pending", "completed", "dismissed"]).optional(),
        dueAt: z.string().max(100).optional(),
        timeZone: z.string().max(100).optional(),
        title: z.string().max(1000).optional(),
      })
      .parse(req.body);
    const action = tracker.store.get("actions", String(req.params.id));
    if (!action) throw new Error("Action not found.");
    tracker.store.transaction(() => {
      tracker.store.put("actions", { ...action, ...data });
      if (data.status === "completed" && action.status !== "completed") {
        const application = tracker.app(action.applicationId);
        const time = new Date().toISOString();
        tracker.store.put("events", {
          id: `action:${action.id}:completed`,
          applicationId: application.id,
          type:
            action.kind === "assessment"
              ? "assessment_completed"
              : "interview_completed",
          stage: application.stage,
          occurredAt: time,
          timeBasis: "user",
          createdAt: time,
          sourceId: "",
          label: `${action.kind === "assessment" ? "Assessment" : "Interview"} marked complete`,
          confidence: 1,
          matchConfidence: 1,
        });
        tracker.store.put("applications", {
          ...application,
          lastActivity: time,
          updatedAt: time,
        });
      }
    });
    res.json({ ok: true });
  });
  app.post("/api/merge", (req, res) => {
    const data = z
      .object({ from: z.string(), into: z.string() })
      .parse(req.body);
    const result = tracker.merge(data.from, data.into);
    tracker.store.set("mergeHash", hashBackup(tracker));
    res.json(result);
  });
  app.post("/api/merge/undo", (_req, res) => {
    if (tracker.sync.running)
      throw new Error("Wait for Gmail sync before undoing the merge.");
    const backup = tracker.store.setting<any>("mergeUndo", null);
    if (!backup) throw new Error("There is no merge to undo.");
    if (hashBackup(tracker) !== tracker.store.setting("mergeHash", ""))
      throw new Error(
        "Records changed after the merge. Undo is no longer safe; use the pre-merge backup to recover separately.",
      );
    tracker.restore(backup);
    res.json({ ok: true });
  });
  app.get("/api/export.csv", (_req, res) => {
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="applications.csv"',
    );
    res.type("text/csv").send(csvExport(tracker.apps()));
  });
  app.get("/api/backup", (_req, res) => {
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="fieldwork-backup.json"',
    );
    res.json(tracker.store.backup());
  });
  app.get("/api/merge/backup", (_req, res) => {
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="fieldwork-before-merge.json"',
    );
    res.json(tracker.store.setting("mergeUndo", null));
  });
  app.post("/api/restore", (req, res) => {
    if (
      tracker.apps().length ||
      tracker.store.all("sources").length ||
      tracker.sync.running
    )
      throw new Error(
        "Restore requires an empty instance with Gmail sync stopped. Use a new data directory.",
      );
    const backup = backupSchema.parse(req.body);
    const ids = new Set(backup.tables.applications.map((a) => a.id));
    for (const table of Object.values(backup.tables))
      if (new Set(table.map((i) => i.id)).size !== table.length)
        throw new Error("Backup contains duplicate IDs.");
    for (const table of [
      "events",
      "snapshots",
      "actions",
      "sources",
      "imports",
    ] as const)
      for (const row of backup.tables[table])
        if (row.applicationId && !ids.has(row.applicationId))
          throw new Error("Backup contains an invalid application reference.");
    tracker.restore(backup);
    res.json({ ok: true });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Endpoint not found." }),
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof z.ZodError)
        return void res.status(400).json({
          error: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .slice(0, 3)
            .join("; "),
        });
      const message =
        error instanceof Error ? error.message : "Request failed.";
      const safe =
        /^(?:Add |Choose |Use |This |These |Select |Application |Message |Action |Connect |Save |Gmail |AI |Job |Private |Only |Too many |Reload |Authorization |Could not |Read-only |Restore |Backup |Wait |There |Records |The AI|Unsupported|Invalid)/.test(
          message,
        );
      res.status(message.includes("not found") ? 404 : 400).json({
        error: safe
          ? message
          : "The request could not be completed. Check the input and try again.",
      });
    },
  );
  return { app, gmail, discovery };
}
