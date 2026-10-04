import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MissionBanner, type MissionBannerData } from './MissionBanner';

/**
 * Quick responsive checks for the Mission banner.
 *
 * jsdom does not run a real layout/paint engine, so these tests assert the
 * crispness-critical styling contract that keeps the banner readable on every
 * smartphone size and orientation:
 *  - fluid clamp() font sizes (scale smoothly, never pixelate)
 *  - NO blur/drop-shadow over text (the past blur regression)
 *  - single-column goals on small/portrait screens
 *  - break-words / hyphens so long text never overflows
 *
 * We re-render the banner under a matrix of common phone viewports +
 * orientations to confirm the contract holds regardless of device dimensions.
 */

const MISSION: MissionBannerData = {
  mission:
    'Place 1,000 verified tenants this month while keeping our agent network the unstoppable driving force of Welile.',
  goals: [
    'Onboard 500 new landlords with confirmed GPS locations',
    'Keep daily collections above the agent target every single day',
    'Zero phantom wallet drift across all operator dashboards',
  ],
  font_family: null,
  period_month: '2026-06',
  posted_by_name: 'Welile CEO',
};

// Common smartphone sizes in both portrait and landscape.
const VIEWPORTS: Array<{ name: string; w: number; h: number }> = [
  { name: 'iPhone SE portrait', w: 375, h: 667 },
  { name: 'iPhone SE landscape', w: 667, h: 375 },
  { name: 'iPhone 12/13/14 portrait', w: 390, h: 844 },
  { name: 'iPhone 12/13/14 landscape', w: 844, h: 390 },
  { name: 'iPhone Pro Max portrait', w: 430, h: 932 },
  { name: 'Pixel/Galaxy portrait', w: 360, h: 800 },
  { name: 'Galaxy Fold (narrowest)', w: 280, h: 653 },
];

function setViewport(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      // Resolve min-width / orientation queries against the simulated viewport.
      const minWidth = /min-width:\s*(\d+)px/.exec(query);
      const orientationPortrait = /orientation:\s*portrait/.test(query);
      const orientationLandscape = /orientation:\s*landscape/.test(query);
      let matches = false;
      if (minWidth) matches = w >= Number(minWidth[1]);
      else if (orientationPortrait) matches = h >= w;
      else if (orientationLandscape) matches = w > h;
      return {
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => {},
      };
    },
  });
  window.dispatchEvent(new Event('resize'));
}

function renderBanner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MissionBanner dashboardRole="ceo" missionOverride={MISSION} />
    </QueryClientProvider>,
  );
}

describe('MissionBanner responsive crispness', () => {
  afterEach(() => cleanup());

  for (const vp of VIEWPORTS) {
    describe(`${vp.name} (${vp.w}x${vp.h})`, () => {
      beforeEach(() => setViewport(vp.w, vp.h));

      it('renders the mission headline and all goals', () => {
        renderBanner();
        expect(screen.getByText(MISSION.mission!)).toBeInTheDocument();
        for (const g of MISSION.goals) {
          expect(screen.getByText(g)).toBeInTheDocument();
        }
      });

      it('scales the headline with a fluid clamp() font size (no pixelation)', () => {
        renderBanner();
        const headline = screen.getByText(MISSION.mission!);
        expect(headline.className).toMatch(/text-\[clamp\(/);
        expect(headline.className).toContain('break-words');
      });

      it('never blurs or drop-shadows the text (crispness contract)', () => {
        renderBanner();
        const headline = screen.getByText(MISSION.mission!);
        expect(headline.className).not.toMatch(/backdrop-blur/);
        expect(headline.className).not.toMatch(/drop-shadow/);
        expect(headline.className).toContain('text-white');
        for (const g of MISSION.goals) {
          const goal = screen.getByText(g);
          expect(goal.className).not.toMatch(/backdrop-blur/);
          expect(goal.className).not.toMatch(/drop-shadow/);
        }
      });

      it('stacks goals in a single column on small/portrait screens', () => {
        renderBanner();
        const goalList = screen.getByText(MISSION.goals[0]).closest('ul');
        expect(goalList).not.toBeNull();
        // Mobile-first single column; only widens to 2 columns at md breakpoint.
        expect(goalList!.className).toContain('grid-cols-1');
        expect(goalList!.className).toContain('md:grid-cols-2');
      });
    });
  }
});