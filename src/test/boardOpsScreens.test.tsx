import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAP, STAGES_RAW } from '@/lib/boardMap.fixtures';

/* A stand-in for the Google Maps API: records what the ops map makes. */
const g = vi.hoisted(() => {
  const made = { maps: [] as FakeMap[], markers: [] as FakeMarker[], lines: [] as FakeLine[] };
  class FakeMap {
    opts: Record<string, unknown>; fits: unknown[] = [];
    constructor(_el: unknown, opts: Record<string, unknown>) { this.opts = opts; made.maps.push(this); }
    fitBounds(b: unknown) { this.fits.push(b); }
  }
  class FakeMarker {
    opts: Record<string, unknown>; map: unknown = null; listeners: Record<string, () => void> = {};
    constructor(opts: Record<string, unknown>) { this.opts = opts; made.markers.push(this); }
    setMap(m: unknown) { this.map = m; }
    addListener(ev: string, fn: () => void) { this.listeners[ev] = fn; }
  }
  class FakeLine { opts: Record<string, unknown>; map: unknown = null; constructor(opts: Record<string, unknown>) { this.opts = opts; made.lines.push(this); } setMap(m: unknown) { this.map = m; } }
  const maps = { Map: FakeMap, Marker: FakeMarker, Polyline: FakeLine, Size: class { constructor(public w: number, public h: number) {} }, Point: class { constructor(public x: number, public y: number) {} }, SymbolPath: { CIRCLE: 0 } };
  return { made, maps, load: vi.fn(), list: vi.fn() };
});
vi.mock('@/lib/googleMapsScript', () => ({ loadGoogleMapsWith: () => Promise.resolve(g.maps) }));
vi.mock('@/lib/boardDisplayClient', () => ({ loadBoardDisplay: g.load, loadBoardList: g.list, boardMapsKey: () => Promise.resolve('test-key') }));

import BoardDisplay from '@/pages/BoardDisplay';
import { readBoardFeed } from '@/lib/boardDisplay';

