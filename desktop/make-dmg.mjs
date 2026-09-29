// Use macOS's own disk image tool; no legacy image parser dependencies.
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { root } from "./build.mjs";

if (process.platform !== "darwin")
  throw new Error("Build the Mac installer on macOS.");
const { version } = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const stage = await mkdtemp(join(tmpdir(), "fieldwork-dmg-"));
try {
  await cp(
    join(root, "out", `Fieldwork-darwin-${process.arch}`, "Fieldwork.app"),
    join(stage, "Fieldwork.app"),
    { recursive: true, verbatimSymlinks: true },
  );
  await symlink("/Applications", join(stage, "Applications"));
  await mkdir(join(root, "out/make"), { recursive: true });
  const zip = join(
    root,
    "out/make",
    `Fieldwork-${version}-${process.arch}.zip`,
  );
  execFileSync("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    join(stage, "Fieldwork.app"),
    zip,
  ]);
  console.log(`ZIP: ${zip}`);
  const destination = join(
    root,
    "out/make",
    `Fieldwork-${version}-${process.arch}.dmg`,
  );
  execFileSync(
    "hdiutil",
    [
      "create",
      "-volname",
      "Fieldwork",
      "-srcfolder",
      stage,
      "-ov",
      "-format",
      "UDZO",
      destination,
    ],
    { stdio: "inherit" },
  );
  console.log(`Installer: ${destination}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
