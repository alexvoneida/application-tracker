import { publicRequest } from "./network.ts";
import { telegramCredentialsSchema } from "./telegram.ts";

try {
  const token = telegramCredentialsSchema.shape.token.parse(
    process.env.TELEGRAM_BOT_TOKEN,
  );
  const test = process.argv.includes("--test");
  const chatId = test
    ? telegramCredentialsSchema.shape.chatId.parse(process.env.TELEGRAM_CHAT_ID)
    : "";
  const response = await publicRequest(
    `https://api.telegram.org/bot${token}/${test ? "sendMessage" : "getUpdates"}`,
    {
      method: "POST",
      httpsOnly: true,
      maxBytes: 500000,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        test
          ? {
              chat_id: chatId,
              text: "test from application tracker: phone alerts work. new matches will have an apply button.",
              allow_paid_broadcast: false,
            }
          : { limit: 100, allowed_updates: ["message"] },
      ),
    },
  );
  const data = JSON.parse(response.text);
  if (response.status !== 200 || data.ok !== true)
    throw new Error("telegram rejected the request");
  if (test)
    console.log(
      "Test message accepted by Telegram. Check your phone and enable notifications for this chat.",
    );
  else {
    const ids = [
      ...new Set(
        (data.result as any[])
          .filter((update) => update.message?.chat?.type === "private")
          .map((update) => String(update.message.chat.id)),
      ),
    ];
    console.log(
      ids.length
        ? `Private chat IDs from recent messages: ${ids.join(", ")}. Choose your own chat ID for TELEGRAM_CHAT_ID.`
        : "no messages found. open the bot in telegram, send /start, and run this again (use a bot with no webhook).",
    );
  }
} catch {
  console.error(
    "Telegram setup failed. Check TELEGRAM_BOT_TOKEN, network connectivity, and (for --test) your private TELEGRAM_CHAT_ID. No secret details were logged.",
  );
  process.exitCode = 1;
}
