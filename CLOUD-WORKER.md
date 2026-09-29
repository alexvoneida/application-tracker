# Always-on job alerts

Fieldwork has two independent notification paths:

- **Mac:** Discover → save preferences with notifications enabled, or click **Test Mac notification**, to request macOS permission if undecided. The observed status and timestamps are saved locally and rechecked against macOS. If denied, use **Open macOS Notification Settings**; the OS does not repeat the initial prompt. Start monitoring to receive matching-job alerts while the desktop app is running and your Mac is awake/online. Enable “Keep running in the menu bar” in Settings if you want to close its window. Check Focus settings and use a signed app build.
- **Phone:** the discovery-only cloud worker sends a private Telegram message with an **Open application** button. Your Mac can be off. This is a Telegram push notification, not carrier SMS. [Telegram bot messages are free within rate limits](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this); this worker explicitly disables paid broadcasting. Cloud hosting/storage may still cost money.

The cloud worker is a continuously running **Node/container process**, not a Cloudflare Worker or static GitHub Pages site. It exposes no web port and needs only outbound HTTPS, a persistent disk, and its own configuration/secrets. Do not deploy the local Express/Gmail server publicly.

## 1. Export your search

In Fieldwork, save Discover’s search preferences. Expand **Always-on phone alerts · Telegram** and download `fieldwork-worker.json`. Put it in the project root on the worker host, or mount it as a private configuration file.

This export contains filters and supported board URLs only. It enables cloud monitoring and notifications, even if local monitoring is paused. It does **not** include Gmail credentials, AI keys, application history, discovered-job history, or Telegram credentials. Each newly checked source creates a quiet baseline: existing openings will not all trigger notifications at startup.

Export after the initial GitHub scan to include the discovered boards, or leave automatic board discovery enabled to let the worker find them itself. You can also start from this minimal file, then replace it with an export later:

```json
{
  "version": 1,
  "config": {
    "enabled": true,
    "notifications": true,
    "autoWatch": true,
    "pollMinutes": 5,
    "maxExperience": 2,
    "locations": "",
    "minSalary": 0
  },
  "githubEnabled": true,
  "boards": []
}
```

Local and cloud filters/status are not synchronized. After changing local preferences, save and export again, replace the mounted file, and restart the worker. Already discovered cloud boards remain monitored unless explicitly disabled in the configuration; omission does not delete their history. To disable one, include its URL with `"enabled": false`. Local “I applied” actions are not sent to the cloud, so it cannot suppress alerts based on your application history. A particular job normally alerts once per worker database.

## 2. Create a private Telegram bot

