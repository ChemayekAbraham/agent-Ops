import { describe, expect, it, vi } from 'vitest';

// deskAccess reads through the Supabase client; nothing here calls it.
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));
import {
  STATIONS,
  addressWithoutToken,
  buildDots,
  clockAt,
  copy,
  decisionsForNode,
  deskForNode,
  gapChains,
  hourActivity,
  isRedacted,
  laneLinks,
  laneState,
  laneTabs,
  layoutMap,
  moneyLanes,
  msUntilNextEat0805,
  orderChecks,
  orderNeeds,
  orderRulings,
  overdueAt,
  readTwin,
  screenLabel,
  sectionsFor,
  stationPanel,
  stopOfStatus,
  twinBoardToken,
  waitingNow,
  whatChanged,
  readHistory,
} from './twinModel';
import { fillOfflineTemplate, offlineSnapshot, scriptSafeJson, toMarkdown } from './twinReport';
import { withTwin } from '../deskAccess';
import { LIVE, at, lane } from './twinFixture';
import { DESKS } from '../deskConfig';

const live = () => readTwin(LIVE)!;

describe('readTwin', () => {
  it('returns null when there is no run', () => {
    expect(readTwin(null)).toBeNull();
    expect(readTwin({ run_id: 3 })).toBeNull();
  });

  it('reads a live answer and says so in the header', () => {
    const t = live();
    expect(t.runId).toBeNull();
    expect(t.live).toBe(true);
    expect(t.lastOfficial?.runId).toBe('11');
    expect(screenLabel(t, Date.parse('2026-11-16T00:20:00Z'))).toBe('Live, updated 03:20 EAT');
    expect(t.payload.nodes.find((n) => n.id === 'X')!.status).toBe('not_started');
    expect(t.payload.flow[0].dir).toBe('fwd');
    expect(t.raw).toBe(LIVE.payload);
  });

  it('labels a saved run by its number and window', () => {
    const t = readTwin({ ...LIVE, run_id: 11, live: undefined })!;
    expect(screenLabel(t, null)).toBe(`Saved run 11, ${LIVE.payload.window_label}`);
  });
});

describe('lane mapping', () => {
  const p = live().payload;

  it('puts Company first, then the lanes in the bar order, red for gap_failed and amber for failed', () => {
    const tabs = laneTabs(p);
    expect(tabs.map((t) => t.label)).toEqual(['Company', 'Rent pipeline', 'Funders and partners', 'Collections', 'Controls']);
    expect(tabs.find((t) => t.key === 'controls')!.badge).toEqual({ n: 3, tone: 'gap' });
    expect(tabs.find((t) => t.key === 'partner')!.badge).toEqual({ n: 3, tone: 'watch' });
    expect(tabs.find((t) => t.key === 'collections')!.badge).toBeNull();
  });

  it('gives each lane a health state', () => {
    expect(laneState({ failed: 6, gap_failed: 3 })).toBe('gap');
    expect(laneState({ failed: 3, gap_failed: 0 })).toBe('partial');
    expect(laneState({ failed: 0, gap_failed: 0 })).toBe('verified');
  });

  it('keeps links that touch the lane at either end', () => {
    expect(laneLinks(p, 'partner').map((l) => l.id)).toEqual(['2']);
    expect(laneLinks(p, null)).toHaveLength(3); // every link is listed; the map alone skips a dangling one
  });

  it('sends each node to the desk where action is taken', () => {
    expect(deskForNode({ owner: 'Service Centre', lane: 'pipeline' })).toBe('service-centre');
    expect(deskForNode({ owner: 'Partner Ops and CFO', lane: 'partner' })).toBe('partner-ops');
    expect(deskForNode({ owner: 'Agent → desks → COO', lane: 'pipeline' })).toBe('coo');
    expect(deskForNode({ owner: 'System', lane: 'landlord' })).toBe('landlord-ops');
    expect(deskForNode({ owner: 'Engineering', lane: 'controls' })).toBe('ontology');
  });
});

