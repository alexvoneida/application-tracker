# Application Tracker — Product Requirements Document

Status: V1 draft incorporating initial product decisions  
Updated: 2026-09-24  
Audience: Individual searching for full-time software engineering roles

## 1. Product concept

A private application tracker that runs on the user's computer, brings together job links and hiring emails, and turns them into an accurate, visual record of a job search. Each friend who uses the tool runs a separate instance, connects their own Gmail account, and owns their own data.

The core promise: quickly answer “Where did I apply, what is happening with each role, and what needs my attention?” without maintaining a spreadsheet by hand.

### Product brief and brainstorming direction

The pain is fragmented information: application confirmations and hiring updates live in email, job details live on sites that can disappear, and some applications produce no email at all. The size of the user's current backlog and time spent tracking it remain unmeasured.

The ideal experience is to append a job link after applying, let the tool save its description, and have later emails update the same record automatically. Opening the dashboard reveals upcoming assessments and interviews, recent changes, and the overall state of the search.

Recommended V1 surfaces:

| Surface | Question it answers | Priority |
| --- | --- | --- |
| Searchable application table | What roles have I applied to, and what is their status? | Core |
| Job detail and timeline | What is this role, and what has happened so far? | Core |
| Summary dashboard | How many applications are active, progressing, or closed? | Core |
| Attention and review queue | What needs action or a correction? | Core |
| Kanban board | Where does each role sit in the process? | Later consideration |
| Sankey/pipeline visualization | How do applications move toward outcomes? | Later consideration |

Recommendation: build the ingestion, correction workflow, and timeline first. They establish whether the tracker can be trusted; visualizations should use those same records. This is a personal utility, so success means saving effort and making the search legible, rather than growth or monetization.

## 2. Confirmed constraints and proposed defaults

### Confirmed by the user

- Track a search for full-time software engineering roles.
- Recognize application confirmations, rejections, online assessments (OAs), interviews, and related hiring updates from Gmail.
- Accept job URLs through a watched plain-text file, including applications without confirmation emails.
- Show status, application date, title, key responsibilities, salary, and location for each job.
- Provide a private local web app; each person runs an independent local instance.
- Use read-only Gmail access with OAuth and automatic email/job-page extraction.
- Do not hard-code the original user's Gmail identity or credentials.
- No public hosted service is planned; sharing the project with friends should be possible.
- A bare URL added to the text file means “applied today,” with an editable application date.
- The main view is an application table with filters and a summary dashboard.
- Relevant hiring-email excerpts and job descriptions may be sent to an AI service using the user's own API key.

### Proposed defaults, subject to discussion

- One Gmail account per local instance in V1.
- For a bare URL, use the local calendar date of first import as the default application date and record its basis as “file default.” If the entry was added while the app was stopped or as part of a historical batch, its actual application date cannot be recovered from the URL; make the default easy to review and correct.
- Initial Gmail import covers a user-selectable period, proposed default 90 days.
- Sync runs on startup, manually on demand, and periodically while the local process is running; proposed interval five minutes.
- Local storage remains usable without Gmail or an AI service being available.
- Hosted AI extraction uses a locally configured provider/model and the user's own API key. Each person opts in during their own setup; rules and manual entry remain usable when no key is configured. Bundling or running a local model is not required for V1.

## 3. User journeys

### A. Set up a private instance

1. Install and start the app using documented steps.
2. Choose the job-links text file and local data location.
3. Configure the instance's Google OAuth application credentials and connect the intended Gmail account in the browser.
4. Choose an email import start date and extraction mode.
5. See import progress, discovered applications, and any uncertain items requiring review.

Setup must distinguish configuring an OAuth application from authorizing access to an individual mailbox. A friend must be able to complete setup without using the original author's account, tokens, or private files.

### B. Record an application without a confirmation email

1. Append a URL to the watched file.
2. The app imports it and immediately creates a visible record, even if the page cannot be fetched.
3. The app saves available job details and a local description snapshot.
4. The user can correct the application date or paste the description if extraction failed.
5. A later matching email attaches to this application instead of creating a duplicate.

The initial status in step 2 is Applied and the default application date is today in the user's local time zone, with the date basis visible and an edit available.

### C. Receive a hiring update

1. A Gmail sync discovers a relevant message.
2. The app identifies the event, candidate role, and any explicit date or deadline.
3. An unambiguous event is attached automatically; an uncertain classification or match enters review.
4. The application shows its updated stage and source evidence in the timeline.
5. An actionable OA or interview appears in the attention view.

