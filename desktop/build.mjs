import { build } from "esbuild";
import sharp from "sharp";
import { mkdir, access, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Shown in Finder, the Dock, and the menu bar; file names use the dashed form.
// The internal app name (data folder, Keychain entry) stays "Fieldwork", which
// is also why package.json's productName is still "Fieldwork".
export const appName = "application tracker";
export const artifactName = "application-tracker";
export async function buildDesktop() {
  const output = join(root, ".desktop-build");
  await mkdir(output, { recursive: true });
  await Promise.all([
    build({
      entryPoints: [join(root, "desktop/main.ts")],
      outfile: join(output, "main.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      packages: "external",
    }),
    build({
      entryPoints: [join(root, "desktop/preload.ts")],
      outfile: join(output, "preload.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["electron"],
    }),
    sharp(join(root, "desktop/tray.svg"))
      .resize(18, 18)
      .png()
      .toFile(join(output, "trayTemplate.png")),
    sharp(join(root, "desktop/tray.svg"))
      .resize(36, 36)
      .png()
      .toFile(join(output, "trayTemplate@2x.png")),
  ]);
  if (process.platform === "darwin") {
    // Stable Node-API ABI works with Electron without rebuilding against V8.
    const nodeHeaders =
      process.env.FIELDWORK_NODE_HEADERS ||
      join(dirname(dirname(await realpath(process.execPath))), "include/node");
    await access(join(nodeHeaders, "node_api.h")).catch(() => {
      throw new Error(
        "Node-API headers missing. Install Node with headers or set FIELDWORK_NODE_HEADERS to its include/node directory.",
      );
    });
    execFileSync("xcrun", [
      "clang++",
      "-std=c++17",
      "-fobjc-arc",
      "-fblocks",
      "-bundle",
      "-undefined",
      "dynamic_lookup",
      "-DNAPI_VERSION=8",
      "-I",
      nodeHeaders,
      "-framework",
      "Foundation",
      "-framework",
      "UserNotifications",
      join(root, "desktop/notification-permissions.mm"),
      "-o",
      join(output, "notification-permissions.node"),
    ]);
    const iconset = join(output, "Fieldwork.iconset");
    await mkdir(iconset, { recursive: true });
    await Promise.all(
      [16, 32, 128, 256, 512].flatMap((size) =>
        [1, 2].map((scale) =>
          sharp(join(root, "desktop/icon.svg"))
            .resize(size * scale, size * scale)
            .png()
            .toFile(
              join(
                iconset,
                `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`,
              ),
            ),
        ),
      ),
    );
    execFileSync("iconutil", [
      "--convert",
      "icns",
      "--output",
      join(output, "Fieldwork.icns"),
      iconset,
    ]);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildDesktop();
