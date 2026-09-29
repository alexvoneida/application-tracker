import { DatabaseSync } from "node:sqlite";
import { resolve, join } from "node:path";

try {
  const db = new DatabaseSync(
    join(
      resolve(process.env.WORKER_DATA_DIR || ".worker-data"),
      "tracker.sqlite",
    ),
    { readOnly: true },
  );
  const setting = (id: string) => {
    const row = db.prepare("SELECT data FROM settings WHERE id=?").get(id);
    return row ? JSON.parse(row.data as string) : null;
  };
  const sources = db
    .prepare("SELECT data FROM discovery_sources")
    .all()
    .map((row) => JSON.parse(row.data as string));
  const deliveries = db
    .prepare("SELECT data FROM telegram_outbox")
    .all()
    .map((row) => JSON.parse(row.data as string));
  const heartbeat = setting("workerHeartbeat");
  const lastCycle = setting("workerLastCycle");
  const live =
    Date.now() - Date.parse(heartbeat) < 120000 &&
    setting("workerLease")?.until > Date.now();
  const responsive = Date.now() - Date.parse(lastCycle || heartbeat) < 600000;
  console.log(
    JSON.stringify(
      {
        live,
        responsive,
        heartbeat,
        lastCycle,
        sources: sources.map(
          ({ name, lastSuccess, nextCheck, error, enabled }) => ({
            name,
            lastSuccess,
            nextCheck,
            error,
            enabled,
          }),
        ),
        deliveryCounts: Object.fromEntries(
          ["pending", "sent", "failed", "uncertain", "expired"].map((state) => [
            state,
            deliveries.filter((i) => i.state === state).length,
          ]),
        ),
      },
      null,
      2,
    ),
  );
  db.close();
  process.exitCode = live && responsive ? 0 : 1;
} catch {
  console.error(
    "Worker status unavailable. Check WORKER_DATA_DIR and whether the worker has started.",
  );
  process.exitCode = 1;
}