### D. Review the search

The user filters by company, stage, application date, location/work arrangement, and salary availability. Opening a role reveals the saved description, responsibilities, compensation, application history, related email references, notes, and outstanding actions. Corrections persist through later syncs.

## 4. Functional requirements

### F1. Gmail connection and synchronization

- Use the Gmail API with read-only authorization. Each local instance stores its own account connection and configurable OAuth client settings.
- Display connected account, last successful sync, current progress, and failures requiring attention.
- Allow a selectable historical import window, manual sync, and periodic sync while running.
- Discover candidate hiring messages using configurable searches and classification. Do not rely on the exact phrase “thank you for applying” alone.
- Include archived messages in the selected search scope; proposed default excludes spam and trash.
- Recognize confirmations, rejections, OA invitations, recruiter screens, interview invitations and scheduling changes, offers, and explicit withdrawals or role cancellations.
- Distinguish hiring events from job alerts, marketing, generic recruiter outreach, quoted older text, and canceled or rescheduled events.
- Fetching and classifying the same Gmail message again must not duplicate events or records.
- A disconnected or expired connection pauses email ingestion and offers reconnection without losing local records. When the app restarts, it catches up on changes missed while stopped.
- Gmail remains unchanged: the app does not send mail, mark messages read, label, archive, or delete them.

### F2. Text-file and manual capture

- Watch one user-configured UTF-8 text file and scan it on startup; import only complete, valid entries.
- Support one URL per line. Ignore blank lines and lines starting with `#`.
- Proposed optional syntax: `YYYY-MM-DD | https://example.com/job/123` for a known application date.
- Bare URLs create an Applied record with first import date as the default application date. Label the basis as “file default”; bulk historical imports and entries discovered after downtime must clearly expose this limitation and support date correction.
- Repeated URLs, repeated file scans, and file reordering must not create duplicate applications or reset application dates.
- Removing a line does not delete an application. The app never rewrites the user's file.
- Show line-specific errors without stopping other valid imports.
- Provide manual record creation, date editing, description paste, and direct URL entry as recovery paths.
- Keep the original URL. Normalize only known tracking parameters; retain parameters needed to identify the actual job.
- Distinct job IDs at the same company remain separate. Reapplying to the same posting requires an explicit new application action rather than a duplicated file line.

### F3. Job details and preservation

For each role, capture and allow correction of:

| Field | Required behavior |
| --- | --- |
| Company and job title | Preserve source wording; show unknown if unavailable |
| Job URL and posting/requisition ID | Keep available identifiers for deduplication and email matching |
| Employment type and seniority | Capture when stated; unknown does not prevent tracking |
| Responsibilities | Concise summary backed by the saved description |
| Location | Support multiple locations and stated geographic restrictions |
| Work arrangement | Remote, hybrid, on-site, or unknown; do not equate remote with work-from-anywhere |
| Compensation | Preserve original text, currency, range, period, and whether base pay or other compensation |
| Requirements and technologies | Extract stated qualifications and skills when available |
| Full description | Save readable source text and capture time locally |

- Preserve unknown fields instead of inventing salary, location, title, or qualifications.
- Do not compare hourly and annual compensation or different currencies as if equivalent. Any future conversion must be visibly labeled and retain the original.
- Attempt extraction from accessible job pages; blocked, expired, login-required, or unsupported pages produce a recoverable extraction state and manual paste option.
- Email-only applications remain trackable without a job URL. Offer to attach a URL or description; do not assume a search result is the correct role.
- Preserve the original description snapshot when a listing changes or disappears. An explicit refresh adds a newer snapshot instead of destroying the old one.

### F4. Application lifecycle and event history

Use a current stage plus an event timeline. Proposed stages:

| Stage | Meaning |
| --- | --- |
| Applied | Application submitted or supported by a confirmation |
| Assessment | OA or take-home assessment stage |
| Interviewing | Recruiter screen or one or more interview rounds |
| Offer | Offer received and under consideration |
| Accepted | User accepted an offer |
| Rejected | Explicit rejection received |
| Withdrawn | User withdrew from the process |
| Closed | Role canceled or process otherwise explicitly closed |
| Unknown | A role is identified but its current stage is not established |