describe('who sees the Twin tab', () => {
  const by = (ids: string[]) => DESKS.filter((d) => ids.includes(d.id));
  const noAccess = null;

  it('sits right after the Ontology tab and reads no desk feed', () => {
    const ids = DESKS.map((d) => d.id);
    expect(ids[ids.indexOf('ontology') + 1]).toBe('twin');
  });

  it('opens for the COO, CEO, CFO, CTO and super admin by role', () => {
    for (const role of ['coo', 'ceo', 'cfo', 'cto', 'super_admin']) {
      expect(withTwin(by(['cfo']), DESKS, noAccess, [role]).some((d) => d.id === 'twin')).toBe(true);
    }
  });

  it('opens for an all-desk holder and for the Command Centre desk, not for others', () => {
    const access = { enforced: true, employee: true, all: false, desks: ['command'], desk: null, sc_person: false, can_manage: false };
    expect(withTwin(by(['command']), DESKS, access, ['manager']).map((d) => d.id)).toEqual(['command', 'twin']);
    expect(withTwin(by(['service-centre']), DESKS, { ...access, all: true, desks: [] }, ['manager']).some((d) => d.id === 'twin')).toBe(true);
    expect(withTwin(by(['service-centre']), DESKS, { ...access, desks: ['service-centre'] }, ['operations']).some((d) => d.id === 'twin')).toBe(false);
    expect(withTwin([], DESKS, noAccess, ['agent']).some((d) => d.id === 'twin')).toBe(false);
  });
});

describe('redaction', () => {
  const redacted = () =>
    readTwin({
      ...LIVE,
      payload: {
        ...LIVE.payload,
        redacted: ['partner'],
        nodes: LIVE.payload.nodes.filter((n) => n.lane !== 'partner'),
        checks: LIVE.payload.checks.filter((c) => c.lane !== 'partner'),
        hourly: Object.fromEntries(Object.entries(LIVE.payload.hourly).filter(([k]) => !k.endsWith('|partner'))),
      },
    })!;

  it('knows which lane the server withheld', () => {
    const p = redacted().payload;
    expect(isRedacted(p, 'partner')).toBe(true);
    expect(isRedacted(p, 'pipeline')).toBe(false);
    expect(isRedacted(live().payload, 'partner')).toBe(false);
  });

  it('still shows the partner lane with its totals', () => {
    const p = redacted().payload;
    const tab = laneTabs(p).find((t) => t.key === 'partner')!;
    expect(tab.label).toBe('Funders and partners');
    expect(p.lanes.find((l) => l.key === 'partner')!.metrics).toHaveLength(1);
    expect(moneyLanes(p.hourly).map((m) => m.key)).toEqual(['withdrawals|money']);
  });

  it('says so in the report instead of failing', () => {
    expect(toMarkdown(redacted(), null)).toContain('Partner detail is limited to the COO, CEO and CFO.');
  });
});

describe('reconstructed days', () => {
  const day = {
    run_id: 6,
    run_at: '2026-11-12T05:00:00Z',
    source: 'reconstructed',
    reconstructed: true,
    payload: {
      window_label: 'Wed 11 Nov 08:00 – Thu 12 Nov 08:00 EAT',
      note: 'Reconstructed on 15 Nov 2026. Queues, statuses and backlog were not recorded that day.',
      hours: LIVE.payload.hours,
      hourly: { 'coo|fwd': at(9, 12), 'roi|partner': at(10, 2) },
      kpis: { moves: 106 },
      checks: [{ key: 'bursts', label: 'Bulk moves', ok: false, severity: 'watch', value: 1, rec: 'Confirm.', lane: 'pipeline' }],
      lanes: [lane('pipeline', 1, 0)],
    },
  };

  it('is marked reconstructed, keeps its note and has no nodes, queues or totals', () => {
    const t = readTwin(day)!;
    expect(t.payload.reconstructed).toBe(true);
    expect(t.payload.note).toMatch(/not recorded/);
    expect(t.payload.nodes).toEqual([]);
    expect(t.payload.queues).toEqual([]);
    expect(t.payload.totals).toEqual({});
    expect(screenLabel(t, null)).toBe('Saved run 6, Wed 11 Nov 08:00 – Thu 12 Nov 08:00 EAT');
  });

  it('shows only the river, money, partner flows and checks, whatever lane was open', () => {
    expect(sectionsFor('company', true)).toEqual(['money', 'partner', 'checks']);
    expect(sectionsFor('partner', true)).toEqual(['money', 'partner', 'checks']);
    expect(sectionsFor('company', false)).toEqual(['ribbon', 'tiles', 'map', 'checks', 'health', 'needs', 'rulings', 'nodes', 'links']);
    expect(sectionsFor('pipeline', false)).toEqual(['lanehead', 'checks', 'map', 'tables', 'nodes', 'links']);
  });

  it('still replays its river and money strip', () => {
    const p = readTwin(day)!.payload;
    expect(buildDots(p.hourly)).toHaveLength(12);
    expect(moneyLanes(p.hourly).map((m) => m.label)).toEqual(['Returns credits raised']);
  });

  it('is never the "previous saved run" for the ribbon', () => {
    const history = readHistory([
      { run_id: 6, run_at: '2026-11-12T05:00:00Z', day: '2026-11-12', source: 'reconstructed', reconstructed: true, totals: null },
      { run_id: 11, run_at: '2026-11-15T17:17:41Z', day: '2026-11-15', source: 'manual', totals: { gap: 38, nodes: 113 }, kpis: { moves: 10 }, money: { funded_ugx: 500000 }, checks_failed: 16 },
    ]);
    const w = whatChanged(live(), history)!;
    expect(w.since.runId).toBe('11');
    expect(w.deltas.map((d) => [d.label, d.delta])).toEqual([
      ['Gap nodes', 2],
      ['Failed checks', 4 - 16],
      ['Stage moves', 8],
      ['UGX funded', -500000],
    ]);
    expect(whatChanged(live(), history.slice(0, 1))).toBeNull();
  });
});

