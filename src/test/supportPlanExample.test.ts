import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SUPPORT_EXAMPLE_STEPS,
  OPERATIONAL_GUARANTEE_LINE,
  EXAMPLE_MONTHLY_RATE,
  buildSupportPlanExampleLine,
  exampleMonthlyReturn,
  formatFixedUGX,
} from '@/lib/supportPlanExample';

const read = (segments: string[]) =>
  readFileSync(resolve(__dirname, '..', '..', ...segments), 'utf8');

describe('support plan worked example', () => {
  it('shows the five approved steps, in order, with the approved figures', () => {
    expect([...SUPPORT_EXAMPLE_STEPS]).toEqual([
      'You support a tenant with UGX 100,000.',
      'The system pays the UGX 100,000 straight to the landlord.',
      'You earn UGX 15,000 every month for 12 months (UGX 180,000 total).',
      'The tenant pays back the UGX 100,000 plus UGX 15,000 a month.',
      'After 12 months: renew your support, or withdraw your UGX 100,000.',
    ]);
  });

  it('computes the for-this-plan line from the funding amount at the 15% rate', () => {
    expect(EXAMPLE_MONTHLY_RATE).toBe(0.15);
    expect(exampleMonthlyReturn(100000)).toBe(15000);
    expect(exampleMonthlyReturn(700000)).toBe(105000);
    expect(buildSupportPlanExampleLine(100000)).toBe(
      'Support UGX 100,000 → earn UGX 15,000/month for 12 months → then renew or withdraw your UGX 100,000',
    );
    expect(buildSupportPlanExampleLine(700000)).toBe(
      'Support UGX 700,000 → earn UGX 105,000/month for 12 months → then renew or withdraw your UGX 700,000',
    );
  });

  it('rounds a monthly return to whole UGX', () => {
    expect(formatFixedUGX(450001)).toBe('UGX 450,001');
    expect(exampleMonthlyReturn(9999)).toBe(1500);
    expect(buildSupportPlanExampleLine(9999)).toBe(
      'Support UGX 9,999 → earn UGX 1,500/month for 12 months → then renew or withdraw your UGX 9,999',
    );
  });

  it('hides the for-this-plan line when there is no usable amount', () => {
    expect(buildSupportPlanExampleLine(0)).toBeNull();
    expect(buildSupportPlanExampleLine(-500)).toBeNull();
    expect(buildSupportPlanExampleLine(Number.NaN)).toBeNull();
  });

  it('mentions no fee, margin or charge beyond the 15% return', () => {
    const copy = [...SUPPORT_EXAMPLE_STEPS, OPERATIONAL_GUARANTEE_LINE].join(' ');
    expect(copy).not.toMatch(/fee|margin|charge|interest|ROI|loan|lender/i);
  });

  it('keeps the operational guarantee line on both surfaces', () => {
    const publicPage = read(['src', 'pages', 'SupportPlanPublic.tsx']);
    const panel = read(['src', 'components', 'funder-new', 'FunderNewSelectionPanel.tsx']);
    expect(publicPage).toContain(OPERATIONAL_GUARANTEE_LINE);
    expect(panel).toContain(OPERATIONAL_GUARANTEE_LINE);
  });

  it('renders the example block on both surfaces', () => {
    const publicPage = read(['src', 'pages', 'SupportPlanPublic.tsx']);
    const panel = read(['src', 'components', 'funder-new', 'FunderNewSelectionPanel.tsx']);
    expect(publicPage).toContain('<SupportPlanExample fundingAmount={plan.fundingAmount}');
    expect(panel).toContain('<SupportPlanExample fundingAmount={item.amount}');
  });
});
