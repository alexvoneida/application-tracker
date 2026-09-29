import type { Tracker } from "./tracker";
import { localDate } from "../shared/model";
import {
  discoveryConfigSchema,
  type DiscoveryConfig,
  type DiscoverySource,
  type DiscoveredJob,
  type DiscoveryCandidate,
  type DiscoveryState,
} from "../shared/discovery";
import { publicRequest } from "./network";
import {
  boardFromUrl,
  jobIdentity,
  isSoftwareRole,
  fetchSource,
  FeedError,
  githubFeed,
} from "./discovery-providers";

const terms = (value: string) =>
  value
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
export function matchDiscovery(
  job: DiscoveryCandidate,
  config: DiscoveryConfig,
) {
  const reasons: string[] = [];
  const haystack = `${job.title}\n${job.description}`.toLowerCase();
  if (
    !isSoftwareRole(job.title) ||
    /intern|contract|part.?time|temporary/i.test(job.employmentType)
  )
    reasons.push("Not a full-time entry-level SWE role");
  if (job.requiredYears !== null && job.requiredYears > config.maxExperience)
    reasons.push("Experience requirement exceeds your limit");
  if (
    job.requiredYears === null &&
    job.entryEvidence === "Experience not established" &&
    !config.includeUnknownExperience
  )
    reasons.push("Experience requirement unknown");
  if (
    config.workArrangement !== "Any" &&
    job.workArrangement !== config.workArrangement
  )
    reasons.push("Work arrangement does not match");
  if (
    terms(config.locations).length &&
    !terms(config.locations).some((term) =>
      job.location.toLowerCase().includes(term),
    )
  )
    reasons.push("Location does not match (or is unknown)");
  if (
    terms(config.keywords).length &&
    !terms(config.keywords).some((term) => haystack.includes(term))
  )
    reasons.push("No preferred keyword found");
  if (terms(config.excludeKeywords).some((term) => haystack.includes(term)))
    reasons.push("Excluded keyword found");
  if (
    terms(config.excludeCompanies).some((term) =>
      job.company.toLowerCase().includes(term),
    )
  )
    reasons.push("Excluded company");
  if (config.minSalary > 0) {
    if (job.annualSalaryMax === null || job.currency !== config.currency) {
      if (!config.includeUnknownSalary)
        reasons.push("Comparable annual salary is unavailable");
    } else if (job.annualSalaryMax < config.minSalary)
      reasons.push("Posted salary range is below your minimum");
  }
  return reasons;
}
// Rejecting with an Error shows its message in Discover.
export type DiscoveryNotify = (jobs: DiscoveredJob[]) => void | Promise<void>;
// Runs inside the checkpoint transaction, so it must be synchronous.
export type DiscoveryOutbox = (jobs: DiscoveredJob[]) => void;