const headline = Object.fromEntries(['today', '7d', '30d', '90d', 'all'].map((p) => [p, { posted: { n: 1, ugx: 1 }, sold: { n: 0, ugx: 0 }, selected: { n: 0, ugx: 0 }, waiting: { n: 1, ugx: 1 } }]));
/** What loadBoardDisplay returns: the server's feed read through readBoardFeed, as the real client does. */
const feed = (screenKind: string, over: Record<string, unknown> = {}) => readBoardFeed({
  generated_at: '2026-11-13T08:00:00Z', display: { label: `Boardroom screen ${screenKind === 'map' ? 3 : 2}`, screen: screenKind }, headline, stages: STAGES_RAW,
  ...(screenKind === 'map' ? { map: MAP } : {}), ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  g.load.mockReset();
  g.made.maps.length = 0; g.made.markers.length = 0; g.made.lines.length = 0;
  window.history.replaceState(null, '', '/board/e9f5ba50d5f9');
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const mount = async () => { await act(async () => { render(<BoardDisplay />); }); await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
const visibleMarkers = () => g.made.markers.filter((m) => m.map !== null);

describe('Boardroom screen 3: OPS COMMAND MAP', () => {
  it('top bar, READINESS from map.readiness, LIVE pill and the six KPI tiles', async () => {
    g.load.mockResolvedValue(feed('map'));
    await mount();
    expect(document.querySelector('main')?.getAttribute('data-screen')).toBe('map');
    expect(screen.getByText('WELILE OPS COMMAND')).toBeInTheDocument();
    expect(screen.getByText('UGANDA THEATRE · BOARDROOM SCREEN 3 · OFFICE NETWORK ONLY')).toBeInTheDocument();
    expect(document.querySelector('[data-readiness]')?.textContent).toBe('READINESS · RED');
    expect(screen.getByText('LIVE · 30 s')).toBeInTheDocument();
    const kpi = (k: string) => document.querySelector(`[data-kpi="${k}"]`)?.textContent;
    expect(kpi('sold_today')).toBe('SOLD TODAY · LANDLORD PAID, OTP8UGX 4.45M');
    expect(kpi('selected')).toBe('SELECTED, WAITING · WITH AGENTS5UGX 1.43MOLDEST 7.7 D');
    expect(document.querySelector('[data-kpi="selected"] [data-oldest]')?.getAttribute('data-oldest')).toBe('red');
    expect(kpi('on_board')).toBe('ON FUNDERS BOARD · NOT TAKEN34UGX 19.35M');
    expect(kpi('in_desks')).toBe('IN THE DESKS3,814SC 221 · COO 14');
    expect(kpi('repaying')).toBe('REPAYING · LIVE PLANS983213 ARREARS PINGS');
    expect(kpi('agents')).toBe('FIELD AGENTS · 60 DAYS14577 FROZEN');
  });

  it('a figure the server did not send reads "—", never 0', async () => {
    g.load.mockResolvedValue(feed('map', { map: { ...MAP, kpis: { ...MAP.kpis, sold_today: {}, in_desks: null } } }));
    await mount();
    expect(document.querySelector('[data-kpi="sold_today"]')?.textContent).toBe('SOLD TODAY · LANDLORD PAID, OTP——');
    expect(document.querySelector('[data-kpi="in_desks"] .ops-kpi-value')?.textContent).toBe('—');
  });

  it('the map: centred on Uganda, night style without POI labels, a marker per point; empty houses and repaying start hidden', async () => {
    g.load.mockResolvedValue(feed('map'));
    await mount();
    expect(g.made.maps).toHaveLength(1);
    const opts = g.made.maps[0].opts as { center: unknown; zoom: number; styles: { featureType?: string; stylers: unknown[] }[] };
    expect(opts.center).toEqual({ lat: 1.37, lng: 32.29 });
    expect(opts.zoom).toBe(7);
    expect(opts.styles.find((s) => s.featureType === 'poi')?.stylers).toEqual([{ visibility: 'off' }]);
    // 2 empty-house cells + 1 repaying + 1 desk + 1 on board + 2 agents + 1 sold + 2 selected = 10 markers; 1 dashed line.
    expect(g.made.markers).toHaveLength(10);
    expect(g.made.lines).toHaveLength(1);
    expect(g.made.lines[0].opts.path).toEqual([{ lat: 0.0993199, lng: 32.4988485 }, { lat: 0.31, lng: 32.58 }]);
    expect(visibleMarkers()).toHaveLength(7);
    // The selected ring pulses (an animated SVG on an unoptimised marker).
    const ring = g.made.markers.find((m) => m.opts.optimized === false)!;
    expect(decodeURIComponent(String((ring.opts.icon as { url: string }).url))).toContain('<animate');
    // Frozen agents: amber outline.
    const agentStrokes = g.made.markers.filter((m) => String((m.opts.icon as { path?: unknown }).path).startsWith('M 0 -1')).map((m) => (m.opts.icon as { strokeColor: string }).strokeColor);
    expect(agentStrokes).toEqual(['#D7E3EC', '#F5A524']);
  });

  it('layer switches with counts and GPS coverage; a switch hides and shows its markers', async () => {
    g.load.mockResolvedValue(feed('map'));
    await mount();
    const rail = screen.getByRole('complementary', { name: 'Map layers' });
    const sold = within(rail).getByRole('button', { name: /Sold · landlord paid/ });
    expect(sold).toHaveAttribute('aria-pressed', 'true');
    expect(sold.textContent).toContain('8');
    expect(within(rail).getByRole('button', { name: /Empty houses · heat/ })).toHaveAttribute('aria-pressed', 'false');
    expect(document.querySelector('[data-coverage]')?.textContent).toBe('GPS COVERAGEDesks 3,811 / 3,8143,012 legacy Kigishu not mappedRepaying 727 / 983Agent bases 96');
    const before = visibleMarkers().length;
    fireEvent.click(sold);
    expect(visibleMarkers().length).toBe(before - 1);
    fireEvent.click(within(rail).getByRole('button', { name: /Empty houses · heat/ }));
    expect(visibleMarkers().length).toBe(before + 1);
  });

  it('tapping a selected marker shows its names card; closing it, or a minute passing, puts it away', async () => {
    g.load.mockResolvedValue(feed('map'));
    await mount();
    const ring = g.made.markers.find((m) => m.opts.optimized === false && (m.opts.position as { lat: number }).lat === 0.0993199)!;
    act(() => ring.listeners.click());
    const card = screen.getByRole('dialog', { name: 'Selected, waiting' });
    expect(card.textContent).toContain('Nakiyinji Zaitun');
    for (const line of ['Agent: M. Magezi', 'Funder: B. Muhanguzi', 'Landlord: Landlord K', 'Tenant: Nakiyinji Zaitun']) expect(card.textContent).toContain(line);
    fireEvent.click(within(card).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // A sold marker; the card closes itself after 45 s.
    const soldM = g.made.markers.find((m) => (m.opts.position as { lat: number }).lat === 0.33)!;
    act(() => soldM.listeners.click());
    expect(screen.getByRole('dialog', { name: 'Sold' }).textContent).toContain('Sold Sara');
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('with no names (link not office-locked) the card shows only what came', async () => {
    g.load.mockResolvedValue(feed('map', { map: { ...MAP, names: false } }));
    await mount();
    const nameless = g.made.markers.find((m) => m.opts.optimized === false && (m.opts.position as { lat: number }).lat === 1.2)!;
    act(() => nameless.listeners.click());
    const card = screen.getByRole('dialog');
    expect(card.textContent).not.toMatch(/Tenant:|Agent:|Funder:|Landlord:/);
    expect(card.textContent).toContain('Names show only on the office-network link.');
    expect(screen.getByText('UGANDA THEATRE · BOARDROOM SCREEN 3')).toBeInTheDocument();
  });

  it('alerts by severity, money in motion oldest first with red/amber hours, and the pipeline strip', async () => {
    g.load.mockResolvedValue(feed('map'));
    await mount();
    expect([...document.querySelectorAll('[data-alert]')].map((a) => a.getAttribute('data-alert'))).toEqual(['critical', 'high', 'high', 'medium']);
    const motion = [...document.querySelectorAll('[data-motion]')];
    expect(motion.map((m) => m.getAttribute('data-motion'))).toEqual(['red', 'amber', 'none']);
    expect(motion[1].textContent).toBe('Nakiyinji Zaitun1.5 dB. Muhanguzi → M. Magezi → landlord not paid200K');
    const strip = screen.getByRole('region', { name: 'Pipeline' });
    expect(strip.querySelectorAll('[data-stage]')).toHaveLength(9);
    expect(strip.querySelector('[data-bottleneck]')?.getAttribute('data-stage')).toBe('SERVICE CENTRE');
  });

  it('refreshes every 30 s without rebuilding the map, so the pan and zoom stay; old markers come off', async () => {
    // Like the real client: a fresh feed read on every poll.
    g.load.mockImplementation(() => Promise.resolve(feed('map')));
    await mount();
    const first = g.made.markers.slice();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(g.load).toHaveBeenCalledTimes(2);
    expect(g.made.maps).toHaveLength(1);
    // Fitted to Uganda once, at the start; never again on a refresh.
    expect(g.made.maps[0].fits).toEqual([{ south: -1.5, west: 29.5, north: 4.25, east: 35.05 }]);
    expect(first.every((m) => m.map === null)).toBe(true);
    expect(visibleMarkers()).toHaveLength(7);
  });
});

describe('Boardroom screen 2: PIPELINE', () => {
  it('the lead line and the eight stages in two rows of four, Submitted → … → Selected, waiting', async () => {
    g.load.mockResolvedValue(feed('pipeline'));
    await mount();
    expect(document.querySelector('main')?.getAttribute('data-screen')).toBe('pipeline');
    expect(document.querySelector('[data-pipeline-lead]')?.textContent).toBe('6.9 new requests a day come in; the slowest stage, Service Centre, clears 6.9 a day.');
    const grid = screen.getByRole('region', { name: 'Pipeline' });
    expect(grid.className).toContain('ops-grid');
    expect([...grid.querySelectorAll('[data-stage]')].map((s) => s.getAttribute('data-stage'))).toEqual([
      'SUBMITTED', 'SERVICE CENTRE', 'AGENT OPS', 'TENANT OPS', 'LANDLORD OPS', 'COO APPROVAL', 'FUNDERS BOARD', 'SELECTED, WAITING',
    ]);
    expect(document.querySelector('[data-readiness]')).toBeNull();
    expect(g.made.maps).toHaveLength(0);
  });

  it('a funders link still shows the four-tile board', async () => {
    g.load.mockResolvedValue(feed('funders'));
    await mount();
    expect(document.querySelector('.board-display')).not.toBeNull();
    expect(document.querySelector('[data-screen]')).toBeNull();
  });
});
