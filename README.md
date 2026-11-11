# GTME.School — Individual landing page (standalone Vercel project)

Serves `vsl.html` at `/` and `/vsl`. The link to the other page (`/corporate-vsl`) redirects to https://gtme.school until you change the `redirects` destination in `vercel.json`.

---

# GTME.School — VSL landing pages

Paid-traffic landing pages for GTME.School (Meta Ads and Google Ads):

| Route | File | Audience | Primary CTA |
|---|---|---|---|
| `/vsl` (also `/`) | `vsl.html` | Individuals: career switchers, SDRs, founders, operators | Apply for the Program |
| `/corporate-vsl` | `corporate-vsl.html` | Companies: sales leaders, SDR managers, RevOps, HR / L&D | Request a Team Consultation |

Same stack as gtme.school: static HTML, one CSS file, vanilla JS, no build step. One Vercel serverless function (`/api/apply`) receives form submissions so no webhook URL or credential ever reaches the browser.

## Run locally

```bash
npm run dev          # http://localhost:3000/vsl and /corporate-vsl
npm test             # unit tests for /api/apply
npm run migrate      # create the Supabase tables (needs POSTGRES_URL)
```

To exercise the real database locally, pull the project's variables first
(`vercel env pull .env.local`) and start the dev server with them loaded.

Add `?debug=1` to any page URL to log every tracking event to the console (also stored in `window.__gtmeEvents`).

## Deploy (Vercel)

1. Import this repository into Vercel. Framework preset: **Other**. No build command, no output directory.
2. Connect a Supabase database: Project → Storage → Supabase. The integration sets
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and the `POSTGRES_*` variables itself; that is all
   `/api/apply` needs in order to store applications. See **Where applications are stored** below.
3. Optional environment variables:
   - `APPLY_WEBHOOK_URL` — also push each application to Zapier / Make / n8n / a CRM / Slack.
   - `CORPORATE_WEBHOOK_URL` — separate destination for corporate enquiries.
   - `APPLY_WEBHOOK_SECRET` — sent as `X-GTME-Secret` so the receiver can reject forged posts.
4. Point a domain at it (for example `apply.gtme.school`), or a path on gtme.school via rewrites.

If **neither** Supabase nor a webhook is configured, `/api/apply` returns 503 and the form falls
back to opening a pre-filled email to hello@gtme.school. No `Lead` event fires in that case.

## Where applications are stored

Every submission is written to Supabase by `/api/apply` using the service-role key, which stays on
the server. Two tables, created by `supabase/migrations/0001_applications.sql`:

| Table | What's in it |
|---|---|
| `applications` | One row per applicant, keyed on `lead_id`. Step 1, the full application and the booked call all update the same row, so a row reads as the whole story: name, email, phone, the six answers, `qualified`, UTM tags, and `contact_at` / `applied_at` / `booked_at`. |
| `application_events` | Append-only log of every accepted POST, with the full payload in `payload` (jsonb). Never updated or deleted, so nothing is ever lost if an answer changes. |

There is also an `applications_overview` view with just the columns you want when reading the
funnel in the dashboard.

Row Level Security is enabled on both tables with **no policies**, so the publishable/anon key the
browser holds cannot read or write them — only the serverless function and the Supabase dashboard
can. Don't add an `anon` policy.

To read the data: Supabase dashboard → Table Editor → `applications` (or SQL Editor, e.g.
`select * from applications_overview limit 50;`).

### Migrations

The schema lives in `api/_schema.js` (mirrored readably in
`supabase/migrations/0001_applications.sql`) and every statement is idempotent. Three ways to
apply it, in order of convenience:

1. **From the deployment.** Add a `DB_SETUP_TOKEN` environment variable with any long random
   value, redeploy, then open `/api/migrate?token=<that value>`. It connects with the Postgres
   credentials the Supabase integration installed, creates everything and reports the row counts.
   **Delete `DB_SETUP_TOKEN` afterwards** — without it the route answers 404 and does nothing.
