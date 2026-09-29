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
        reject(new Error(spawnMessage(error, stderr)));
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
    throw new Error("Claude Code returned unreadable output. Retry.");
  }
  const final = Array.isArray(payload) ? payload[payload.length - 1] : payload;
  const record = (final ?? {}) as Record<string, unknown>;
  if (record.is_error)
    throw new Error(claudeCodeMessage(String(record.result ?? "")));
  if (typeof record.result !== "string" || !record.result)
    throw new Error("Claude Code returned no result. Retry.");
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
    throw new Error(
      "Claude Code did not return a JSON object. Retry or correct the record manually.",
    );
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new Error(
      "Claude Code returned malformed JSON. Retry or correct the record manually.",
    );
  }
}

function claudeCodeMessage(text: string) {
  if (/usage limit|rate limit|quota/i.test(text))
    return "Claude Code usage limit reached. Wait for your quota window to reset, or switch providers in Settings.";
  if (/auth|login|unauthorized|not logged in/i.test(text))
    return "Claude Code is not signed in. Run `claude` in a terminal and sign in, then retry.";
  return `Claude Code failed: ${text.slice(0, 200)}`;
}

function spawnMessage(error: ExecFileException, stderr: string) {
  if (error.code === "ENOENT")
    return "Claude Code was not found. Install it, or set its full path in Settings.";
  if (error.killed)
    return "Claude Code timed out. Retry, or choose a smaller model in Settings.";
  return claudeCodeMessage(stderr || error.message);
}
