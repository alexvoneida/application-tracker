import type {
  Action,
  Application,
  Event,
  Settings,
  Source,
  SyncState,
  BackfillState,
  Snapshot,
} from "../shared/model";
export type State = {
  csrf: string;
  applications: Application[];
  events: Event[];
  actions: Action[];
  review: Source[];
  settings: Settings;
  sync: SyncState;
  backfill: BackfillState;
  connection: {
    account: string;
    connected: boolean;
    googleConfigured: boolean;
    aiConfigured: boolean;
    aiUsage: { at: string; model: string; tokens: number | null } | null;
  };
  canUndoMerge: boolean;
};
export type Detail = {
  application: Application;
  events: Event[];
  snapshots: Snapshot[];
  sources: Source[];
  actions: Action[];
};
let token = "";
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Tracker-Token": token },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).catch(() => {
    throw new Error("couldn't reach the server");
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "something went wrong");
  if (data.csrf) token = data.csrf;
  return data;
}
export const dateText = (value: string) =>
  value
    ? new Date(
        value.length === 10 ? `${value}T12:00:00` : value,
      ).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "no date";
export const timeText = (value: string) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "never";
export function since(value: string) {
  if (!value) return "—";
  const days = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 86400000),
  );
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}
export const safeLink = (url: string) => {
  try {
    const u = new URL(url);
    return ["https:", "http:"].includes(u.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
};
