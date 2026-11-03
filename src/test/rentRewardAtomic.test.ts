import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyRentRewardPost } from '../../supabase/functions/_shared/rentRewardOutcome';

const ROOT = resolve(__dirname, '..', '..');
const EDGE = readFileSync(resolve(ROOT, 'supabase/functions/process-supporter-roi/index.ts'), 'utf8').replace(/\r\n/g, '\n');
const MIGRATION = readFileSync(resolve(ROOT, 'supabase/migrations/20261024170000_rent_reward_atomic_post.sql'), 'utf8');

describe('classifyRentRewardPost', () => {
  it('posted only when the database says posted', () => {
    expect(classifyRentRewardPost({ status: 'posted', amount: 67500 }, null)).toEqual({ action: 'posted', reason: 'posted' });
  });
  it('a held reinvest portfolio defers the reward (retry next run), never errors or falls back', () => {
    const o = classifyRentRewardPost(null, { code: '42501', message: 'PORTFOLIO_ON_HOLD: portfolio WIP1 is on a CFO hold' });
    expect(o).toEqual({ action: 'defer', reason: 'reinvest_portfolio_on_hold' });
  });
  it('an unavailable reinvest portfolio defers the reward', () => {
    expect(classifyRentRewardPost(null, { message: 'RENT_REWARD_REINVEST_TARGET_UNAVAILABLE: portfolio x' }).action).toBe('defer');
  });
  it('already posted / not due / not eligible are skips', () => {
    for (const s of ['already_posted', 'not_due', 'not_eligible']) expect(classifyRentRewardPost({ status: s }, null).action).toBe('skip');
  });
  it('a row left by the old flow is skipped for CFO review, not posted over', () => {
    expect(classifyRentRewardPost({ status: 'recorded_without_schedule' }, null))
      .toEqual({ action: 'skip', reason: 'recorded_without_schedule_needs_review' });
  });
  it('any other failure or an unknown result is an error (nothing was recorded, the next run retries)', () => {
    expect(classifyRentRewardPost(null, { message: 'timeout' }).action).toBe('error');
    expect(classifyRentRewardPost({ status: 'weird' }, null).action).toBe('error');
    expect(classifyRentRewardPost(undefined, null).action).toBe('error');
  });
});

describe('process-supporter-roi reward loop (source guard)', () => {
  const loop = EDGE.slice(EDGE.indexOf('for (const rr of fundedRequests || [])'), EDGE.indexOf('POST-PAYOUT: Merge pending top-ups'));
  it('posts each reward through the atomic database function', () => {
    expect(loop).toContain("supabase.rpc('post_rent_facilitation_reward'");
  });
  it('never writes the payment row, the portfolio principal, the ledger or the schedule itself', () => {
    expect(loop).not.toMatch(/from\(['"]supporter_roi_payments['"]\)/);
    expect(loop).not.toMatch(/from\(['"]investor_portfolios['"]\)\s*\.update/);
    expect(loop).not.toContain("rpc('create_ledger_transaction'");
    expect(loop).not.toMatch(/from\(['"]rent_requests['"]\)\s*\.update/);
  });
  it('notifications and recovery steps run only after a posted outcome', () => {
    const postedAt = loop.indexOf("if (outcome.action === 'error') throw");
    expect(postedAt).toBeGreaterThan(0);
    for (const step of ["apply_roi_advance_recovery", "apply_smartphone_roi_pledge", "from('notifications')"]) {
      expect(loop.indexOf(step)).toBeGreaterThan(postedAt);
    }
  });
});

describe('migration 20261024170000', () => {
  it('posting function is callable by the service role only', () => {
    expect(MIGRATION).toMatch(/REVOKE EXECUTE ON FUNCTION public\.post_rent_facilitation_reward\(uuid, integer, uuid, text\) FROM PUBLIC, anon, authenticated;/);
    expect(MIGRATION).toMatch(/GRANT EXECUTE ON FUNCTION public\.post_rent_facilitation_reward\(uuid, integer, uuid, text\) TO service_role;/);
  });
  it('never falls back from a refused reinvestment to a wallet credit', () => {
    expect(MIGRATION).not.toMatch(/EXCEPTION\s+WHEN/i);
  });
});