2. **Supabase SQL editor.** Paste `supabase/migrations/0001_applications.sql`, then `0002_cal_bookings.sql`, and run them.
3. **Locally.** `vercel env pull .env.local`, then `POSTGRES_URL='postgresql://…' npm run migrate`.

## Configure — `assets/js/config.js`

Everything the campaign owner changes lives in one file. Empty values mean "not configured": the page shows a labelled placeholder or skips loading the script.

| Setting | What it does |
|---|---|
| `tracking.gtmId` | Loads Google Tag Manager |
| `tracking.metaPixelId` | Loads the Meta Pixel |
| `tracking.googleAds.id` + `conversions.{Lead,CompleteRegistration,Schedule}` | Direct Google Ads conversions (leave empty if Ads runs through GTM) |
| `funnels.<funnel>.videoSrc` / `videoPoster` | The VSL. `.mp4` URL, or a YouTube / Vimeo / Wistia / Loom link |
| `funnels.<funnel>.calendlyUrl` | Booking calendar shown to qualified applicants |
| `funnels.<funnel>.qualification.disqualifyIf` | Rules that decide who sees the booking step |
| `funnels.<funnel>.askInvestment` / `investmentOptions` | Optional investment-readiness question (off until approved) |
| `proof.*` | Student screenshots, verified stats, LinkedIn recommendations, corporate testimonials. Placeholders show until these are filled |

## Funnel

1. Visitor watches the VSL → `ViewContent`
2. Submits the application → validated in the browser and again on the server → `Lead`
3. Qualification is evaluated from the configured rules
   - qualified → `CompleteRegistration`, booking step opens with name, email and UTM tags prefilled in Calendly
   - not qualified → `Disqualified` (custom), a polite message, no booking step
4. Calendly page viewed → `BookingView` (custom); call booked → `Schedule`

## Tracking events

| Event | Fires when | Meta | GTM `dataLayer` event | Google Ads |
|---|---|---|---|---|
| PageView | Page loads (once) | `PageView` | `gtme_page_view` | – |
| ViewContent | VSL starts playing (once per page) | `ViewContent` | `gtme_view_content` | – |
| VideoProgress | 25 / 50 / 75 / 100 % of a self-hosted VSL | custom | `gtme_video_progress` | – |
| Lead | Application accepted by `/api/apply` | `Lead` | `gtme_lead` | if label set |
| CompleteRegistration | Applicant passes qualification | `CompleteRegistration` | `gtme_complete_registration` | if label set |
| Disqualified | Applicant does not pass qualification | custom | `gtme_disqualified` | – |
| BookingView | Calendly booking page viewed | custom | `gtme_booking_view` | – |
| Schedule | Calendly booking confirmed | `Schedule` | `gtme_schedule` | if label set |

De-duplication: every event fires at most once per page load. `Lead`, `CompleteRegistration`, `Disqualified` and `Schedule` are also remembered for the browser session (per email address), so refreshes and re-submits never double-count. Each event carries an `event_id` you can reuse for Meta Conversions API de-duplication. No names, emails or phone numbers are sent to any pixel.

UTM parameters, `fbclid`, `gclid`, landing page and referrer are captured on arrival and sent with the application payload.

## Files

```
vsl.html, corporate-vsl.html   the two pages
assets/css/v2.css              v2 design system (gtme.school black / white grid / ember gradient, Space Grotesk · Poppins · Inter)
assets/css/vsl.css             previous design, no longer linked by the pages (safe to delete)
assets/js/config.js            all configuration
assets/js/track.js             tracking hooks (GTMETrack.event)
assets/js/vsl.js               video, testimonials, proof slots, form, qualification, Calendly, FAQ
assets/js/motion.js            v2 motion only: scroll progress, counters, sticky engine, live-build demo, tabs, rails, calculator
api/apply.js                   serverless form handler (validation, honeypot, Supabase, webhook forwarding)
api/_supabase.js               writes each submission to the applications / application_events tables
api/_schema.js                 the schema both migration paths apply
api/migrate.js                 one-time, DB_SETUP_TOKEN-guarded route that creates the tables (and checks one lead's booking sync)
api/cal-webhook.js             Cal.com webhook: signed booking events → the application row in Supabase
api/_cal.js                    Cal.com API client, webhook signature check, booking normalisation
supabase/migrations/*.sql      the same schema, to paste into the Supabase SQL editor
scripts/migrate.js             applies the schema from a connection string (`npm run migrate`)
scripts/dev.js                 local server that mirrors vercel.json
tests/apply.test.js            handler tests
tests/cal.test.js              booking sync tests (webhook + browser report, against an in-memory Supabase / Cal.com fake)
```

