import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Bell,
  BriefcaseBusiness,
  Check,
  ChevronRight,
  Inbox,
  LayoutDashboard,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  stages,
  terminal,
  localDate,
  type Application,
  type Action,
} from "../shared/model";
import { api, dateText, since, timeText, type State } from "./api";
import { Badge, Busy, Empty, Field, Notice } from "./components";
import { DiscoverPanel } from "./DiscoverPanel";
import {
  ApplicationPanel,
  AddApplication,
  ReviewPanel,
  SettingsPanel,
} from "./panels";

type View = "applications" | "discover" | "attention" | "review" | "settings";
export default function App() {
  const [state, setState] = useState<State>();
  const [view, setView] = useState<View>("applications");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [selected, setSelected] = useState("");
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState("");
  const [arrangement, setArrangement] = useState("");
  const [location, setLocation] = useState("");
  const [sort, setSort] = useState("applied");
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [salary, setSalary] = useState(false);
  const [filters, setFilters] = useState(false);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const refresh = useCallback(async () => {
    const next = await api<State>("/state");
    setState(next);
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(
      () => void refresh().catch((e) => setError(e.message)),
      5000,
    );
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (
      new URLSearchParams(window.location.search).get("view") === "discover"
    ) {
      setView("discover");
      window.history.replaceState({}, "", "/");
    }
    const value = new URLSearchParams(window.location.search).get("gmail");
    if (value) {
      setView("settings");
      value === "connected"
        ? setToast("Gmail connected. Your first sync will begin shortly.")
        : setError(
            "Gmail connection failed. Check your Desktop OAuth credentials, test user access, and Gmail API configuration.",
          );
      window.history.replaceState({}, "", "/");
    }
  }, []);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    setPage(1);
  }, [search, stage, arrangement, location, sort, after, before, salary]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        ["INPUT", "TEXTAREA", "SELECT"].includes(
          (e.target as HTMLElement)?.tagName,
        ) ||
        document.querySelector("dialog[open]")
      )
        return;
      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("search")?.focus();
      }
      if (e.key === "n" && !e.metaKey && !e.ctrlKey) setAdding(true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  async function run(task: () => Promise<unknown>, message?: string) {
    setBusy(true);
    setError("");
    try {
      await task();
      await refresh();
      if (message) setToast(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const applications = state?.applications || [];
  const filtered = useMemo(
    () =>
      applications
        .filter(
          (a) =>
            (!search ||
              `${a.company} ${a.title}`
                .toLowerCase()
                .includes(search.toLowerCase())) &&
            (!stage || a.stage === stage) &&
            (!arrangement || a.workArrangement === arrangement) &&
            (!location ||
              a.location.toLowerCase().includes(location.toLowerCase())) &&
            (!after || a.appliedAt >= after) &&
            (!before || (!!a.appliedAt && a.appliedAt <= before)) &&
            (!salary || !!a.salary),
        )
        .sort((a, b) =>
          sort === "company"
            ? a.company.localeCompare(b.company)
            : sort === "waiting"
              ? a.lastActivity.localeCompare(b.lastActivity)
              : sort === "activity"
                ? b.lastActivity.localeCompare(a.lastActivity)
                : b.appliedAt.localeCompare(a.appliedAt),
        ),
    [
      applications,
      search,
      stage,
      arrangement,
      location,
      after,
      before,
      salary,
      sort,
    ],
  );
  // Deletes and merges can shrink the list out from under the current page.
  const pageCount = Math.max(1, Math.ceil(filtered.length / 30));
  const currentPage = Math.min(page, pageCount);
  const actions = (state?.actions || [])
    .filter((a) => a.status === "pending")
    .sort((a, b) => (a.dueAt || "z").localeCompare(b.dueAt || "z"));
  const nav: {
    id: View;
    label: string;
    icon: typeof LayoutDashboard;
    count?: number;
  }[] = [
    { id: "applications", label: "My applications", icon: LayoutDashboard },
    { id: "discover", label: "Discover jobs", icon: Search },
    {
      id: "attention",
      label: "Next actions",
      icon: Bell,
      count: actions.length,
    },
    {
      id: "review",
      label: "Review inbox",
      icon: Inbox,
      count: state?.review.length,
    },
    { id: "settings", label: "Settings", icon: Settings2 },
  ];
  const cohort = applications.filter(
    (a) =>
      (!after || a.appliedAt >= after) &&
      (!before || (!!a.appliedAt && a.appliedAt <= before)) &&
      !!a.appliedAt,
  );
  const reached = (app: Application, stage: string) =>
    app.stage === stage ||
    state?.events.some((e) => e.applicationId === app.id && e.stage === stage);
  const responded = cohort.filter((a) =>
    state?.events.some(
      (e) =>
        e.applicationId === a.id &&
        e.sourceId &&
        ![
          "application_submitted",
          "application_confirmed",
          "manual_status",
        ].includes(e.type),
    ),
  ).length;
  if (!state)
    return (
      <div className="loading-screen">
        <div className="brand-mark">f.</div>
        <h1>Fieldwork</h1>
        {error ? (
          <Notice error>
            {error}{" "}
            <button
              onClick={() => void refresh().catch((e) => setError(e.message))}
            >
              Retry
            </button>
          </Notice>
        ) : (
          <Busy text="Opening your workspace…" />
        )}
      </div>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Fieldwork home">
          <span className="brand-mark">f.</span>
          <span>
            fieldwork<span className="brand-sub">YOUR NEXT CHAPTER</span>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-avatar">ME</span>
          <div>
            Personal workspace
            <small>
              <span className="live-dot" /> Local instance
            </small>
          </div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {nav.map(({ id, label, icon: Icon, count }) => (
            <button
              key={id}
              className={`nav-item ${view === id ? "active" : ""}`}
              onClick={() => setView(id)}
              aria-current={view === id ? "page" : undefined}
              aria-label={label}
            >
              <Icon size={18} />
              <span>{label}</span>
              {!!count && <span className="count">{count}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-note">
            <ShieldCheck size={18} />
            <div>
              Your search, your space.<small>Stored on this computer.</small>
            </div>
          </div>
          <button
            className="connection-summary"
            onClick={() => setView("settings")}
          >
            <Mail size={17} />
            <span>
              {state.connection.connected
                ? "Gmail connected"
                : "Connect your Gmail"}
              <small>
                {state.connection.connected
                  ? state.connection.account
                  : "Bring your updates together"}
              </small>
            </span>
            <ChevronRight size={15} />
          </button>
          <div className="version">
            FIELDWORK <span>v0.2 · LOCAL</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <strong>{nav.find((n) => n.id === view)?.label}</strong>
          </div>
          <span className="local-label">
            <span className="live-dot" /> Private & local
          </span>
        </header>
        <div className="content">
          {error && (
            <div className="banner error" role="alert">
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={17} />
              </button>
            </div>
          )}
          {view === "applications" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">MAKE YOUR NEXT MOVE</div>
                  <h1>Your search, in perspective.</h1>
                  <p>A little clarity for everything that comes next.</p>
                </div>
                <div className="heading-actions">
                  <button
                    className="button secondary"
                    disabled={
                      busy || state.sync.running || !state.connection.connected
                    }
                    onClick={() =>
                      void run(() => api("/gmail/sync", "POST", {}))
                    }
                  >
                    <RefreshCw
                      size={16}
                      className={state.sync.running ? "spin" : ""}
                    />
                    {state.sync.running ? "Syncing…" : "Sync Gmail"}
                  </button>
                  <button
                    className="button primary"
                    onClick={() => setAdding(true)}
                  >
                    <Plus size={17} />
                    Add application
                  </button>
                </div>
              </div>
              <section className="metrics" aria-label="Search summary">
                <Metric
                  title="APPLICATIONS"
                  value={applications.length}
                  detail={`${applications.filter((a) => !terminal.has(a.stage)).length} active opportunities`}
                  icon={<BriefcaseBusiness size={18} />}
                />
                <Metric
                  title="REACHED INTERVIEW"
                  value={
                    applications.filter((a) => reached(a, "Interviewing"))
                      .length
                  }
                  detail="Across your application history"
                  icon={<Mail size={18} />}
                />
                <Metric
                  title="OFFERS RECEIVED"
                  value={
                    applications.filter(
                      (a) => reached(a, "Offer") || reached(a, "Accepted"),
                    ).length
                  }
                  detail="Every offer is a milestone"
                  icon={<ArrowUpRight size={18} />}
                />
                <Metric
                  title="RESPONSE RATE"
                  value={`${cohort.length ? Math.round((responded / cohort.length) * 100) : 0}%`}
                  detail={`${responded} / ${cohort.length} dated applications · excludes receipts`}
                  icon={<RefreshCw size={18} />}
                />
              </section>
              <section className="overview">
                <div className="activity-chart">
                  <div className="section-title">
                    <h2>Building momentum</h2>
                    <span>Applications · last 14 days</span>
                  </div>
                  <ActivityChart apps={applications} />
                </div>
                <div className="pipeline">
                  <div className="section-title">
                    <h2>Where things stand</h2>
                    <span>Current stage</span>
                  </div>
                  <div className="stage-summary">
                    {(
                      [
                        "Applied",
                        "Assessment",
                        "Interviewing",
                        "Offer",
                        "Rejected",
                      ] as const
                    ).map((s) => (
                      <button
                        key={s}
                        onClick={() => setStage(stage === s ? "" : s)}
                        className={stage === s ? "chosen" : ""}
                      >
                        <Badge stage={s} />
                        <strong>
                          {applications.filter((a) => a.stage === s).length}
                        </strong>
                      </button>
                    ))}
                  </div>
                  <span className="muted small">
                    {
                      applications.filter((a) =>
                        ["Accepted", "Withdrawn", "Closed", "Unknown"].includes(
                          a.stage,
                        ),
                      ).length
                    }{" "}
                    accepted, withdrawn, closed, or unknown
                  </span>
                </div>
              </section>
              {(state.review.length > 0 ||
                state.sync.error ||
                state.sync.fileErrors.length > 0) && (
                <div className="attention-strip">
                  <Inbox size={18} />
                  <span>
                    {state.review.length
                      ? `${state.review.length} email updates are ready for your review.`
                      : state.sync.error || state.sync.fileErrors[0]}
                  </span>
                  <button
                    onClick={() =>
                      setView(state.review.length ? "review" : "settings")
                    }
                  >
                    {state.review.length ? "Review updates" : "Check settings"}
                    <ArrowUpRight size={15} />
                  </button>
                </div>
              )}
              <section className="application-section">
                <div className="table-heading">
                  <div>
                    <h2>
                      All applications{" "}
                      <span className="pill">{applications.length}</span>
                    </h2>
                    <p>Your opportunities, all in one place.</p>
                  </div>
                  <a className="text-button" href="/api/export.csv" download>
                    <ArrowDownToLine size={15} />
                    Export CSV
                  </a>
                </div>
                <div className="toolbar">
                  <div className="search-box">
                    <Search size={17} />
                    <input
                      id="search"
                      aria-label="Search applications"
                      placeholder="Search company or role…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <kbd>/</kbd>
                  </div>
                  <select
                    aria-label="Filter stage"
                    value={stage}
                    onChange={(e) => setStage(e.target.value)}
                  >
                    <option value="">All stages</option>
                    {stages.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  <select
                    aria-label="Sort applications"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="applied">Recently applied</option>
                    <option value="activity">Latest activity</option>
                    <option value="waiting">Longest waiting</option>
                    <option value="company">Company A–Z</option>
                  </select>
                  <button
                    className={`button secondary filter-button ${filters ? "selected" : ""}`}
                    onClick={() => setFilters(!filters)}
                    aria-expanded={filters}
                  >
                    <SlidersHorizontal size={16} />
                    Filters
                  </button>
                </div>
                {filters && (
                  <div className="filter-row">
                    <Field label="Applied from">
                      <input
                        type="date"
                        value={after}
                        onChange={(e) => setAfter(e.target.value)}
                      />
                    </Field>
                    <Field label="Applied through">
                      <input
                        type="date"
                        value={before}
                        onChange={(e) => setBefore(e.target.value)}
                      />
                    </Field>
                    <Field label="Work arrangement">
                      <select
                        value={arrangement}
                        onChange={(e) => setArrangement(e.target.value)}
                      >
                        <option value="">Any arrangement</option>
                        {["Remote", "Hybrid", "On-site", "Unknown"].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Location">
                      <input
                        value={location}
                        placeholder="City, state, or country"
                        onChange={(e) => setLocation(e.target.value)}
                      />
                    </Field>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={salary}
                        onChange={(e) => setSalary(e.target.checked)}
                      />
                      Has salary
                    </label>
                    <button
                      className="text-button"
                      onClick={() => {
                        setAfter("");
                        setBefore("");
                        setArrangement("");
                        setLocation("");
                        setSalary(false);
                        setStage("");
                        setSearch("");
                      }}
                    >
                      Clear filters
                    </button>
                  </div>
                )}
                {!applications.length ? (
                  <Empty
                    title="Your next chapter starts here."
                    action={
                      <div className="empty-actions">
                        <button
                          className="button primary"
                          onClick={() => setAdding(true)}
                        >
                          <Plus size={16} />
                          Add your first application
                        </button>
                        <button
                          className="button secondary"
                          onClick={() => setView("settings")}
                        >
                          Set up Gmail & text file
                        </button>
                      </div>
                    }
                  >
                    Drop in a job link. Save the details. Let hiring updates
                    find their way back to the right role.
                  </Empty>
                ) : !filtered.length ? (
                  <Empty title="No matching applications">
                    Try another company name or broaden your filters.
                  </Empty>
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>COMPANY / ROLE</th>
                          <th>STAGE</th>
                          <th>APPLIED</th>
                          <th>LOCATION</th>
                          <th>COMPENSATION</th>
                          <th>LAST ACTIVITY</th>
                          <th>
                            <span className="sr-only">Open</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered
                          .slice((currentPage - 1) * 30, currentPage * 30)
                          .map((a) => (
                            <tr key={a.id}>
                              <td>
                                <button
                                  className="role-button"
                                  onClick={() => setSelected(a.id)}
                                >
                                  <span
                                    className={`company-avatar tone-${(a.company || "U").charCodeAt(0) % 5}`}
                                  >
                                    {(a.company || "?")
                                      .slice(0, 2)
                                      .toUpperCase()}
                                  </span>
                                  <span>
                                    <strong>
                                      {a.company || "Company pending"}
                                    </strong>
                                    <span>
                                      {a.title || "Job details pending"}
                                      {a.enrichment === "pending" && (
                                        <span className="tiny-dot" />
                                      )}
                                    </span>
                                  </span>
                                </button>
                              </td>
                              <td>
                                <Badge stage={a.stage} />
                              </td>
                              <td>
                                <span className="date-cell">
                                  {a.appliedAt
                                    ? dateText(a.appliedAt).replace(
                                        /, \d{4}$/,
                                        "",
                                      )
                                    : "Unknown"}
                                  {a.appliedAt && a.dateBasis !== "user" && (
                                    <span
                                      title={`Date basis: ${a.dateBasis}. Editable in details.`}
                                      aria-label={`Date basis: ${a.dateBasis}`}
                                    >
                                      {" "}
                                      ≈
                                    </span>
                                  )}
                                </span>
                              </td>
                              <td>
                                <span className="cell-primary">
                                  {a.location || "Not specified"}
                                </span>
                                <small>
                                  {a.workArrangement !== "Unknown"
                                    ? a.workArrangement
                                    : "Arrangement unknown"}
                                </small>
                              </td>
                              <td>
                                <span className="salary-cell">
                                  {a.salary || "—"}
                                </span>
                              </td>
                              <td>
                                <span className="muted">
                                  {since(a.lastActivity)}
                                </span>
                                {state.actions.find(
                                  (t) =>
                                    t.applicationId === a.id &&
                                    t.status === "pending",
                                ) && (
                                  <small className="action-hint">
                                    Action pending
                                  </small>
                                )}
                              </td>
                              <td>
                                <button
                                  className="icon-button"
                                  aria-label={`Open ${a.company || a.title || "application"}`}
                                  onClick={() => setSelected(a.id)}
                                >
                                  <ArrowUpRight size={17} />
                                </button>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="table-footer">
                  <span>
                    {filtered.length} application
                    {filtered.length === 1 ? "" : "s"}
                    {applications.some((a) => !a.appliedAt)
                      ? ` · ${applications.filter((a) => !a.appliedAt).length} with unknown dates`
                      : ""}
                  </span>
                  {filtered.length > 30 && (
                    <div className="pagination">
                      <button
                        disabled={currentPage <= 1}
                        onClick={() => setPage(currentPage - 1)}
                      >
                        Previous
                      </button>
                      <span>
                        {currentPage} / {pageCount}
                      </span>
                      <button
                        disabled={currentPage >= pageCount}
                        onClick={() => setPage(currentPage + 1)}
                      >
                        Next
                      </button>
                    </div>
                  )}
                  <span>≈ Estimated or file-default date</span>
                </div>
              </section>
              <div className="bottom-note">
                <ShieldCheck size={14} />
                <span>
                  Stored locally. Last Gmail sync:{" "}
                  {timeText(state.sync.lastSuccess)}.
                  {after || before
                    ? ` Response cohort: ${after || "earliest"} – ${before || "latest"}.`
                    : " Response cohort: all dated applications."}
                </span>
              </div>
            </>
          )}
          {view === "attention" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">ONE THING AT A TIME</div>
                  <h1>Your next moves.</h1>
                  <p>Assessments and interviews that need your attention.</p>
                </div>
              </div>
              {!actions.length ? (
                <Empty title="A little breathing room.">
                  There are no pending actions. Invitations from Gmail appear
                  here after they’re matched to a role.
                </Empty>
              ) : (
                <div className="action-list">
                  {actions.map((action) => (
                    <ActionCard
                      key={action.id}
                      action={action}
                      application={applications.find(
                        (a) => a.id === action.applicationId,
                      )}
                      open={() => setSelected(action.applicationId)}
                      refresh={refresh}
                      report={setError}
                    />
                  ))}
                </div>
              )}
            </>
          )}
          {view === "review" && (
            <ReviewPanel state={state} refresh={refresh} open={setSelected} />
          )}
          {view === "discover" && (
            <DiscoverPanel
              onApplied={async (id) => {
                await refresh();
                setSelected(id);
              }}
            />
          )}
          {view === "settings" && (
            <SettingsPanel state={state} refresh={refresh} />
          )}
        </div>
      </main>
      {adding && (
        <AddApplication
          close={() => setAdding(false)}
          saved={async (id) => {
            await refresh();
            setAdding(false);
            setSelected(id);
            setToast("Application added.");
          }}
        />
      )}
      {selected && (
        <ApplicationPanel
          id={selected}
          state={state}
          close={() => setSelected("")}
          changed={refresh}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
    </div>
  );
}
function Metric({
  title,
  value,
  detail,
  icon,
}: {
  title: string;
  value: number | string;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="metric">
      <div className="metric-title">
        {title}
        {icon}
      </div>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}
function ActivityChart({ apps }: { apps: Application[] }) {
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - 13 + i);
    const date = localDate(d);
    return { date, count: apps.filter((a) => a.appliedAt === date).length };
  });
  const max = Math.max(4, ...days.map((d) => d.count));
  return (
    <div className="chart-wrap">
      <svg
        viewBox="0 0 560 100"
        role="img"
        aria-label={`Applications in the last 14 days: ${days.map((d) => `${d.date}: ${d.count}`).join(", ")}`}
      >
        <line x1="0" y1="87" x2="560" y2="87" stroke="#e9e9e2" />
        <line
          x1="0"
          y1="43"
          x2="560"
          y2="43"
          stroke="#efefe9"
          strokeDasharray="3 4"
        />
        {days.map((d, i) => (
          <g key={d.date}>
            <rect
              x={i * 40 + 8}
              y={87 - Math.max(3, (d.count / max) * 76)}
              width="24"
              height={Math.max(3, (d.count / max) * 76)}
              rx="3"
              fill={d.count ? (i === 13 ? "#be6a42" : "#8eaa91") : "#e9ece5"}
            >
              <title>
                {dateText(d.date)}: {d.count} applications
              </title>
            </rect>
          </g>
        ))}
      </svg>
      <div className="chart-labels">
        <span>{dateText(days[0].date).replace(/, \d{4}/, "")}</span>
        <span>Today</span>
      </div>
    </div>
  );
}
function ActionCard({
  action,
  application,
  open,
  refresh,
  report,
}: {
  action: Action;
  application?: Application;
  open: () => void;
  refresh: () => Promise<void>;
  report: (e: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [due, setDue] = useState(action.dueAt);
  const [zone, setZone] = useState(action.timeZone);
  const change = async (data: unknown) => {
    try {
      await api(`/actions/${action.id}`, "PATCH", data);
      await refresh();
      setEditing(false);
    } catch (e) {
      report((e as Error).message);
    }
  };
  return (
    <article className="action-card">
      <div className="action-icon">
        {action.kind === "assessment" ? (
          <BriefcaseBusiness size={20} />
        ) : (
          <Mail size={20} />
        )}
      </div>
      <div className="action-body">
        <button className="text-button" onClick={open}>
          {application?.company || "Unknown company"}
          <ArrowUpRight size={14} />
        </button>
        <h3>{action.title}</h3>
        <p>{application?.title || "Role details pending"}</p>
        <span className="due-label">
          {action.dueAt || "Date needs confirmation"}
          {action.timeZone
            ? ` · ${action.timeZone}`
            : " · Time zone unconfirmed"}
        </span>
        {editing && (
          <div className="action-edit">
            <Field label="Date / time">
              <input
                value={due}
                onChange={(e) => setDue(e.target.value)}
                placeholder="2026-10-01 14:00"
              />
            </Field>
            <Field label="Time zone">
              <input
                value={zone}
                onChange={(e) => setZone(e.target.value)}
                placeholder="America/Denver"
              />
            </Field>
            <button
              className="button secondary"
              onClick={() => void change({ dueAt: due, timeZone: zone })}
            >
              Save
            </button>
          </div>
        )}
      </div>
      <div className="action-controls">
        <button
          className="button secondary"
          onClick={() => void change({ status: "completed" })}
        >
          <Check size={15} />
          Complete
        </button>
        <button
          className="text-button"
          onClick={() => {
            if (!editing) {
              setDue(action.dueAt);
              setZone(action.timeZone);
            }
            setEditing(!editing);
          }}
        >
          Edit date
        </button>
        <button
          className="text-button muted"
          onClick={() => void change({ status: "dismissed" })}
        >
          Dismiss
        </button>
      </div>
    </article>
  );
}