- Stages may be skipped. A process may contain multiple assessments and interviews in different orders.
- Record events separately: application submitted/confirmed, assessment invited/completed, interview invited/scheduled/completed/rescheduled/canceled, offer received/accepted/declined, rejected, withdrawn, and role closed.
- An invitation does not imply completion. An offer does not imply acceptance. A completed assessment alone does not imply an interview.
- Use the event's stated occurrence time when available, otherwise the message time with an explicit basis. Keep import time separately.
- A delayed confirmation must not regress an application already interviewing. Rejected, withdrawn, accepted, or closed applications cannot be reopened silently by an ambiguous later email.
- No response is an elapsed-time indicator, never an automatic rejection or claim that the employer has ghosted the user.
- Application date may be user-provided, estimated from a confirmation, defaulted from file import, or unknown. An interview/rejection alone does not establish when the user applied. Show the date basis in details and an indicator for estimated/defaulted dates in the table.
- Manual stage corrections establish an authoritative baseline; later unambiguous new events may advance it, but reprocessing older evidence cannot undo the correction. Terminal-state reopening needs user review.
- Show every automated status change with its source and provide a correction action.

### F5. Matching and review

- Match evidence using job/requisition IDs, job URLs, company, title, thread context, and timing. Company name or sender domain alone is insufficient when several roles are possible.
- Route uncertain classifications, contradictory updates, suspected duplicates, and ambiguous application matches to a review queue.
- Let the user attach evidence to an existing application, create a new one, edit extracted fields, or dismiss unrelated mail.
- A message discussing several roles must not apply a blanket outcome to every role without explicit role-specific evidence.
- Preserve source references and user corrections. Repeated syncs must not keep surfacing a dismissed message unless the user explicitly requests reprocessing.
- Support merging confirmed duplicates with a preview and reversible correction path; do not lose event history.
- Distinguish confidence in event classification from confidence in matching the event to the right application. Confidence must be validated on labeled examples before determining automatic-update thresholds.

### F6. Visualization and everyday use

- Table columns: company, title, current stage, application date with estimate indicator, location/work arrangement, compensation, last activity, and next action.
- Search by company/title and filter by stage, date range, location, and work arrangement. Sort by date, latest activity, or time waiting.
- Job detail shows editable structured information, original description, timeline, email references, and notes.
- Dashboard shows applications submitted over time, counts by current stage, interview and offer counts, and the review queue size.
- Unknown application dates appear separately and are excluded from date-cohort calculations with an explanation.
- Any funnel reports stage reach using event history, not only current status. For example, a rejected application that reached interview still counts as having reached interview.
- Define response rate as applications with at least one employer hiring update beyond an automated receipt divided by applications in the selected application-date cohort. Show the numerator, denominator, and cohort dates; pending applications remain pending.
- A future Sankey view must account for skipped and repeated stages and preserve total application counts. Kanban and Sankey views are outside V1; the table and summary dashboard are the selected main experience.
- Provide a compact attention list for known OA deadlines and upcoming interviews. Missing or ambiguous time zones/dates are flagged for correction; do not invent deadlines.
- Support completing or dismissing an action. A canceled/rescheduled interview updates its related action rather than leaving a stale reminder.

### F7. Local ownership and portability

- Store application records, job snapshots, and relevant evidence locally. No shared account service or central database is required.
- Provide CSV export of applications and a documented local backup/restore path covering records and history. OAuth tokens and API keys are excluded from shareable exports and backups by default.
- Disconnecting Gmail stops synchronization and removes its local credentials; it does not silently erase tracked applications.
- Allow deletion of local records and their stored evidence. Remember ignored source IDs until explicitly reset so the next sync does not recreate deliberately deleted records.
- Store only relevant email excerpts and metadata needed for evidence; do not archive unrelated mailbox content or attachments by default.

## 5. Implementation-facing capability contract

### Actors and surfaces

The only user is the local instance's owner. Surfaces are the local browser UI, the watched file, Gmail authorization and sync, job-page retrieval, optional extraction service, local storage, and export files. There is no cross-user collaboration or administrator role.

### Data model requirements

- **Application:** stable local ID, company, title, original/canonical job URL, posting ID, current stage, application date and its basis, timestamps, notes, and manual corrections.
- **Job snapshot:** source URL or pasted text, captured time, description text, extracted fields, field provenance, and extraction status.
- **Source message:** account identity, Gmail message/thread IDs, relevant excerpt, received time, classification, dismissal state, and source reference.
- **Application event:** application ID, type, occurrence time and basis, ingestion time, source ID, extraction/match confidence, and correction history.
- **Action:** application ID, assessment/interview type, due/scheduled time and time zone if known, status, and supporting event.
- **Import record:** source fingerprint, first seen time, result, errors, and deduplication association.
- **Local configuration:** selected file, import window, sync preferences, OAuth client configuration references, and extraction mode. Store secret material separately.

