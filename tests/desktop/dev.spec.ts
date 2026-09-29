import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("desktop development restarts on a frontend source edit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fieldwork-dev-watch-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRACKER_DESKTOP_DATA_DIR: directory,
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    OPENAI_API_KEY: "",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, ["desktop/dev.mjs"], {
    cwd: resolve("."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  try {
    await expect
      .poll(() => output.split("Fieldwork desktop ready.").length - 1, {
        message: "Vite-backed desktop should start",
        timeout: 20000,
      })
      .toBe(1);
    const source = resolve("src/styles.css");
    const stat = statSync(source);
    // Notify the watcher without changing any source contents.
    utimesSync(source, stat.atime, new Date());
    await expect
      .poll(() => output.split("Fieldwork desktop ready.").length - 1, {
        message: "Source edit should restart the desktop",
        timeout: 20000,
      })
      .toBe(2);
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit");
      child.kill("SIGTERM");
      await closed;
    }
  }
});