describe('the river and its panels', () => {
  const p = live().payload;

  it('has the nine stations in order', () => {
    expect(STATIONS.map((s) => s.label)).toEqual([
      'Agents submit', 'Service Centre', 'Agent Ops', 'Tenant Ops', 'Landlord Ops', 'COO', 'Funders board', 'Funded, paying landlord', 'Repaying',
    ]);
  });

  it('counts waiting now per station with UGX; Landlord Ops takes both of its statuses', () => {
    expect(waitingNow(p.queues).map((w) => w.n)).toEqual([0, 3803, 21, 0, 5, 3, 18, 0, 977]);
    expect(waitingNow(p.queues)[4].ugx).toBe(300);
  });

  it('makes one dot per stage move and leaves money and partner keys to the strip', () => {
    const dots = buildDots(p.hourly);
    expect(dots).toHaveLength(2 + 5 + 2 + 2 + 3 + 4);
    expect(dots.filter((d) => d.from === 5 && d.to === 'pool')).toHaveLength(2);
    expect(dots.filter((d) => d.from === 'pool' && d.to === 1)).toHaveLength(3);
    expect(dots.filter((d) => d.from === 8 && d.to === 'end')).toHaveLength(4);
  });

  it('opens a desk: waiting, moves out by destination, moves in by source, overdue, checks', () => {
    const sc = stationPanel(p, 1);
    expect(sc.title).toBe('Service Centre');
    expect(sc.waiting).toEqual({ n: 3803, ugx: 791384672 });
    expect(sc.out.map((f) => f.to)).toEqual(['pending', 'rejected']);
    expect(sc.inn.map((f) => f.from)).toEqual(['rejected', 'new', 'partner_ops_approved']);
    expect(sc.overdue).toBe(3797);
    expect(sc.checks.map((c) => c.key)).toEqual(['sc_review_no_staff_id']);
    expect(sc.lane).toBe('pipeline');
    expect(stationPanel(p, 0).waiting).toBeNull();
    expect(stationPanel(p, 7).lane).toBe('landlord');
    expect(stationPanel(p, 3).overdue).toBe(0);
  });

  it('opens the basin: the back moves and what agents brought back', () => {
    const pool = stationPanel(p, 'pool');
    expect(pool.isPool).toBe(true);
    expect(pool.out.map((f) => f.from)).toEqual(['partner_ops_approved', 'service_center_review']);
    expect(pool.inn.map((f) => f.from)).toEqual(['rejected']);
  });

  it('opens an hour', () => {
    expect(hourActivity(p.hourly, 23)).toEqual([{ key: 'service_centre|fwd', label: 'Service Centre passes', n: 5 }]);
    expect(hourActivity(p.hourly, 12)).toEqual([]);
  });

  it('reads overdue counts from the check detail', () => {
    expect(overdueAt(p.checks, 'Funders board')).toBe(18);
    expect(overdueAt(p.checks, null)).toBeNull();
    expect(overdueAt([], 'COO')).toBeNull();
  });

  it('places a live stage event on the river', () => {
    expect(stopOfStatus(null)).toBe(0);
    expect(stopOfStatus('service_center_review')).toBe(1);
    expect(stopOfStatus('landlord_ops_approved')).toBe(4);
    expect(stopOfStatus('coo_approved')).toBe(6);
    expect(stopOfStatus('rejected')).toBe('pool');
    expect(stopOfStatus('completed')).toBe('end');
  });

  it('reads the clock off the window hours', () => {
    expect(clockAt(p.hours, 0)).toBe('03:00');
    expect(clockAt(p.hours, 10.5)).toBe('13:30');
    expect(clockAt(p.hours, 24)).toBe('03:00');
  });
});

