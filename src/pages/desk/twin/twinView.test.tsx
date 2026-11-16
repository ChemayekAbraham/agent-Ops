import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readTwin, type HistoryDay, type Twin } from './twinModel';
import { TwinError, type TwinSource } from './twinSource';
import { TwinView } from './TwinView';
import { LIVE } from './twinFixture';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));

beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/desk/twin');
});

function source(now: () => Promise<Twin | null>, day?: (d: string) => Promise<Twin | null>, history: HistoryDay[] = []): TwinSource {
  return {
    kind: 'board',
    now: () => now(),
    day: (d) => (day ? day(d) : Promise.resolve(null)),
    history: () => Promise.resolve(history),
    realtime: null,
  };
}

const redactedLive = () =>
  readTwin({
    ...LIVE,
    payload: {
      ...LIVE.payload,
      redacted: ['partner'],
      partner: undefined,
      nodes: LIVE.payload.nodes.filter((n) => n.lane !== 'partner'),
      checks: LIVE.payload.checks.filter((c) => c.lane !== 'partner'),
    },
  });

// Rendering the full view takes a few seconds when the whole suite runs in parallel.
describe('TwinView', { timeout: 20_000 }, () => {
  it('says what is on screen and opens a desk panel from the river', async () => {
    render(<TwinView source={source(async () => readTwin(LIVE))} board={false} />);
    expect(await screen.findByText(/^Live, updated \d\d:\d\d EAT$/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Service Centre: show what happened here' }));
    const panel = screen.getByRole('region', { name: 'River detail' });
    expect(within(panel).getByText(/Waiting now: 3,803 \(UGX 791.38M\)/)).toBeTruthy();
    expect(within(panel).getByText(/Past the time limit: 3,797/)).toBeTruthy();
    expect(within(panel).getByText('To Agent Ops queue')).toBeTruthy();
    expect(within(panel).getByText('From New submission')).toBeTruthy();
    expect(within(panel).getByText(/Recommendation: Give staff IDs/)).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Show on the map' })).toBeTruthy();

    // Keyboard works too: the basin.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Sent back, rejected or recalled: show the moves' }), { key: 'Enter' });
    expect(within(screen.getByRole('region', { name: 'River detail' })).getByText('Brought back by agents')).toBeTruthy();

    // "Open the lane" moves to that lane's view.
    fireEvent.click(screen.getByRole('button', { name: 'Service Centre: show what happened here' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open the Rent pipeline lane' }));
    expect(screen.getByRole('button', { name: /Rent pipeline/, current: 'page' })).toBeTruthy();
  }, 20_000);

  it('shows the partner lane totals and the plain line when partner detail is withheld', async () => {
    render(<TwinView source={source(async () => redactedLive())} board={false} />);
    await screen.findByText(/^Live, updated/);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Funders and partners/ }));
    expect(screen.getAllByText(/Partner detail is limited to the COO, CEO and CFO/).length).toBeGreaterThan(0);
    // The lane's totals still show (with returns, never ROI).
    expect(screen.getAllByText('Returns credits raised').length).toBeGreaterThan(0);
    expect(screen.queryByText(/\bROI\b/)).toBeNull();
  });

  it('shows a reconstructed day with its note and only the river, money, partner flows and checks', async () => {
    const day = readTwin({
      run_id: 6,
      run_at: '2026-11-12T05:00:00Z',
      source: 'reconstructed',
      reconstructed: true,
      payload: {
        window_label: 'Wed 11 Nov 08:00 – Thu 12 Nov 08:00 EAT',
        note: 'Reconstructed on 15 Nov 2026. Queues, statuses and backlog were not recorded that day.',
        hours: LIVE.payload.hours,
        hourly: { 'coo|fwd': [0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
        kpis: { moves: 106 },
        checks: [{ key: 'bursts', label: 'Bulk moves', ok: false, severity: 'watch', value: 1, rec: 'Confirm.', lane: 'pipeline' }],
        lanes: [{ key: 'pipeline', label: 'Rent pipeline', failed: 1, gap_failed: 0, metrics: [] }],
      },
    });
    window.history.replaceState(null, '', '/desk/twin?day=2026-11-12');
    render(<TwinView source={source(async () => readTwin(LIVE), async () => day)} board />);
    expect(await screen.findByText('Saved run 6, Wed 11 Nov 08:00 – Thu 12 Nov 08:00 EAT')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/not recorded that day/);
    expect(screen.getByRole('heading', { name: 'Money in the window' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Partner flows in the window' })).toBeTruthy();
    expect(screen.getByText('Bulk moves')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Company and lanes' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /objects, links and actions/ })).toBeNull();
  });

  it('reads the gaps on the map: red gap links, named gap actions and chains in the side panel', async () => {
    const withChain = readTwin({ ...LIVE, payload: { ...LIVE.payload, links: [...LIVE.payload.links, { id: 9, from: 'O7', to: 'A4', label: 'does' }] } });
    const { container } = render(<TwinView source={source(async () => withChain)} board={false} />);
    await screen.findByText(/^Live, updated/);
    fireEvent.click(screen.getByRole('button', { name: 'Gaps only' }));

    const map = container.querySelector('#twin-map')!;
    const svg = map.querySelector('svg[aria-label="Map of objects, actions and links"]')!;
    const red = svg.querySelectorAll('line[data-gap-link]');
    expect(red).toHaveLength(1);
    expect(red[0].getAttribute('opacity')).toBe('1');
    expect([...svg.querySelectorAll('line:not([data-gap-link])')].every((l) => l.getAttribute('opacity') === '0.06')).toBe(true);
    expect(svg.querySelector('text.twin-action-name')?.textContent).toBe('Service Centre verify');

    const panel = within(map as HTMLElement);
    expect(panel.getByRole('heading', { name: 'Reading the gaps' })).toBeTruthy();
    const chain = panel.getByRole('region', { name: 'Chain 1' });
    expect(within(chain).getAllByRole('listitem').map((li) => li.textContent)).toContain('Service Centre manager does Service Centre verify');
    expect(panel.getByText(/2 gaps: 1 chain of gaps that touch, 0 on their own/)).toBeTruthy();

    fireEvent.click(within(chain).getByRole('button', { name: /O7 Service Centre manager/ }));
    expect(panel.getByRole('heading', { name: 'Service Centre manager' })).toBeTruthy();
  });

  it('says plainly when the database refuses this viewer', async () => {
    render(<TwinView source={source(async () => Promise.reject(new TwinError('OPS_TWIN_NOT_ALLOWED')))} board={false} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/The twin is open to the COO, CEO, CFO, CTO, super admins/));
  });
});
