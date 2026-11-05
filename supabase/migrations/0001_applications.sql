-- GTME.School individual VSL — storage for /api/apply.
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