The local database is the durable application record. The text file and Gmail are ingestion sources; deleting or changing a source does not implicitly erase application history.

### Ingestion contract

Inputs are file entries, manual edits, Gmail messages, fetched job descriptions, and pasted text. Outputs are applications, snapshots, events, review items, actions, and visible import errors. Replaying any source is idempotent. Parsing failure must not erase a successfully captured application.

Source ingestion and extraction must be independently retryable. A failed message or job page cannot halt the entire batch. Persist enough progress to resume after restart; retry transient failures with bounded backoff, expose permanent failures, and honor provider rate limits.

### Architecture preferences, not fixed product requirements

A browser frontend backed by a local process, a local relational database, and a background ingestion worker is a suitable starting point. The local process owns the file watcher so capture is not dependent on browser file permissions. Technology stack, packaging, and the precise OAuth client flow remain engineering decisions; no implementation stack is selected by this PRD.

### Privacy and trust boundaries

- Bind the service to loopback by default, protect local mutation endpoints from cross-origin requests, and keep credentials out of browser bundles, source control, logs, and exports.
- Treat email and job-page contents as untrusted extraction inputs. They cannot authorize tool execution or change application instructions.
- Restrict job fetching to public HTTP(S) destinations, including redirect validation; reject loopback/private-network targets.
- Sanitize stored/rendered content and do not load remote email images or scripts.
- If hosted AI is enabled, explain exactly what is sent and transmit only relevant excerpts/descriptions. Credentials, unrelated email content, and attachments are not extraction inputs.
- Let the user configure and replace the AI provider/model and API key locally. Display provider failures and usage where available; bound retries and avoid repeated paid extraction of unchanged content. Provider failure must preserve captured records and offer retry/manual correction.
- Use OS-backed credential storage where supported, or a documented secure local fallback; the app must never ship with the author's tokens or API key.

### Verified Gmail integration considerations

