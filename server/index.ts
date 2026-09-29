import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { startServer } from "./runtime.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
process.umask(0o077);
const port = Number(process.env.PORT || 3210);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PORT has to be between 1024 and 65535");
const directory = resolve(process.env.TRACKER_DATA_DIR || ".data");
const runtime = await startServer({
  directory,
  port,
  root: process.cwd(),
  production: process.argv.includes("--production"),
});
console.log(
  `application tracker is running at ${runtime.origin}\ndata: ${directory}`,
);
let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  await runtime.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
