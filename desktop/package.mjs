import { packager } from "@electron/packager";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./build.mjs";

if (process.platform !== "darwin")
  throw new Error("Build the macOS app on a Mac.");
const { version: electronVersion } = JSON.parse(
  await readFile(join(root, "node_modules/electron/package.json"), "utf8"),
);
const notarization = [
  process.env.APPLE_API_KEY,
  process.env.APPLE_API_KEY_ID,
  process.env.APPLE_API_ISSUER,
];
if (
  notarization.some(Boolean) &&
  (!notarization.every(Boolean) || !process.env.APPLE_SIGN_IDENTITY)
)
  throw new Error(
    "Notarization requires APPLE_SIGN_IDENTITY and all three APPLE_API_* variables.",
  );
const paths = await packager({
  dir: root,
  out: join(root, "out"),
  platform: "darwin",
  arch: process.arch,
  electronVersion,
  overwrite: true,
  name: "Fieldwork",
  executableName: "Fieldwork",
  appBundleId: "local.fieldwork.tracker",
  appCategoryType: "public.app-category.productivity",
  icon: join(root, ".desktop-build/Fieldwork.icns"),
  // ASAR uses matchBase: a basename glob also matches inside .desktop-build.
  asar: { unpack: "*.node" },
  // Explicit allowlist, plus packager's production-dependency pruning.
  // No source, .env, databases, test fixtures, signing keys, or link files.
  ignore: (path) =>
    path !== "" &&
    !/^\/(package\.json$|node_modules(?:\/|$)|dist(?:\/|$)|\.desktop-build(?:\/|$))/.test(
      path,
    ),
  ...(process.env.APPLE_SIGN_IDENTITY
    ? { osxSign: { identity: process.env.APPLE_SIGN_IDENTITY } }
    : {
        osxSign: {
          identity: "-",
          identityValidation: false,
          preAutoEntitlements: false,
          preEmbedProvisioningProfile: false,
          optionsForFile: () => ({ timestamp: "none", hardenedRuntime: false }),
        },
      }),
  ...(notarization.every(Boolean)
    ? {
        osxNotarize: {
          appleApiKey: process.env.APPLE_API_KEY,
          appleApiKeyId: process.env.APPLE_API_KEY_ID,
          appleApiIssuer: process.env.APPLE_API_ISSUER,
        },
      }
    : {}),
});
for (const path of paths) {
  await access(
    join(
      path,
      "Fieldwork.app/Contents/Resources/app.asar.unpacked/.desktop-build/notification-permissions.node",
    ),
  );
  console.log(`Packaged: ${path}/Fieldwork.app`);
}
