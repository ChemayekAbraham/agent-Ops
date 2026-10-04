import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Gmail outgoing exclusion invariants.
 *
 * Verifies that outgoing/sent/charge/unknown-direction Gmail receipts
 * NEVER create or auto-approve a deposit request, and are recorded in
 * `gmail_deposit_exclusions` with the correct reason.
 *
 * Runs as a transactional psql script (BEGIN ... ROLLBACK) so nothing
 * persists. Skipped when the sandbox lacks PG env vars or psql.
 */

const sqlPath = path.join(__dirname, 'gmail_outgoing_excluded.sql');

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

describe.runIf(canRun)('gmail outgoing exclusion (integration)', () => {
  it('blocks out/charge/null direction emails from becoming deposits', () => {
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
    expect(output).toContain('PASS: outgoing email did not create a deposit');
    expect(output).toContain('PASS: outgoing email logged as outgoing_money_sent');
    expect(output).toContain('PASS: charge email blocked and logged');
    expect(output).toContain('PASS: unknown-direction email blocked and logged');
    expect(output).toContain('PASS: auto_create_deposits_from_gmail skipped all excluded directions');
    expect(output).toContain('PASS: incoming email not logged as excluded');
    expect(output).toContain('PASS: missing-amount email blocked and logged');
    expect(output).toContain('PASS: missing-TID email blocked and logged');
    expect(output).toContain('PASS: all malformed direction values blocked and logged with correct reasons');
    expect(output).toContain('PASS: edge-case payloads survive auto_create_deposits_from_gmail untouched');
    expect(output).toContain('PASS: gmail outgoing exclusion invariants all green');
    expect(output).toContain('ROLLBACK');
  }, 30_000);
});

describe.skipIf(canRun)('gmail outgoing exclusion (integration)', () => {
  it.skip('skipped: no PGHOST or psql in environment', () => {});
});