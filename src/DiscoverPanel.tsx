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
    return "notifications are blocked. turn them on for application tracker in macos notification settings (macos won't ask again).";
  if (permission.status === "not-determined")
    return "haven't allowed or blocked notifications yet";
  if (permission.status === "provisional")
    return "notifications are on but quiet. turn on banners/sounds in notification settings to actually see them.";
  if (permission.status === "authorized")
    return permission.alertsEnabled
      ? "notifications are on"
      : "notifications are allowed but alerts are off in notification settings";
  return "can't check notification permission";
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
  const [connectionError, setConnectionError] = useState("");
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
    // Separate from `error` so a recovered poll clears only its own banner.
    const poll = () =>
      void refresh().then(
        () => setConnectionError(""),
        (e) => setConnectionError(e.message),
      );
    poll();
    const timer = setInterval(poll, 5000);
    const focus = poll;
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
        return `saved. ${permissionMessage(result)}`;
      }
    }, "saved. alerts use these filters now; jobs already found are still here.");
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
    return error ? <Notice error>{error}</Notice> : <Busy text="loading…" />;
  const healthy = state.sources.filter(
    (s) => s.enabled && s.lastSuccess && !s.error,
  ).length;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>find jobs</h1>
          <p>new grad / entry level swe roles as they get posted</p>
        </div>
        <button
          className="button primary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const enabled = !state.config.enabled;
              await api("/discovery/settings", "POST", {
                ...state.config,
                enabled,
              });
              setConfig((current) => current && { ...current, enabled });
            })
          }
        >
          {state.config.enabled ? "pause" : "start watching"}
        </button>
      </div>
      {connectionError && <Notice error>{connectionError}</Notice>}
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {state.notificationError && (
        <Notice error>{state.notificationError}</Notice>
      )}
      <div className="discovery-summary">
        <span>
          <strong>{state.matching}</strong> matching
        </span>
        <span>
          <strong>{state.unread}</strong> new
        </span>
        <span>
          <strong>
            {healthy}/{state.sources.filter((s) => s.enabled).length}
          </strong>{" "}
          sources working
        </span>
        <span>
          {state.running
            ? "checking…"
            : state.config.enabled
              ? "watching"
              : "paused"}
        </span>
        <button
          className="text-button"
          disabled={busy || state.running || !state.config.enabled}
          onClick={() =>
            void run(
              () => api("/discovery/check", "POST", {}),
              "checking the ones that are due",
            )
          }
        >
          <RefreshCw size={14} /> check now
        </button>
      </div>
      {!state.config.enabled && (
        <Notice>
          hit start to pull in the github list and find company boards. the
          first check just records what's already there so it doesn't spam old
          jobs.
        </Notice>
      )}
      <details className="settings-section discovery-settings">
        <summary>
          <Search size={18} /> filters & alerts
        </summary>
        <form onSubmit={save}>
          <div className="form-grid compact">
            <Field
              label="locations"
              hint="comma separated, matched against the listed location. blank = anywhere. remote jobs can still be location-locked."
            >
              <input
                value={config.locations}
                onChange={(e) => change("locations", e.target.value)}
                placeholder="denver, colorado, remote in usa"
              />
            </Field>
            <Field label="remote / hybrid / on-site">
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
                  <option key={v} value={v}>
                    {v.toLowerCase()}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="max years of experience"
              hint="based on what the posting says and entry-level titles. double check the actual posting."
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
              label="check every (minutes)"
              hint="per source, roughly. can run late if things are busy or a source is rate limiting."
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
              label="min salary (per year)"
              hint="matches if the top of the posted range hits this. no currency conversion. 0 = off."
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
            <Field label="currency">
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
              label="keywords (any)"
              hint="comma separated, at least one has to show up. blank = any swe role."
            >
              <input
                value={config.keywords}
                onChange={(e) => change("keywords", e.target.value)}
                placeholder="backend, full stack, python"
              />
            </Field>
            <Field label="skip if it mentions">
              <input
                value={config.excludeKeywords}
                onChange={(e) => change("excludeKeywords", e.target.value)}
                placeholder="security clearance"
              />
            </Field>
            <Field label="skip these companies">
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
            include ones where the experience level is unclear
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={config.includeUnknownSalary}
              onChange={(e) => change("includeUnknownSalary", e.target.checked)}
            />
            include ones with no usable salary info
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={config.autoWatch}
              onChange={(e) => change("autoWatch", e.target.checked)}
            />
            auto-add greenhouse, lever, and ashby boards from the github list
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={config.notifications}
              onChange={(e) => change("notifications", e.target.checked)}
            />
            notify me about new matches
          </label>
          <p className="small muted">
            mac notifications only work while the app is running (menu bar
            counts) and the mac is awake. in the browser version they just show
            up here.
          </p>
          {permission && (
            <div className="small" role="status">
              <p>{permissionMessage(permission)}</p>
              <p className="muted">
                last checked {timeText(permission.checkedAt)}
                {permission.requestedAt
                  ? ` · asked ${timeText(permission.requestedAt)}`
                  : ""}
                . macos settings are what actually count.
              </p>
            </div>
          )}
          <div className="button-row">
            <button className="button primary" disabled={busy}>
              save filters
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
                    return `${permissionMessage(result)}${["authorized", "provisional"].includes(result.status) ? " sent a test one, check focus mode if it doesn't show." : ""}`;
                  })
                }
              >
                <Bell size={15} /> test notification
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
                open notification settings
              </button>
            )}
          </div>
        </form>
      </details>
      <details className="settings-section discovery-settings">
        <summary>phone alerts (telegram)</summary>
        <p>
          run the worker on a cloud server to get telegram messages when the mac
          is asleep. each one has the role, company, location, and apply link.
          telegram is free, the server might not be.
        </p>
        <ol>
          <li>save the filters above, then download the worker config.</li>
          <li>make a telegram bot with @BotFather and start a chat with it.</li>
          <li>
            deploy the worker container with persistent storage and add the bot
            token + chat id as secrets.
          </li>
        </ol>
        <p className="small muted">
          the file is just filters and board urls, no gmail, keys, or
          applications. the worker and this app don't sync, so re-download and
          restart it after changing filters. a fresh worker starts quiet (no
          old-job alerts).
        </p>
        <a
          className="button secondary"
          href="/api/discovery/worker-config"
          download="fieldwork-worker.json"
        >
          download worker config
        </a>
        <p className="small muted">
          setup steps are in CLOUD-WORKER.md. downloading this doesn't deploy
          anything.
        </p>
      </details>
      <details className="settings-section discovery-settings">
        <summary>sources ({state.sources.length})</summary>
        <p className="small muted">
          simplify's swe github list plus the boards it links to. not every
          company, workday and other unsupported boards only come through
          github. new boards start quiet. max 500 boards.
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
          <Field label="company">
            <input
              value={boardName}
              onChange={(e) => setBoardName(e.target.value)}
              maxLength={200}
            />
          </Field>
          <Field label="board url">
            <input
              type="url"
              required
              value={boardUrl}
              onChange={(e) => setBoardUrl(e.target.value)}
              placeholder="https://jobs.ashbyhq.com/company"
            />
          </Field>
          <button className="button secondary" disabled={busy}>
            add board
          </button>
        </form>
        <Field label="search sources">
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
                    last checked {timeText(source.lastSuccess)} · next{" "}
                    {timeText(source.nextCheck)} · {source.count} postings
                  </p>
                  {source.error && <p className="error-text">{source.error}</p>}
                </div>
                <button
                  className="text-button"
                  disabled={busy}
                  aria-label={`${source.enabled ? "pause" : "resume"} ${source.name}`}
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
                  {source.enabled ? "pause" : "resume"}
                </button>
              </div>
            ))}
        </div>
      </details>
      <div className="discovery-toolbar">
        <Field label="search jobs">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="company, role, location…"
          />
        </Field>
        <Field label="show">
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="matches">matching</option>
            <option value="new">new</option>
            <option value="saved">saved</option>
            <option value="all">everything</option>
            <option value="dismissed">dismissed</option>
          </select>
        </Field>
        <span className="small muted">{shown.length} jobs</span>
      </div>
      <div className="discovery-jobs">
        {shown.slice(0, limit).map((job) => (
          <article className="discovery-job" key={job.id}>
            <div className="discovery-job-heading">
              <div>
                <div className="eyebrow">{job.company}</div>
                <h2>{job.title}</h2>
                <p>
                  {job.location || "location not listed"} ·{" "}
                  {job.workArrangement}
                </p>
              </div>
              <span
                className={`connection-pill ${!job.baseline && !job.seenAt ? "connected" : ""}`}
              >
                {job.applicationId
                  ? "applied"
                  : job.closed
                    ? "taken down"
                    : job.disposition === "saved"
                      ? "saved"
                      : job.baseline
                        ? "was already up"
                        : "new"}
              </span>
            </div>
            <p className="small">{job.salary || "no salary listed"}</p>
            <p className="small muted">
              found {timeText(job.firstSeenAt)}
              {job.publishedAt &&
                ` · posted ${timeText(job.publishedAt)} (could be a repost)`}
            </p>
            <p className="small muted">
              {job.entryEvidence.toLowerCase()} ·{" "}
              {Object.keys(job.sources)
                .map((id) => state.sources.find((s) => s.id === id)?.kind || id)
                .filter((v, i, a) => a.indexOf(v) === i)
                .join(" + ")}
            </p>
            {!job.matches && (
              <p className="small muted">
                doesn't match: {job.matchReasons.join("; ")}
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
                <ExternalLink size={15} /> open posting
              </a>
              {job.applicationId ? (
                <button
                  className="button secondary"
                  onClick={() => void onApplied(job.applicationId)}
                >
                  see my application
                </button>
              ) : (
                <button
                  className="button secondary"
                  onClick={() => {
                    setError("");
                    setConfirm(job);
                    setDate(localDate());
                  }}
                >
                  <Check size={15} /> i applied
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
                {job.disposition === "saved" ? "unsave" : "save"}
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
                details
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
                {job.disposition === "dismissed" ? "restore" : "dismiss"}
              </button>
            </div>
          </article>
        ))}
      </div>
      {!shown.length && (
        <div className="empty-state">
          <Search size={28} />
          <h2>nothing here</h2>
          <p>
            start watching, check the sources, or loosen the filters (there's a
            toggle for no-salary and unclear-experience jobs).
          </p>
        </div>
      )}
      {shown.length > limit && (
        <button
          className="button secondary"
          onClick={() => setLimit((n) => n + 40)}
        >
          show more
        </button>
      )}
      {confirm && (
        <Modal title="mark as applied" close={() => setConfirm(undefined)}>
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
            {error && <Notice error>{error}</Notice>}
            <p>
              did i actually apply to {confirm.title} at {confirm.company}? just
              opening the posting doesn't count.
            </p>
            <Field label="date applied">
              <input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <button className="button primary" disabled={busy}>
              yep, applied
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
              "no description from this source, open the posting for the full thing."}
          </pre>
          <a
            className="button primary"
            href={detail.url}
            target="_blank"
            rel="noreferrer"
          >
            open posting
          </a>
        </Modal>
      )}
    </>
  );
}
