import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  Bell,
  ExternalLink,
  RefreshCw,
  Search,
  Bookmark,
  Check,
  X,
} from "lucide-react";
import type {
  DiscoveryConfig,
  DiscoveryState,
  DiscoveredJob,
} from "../shared/discovery";
import { localDate } from "../shared/model";
import { api, timeText } from "./api";
import { Field, Notice, Busy, Modal } from "./components";
import type { DesktopNotificationPermission } from "../shared/desktop";

function permissionMessage(permission: DesktopNotificationPermission) {
  if (permission.error) return permission.error;
  if (permission.status === "denied")
    return "Mac notifications are denied. Enable Fieldwork in macOS Notification Settings; macOS will not repeat a previously answered permission prompt.";
  if (permission.status === "not-determined")
    return "Mac notification permission has not been decided yet.";
  if (permission.status === "provisional")
    return "Mac notifications are allowed quietly. Enable banners and sounds in Notification Settings if you want visible alerts.";
  if (permission.status === "authorized")
    return permission.alertsEnabled
      ? "Mac notification permission is allowed."
      : "Mac notification permission is allowed, but alerts are disabled in Notification Settings.";
  return "Mac notification permission is unavailable.";
}

export function DiscoverPanel({
  onApplied,
}: {
  onApplied: (id: string) => Promise<void>;
}) {
  const [state, setState] = useState<DiscoveryState>();
  const [config, setConfig] = useState<DiscoveryConfig>();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState("matches");
  const [limit, setLimit] = useState(40);
  const [boardUrl, setBoardUrl] = useState("");
  const [boardName, setBoardName] = useState("");
  const [sourceSearch, setSourceSearch] = useState("");
  const [confirm, setConfirm] = useState<DiscoveredJob>();
  const [date, setDate] = useState(localDate());
  const [detail, setDetail] = useState<DiscoveredJob>();
  const [permission, setPermission] = useState<DesktopNotificationPermission>();
  const refresh = useCallback(async () => {
    const result = await api<DiscoveryState>("/discovery");
    setState(result);
    setConfig((current) => current || result.config);
    if (window.fieldworkDesktop)
      setPermission(await window.fieldworkDesktop.notificationPermission());
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(
      () => void refresh().catch((e) => setError(e.message)),
      5000,
    );
    const focus = () => void refresh().catch((e) => setError(e.message));
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  useEffect(() => {
    setLimit(40);
  }, [search, mode]);
  async function run(task: () => Promise<unknown>, success = "") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await task();
      await refresh();
      setMessage(typeof result === "string" ? result : success);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const change = <K extends keyof DiscoveryConfig>(
    key: K,
    value: DiscoveryConfig[K],
  ) => setConfig((c) => (c ? { ...c, [key]: value } : c));
  async function save(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      await api("/discovery/settings", "POST", config);
      if (window.fieldworkDesktop && config?.notifications) {
        const result =
          await window.fieldworkDesktop.requestNotificationPermission();
        setPermission(result);
        return `Discovery preferences saved. ${permissionMessage(result)}`;
      }
    }, "Discovery preferences saved. Alerts use these filters; existing jobs remain available.");
  }
  const shown = useMemo(
    () =>
      (state?.jobs || []).filter(
        (job) =>
          (mode === "all" || mode === "dismissed"
            ? mode !== "dismissed" || job.disposition === "dismissed"
            : job.matches &&
              !job.closed &&
              !job.applicationId &&
              job.disposition !== "dismissed") &&
          (mode !== "saved" || job.disposition === "saved") &&
          (mode !== "new" || (!job.baseline && !job.seenAt)) &&
          (!search ||
            `${job.company} ${job.title} ${job.location}`
              .toLowerCase()
              .includes(search.toLowerCase())),
      ),
    [state, search, mode],
  );
  if (!state || !config)
    return error ? (
      <Notice error>{error}</Notice>
    ) : (
      <Busy text="Loading job discovery…" />
    );
  const healthy = state.sources.filter(
    (s) => s.enabled && s.lastSuccess && !s.error,
  ).length;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">GET THERE EARLIER</div>
          <h1>Your next opportunity.</h1>
          <p>
            New-grad and entry-level software roles, straight from the source.
          </p>
        </div>
        <button
          className="button primary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const next = { ...config, enabled: !state.config.enabled };
              await api("/discovery/settings", "POST", next);
              setConfig(next);
            })
          }
        >
          {state.config.enabled ? "Pause monitoring" : "Start monitoring"}
        </button>
      </div>
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {state.notificationError && (
        <Notice error>{state.notificationError}</Notice>
      )}
      <div className="discovery-summary">
        <span>
          <strong>{state.matching}</strong> matching roles
        </span>
        <span>
          <strong>{state.unread}</strong> unseen new matches
        </span>
        <span>
          <strong>
            {healthy}/{state.sources.filter((s) => s.enabled).length}
          </strong>{" "}
          healthy sources
        </span>
        <span>
          {state.running
            ? "Checking sources…"
            : state.config.enabled
              ? "Monitoring active"
              : "Monitoring paused"}
        </span>
        <button
          className="text-button"
          disabled={busy || state.running || !state.config.enabled}
          onClick={() =>
            void run(
              () => api("/discovery/check", "POST", {}),
              "Checking sources that are due. Rate limits and retry delays are respected.",
            )
          }
        >
          <RefreshCw size={14} /> Check due sources
        </button>
      </div>
      {!state.config.enabled && (
        <Notice>
          Start monitoring to import the GitHub list and discover supported
          company boards. The first check establishes a baseline without sending
          a burst of old-job alerts.
        </Notice>
      )}
      <details className="settings-section discovery-settings">
        <summary>
          <Search size={18} /> Search preferences & alerts
        </summary>
        <form onSubmit={save}>
          <div className="form-grid compact">
            <Field
              label="Locations"
              hint="Comma-separated alternatives, matched against the posted location. Blank means anywhere. Remote roles still have geographic restrictions."
            >
              <input
                value={config.locations}
                onChange={(e) => change("locations", e.target.value)}
                placeholder="Denver, Colorado, Remote in USA"
              />
            </Field>
            <Field label="Work arrangement">
              <select
                value={config.workArrangement}
                onChange={(e) =>
                  change(
                    "workArrangement",
                    e.target.value as DiscoveryConfig["workArrangement"],
                  )
                }
              >
                {["Any", "Remote", "Hybrid", "On-site"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Field>
            <Field
              label="Maximum required experience (years)"
              hint="Uses explicit experience statements and entry-level titles; check the original eligibility requirements."
            >
              <input
                type="number"
                min="0"
                max="5"
                value={config.maxExperience}
                onChange={(e) =>
                  change("maxExperience", Number(e.target.value))
                }
              />
            </Field>
            <Field
              label="Check interval (minutes)"
              hint="Target interval per source, not a guaranteed detection time. Busy queues and backoff can delay checks."
            >
              <input
                type="number"
                min="2"
                max="60"
                value={config.pollMinutes}
                onChange={(e) => change("pollMinutes", Number(e.target.value))}
              />
            </Field>
            <Field
              label="Minimum annual salary"
              hint="Matches when the published range’s upper end reaches this amount. No currency conversion; not a salary guarantee. Zero disables this filter."
            >
              <input
                type="number"
                min="0"
                max="10000000"
                step="1000"
                value={config.minSalary}
                onChange={(e) => change("minSalary", Number(e.target.value))}
              />
            </Field>
            <Field label="Salary currency">
              <select
                value={config.currency}
                onChange={(e) =>
                  change(
                    "currency",
                    e.target.value as DiscoveryConfig["currency"],
                  )
                }
              >
                {["USD", "CAD", "EUR", "GBP", "AUD", "INR"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Field>
            <Field
              label="Preferred keywords"
              hint="Comma-separated alternatives; at least one must appear. Blank accepts all SWE specialties."
            >
              <input
                value={config.keywords}
                onChange={(e) => change("keywords", e.target.value)}
                placeholder="backend, full stack, Python"
              />
            </Field>
            <Field label="Excluded keywords">
              <input
                value={config.excludeKeywords}
                onChange={(e) => change("excludeKeywords", e.target.value)}
                placeholder="security clearance"
              />
            </Field>
            <Field label="Excluded companies">
              <input
                value={config.excludeCompanies}
                onChange={(e) => change("excludeCompanies", e.target.value)}
              />
            </Field>
          </div>
          <label className="check-label">
            <input
              type="checkbox"
              checked={config.includeUnknownExperience}
              onChange={(e) =>
                change("includeUnknownExperience", e.target.checked)
              }
            />
            Include SWE roles with unestablished experience level
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={config.includeUnknownSalary}
              onChange={(e) => change("includeUnknownSalary", e.target.checked)}
            />
            Include roles without comparable salary information
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={config.autoWatch}
              onChange={(e) => change("autoWatch", e.target.checked)}
            />
            Automatically discover Greenhouse, Lever, and Ashby boards from
            GitHub listings
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={config.notifications}
              onChange={(e) => change("notifications", e.target.checked)}
            />
            Notify me about newly detected matching roles
          </label>
          <p className="small muted">
            Mac alerts work while Fieldwork is running, including in the menu
            bar. Your Mac must be awake and online. Allow Fieldwork
            notifications in macOS System Settings. Browser mode keeps matches
            in this feed but does not send native Mac alerts.
          </p>
          {permission && (
            <div className="small" role="status">
              <p>{permissionMessage(permission)}</p>
              <p className="muted">
                Permission status saved locally. Last checked:{" "}
                {timeText(permission.checkedAt)}
                {permission.requestedAt
                  ? ` · Requested: ${timeText(permission.requestedAt)}`
                  : ""}
                . macOS remains the source of truth.
              </p>
            </div>
          )}
          <div className="button-row">
            <button className="button primary" disabled={busy}>
              Save discovery preferences
            </button>
            {window.fieldworkDesktop && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result =
                      await window.fieldworkDesktop!.testNotification();
                    setPermission(result);
                    return `${permissionMessage(result)}${["authorized", "provisional"].includes(result.status) ? " Test notification requested; check Focus mode if it does not appear." : ""}`;
                  })
                }
              >
                <Bell size={15} /> Test Mac notification
              </button>
            )}
            {window.fieldworkDesktop && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    window.fieldworkDesktop!.openNotificationSettings(),
                  )
                }
              >
                Open macOS Notification Settings
              </button>
            )}
          </div>
        </form>
      </details>
      <details className="settings-section discovery-settings">
        <summary>Always-on phone alerts · Telegram</summary>
        <p>
          Run the discovery-only worker on a cloud server to receive Telegram
          messages while your Mac is asleep or off. Each alert includes the
          role, company, location, and an application link. Telegram messages
          are free at this volume; cloud hosting may cost money.
        </p>
        <ol>
          <li>
            Save your search preferences above, then download your worker
            configuration.
          </li>
          <li>
            Create your own Telegram bot using @BotFather and start a private
            chat with it.
          </li>
          <li>
            Deploy the included worker container with persistent storage. Add
            the bot token and your chat ID as hosting secrets.
          </li>
        </ol>
        <p className="small muted">
          The download contains only filters and job-board URLs—no Gmail access,
          API keys, or application history. It enables cloud monitoring and
          alerts. Local and cloud instances are independent: re-export and
          restart the worker after changing filters. A newly deployed worker
          starts with a quiet baseline; discoveries and applied status do not
          sync between devices.
        </p>
        <a
          className="button secondary"
          href="/api/discovery/worker-config"
          download="fieldwork-worker.json"
        >
          Download cloud worker configuration
        </a>
        <p className="small muted">
          Deployment and Telegram setup instructions are in CLOUD-WORKER.md in
          the project. Downloading this file does not deploy or activate a cloud
          service.
        </p>
      </details>
      <details className="settings-section discovery-settings">
        <summary>Sources & coverage ({state.sources.length})</summary>
        <p className="small muted">
          Simplify’s SWE GitHub list plus supported boards discovered from its
          links. This is not every company: Workday and other unsupported boards
          are visible through GitHub only. Every newly added board is baselined
          without old-job alerts. Up to 500 direct boards.
        </p>
        <form
          className="discovery-source-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("/discovery/sources", "POST", {
                url: boardUrl,
                name: boardName,
              });
              setBoardUrl("");
              setBoardName("");
            });
          }}
        >
          <Field label="Company name">
            <input
              value={boardName}
              onChange={(e) => setBoardName(e.target.value)}
              maxLength={200}
            />
          </Field>
          <Field label="Additional job board URL">
            <input
              type="url"
              required
              value={boardUrl}
              onChange={(e) => setBoardUrl(e.target.value)}
              placeholder="https://jobs.ashbyhq.com/company"
            />
          </Field>
          <button className="button secondary" disabled={busy}>
            Watch board
          </button>
        </form>
        <Field label="Find a source">
          <input
            value={sourceSearch}
            onChange={(e) => setSourceSearch(e.target.value)}
          />
        </Field>
        <div className="discovery-source-list">
          {state.sources
            .filter((source) =>
              `${source.name} ${source.kind}`
                .toLowerCase()
                .includes(sourceSearch.toLowerCase()),
            )
            .slice(0, 100)
            .map((source) => (
              <div key={source.id} className="discovery-source">
                <div>
                  <strong>{source.name}</strong>{" "}
                  <span className="small muted">{source.kind}</span>
                  <p className="small muted">
                    Last successful check: {timeText(source.lastSuccess)} ·
                    Next: {timeText(source.nextCheck)} · {source.count} postings
                  </p>
                  {source.error && <p className="error-text">{source.error}</p>}
                </div>
                <button
                  className="text-button"
                  disabled={busy}
                  aria-label={`${source.enabled ? "Pause" : "Resume"} ${source.name}`}
                  onClick={() =>
                    void run(() =>
                      api(
                        `/discovery/sources/${encodeURIComponent(source.id)}`,
                        "PATCH",
                        { enabled: !source.enabled },
                      ),
                    )
                  }
                >
                  {source.enabled ? "Pause" : "Resume"}
                </button>
              </div>
            ))}
        </div>
      </details>
      <div className="discovery-toolbar">
        <Field label="Search discovered jobs">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Company, role, location…"
          />
        </Field>
        <Field label="Show discoveries">
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="matches">Matching open roles</option>
            <option value="new">Unseen new matches</option>
            <option value="saved">Saved matches</option>
            <option value="all">All discovered roles</option>
            <option value="dismissed">Dismissed roles</option>
          </select>
        </Field>
        <span className="small muted">{shown.length} roles</span>
      </div>
      <div className="discovery-jobs">
        {shown.slice(0, limit).map((job) => (
          <article className="discovery-job" key={job.id}>
            <div className="discovery-job-heading">
              <div>
                <div className="eyebrow">{job.company}</div>
                <h2>{job.title}</h2>
                <p>
                  {job.location || "Location not listed"} ·{" "}
                  {job.workArrangement}
                </p>
              </div>
              <span
                className={`connection-pill ${!job.baseline && !job.seenAt ? "connected" : ""}`}
              >
                {job.applicationId
                  ? "Applied"
                  : job.closed
                    ? "No longer listed"
                    : job.disposition === "saved"
                      ? "Saved"
                      : job.baseline
                        ? "Existing at first check"
                        : "Newly detected"}
              </span>
            </div>
            <p className="small">
              {job.salary ||
                "Salary not published / not available from this source"}
            </p>
            <p className="small muted">
              Detected {timeText(job.firstSeenAt)}
              {job.publishedAt &&
                ` · Employer publication: ${timeText(job.publishedAt)} (may be a republication)`}
            </p>
            <p className="small muted">
              {job.entryEvidence} ·{" "}
              {Object.keys(job.sources)
                .map((id) => state.sources.find((s) => s.id === id)?.kind || id)
                .filter((v, i, a) => a.indexOf(v) === i)
                .join(" + ")}
            </p>
            {!job.matches && (
              <p className="small muted">
                Outside current filters: {job.matchReasons.join("; ")}
              </p>
            )}
            <div className="button-row">
              <a
                className="button primary"
                href={job.url}
                target="_blank"
                rel="noreferrer"
                onClick={() =>
                  void run(() =>
                    api(`/discovery/jobs/${job.id}`, "PATCH", {
                      action: "seen",
                    }),
                  )
                }
              >
                <ExternalLink size={15} /> Open application
              </a>
              {job.applicationId ? (
                <button
                  className="button secondary"
                  onClick={() => void onApplied(job.applicationId)}
                >
                  View tracked application
                </button>
              ) : (
                <button
                  className="button secondary"
                  onClick={() => {
                    setConfirm(job);
                    setDate(localDate());
                  }}
                >
                  <Check size={15} /> I applied
                </button>
              )}
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api(`/discovery/jobs/${job.id}`, "PATCH", {
                      action: job.disposition === "saved" ? "restore" : "save",
                    }),
                  )
                }
              >
                <Bookmark size={14} />{" "}
                {job.disposition === "saved" ? "Unsave" : "Save"}
              </button>
              <button
                className="text-button"
                onClick={() =>
                  void run(async () =>
                    setDetail(
                      await api<DiscoveredJob>(`/discovery/jobs/${job.id}`),
                    ),
                  )
                }
              >
                Details
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api(`/discovery/jobs/${job.id}`, "PATCH", {
                      action:
                        job.disposition === "dismissed" ? "restore" : "dismiss",
                    }),
                  )
                }
              >
                <X size={14} />{" "}
                {job.disposition === "dismissed" ? "Restore" : "Dismiss"}
              </button>
            </div>
          </article>
        ))}
      </div>
      {!shown.length && (
        <div className="empty-state">
          <Search size={28} />
          <h2>No roles in this view yet.</h2>
          <p>
            Start monitoring, check source health, or broaden your filters.
            Missing salary and unknown experience can be included separately.
          </p>
        </div>
      )}
      {shown.length > limit && (
        <button
          className="button secondary"
          onClick={() => setLimit((n) => n + 40)}
        >
          Show more roles
        </button>
      )}
      {confirm && (
        <Modal
          title="Record your application"
          close={() => setConfirm(undefined)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const app = await api<{ id: string }>(
                  `/discovery/jobs/${confirm.id}/applied`,
                  "POST",
                  { appliedAt: date },
                );
                setConfirm(undefined);
                await onApplied(app.id);
              });
            }}
          >
            <p>
              Confirm that you submitted an application for {confirm.title} at{" "}
              {confirm.company}. Opening the listing does not submit anything.
            </p>
            <Field label="Date applied">
              <input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <button className="button primary" disabled={busy}>
              Confirm application submitted
            </button>
          </form>
        </Modal>
      )}
      {detail && (
        <Modal title={detail.title} close={() => setDetail(undefined)}>
          <p>
            {detail.company} · {detail.location}
          </p>
          <pre className="description-text">
            {detail.description ||
              "The source did not include a description. Open the application page for the full requirements."}
          </pre>
          <a
            className="button primary"
            href={detail.url}
            target="_blank"
            rel="noreferrer"
          >
            Open original posting
          </a>
        </Modal>
      )}
    </>
  );
}
