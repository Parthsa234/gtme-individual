/*
 * GET|POST /api/migrate?token=... — creates the tables /api/apply writes to.
 *
 * It runs inside the deployment, so it uses the Postgres credentials the Vercel <-> Supabase
 * integration already installed here and no database password has to be copied anywhere.
 *
 * Guarded by DB_SETUP_TOKEN: without that environment variable set the route answers 404 and
 * does nothing, so it is inert on any deployment that has not deliberately enabled it. Unset
 * DB_SETUP_TOKEN once the schema is in place.
 *
 * The SQL (api/_schema.js) is idempotent, so calling this more than once is harmless.
 */
'use strict';

const schema = require('./_schema.js');

const CANDIDATES = ['POSTGRES_URL', 'POSTGRES_URL_NON_POOLING', 'POSTGRES_PRISMA_URL', 'DATABASE_URL'];

function timingSafeEqual(a, b) {
  const crypto = require('crypto');
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const expected = process.env.DB_SETUP_TOKEN;
  const given = (req.query && req.query.token) || '';
  // Disabled, or the wrong token: look exactly like a route that does not exist.
  if (!expected || !given || !timingSafeEqual(given, expected)) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  let Client;
  try { Client = require('pg').Client; } catch (e) {
    return res.status(500).json({ ok: false, error: 'pg_missing', message: 'The "pg" package is not installed in this deployment.' });
  }

  const tried = [];
  for (const key of CANDIDATES) {
    if (!process.env[key]) continue;
    const client = new Client({ connectionString: process.env[key], ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000, statement_timeout: 60000 });
    try {
      await client.connect();
      await client.query(schema.sql);
      const counts = await client.query(
        'select (select count(*) from public.applications) as applications, (select count(*) from public.application_events) as events');
      await client.end();
      return res.status(200).json({
        ok: true,
        applied: schema.name,
        via: key,
        rows: counts.rows[0],
        next: 'Remove the DB_SETUP_TOKEN environment variable now that the schema is in place.'
      });
    } catch (e) {
      tried.push({ via: key, error: (e && e.message) || String(e) });
      try { await client.end(); } catch (e2) {}
    }
  }

  if (!tried.length) {
    return res.status(503).json({ ok: false, error: 'no_connection_string', message: 'No POSTGRES_URL in this deployment. Connect Supabase in Vercel → Storage, then redeploy.' });
  }
  console.error('[migrate]', JSON.stringify(tried));
  return res.status(502).json({ ok: false, error: 'connect_failed', tried });
};
