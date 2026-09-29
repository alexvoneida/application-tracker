import { randomUUID } from "node:crypto";
import { workerConfigSchema } from "../shared/discovery.ts";
import { Discovery, matchDiscovery } from "./discovery.ts";
import { boardFromUrl } from "./discovery-providers.ts";
import { Store } from "./store.ts";
import { publicRequest } from "./network.ts";
import {
  TelegramOutbox,
  telegramCredentialsSchema,
  type TelegramCredentials,
} from "./telegram.ts";

export function startCloudWorker(
  directory: string,
  input: unknown,
  credentials: TelegramCredentials,
  request = publicRequest,
) {
  const config = workerConfigSchema.parse(input);
  telegramCredentialsSchema.parse(credentials);
  if (config.boards.some((b) => !boardFromUrl(b.url)))
    throw new Error("Invalid job board in worker configuration.");
  const store = new Store(directory);
  const owner = randomUUID();
  try {
    store.transaction(() => {
      const lease = store.setting("workerLease", { owner: "", until: 0 });
      if (lease.until > Date.now())
        throw new Error(
          "Another worker owns this data directory. Stop it or wait two minutes after an unclean shutdown.",
        );
      store.set("workerLease", { owner, until: Date.now() + 120000 });
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const outbox = new TelegramOutbox(store, credentials, request);
  // No Tracker, Vault, Gmail polling, web server, or application records loaded.
  const discovery = new Discovery(
    {
      store,
      apps: () => [],
      create: () => {
        throw new Error("Applications are recorded in the desktop app only.");
      },
    },
    request,
    undefined,
    (jobs) => outbox.enqueue(jobs),
  );
  discovery.configure(config.config);
  discovery.enableSource("github:simplify", config.githubEnabled);
  for (const board of config.boards) {
    const source = discovery.addBoard(board.url, board.name);
    discovery.enableSource(source.id, board.enabled);
  }
  let closed = false;
  let stopping: Promise<void> | undefined;
  let lastLog = 0;
  let active: Promise<void> | undefined;
  let scan: Promise<void> | undefined;
  const tick = () =>
    (active ??= (async () => {
      if (closed) return;
      // A slow company board must not hold up alerts already queued by another.
      scan ??= discovery
        .tick()
        .then(() => {
          store.set("workerLastCycle", new Date().toISOString());
        })
        .catch(() => {
          console.error(
            "Discovery scan failed; previous source data retained.",
          );
        })
        .finally(() => {
          scan = undefined;
        });
      const jobs = new Map(discovery.jobs().map((j) => [j.id, j]));
      await outbox.tick((id) => {
        const job = jobs.get(id);
        return (
          !!job &&
          config.config.enabled &&
          config.config.notifications &&
          !job.closed &&
          !matchDiscovery(job, config.config).length
        );
      });
      if (Date.now() - lastLog > 300000) {
        lastLog = Date.now();
        // Operational metadata only. Never print tokens, messages, or request URLs.
        console.log(
          JSON.stringify({
            event: "worker-health",
            sources: discovery.sources().length,
            sourceErrors: discovery
              .sources()
              .filter((s) => s.error && s.enabled).length,
            pending: outbox.items().filter((i) => i.state === "pending").length,
            deliveryIssues: outbox
              .items()
              .filter((i) => ["failed", "uncertain"].includes(i.state)).length,
          }),
        );
      }
    })()
      .catch(() => {
        console.error(
          "Worker cycle failed; inspect source health with npm run worker:status.",
        );
      })
      .finally(() => {
        active = undefined;
      }));
  const stop = () =>
    (stopping ??= (async () => {
      closed = true;
      clearInterval(timer);
      clearInterval(heartbeat);
      discovery.stop();
      outbox.stop();
      await active;
      await scan;
      await discovery.idle();
      await outbox.idle();
      if (store.setting("workerLease", { owner: "" }).owner === owner)
        store.set("workerLease", { owner: "", until: 0 });
      store.close();
    })());
  const heartbeat = setInterval(() => {
    if (store.setting("workerLease", { owner: "" }).owner !== owner) {
      void stop();
      return;
    }
    store.set("workerLease", { owner, until: Date.now() + 120000 });
    store.set("workerHeartbeat", new Date().toISOString());
  }, 10000);
  const timer = setInterval(() => void tick(), 3000);
  store.set("workerHeartbeat", new Date().toISOString());
  void tick();
  return { discovery, outbox, stop };
}