export class Discovery {
  private active?: Promise<void>;
  private controller?: AbortController;
  private stopped = false;
  notificationError = "";
  // Alerts are delivered one batch at a time, off the scan loop, so a slow OS
  // permission check never delays other sources or shutdown, and the error
  // shown always reflects the latest batch.
  private delivery = Promise.resolve();
  constructor(
    private tracker: Pick<Tracker, "store" | "apps" | "create">,
    private request = publicRequest,
    private notify?: DiscoveryNotify,
    private persistAlerts?: DiscoveryOutbox,
  ) {
    // Discovery is a rebuildable cache, kept outside application backup/merge tables.
    tracker.store.db
      .exec(`CREATE TABLE IF NOT EXISTS discovery_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS discovery_sources (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));`);
    if (!this.sources().some((s) => s.id === "github:simplify"))
      this.putSource({
        id: "github:simplify",
        kind: "github",
        slug: "simplify",
        name: "Simplify • SWE new grads",
        url: githubFeed,
        enabled: true,
        initialized: false,
        lastChecked: "",
        lastSuccess: "",
        nextCheck: "",
        failures: 0,
        error: "",
        etag: "",
        count: 0,
      });
  }
  config() {
    return discoveryConfigSchema.parse(
      this.tracker.store.setting("discoveryConfig", {}),
    );
  }
  configure(value: unknown) {
    const config = discoveryConfigSchema.parse(value);
    this.tracker.store.set("discoveryConfig", config);
    if (!config.enabled) this.controller?.abort();
    return config;
  }
  sources(): DiscoverySource[] {
    return this.tracker.store.db
      .prepare("SELECT data FROM discovery_sources")
      .all()
      .map((row) => JSON.parse(row.data as string));
  }
  jobs(): DiscoveredJob[] {
    return this.tracker.store.db
      .prepare("SELECT data FROM discovery_jobs")
      .all()
      .map((row) => JSON.parse(row.data as string));
  }
  private putSource(source: DiscoverySource) {
    this.tracker.store.db
      .prepare(
        "INSERT INTO discovery_sources VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(source.id, JSON.stringify(source));
  }
  private putJob(job: DiscoveredJob) {
    this.tracker.store.db
      .prepare(
        "INSERT INTO discovery_jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(job.id, JSON.stringify(job));
  }
  private job(id: string) {
    const row = this.tracker.store.db
      .prepare("SELECT data FROM discovery_jobs WHERE id=?")
      .get(id);
    if (!row) throw new Error("Job not found.");
    return JSON.parse(row.data as string) as DiscoveredJob;
  }
  addBoard(url: string, name = "") {
    const source = boardFromUrl(url, name);
    if (!source)
      throw new Error(
        "Choose a Greenhouse, Lever, or Ashby HTTPS job-board link.",
      );
    const existing = this.sources();
    if (existing.some((s) => s.id === source.id))
      return existing.find((s) => s.id === source.id)!;
    if (existing.length >= 501)
      throw new Error(
        "Too many boards. This local instance supports 500 direct boards.",
      );
    this.putSource(source);
    return source;
  }
  enableSource(id: string, enabled: boolean) {
    const source = this.sources().find((s) => s.id === id);
    if (!source) throw new Error("Job source not found.");
    // A disabled source remains in the DB to retain its baseline/dedup history.
    this.putSource({ ...source, enabled });
  }
  state(): DiscoveryState {
    const config = this.config();
    const apps = this.tracker.apps();
    const applicationIds = new Set(apps.map((a) => a.id));
    const applications = new Map(
      apps.filter((a) => a.url).map((a) => [jobIdentity(a.url), a.id]),
    );
    const jobs = this.jobs()
      .map((job) => {
        const matchReasons = matchDiscovery(job, config);
        return {
          ...job,
          // Fetch descriptions on demand, not in every five-second list poll.
          description: "",
          applicationId:
            applications.get(job.id) ||
            (applicationIds.has(job.applicationId) ? job.applicationId : ""),
          matches: !matchReasons.length,
          matchReasons,
        };
      })
      .sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt));
    return {
      config,
      sources: this.sources(),
      running: !!this.active,
      total: jobs.length,
      matching: jobs.filter(
        (j) =>
          j.matches &&
          !j.closed &&
          j.disposition !== "dismissed" &&
          !j.applicationId,
      ).length,
      unread: jobs.filter(
        (j) =>
          j.matches &&
          !j.closed &&
          !j.baseline &&
          !j.seenAt &&
          j.disposition !== "dismissed" &&
          !j.applicationId,
      ).length,
      jobs,
      notificationError: this.notificationError,
    };
  }
  detail(id: string) {
    return this.job(id);
  }
  workerConfig() {
    return {
      version: 1,
      config: { ...this.config(), enabled: true, notifications: true },
      githubEnabled: this.sources().find((s) => s.kind === "github")!.enabled,
      boards: this.sources()
        .filter((s) => s.kind !== "github")
        .map(({ url, name, enabled }) => ({ url, name, enabled })),
    };
  }
  updateJob(id: string, action: "save" | "dismiss" | "restore" | "seen") {
    const job = this.job(id);
    this.putJob({
      ...job,
      seenAt: new Date().toISOString(),
      disposition:
        action === "save"
          ? "saved"
          : action === "dismiss"
            ? "dismissed"
            : action === "restore"
              ? "new"
              : job.disposition,
    });
  }
  markApplied(id: string, appliedAt = localDate()) {
    const job = this.job(id);
    const existing = this.tracker
      .apps()
      .find((a) => a.url && jobIdentity(a.url) === job.id);
    const application =
      existing ||
      this.tracker.create({
        ...job,
        url: job.url,
        appliedAt,
        stage: "Applied",
        description: job.description,
      });
    this.putJob({
      ...job,
      applicationId: application.id,
      seenAt: new Date().toISOString(),
    });
    return application;
  }
  tick() {
    if (this.stopped || !this.config().enabled) return Promise.resolve();
    if (this.active) return this.active;
    const controller = (this.controller = new AbortController());
    this.active = this.scan(controller.signal).finally(() => {
      this.active = undefined;
      this.controller = undefined;
    });
    return this.active;
  }
  private async scan(signal: AbortSignal) {
    // Fair queue, bounded concurrency, persisted Retry-After/backoff. Manual checks
    // use the same schedule, so repeated clicks cannot hammer providers.
    const due = this.sources()
      .filter(
        (s) =>
          s.enabled && (!s.nextCheck || Date.parse(s.nextCheck) <= Date.now()),
      )
      .sort((a, b) => a.lastChecked.localeCompare(b.lastChecked))
      .slice(0, 12);
    let index = 0;
    const worker = async () => {
      while (index < due.length && !signal.aborted) {
        const source = due[index++];
        await this.poll(source, signal);
      }
    };
    await Promise.all([worker(), worker()]);
  }
  private deliver(notify: DiscoveryNotify, alerts: DiscoveredJob[]) {
    this.delivery = this.delivery
      .then(() => notify(alerts))
      .then(
        () => {
          this.notificationError = "";
        },
        (error) => {
          this.notificationError =
            (error instanceof Error && error.message) ||
            "Desktop alert could not be shown. Check macOS notification settings; matches remain in Discover.";
        },
      );
  }
  private async poll(source: DiscoverySource, signal: AbortSignal) {
    const started = new Date().toISOString();
    try {
      const result = await fetchSource(source, this.request, signal);
      if (signal.aborted) return;
      // Preserve user pause changes made while this request was in flight.
      const current = this.sources().find((s) => s.id === source.id)!;
      if (!current.enabled) return;
      const alerts: DiscoveredJob[] = [];
      const config = this.config();
      this.tracker.store.transaction(() => {
        if (!result.unchanged) {
          const existing = new Map(this.jobs().map((j) => [j.id, j]));
          const present = new Set(result.jobs.map((j) => j.id));
          const appliedIds = new Set(
            this.tracker
              .apps()
              .filter((a) => a.url)
              .map((a) => jobIdentity(a.url)),
          );
          for (const candidate of result.jobs) {
            const old = existing.get(candidate.id);
            if (!old && !isSoftwareRole(candidate.title)) continue;
            const sources = {
              ...old?.sources,
              [source.id]: { present: true, lastSeen: started },
            };
            const direct = Object.entries(sources).filter(
              ([id]) => !id.startsWith("github:"),
            );
            const closed = !(
              direct.length ? direct : Object.entries(sources)
            ).some(([, state]) => state.present);
            // GitHub metadata must not erase richer fields learned directly.
            const data =
              old && source.kind === "github"
                ? { ...candidate, ...old }
                : { ...old, ...candidate };
            const job: DiscoveredJob = {
              ...data,
              sources,
              closed,
              firstSeenAt: old?.firstSeenAt || started,
              lastSeenAt: started,
              baseline: old?.baseline ?? !source.initialized,
              disposition: old?.disposition || "new",
              seenAt: old?.seenAt || "",
              alertedAt: old?.alertedAt || "",
              applicationId: old?.applicationId || "",
            };
            if (
              !job.baseline &&
              !job.alertedAt &&
              job.disposition !== "dismissed" &&
              source.initialized &&
              !closed &&
              !appliedIds.has(job.id) &&
              !matchDiscovery(job, config).length &&
              config.notifications
            ) {
              job.alertedAt = started;
              alerts.push(job);
            }
            this.putJob(job);
            existing.set(job.id, job);
          }
          for (const old of existing.values())
            if (old.sources[source.id]?.present && !present.has(old.id)) {
              const sources = {
                ...old.sources,
                [source.id]: { ...old.sources[source.id], present: false },
              };
              const direct = Object.entries(sources).filter(
                ([id]) => !id.startsWith("github:"),
              );
              this.putJob({
                ...old,
                sources,
                closed: !(
                  direct.length ? direct : Object.entries(sources)
                ).some(([, state]) => state.present),
              });
            }
          if (source.kind === "github" && config.autoWatch) {
            const known = new Set(this.sources().map((s) => s.id));
            for (const job of result.jobs) {
              const board = boardFromUrl(job.url, job.company);
              if (board && !known.has(board.id) && known.size < 501) {
                this.putSource(board);
                known.add(board.id);
              }
            }
          }
        }
        this.putSource({
          ...current,
          lastChecked: started,
          lastSuccess: started,
          initialized: true,
          failures: 0,
          error: "",
          etag: result.etag,
          count: result.unchanged ? current.count : result.jobs.length,
          nextCheck: new Date(
            Date.now() + config.pollMinutes * 60000 + Math.random() * 5000,
          ).toISOString(),
        });
        // A cloud outbox is written in the same transaction as the checkpoint.
        if (alerts.length) this.persistAlerts?.(alerts);
      });
      if (alerts.length && this.notify) this.deliver(this.notify, alerts);
    } catch (error) {
      if (signal.aborted) return;
      const current = this.sources().find((s) => s.id === source.id)!;
      const failures = current.failures + 1;
      const delay = Math.max(
        this.config().pollMinutes * 60000,
        Math.min(6 * 3600000, 60000 * 2 ** Math.min(failures, 9)),
        error instanceof FeedError ? Math.min(error.retryAfter, 86400000) : 0,
      );
      this.putSource({
        ...current,
        lastChecked: started,
        failures,
        nextCheck: new Date(Date.now() + delay).toISOString(),
        error:
          error instanceof FeedError ||
          (error instanceof Error &&
            /^(Unsupported|Source pagination)/.test(error.message))
            ? error.message
            : "Could not read this source. Previous listings preserved; retry scheduled.",
      });
    }
  }
  stop() {
    this.stopped = true;
    this.controller?.abort();
  }
  async idle() {
    await this.active;
  }
}
