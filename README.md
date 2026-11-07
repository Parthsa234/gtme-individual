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
2. **Supabase SQL editor.** Paste `supabase/migrations/0001_applications.sql` and run it.
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
api/book.js                    GET /book: personalised Cal.com link, reads the lead from Supabase
api/_booking.js                signs booking links, normalises phones, builds the prefilled Cal.com URL
api/migrate.js                 one-time, DB_SETUP_TOKEN-guarded route that creates the tables
supabase/migrations/*.sql      the same schema, to paste into the Supabase SQL editor
scripts/migrate.js             applies the schema from a connection string (`npm run migrate`)
scripts/dev.js                 local server that mirrors vercel.json
tests/apply.test.js            handler tests
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

### Personalised booking links (Supabase → Cal.com)

Every individual lead who finished step 1, or who qualified, gets a personalised booking link:

```
https://gtme-individual.vercel.app/book?lead=<lead_id>&sig=<signature>
```

- `/api/apply` creates it and returns it as `booking_link` in its response and in the
  `APPLY_WEBHOOK_URL` payload, so Zapier / Make / n8n can email or WhatsApp it, for example to
  people who left the form after step 1. Not-qualified applicants and corporate enquiries get no link.
- When someone opens it, `/api/book` checks the signature, reads that lead's row from Supabase
  (`applications`, by `lead_id`) and redirects to the Cal.com event with **name, email and phone
  prefilled** and `metadata[lead_id]` attached to the booking. The lead only picks a slot and confirms.
  Nothing is booked automatically.
- The link contains no personal data, and the signature stops anyone from guessing other leads' links.
- Already booked → `/apply/booked`. Marked not qualified → `/apply/not-a-fit`. Row missing or
  Supabase unreachable → the plain Cal.com event, so a real lead can still book.
- The calendar embedded on `/apply/qualified` now also prefills the phone and the lead_id.

Phone prefill needs the event's phone question switched on (Cal.com → event → Advanced → Booking
questions → "Phone number", identifier `attendeePhoneNumber`). Cal.com only accepts E.164, so numbers
are normalised (`+91 98765 43210` → `+919876543210`; a bare 10-digit number is assumed to be Indian)
and left out when they can't be normalised safely.

| Variable | |
|---|---|
| `BOOKING_LINK_SECRET` | **Required.** At least 16 random characters. Without it no links are issued and `/book` answers 404. |
| `CAL_BOOKING_URL` | The event to book, e.g. the simplified copy. Default `https://cal.com/shrinishkarsh/gtme-school`. Keep it the same as `bookingUrl` in `config.js`. |
| `CAL_PHONE_FIELD` | Phone question identifier. Default `attendeePhoneNumber`; `none` turns phone prefill off. Keep it the same as `bookingPhoneField` in `config.js`. |
| `DEFAULT_PHONE_COUNTRY_CODE` | For bare 10-digit numbers. Default `91`. |
| `PUBLIC_SITE_URL` | Origin used in links. Default: the host the form was submitted to. |

### Stages (for Supabase and the optional CRM webhook)

Every request carries the same `lead_id`, so one `applications` row — and any Zapier / Make / n8n automation — moves through the pipeline instead of collecting duplicates:

| `stage` | `lead_stage` | When |
|---|---|---|
| `contact` | `started` | step 1 completed |
| `application` | `qualified` / `not_qualified` | all 7 steps sent |
| `call_booked` | `call_booked` | call booked on `/apply/qualified` (includes `booking_time`, `booking_ref`) |

### Tracking events (individual)

`Lead` when step 1 is saved · `ApplicationStep` per step · `SubmitApplication` (Meta standard event) when the application is sent · `CompleteRegistration` on `/apply/qualified` · `Disqualified` and `DownsellClick` on `/apply/not-a-fit` · `BookingView` and `Schedule` on the calendar. The corporate page is unchanged.