## Still needed before ads go live

See the checklist in the pull request / hand-off notes. In short: the edited VSL videos, Pixel / GTM / Google Ads IDs, verified student proof, a privacy policy URL, the recorded-course checkout URL, and sign-off on the qualification rules and the corporate program format. (Applications already store to Supabase, and the call calendar is live.)

## v2 design notes

- Motion respects `prefers-reduced-motion` and every section still reads without JavaScript.
- Market figures (63 → 3,342 postings, +5,205%, ~70% mention Clay, 71% use AI tools) come from Nish's YouTube research slides. Confirm the original sources before running ads.
- Result numbers (24.8K sent, 2.3% reply, 183 opportunities; 23.5K / 81; 549 / 37 / 25) are read from the dashboard screenshots in `assets/img`.

## Individual page v2.3: changes from the Nov 6 founder / marketing review

Section order on `/vsl`: hero (Apply CTA → `#apply`) · GTM engineering intro · the program in brief ·
student testimonials · **application form** · campaign work samples · market demand · curriculum (the
six machines, shown once, as expandable modules) · founder · investment (one program, $4,000) · FAQ · final CTA.

Removed: the Problem (before/after) section, the Opportunity orbit, the sticky "engine" animation, the
live-build simulation, the "Your path" post-application timeline, the Principal / Lieutenant tracks,
the "Who it's for" tabs, the quote rotator and the dashed proof placeholders.

- The VSL frame spans the full content width. Until `funnels.individual.videoSrc` is set it shows "Video coming soon".
- `funnels.individual.curriculumUrl` (new) shows a "Download the curriculum" link only once a real file is set.
- `proof.*` items render under the testimonials only when filled; nothing shows while they are empty.

## Individual funnel v2.2: multi-step application and routing

```
/vsl  ── 7-step application ──┬─ qualified ──────▶ /apply/qualified  (Cal.com calendar, prefilled) ──▶ /apply/booked (what to prepare)
                              └─ not qualified ──▶ /apply/not-a-fit  (recorded course, ₹999)
```

