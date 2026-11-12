/*
 * The database schema that /api/apply writes to. Kept as a module so the one-time
 * /api/migrate route and `npm run migrate` apply exactly the same SQL, and so the route
 * needs no extra files bundled into the function.
 *
 * The same SQL is mirrored, readably, in supabase/migrations/0001_applications.sql and 0002_cal_bookings.sql for anyone
 * who would rather paste it into the Supabase SQL editor. Every statement is idempotent.
 */
'use strict';

const SQL_0001 = `-- GTME.School individual VSL — storage for /api/apply.
--
-- Run this once against the Supabase project connected to this Vercel project
-- (Vercel → Storage → Supabase → Open in Supabase → SQL Editor), or let
-- /api/setup-db create it (see README). Safe to re-run: every statement is idempotent.
--
--   applications        one row per applicant, keyed on lead_id. Step 1 (contact), the full
--                       application and the booked call all update the same row.
--   application_events  append-only log of every POST the endpoint accepted, so a bad merge or
--                       a changed answer never loses the original submission.
--
-- RLS is enabled with no policies, so the browser's anon/publishable key can neither read nor
-- write these tables. Only the serverless function (service-role key) and the Supabase
-- dashboard can touch them. Do not add a policy for the anon role.

create extension if not exists pgcrypto;

create table if not exists public.applications (
  id            uuid primary key default gen_random_uuid(),
  lead_id       text not null unique,

  -- which page and how far they got
  funnel        text not null default 'individual',   -- individual | corporate
  stage         text,                                 -- contact | application | call_booked
  lead_stage    text,                                 -- started | qualified | not_qualified | call_booked | enquiry
  qualified     boolean,
  page          text,

  -- step 1 (individual)
  full_name     text,
  email         text,
  phone         text,
  consent       boolean,

  -- steps 2-7 (individual)
  persona       text,   -- which best describes you
  goal          text,   -- what you want in 6 months
  tried         text,   -- what you have tried so far
  hours_ok      text,   -- 6-10 hours a week
  invest        text,   -- the $4,000 investment
  start_when    text,   -- how soon you want to start

  -- corporate enquiry
  work_email    text,
  company       text,
  role          text,
  team_size     text,
  motion        text,
  timeline      text,
  goals         text,

  -- older / optional individual fields kept by the validator
  why           text,
  experience    text,
  hours         text,
  investment    text,

  -- booked call
  booking_time  text,
  booking_ref   text,

  -- attribution, flattened for filtering plus the full object
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  utm_term      text,
  utm_content   text,
  fbclid        text,
  gclid         text,
  wbraid        text,
  gbraid        text,
  landing_page  text,
  referrer      text,
  attribution   jsonb,

  user_agent    text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  contact_at    timestamptz,   -- step 1 completed
  applied_at    timestamptz,   -- all seven steps sent
  booked_at     timestamptz    -- call booked
);

create index if not exists applications_created_at_idx on public.applications (created_at desc);
create index if not exists applications_email_idx      on public.applications (lower(email));
create index if not exists applications_lead_stage_idx on public.applications (lead_stage);
create index if not exists applications_utm_source_idx on public.applications (utm_source);

create table if not exists public.application_events (
  id          bigserial primary key,
  lead_id     text not null,
  funnel      text,
  stage       text,
  lead_stage  text,
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);

create index if not exists application_events_lead_id_idx    on public.application_events (lead_id);
create index if not exists application_events_created_at_idx on public.application_events (created_at desc);

alter table public.applications       enable row level security;
alter table public.application_events enable row level security;

-- A readable view of the funnel for the dashboard.
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
  booked_at
from public.applications
order by created_at desc;

comment on table public.applications is
  'One row per VSL applicant, upserted on lead_id by /api/apply as they move through the stages.';
comment on table public.application_events is
  'Append-only log of every submission accepted by /api/apply. Never updated or deleted.';
`;

/* 0002: Cal.com booking sync. Mirrors supabase/migrations/0002_cal_bookings.sql. */
const SQL_0002 = `-- GTME.School individual VSL — Cal.com booking sync.
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
`;

/* Applied in order, as one script. Every statement in both is idempotent. */
module.exports = {
  name: '0002_cal_bookings',
  migrations: ['0001_applications', '0002_cal_bookings'],
  sql: SQL_0001 + '\n' + SQL_0002
};
