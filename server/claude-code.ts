import { UserError } from "./errors.ts";
import {
  execFile,
  type ChildProcess,
  type ExecFileException,
} from "node:child_process";
import { dirname } from "node:path";
import { discover } from "switchboard-ai-sdk";

let pathedBinary = "";
const running = new Set<ChildProcess>();

// The CLI is spawned by name, inheriting this process's PATH. A packaged macOS
// app launched from Finder gets a minimal PATH that omits the usual install
// locations, so the configured binary's directory is prepended here.
function ensureOnPath(binary: string) {
  if (!binary || binary === pathedBinary) return;
  const directory = dirname(binary);
  const entries = (process.env.PATH || "").split(":");
  if (!entries.includes(directory))
    process.env.PATH = [directory, ...entries].join(":");
  pathedBinary = binary;
}

export function resetClaudeCode() {
  pathedBinary = "";
}

// Children outlive a force-quit parent, so shutdown ends them explicitly.
export function stopClaudeCode() {
  for (const child of running) child.kill();
}

export async function claudeCodeStatus(binary: string) {
  ensureOnPath(binary);
  const tools = await discover();
  return tools.find((t) => t.id === "claude-code");
}

// switchboard-ai-sdk's own chat path cannot read Claude Code 2.x output: it
// passes --verbose, which makes the CLI emit an array of events, then reads
// `.result` off the parsed array. The CLI is invoked directly instead.
// --restricted, --tools and --strict-mcp-config drop the agent harness the
// extraction has no use for, cutting a call from ~22k input tokens to ~400.
function args(system: string, content: string, model: string) {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--max-turns",
    "1",
    "--restricted",
    "--tools",
    "",
    "--strict-mcp-config",
    "--system-prompt",
    system,
    "--",
    content,
  ];
}

export async function claudeCodeExtract(
  system: string,
  content: string,
  model: string,
  binary: string,
  timeoutMs = 120000,
): Promise<unknown> {
  ensureOnPath(binary);
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      binary || "claude",
      args(system, content, model),
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 10_000_000 },
      (error, out, stderr) => {
        running.delete(child);
        if (!error) return resolve(out);
        reject(new UserError(spawnMessage(error, stderr)));
      },
    );
    running.add(child);
  });
  return parseJsonObject(resultText(stdout));
}

export function resultText(stdout: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    throw new UserError(
      "claude code sent back something unreadable, try again",
    );
  }
  const final = Array.isArray(payload) ? payload[payload.length - 1] : payload;
  const record = (final ?? {}) as Record<string, unknown>;
  if (record.is_error)
    throw new UserError(claudeCodeMessage(String(record.result ?? "")));
  if (typeof record.result !== "string" || !record.result)
    throw new UserError("claude code didn't return anything, try again");
  return record.result;
}

// A JSON system prompt is a request, not a guarantee: Claude Code may still
// wrap the object in a fenced block or a sentence of preamble.
export function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start)
    throw new UserError(
      "claude code didn't return json. try again or fix it by hand",
    );
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new UserError(
      "claude code returned broken json. try again or fix it by hand",
    );
  }
}

function claudeCodeMessage(text: string) {
  if (/usage limit|rate limit|quota/i.test(text))
    return "hit the claude code usage limit. wait for it to reset or switch providers in settings";
  if (/auth|login|unauthorized|not logged in/i.test(text))
    return "claude code isn't signed in. run `claude` in a terminal to sign in, then try again";
  return `claude code failed: ${text.slice(0, 200)}`;
}

function spawnMessage(error: ExecFileException, stderr: string) {
  if (error.code === "ENOENT")
    return "can't find claude code. install it or set its path in settings";
  if (error.killed)
    return "claude code timed out. try again or pick a smaller model in settings";
  return claudeCodeMessage(stderr || error.message);
}
