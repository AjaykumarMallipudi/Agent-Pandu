# Smart Applytick

Discovers companies by location and industry through an official search API. It scans each company's public website for published HR, careers, general and founder/CEO email addresses, keeping the evidence for each one. You then send personalized one-to-one emails to contacts you select, but only after you have reviewed and explicitly approved the campaign.

**Stack:** React 19 + Vite + Tailwind + TanStack Query · Express 5 + TypeScript (strict) + SQLite (better-sqlite3) + Zod + Pino · Axios + Cheerio + robots-parser · Nodemailer + Handlebars · ExcelJS · SSE · Vitest + Supertest + nock.

## Quick start

```bash
npm install
cp .env.example .env        # fill in the values (see below)
npm run db:init             # creates data/applytick.db and the default template
npm run dev                 # API on http://127.0.0.1:4000, UI on http://127.0.0.1:5173
```

Production (one process serves both API and UI):

```bash
npm run build
npm start                   # http://127.0.0.1:4000
```

Tests (no network access; SMTP and HTTP are mocked):

```bash
npm test                    # 114 tests
npm run typecheck
```

## Your data on GitHub (data/snapshot)

Scraped data is saved as readable JSON in `data/snapshot/`. It's written automatically after every discovery run, every finished campaign and every opt-out or template change. You can also use **Settings → Data files → Save data files now**, or run `npm run data:export`.

| File | Contents |
|---|---|
| `companies.json` | companies, websites, locations, OpenStreetMap links |
| `contacts.json` | contacts with type, confidence and where each was found |
| `contacted.json` | everyone already emailed, so they're never emailed twice from any machine |
| `suppressions.json` | opt-outs |
| `templates.json` | your email templates |

To publish it:

```bash
git add data/snapshot
git commit -m "Update scraped data"
git push
```

On another computer, `git clone`, `npm install`, copy `.env`, then `npm run dev`. The empty database loads the snapshot on first start. To merge newer files into an existing database, use `npm run data:import` or **Settings → Load from data files**.

**Keep the repository private.** These files contain names and email addresses. `.env` (SMTP password) is never included.

## Sending emails, step by step

1. **Settings → Applying**: paste your Google Drive resume link (Share → *Anyone with the link*). The **Simple — resume button** template shows it as a centred blue *View My Resume* button.
2. **Campaigns → New campaign**:
   - **Pick automatically** chooses the best person at each company: HR, then talent acquisition and recruiting, then careers and founders, then general inboxes. Already-contacted people and companies, opt-outs, and privacy, legal, support and sales inboxes are skipped.
   - Set how many, then choose the template and the role you're applying for.
3. **Review**: click each recipient to see their exact email, and exclude anyone you don't want.
4. **Approve**: type `SEND <n>`, then press **Start sending** and watch progress live.

**One contact per company** is on by default: one email per company, and never a second person at a company you already wrote to. You can turn it off in Settings.

While `EMAIL_TEST_MODE=true`, the whole flow is simulated. To send real email:
1. Fill the SMTP settings in `.env` (Gmail: `smtp.gmail.com`, port 465, `SMTP_SECURE=true`, an App Password).
2. Send yourself a test from **Email Templates**.
3. Set `EMAIL_TEST_MODE=false` and restart.

The Campaigns page shows a readiness checklist.

University, government and research-institute sites (`.ac.in`, `.edu`, `.gov.in`, …) are not crawled.

## Credentials you must provide

| What | Where | Needed for |
|---|---|---|
| `OSM_CONTACT_EMAIL` | Your own real email | **Default, free** discovery provider (OpenStreetMap). No API key. See below. |
| `GOOGLE_PLACES_API_KEY` | Google Cloud Console → enable **Places API (New)** → create a key restricted to that API | *Optional* paid provider with more business coverage. The `websiteUri` field is billed at the Places "Enterprise" tier. |
| `SMTP_*`, `EMAIL_FROM`, `SENDER_NAME` | Your mail provider | Real sending. Gmail needs an **App Password** (`smtp.gmail.com`, 465, `SMTP_SECURE=true`). Microsoft 365 uses `smtp.office365.com`, 587. |
| `TEST_EMAIL_ADDRESS` | Your own inbox | The template editor's "Send test" button |

If a provider has no credentials, the Discover page shows a setup message and refuses to start a run. It never invents results.

## OpenStreetMap discovery (free, default)

### Setup

