import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { startCloudWorker } from "./cloud-worker.ts";

try {
  const configPath = resolve(
    process.env.DISCOVERY_CONFIG_FILE || "fieldwork-worker.json",
  );
  if (statSync(configPath).size > 2_000_000)
    throw new Error("Configuration too large.");
  const worker = startCloudWorker(
    resolve(process.env.WORKER_DATA_DIR || ".worker-data"),
    JSON.parse(readFileSync(configPath, "utf8")),
    {
      token: process.env.TELEGRAM_BOT_TOKEN || "",
      chatId: process.env.TELEGRAM_CHAT_ID || "",
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void worker.stop().then(() => process.exit(0));
    });
  console.log(
    "Fieldwork discovery worker started. No Gmail or application-history access. First checks establish quiet baselines.",
  );
} catch {
  console.error(
    "Worker could not start. Check configuration JSON, supported board URLs, TELEGRAM_BOT_TOKEN, positive private TELEGRAM_CHAT_ID, and writable persistent storage. Only one worker may use a data directory; after a crash wait two minutes for its lease to expire.",
  );
  process.exitCode = 1;
}