Google classifies `gmail.readonly` as a restricted scope. It permits reading mailbox messages and settings; filtering for hiring messages is app behavior, not an OAuth restriction to a particular subset of mail. Setup must describe this accurately. [Google Gmail scope documentation](https://developers.google.com/workspace/gmail/api/auth/scopes)

External OAuth projects in Testing generally issue refresh tokens that expire after seven days when requesting Gmail access. Setup documentation and reconnection behavior must account for this, rather than promise an indefinitely connected mailbox. [Google OAuth documentation](https://developers.google.com/identity/protocols/oauth2)

Proposed distribution approach: each user supplies their own Google OAuth project/client configuration, supported by a setup guide. A shared developer OAuth project is an alternative, but not required for V1. Confirm the applicable Google setup requirements during integration; a private local deployment alone does not establish an exemption from provider rules.

## 6. Non-goals for V1

- Hosted multi-user accounts, a public launch, subscriptions, or monetization.
- Automatically applying to jobs or sending recruiter replies.
- Resume generation, job recommendations, interview coaching, or application-fit scoring.
- Scraping entire job boards or bypassing login/CAPTCHA/access controls.
- Calendar writes, automated email follow-ups, or system notifications while the local process is stopped.
- Outlook/other email providers, multiple connected mailboxes, or cross-device synchronization.
- Saved-for-later workflow, Kanban boards, and Sankey charts; these remain possible additions after V1.
- Guaranteed extraction from every job site or completely error-free email classification.

## 7. Acceptance criteria

| Scenario | Required result |
| --- | --- |
| Friend installs a clean copy | Can configure their own OAuth client and Gmail account; no original-user identity or credentials appear |
| Valid URL added without any email | Visible Applied record with today's editable default date and recoverable extraction state |
| Same file scanned repeatedly or reordered | Exactly one application per intentional application; original date retained |
| Historical bare URLs imported | Dates visibly marked estimated; user can supply/correct actual dates |
| Confirmation arrives for a manually added role | Existing application gains evidence; no duplicate when identity is unambiguous |
| Two roles at one company and a generic rejection | Review item rather than rejecting an arbitrary role |
| Old confirmation imported after an interview | Timeline gains the confirmation; stage does not regress |
| OA invitation with a deadline | Assessment event and pending action; no claim of completion |
| Job page becomes unavailable | Previously saved description remains available |
| Salary or application date not stated | Unknown or explicitly estimated; no fabricated value |
| Gmail expires or network fails | Existing records remain usable; failure and recovery action are visible |
| User corrects extracted data | Reprocessing the same evidence preserves the correction |
| Interview later ends in rejection | Current stage is rejected; interview history and funnel reach remain correct |
| User deletes a tracked record | It stays deleted across ordinary sync unless the user explicitly restores/reimports it |
| AI key is missing, invalid, or quota is exhausted | Captured applications remain available; show extraction failure and allow configuration, retry, or manual correction |

## 8. Success measures and delivery sequence

Proposed targets, to validate rather than treat as measured results:

- A new text-file entry appears within five seconds while the app is running, before slow enrichment finishes.
- Replaying a test import produces zero duplicate application/events.
- Every automated stage change has inspectable evidence; every inferred application date is labeled.
- On a manually labeled sample containing confirmations, OAs, interviews, rejections, unrelated messages, and multiple roles per company: target at least 95% precision for automatic event-to-application updates and at least 90% discovery of relevant events, including those routed to review. Report sample size and errors; abstaining on everything does not pass.
- With a proposed test size of 2,000 applications, routine local search/filter interactions complete within one second on the development machine.
- After a two-week personal trial, daily review should take about five minutes or less and require no parallel spreadsheet. Measure the correction burden and missed emails during that trial.

Delivery slices:

1. Manual/text-file capture, local persistence, table, role details, editable dates, and job snapshots.
2. Gmail setup and historical import, classifications, event timeline, role matching, and review queue.
3. Incremental sync and recovery, dashboard, attention list, export/restore, and clean-install documentation for a friend.
4. Evaluate later visualizations only after the underlying counts and transitions are verified and V1 has been used in a real job search.

These are proposed slices, not calendar estimates or authorization to implement the application.

## 9. Open decisions and handoff

The initial product decisions are resolved: the file records applications for today, hosted AI with a personal API key is allowed, and the table/dashboard is the primary view.

Proposed defaults remain one Gmail account, a 90-day initial import, five-minute active sync, and user-supplied OAuth client configuration. These are adjustable defaults, not additional product questions blocking the PRD.

Engineering choices before implementation: select the stack, initial AI provider/model, local packaging/OAuth flow, and supported operating systems. Start by validating a complete Gmail connection on a clean local instance and extraction/matching on a small labeled email sample. Confirm the provider's applicable Gmail-data handling requirements as part of choosing the hosted extraction service.

Handoff: ready for technical design based on the V1 scope. This PRD uses the product-capability structure to make date provenance, source matching, correction behavior, and local ownership explicit. No application code is included in this deliverable.

## 10. Subsequent scope: early job discovery and notifications

Added after the original V1 planning handoff: help the user apply quickly to new-grad/entry-level SWE openings, without auto-submitting applications or relying on Instagram stories.

- Discover new listings from Simplify's SWE new-grad GitHub section and supported direct company boards (Greenhouse, Lever, Ashby). Automatically expand the watch list from supported GitHub links and permit manual board additions.
- Let users configure location, work arrangement, maximum experience, salary/currency, keywords, excluded companies, and handling of unknown experience/salary.
- Show first detected time separately from employer publication time. Establish a quiet baseline for each source and deduplicate repeat/cross-source discoveries. Failed source checks must not falsely close listings.
- Notify through native macOS notifications while the desktop app runs; optionally keep it in the menu bar. Sleeping/offline Macs do not monitor.
- Run a separate discovery-only cloud worker for continuous monitoring and private Telegram phone alerts. Use user-owned bot credentials; do not copy Gmail credentials or application history to the cloud. Telegram replaces the originally discussed paid SMS option.
- Export cloud filters/boards without secrets. The initial implementation does not synchronize desktop/cloud filters, discoveries, or application status; re-export/restart when changing cloud preferences.
- Persist cloud baselines and an alert outbox across restarts. Respect provider rate limits, surface source/delivery failures, and avoid blindly replaying uncertain deliveries.
- Opening an application is not submission. Only explicit “I applied” confirmation creates a local application record, with an editable application date.

Coverage is limited to known/added supported boards plus the GitHub list, not every hiring company. The default five-minute polling interval is a target rather than an instant-detection guarantee; there is no guarantee of preceding LinkedIn. Cloud deployment, real Telegram delivery, and a multi-day reliability trial require the user's hosting account and bot setup. See [CLOUD-WORKER.md](CLOUD-WORKER.md).
