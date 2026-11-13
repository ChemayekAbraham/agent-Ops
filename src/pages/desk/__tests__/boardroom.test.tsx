import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MAP, STAGES_RAW } from '@/lib/boardMap.fixtures';

/** E97: the Command Centre's Boardroom view, fed by boardroom_feed, drawn by the board's own screens. */

const h = vi.hoisted(() => ({ rpc: vi.fn(), mapProps: [] as Record<string, unknown>[] }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => h.rpc(...a), from: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['coo'] }) }));
// The ops map needs Google Maps; its props are what this view owes it.
vi.mock('@/pages/board/OpsMapScreen', () => ({
  OpsMapScreen: (p: Record<string, unknown>) => {
    h.mapProps.push(p);
    return (
      <main data-screen="map">
        {p.switcher as ReactNode}
        <span>ops map {String(p.label)}</span>
      </main>
    );
  },
}));

import { BOARD_ROTATE_MS } from '@/lib/boardDisplay';
import { BOARDROOM_LIST_MISSING, Boardroom } from '../Boardroom';

const BOARDROOM_SCREENS = [
  { key: 'funders', label: 'Funders' },
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'map', label: 'Ops map' },
];

const total = { n: 1, ugx: 100000 };
const headline = Object.fromEntries(
  ['today', '7d', '30d', '90d', 'all'].map((p) => [p, { posted: total, sold: total, selected: total, waiting: total }]),
);
const feedFor = (screen: string) => ({
  generated_at: '2026-11-13T08:00:00Z',
  headline,
  stages: STAGES_RAW,
  map: MAP,
  display: { label: 'Command Centre', screen, home_screen: 'funders', can_switch: true, screens: BOARDROOM_SCREENS },
});
const answerScreens = () =>
  h.rpc.mockImplementation((fn: string, args: { p_screen: string }) =>
    Promise.resolve(fn === 'boardroom_feed' ? { data: feedFor(args.p_screen), error: null } : { data: null, error: null }),
  );

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  h.rpc.mockReset();
  h.mapProps = [];
});
afterEach(() => vi.useRealTimers());

describe('Boardroom view', () => {
  it('asks boardroom_feed for the screen on show; Pipeline and Ops map draw the board’s own screens', async () => {
    answerScreens();
    wrap(<Boardroom onClose={() => {}} />);
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('boardroom_feed', { p_screen: 'funders' }));
    // Funders: the board's four tiles, under CFO 1's switcher.
    await waitFor(() => expect(document.querySelectorAll('[data-metric]').length).toBe(4));
    expect(document.querySelector('[data-screen-switch]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Pipeline' }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('boardroom_feed', { p_screen: 'pipeline' }));
    const pipeline = await waitFor(() => {
      const el = document.querySelector('main[data-screen="pipeline"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(pipeline.textContent).toContain('Service Centre');
    expect(screen.getByRole('button', { name: 'Pipeline' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Ops map' }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('boardroom_feed', { p_screen: 'map' }));
    await screen.findByText('ops map Command Centre');
    const last = h.mapProps[h.mapProps.length - 1] as { map: { names: boolean; layers: { selected: { tenant: string | null }[] } }; idle: boolean };
    // Names included: staff are signed in.
    expect(last.map.names).toBe(true);
    expect(last.map.layers.selected[0].tenant).toBe('Nakiyinji Zaitun');
    expect(last.idle).toBe(false);
  });

  it('a refusal is shown in the server’s words', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'The boardroom views are for the COO, CEO, Command Centre and Funders Dashboard desk' } });
    wrap(<Boardroom onClose={() => {}} />);
    expect((await screen.findByRole('alert', {}, { timeout: 5000 })).textContent).toBe('The boardroom views are for the COO, CEO, Command Centre and Funders Dashboard desk');
  });

  it('auto-rotate moves on a minute at a time, round the three screens; a pick stops it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    answerScreens();
    wrap(<Boardroom onClose={() => {}} />);
    // Each screen draws its own switcher, so the buttons are looked up afresh.
    const btn = (name: string) => screen.getByRole('button', { name });
    const pressed = (name: string) => btn(name).getAttribute('aria-pressed');
    const tick = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(BOARD_ROTATE_MS + 10);
      });
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-rotate' }));
    expect(pressed('Auto-rotate')).toBe('true');
    await tick();
    await waitFor(() => expect(pressed('Pipeline')).toBe('true'));
    await tick();
    await waitFor(() => expect(pressed('Ops map')).toBe('true'));
    await tick();
    await waitFor(() => expect(pressed('Funders')).toBe('true'));
    expect(pressed('Auto-rotate')).toBe('true');

    fireEvent.click(btn('Pipeline'));
    await waitFor(() => expect(pressed('Pipeline')).toBe('true'));
    expect(pressed('Auto-rotate')).toBe('false');
    await tick();
    expect(pressed('Pipeline')).toBe('true');
  });

  it('a funders tile says plainly that its list is on the TV link, not a made-up empty list', async () => {
    answerScreens();
    wrap(<Boardroom onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector('[data-metric="sold"]')).toBeTruthy());
    fireEvent.click(document.querySelector('[data-metric="sold"]')!);
    expect((await screen.findByRole('alert')).textContent).toBe(BOARDROOM_LIST_MISSING);
  });

  it('back to the Command Centre from the switcher slot, and from a refusal', async () => {
    answerScreens();
    const onClose = vi.fn();
    const { unmount } = wrap(<Boardroom onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: '← Command Centre' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    h.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'no' } });
    wrap(<Boardroom onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Back to the Command Centre' }, { timeout: 5000 }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('does not touch the page hash (syncHash off)', async () => {
    window.history.replaceState(null, '', '/desk/command#keep');
    answerScreens();
    wrap(<Boardroom onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pipeline' }));
    await waitFor(() => expect(document.querySelector('main[data-screen="pipeline"]')).toBeTruthy());
    expect(window.location.hash).toBe('#keep');
  });

  it('imports CFO 1’s shared board module unchanged and sits behind a Boardroom tab on the Command Centre', () => {
    const src = readFileSync(resolve(__dirname, '../Boardroom.tsx'), 'utf8');
    expect(src).toContain("import { FundersScreen, OpsMapScreen, PipelineScreen, useBoardScreenControl, type BoardListLoader } from '@/pages/board'");
    expect(src).toContain('useBoardScreenControl(feed, { syncHash: false })');
    const cc = readFileSync(resolve(__dirname, '../CommandCentre.tsx'), 'utf8');
    expect(cc).toContain("lazy(() => import('./Boardroom')");
    expect(cc).toContain("<Boardroom onClose={() => setView('overview')} />");
    expect(cc).toContain("'Boardroom'");
  });
});
