import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { MERCHANT_QUEUE_STATUSES, isMerchantQueueActionable } from '@/lib/merchantPayoutQueue';

/**
 * ONE ACTIVE CLAIM PER MERCHANT.
 *
 * The enforcing authority is `public.claim_withdrawal_verified` (advisory-locked
 * per merchant) plus the `release-stale-cashout-claims` pg_cron job. The pure
 * model below MIRRORS that SQL rule so the invariants are covered even where a
 * database connection is unavailable; the psql suite proves the real thing.
 */

interface Row {
  id: string;
  agent: string | null;
  status: string;
  processed_at?: string | null;
  fin_ops_reference?: string | null;
}

/** Mirror of the RPC's blocking query. */
function blockingClaim(rows: Row[], agent: string, target: string): string | null {
  const hit = rows.find(
    (r) =>
      r.agent === agent &&
      r.id !== target &&
      isMerchantQueueActionable({
        status: r.status,
        processed_at: r.processed_at ?? null,
        fin_ops_reference: r.fin_ops_reference ?? null,
      } as any),
  );
  return hit ? hit.id : null;
}

/** Mirror of the claim path: refuse when a blocker exists, else assign. */
function claim(rows: Row[], agent: string, target: string): { ok: boolean; error?: string; blocking_withdrawal_id?: string } {
  const blocker = blockingClaim(rows, agent, target);
  if (blocker) return { ok: false, error: 'active_claim_exists', blocking_withdrawal_id: blocker };
  const row = rows.find((r) => r.id === target);
  if (!row) return { ok: false, error: 'not_found' };
  if (row.agent !== null) return { ok: false, error: 'already_claimed' };
  row.agent = agent;
  return { ok: true };
}

const M = 'merchant-1';

function open(id: string): Row {
  return { id, agent: null, status: 'pending', processed_at: null, fin_ops_reference: null };
}

describe('one active claim per merchant', () => {
  it('lets a merchant claim one available withdrawal', () => {
    const rows = [open('w1'), open('w2')];
    expect(claim(rows, M, 'w1').ok).toBe(true);
    expect(rows[0].agent).toBe(M);
  });

  it('refuses a second claim while the first is still active', () => {
    const rows = [open('w1'), open('w2')];
    claim(rows, M, 'w1');
    const res = claim(rows, M, 'w2');
    expect(res.error).toBe('active_claim_exists');
    expect(res.blocking_withdrawal_id).toBe('w1');
    expect(rows[1].agent).toBeNull();
  });

  it.each(['completed', 'rejected', 'cancelled'])('allows another claim after the first is %s', (status) => {
    const rows = [open('w1'), open('w2')];
    claim(rows, M, 'w1');
    rows[0].status = status;
    rows[0].processed_at = '2026-09-11T10:00:00Z';
    expect(claim(rows, M, 'w2').ok).toBe(true);
  });

  it('allows another claim after the stale-release cron frees the first', () => {
    const rows = [open('w1'), open('w2')];
    claim(rows, M, 'w1');
    rows[0].agent = null; // release_stale_cashout_claims()
    expect(claim(rows, M, 'w2').ok).toBe(true);
  });

  it('two concurrent attempts by the same merchant leave exactly one assignment', () => {
    const rows = [open('w1'), open('w2')];
    // The advisory lock serialises the two attempts; simulate that ordering.
    const first = claim(rows, M, 'w1');
    const second = claim(rows, M, 'w2');
    expect(first.ok).toBe(true);
    expect(second.error).toBe('active_claim_exists');
    expect(rows.filter((r) => r.agent === M)).toHaveLength(1);
  });

  it('a settled/evidenced row assigned to the merchant never blocks a new claim', () => {
    const rows: Row[] = [
      { id: 'w1', agent: M, status: 'pending', processed_at: null, fin_ops_reference: 'TID1' },
      open('w2'),
    ];
    expect(claim(rows, M, 'w2').ok).toBe(true);
  });

  it('another merchant is unaffected by this merchant’s active claim', () => {
    const rows = [open('w1'), open('w2')];
    claim(rows, M, 'w1');
    expect(claim(rows, 'merchant-2', 'w2').ok).toBe(true);
  });

  it('queue placement is exclusive: shared queue only when unassigned', () => {
    const rows = [open('w1'), open('w2')];
    claim(rows, M, 'w1');
    const shared = rows.filter((r) => r.agent === null && isMerchantQueueActionable(r as any));
    const claimed = rows.filter((r) => r.agent === M && isMerchantQueueActionable(r as any));
    expect(shared.map((r) => r.id)).toEqual(['w2']);
    expect(claimed.map((r) => r.id)).toEqual(['w1']);
    expect(shared.some((r) => claimed.includes(r))) .toBe(false);
  });

  it('uses the canonical merchant queue statuses', () => {
    expect(MERCHANT_QUEUE_STATUSES).toContain('pending');
    expect(MERCHANT_QUEUE_STATUSES).not.toContain('paid');
  });
});

// --- Real database invariants (skipped without psql/PGHOST) ---

const sqlPath = path.join(__dirname, 'merchant_one_active_claim.sql');

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

describe.runIf(canRun)('merchant claim guard (integration)', () => {
  it('enforces the claim gate, stale-release safeguards and cron registration', () => {
    let output = '';
    try {
      output = execFileSync('bash', ['-c', `psql -v ON_ERROR_STOP=1 -f ${JSON.stringify(sqlPath)} 2>&1`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      throw new Error(`psql failed: ${e?.message}\n${e?.stdout?.toString() ?? ''}\n${e?.stderr?.toString() ?? ''}`);
    }
    expect(output).toContain('PASS: claim RPC enforces one active claim per merchant, race-safe');
    expect(output).toContain('PASS: stale release keeps 45-minute + zero-evidence safeguards');
    expect(output).toContain('PASS: release-stale-cashout-claims cron registered every 5 minutes');
    expect(output).toContain('PASS: merchant claim invariants all green');
    expect(output).toContain('ROLLBACK');
  }, 60_000);
});

describe.skipIf(canRun)('merchant claim guard (integration)', () => {
  it.skip('skipped: no PGHOST or psql in environment', () => {});
});
