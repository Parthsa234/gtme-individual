/*
 * Applies supabase/migrations/*.sql to the connected Supabase project.
 *
 * Runs as the Vercel build step (see "buildCommand" in vercel.json), where the Postgres
 * credentials the Supabase integration installed are already in the environment. That means the
 * tables /api/apply writes to exist before the deployment goes live, and no database password
 * ever has to be copied anywhere by hand. Every migration is idempotent, so re-running on each
 * deploy is a no-op once the schema is in place.
 *
 * It never fails the build: a database hiccup must not stop the landing page from deploying.
 * Check the build log for "[migrate]" lines to see what happened.
 *
 * Locally:  POSTGRES_URL='postgresql://...' npm run migrate
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CANDIDATES = ['POSTGRES_URL', 'POSTGRES_URL_NON_POOLING', 'POSTGRES_PRISMA_URL', 'DATABASE_URL'];

function sqlFiles() {
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(function (f) { return f.endsWith('.sql'); }).sort()
    .map(function (f) { return { name: f, sql: fs.readFileSync(path.join(dir, f), 'utf8') }; });
}

async function main() {
  const files = sqlFiles();
  if (!files.length) return console.log('[migrate] no migrations found, nothing to do');

  const urls = CANDIDATES.map(function (k) { return { key: k, url: process.env[k] }; }).filter(function (c) { return c.url; });
  if (!urls.length) return console.warn('[migrate] no Postgres connection string in the environment (' + CANDIDATES.join(', ') + ') — skipping. Run supabase/migrations/*.sql by hand in the Supabase SQL editor.');

  let Client;
  try { Client = require('pg').Client; } catch (e) {
    return console.warn('[migrate] the "pg" package is not installed — skipping. Run `npm install` or apply supabase/migrations/*.sql by hand.');
  }

  for (const cand of urls) {
    const client = new Client({ connectionString: cand.url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, statement_timeout: 120000 });
    try {
      await client.connect();
      console.log('[migrate] connected via ' + cand.key);
      for (const f of files) {
        await client.query(f.sql);
        console.log('[migrate] applied ' + f.name);
      }
      console.log('[migrate] schema up to date');
      await client.end();
      return;
    } catch (e) {
      console.warn('[migrate] ' + cand.key + ' failed: ' + ((e && e.message) || e));
      try { await client.end(); } catch (e2) {}
    }
  }
  console.warn('[migrate] could not apply migrations with any connection string. The site still deploys; /api/apply will report an error until the tables exist.');
}

main().catch(function (e) { console.warn('[migrate] unexpected error: ' + ((e && e.message) || e)); })
  .then(function () { process.exit(0); });
