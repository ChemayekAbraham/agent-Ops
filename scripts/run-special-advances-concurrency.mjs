#!/usr/bin/env node
// Special Advances readiness Phase E: run src/test/specialAdvanceConcurrency.test.ts against a THROWAWAY local
// Postgres cluster (real separate connections, which PGlite cannot give). The cluster is created in a temp folder on a
// free localhost port, used once and deleted, even on failure. Nothing else is touched.
//
//   node scripts/run-special-advances-concurrency.mjs
//   PG_BIN="C:/Program Files/PostgreSQL/18/bin" node scripts/run-special-advances-concurrency.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exe = process.platform === 'win32' ? '.exe' : '';
const candidates = [process.env.PG_BIN, 'C:/Program Files/PostgreSQL/18/bin', 'C:/Program Files/PostgreSQL/17/bin',
  'C:/Program Files/PostgreSQL/16/bin', '/usr/lib/postgresql/16/bin', '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean);
const bin = candidates.find((d) => existsSync(join(d, `initdb${exe}`)) && existsSync(join(d, `pg_ctl${exe}`)));
if (!bin) {
  console.error('No local Postgres found (initdb + pg_ctl). Set PG_BIN to its bin folder.');
  process.exit(2);
}

const port = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const dir = mkdtempSync(join(tmpdir(), 'sa-concurrency-'));
const data = join(dir, 'data');
let started = false;
let status = 1;
try {
  execFileSync(join(bin, `initdb${exe}`), ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' });
  execFileSync(join(bin, `pg_ctl${exe}`), ['-D', data, '-l', join(dir, 'pg.log'), '-w', '-o',
    `-p ${port} -c listen_addresses=127.0.0.1 -c max_connections=60 -c fsync=off`, 'start'], { stdio: 'ignore' });
  started = true;
  console.log(`[sa-concurrency] throwaway Postgres on 127.0.0.1:${port} (${bin})`);
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vitest', 'run', 'src/test/specialAdvanceConcurrency.test.ts'], {
    stdio: 'inherit', shell: process.platform === 'win32',
    env: { ...process.env, SA_PG_URL: `postgres://postgres@127.0.0.1:${port}/postgres` },
  });
  status = r.status ?? 1;
} finally {
  if (started) {
    try { execFileSync(join(bin, `pg_ctl${exe}`), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' }); } catch { /* already stopped */ }
  }
  rmSync(dir, { recursive: true, force: true });
  console.log('[sa-concurrency] throwaway cluster stopped and deleted');
}
process.exit(status);
