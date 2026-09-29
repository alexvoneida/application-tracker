import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import electron from "electron";
import { root, buildDesktop } from "./build.mjs";

let child;
let restarting = false;
let pending = false;
let stopping = false;
let debounce;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
async function stopChild() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "exit");
    child.kill("SIGTERM");
    await closed;
  }
}
async function restart() {
  if (stopping) return;
  if (restarting) {
    pending = true;
    return;
  }
  restarting = true;
  try {
    await stopChild();
    await buildDesktop();
    if (stopping) return;
    child = spawn(electron, [root, "--desktop-dev"], {
      cwd: root,
      env,
      stdio: "inherit",
    });
    child.on("error", (error) => console.error(error.message));
    console.log(
      "dev app started. edits rebuild and restart it, data is kept. ctrl+c to stop.",
    );
  } catch (error) {
    console.error(error);
  } finally {
    restarting = false;
    if (pending && !stopping) {
      pending = false;
      void restart();
    }
  }
}
const watchers = ["desktop", "server", "shared", "src"].map((path) =>
  watch(join(root, path), { recursive: true }, (_event, filename) => {
    if (!filename || !/\.(ts|tsx|css|svg|mjs)$/.test(filename)) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => void restart(), 350);
  }),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(debounce);
    watchers.forEach((watcher) => watcher.close());
    await stopChild();
  });
await restart();
