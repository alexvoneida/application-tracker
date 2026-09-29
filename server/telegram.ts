import { z } from "zod";
import type { Store } from "./store.ts";
import type { DiscoveredJob } from "../shared/discovery.ts";
import { publicRequest } from "./network.ts";

export const telegramCredentialsSchema = z.object({
  token: z.string().regex(/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/),
  // Personal alerts only. No group/channel broadcasting or arbitrary usernames.
  chatId: z.string().regex(/^[1-9]\d{0,19}$/),
});
export type TelegramCredentials = z.infer<typeof telegramCredentialsSchema>;
export type Delivery = {
  id: string;
  text: string;
  url: string;
  created: number;
  next: number;
  attempts: number;
  state: "pending" | "sending" | "sent" | "failed" | "uncertain" | "expired";
  error: string;
};

export class TelegramOutbox {
  private active?: Promise<void>;
  private controller = new AbortController();
  constructor(
    private store: Store,
    private credentials: TelegramCredentials,
    private request = publicRequest,
  ) {
    telegramCredentialsSchema.parse(credentials);
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS telegram_outbox (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)))",
    );
    // A crash after sending but before recording success is ambiguous. Telegram
    // has no sendMessage idempotency key; never blindly duplicate these messages.
    for (const item of this.items().filter((i) => i.state === "sending"))
      this.put({
        ...item,
        state: "uncertain",
        error:
          "Worker stopped during delivery; check Telegram. Not automatically resent.",
      });
  }
  items(): Delivery[] {
    return this.store.db
      .prepare("SELECT data FROM telegram_outbox")
      .all()
      .map((row) => JSON.parse(row.data as string));
  }
  private put(item: Delivery) {
    this.store.db
      .prepare(
        "INSERT INTO telegram_outbox VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(item.id, JSON.stringify(item));
  }
  enqueue(jobs: DiscoveredJob[]) {
    const insert = this.store.db.prepare(
      "INSERT OR IGNORE INTO telegram_outbox VALUES (?,?)",
    );
    for (const job of jobs) {
      const text = [
        `new match: ${job.company.slice(0, 200)}`,
        job.title.slice(0, 300),
        job.location.slice(0, 300) || "location not listed",
        job.salary.slice(0, 200) || "no salary listed",
        `found ${job.firstSeenAt}`,
        "apply link below",
      ].join("\n");
      const item: Delivery = {
        id: job.id,
        text,
        url: job.url,
        created: Date.now(),
        next: 0,
        attempts: 0,
        state: "pending",
        error: "",
      };
      insert.run(item.id, JSON.stringify(item));
    }
  }
  tick(eligible: (id: string) => boolean = () => true) {
    if (this.controller.signal.aborted) return Promise.resolve();
    return (this.active ??= this.deliver(eligible).finally(() => {
      this.active = undefined;
    }));
  }
  private async deliver(eligible: (id: string) => boolean) {
    const now = Date.now();
    if (this.store.setting("telegramNextSend", 0) > now) return;
    const item = this.items()
      .filter((i) => i.state === "pending" && i.next <= now)
      .sort((a, b) => a.created - b.created)[0];
    if (!item) return;
    if (now - item.created > 86400000 || !eligible(item.id)) {
      this.put({
        ...item,
        state: "expired",
        error: "too old or doesn't match anymore",
      });
      return;
    }
    const sending: Delivery = {
      ...item,
      attempts: item.attempts + 1,
      state: "sending",
      error: "",
    };
    this.store.transaction(() => {
      this.put(sending);
      this.store.set("telegramNextSend", now + 2500);
    });
    try {
      const response = await this.request(
        `https://api.telegram.org/bot${this.credentials.token}/sendMessage`,
        {
          method: "POST",
          httpsOnly: true,
          maxBytes: 100000,
          signal: this.controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.credentials.chatId,
            text: item.text,
            allow_paid_broadcast: false,
            link_preview_options: { is_disabled: true },
            reply_markup: {
              inline_keyboard: [[{ text: "apply", url: item.url }]],
            },
          }),
        },
      );
      const data = z
        .object({
          ok: z.boolean(),
          error_code: z.number().optional(),
          parameters: z
            .object({ retry_after: z.number().positive().finite().optional() })
            .optional(),
        })
        .parse(JSON.parse(response.text));
      if (response.status === 200 && data.ok) {
        this.put({ ...sending, state: "sent" });
      } else if (
        (response.status === 429 || data.error_code === 429) &&
        sending.attempts < 10
      ) {
        const next =
          Date.now() +
          Math.min(86400, Math.max(3, data.parameters?.retry_after || 60)) *
            1000;
        this.put({
          ...sending,
          state: "pending",
          next,
          error: "telegram rate limited, will retry",
        });
        this.store.set("telegramNextSend", next);
      } else {
        const uncertain = response.status >= 500;
        this.put({
          ...sending,
          state: uncertain ? "uncertain" : "failed",
          error: uncertain
            ? "telegram server error, might not have sent (won't resend on its own)"
            : "telegram rejected it. check the bot token, chat id, and that the bot isn't blocked",
        });
      }
    } catch {
      // Never log errors containing the request URL (which includes the bot token).
      this.put({
        ...sending,
        state: "uncertain",
        error:
          "Delivery could not be confirmed. Check Telegram; not automatically resent.",
      });
    }
  }
  stop() {
    this.controller.abort();
  }
  async idle() {
    await this.active;
  }
}
