/*
 * The database schema that /api/apply writes to. Kept as a module so the one-time
 * /api/migrate route and `npm run migrate` apply exactly the same SQL, and so the route
 * needs no extra files bundled into the function.
 *
 * The same SQL is mirrored, readably, in supabase/migrations/0001_applications.sql, 0002_cal_bookings.sql and 0003_brochure_leads.sql for anyone
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

-- A readable view of the funnel for the dashboard. Created only when missing: 0002 replaces it with
-- more columns, and re-running this "create or replace" afterwards would fail ("cannot drop columns
-- from view") and abort the whole migration script.
do $mig$ begin if to_regclass('public.applications_overview') is null then execute $v$
create view public.applications_overview as
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
order by created_at desc
$v$; end if; end $mig$;

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

/* 0003: brochure download lead capture. Mirrors supabase/migrations/0003_brochure_leads.sql.
   String.raw keeps the regex backslashes in the check constraints intact. */
const SQL_0003 = String.raw`-- GTME.School individual VSL — brochure download lead capture.
--
-- Written only by /api/brochure (service-role key, server-side). Safe to re-run: every statement
-- is idempotent.
--
--   brochure_leads             one row per person who asked for the brochure. De-duplicated on
--                              lower(email) within THIS table only: a repeat download updates the
--                              existing row instead of adding another. Other lead tables
--                              (applications, ...) are untouched and keep their own rules.
--   brochure_download_events   one row per accepted brochure request, linked to its lead. Status
--                              moves requested → initiated | failed as the browser reports back.
--   brochure_capture(...)      the single entry point /api/brochure calls: rate-limits, upserts the
--                              lead and creates the event in one transaction.
--   brochure_set_status(...)   records what the browser reported about the download.
--
-- Security: RLS on, no policies, all privileges revoked from anon/authenticated, and the functions
-- are executable by service_role only. The publishable/anon key in a browser can neither read nor
-- write any of this. Do not add an anon policy.

create extension if not exists pgcrypto;

create table if not exists public.brochure_leads (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  full_name     text not null check (char_length(full_name) between 2 and 120),
  email         text not null check (char_length(email) between 5 and 160 and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'),
  phone         text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  profession    text not null check (profession in ('Student', 'Working Professional', 'Agency Owner', 'Freelancer', 'Founder / Business Owner', 'Other')),
  source        text not null default 'gtme_vsl_brochure',
  landing_page  text,
  referrer      text,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  utm_content   text,
  utm_term      text
);

-- Case-insensitive de-duplication, scoped to this table.
create unique index if not exists brochure_leads_email_lower_key on public.brochure_leads (lower(email));
create index if not exists brochure_leads_created_at_idx on public.brochure_leads (created_at desc);
create index if not exists brochure_leads_utm_source_idx on public.brochure_leads (utm_source);

create table if not exists public.brochure_download_events (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references public.brochure_leads (id) on delete cascade,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  brochure_name    text not null,
  brochure_version text,
  download_status  text not null default 'requested' check (download_status in ('requested', 'initiated', 'failed')),
  failure_reason   text,
  source           text not null default 'gtme_vsl_brochure',
  landing_page     text,
  utm_source       text,
  utm_medium       text,
  utm_campaign     text,
  -- Salted SHA-256 of the requester's IP, used only for rate limiting. Never the IP itself.
  ip_hash          text
);

create index if not exists brochure_download_events_lead_id_idx    on public.brochure_download_events (lead_id, created_at desc);
create index if not exists brochure_download_events_created_at_idx on public.brochure_download_events (created_at desc);
create index if not exists brochure_download_events_ip_hash_idx    on public.brochure_download_events (ip_hash, created_at desc);

alter table public.brochure_leads           enable row level security;
alter table public.brochure_download_events enable row level security;
revoke all on public.brochure_leads           from anon, authenticated;
revoke all on public.brochure_download_events from anon, authenticated;

/*
 * One brochure request: rate limit → upsert lead on lower(email) → new event (status requested).
 * Returns { ok, lead_id, event_id, new_lead } or { ok:false, error:'rate_limited' }.
 * Limits: 5 requests per email per 10 minutes, 20 per IP hash per hour.
 */
create or replace function public.brochure_capture(
  p_full_name text, p_email text, p_phone text, p_profession text,
  p_landing_page text, p_referrer text,
  p_utm_source text, p_utm_medium text, p_utm_campaign text, p_utm_content text, p_utm_term text,
  p_brochure_name text, p_brochure_version text, p_ip_hash text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
  v_lead  uuid;
  v_new   boolean;
  v_event uuid;
begin
  -- Serialise requests for the same address so the limit and the upsert see each other.
  perform pg_advisory_xact_lock(hashtext('brochure:' || v_email));

  if (select count(*) from public.brochure_download_events e
        join public.brochure_leads l on l.id = e.lead_id
       where lower(l.email) = v_email and e.created_at > now() - interval '10 minutes') >= 5
     or (p_ip_hash is not null and (select count(*) from public.brochure_download_events e
       where e.ip_hash = p_ip_hash and e.created_at > now() - interval '1 hour') >= 20) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  -- First touch keeps its attribution; contact details take the latest values (typo fixes).
  insert into public.brochure_leads as l
    (full_name, email, phone, profession, landing_page, referrer,
     utm_source, utm_medium, utm_campaign, utm_content, utm_term)
  values
    (btrim(p_full_name), v_email, p_phone, p_profession, p_landing_page, p_referrer,
     p_utm_source, p_utm_medium, p_utm_campaign, p_utm_content, p_utm_term)
  on conflict (lower(email)) do update
    set full_name  = excluded.full_name,
        phone      = excluded.phone,
        profession = excluded.profession,
        updated_at = now()
  returning l.id, (l.xmax = 0) into v_lead, v_new;

  insert into public.brochure_download_events
    (lead_id, brochure_name, brochure_version, download_status, landing_page,
     utm_source, utm_medium, utm_campaign, ip_hash)
  values
    (v_lead, p_brochure_name, p_brochure_version, 'requested', p_landing_page,
     p_utm_source, p_utm_medium, p_utm_campaign, p_ip_hash)
  returning id into v_event;

  return jsonb_build_object('ok', true, 'lead_id', v_lead, 'event_id', v_event, 'new_lead', v_new);
end;
$$;

/*
 * What the browser reported about one download. Only requested/failed events can change, only to
 * initiated/failed, and only within an hour of the request, so a replayed report can't rewrite
 * history. Returns true when the row changed.
 */
create or replace function public.brochure_set_status(p_event_id uuid, p_status text, p_reason text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare n int;
begin
  if p_status not in ('initiated', 'failed') then return false; end if;
  update public.brochure_download_events
     set download_status = p_status,
         failure_reason  = case when p_status = 'failed' then left(p_reason, 120) else null end,
         updated_at      = now()
   where id = p_event_id
     and download_status in ('requested', 'failed')
     and created_at > now() - interval '1 hour';
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke all on function public.brochure_capture(text, text, text, text, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.brochure_set_status(uuid, text, text) from public, anon, authenticated;
grant execute on function public.brochure_capture(text, text, text, text, text, text, text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.brochure_set_status(uuid, text, text) to service_role;
grant select, insert, update on public.brochure_leads, public.brochure_download_events to service_role;

-- A readable join for the dashboard: which lead each download belongs to. security_invoker so it
-- obeys the tables' RLS, and closed to anon/authenticated like the tables.
create or replace view public.brochure_downloads_overview with (security_invoker = true) as
select
  e.created_at,
  e.download_status,
  e.brochure_version,
  l.full_name,
  l.email,
  l.phone,
  l.profession,
  e.utm_source,
  e.utm_medium,
  e.utm_campaign,
  e.landing_page,
  l.created_at as lead_first_seen,
  e.id as event_id,
  l.id as lead_id
from public.brochure_download_events e
join public.brochure_leads l on l.id = e.lead_id
order by e.created_at desc;
revoke all on public.brochure_downloads_overview from anon, authenticated;

comment on table public.brochure_leads is
  'One row per brochure requester (unique on lower(email)), written by /api/brochure via brochure_capture().';
comment on table public.brochure_download_events is
  'One row per accepted brochure request, linked to brochure_leads. Status: requested → initiated | failed.';
`;

/* Applied in order, as one script. Every statement is idempotent. */
module.exports = {
  name: '0003_brochure_leads',
  migrations: ['0001_applications', '0002_cal_bookings', '0003_brochure_leads'],
  sql: SQL_0001 + '\n' + SQL_0002 + '\n' + SQL_0003
};