1. Install Telegram on your phone and enable notifications.
2. Open the official **[@BotFather](https://t.me/BotFather)**, send `/newbot`, and follow its instructions. Save the bot token privately; treat it like a password.
3. Open your new bot and send `/start`. Bots cannot initiate a private conversation before you contact them.
4. On the worker host, create a private `.env.worker` file in your editor (not committed to Git):

```dotenv
TELEGRAM_BOT_TOKEN=replace_with_your_bot_token
TELEGRAM_CHAT_ID=replace_with_your_positive_private_chat_id
```

To discover your chat ID without placing the token in a browser URL or shell history, use Node 22.13+ (Node 24 recommended) with dependencies installed:

```sh
chmod 600 .env.worker
node --env-file=.env.worker --import tsx server/telegram-setup.ts
```

This reads recent incoming messages from your bot and prints only private chat IDs, not message contents or the token. If several IDs appear, confirm which is yours; use a dedicated personal bot. It does not subscribe other people or use public groups/channels. Fill in `TELEGRAM_CHAT_ID` with your positive numeric ID. A bot already configured with a webhook should not be reused.

Send an explicit test message (this command really sends a Telegram message):

```sh
node --env-file=.env.worker --import tsx server/telegram-setup.ts --test
```

Keep the chat unmuted. Telegram API acceptance does not prove a phone notification was displayed; test on your phone. Do not enable paid broadcasts in BotFather. See the [official bot setup guide](https://core.telegram.org/bots/tutorial#obtain-your-bot-token) and [sendMessage API](https://core.telegram.org/bots/api#sendmessage).

## 3. Deploy on an always-on cloud machine

Use an existing Linux VM with Docker/Compose, or a container host that supports a **non-sleeping background process and persistent volume**. A free web tier that sleeps or ephemeral scheduled jobs will not provide continuous near-real-time checks. No hosting account, infrastructure, or paid plan is provisioned by this project.

Upload the project source, `fieldwork-worker.json`, and private `.env.worker` to that machine. Never upload your Mac’s Fieldwork data directory or `.data/`. The Docker build context allowlist includes only `package*.json`, `server/`, and `shared/`; tokens and config are mounted at runtime, not baked into an image.

```sh
docker compose -f compose.worker.yml up -d --build
docker compose -f compose.worker.yml logs --tail=30 worker
docker compose -f compose.worker.yml exec worker npm run worker:status
```

The named `worker-data` volume retains source baselines, per-job deduplication, and the Telegram outbox across deployments. Keep **one replica** per personal worker. Do not run `down -v` unless you deliberately want to erase its discovery history; losing the volume creates new baselines and loses queued notifications. Compose restarts a crashed process, but container-health warnings still require host monitoring/restart policies.

On a managed container host, use `Dockerfile.worker`, mount a persistent disk at `/data`, mount the JSON at `/config/fieldwork-worker.json`, and enter `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the host’s secret settings. No port/domain is required. Configure alerts for failed container health checks and repeated source/delivery failures.

To pause without deleting history:

```sh
docker compose -f compose.worker.yml stop worker
```

To deploy code/filter changes while preserving data:

```sh
docker compose -f compose.worker.yml up -d --build --force-recreate worker
```

Source changes do not automatically update a running worker or installed `.app`: redeploy the container / rebuild the desktop app. If the process crashed, allow up to two minutes for its exclusive database lease to expire before restarting.

## Reliability and coverage

- Watches Simplify’s SWE new-grad section and discovers direct Greenhouse, Lever, and Ashby boards from its links; additional supported boards can be added manually. It cannot discover every company on the internet. Unsupported ATSs are visible only through the GitHub list.
- Default target is one check per source every five minutes (configurable 2–60). Concurrency is bounded, ETags are used where supported, and failures/rate limits back off. Queues, outages, newly added companies, and GitHub update timing can delay detection. **No guarantee of beating LinkedIn or matching the original publication time.**
- First-seen time is our detection time, not publication time. Employer dates are shown separately when available; reposting can change them. Greenhouse `updated_at` is not presented as publication time.
- Entry-level classification is a heuristic based on titles, explicit experience statements, and the curated GitHub section. Always review actual requirements, eligibility and location restrictions. Missing/ambiguous salaries remain unknown; currencies are not converted.
- No automatic application submission or AI calls occur during discovery. A link opens the employer’s application; confirm “I applied” locally after submitting yourself.
- Alerts are written atomically with the discovery checkpoint. The outbox sends at most one message per three-second cycle and persists Telegram rate-limit delays. Messages expire after 24 hours or when the role no longer matches/is closed.
- Telegram has no sendMessage idempotency key. A timeout or crash mid-send is marked **uncertain** and is not automatically retried, preventing duplicate bursts at the cost of a potentially missed alert. Definite rejections appear as **failed**. Check `worker:status` and the chat; fix credentials/permissions and use the explicit test command. Previously failed/uncertain messages are not replayed automatically.
- Status includes heartbeat, last completed cycle, source errors, and delivery counts. Logs exclude bot tokens, phone numbers, message text, Gmail data, and application records. Telegram receives the job/company/location/salary metadata and link you choose to be notified about; bot chats are not end-to-end encrypted.
- Back up the entire worker data directory only while the worker is stopped, or use your host’s consistent volume snapshots. The desktop application backup does not include discovery caches, search settings, or the cloud outbox.

Deployment and real Telegram delivery require your hosting account, bot token, and private chat ID. Automated tests use fixtures and do not message your real account.