- **Step 1** asks for name, email and phone/WhatsApp, and is POSTed to `/api/apply` as `stage: "contact"` the moment the person clicks Continue, so abandoned forms can be followed up.
- **Steps 2–7** are one-click questions (also keyboard A–F): which best describes you, the goal in 6 months, what you've tried so far, 6–10 hours a week, the $4,000 investment and when you want to start.
- **Qualification** lives in `funnels.individual.qualification` in `config.js`. By default anyone answering "Not right now" to the investment question goes to the course offer, and "Yes" or "Need a payment plan" goes to the calendar.
- **Booking** is `funnels.individual.bookingUrl` in `config.js`, set to `https://cal.com/shrinishkarsh/gtme-school`. It is embedded inline on `/apply/qualified` with the applicant's name and email prefilled, and a confirmed booking posts `stage: "call_booked"` back to `/api/apply`. Change the link there and the embed and its namespace follow.
- **Still to fill in** (`config.js`): `downsell.url` (checkout for the ₹999 course; until it's set the button opens an email), `prepVideoSrc` (optional video on the booked page).

### Stages (for Supabase and the optional CRM webhook)

Every request carries the same `lead_id`, so one `applications` row — and any Zapier / Make / n8n automation — moves through the pipeline instead of collecting duplicates:

| `stage` | `lead_stage` | When |
|---|---|---|
| `contact` | `started` | step 1 completed |
| `application` | `qualified` / `not_qualified` | all 7 steps sent |
| `call_booked` | `call_booked` | call booked on `/apply/qualified` (includes `booking_time`, `booking_ref`), confirmed with Cal.com |
| (Cal.com webhook) | `call_booked` / `call_requested` / `call_cancelled` / `call_rejected` | booking created, rescheduled, requested, cancelled or rejected in Cal.com |

### Cal.com booking sync

```
form (/vsl) ──▶ /api/apply ──▶ Supabase row (answers + utm_source/medium/campaign/term/content)
                                   ▲
/apply/qualified: Cal.com embed    │  lead_id, name, email, UTM tags passed into the booking
   │ booking confirmed             │
   ├─ browser ─▶ /api/apply (stage call_booked) ─ checked with the Cal.com API ─┤
   └─ Cal.com ─▶ /api/cal-webhook (signed) ───── re-read from the Cal.com API ──┘
```

- **No repeated questions.** The `gtme-school` event asks nothing the form already asked: name and
  email are prefilled from the application (Cal.com requires both, so they can't be removed), and
  the phone question is hidden. The name is locked; the email stays editable because Cal.com refuses
  addresses that can't receive mail, and an applicant with a typo must be able to fix it. Only the
  optional notes and guests fields remain.
- **Booking → row.** Either path writes `cal_booking_id`, `cal_booking_uid`, `booking_start`,
  `booking_end`, `booking_status` (accepted / pending / cancelled / rejected) and `lead_stage` onto the
  applicant's row. The webhook is the reliable one: it works even if the applicant closes the tab
  right after booking, and it also records reschedules and cancellations.
- **Matching.** `metadata.lead_id` on the booking (set by the embed) → the booking uid (or the uid a
  reschedule replaced) → the attendee's email. A booking made from the bare Cal.com link without
  applying still gets its own row.
- **Safety.** Webhooks without a valid `X-Cal-Signature-256` get 401. Every booking is re-read from
  the Cal.com API before it is stored, and a browser report for a uid Cal.com doesn't know, or that
  belongs to someone else, gets 400. The API key and webhook secret only exist as server-side
  environment variables.
- **Duplicates.** A repeat application from the same email (new tab, other device) merges onto the
  first row. A webhook delivered twice is logged once. Each write carries the time Cal.com produced
  that state, and an older state never overwrites a newer one, so late or out-of-order deliveries
  are harmless. The same browser session is not offered a second booking.
- **Failures.** If the calendar fails to load, the page offers the direct booking link (prefilled)
  and the email address. If the browser report fails it is retried once, and the webhook still
  records the booking.

| Variable | |
|---|---|
| `CAL_API_KEY` | Cal.com → Settings → Developer → API keys. Used to confirm every booking. |
| `CAL_WEBHOOK_SECRET` | The secret set on the Cal.com webhook. Without it `/api/cal-webhook` answers 503. |
| `CAL_EVENT_SLUGS` | Optional. Event slugs to sync, comma-separated. Default `gtme-school,gtme-school-copy`. |

The Cal.com webhook (event type `gtme-school` → Webhooks) points at
`https://<site>/api/cal-webhook` with triggers Booking created, rescheduled, requested, cancelled
and rejected, and the same secret as `CAL_WEBHOOK_SECRET`.

To check one lead end to end without opening the database, with `DB_SETUP_TOKEN` set:
`/api/migrate?token=<token>&lead_id=<lead_id>` returns its stage, UTM tags and booking columns
(no name, email or phone).

### Tracking events (individual)

`Lead` when step 1 is saved · `ApplicationStep` per step · `SubmitApplication` (Meta standard event) when the application is sent · `CompleteRegistration` on `/apply/qualified` · `Disqualified` and `DownsellClick` on `/apply/not-a-fit` · `BookingView` and `Schedule` on the calendar. The corporate page is unchanged.
