import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createRequire } from "node:module";
import { root, appName, artifactName } from "./build.mjs";

const require = createRequire(import.meta.url);
const executable = join(
  root,
  "out",
  `${appName}-darwin-${process.arch}`,
  `${appName}.app/Contents/MacOS/${artifactName}`,
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
