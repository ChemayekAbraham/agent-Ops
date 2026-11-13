import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import pageSource from '@/pages/AgentServiceCenter.tsx?raw';

const alert = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/hooks/useOverdueVettingAlert', () => ({ useOverdueVettingAlert: () => alert.value }));

import { OverdueVettingBanner } from '@/components/service-center/OverdueVettingBanner';

const PINNED = /\b(sticky|fixed|absolute)\b/;

describe('overdue vetting banner stays in the page flow (phone overlap bug)', () => {
  it('the banner itself is not pinned', () => {
    alert.value = {
      data: { enabled: true, oldest_age_hours: 52, escalated_count: 0 },
      dueSoonBanner: null,
      overdueCount: 12,
    };
    render(<OverdueVettingBanner onJumpToOldest={vi.fn()} />);
    const bar = screen.getByRole('status');
    expect(bar).toHaveTextContent('12 overdue · oldest waiting');
    expect(screen.getByRole('button', { name: /Jump to oldest/ })).toBeInTheDocument();
    for (let el: HTMLElement | null = bar; el && el !== document.body; el = el.parentElement) {
      expect(el.className).not.toMatch(PINNED);
    }
    // Wraps on a 360 px screen instead of pushing the button off the edge.
    expect(bar.className).toMatch(/\bflex-wrap\b/);
  });

  it('the Service Centre page does not wrap it in a sticky or fixed container', () => {
    const at = pageSource.indexOf('<OverdueVettingBanner');
    expect(at).toBeGreaterThan(-1);
    // The JSX just before the banner (its would-be wrapper), comments left out.
    const before = pageSource.slice(Math.max(0, at - 300), at).replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    const lastTag = before.slice(before.lastIndexOf('<'));
    expect(lastTag).not.toMatch(PINNED);
  });
});
