import { describe, expect, it } from 'vitest';
import { executiveSidebarConfig } from '@/components/layout/executiveSidebarConfig';

describe('CFO Dashboard Special Advances accessibility', () => {
  it('registers special-advances in executiveSidebarConfig under Advances', () => {
    const cfoSections = executiveSidebarConfig.cfo ?? [];
    const advancesSection = cfoSections.find((s) => s.title === 'Advances');
    expect(advancesSection).toBeDefined();

    const specialItem = advancesSection?.items.find((i) => i.id === 'special-advances');
    expect(specialItem).toBeDefined();
    expect(specialItem?.label).toBe('Special Advances');
  });

  it('preserves sidebar order: Overview -> Requests -> Special Advances -> Disbursed -> Repayments', () => {
    const advancesSection = executiveSidebarConfig.cfo?.find((s) => s.title === 'Advances');
    const ids = advancesSection?.items.map((i) => i.id);
    expect(ids).toEqual([
      'advances-analytics',
      'advances',
      'special-advances',
      'advances-disbursed',
      'advance-repayments',
      'agent-products',
    ]);
  });
});
