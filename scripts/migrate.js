/*
 * Applies supabase/migrations/*.sql to the connected Supabase project.
 *
 * Two ways to put the schema in place; both apply api/_schema.js, which is idempotent:
 *   - this script, with a connection string:  POSTGRES_URL='postgresql://...' npm run migrate
 *   - GET /api/migrate?token=... on a deployment, which uses the Postgres credentials the
 *     Supabase integration already installed there, so no password is copied by hand.
 */
'use strict';
const schema = require('../api/_schema.js');

const CANDIDATES = ['POSTGRES_URL', 'POSTGRES_URL_NON_POOLING', 'POSTGRES_PRISMA_URL', 'DATABASE_URL'];

/* Supabase serves its database behind a certificate chain Node does not trust by default, so the
   connection is made with rejectUnauthorized:false. node-postgres lets `sslmode` in the
   connection string win over the ssl option, which would reinstate verification and fail with
   "self-signed certificate in certificate chain" — so strip it and set ssl explicitly. */
function clientOptions(connectionString) {
  let cs = connectionString;
  try { const u = new URL(cs); u.searchParams.delete('sslmode'); cs = u.toString(); } catch (e) {}
  return { connectionString: cs, ssl: { rejectUnauthorized: false } };
}

async function main() {
  const files = [schema];
  const urls = CANDIDATES.map(function (k) { return { key: k, url: process.env[k] }; }).filter(function (c) { return c.url; });
  if (!urls.length) return console.warn('[migrate] no Postgres connection string in the environment (' + CANDIDATES.join(', ') + ') — skipping. Use GET /api/migrate?token=... instead, or paste supabase/migrations/0001_applications.sql into the Supabase SQL editor.');

  let Client;
  try { Client = require('pg').Client; } catch (e) {
    return console.warn('[migrate] the "pg" package is not installed — skipping. Run `npm install` or apply the SQL by hand.');
  }

  for (const cand of urls) {
    const client = new Client(Object.assign(clientOptions(cand.url), { connectionTimeoutMillis: 15000, statement_timeout: 120000 }));
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
