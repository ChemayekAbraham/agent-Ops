import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { readBoardFeed, type BoardFeed, type BoardPeriod } from '@/lib/boardDisplay';
import { STAGES } from '@/lib/boardMap.fixtures';

vi.mock('@/lib/googleMapsScript', () => ({ loadGoogleMapsWith: () => new Promise(() => {}) }));
vi.mock('@/lib/boardDisplayClient', () => ({ loadBoardDisplay: vi.fn(), loadBoardList: vi.fn(), boardMapsKey: vi.fn() }));

import * as board from '@/pages/board';
import { FundersScreen, PipelineScreen, useBoardScreenControl } from '@/pages/board';

/* What the Command Centre's Boardroom tab imports from src/pages/board. */

const headline = Object.fromEntries(['today', '7d', '30d', '90d', 'all'].map((p) => [p, { posted: { n: 14, ugx: 9_800_000 }, sold: { n: 8, ugx: 4_450_000 }, selected: { n: 5, ugx: 1_430_000 }, waiting: { n: 34, ugx: 19_350_000 } }]));
const SCREENS = [{ key: 'funders', label: 'Funders' }, { key: 'pipeline', label: 'Pipeline' }, { key: 'map', label: 'Ops map' }];
const feed = (shown: string, canSwitch = true): BoardFeed =>
  readBoardFeed({ generated_at: '2026-11-13T08:00:00Z', headline, stages: STAGES, display: { label: 'Boardroom', screen: shown, home_screen: 'funders', can_switch: canSwitch, screens: SCREENS } });

beforeEach(() => { vi.useFakeTimers(); window.history.replaceState(null, '', '/desk/command#boardroom'); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('src/pages/board, the shared boardroom module', () => {
  it('exports the three screens, the switcher, the auto-rotate button and the control hook', () => {
    for (const name of ['FundersScreen', 'PipelineScreen', 'OpsMapScreen', 'ScreenSwitcher', 'AutoRotateButton', 'useBoardScreenControl']) {
      expect(typeof (board as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('FundersScreen: the four tiles from the feed and the period; a tile loads its list through the host\'s loadList', async () => {
    const loadList = vi.fn().mockResolvedValue({ period: '7d', kind: 'sold', count: 0, ugx: 0, shown: 0, rows: [] });
    const onPeriodChange = vi.fn();
    render(<FundersScreen feed={feed('funders')} period={'7d' as BoardPeriod} onPeriodChange={onPeriodChange} loadList={loadList} now={Date.parse('2026-11-13T08:00:00Z')} stale={false} error={null} idle={false} />);
    expect([...document.querySelectorAll('.board-tile')].map((t) => t.getAttribute('data-metric'))).toEqual(['posted', 'sold', 'selected', 'waiting']);
    expect(document.querySelector('.board-tile.board-sold .board-hero-count')?.textContent).toBe('8');
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    expect(onPeriodChange).toHaveBeenCalledWith('30d');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Rent requests sold/ })); });
    expect(loadList).toHaveBeenCalledWith('7d', 'sold', expect.any(AbortSignal));
    expect(screen.getByRole('dialog', { name: 'Rent requests sold' })).toBeInTheDocument();
  });

  it('FundersScreen before the first feed says it is connecting; a fatal error takes the screen', () => {
    const props = { period: 'today' as BoardPeriod, onPeriodChange: vi.fn(), loadList: vi.fn(), now: 0, stale: false, idle: false };
    const { rerender } = render(<FundersScreen feed={null} error={null} {...props} />);
    expect(screen.getByText('Connecting to the command centre…')).toBeInTheDocument();
    rerender(<FundersScreen feed={feed('funders')} error={{ text: 'This display link has been switched off', fatal: true }} {...props} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This display link has been switched off');
    expect(document.querySelector('.board-tile')).toBeNull();
  });

  it('useBoardScreenControl({ syncHash: false }): a desk tab gets the switcher and rotation without its hash being touched', async () => {
    function Host() {
      const [f, setF] = useState<BoardFeed>(feed('funders'));
      const ctl = useBoardScreenControl(f, { syncHash: false });
      return (
        <>
          <span data-wanted>{ctl.wanted ?? 'own'}</span>
          <button type="button" onClick={() => setF(feed(ctl.wanted ?? 'funders'))}>answer</button>
          {f.display.screen === 'pipeline' ? <PipelineScreen switcher={ctl.switcher} label="x" stages={f.stages ?? []} now={0} stale={false} errorText={null} idle={false} /> : ctl.switcher}
        </>
      );
    }
    render(<Host />);
    expect(screen.getByRole('group', { name: 'Screen' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pipeline' }));
    expect(document.querySelector('[data-wanted]')?.textContent).toBe('pipeline');
    fireEvent.click(screen.getByRole('button', { name: 'answer' }));
    expect(document.querySelector('[data-screen="pipeline"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Auto-rotate' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(document.querySelector('[data-wanted]')?.textContent).toBe('map');
    expect(window.location.hash).toBe('#boardroom');
  });

  it('no switcher when the link may not switch', () => {
    function Host() {
      const ctl = useBoardScreenControl(feed('funders', false), { syncHash: false });
      return <div data-host>{ctl.switcher}</div>;
    }
    render(<Host />);
    expect(screen.queryByRole('group', { name: 'Screen' })).toBeNull();
  });
});
