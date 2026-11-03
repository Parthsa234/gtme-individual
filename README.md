# GTME.School — Individual landing page (standalone Vercel project)

Serves `vsl.html` at `/` and `/vsl`. The link to the other page (`/corporate-vsl`) redirects to https://gtme.school until you change the `redirects` destination in `vercel.json` to wherever the other page is deployed.

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
```

Add `?debug=1` to any page URL to log every tracking event to the console (also stored in `window.__gtmeEvents`).

## Deploy (Vercel)

1. Import this repository into Vercel. Framework preset: **Other**. No build command, no output directory.
2. Set environment variables (Project → Settings → Environment Variables):
   - `APPLY_WEBHOOK_URL` — **required**. Where applications go (Zapier / Make / n8n / CRM / Slack webhook).
   - `CORPORATE_WEBHOOK_URL` — optional. Separate destination for corporate enquiries.
   - `APPLY_WEBHOOK_SECRET` — optional. Sent as `X-GTME-Secret` so the receiver can reject forged posts.
3. Point a domain at it (for example `apply.gtme.school`), or a path on gtme.school via rewrites.

Until `APPLY_WEBHOOK_URL` is set, `/api/apply` returns 503 and the form falls back to opening a pre-filled email to hello@gtme.school (the same behaviour as gtme.school's forms today). No `Lead` event fires in that case.

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
api/apply.js                   serverless form handler (validation, honeypot, webhook forwarding)
scripts/dev.js                 local server that mirrors vercel.json
tests/apply.test.js            handler tests
```

## Still needed before ads go live

See the checklist in the pull request / hand-off notes. In short: the edited VSL videos, Calendly URLs, Pixel / GTM / Google Ads IDs, a webhook destination, verified student proof, a privacy policy URL, and sign-off on the qualification rules and the corporate program format.

## v2 design notes

- Motion respects `prefers-reduced-motion` and every section still reads without JavaScript.
- The countdown in the top notice reads `data-deadline` on `vsl.html` and hides itself once the date passes.
- Market figures (63 → 3,342 postings, +5,205%, ~70% mention Clay, 71% use AI tools) come from Nish's YouTube research slides. Confirm the original sources before running ads.
- Result numbers (24.8K sent, 2.3% reply, 183 opportunities; 23.5K / 81; 549 / 37 / 25) are read from the dashboard screenshots in `assets/img`.
