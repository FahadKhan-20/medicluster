const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const sql = readFileSync(path.join(__dirname, '../supabase/migrations/20261112_agent_realtime.sql'), 'utf8');

test('agent realtime migration publishes medicluster_records and grants read-only access to service_role', () => {
  assert.match(sql, /ALTER PUBLICATION supabase_realtime ADD TABLE public\.medicluster_records/i);
  assert.match(sql, /GRANT SELECT ON public\.medicluster_records TO service_role/i);
});

test('agent realtime migration never grants write privileges', () => {
  assert.doesNotMatch(sql, /GRANT\s+(INSERT|UPDATE|DELETE|ALL)/i);
});

test('agent realtime migration guards the publication add so it is idempotent', () => {
  assert.match(sql, /pg_publication_tables/i);
  assert.match(sql, /DO\s+\$\$/i);
});
