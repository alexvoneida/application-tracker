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
  Send,
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
  const [connectionError, setConnectionError] = useState("");
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
    // Poll failures get their own banner so recovery can clear it without
    // hiding an error from something the user did.
    const poll = () =>
      void refresh().then(
        () => setConnectionError(""),
        (e) => setConnectionError(e.message),
      );
    poll();
    const timer = setInterval(poll, 5000);
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
        ? setToast("gmail's connected, first sync starts in a sec")
        : setError(
            "gmail didn't connect. check the oauth client id/secret, that my account is a test user, and that the gmail api is turned on",
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
    { id: "applications", label: "applications", icon: LayoutDashboard },
    { id: "discover", label: "find jobs", icon: Search },
    {
      id: "attention",
      label: "to do",
      icon: Bell,
      count: actions.length,
    },
    {
      id: "review",
      label: "emails to sort",
      icon: Inbox,
      count: state?.review.length,
    },
    { id: "settings", label: "settings", icon: Settings2 },
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
        <div className="brand-mark">
          <Send size={22} />
        </div>
        <h1>application tracker</h1>
        {error ? (
          <Notice error>
            {error}{" "}
            <button
              onClick={() => void refresh().catch((e) => setError(e.message))}
            >
              try again
            </button>
          </Notice>
        ) : (
          <Busy text="loading…" />
        )}
      </div>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="home">
          <span className="brand-mark">
            <Send size={17} />
          </span>
          <span>application tracker</span>
        </a>
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
          <button
            className="connection-summary"
            onClick={() => setView("settings")}
          >
            <Mail size={17} />
            <span>
              {state.connection.connected ? "gmail connected" : "connect gmail"}
              <small>
                {state.connection.connected
                  ? state.connection.account
                  : "not set up yet"}
              </small>
            </span>
            <ChevronRight size={15} />
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="content">
          {connectionError && (
            <div className="banner error" role="alert">
              <span>{connectionError}</span>
            </div>
          )}
          {error && (
            <div className="banner error" role="alert">
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="dismiss error"
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
                  <h1>how it's going</h1>
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
                    {state.sync.running ? "syncing…" : "sync gmail"}
                  </button>
                  <button
                    className="button primary"
                    onClick={() => setAdding(true)}
                  >
                    <Plus size={17} />
                    add application
                  </button>
                </div>
              </div>
              <section className="metrics" aria-label="summary">
                <Metric
                  title="applied"
                  value={applications.length}
                  detail={`${applications.filter((a) => !terminal.has(a.stage)).length} still open`}
                  icon={<BriefcaseBusiness size={18} />}
                />
                <Metric
                  title="got interviews"
                  value={
                    applications.filter((a) => reached(a, "Interviewing"))
                      .length
                  }
                  detail="all time"
                  icon={<Mail size={18} />}
                />
                <Metric
                  title="offers"
                  value={
                    applications.filter(
                      (a) => reached(a, "Offer") || reached(a, "Accepted"),
                    ).length
                  }
                  detail="all time"
                  icon={<ArrowUpRight size={18} />}
                />
                <Metric
                  title="response rate"
                  value={`${cohort.length ? Math.round((responded / cohort.length) * 100) : 0}%`}
                  detail={`${responded} of ${cohort.length} heard back (auto-confirmations don't count)`}
                  icon={<RefreshCw size={18} />}
                />
              </section>
              <section className="overview">
                <div className="activity-chart">
                  <div className="section-title">
                    <h2>last 14 days</h2>
                    <span>applications per day</span>
                  </div>
                  <ActivityChart apps={applications} />
                </div>
                <div className="pipeline">
                  <div className="section-title">
                    <h2>by stage</h2>
                    <span>click one to filter</span>
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
                      ? `${state.review.length} emails to sort`
                      : state.sync.error || state.sync.fileErrors[0]}
                  </span>
                  <button
                    onClick={() =>
                      setView(state.review.length ? "review" : "settings")
                    }
                  >
                    {state.review.length ? "sort them" : "check settings"}
                    <ArrowUpRight size={15} />
                  </button>
                </div>
              )}
              <section className="application-section">
                <div className="table-heading">
                  <div>
                    <h2>
                      all applications{" "}
                      <span className="pill">{applications.length}</span>
                    </h2>
                  </div>
                  <a className="text-button" href="/api/export.csv" download>
                    <ArrowDownToLine size={15} />
                    export csv
                  </a>
                </div>
                <div className="toolbar">
                  <div className="search-box">
                    <Search size={17} />
                    <input
                      id="search"
                      aria-label="search applications"
                      placeholder="search company or role…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <kbd>/</kbd>
                  </div>
                  <select
                    aria-label="filter by stage"
                    value={stage}
                    onChange={(e) => setStage(e.target.value)}
                  >
                    <option value="">all stages</option>
                    {stages.map((s) => (
                      <option key={s} value={s}>
                        {s.toLowerCase()}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="sort"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="applied">recently applied</option>
                    <option value="activity">latest activity</option>
                    <option value="waiting">waiting longest</option>
                    <option value="company">company a–z</option>
                  </select>
                  <button
                    className={`button secondary filter-button ${filters ? "selected" : ""}`}
                    onClick={() => setFilters(!filters)}
                    aria-expanded={filters}
                  >
                    <SlidersHorizontal size={16} />
                    filters
                  </button>
                </div>
                {filters && (
                  <div className="filter-row">
                    <Field label="applied after">
                      <input
                        type="date"
                        value={after}
                        onChange={(e) => setAfter(e.target.value)}
                      />
                    </Field>
                    <Field label="applied before">
                      <input
                        type="date"
                        value={before}
                        onChange={(e) => setBefore(e.target.value)}
                      />
                    </Field>
                    <Field label="remote / hybrid / on-site">
                      <select
                        value={arrangement}
                        onChange={(e) => setArrangement(e.target.value)}
                      >
                        <option value="">any</option>
                        {["Remote", "Hybrid", "On-site", "Unknown"].map((s) => (
                          <option key={s} value={s}>
                            {s.toLowerCase()}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="location">
                      <input
                        value={location}
                        placeholder="city, state, or country"
                        onChange={(e) => setLocation(e.target.value)}
                      />
                    </Field>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={salary}
                        onChange={(e) => setSalary(e.target.checked)}
                      />
                      has salary
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
                      clear filters
                    </button>
                  </div>
                )}
                {!applications.length ? (
                  <Empty
                    title="nothing here yet"
                    action={
                      <div className="empty-actions">
                        <button
                          className="button primary"
                          onClick={() => setAdding(true)}
                        >
                          <Plus size={16} />
                          add one
                        </button>
                        <button
                          className="button secondary"
                          onClick={() => setView("settings")}
                        >
                          set up gmail / links file
                        </button>
                      </div>
                    }
                  >
                    paste in a job link, or hook up gmail and it'll fill in from
                    emails.
                  </Empty>
                ) : !filtered.length ? (
                  <Empty title="nothing matches">
                    try a different search or loosen the filters.
                  </Empty>
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>company / role</th>
                          <th>stage</th>
                          <th>applied</th>
                          <th>location</th>
                          <th>pay</th>
                          <th>last activity</th>
                          <th>
                            <span className="sr-only">open</span>
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
                                      {a.company || "no company yet"}
                                    </strong>
                                    <span>
                                      {a.title || "no details yet"}
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
                                    : "?"}
                                  {a.appliedAt && a.dateBasis !== "user" && (
                                    <span
                                      title={`date is a guess (${a.dateBasis}), can fix it in details`}
                                      aria-label={`guessed date (${a.dateBasis})`}
                                    >
                                      {" "}
                                      ≈
                                    </span>
                                  )}
                                </span>
                              </td>
                              <td>
                                <span className="cell-primary">
                                  {a.location || "not listed"}
                                </span>
                                <small>
                                  {a.workArrangement !== "Unknown"
                                    ? a.workArrangement.toLowerCase()
                                    : ""}
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
                                  <small className="action-hint">to do</small>
                                )}
                              </td>
                              <td>
                                <button
                                  className="icon-button"
                                  aria-label={`open ${a.company || a.title || "application"}`}
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
                        prev
                      </button>
                      <span>
                        {currentPage} / {pageCount}
                      </span>
                      <button
                        disabled={currentPage >= pageCount}
                        onClick={() => setPage(currentPage + 1)}
                      >
                        next
                      </button>
                    </div>
                  )}
                  <span>≈ guessed date</span>
                </div>
              </section>
              <div className="bottom-note">
                <ShieldCheck size={14} />
                <span>
                  last gmail sync: {timeText(state.sync.lastSuccess)}.
                  {after || before
                    ? ` response rate covers ${after || "the start"} – ${before || "now"}.`
                    : " response rate covers everything with a date."}
                </span>
              </div>
            </>
          )}
          {view === "attention" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>to do</h1>
                  <p>assessments and interviews coming up</p>
                </div>
              </div>
              {!actions.length ? (
                <Empty title="nothing to do right now">
                  interview and assessment invites show up here once they're
                  matched to an application.
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
            setToast("added");
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
        aria-label={`applications per day, last 14 days: ${days.map((d) => `${d.date}: ${d.count}`).join(", ")}`}
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
        <span>today</span>
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
          {application?.company || "unknown company"}
          <ArrowUpRight size={14} />
        </button>
        <h3>{action.title.toLowerCase()}</h3>
        <p>{application?.title || "no details yet"}</p>
        <span className="due-label">
          {action.dueAt || "date not confirmed"}
          {action.timeZone ? ` · ${action.timeZone}` : " · time zone?"}
        </span>
        {editing && (
          <div className="action-edit">
            <Field label="date / time">
              <input
                value={due}
                onChange={(e) => setDue(e.target.value)}
                placeholder="2026-10-01 14:00"
              />
            </Field>
            <Field label="time zone">
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
              save
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
          done
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
          edit date
        </button>
        <button
          className="text-button muted"
          onClick={() => void change({ status: "dismissed" })}
        >
          dismiss
        </button>
      </div>
    </article>
  );
}
