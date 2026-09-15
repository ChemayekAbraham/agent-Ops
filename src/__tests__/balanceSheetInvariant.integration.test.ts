import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Balance sheet (statement of financial position) regression guard.
 *
 * Runs a transactional psql script (BEGIN ... ROLLBACK, temp tables only)
 * against the live Postgres so no data persists. Skipped automatically when the
 * sandbox lacks PG env vars or psql (e.g. CI without DB access).
 *
 * Protects the three failure modes behind the UGX 367,127,036 imbalance:
 *  - rent collections: cash and tenant receivable recognised exactly once, on
 *    opposite sides, under either posting convention
 *  - personal-balance deposits: the custody liability recognised exactly once
 *    and never crossed with the agent-float offset
 *  - agent float top-ups: the same cash never sits in company bank cash and
 *    agent-held float at the same time
 * plus the hard invariant Assets = Liabilities + Equity (and total debits =
 * total credits) at every reporting checkpoint, on existing data and with newly
 * simulated transactions of each affected type applied.
 */

const sqlPath = path.join(__dirname, 'balanceSheetInvariant.sql');

function psqlAvailable(): boolean {
  if (!process.env.PGHOST) return false;
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const canRun = psqlAvailable() && existsSync(sqlPath);

describe.runIf(canRun)('statement of financial position (integration)', () => {
  it('stays balanced for historical and newly created transactions', () => {
    let output = '';
    try {
      // psql NOTICE/RAISE goes to stderr — merge both into one buffer.
      output = execFileSync(
        'bash',
        ['-c', `psql -v ON_ERROR_STOP=1 -f ${JSON.stringify(sqlPath)} 2>&1`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (e: any) {
      const stdout = e?.stdout?.toString() ?? '';
      const stderr = e?.stderr?.toString() ?? '';
      throw new Error(
        `psql failed: ${e?.message}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }

    expect(output).not.toMatch(/FAIL/);
    for (const marker of [
      'PASS invariant holds at all checkpoints',
      'PASS no same-side classification',
      'PASS rent collections',
      'PASS personal-balance deposits',
      'PASS float top-ups',
      'PASS simulated new transactions',
    ]) {
      expect(output).toContain(marker);
    }
    expect(output).toContain('ROLLBACK');
  }, 180_000);
});

describe.skipIf(canRun)('statement of financial position (integration)', () => {
  it.skip('skipped: no PGHOST or psql in environment', () => {});
});