1. In `.env`, set:
   ```
   DISCOVERY_PROVIDER=osm
   OSM_CONTACT_EMAIL=your-real-email@example.com
   EMAIL_TEST_MODE=true
   ```
2. Restart the server (`npm run dev`). **Settings → Company discovery source** should show OpenStreetMap as *configured* and the default.
3. You don't need a Google key. Google Places stays optional; select it on the Discover page only if you set `GOOGLE_PLACES_API_KEY`.

### How a run works

1. **Find the location.** Nominatim looks up the city, state and country once and returns the city's boundary. Results are cached for 30 days.
2. **List the companies.** One Overpass query fetches named businesses inside the boundary. If OpenStreetMap has no usable boundary, the app falls back to a rectangle around the city. The query covers:
   - `office=it|software|company|telecommunication|research|engineering|consulting|coworking`
   - anything with a `company=*` tag
   - anything with a technology-related `industry=*` tag

   Results are cached for 24 hours, so repeating or re-filtering a search in the same city sends no new requests.
3. **Match your search.** Matching is done locally from the Industry and Keywords fields:
   - **IT**: `office=it`, IT company/industry tags, or "IT"/"Infotech" in the name
   - **software**: `office=software`, `company=software`, or software/SaaS in the name or description
   - **technology**: technology tags, or tech-like names on office records
   - **startups**: OpenStreetMap has no startup tag, so this matches "startup", "ventures" or "incubator" in the name or description. If startups is the only category, it falls back to technology companies.

   Any other keywords (e.g. `fintech`) must appear as whole words in the name, description or tags.
4. **What is saved.** For each company: name, website (if tagged), address, city, state and the OpenStreetMap link, e.g. `https://www.openstreetmap.org/node/123`. Companies with a website come first and are passed to the website crawler, which looks for **publicly listed** emails. Companies without one are saved with status *No website*. OpenStreetMap doesn't contain HR emails, and many records have no website.

### Usage-policy safeguards

- Requests identify the app with a User-Agent that includes `OSM_CONTACT_EMAIL`.
- Nominatim is called at most once per second across the whole app.
- Only one Overpass query runs at a time, with a server-side timeout.
- Responses are cached in the database (`api_cache` table).
- HTTP timeouts are 15 s for Nominatim and 120 s for Overpass (its server-side limit is 90 s).
- A 429/503/504 response stops the run with a clear "try again later" message and is never retried automatically.
- Search-engine result pages are never scraped.

### Test discovery from the dashboard

```bash
npm run dev
```

1. Open http://127.0.0.1:5173 → **Discover Companies**.
2. Source: **OpenStreetMap (Nominatim + Overpass) — free**.
3. Click **Use preset: IT / software / tech / startups in Hyderabad**. This fills in Country *India*, State *Telangana*, City *Hyderabad*, Industry *IT, software, technology*, Keywords *startups*. Set **Max companies** to 10–25 for a first run.
   **City is required** for OpenStreetMap: a whole country or state is too large for the free public Overpass service and times out, so the app refuses it. For wider coverage, run one search per city.
4. Click **Start discovery** and watch the progress card. Results appear in **Companies** (open one to see "View on OpenStreetMap") and **Contacts**.
5. Test mode stays on. Campaigns are simulated and nothing is sent.

## Workflow

1. **Discover Companies**: enter the country, state, city, industry and keywords, then start a run. Progress streams live. Only one run can be active at a time. If a run is stopped or interrupted, the results collected so far are kept.
2. **Companies / Contacts**: open any contact to see where it was published (the page URL and a nearby text snippet), why it got its confidence score, and its MX result. Only **eligible** contacts can be selected. A contact is not eligible if it is suppressed, already contacted, invalid or below the minimum confidence. A campaign holds up to 50 or 100 contacts, which you can configure.
3. **Email Templates**: edit the HTML and plain-text versions with a live preview and placeholders: `{{name}} {{company}} {{role}} {{position}} {{sender_name}} {{sender_email}} {{phone}} {{linkedin}} {{github}} {{portfolio}} {{unsubscribe_url}}` plus `{{#if x}}…{{/if}}`.
4. **Create campaign** from your selection. This builds a frozen, personalized draft for each recipient. You review each subject, HTML and plain-text version, and exclude any recipient you don't want.
5. **Approve** by typing `SEND <n>`. Then press **Start sending**, and pause or resume whenever you need. Progress, the status of each recipient and failure reasons update live and are saved in the database.

