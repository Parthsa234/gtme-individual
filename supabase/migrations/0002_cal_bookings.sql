-- GTME.School individual VSL — Cal.com booking sync.
--
-- Adds the confirmed Cal.com booking to each application row, written server-side by
-- /api/cal-webhook (Cal.com → us) and by /api/apply when the browser reports a booking (which is
-- checked against the Cal.com API before anything is stored). Safe to re-run.
--
--   cal_booking_id / cal_booking_uid   Cal.com's numeric id and uid for the booking
--   booking_start / booking_end        the scheduled call, as timestamptz
--   booking_status                     Cal.com's status: accepted | pending | cancelled | rejected
--   booking_event_at                   when Cal.com produced the newest booking state we stored.
--                                      Updates older than this are ignored, so a late or
--                                      re-delivered webhook can never roll a row back.
--   booking_source                     webhook | api — which path wrote the current state
--   email_lower                        lower(email), used to merge repeat applications from the
--                                      same person onto one row and to match bookings to rows.

alter table public.applications add column if not exists cal_booking_id      bigint;
alter table public.applications add column if not exists cal_booking_uid     text;
alter table public.applications add column if not exists cal_event_type      text;
alter table public.applications add column if not exists booking_start       timestamptz;
alter table public.applications add column if not exists booking_end         timestamptz;
alter table public.applications add column if not exists booking_status      text;
alter table public.applications add column if not exists booking_cancel_reason text;
alter table public.applications add column if not exists booking_event_at    timestamptz;
alter table public.applications add column if not exists booking_source      text;
alter table public.applications add column if not exists booking_last_trigger text;
alter table public.applications add column if not exists email_lower text generated always as (lower(email)) stored;

create index if not exists applications_email_lower_idx on public.applications (funnel, email_lower);
create index if not exists applications_cal_booking_uid_idx on public.applications (cal_booking_uid);

-- De-duplicates webhook deliveries: the same Cal.com event delivered twice is logged once.
alter table public.application_events add column if not exists dedupe_key text;
create unique index if not exists application_events_dedupe_key_key on public.application_events (dedupe_key);

-- The overview gains the booking columns (appended, so the existing view can be replaced in place).
create or replace view public.applications_overview as
select
  lead_id,
  created_at,
  full_name,
  email,
  phone,
  lead_stage,
  qualified,
  persona,
  goal,
  invest,
  start_when,
  utm_source,
  utm_campaign,
  booked_at,
  utm_medium,
  utm_term,
  utm_content,
  cal_booking_id,
  booking_start,
  booking_status
from public.applications
order by created_at desc;

-- Security: a plain view runs as its owner and so bypasses the tables' RLS, and Supabase grants
-- anon/authenticated SELECT on new public objects by default. Without this, anyone holding the
-- public anon key could read applicants' names, emails and phones through the view.
alter view public.applications_overview set (security_invoker = true);
revoke all on public.applications_overview from anon, authenticated;
revoke all on public.applications      from anon, authenticated;
revoke all on public.application_events from anon, authenticated;
