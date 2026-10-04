import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Advance Recovery Isolation — Wallet Routing v2 enforcement.
 *
 * Verifies the DB-side invariants that protect float from advance recovery:
 *  - `agent_repayment` (and friends) can NEVER route to an operational wallet.
 *  - `agent_repayment` MUST be allowed to route to a user wallet.
 *  - `wallet_route_for_category('agent_repayment','cash_out')` lands on
 *    the withdrawable bucket with sign -1.
 *
 * Runs as a transactional psql script (BEGIN ... ROLLBACK), so nothing
 * persists. Skipped when the sandbox lacks PG env vars or psql.
 */

const sqlPath = path.join(__dirname, 'advance_repayment_isolation.sql');

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

describe.runIf(canRun)('advance repayment isolation (integration)', () => {
  it('blocks float routing for agent_repayment and friends', () => {
    let output = '';
    try {
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
    expect(output).toContain('PASS: operational_wallet routing blocked for agent_repayment');
    expect(output).toContain('PASS: user routing accepted for agent_repayment');
    expect(output).toContain('PASS: agent_advance_repayment blocked from operational_wallet');
    expect(output).toContain('PASS: salary_advance_repayment blocked from operational_wallet');
    expect(output).toContain('PASS: debt_recovery blocked from operational_wallet');
    expect(output).toContain('PASS: agent_repayment cash_out routes to withdrawable/-1');
    expect(output).toContain('PASS: advance repayment isolation invariants all green');
    expect(output).toContain('ROLLBACK');
  }, 30_000);
});

describe.skipIf(canRun)('advance repayment isolation (integration)', () => {
  it.skip('skipped: no PGHOST or psql in environment', () => {});
});
