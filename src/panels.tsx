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
    <Modal title="add an application" close={close}>
      <form onSubmit={submit}>
        <p className="modal-intro">just the link is fine, rest is optional.</p>
        {error && <Notice error>{error}</Notice>}
        <div className="form-grid">
          <Field
            label="job link"
            full
            hint="it'll try to grab the description and fill in the rest"
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
          <Field label="company">
            <input
              value={draft.company}
              onChange={(e) => setDraft({ ...draft, company: e.target.value })}
              placeholder="company"
            />
          </Field>
          <Field label="job title">
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="software engineer"
            />
          </Field>
          <Field label="date applied">
            <input
              type="date"
              value={draft.appliedAt}
              onChange={(e) =>
                setDraft({ ...draft, appliedAt: e.target.value })
              }
            />
          </Field>
          <Field label="stage">
            <select
              value={draft.stage}
              onChange={(e) =>
                setDraft({ ...draft, stage: e.target.value as Draft["stage"] })
              }
            >
              {stages.map((s) => (
                <option key={s} value={s}>
                  {s.toLowerCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field label="job description (optional)" full>
            <textarea
              rows={4}
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
              placeholder="paste it here if the job page won't load…"
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
            reapplying to a posting i already have
          </label>
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={close}>
            cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <Busy text="adding…" />
            ) : (
              <>
                <Plus size={16} />
                add application
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
    // The description has its own form ("save description") on another tab.
    const patch: Partial<Draft> = Object.fromEntries(
      Object.entries(draft).filter(
        ([key, value]) =>
          key !== "description" && value !== baseline[key as keyof Draft],
      ),
    );
    await action(
      () => api(`/applications/${id}`, "PATCH", patch),
      "saved. my edits win over future extraction.",
      patch,
    );
  }
  async function saveSnapshot(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const patch = { description: draft.description };
    await action(
      () => api(`/applications/${id}`, "PATCH", patch),
      "saved the description",
      patch,
    );
  }
  const set = (key: keyof Draft, value: string) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  const app = detail?.application;
  const selectedSnapshot =
    detail?.snapshots.find((s) => s.id === snapshot) || detail?.snapshots[0];
  return (
    <Modal title={app?.company || "application"} close={close} wide>
      {error && <Notice error>{error}</Notice>}
      {!detail || !draft || !app ? (
        <div className="panel-padding">
          <Busy text="loading…" />
        </div>
      ) : (
        <>
          <div className="detail-heading">
            <div>
              <h2>{app.title || "no title yet"}</h2>
              <div className="detail-meta">
                <Badge stage={app.stage} />
                <span>{app.location || "location not listed"}</span>
                {safeLink(app.url) && (
                  <a
                    className="text-button"
                    href={safeLink(app.url)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    job posting
                    <ExternalLink size={13} />
                  </a>
                )}
              </div>
            </div>
          </div>
          <div className="tabs" role="tablist" aria-label="sections">
            {(["details", "timeline", "description"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={tab === t ? "active" : ""}
              >
                {t === "details"
                  ? "details"
                  : t === "timeline"
                    ? `timeline · ${detail.events.length}`
                    : "description"}
              </button>
            ))}
          </div>
          {message && <Notice>{message}</Notice>}
          {app.enrichment === "pending" && (
            <div className="inline-note">
              <Busy text="pulling job details…" />
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
                  try again
                </button>
              </Notice>
            </div>
          )}
          {tab === "details" && (
            <form onSubmit={save}>
              <div className="form-grid">
                <Field label="company">
                  <input
                    value={draft.company}
                    onChange={(e) => set("company", e.target.value)}
                  />
                </Field>
                <Field label="job title">
                  <input
                    value={draft.title}
                    onChange={(e) => set("title", e.target.value)}
                  />
                </Field>
                <Field label="stage">
                  <select
                    value={draft.stage}
                    onChange={(e) => set("stage", e.target.value)}
                  >
                    {stages.map((s) => (
                      <option key={s} value={s}>
                        {s.toLowerCase()}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="date applied"
                  hint={`from: ${app.dateBasis}. clear it if i don't know`}
                >
                  <input
                    type="date"
                    value={draft.appliedAt}
                    onChange={(e) => set("appliedAt", e.target.value)}
                  />
                </Field>
                <Field label="location">
                  <input
                    value={draft.location}
                    onChange={(e) => set("location", e.target.value)}
                    placeholder="unknown"
                  />
                </Field>
                <Field label="remote / hybrid / on-site">
                  <select
                    value={draft.workArrangement}
                    onChange={(e) => set("workArrangement", e.target.value)}
                  >
                    {["Unknown", "Remote", "Hybrid", "On-site"].map((s) => (
                      <option key={s} value={s}>
                        {s.toLowerCase()}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="pay (as posted)" full>
                  <input
                    value={draft.salary}
                    onChange={(e) => set("salary", e.target.value)}
                    placeholder="e.g. USD 140,000–175,000 / year base"
                  />
                </Field>
                <Field label="currency">
                  <input
                    value={draft.currency}
                    onChange={(e) => set("currency", e.target.value)}
                    placeholder="USD"
                  />
                </Field>
                <Field label="per">
                  <input
                    value={draft.salaryPeriod}
                    onChange={(e) => set("salaryPeriod", e.target.value)}
                    placeholder="year, hour…"
                  />
                </Field>
                <Field label="type">
                  <input
                    value={draft.employmentType}
                    onChange={(e) => set("employmentType", e.target.value)}
                    placeholder="full-time"
                  />
                </Field>
                <Field label="level">
                  <input
                    value={draft.seniority}
                    onChange={(e) => set("seniority", e.target.value)}
                    placeholder="not listed"
                  />
                </Field>
                <Field label="job / req id">
                  <input
                    value={draft.postingId}
                    onChange={(e) => set("postingId", e.target.value)}
                  />
                </Field>
                <Field label="job link">
                  <input
                    type="url"
                    value={draft.url}
                    onChange={(e) => set("url", e.target.value)}
                  />
                </Field>
                <Field label="responsibilities" full>
                  <textarea
                    rows={4}
                    value={draft.responsibilities}
                    onChange={(e) => set("responsibilities", e.target.value)}
                    placeholder="fills in after extraction"
                  />
                </Field>
                <Field label="requirements" full>
                  <textarea
                    rows={3}
                    value={draft.requirements}
                    onChange={(e) => set("requirements", e.target.value)}
                  />
                </Field>
                <Field label="tech" full>
                  <input
                    value={draft.technologies}
                    onChange={(e) => set("technologies", e.target.value)}
                  />
                </Field>
                <Field label="notes" full>
                  <textarea
                    rows={3}
                    value={draft.notes}
                    onChange={(e) => set("notes", e.target.value)}
                    placeholder="referral, recruiter, whatever…"
                  />
                </Field>
              </div>
              <div className="modal-footer">
                <span className="muted small">
                  Captured {dateText(app.createdAt)}
                </span>
                <button className="button primary" disabled={busy}>
                  {busy ? (
                    <Busy text="saving…" />
                  ) : (
                    <>
                      <Save size={15} />
                      save
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
                      <h3>{event.label.toLowerCase()}</h3>
                      {source && (
                        <>
                          <p className="muted">{source.subject}</p>
                          <details>
                            <summary>show the email</summary>
                            <pre className="source-text">{source.excerpt}</pre>
                            <a
                              href={`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(source.account)}#all/${encodeURIComponent(source.messageId)}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-button"
                            >
                              open in gmail
                              <ExternalLink size={13} />
                            </a>
                            <p className="small muted">
                              classifier {Math.round(event.confidence * 100)}% ·
                              match {Math.round(event.matchConfidence * 100)}%
                              (rough scores, not real probabilities)
                            </p>
                          </details>
                        </>
                      )}
                    </article>
                  );
                })
              ) : (
                <Empty title="nothing yet">
                  emails and status changes show up here.
                </Empty>
              )}
            </div>
          )}
          {tab === "description" && (
            <div className="panel-padding">
              <div className="snapshot-toolbar">
                <h3>saved descriptions</h3>
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
                  refetch from link
                </button>
              </div>
              {detail.snapshots.length > 0 && (
                <>
                  <label className="field">
                    <span>version</span>
                    <select
                      value={selectedSnapshot?.id || ""}
                      onChange={(e) => setSnapshot(e.target.value)}
                    >
                      {detail.snapshots.map((s) => (
                        <option value={s.id} key={s.id}>
                          {timeText(s.capturedAt)} ·{" "}
                          {s.sourceKind === "pasted"
                            ? "pasted"
                            : "from the job page"}
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
                <Field label="new description" hint="older ones are kept">
                  <textarea
                    rows={7}
                    value={draft.description}
                    onChange={(e) => set("description", e.target.value)}
                    placeholder="paste the whole thing…"
                  />
                </Field>
                <button
                  className="button primary"
                  disabled={busy || !draft.description.trim()}
                >
                  <FileText size={15} />
                  save description
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
              merge duplicate
            </button>
            <button
              className="text-button danger"
              onClick={() => {
                setConfirmDelete(!confirmDelete);
                setMerge(false);
              }}
            >
              <Trash2 size={15} />
              delete
            </button>
          </div>
          {merge && (
            <div className="confirmation">
              <h3>merge this into another application</h3>
              <p>
                moves this one's timeline, descriptions, to-dos, and emails into
                the one i pick, and fills in its empty fields. it keeps
                whichever stage is further along (or the more recent one if
                either is closed out). a backup is saved first so i can undo.
              </p>
              <select
                aria-label="merge into"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">pick the one to keep</option>
                {state.applications
                  .filter((a) => a.id !== id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.company || "unknown company"} — {a.title || "untitled"}{" "}
                      · {a.stage.toLowerCase()}
                    </option>
                  ))}
              </select>
              {target && (
                <p className="merge-preview">
                  {app.company || "this one"} / {app.title || "untitled"} →{" "}
                  {state.applications.find((a) => a.id === target)?.company} /{" "}
                  {state.applications.find((a) => a.id === target)?.title}
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
                merge
              </button>
            </div>
          )}
          {confirmDelete && (
            <div className="confirmation">
              <h3>delete this and everything attached to it?</h3>
              <p>
                removes its descriptions, timeline, and saved email bits. gmail
                and the links file aren't touched, and sync won't bring it back.
                grab a backup first if i might want it.
              </p>
              <div className="button-row">
                <a className="button secondary" href="/api/backup" download>
                  download backup
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
                  delete for good
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
          <h1>emails to sort</h1>
          <p>ones it wasn't sure about. oldest first.</p>
        </div>
        <span className="review-total">{pending.length} left</span>
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
                ? `re-reading ${backfill.processed} of ${backfill.total}${backfill.failed ? ` · ${backfill.failed} failed` : ""}`
                : state.settings.aiEnabled
                  ? `have ${state.settings.aiModel} re-read all of these and fill in company, role, event, and dates`
                  : "turn on ai extraction in settings to have these re-read automatically"}
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
                ? "running…"
                : `run ai on all ${pending.length}`}
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
        <Empty title="all sorted">
          anything it can't figure out on its own shows up here after a gmail
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
        if (action === "dismiss") return onExit("dismissed");
        if (action === "attach") {
          const application = applications.find((a) => a.id === target);
          return onExit(
            `attached to ${application?.company || "unknown company"} — ${application?.title || "untitled"}`,
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
              {source.state === "failed" ? "extraction failed" : "needs a look"}
            </span>
          </div>
          <div className="review-content">
            <Notice error={source.state === "failed"}>{source.reason}</Notice>
            {error && <Notice error>{error}</Notice>}
            <details>
              <summary>read the email</summary>
              <pre className="source-text">{source.excerpt}</pre>
            </details>
            <div className="form-grid compact">
              <Field label="what happened">
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
                  <option value="">pick one</option>
                  {eventTypes
                    .filter((t) => t !== "manual_status")
                    .map((t) => (
                      <option key={t} value={t}>
                        {eventLabel(t)}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="which application">
                <select
                  value={target}
                  onChange={(e) => {
                    setTarget(e.target.value);
                    setActionId("");
                  }}
                >
                  <option value="">pick one</option>
                  {[...applications]
                    .sort(
                      (a, b) =>
                        Number(source.candidates.includes(b.id)) -
                        Number(source.candidates.includes(a.id)),
                    )
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.company || "unknown company"} —{" "}
                        {a.title || "untitled"}
                        {source.candidates.includes(a.id) ? " (suggested)" : ""}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="company (if it's new)">
                <input
                  value={data.company}
                  onChange={(e) =>
                    setData({ ...data, company: e.target.value })
                  }
                />
              </Field>
              <Field label="title (if it's new)">
                <input
                  value={data.title}
                  onChange={(e) => setData({ ...data, title: e.target.value })}
                />
              </Field>
              <Field label="job / req id">
                <input
                  value={data.postingId}
                  onChange={(e) =>
                    setData({ ...data, postingId: e.target.value })
                  }
                />
              </Field>
              <Field label="job link">
                <input
                  type="url"
                  value={data.url}
                  onChange={(e) => setData({ ...data, url: e.target.value })}
                />
              </Field>
              <Field label="deadline / time">
                <input
                  value={data.dueAt}
                  onChange={(e) => setData({ ...data, dueAt: e.target.value })}
                  placeholder="blank if unknown"
                />
              </Field>
              <Field label="time zone">
                <input
                  value={data.timeZone}
                  onChange={(e) =>
                    setData({ ...data, timeZone: e.target.value })
                  }
                  placeholder="check the email"
                />
              </Field>
              {["interview_rescheduled", "interview_canceled"].includes(
                data.eventType || "",
              ) &&
                actions.length > 1 && (
                  <Field label="which interview" full>
                    <select
                      value={actionId}
                      onChange={(e) => setActionId(e.target.value)}
                    >
                      <option value="">pick one</option>
                      {actions.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.title} · {a.dueAt || "no date"}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
            </div>
            {target && (
              <div className="inline-help">
                <button className="text-button" onClick={() => open(target)}>
                  open it
                  <ExternalLink size={13} />
                </button>
                <span>
                  won't override a closed stage or anything i set by hand.
                  reopen it in details if needed.
                </span>
              </div>
            )}
            <div className="review-footer">
              <button
                className="text-button muted"
                disabled={busy}
                onClick={() => void decide("dismiss")}
              >
                not a job email
              </button>
              <div className="button-row">
                {source.state === "failed" && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void decide("retry")}
                  >
                    <RefreshCw size={14} />
                    try again
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
                  {createdApplication ? "created" : "new application"}
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
                      attach it
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
          ? "saved. re-checking emails to sort against the new search…"
          : "saved",
    );
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>settings</h1>
        </div>
      </div>
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      <form onSubmit={save} className="settings-form">
        <section className="settings-section">
          <div className="settings-title">
            <FileText size={21} />
            <div>
              <h2>links file</h2>
              <p>paste a link in after applying and it picks it up</p>
            </div>
          </div>
          <Field
            label="full path to the file"
            hint="make the file first, then pick it or paste the path. checked every 2 seconds while the app is open."
          >
            <input
              value={settings.linksFile}
              onChange={(e) => change("linksFile", e.target.value)}
              placeholder="/Users/me/Documents/applications.txt"
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
              pick file…
            </button>
          )}
          <pre className="code-example">
            {
              "# one per line\nhttps://company.com/careers/software-engineer\n2026-09-20 | https://another-company.com/jobs/123"
            }
          </pre>
          <p className="small muted">
            just a link = applied today. older ones need a date. deleting a line
            doesn't delete the application.
          </p>
          <div className="connection-line">
            <span>last checked: {timeText(state.sync.fileLastScan)}</span>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void run(() => api("/import/scan", "POST", {}), "checked")
              }
            >
              <RefreshCw size={14} />
              check now
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
              <h2>gmail</h2>
              <p>read-only, doesn't change anything in the inbox</p>
            </div>
            <span
              className={`connection-pill ${state.connection.connected ? "connected" : ""}`}
            >
              {state.connection.connected ? "connected" : "not connected"}
            </span>
          </div>
          <div className="form-grid compact">
            <Field
              label="google oauth client id (desktop)"
              hint={
                state.connection.googleConfigured
                  ? "saved. leave blank to keep it"
                  : "make one in google cloud"
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
            <Field label="google oauth client secret">
              <input
                type="password"
                value={secrets.googleClientSecret}
                onChange={(e) =>
                  setSecrets({ ...secrets, googleClientSecret: e.target.value })
                }
                autoComplete="new-password"
                placeholder="blank = keep the saved one"
              />
            </Field>
            <Field label="pull emails since">
              <input
                type="date"
                required
                value={settings.importAfter}
                onChange={(e) => change("importAfter", e.target.value)}
              />
            </Field>
            <Field label="sync every (minutes)">
              <input
                type="number"
                min="1"
                max="1440"
                value={settings.syncMinutes}
                onChange={(e) => change("syncMinutes", Number(e.target.value))}
              />
            </Field>
            <Field
              label="gmail search"
              full
              hint="normal gmail search syntax. includes archived, skips spam/trash. changing it re-checks emails to sort and drops ones that don't match anymore."
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
                  }, "re-checking against this search…")
                }
              >
                save + re-check now
              </button>
            </Field>
          </div>
          <details className="setup-guide">
            <summary>how to set up gmail</summary>
            <ol>
              <li>
                make a project in{" "}
                <a
                  href="https://console.cloud.google.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  google cloud
                </a>{" "}
                and turn on the gmail api.
              </li>
              <li>
                set up the oauth consent screen in testing mode, add my gmail as
                a test user, and add the <code>gmail.readonly</code> scope.
              </li>
              <li>
                make an oauth client of type <strong>desktop app</strong>, paste
                the id and secret above, and save.
              </li>
              <li>hit connect gmail and sign in in the browser.</li>
            </ol>
            <p>
              testing-mode sign-ins expire after about a week, so reconnect if
              sync starts failing.
            </p>
            <p>
              <a
                href="https://developers.google.com/identity/protocols/oauth2/native-app"
                target="_blank"
                rel="noreferrer"
              >
                google's desktop oauth docs
              </a>
            </p>
          </details>
          <div className="connection-line">
            <span>
              {state.connection.account || "save the client id/secret first"}
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
                  ? "reconnect gmail"
                  : "connect gmail"}
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
                      "disconnected gmail. applications are still here.",
                    )
                  }
                >
                  <Unplug size={14} />
                  disconnect
                </button>
              )}
            </div>
          </div>
          <div className="connection-line">
            <span>
              {state.sync.running
                ? `checked ${state.sync.processed} / ${state.sync.discovered} emails`
                : `last synced: ${timeText(state.sync.lastSuccess)}`}
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
                  "rescanning. won't duplicate anything already pulled in.",
                )
              }
            >
              rescan everything since the start date
            </button>
          </div>
          {state.sync.error && <Notice error>{state.sync.error}</Notice>}
        </section>
        <section className="settings-section">
          <div className="settings-title">
            <Settings2 size={21} />
            <div>
              <h2>ai extraction</h2>
              <p>
                reads emails and job pages to pull out company, role, what
                happened, and dates so fewer need sorting by hand. off = keyword
                rules only.
              </p>
            </div>
            <span
              className={`connection-pill ${usingClaudeCode || state.connection.aiConfigured ? "connected" : ""}`}
            >
              {usingClaudeCode
                ? "claude code"
                : state.connection.aiConfigured
                  ? "key saved"
                  : "no key"}
            </span>
          </div>
          <label className="check-label consent">
            <input
              type="checkbox"
              checked={settings.aiEnabled}
              onChange={(e) => change("aiEnabled", e.target.checked)}
            />
            <span>
              use ai extraction
              <small>
                sends job-email snippets, subjects, dates, and job descriptions
                to the provider below. not the whole inbox, no attachments.
              </small>
            </span>
          </label>
          <div className="form-grid compact">
            <Field
              label="provider"
              full
              hint="claude code uses the cli i already have signed in. no api key, nothing billed separately."
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
                <option value="claude-code">claude code (local cli)</option>
                <option value="openai">openai-compatible api key</option>
              </select>
            </Field>
            {!usingClaudeCode && (
              <Field
                label="api key"
                hint={
                  state.connection.aiConfigured
                    ? "blank = keep the saved key"
                    : "billed by the provider"
                }
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  value={secrets.aiKey}
                  onChange={(e) =>
                    setSecrets({ ...secrets, aiKey: e.target.value })
                  }
                  placeholder="api key"
                />
              </Field>
            )}
            <Field
              label="model"
              hint={
                usingClaudeCode
                  ? "a small model keeps this from eating the subscription limit"
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
                label="claude path (optional)"
                full
                hint="blank = look for `claude` on PATH. the app opened from finder barely has a PATH, so set the full path if it says claude isn't found."
              >
                <input
                  value={settings.claudeCodePath}
                  onChange={(e) => change("claudeCodePath", e.target.value)}
                  placeholder="/Users/me/.local/bin/claude"
                />
              </Field>
            ) : (
              <Field
                label="api base url (https)"
                full
                hint="defaults to openai. whatever's here is who gets the email snippets."
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
              let ai update applications on its own when it's confident
              <small>
                off by default since ai confidence is kind of made up. when off,
                ai results go to emails to sort; obvious keyword matches can
                still attach on their own.
              </small>
            </span>
          </label>
          {state.connection.aiUsage && (
            <p className="small muted">
              last run: {timeText(state.connection.aiUsage.at)} ·{" "}
              {state.connection.aiUsage.model} ·{" "}
              {state.connection.aiUsage.tokens ?? "?"} tokens
            </p>
          )}
          <p className="small muted">
            {window.fieldworkDesktop
              ? "keys are encrypted with a key kept in the macos keychain, and never exported"
              : "keys are encrypted in the data folder, but the encryption key is on the same machine. never exported."}
          </p>
        </section>
        <div className="settings-save">
          <span className="muted small">just for this computer</span>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <Busy text="saving…" />
            ) : (
              <>
                <Save size={16} />
                save
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
            <h2>backups</h2>
            <p>has all the applications and emails, no passwords or keys</p>
          </div>
        </div>
        <div className="button-row">
          <a className="button secondary" href="/api/export.csv" download>
            <ArrowDownToLine size={15} />
            export csv
          </a>
          <a className="button secondary" href="/api/backup" download>
            <ArrowDownToLine size={15} />
            download backup
          </a>
          {state.canUndoMerge && (
            <>
              <a className="button secondary" href="/api/merge/backup" download>
                backup from before the merge
              </a>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api("/merge/undo", "POST", {}),
                    "undid the merge",
                  )
                }
              >
                undo last merge
              </button>
            </>
          )}
        </div>
        <div className="restore-area">
          <Field
            label="restore a backup (only into an empty app)"
            hint="only works with no applications or emails yet. point TRACKER_DATA_DIR at a new folder to restore on the side."
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
                      throw new Error("backup is too big (20 MB max)");
                    setBackup(JSON.parse(await file.text()));
                  }
                } catch {
                  setError("pick a backup .json under 20 MB");
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
              }, "restored. reconnect gmail/ai separately.")
            }
          >
            restore
          </button>
        </div>
      </section>
    </>
  );
}
