import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Integration test for `agent_resubmit_rent_request` RPC.
 *
 * Runs a transactional psql script (BEGIN ... ROLLBACK) against the live
 * Supabase Postgres so no data persists. Skipped automatically when the
 * sandbox lacks PG env vars or psql binary (e.g. CI without DB access).
 *
 * Verifies that clicking Resubmit on a rejected rent request:
 *  - flips status from 'rejected' back to its previous stage ('pending')
 *  - recomputes access_fee / request_fee / total_repayment / daily_repayment
 *    via the canonical Welile compound formula (DB trigger)
 *  - increments reopen_count, stamps resubmitted_at/note, clears rejection fields
 *  - inserts the system_events row without enum errors
 */

const sqlPath = path.join(__dirname, 'agent_resubmit_rent_request.sql');

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

describe.runIf(canRun)('agent_resubmit_rent_request (integration)', () => {
  it('rebuilds totals and flips status to pending without errors', () => {
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
    expect(output).toContain('PASS: resubmit RPC updated all fields correctly');
    expect(output).toContain('ROLLBACK');
  }, 30_000);
});

describe.skipIf(canRun)('agent_resubmit_rent_request (integration)', () => {
  it.skip('skipped: no PGHOST or psql in environment', () => {});
});