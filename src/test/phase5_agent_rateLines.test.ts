/**
 * Partner Returns Phase 5, Claude data lines on agent / public / Nexa screens (gemini_tasks.md
 * "Claude data lines still to wire", items 3-6, 11b, 15).
 *
 * 1. Switch-off parity: the shared helpers give exactly today's figures for today's inputs
 *    (every stored rate is 10, 14, 15 or 20 and every amount an integer, checked on production 7 Nov).
 * 2. The data lines read rates without a default (no `|| 10`, `|| 15`, `* 0.15`, `ROI_RATE`,
 *    hub `?? 0`) and through the named helpers. JSX/copy is Gemini's and is not asserted here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { monthlyReturnFor, rateOrNull } from '@/lib/partnerReturnPolicy';

const SRC = join(__dirname, '..');
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

/** Amounts that exercise .5 rounding at every rate in use, plus production-like values. */
function sampleAmounts(): number[] {
  const out: number[] = [0, 1, 50, 100, 1458, 39_675, 91_429, 28_572, 1_000_000, 588_600_000];
  for (let a = 0; a <= 200_000; a++) out.push(a);
  for (let a = 200_000; a <= 50_000_000; a += 997) out.push(a);
  return out;
}

describe('switch-off parity of the helpers the data lines now use', () => {
  it('rateOrNull keeps every stored rate in use (10, 14, 15, 20) and drops only missing / invalid ones', () => {
    for (const r of [10, 14, 15, 20, '15', '20.00']) expect(rateOrNull(r)).toBe(Number(r));
    for (const r of [null, undefined, 0, '', 'x', -5, 101]) expect(rateOrNull(r)).toBeNull();
  });

  it('InvestorPortfolioPublic: monthlyReturnFor(amount, rate) === Math.round(amount * (rate / 100)) for rates in use', () => {
    const diffs: string[] = [];
    for (const r of [10, 14, 15, 20]) {
      for (const a of sampleAmounts()) {
        if (monthlyReturnFor(a, r) !== Math.round(a * (r / 100))) diffs.push(`${a}@${r}`);
      }
    }
    expect(diffs).toEqual([]);
  });

  it('AgentInvestForPartnerDialog / RegisterPartnerPublic preview at the switch-off public rate (15) === Math.round(amount * 0.15)', () => {
    const diffs = sampleAmounts().filter((a) => monthlyReturnFor(a, 15) !== Math.round(a * 0.15));
    expect(diffs).toEqual([]);
  });

  it('an unknown rate gives no figure (null), never a default', () => {
    expect(monthlyReturnFor(1_000_000, null)).toBeNull();
    expect(monthlyReturnFor(1_000_000, rateOrNull(undefined))).toBeNull();
  });
});

describe('data lines carry no default rate', () => {
  const FILES = [
    'components/agent/AgentPartnerDashboardSheet.tsx',
    'components/agent/FunderDetailView.tsx',
    'components/agent/FunderManagementSheet.tsx',
    'pages/InvestorPortfolioPublic.tsx',
    'components/agent/AgentInvestForPartnerDialog.tsx',
    'components/ai-chat/NexaSalesHub.tsx',
    'components/supporter/FunderWalletHubSection.tsx',
    'pages/RegisterPartnerPublic.tsx',
  ];

  it('no `|| 10`, `|| 15`, `?? 15`, `* 0.15`, `* 0.1` or ROI_RATE on a rate', () => {
    const bad = /roi_percentage\)?\s*(\|\||\?\?)\s*\d|\|\|\s*1[05]\b|\?\?\s*1[05]\b|\*\s*0\.1[05]?\b|\bROI_RATE\b/;
    const hits = FILES.flatMap((f) =>
      read(f).split(/\r?\n/).map((l, i) => (bad.test(l) ? `${f}:${i + 1}: ${l.trim()}` : null)).filter(Boolean));
    expect(hits).toEqual([]);
  });

  it('agent partner cards keep a masked rate / Returns figure null', () => {
    expect(read('components/agent/AgentPartnerDashboardSheet.tsx')).toMatch(/roiPercentage:\s*rateOrNull\(p\.roi_percentage\)/);
    const detail = read('components/agent/FunderDetailView.tsx');
    expect(detail).toMatch(/roi_percentage:\s*rateOrNull\(c\.roi_percentage\)/);
    expect(detail).toMatch(/total_roi_earned:\s*c\.total_roi_earned == null \? null/);
    expect(detail).not.toMatch(/^\s*(total_roi_earned|roi_percentage):\s*Number\(c\.\1\)\s*\|\|\s*0,/m);
    expect(read('components/agent/FunderManagementSheet.tsx')).toMatch(/portfolios\.some\(p => p\.total_roi_earned == null\)\s*\n?\s*\?\s*null/);
  });

  it('public portfolio page prices with the stored rate through the helpers', () => {
    expect(read('pages/InvestorPortfolioPublic.tsx')).toMatch(/monthlyReturnFor\(portfolio\.investment_amount,\s*rateOrNull\(portfolio\.roi_percentage\)\)/);
  });

  it('agent invest dialog: preview from the public policy; monthly_reward kept null when the answer leaves it out', () => {
    const f = read('components/agent/AgentInvestForPartnerDialog.tsx');
    expect(f).toMatch(/usePartnerReturnPolicy\(\)/);
    expect(f).toMatch(/monthlyReturnFor\(parsedAmount,\s*newContractRate\)/);
    expect(f).toMatch(/monthly_reward:\s*typeof data\.monthly_reward === 'number' \? data\.monthly_reward : null/);
  });

  it('Nexa sales hub passes the public rate into the engine', () => {
    const f = read('components/ai-chat/NexaSalesHub.tsx');
    expect(f).toMatch(/calculateSupporterSalesProjection\([^)]*newContractRate\)/);
    expect(f).toMatch(/buildPromissoryNoteReminderReply\(newContractRate\)/);
  });

  it('wallet hub passes a masked total / Returns figure through as null (no `?? 0`)', () => {
    const f = read('components/supporter/FunderWalletHubSection.tsx');
    expect(f).not.toMatch(/data\?\.(totalAvailable|roiAmount)\s*\?\?\s*0/);
    expect(f).toMatch(/balance=\{data \? data\.totalAvailable : 0\}/);
    expect(f).toMatch(/roiBalance=\{data \? data\.roiAmount : 0\}/);
  });

  it('registration page: public rate preview, server answer decides the success figure', () => {
    const f = read('pages/RegisterPartnerPublic.tsx');
    expect(f).toMatch(/monthlyReturnFor\(amount,\s*newContractRate\)/);
    expect(f).toMatch(/setAnswerMonthlyRoi\(typeof data\.monthly_roi === 'number' \? data\.monthly_roi : null\)/);
  });
});
