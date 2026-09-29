import {
  OAuth2Client,
  CodeChallengeMethod,
  type Credentials,
} from "google-auth-library";
import { randomBytes } from "node:crypto";
import { htmlText } from "./extraction.ts";
import type { Tracker } from "./tracker.ts";

type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
};
export function messageText(payload: GmailPart): string {
  const plain: string[] = [];
  const html: string[] = [];
  const visit = (part: GmailPart) => {
    if (part.filename) return;
    if (part.body?.data) {
      const text = Buffer.from(part.body.data, "base64url").toString("utf8");
      if (part.mimeType === "text/plain") plain.push(text);
      else if (part.mimeType === "text/html") html.push(htmlText(text));
    }
    part.parts?.forEach(visit);
  };
  visit(payload);
  return (plain.length ? plain : html).join("\n").slice(0, 50000);
}
export class Gmail {
  private pending = new Map<string, { verifier: string; expires: number }>();
  private generation = 0;
  private reconcileQueued = false;
  constructor(
    private tracker: Tracker,
    private origin: string,
  ) {}
  client(persistRefresh = true) {
    const vault = this.tracker.vault;
    const client = new OAuth2Client({
      clientId: process.env.GOOGLE_CLIENT_ID || vault.get("googleClientId"),
      clientSecret:
        process.env.GOOGLE_CLIENT_SECRET || vault.get("googleClientSecret"),
      redirectUri: `${this.origin}/oauth/callback`,
    });
    const raw = vault.get("gmailTokens");
    if (raw) client.setCredentials(JSON.parse(raw));
    const generation = this.generation;
    if (persistRefresh)
      client.on("tokens", (tokens) => {
        if (generation !== this.generation) return;
        const existing: Credentials = JSON.parse(
          vault.get("gmailTokens") || "{}",
        );
        vault.set("gmailTokens", JSON.stringify({ ...existing, ...tokens }));
      });
    return client;
  }
  async authorize() {
    if (!(
      process.env.GOOGLE_CLIENT_ID || this.tracker.vault.get("googleClientId")
    ))
      throw new Error(
        "Save your Google Desktop OAuth client ID and secret in Settings first.",
      );
    this.pending.clear();
    const client = this.client();
    const codes = await client.generateCodeVerifierAsync();
    const state = randomBytes(24).toString("hex");
    this.pending.set(state, {
      verifier: codes.codeVerifier,
      expires: Date.now() + 10 * 60000,
    });
    return client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/gmail.readonly"],
      state,
      code_challenge: codes.codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
  }
  async callback(code: string, state: string) {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expires < Date.now() || !code)
      throw new Error(
        "Authorization expired. Return to Settings and connect again.",
      );
    const client = this.client(false);
    const generation = this.generation;
    const { tokens } = await client.getToken({
      code,
      codeVerifier: pending.verifier,
    });
    if (
      !tokens.scope
        ?.split(" ")
        .includes("https://www.googleapis.com/auth/gmail.readonly")
    )
      throw new Error("Read-only Gmail permission was not granted.");
    client.setCredentials(tokens);
    const response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok)
      throw new Error(
        "Could not verify this Gmail connection. Check that Gmail API is enabled.",
      );
    const profile = (await response.json()) as { emailAddress: string };
    if (
      profile.emailAddress !== this.tracker.store.setting("gmailAccount", "")
    ) {
      this.tracker.store.set("lastSync", "");
      this.tracker.sync.lastSuccess = "";
    }
    if (generation !== this.generation)
      throw new Error("Gmail disconnected during authorization.");
    this.tracker.vault.set("gmailTokens", JSON.stringify(tokens));
    this.tracker.store.set("gmailAccount", profile.emailAddress);
    this.tracker.sync.error = "";
  }
  async disconnect() {
    this.generation++;
    this.pending.clear();
    this.reconcileQueued = false;
    const raw = this.tracker.vault.get("gmailTokens");
    this.tracker.vault.set("gmailTokens", "");
    this.tracker.store.set("gmailAccount", "");
    this.tracker.sync.error = "";
    if (raw) {
      const token = JSON.parse(raw).refresh_token;
      if (token) {
        try {
          await fetch("https://oauth2.googleapis.com/revoke", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token }),
            signal: AbortSignal.timeout(10000),
          });
        } catch {
          /* local connection is already removed */
        }
      }
    }
  }
  cancel() {
    this.generation++;
    this.pending.clear();
  }
  private async get(path: string, generation: number): Promise<any> {
    if (
      generation !== this.generation ||
      !this.tracker.vault.get("gmailTokens")
    )
      throw new Error("Gmail disconnected.");
    const client = this.client();
    let accessToken: string | null | undefined;
    try {
      accessToken = (await client.getAccessToken()).token;
    } catch {
      throw new Error(
        "Gmail authorization expired or was revoked. Reconnect in Settings.",
      );
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (generation !== this.generation)
        throw new Error("Gmail disconnected.");
      const response = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(25000),
        },
      );
      if (response.ok) return response.json();
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const delay = Math.min(
          5000,
          Math.max(
            1000 * 2 ** attempt,
            Number(response.headers.get("retry-after") || 0) * 1000,
          ),
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (response.status === 401)
        throw new Error("Gmail authorization expired. Reconnect in Settings.");
      throw new Error(
        `Gmail returned HTTP ${response.status}. Check API access or retry later.`,
      );
    }
  }
  async sync(full = false, prune = false) {
    if (this.tracker.sync.running) {
      if (prune) this.reconcileQueued = true;
      return;
    }
    if (!this.tracker.vault.get("gmailTokens"))
      throw new Error("Connect Gmail in Settings first.");
    const generation = this.generation;
    const state = this.tracker.sync;
    state.running = true;
    state.error = "";
    state.processed = 0;
    state.discovered = 0;
    const started = new Date().toISOString();
    const account = this.tracker.store.setting("gmailAccount", "");
    try {
      const settings = this.tracker.settings();
      const initial = Math.floor(
        new Date(`${settings.importAfter}T00:00:00`).getTime() / 1000,
      );
      const since =
        !full && !prune && state.lastSuccess
          ? Math.max(
              initial,
              Math.floor(Date.parse(state.lastSuccess) / 1000) - 86400,
            )
          : initial;
      const query = `after:${since} -in:spam -in:trash (${settings.gmailQuery})`;
      let pageToken = "";
      let failures = 0;
      const matched = prune ? new Set<string>() : null;
      do {
        const params = new URLSearchParams({ q: query, maxResults: "100" });
        if (pageToken) params.set("pageToken", pageToken);
        const page = await this.get(`messages?${params}`, generation);
        const refs: { id: string; threadId: string }[] = page.messages || [];
        state.discovered += refs.length;
        for (const ref of refs) matched?.add(`${account}:${ref.id}`);
        for (const ref of refs) {
          if (generation !== this.generation)
            throw new Error("Gmail disconnected.");
          if (this.tracker.store.get("sources", `${account}:${ref.id}`)) {
            state.processed++;
            continue;
          }
          try {
            const message = await this.get(
              `messages/${encodeURIComponent(ref.id)}?format=full`,
              generation,
            );
            if (generation !== this.generation)
              throw new Error("Gmail disconnected.");
            const header = (name: string) =>
              message.payload?.headers?.find(
                (h: { name: string }) => h.name.toLowerCase() === name,
              )?.value || "";
            await this.tracker.ingestMessage(
              {
                account,
                messageId: ref.id,
                threadId: ref.threadId,
                subject: header("subject"),
                from: header("from"),
                receivedAt: new Date(
                  Number(message.internalDate),
                ).toISOString(),
                body: messageText(message.payload || {}),
              },
              false,
              () => generation !== this.generation,
            );
          } catch {
            failures++;
          }
          state.processed++;
        }
        pageToken = page.nextPageToken || "";
      } while (pageToken);
      if (generation !== this.generation)
        throw new Error("Gmail disconnected.");
      if (matched) this.tracker.pruneReview(account, matched);
      if (failures)
        throw new Error(
          `${failures} messages could not be read. Sync again to retry; the sync checkpoint was preserved.`,
        );
      if (generation !== this.generation)
        throw new Error("Gmail disconnected.");
      state.lastSuccess = started;
      this.tracker.store.set("lastSync", started);
      const failed = this.tracker.store
        .all("sources")
        .filter((s) => s.state === "failed").length;
      if (failed)
        state.error = `${failed} messages need extraction retry in Review.`;
    } catch (error) {
      state.error =
        error instanceof Error
          ? error.message
          : "Gmail sync failed. Retry later.";
    } finally {
      state.running = false;
      if (this.reconcileQueued && generation === this.generation) {
        this.reconcileQueued = false;
        this.sync(true, true).catch(() => {
          state.error = "Gmail sync failed. Retry later.";
        });
      }
    }
  }
}
