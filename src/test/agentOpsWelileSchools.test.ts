import { describe, it, expect } from 'vitest';
import { GraduationCap } from 'lucide-react';
import {
  BUSINESS_AREAS,
  ALL_DASHBOARD_FEATURES,
} from '@/components/executive/agentOpsFeatureRegistry';

/**
 * Welile Schools is Core Business Area #15. Both lists must agree: BUSINESS_AREAS
 * drives the grid, ALL_DASHBOARD_FEATURES drives search. Updating one without the
 * other is the failure this guards.
 */
describe('Welile Schools as Core Business Area 15', () => {
  it('is the 15th entry in the business areas grid', () => {
    expect(BUSINESS_AREAS).toHaveLength(15);

    const last = BUSINESS_AREAS[BUSINESS_AREAS.length - 1];
    expect(last).toMatchObject({
      num: '15',
      title: 'Welile Schools',
      section: 'welile-schools',
      category: 'field',
    });
    expect(last.icon).toBe(GraduationCap);
  });

  it('has no duplicate numbers or sections in the grid', () => {
    const nums = BUSINESS_AREAS.map((b) => b.num);
    const sections = BUSINESS_AREAS.map((b) => b.section);
    expect(new Set(nums).size).toBe(nums.length);
    expect(new Set(sections).size).toBe(sections.length);
  });

  it('appears in the search list with the same section and number', () => {
    const feature = ALL_DASHBOARD_FEATURES.find((f) => f.id === 'core-15-welile-schools');
    expect(feature).toBeDefined();
    expect(feature).toMatchObject({
      title: 'Welile Schools',
      section: 'welile-schools',
      categoryGroup: 'Core Business Areas',
      isCoreBusinessArea: true,
      businessAreaNum: '15',
    });
    expect(feature!.icon).toBe(GraduationCap);
  });

  it('keeps every grid entry and search entry in step', () => {
    const coreFeatures = ALL_DASHBOARD_FEATURES.filter((f) => f.isCoreBusinessArea);
    expect(coreFeatures).toHaveLength(BUSINESS_AREAS.length);

    for (const area of BUSINESS_AREAS) {
      const match = coreFeatures.filter((f) => f.section === area.section);
      expect(match, `search entry for ${area.section}`).toHaveLength(1);
      expect(match[0].businessAreaNum, `number for ${area.section}`).toBe(area.num);
      expect(match[0].title).toBe(area.title);
    }
  });
});