describe('ordering and the map', () => {
  const p = live().payload;

  it('puts failed checks first, gap before watch', () => {
    expect(orderChecks(p.checks).map((c) => c.key)).toEqual(['sc_review_no_staff_id', 'b', 'stage_overdue', 'partner_roi_date_past', 'a']);
  });

  it('orders decisions by priority, answer-first at the top', () => {
    expect(orderNeeds(p.needs).map((n) => n.id)).toEqual(['102', '7', '9']);
  });

  it('lays out every node inside the map; actions tether to their object', () => {
    const { placed, edges } = layoutMap(p.nodes, p.links);
    expect(placed).toHaveLength(5);
    for (const n of placed) expect(n.x).toBeGreaterThanOrEqual(12);
    expect(edges.filter((e) => e.tether).map((e) => `${e.a}>${e.b}`)).toEqual(['A4>O1']);
  });
});

describe('reading the gaps', () => {
  const g = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `N${id}`, kind: 'object', family: 'Party', status: 'gap', lane: 'pipeline', ...over });
  const twin = readTwin({
    run_id: 1,
    run_at: '2026-11-16T05:00:00Z',
    payload: {
      nodes: [
        g('O1'),
        g('O2'),
        g('A1', { kind: 'action', on: 'O2' }),
        g('O3', { status: 'verified' }),
        g('O4'),
        g('O5', { lane: 'money' }),
        g('O6'),
      ],
      links: [
        { id: 'L1', from: 'O1', to: 'O2', label: 'asks' },
        { id: 'L2', from: 'O4', to: 'O3', label: 'feeds' },
        { id: 'L3', from: 'O3', to: 'O6', label: 'feeds' },
        { id: 'L4', from: 'O6', to: 'O5', label: 'pays' },
      ],
    },
  })!;

  it('groups gaps that touch through links or an action and what it changes; a non-gap in between does not join them', () => {
    const { chains, alone } = gapChains(twin.payload.nodes, twin.payload.links);
    expect(chains).toHaveLength(2);
    expect(chains[0].gaps.map((n) => n.id).sort()).toEqual(['A1', 'O1', 'O2']);
    expect(chains[0].pairs.map((p) => `${p.a.id} ${p.how} ${p.b.id}`).sort()).toEqual(['A1 changes O2', 'O1 asks O2']);
    expect(chains[1].gaps.map((n) => n.id).sort()).toEqual(['O5', 'O6']);
    expect(alone.map((n) => n.id)).toEqual(['O4']);
  });

  it('counts only the gaps in that lane in a lane view', () => {
    const { chains, alone } = gapChains(twin.payload.nodes, twin.payload.links, 'pipeline');
    expect(chains.map((c) => c.gaps.length)).toEqual([3]);
    expect(alone.map((n) => n.id).sort()).toEqual(['O4', 'O6']);
  });
});

describe('decisions and rulings by node', () => {
  const p = live().payload;

  it('reads rulings and the nodes each decision affects', () => {
    expect(p.rulings.map((r) => r.id)).toEqual(['201', '202', '203']);
    expect(p.rulings[0]).toMatchObject({ question: 'Arrears calls', lane: 'collections', kind: 'rule', nodes: ['O1'], source: 'COO ruling', decidedAt: '2026-11-15T06:07:00Z' });
    expect(p.rulings[2]).toMatchObject({ nodes: [], decidedAt: null });
    expect(p.needs.find((n) => n.id === '7')?.nodes).toEqual(['O7', 'A4']);
    expect(p.needs.find((n) => n.id === '102')?.nodes).toEqual([]);
    expect(readTwin({ run_id: 1, payload: {} })!.payload.rulings).toEqual([]);
  });

  it('puts the newest ruling first and undated last', () => {
    expect(orderRulings(p.rulings).map((r) => r.id)).toEqual(['202', '201', '203']);
  });

  it('matches decisions waiting and rulings to a node by id', () => {
    expect(decisionsForNode(p, 'O7')).toMatchObject({ waiting: [{ id: '7' }], rulings: [{ id: '202' }] });
    expect(decisionsForNode(p, 'O1').rulings.map((r) => r.id)).toEqual(['201']);
    expect(decisionsForNode(p, 'O11')).toEqual({ waiting: [], rulings: [] });
  });

  it('lists the rulings in the report', () => {
    const md = toMarkdown(live(), Date.now());
    expect(md).toContain('## Rulings in force');
    expect(md).toMatch(/- \*\*Service Centre review\*\*: Every review carries a staff ID\. .*Applies to Service Centre manager, NOPE\./);
  });
});

