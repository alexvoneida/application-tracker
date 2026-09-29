import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  ExternalLink,
  FileText,
  GitMerge,
  Mail,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
  Unplug,
} from "lucide-react";
import {
  applicationInput,
  eventTypes,
  eventLabel,
  localDate,
  stages,
  type Application,
  type EmailExtraction,
  type Settings,
  type Source,
} from "../shared/model";
import {
  api,
  dateText,
  safeLink,
  timeText,
  type Detail,
  type State,
} from "./api";
import { Badge, Busy, Empty, Field, Modal, Notice } from "./components";
import { DesktopSettings } from "./DesktopSettings";

type Draft = ReturnType<typeof applicationInput.parse>;
export function AddApplication({
  close,
  saved,
}: {
  close: () => void;
  saved: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(
    applicationInput.parse({ appliedAt: localDate() }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const app = await api<Application>("/applications", "POST", draft);
      await saved(app.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Add an application" close={close}>
      <form onSubmit={submit}>
        <p className="modal-intro">
          A link is enough to start. Add any details you already know.
        </p>
        {error && <Notice error>{error}</Notice>}
        <div className="form-grid">
          <Field
            label="Job link"
            full
            hint="We’ll try to save the job description and fill in the details."
          >
            <input
              autoFocus
              data-autofocus
              type="url"
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              placeholder="https://company.com/careers/role"
            />
          </Field>
          <Field label="Company">
            <input
              value={draft.company}
              onChange={(e) => setDraft({ ...draft, company: e.target.value })}
              placeholder="Company name"
            />
          </Field>
          <Field label="Job title">
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="Software Engineer"
            />
          </Field>
          <Field label="Application date">
            <input
              type="date"
              value={draft.appliedAt}
              onChange={(e) =>
                setDraft({ ...draft, appliedAt: e.target.value })
              }
            />
          </Field>
          <Field label="Stage">
            <select
              value={draft.stage}
              onChange={(e) =>
                setDraft({ ...draft, stage: e.target.value as Draft["stage"] })
              }
            >
              {stages.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Job description (optional)" full>
            <textarea
              rows={4}
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
              placeholder="Paste the description if the job page is unavailable…"
            />
          </Field>
          <label className="check-label full">
            <input
              type="checkbox"
              checked={draft.reapply}
              onChange={(e) =>
                setDraft({ ...draft, reapply: e.target.checked })
              }
            />
            This is a new application to a previously tracked posting
          </label>
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <Busy text="Adding…" />
            ) : (
              <>
                <Plus size={16} />
                Add application
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function keepUnsavedEdits(
  draft: Draft,
  saved: Draft,
  next: Application,
): Draft {
  const fresh = applicationInput.parse(next);
  for (const key of Object.keys(draft) as (keyof Draft)[])
    if (draft[key] !== saved[key]) (fresh as any)[key] = draft[key];
  return fresh;
}
export function ApplicationPanel({
  id,
  state,
  close,
  changed,
}: {
  id: string;
  state: State;
  close: () => void;
  changed: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<Detail>();
  const [draft, setDraft] = useState<Draft>();
  // Latest server copy, read after awaits where the render's `detail` is stale.
  const serverCopy = useRef<Application | undefined>(undefined);
  const [tab, setTab] = useState<"details" | "timeline" | "description">(
    "details",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [merge, setMerge] = useState(false);
  const [target, setTarget] = useState("");
  const [snapshot, setSnapshot] = useState("");
  // `saved` holds the fields just written, which should show the server's value.
  async function load(saved: Partial<Draft> = {}) {
    const data = await api<Detail>(`/applications/${id}`);
    const baseline = serverCopy.current;
    serverCopy.current = data.application;
    setDetail(data);
    setDraft((current) =>
      current && baseline
        ? keepUnsavedEdits(
            current,
            { ...applicationInput.parse(baseline), ...saved },
            data.application,
          )
        : applicationInput.parse(data.application),
    );
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [id]);
  // Poll background enrichment without replacing a user's unsaved edits.
  useEffect(() => {
    if (!detail || detail.application.enrichment !== "pending") return;
    const timer = setInterval(() => {
      void api<Detail>(`/applications/${id}`)
        .then((next) => {
          serverCopy.current = next.application;
          setDetail(next);
          setDraft((current) =>
            current
              ? keepUnsavedEdits(
                  current,
                  applicationInput.parse(detail.application),
                  next.application,
                )
              : applicationInput.parse(next.application),
          );
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [detail, id]);
  async function action(
    fn: () => Promise<unknown>,
    message = "",
    saved: Partial<Draft> = {},
  ) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await changed();
      await load(saved);
      setMessage(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft || !detail) return;
    const baseline = applicationInput.parse(detail.application);
    // The description has its own form ("Save snapshot") on another tab.
    const patch: Partial<Draft> = Object.fromEntries(
      Object.entries(draft).filter(
        ([key, value]) =>
          key !== "description" && value !== baseline[key as keyof Draft],
      ),
    );
    await action(
      () => api(`/applications/${id}`, "PATCH", patch),
      "Changes saved. Your edits take priority over future extraction.",
      patch,
    );
  }
  async function saveSnapshot(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const patch = { description: draft.description };
    await action(
      () => api(`/applications/${id}`, "PATCH", patch),
      "Description snapshot saved.",
      patch,
    );
  }
  const set = (key: keyof Draft, value: string) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  const app = detail?.application;
  const selectedSnapshot =
    detail?.snapshots.find((s) => s.id === snapshot) || detail?.snapshots[0];
  return (
    <Modal title={app?.company || "Application details"} close={close} wide>
      {error && <Notice error>{error}</Notice>}
      {!detail || !draft || !app ? (
        <div className="panel-padding">
          <Busy text="Loading application…" />
        </div>
      ) : (
        <>
          <div className="detail-heading">
            <div>
              <h2>{app.title || "Job title pending"}</h2>
              <div className="detail-meta">
                <Badge stage={app.stage} />
                <span>{app.location || "Location not specified"}</span>
                {safeLink(app.url) && (
                  <a
                    className="text-button"
                    href={safeLink(app.url)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Original posting
                    <ExternalLink size={13} />
                  </a>
                )}
              </div>
            </div>
          </div>
          <div
            className="tabs"
            role="tablist"
            aria-label="Application sections"
          >
            {(["details", "timeline", "description"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={tab === t ? "active" : ""}
              >
                {t === "details"
                  ? "Role details"
                  : t === "timeline"
                    ? `Timeline · ${detail.events.length}`
                    : "Saved description"}
              </button>
            ))}
          </div>
          {message && <Notice>{message}</Notice>}
          {app.enrichment === "pending" && (
            <div className="inline-note">
              <Busy text="Extracting job details in the background…" />
            </div>
          )}
          {app.enrichmentError && (
            <div className="inline-note">
              <Notice error>
                {app.enrichmentError}{" "}
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      api(`/applications/${id}/enrich`, "POST", {}),
                    )
                  }
                >
                  Retry extraction
                </button>
              </Notice>
            </div>
          )}
          {tab === "details" && (
            <form onSubmit={save}>
              <div className="form-grid">
                <Field label="Company">
                  <input
                    value={draft.company}
                    onChange={(e) => set("company", e.target.value)}
                  />
                </Field>
                <Field label="Job title">
                  <input
                    value={draft.title}
                    onChange={(e) => set("title", e.target.value)}
                  />
                </Field>
                <Field label="Stage">
                  <select
                    value={draft.stage}
                    onChange={(e) => set("stage", e.target.value)}
                  >
                    {stages.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Application date"
                  hint={`Source: ${app.dateBasis}. Clear the date if unknown.`}
                >
                  <input
                    type="date"
                    value={draft.appliedAt}
                    onChange={(e) => set("appliedAt", e.target.value)}
                  />
                </Field>
                <Field label="Location">
                  <input
                    value={draft.location}
                    onChange={(e) => set("location", e.target.value)}
                    placeholder="Unknown"
                  />
                </Field>
                <Field label="Work arrangement">
                  <select
                    value={draft.workArrangement}
                    onChange={(e) => set("workArrangement", e.target.value)}
                  >
                    {["Unknown", "Remote", "Hybrid", "On-site"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Compensation as posted" full>
                  <input
                    value={draft.salary}
                    onChange={(e) => set("salary", e.target.value)}
                    placeholder="e.g. USD 140,000–175,000 per year (base)"
                  />
                </Field>
                <Field label="Currency">
                  <input
                    value={draft.currency}
                    onChange={(e) => set("currency", e.target.value)}
                    placeholder="USD"
                  />
                </Field>
                <Field label="Compensation period">
                  <input
                    value={draft.salaryPeriod}
                    onChange={(e) => set("salaryPeriod", e.target.value)}
                    placeholder="Year, hour…"
                  />
                </Field>
                <Field label="Employment type">
                  <input
                    value={draft.employmentType}
                    onChange={(e) => set("employmentType", e.target.value)}
                    placeholder="Full-time"
                  />
                </Field>
                <Field label="Seniority">
                  <input
                    value={draft.seniority}
                    onChange={(e) => set("seniority", e.target.value)}
                    placeholder="Not specified"
                  />
                </Field>
                <Field label="Job / requisition ID">
                  <input
                    value={draft.postingId}
                    onChange={(e) => set("postingId", e.target.value)}
                  />
                </Field>
                <Field label="Job link">
                  <input
                    type="url"
                    value={draft.url}
                    onChange={(e) => set("url", e.target.value)}
                  />
                </Field>
                <Field label="Key responsibilities" full>
                  <textarea
                    rows={4}
                    value={draft.responsibilities}
                    onChange={(e) => set("responsibilities", e.target.value)}
                    placeholder="Responsibilities will appear here after extraction."
                  />
                </Field>
                <Field label="Requirements" full>
                  <textarea
                    rows={3}
                    value={draft.requirements}
                    onChange={(e) => set("requirements", e.target.value)}
                  />
                </Field>
                <Field label="Technologies" full>
                  <input
                    value={draft.technologies}
                    onChange={(e) => set("technologies", e.target.value)}
                  />
                </Field>
                <Field label="Your notes" full>
                  <textarea
                    rows={3}
                    value={draft.notes}
                    onChange={(e) => set("notes", e.target.value)}
                    placeholder="Referral, recruiter contact, things to remember…"
                  />
                </Field>
              </div>
              <div className="modal-footer">
                <span className="muted small">
                  Captured {dateText(app.createdAt)}
                </span>
                <button className="button primary" disabled={busy}>
                  {busy ? (
                    <Busy text="Saving…" />
                  ) : (
                    <>
                      <Save size={15} />
                      Save changes
                    </>
                  )}
                </button>
              </div>
            </form>
          )}
          {tab === "timeline" && (
            <div className="timeline">
              {detail.events.length ? (
                detail.events.map((event) => {
                  const source = detail.sources.find(
                    (s) => s.id === event.sourceId,
                  );
                  return (
                    <article key={event.id} className="timeline-event">
                      <span className="timeline-dot" />
                      <div className="timeline-date">
                        {event.timeBasis.includes("time unknown")
                          ? dateText(event.occurredAt)
                          : timeText(event.occurredAt)}
                        <small>{event.timeBasis}</small>
                      </div>
                      <h3>{event.label}</h3>
                      {source && (
                        <>
                          <p className="muted">{source.subject}</p>
                          <details>
                            <summary>View source evidence</summary>
                            <pre className="source-text">{source.excerpt}</pre>
                            <a
                              href={`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(source.account)}#all/${encodeURIComponent(source.messageId)}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-button"
                            >
                              Open in Gmail
                              <ExternalLink size={13} />
                            </a>
                            <p className="small muted">
                              Classification:{" "}
                              {Math.round(event.confidence * 100)}% · match:{" "}
                              {Math.round(event.matchConfidence * 100)}%
                              (heuristic scores, not calibrated probabilities)
                            </p>
                          </details>
                        </>
                      )}
                    </article>
                  );
                })
              ) : (
                <Empty title="A clean slate">
                  Hiring updates and status changes will appear here.
                </Empty>
              )}
            </div>
          )}
          {tab === "description" && (
            <div className="panel-padding">
              <div className="snapshot-toolbar">
                <h3>Preserved snapshots</h3>
                <button
                  className="button secondary"
                  disabled={busy || !app.url}
                  onClick={() =>
                    void action(() =>
                      api(`/applications/${id}/enrich`, "POST", {}),
                    )
                  }
                >
                  <RefreshCw size={15} />
                  Refresh from link
                </button>
              </div>
              {detail.snapshots.length > 0 && (
                <>
                  <label className="field">
                    <span>Snapshot</span>
                    <select
                      value={selectedSnapshot?.id || ""}
                      onChange={(e) => setSnapshot(e.target.value)}
                    >
                      {detail.snapshots.map((s) => (
                        <option value={s.id} key={s.id}>
                          {timeText(s.capturedAt)} ·{" "}
                          {s.sourceKind === "pasted"
                            ? "Pasted text"
                            : "Job posting"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <pre className="description-text">
                    {selectedSnapshot?.text}
                  </pre>
                </>
              )}
              <form onSubmit={saveSnapshot}>
                <Field
                  label="Save a new description"
                  hint="Earlier snapshots are preserved."
                >
                  <textarea
                    rows={7}
                    value={draft.description}
                    onChange={(e) => set("description", e.target.value)}
                    placeholder="Paste the full description here…"
                  />
                </Field>
                <button
                  className="button primary"
                  disabled={busy || !draft.description.trim()}
                >
                  <FileText size={15} />
                  Save snapshot
                </button>
              </form>
            </div>
          )}
          <div className="detail-tools">
            <button
              className="text-button"
              onClick={() => {
                setMerge(!merge);
                setConfirmDelete(false);
              }}
            >
              <GitMerge size={15} />
              Merge duplicate
            </button>
            <button
              className="text-button danger"
              onClick={() => {
                setConfirmDelete(!confirmDelete);
                setMerge(false);
              }}
            >
              <Trash2 size={15} />
              Delete application
            </button>
          </div>
          {merge && (
            <div className="confirmation">
              <h3>Merge this record into another application</h3>
              <p>
                Keep the selected record’s status and existing details. Move
                this record’s timeline, snapshots, actions, and email evidence
                into it. Empty fields will be filled from this record. A
                pre-merge backup is retained.
              </p>
              <select
                aria-label="Merge target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Choose the record to keep</option>
                {state.applications
                  .filter((a) => a.id !== id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.company || "Unknown company"} — {a.title || "Untitled"}{" "}
                      · {a.stage}
                    </option>
                  ))}
              </select>
              {target && (
                <p className="merge-preview">
                  {app.company || "This record"} / {app.title || "Untitled"} →{" "}
                  {state.applications.find((a) => a.id === target)?.company} /{" "}
                  {state.applications.find((a) => a.id === target)?.title}. The
                  destination’s status stays{" "}
                  {state.applications.find((a) => a.id === target)?.stage}.
                </p>
              )}
              <button
                disabled={!target || busy}
                className="button primary"
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api("/merge", "POST", { from: id, into: target });
                    await changed();
                    close();
                  } catch (e) {
                    setError((e as Error).message);
                    setBusy(false);
                  }
                }}
              >
                Confirm merge
              </button>
            </div>
          )}
          {confirmDelete && (
            <div className="confirmation">
              <h3>Delete this application and its stored evidence?</h3>
              <p>
                Its snapshots, timeline, and local email excerpts will be
                removed. Gmail and your text file stay intact. Ordinary sync
                will not recreate this record. Export a backup first if you want
                to recover it.
              </p>
              <div className="button-row">
                <a className="button secondary" href="/api/backup" download>
                  Download backup
                </a>
                <button
                  disabled={busy}
                  className="button danger-solid"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api(`/applications/${id}`, "DELETE", {});
                      await changed();
                      close();
                    } catch (e) {
                      setError((e as Error).message);
                      setBusy(false);
                    }
                  }}
                >
                  Delete permanently
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// Must equal the total length of the review-collapse animation in styles.css.
const reviewExitMilliseconds = 500;
type ReviewExit = { source: Source; label: string; finished: boolean };

export function ReviewPanel({
  state,
  refresh,
  open,
}: {
  state: State;
  refresh: () => Promise<void>;
  open: (id: string) => void;
}) {
  const [error, setError] = useState("");
  const [exits, setExits] = useState<Record<string, ReviewExit>>({});
  const [announcement, setAnnouncement] = useState("");
  const backfill = state.backfill;
  const pending = state.review.filter((source) => !exits[source.id]);
  const sources = [
    ...pending,
    ...Object.values(exits)
      .filter((exit) => !exit.finished)
      .map((exit) => exit.source),
  ].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  useEffect(() => {
    setExits((current) => {
      const stale = Object.keys(current).filter(
        (id) =>
          current[id].finished &&
          !state.review.some((source) => source.id === id),
      );
      if (!stale.length) return current;
      const next = { ...current };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [state.review]);
  function exit(source: Source, label: string) {
    setAnnouncement(label);
    setExits((current) => ({
      ...current,
      [source.id]: { source, label, finished: false },
    }));
    setTimeout(() => {
      setExits((current) => ({
        ...current,
        [source.id]: { ...current[source.id], finished: true },
      }));
      void refresh().catch((e) => setError((e as Error).message));
    }, reviewExitMilliseconds);
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">A SECOND LOOK</div>
          <h1>Make the right connections.</h1>
          <p>
            Confirm the event and role before an uncertain update changes your
            search.
          </p>
        </div>
        <span className="review-total">{pending.length} pending</span>
      </div>
      {error && <Notice error>{error}</Notice>}
      {backfill.error && <Notice error>{backfill.error}</Notice>}
      <p className="sr-only" role="status">
        {announcement}
      </p>
      {!!pending.length && (
        <div className="backfill">
          <div className="backfill-row">
            <span>
              {backfill.running
                ? `Re-extracting ${backfill.processed} of ${backfill.total}${backfill.failed ? ` · ${backfill.failed} failed` : ""}`
                : state.settings.aiEnabled
                  ? `Re-read every message already in Review with ${state.settings.aiModel}, filling in company, role, event type and dates.`
                  : "Turn on AI extraction in Settings to re-read these messages automatically."}
            </span>
            <button
              className="button secondary"
              type="button"
              disabled={backfill.running || !state.settings.aiEnabled}
              onClick={() =>
                void (async () => {
                  setError("");
                  try {
                    await api("/ai/backfill", "POST", {});
                    await refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                })()
              }
            >
              {backfill.running
                ? "Running…"
                : `Run AI on all ${pending.length}`}
            </button>
          </div>
          {backfill.running && (
            <div
              className="backfill-track"
              role="progressbar"
              aria-valuenow={backfill.processed}
              aria-valuemin={0}
              aria-valuemax={backfill.total}
            >
              <div
                className="backfill-fill"
                style={{
                  width: `${backfill.total ? (backfill.processed / backfill.total) * 100 : 0}%`,
                }}
              />
            </div>
          )}
        </div>
      )}
      {!sources.length ? (
        <Empty title="You’re all caught up.">
          Messages needing a second look will appear here after your next Gmail
          sync.
        </Empty>
      ) : (
        <div className="review-list">
          {sources.map((source) => (
            <ReviewItem
              key={source.id}
              source={source}
              state={state}
              refresh={refresh}
              open={open}
              leaving={exits[source.id]?.label}
              onExit={(label) => exit(source, label)}
            />
          ))}
        </div>
      )}
    </>
  );
}
function ReviewItem({
  source,
  state,
  refresh,
  open,
  leaving,
  onExit,
}: {
  source: Source;
  state: State;
  refresh: () => Promise<void>;
  open: (id: string) => void;
  leaving?: string;
  onExit: (label: string) => void;
}) {
  const [data, setData] = useState(source.extraction);
  const [target, setTarget] = useState(source.candidates[0] || "");
  const [createdApplication, setCreatedApplication] = useState<Application>();
  const [actionId, setActionId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const extractionKey = JSON.stringify(source.extraction);
  const applications =
    createdApplication &&
    !state.applications.some(
      (application) => application.id === createdApplication.id,
    )
      ? [...state.applications, createdApplication]
      : state.applications;
  useEffect(() => {
    setData(source.extraction);
  }, [extractionKey]);
  const actions = state.actions.filter(
    (a) =>
      a.applicationId === target &&
      a.kind === "interview" &&
      a.status === "pending",
  );
  async function decide(action: string) {
    setBusy(true);
    setError("");
    try {
      if (action === "create") {
        const application = await api<Application>("/applications", "POST", {
          company: data.company,
          title: data.title,
          postingId: data.postingId,
          url: data.url,
          stage: "Unknown",
        });
        // Keep the returned option available even if refreshing the list fails.
        setCreatedApplication(application);
        setTarget(application.id);
        setActionId("");
      } else {
        await api(`/review/${encodeURIComponent(source.id)}`, "POST", {
          action,
          applicationId: target,
          actionId,
          extraction: data,
        });
        if (action === "dismiss") return onExit("Dismissed");
        if (action === "attach") {
          const application = applications.find((a) => a.id === target);
          return onExit(
            `Attached to ${application?.company || "Unknown company"} — ${application?.title || "Untitled"}`,
          );
        }
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`review-slot${leaving ? " leaving" : ""}`}>
      <article className="review-item">
        <div className="review-body" inert={!!leaving}>
          <div className="review-heading">
            <div className="review-icon">
              <Mail size={19} />
            </div>
            <div>
              <h3>{source.subject || "(No subject)"}</h3>
              <p>
                {source.from} · {dateText(source.receivedAt)}
              </p>
            </div>
            <span
              className={`pill ${source.state === "failed" ? "pill-error" : ""}`}
            >
              {source.state === "failed" ? "Extraction failed" : "Needs review"}
            </span>
          </div>
          <div className="review-content">
            <Notice error={source.state === "failed"}>{source.reason}</Notice>
            {error && <Notice error>{error}</Notice>}
            <details>
              <summary>Read email excerpt</summary>
              <pre className="source-text">{source.excerpt}</pre>
            </details>
            <div className="form-grid compact">
              <Field label="Event">
                <select
                  value={data.eventType || ""}
                  onChange={(e) =>
                    setData({
                      ...data,
                      eventType: (e.target.value ||
                        null) as EmailExtraction["eventType"],
                    })
                  }
                >
                  <option value="">Choose an event</option>
                  {eventTypes
                    .filter((t) => t !== "manual_status")
                    .map((t) => (
                      <option key={t} value={t}>
                        {eventLabel(t)}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Match to application">
                <select
                  value={target}
                  onChange={(e) => {
                    setTarget(e.target.value);
                    setActionId("");
                  }}
                >
                  <option value="">Choose an existing application</option>
                  {[...applications]
                    .sort(
                      (a, b) =>
                        Number(source.candidates.includes(b.id)) -
                        Number(source.candidates.includes(a.id)),
                    )
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.company || "Unknown company"} —{" "}
                        {a.title || "Untitled"}
                        {source.candidates.includes(a.id) ? " (suggested)" : ""}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Company (for a new record)">
                <input
                  value={data.company}
                  onChange={(e) =>
                    setData({ ...data, company: e.target.value })
                  }
                />
              </Field>
              <Field label="Title (for a new record)">
                <input
                  value={data.title}
                  onChange={(e) => setData({ ...data, title: e.target.value })}
                />
              </Field>
              <Field label="Job / requisition ID">
                <input
                  value={data.postingId}
                  onChange={(e) =>
                    setData({ ...data, postingId: e.target.value })
                  }
                />
              </Field>
              <Field label="Job link">
                <input
                  type="url"
                  value={data.url}
                  onChange={(e) => setData({ ...data, url: e.target.value })}
                />
              </Field>
              <Field label="Deadline / scheduled time">
                <input
                  value={data.dueAt}
                  onChange={(e) => setData({ ...data, dueAt: e.target.value })}
                  placeholder="Leave blank if unknown"
                />
              </Field>
              <Field label="Time zone">
                <input
                  value={data.timeZone}
                  onChange={(e) =>
                    setData({ ...data, timeZone: e.target.value })
                  }
                  placeholder="Confirm from the message"
                />
              </Field>
              {["interview_rescheduled", "interview_canceled"].includes(
                data.eventType || "",
              ) &&
                actions.length > 1 && (
                  <Field label="Affected interview" full>
                    <select
                      value={actionId}
                      onChange={(e) => setActionId(e.target.value)}
                    >
                      <option value="">Choose the affected interview</option>
                      {actions.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.title} · {a.dueAt || "Date unknown"}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
            </div>
            {target && (
              <div className="inline-help">
                <button className="text-button" onClick={() => open(target)}>
                  Inspect selected application
                  <ExternalLink size={13} />
                </button>
                <span>
                  Closed statuses and manual corrections are preserved. Reopen a
                  role in its details if needed.
                </span>
              </div>
            )}
            <div className="review-footer">
              <button
                className="text-button muted"
                disabled={busy}
                onClick={() => void decide("dismiss")}
              >
                Dismiss unrelated email
              </button>
              <div className="button-row">
                {source.state === "failed" && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void decide("retry")}
                  >
                    <RefreshCw size={14} />
                    Retry extraction
                  </button>
                )}
                <button
                  className="button secondary"
                  disabled={
                    busy ||
                    !!createdApplication ||
                    !data.eventType ||
                    (!data.company && !data.title && !data.url)
                  }
                  onClick={() => void decide("create")}
                >
                  {createdApplication
                    ? "Application created"
                    : "Create new application"}
                </button>
                <button
                  className="button primary"
                  disabled={busy || !target || !data.eventType}
                  onClick={() => void decide("attach")}
                >
                  {busy ? (
                    <Busy />
                  ) : (
                    <>
                      <Check size={15} />
                      Attach event
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
        {leaving && (
          <div className="review-confirmation" aria-hidden="true">
            <Check size={18} />
            {leaving}
          </div>
        )}
      </article>
    </div>
  );
}

export function SettingsPanel({
  state,
  refresh,
}: {
  state: State;
  refresh: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings>(state.settings);
  const [secrets, setSecrets] = useState({
    googleClientId: "",
    googleClientSecret: "",
    aiKey: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [backup, setBackup] = useState<unknown>();
  const change = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings({ ...settings, [key]: value });
  const usingClaudeCode = settings.aiProvider === "claude-code";
  async function run<T>(
    fn: () => Promise<T>,
    success: string | ((result: T) => string) = "",
  ) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await fn();
      await refresh();
      setMessage(typeof success === "function" ? success(result) : success);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    await run(
      async () => {
        const saved = await api<{ resyncing: boolean }>("/settings", "POST", {
          settings,
          secrets,
        });
        setSecrets({ googleClientId: "", googleClientSecret: "", aiKey: "" });
        return saved;
      },
      (saved) =>
        saved.resyncing
          ? "Settings saved. Re-checking Review against the new search…"
          : "Settings saved.",
    );
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR WORKSPACE, YOUR RULES</div>
          <h1>A few things to connect.</h1>
          <p>Configure this instance with your own accounts and keys.</p>
        </div>
      </div>
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      <form onSubmit={save} className="settings-form">
        <section className="settings-section">
          <div className="settings-title">
            <FileText size={21} />
            <div>
              <h2>Application text file</h2>
              <p>Add a link after applying. We’ll take it from there.</p>
            </div>
          </div>
          <Field
            label="Absolute path to your text file"
            hint="Create the file yourself, then choose it or paste its full path. Scanned every 2 seconds while Fieldwork is running."
          >
            <input
              value={settings.linksFile}
              onChange={(e) => change("linksFile", e.target.value)}
              placeholder="/Users/you/Documents/applications.txt"
            />
          </Field>
          {window.fieldworkDesktop && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const path = await window.fieldworkDesktop!.chooseLinksFile();
                  if (path) change("linksFile", path);
                })
              }
            >
              Choose text file…
            </button>
          )}
          <pre className="code-example">
            {
              "# One application per line\nhttps://company.com/careers/software-engineer\n2026-09-20 | https://another-company.com/jobs/123"
            }
          </pre>
          <p className="small muted">
            A bare link means applied today. Historical entries need a date.
            Removing a line does not delete its record.
          </p>
          <div className="connection-line">
            <span>Last scan: {timeText(state.sync.fileLastScan)}</span>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void run(() => api("/import/scan", "POST", {}), "File scanned.")
              }
            >
              <RefreshCw size={14} />
              Scan saved path
            </button>
          </div>
          {state.sync.fileErrors.map((e, i) => (
            <Notice error key={i}>
              {e}
            </Notice>
          ))}
        </section>
        <section className="settings-section">
          <div className="settings-title">
            <Mail size={21} />
            <div>
              <h2>Gmail</h2>
              <p>Read hiring updates without changing your mailbox.</p>
            </div>
            <span
              className={`connection-pill ${state.connection.connected ? "connected" : ""}`}
            >
              {state.connection.connected ? "Connected" : "Not connected"}
            </span>
          </div>
          <div className="form-grid compact">
            <Field
              label="Google Desktop OAuth client ID"
              hint={
                state.connection.googleConfigured
                  ? "Configured. Leave blank to keep the saved value."
                  : "Create your own client in Google Cloud."
              }
            >
              <input
                value={secrets.googleClientId}
                onChange={(e) =>
                  setSecrets({ ...secrets, googleClientId: e.target.value })
                }
                autoComplete="off"
                placeholder="…apps.googleusercontent.com"
              />
            </Field>
            <Field label="Google OAuth client secret">
              <input
                type="password"
                value={secrets.googleClientSecret}
                onChange={(e) =>
                  setSecrets({ ...secrets, googleClientSecret: e.target.value })
                }
                autoComplete="new-password"
                placeholder="Leave blank to keep saved secret"
              />
            </Field>
            <Field label="Import emails since">
              <input
                type="date"
                required
                value={settings.importAfter}
                onChange={(e) => change("importAfter", e.target.value)}
              />
            </Field>
            <Field label="Sync interval (minutes)">
              <input
                type="number"
                min="1"
                max="1440"
                value={settings.syncMinutes}
                onChange={(e) => change("syncMinutes", Number(e.target.value))}
              />
            </Field>
            <Field
              label="Candidate email search"
              full
              hint="Gmail search syntax. Archived mail is included; spam and trash are excluded. Changing it re-checks Review on save and dismisses messages that no longer match."
            >
              <textarea
                rows={2}
                value={settings.gmailQuery}
                onChange={(e) => change("gmailQuery", e.target.value)}
              />
              <button
                type="button"
                className="button secondary"
                disabled={
                  busy || state.sync.running || !state.connection.connected
                }
                onClick={() =>
                  void run(async () => {
                    await api("/settings", "POST", { settings, secrets });
                    setSecrets({
                      googleClientId: "",
                      googleClientSecret: "",
                      aiKey: "",
                    });
                    await api("/gmail/sync", "POST", {
                      full: true,
                      prune: true,
                    });
                  }, "Re-checking Review against this search…")
                }
              >
                Save and re-check Review now
              </button>
            </Field>
          </div>
          <details className="setup-guide">
            <summary>How to connect your own Gmail</summary>
            <ol>
              <li>
                Create a project in{" "}
                <a
                  href="https://console.cloud.google.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Google Cloud
                </a>{" "}
                and enable the Gmail API.
              </li>
              <li>
                Configure the OAuth consent screen for personal testing. Add
                your Gmail address as a test user and request the{" "}
                <code>gmail.readonly</code> scope.
              </li>
              <li>
                Create an OAuth client of type <strong>Desktop app</strong>.
                Enter its client ID and secret above and save settings.
              </li>
              <li>
                Click Connect Gmail and authorize in your normal browser. Each
                friend configures their own project and account.
              </li>
            </ol>
            <p>
              Gmail read-only permission covers the mailbox; the application
              filters hiring messages. Testing-mode authorization commonly
              expires after seven days, so you may need to reconnect.
            </p>
            <p>
              <a
                href="https://developers.google.com/identity/protocols/oauth2/native-app"
                target="_blank"
                rel="noreferrer"
              >
                Google’s Desktop OAuth guide
              </a>
            </p>
          </details>
          <div className="connection-line">
            <span>
              {state.connection.account ||
                "Save credentials before connecting."}
            </span>
            <div className="button-row">
              <button
                type="button"
                disabled={busy || !state.connection.googleConfigured}
                className="button secondary"
                onClick={() =>
                  void run(async () => {
                    const response = await api<{ url: string }>(
                      "/gmail/connect",
                      "POST",
                      {},
                    );
                    if (window.fieldworkDesktop)
                      await window.fieldworkDesktop.openGoogleAuth(
                        response.url,
                      );
                    else window.location.assign(response.url);
                  })
                }
              >
                {state.connection.connected
                  ? "Reconnect Gmail"
                  : "Connect Gmail"}
                <ArrowUpRight size={14} />
              </button>
              {state.connection.connected && (
                <button
                  type="button"
                  className="text-button danger"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => api("/gmail/disconnect", "POST", {}),
                      "Gmail disconnected. Your tracked applications are preserved.",
                    )
                  }
                >
                  <Unplug size={14} />
                  Disconnect
                </button>
              )}
            </div>
          </div>
          <div className="connection-line">
            <span>
              {state.sync.running
                ? `${state.sync.processed} / ${state.sync.discovered} messages checked`
                : `Last successful sync: ${timeText(state.sync.lastSuccess)}`}
            </span>
            <button
              className="text-button"
              type="button"
              disabled={
                busy || state.sync.running || !state.connection.connected
              }
              onClick={() =>
                void run(
                  () => api("/gmail/sync", "POST", { full: true }),
                  "Historical sync started. Previously processed messages will not be duplicated.",
                )
              }
            >
              Rescan saved date range
            </button>
          </div>
          {state.sync.error && <Notice error>{state.sync.error}</Notice>}
        </section>
        <section className="settings-section">
          <div className="settings-title">
            <Settings2 size={21} />
            <div>
              <h2>AI extraction</h2>
              <p>
                Reads each hiring email and job page to pull out the company,
                role, event type and dates, so fewer messages need a manual
                second look. Without it, Fieldwork falls back to keyword rules.
              </p>
            </div>
            <span
              className={`connection-pill ${usingClaudeCode || state.connection.aiConfigured ? "connected" : ""}`}
            >
              {usingClaudeCode
                ? "Claude Code"
                : state.connection.aiConfigured
                  ? "Key configured"
                  : "No key"}
            </span>
          </div>
          <label className="check-label consent">
            <input
              type="checkbox"
              checked={settings.aiEnabled}
              onChange={(e) => change("aiEnabled", e.target.checked)}
            />
            <span>
              Enable AI extraction
              <small>
                I allow relevant hiring-email excerpts, subjects, dates, and job
                descriptions to be sent to my configured provider. Full mailbox
                contents and attachments are not sent.
              </small>
            </span>
          </label>
          <div className="form-grid compact">
            <Field
              label="Provider"
              full
              hint="Claude Code runs your locally installed, already signed-in CLI. Nothing leaves this machine except what the CLI sends, and no API key is billed."
            >
              <select
                value={settings.aiProvider}
                onChange={(e) => {
                  const provider = e.target.value as Settings["aiProvider"];
                  setSettings({
                    ...settings,
                    aiProvider: provider,
                    aiModel:
                      provider === "claude-code"
                        ? "claude-haiku-4-5"
                        : "gpt-4.1-mini",
                  });
                }}
              >
                <option value="claude-code">Claude Code (local CLI)</option>
                <option value="openai">OpenAI-compatible API key</option>
              </select>
            </Field>
            {!usingClaudeCode && (
              <Field
                label="API key"
                hint={
                  state.connection.aiConfigured
                    ? "Leave blank to keep the saved key."
                    : "You are billed directly by your provider."
                }
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  value={secrets.aiKey}
                  onChange={(e) =>
                    setSecrets({ ...secrets, aiKey: e.target.value })
                  }
                  placeholder="Your personal API key"
                />
              </Field>
            )}
            <Field
              label="Model"
              hint={
                usingClaudeCode
                  ? "A small model keeps each extraction inside your subscription's usage window."
                  : undefined
              }
            >
              <input
                required
                value={settings.aiModel}
                onChange={(e) => change("aiModel", e.target.value)}
              />
            </Field>
            {usingClaudeCode ? (
              <Field
                label="Claude Code path (optional)"
                full
                hint="Leave blank to find `claude` on your PATH. A packaged app launched from Finder often has a minimal PATH, so set the absolute path if extraction reports the CLI is missing."
              >
                <input
                  value={settings.claudeCodePath}
                  onChange={(e) => change("claudeCodePath", e.target.value)}
                  placeholder="/Users/you/.local/bin/claude"
                />
              </Field>
            ) : (
              <Field
                label="OpenAI-compatible HTTPS API base URL"
                full
                hint="Default: OpenAI. Changing this destination changes who receives your extraction data."
              >
                <input
                  type="url"
                  required
                  value={settings.aiBaseUrl}
                  onChange={(e) => change("aiBaseUrl", e.target.value)}
                />
              </Field>
            )}
          </div>
          <label className="check-label consent">
            <input
              type="checkbox"
              checked={settings.autoApplyAI}
              onChange={(e) => change("autoApplyAI", e.target.checked)}
            />
            <span>
              Allow automatic AI updates for strong role matches
              <small>
                Off by default. AI confidence scores are not calibrated on your
                emails. With this off, AI results go to Review; explicit
                rule-based events may still attach to exact role or unique
                thread matches.
              </small>
            </span>
          </label>
          {state.connection.aiUsage && (
            <p className="small muted">
              Last extraction: {timeText(state.connection.aiUsage.at)} ·{" "}
              {state.connection.aiUsage.model} ·{" "}
              {state.connection.aiUsage.tokens ?? "Unknown"} tokens
            </p>
          )}
          <p className="small muted">
            {window.fieldworkDesktop
              ? "Keys and tokens are encrypted locally with an encryption key protected by macOS Keychain. Keys are excluded from exports."
              : "Keys are stored encrypted in this instance’s private data directory. The local encryption key is on the same computer; protect your OS account and disk. Keys are excluded from exports."}
          </p>
        </section>
        <div className="settings-save">
          <span className="muted small">
            Settings apply only to this computer.
          </span>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <Busy text="Saving…" />
            ) : (
              <>
                <Save size={16} />
                Save settings
              </>
            )}
          </button>
        </div>
      </form>
      <DesktopSettings />
      <section className="settings-section portability">
        <div className="settings-title">
          <ShieldCheck size={21} />
          <div>
            <h2>Take your data with you</h2>
            <p>
              Backups contain application history and relevant evidence, but no
              credentials.
            </p>
          </div>
        </div>
        <div className="button-row">
          <a className="button secondary" href="/api/export.csv" download>
            <ArrowDownToLine size={15} />
            Export CSV
          </a>
          <a className="button secondary" href="/api/backup" download>
            <ArrowDownToLine size={15} />
            Download full backup
          </a>
          {state.canUndoMerge && (
            <>
              <a className="button secondary" href="/api/merge/backup" download>
                Pre-merge backup
              </a>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api("/merge/undo", "POST", {}),
                    "Merge undone.",
                  )
                }
              >
                Undo last merge
              </button>
            </>
          )}
        </div>
        <div className="restore-area">
          <Field
            label="Restore a backup into an empty instance"
            hint="Requires no applications or stored messages. Start with a fresh TRACKER_DATA_DIR to recover separately."
          >
            <input
              type="file"
              accept="application/json,.json"
              disabled={state.applications.length > 0}
              onChange={async (e) => {
                setError("");
                try {
                  const file = e.target.files?.[0];
                  if (file) {
                    if (file.size > 20_000_000)
                      throw new Error("Backup is too large (20 MB maximum).");
                    setBackup(JSON.parse(await file.text()));
                  }
                } catch {
                  setError("Choose a valid JSON backup smaller than 20 MB.");
                }
              }}
            />
          </Field>
          <button
            className="button secondary"
            disabled={!backup || busy || state.applications.length > 0}
            onClick={() =>
              void run(async () => {
                await api("/restore", "POST", backup);
                setBackup(undefined);
              }, "Backup restored. Reconnect accounts separately.")
            }
          >
            Restore selected backup
          </button>
        </div>
      </section>
    </>
  );
}