## Safety model

- **Test mode (default ON):** while `EMAIL_TEST_MODE=true`, campaign messages are built through a network-free transport and marked *Simulated*. The UI cannot turn test mode off while the env flag is set. A campaign created in test mode stays simulated forever.
- **Kill switch:** blocks every SMTP submission, which is re-checked right before each message is sent. If `SENDING_KILL_SWITCH=true` is set in `.env`, the UI cannot release it.
- **Duplicate prevention:** messages are claimed from the database queue atomically. Each recipient address is reserved in `send_ledger` (primary key on the email) before submission, so no address is sent twice across campaigns. Each message has a deterministic idempotency `Message-ID`.
- **SMTP outcomes:**
  - 5xx → failed. If the recipient was rejected, the address is added to suppressions.
  - 4xx, or a failure before DATA → retried with backoff, up to 3 attempts.
  - Authentication error → the campaign pauses.
  - Timeout or dropped connection during or after DATA → **Outcome unknown**. These are never retried automatically. Check your Sent folder and resolve them in the UI.
  - "Accepted by SMTP" is tracked separately from "Confirmed delivered", which only comes from `POST /api/webhooks/delivery` (requires `WEBHOOK_SECRET`).
- **Restart safety:** after a restart, messages that were processing but never submitted are requeued. Messages that were mid-submission become *unknown*. Discovery runs become *interrupted*.
- **Rate limits:** per-minute rate, concurrency and a rolling 24-hour cap. The `.env` values are hard ceilings that the UI can only lower.
- **Crawling:**
  - honours robots.txt; an unreachable robots.txt means the site is not crawled
  - per-host delay, which also respects Crawl-delay
  - timeouts, a 2 MB size cap and a redirect limit
  - SSRF guard that blocks private, loopback, link-local, CGNAT and metadata IPs and non-standard ports; it re-validates every redirect and checks again at socket connect time to stop DNS rebinding
  - no de-obfuscation, CAPTCHA bypass or logins
- **Email content:** placeholder values are HTML-escaped. Templates only allow whitelisted `{{placeholders}}`, with no triple-stash, helpers or partials. HTML is sanitized before and after rendering, and the preview runs in a sandboxed iframe. Every message carries an opt-out notice and a `List-Unsubscribe` header.
- **API protection:**
  - the server binds to `127.0.0.1` and validates the Host header (blocks DNS rebinding)
  - state-changing calls need an `X-Applytick` header (blocks CSRF)
  - `ADMIN_TOKEN` is required before the server binds to any non-loopback address
  - SMTP secrets never appear in API responses
- **Excel:** `data/companies.xlsx`, `data/contacts.xlsx` and `data/campaign-history.xlsx` have frozen headers, filters and column widths. Cells starting with `= + - @` are neutralized.

Public availability is not consent. Send relevant, individual, honest messages, honour every opt-out (add replies saying "unsubscribe" to Settings → Suppression list, or set `PUBLIC_BASE_URL` for working opt-out links), and follow the anti-spam law that applies to you and your recipients, as well as your mail provider's sending limits.

## Remote deployment

Do not expose this app as-is. Before deploying it beyond localhost:

- set `ADMIN_TOKEN` and `ALLOWED_HOSTS`
- put it behind HTTPS
- restrict network access (VPN or IP allow-list)
- set `PUBLIC_BASE_URL` so unsubscribe links work

## Project structure

```
server/src
  config.ts, settings.ts       env (Zod) + UI-editable non-secret settings
  db/                          schema/migrations, init script
  lib/                         url normalization, SSRF guard, safe fetch + host throttle, robots.txt
  discovery/                   provider interface, Google Places, OpenStreetMap, run orchestrator
  crawler/                     site crawler, email extraction, evidence-based classification, MX check
  contacts/repo.ts             dedup + evidence aggregation + eligibility
  email/                       templates (validation/sanitize/render), transport, SMTP error classes
  campaigns/                   service (draft → approve → start/pause/resume/cancel) + DB-backed worker
  export/excel.ts              Excel exports
  routes/, http/middleware.ts  REST + SSE, auth/host/CSRF guards
server/test                    114 Vitest/Supertest tests (nock blocks all real network)
web/src                        React pages: Dashboard, Discover, Companies, Contacts, Templates, Campaigns, History, Settings
```

# Agent-Pandu