describe('the boardroom code', () => {
  it('reads #t= first, then the older ?t=, only on /desk/twin', () => {
    expect(twinBoardToken('/desk/twin', '?board=1', '#t=abc123def456')).toBe('abc123def456');
    expect(twinBoardToken('/desk/twin', '?t=old-code', '')).toBe('old-code');
    expect(twinBoardToken('/desk/coo', '?t=x', '#t=y')).toBe('');
    expect(twinBoardToken('/desk/twin', '', '')).toBe('');
  });

  it('takes the code out of the address and keeps Board mode', () => {
    expect(addressWithoutToken('/desk/twin', '?t=abc&lane=partner', '#t=abc')).toBe('/desk/twin?lane=partner&board=1');
  });

  it('reloads at 08:05 EAT', () => {
    expect(msUntilNextEat0805(Date.parse('2026-11-16T05:00:00Z'))).toBe(5 * 60_000); // 08:00 EAT
    expect(msUntilNextEat0805(Date.parse('2026-11-16T05:06:00Z'))).toBe(24 * 3_600_000 - 60_000);
  });
});

describe('keep and share', () => {
  it('builds a Markdown report from what is on screen', () => {
    const md = toMarkdown(live(), Date.parse('2026-11-16T00:20:00Z'));
    expect(md).toContain('Live, updated 03:20 EAT');
    expect(md).toContain('**Gap: Reviews without a staff ID** = 10');
    expect(md.indexOf('102. UGX 50.00M')).toBeLessThan(md.indexOf('7. Later question'));
    expect(md).not.toMatch(/\bROI\b/);
  });

  it('fills the offline template safely', () => {
    const template = '<html><script type="application/json" id="snapshot">null</script><script>boot()</script></html>';
    const t = readTwin({ ...LIVE, payload: { ...LIVE.payload, window_label: '</script><img src=x onerror=alert(1)>' } })!;
    const html = fillOfflineTemplate(template, offlineSnapshot(t, [], null));
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).not.toContain('<img');
    const json = html.match(/id="snapshot">([\s\S]*?)<\/script>/)![1];
    expect(JSON.parse(json).payload.window_label).toBe('</script><img src=x onerror=alert(1)>');
    expect(() => fillOfflineTemplate('<html></html>', offlineSnapshot(t, [], null))).toThrow();
    expect(scriptSafeJson(`a${String.fromCharCode(0x2028)}b`)).toBe('"a\\u2028b"');
  });
});

describe('copy', () => {
  it('says returns, never ROI', () => {
    expect(copy('ROI credits raised')).toBe('Returns credits raised');
    expect(copy('Partner money in, pledges, ROI and settlements.')).toBe('Partner money in, pledges, returns and settlements.');
    expect(copy('No change here')).toBe('No change here');
  });

  it('applies it to every name and label the database sends, and to the offline copy', () => {
    const t = readTwin({
      ...LIVE,
      payload: {
        ...LIVE.payload,
        nodes: [{ id: 'O45', name: 'ROI credit', kind: 'object', family: 'Money', status: 'gap', lane: 'partner', owner: 'CFO' }],
        links: [{ id: 9, from: 'O45', to: 'O45', label: 'ROI credit posts to' }],
      },
    })!;
    expect(t.payload.nodes[0].name).toBe('Returns credit');
    expect(t.payload.links[0].label).toBe('Returns credit posts to');
    expect(t.payload.lanes[0].metrics[0].label).toBe('Returns credits raised');
    expect(JSON.stringify(offlineSnapshot(t, [], null))).not.toMatch(/\bROI\b/);
  });
});
