import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createRequire } from "node:module";
import { root } from "./build.mjs";

const require = createRequire(import.meta.url);
const executable = join(
  root,
  "out",
  `Fieldwork-darwin-${process.arch}`,
  "Fieldwork.app/Contents/MacOS/Fieldwork",
);
execFileSync(
  process.execPath,
  [
    require.resolve("@playwright/test/cli"),
    "test",
    "--config=playwright.desktop.config.ts",
    "--grep",
    "desktop tray|Mac notification",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, FIELDWORK_PACKAGED_EXECUTABLE: executable },
  },
);
