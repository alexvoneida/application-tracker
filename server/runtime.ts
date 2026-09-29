import { createServer } from "node:http";
import { join } from "node:path";
import { existsSync } from "node:fs";
import express from "express";
import { Store, Vault } from "./store.ts";
import { Tracker } from "./tracker.ts";
import { createApi } from "./api.ts";
import { localDate } from "../shared/model.ts";

export interface ServerOptions {
  directory: string;
  root: string;
  port?: number;
  production?: boolean;
  vault?: Vault;
  onOAuthComplete?: (connected: boolean) => void;
  onDiscover?: import("./discovery").DiscoveryNotify;
}

// Shared by the CLI and desktop. No signals, process.exit, or cwd-relative assets.
export async function startServer(options: ServerOptions) {
  const production = options.production ?? true;
  const index = join(options.root, "dist", "index.html");
  if (production && !existsSync(index))
    throw new Error("run npm run build first");
  const store = new Store(options.directory);
  const vault = options.vault ?? new Vault(options.directory);
  const start = new Date();
  start.setDate(start.getDate() - 90);
  const tracker = new Tracker(store, vault, {
    linksFile: process.env.TRACKER_LINKS_FILE || "",
    importAfter: localDate(start),
    gmailQuery:
      '{application applied applying interview assessment "coding challenge" "take home" recruiter "job offer" "position closed"}',
    syncMinutes: 5,
    aiEnabled: false,
    aiProvider: "claude-code",
    aiModel: "claude-haiku-4-5",
    aiBaseUrl: "https://api.openai.com/v1",
    claudeCodePath: "",
    autoApplyAI: false,
  });
  const host = express();
  const server = createServer(host);
  let closeVite: (() => Promise<void>) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No local port.");
    const origin = `http://127.0.0.1:${address.port}`;
    const { app, gmail, discovery } = createApi(
      tracker,
      origin,
      production,
      options.onOAuthComplete,
      options.onDiscover,
    );
    host.use(app);
    if (production) {
      app.use(express.static(join(options.root, "dist")));
      app.get("/{*path}", (_req, res) => res.sendFile(index));
    } else {
      const { createServer: createVite } = await import("vite");
      const vite = await createVite({
        root: options.root,
        server: { middlewareMode: true, hmr: false },
        appType: "spa",
      });
      closeVite = () => vite.close();
      app.use(vite.middlewares);
    }
    const watchTimer = setInterval(() => void tracker.scanFile(), 2000);
    const discoveryTimer = setInterval(() => void discovery.tick(), 10000);
    void discovery.tick();
    let lastAttempt = 0;
    const syncTimer = setInterval(() => {
      if (
        vault.get("gmailTokens") &&
        !tracker.sync.running &&
        Date.now() - lastAttempt > tracker.settings().syncMinutes * 60000
      ) {
        lastAttempt = Date.now();
        void gmail.sync();
      }
    }, 10000);
    void tracker.scanFile();
    tracker.resumeEnrichment();
    let stopping: Promise<void> | undefined;
    return {
      origin,
      tracker,
      discovery,
      stop() {
        return (stopping ??= (async () => {
          clearInterval(watchTimer);
          clearInterval(syncTimer);
          clearInterval(discoveryTimer);
          discovery.stop();
          tracker.stop();
          gmail.cancel();
          // Drain accepted HTTP work and background writes before closing SQLite.
          await Promise.all([
            new Promise<void>((resolve) => server.close(() => resolve())),
            closeVite?.(),
          ]);
          await tracker.idle();
          await discovery.idle();
          store.close();
        })());
      },
    };
  } catch (error) {
    server.close();
    await closeVite?.();
    store.close();
    throw error;
  }
}
