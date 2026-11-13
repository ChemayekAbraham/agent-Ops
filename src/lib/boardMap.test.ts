import { describe, expect, it } from 'vitest';
import {
  countText,
  desksSub,
  hoursText,
  hoursTone,
  layerCount,
  motionLine,
  pipelineLead,
  readAlerts,
  readBoardMap,
  readMoneyInMotion,
  readStages,
  stageTiles,
  ugxShort,
} from './boardMap';
import { readBoardFeed } from './boardDisplay';

import { MAP, STAGES } from './boardMap.fixtures';


const read = () => readBoardMap(MAP, STAGES)!;

describe('readBoardMap (E96 whitelist)', () => {
  it('keeps the KPIs, readiness and coverage', () => {
    const m = read();
    expect(m.readiness).toBe('red');
    expect(m.kpis.soldToday).toEqual({ n: 8, ugx: 4450000 });
    expect(m.kpis.selected).toEqual({ n: 5, ugx: 1430000, oldestHours: 184.4 });
    expect(m.kpis.inDesks).toBe(3814);
    expect(m.coverage).toEqual({ desksGps: 3811, desksExcludedLegacy: 3012, repayingGps: 727, repayingTotal: 983, agentsWithBase: 96 });
    expect(m.names).toBe(true);
  });
  it('drops points without a real position, cells with no requests, and every field it does not know (a phone number)', () => {
    const m = read();
    expect(m.layers.selected).toHaveLength(2);
    expect(m.layers.desks).toHaveLength(1);
    expect(JSON.stringify(m)).not.toContain('0700111222');
    expect(m.layers.selected[0]).toMatchObject({ tenant: 'Nakiyinji Zaitun', agentLat: 0.31, agentLng: 32.58 });
    expect(m.layers.selected[1]).toMatchObject({ tenant: null, agent: null, funder: null, landlord: null, agentLat: null });
    expect(m.layers.agents[1]).toEqual({ lat: 0.5, lng: 32.9, frozen: true, name: 'Paul Okello' });
  });
  it('a figure the server did not send is null, never 0; a feed with no map is no map', () => {
    const m = readBoardMap({ kpis: { sold_today: {} } }, [])!;
    expect(m.kpis.soldToday).toEqual({ n: null, ugx: null });
    expect(m.kpis.inDesks).toBeNull();
    expect(m.readiness).toBeNull();
    expect(countText(m.kpis.inDesks)).toBe('—');
    expect(ugxShort(m.kpis.soldToday.ugx)).toBe('—');
    expect(readBoardMap(null, STAGES)).toBeNull();
  });
  it('alerts by severity then rank; unknown severities dropped', () => {
    expect(readAlerts(MAP.alerts).map((a) => [a.severity, a.kind])).toEqual([
      ['critical', 'MONEY'], ['high', 'BOTTLENECK'], ['high', 'LANDLORD NOT PAID'], ['medium', 'FIELD FORCE'],
    ]);
  });
  it('money in motion oldest first', () => {
    expect(readMoneyInMotion(MAP.money_in_motion).map((m) => m.hours)).toEqual([80, 36, 6]);
  });
});

describe('what the screen shows', () => {
  it('hours: red past 72 h, amber past 24 h; "5 h" under a day, "1.5 d" from a day', () => {
    expect([hoursTone(80), hoursTone(36), hoursTone(6), hoursTone(null)]).toEqual(['red', 'amber', 'none', 'none']);
    expect([hoursText(5.4), hoursText(36), hoursText(184.4), hoursText(null)]).toEqual(['5 h', '1.5 d', '7.7 d', '—']);
  });
  it('money in motion names only what came', () => {
    expect(motionLine({ funder: 'Byaruhanga Muhanguzi', agent: 'Moses Magezi', landlord: null })).toBe('B. Muhanguzi → M. Magezi → landlord not paid');
    expect(motionLine({ funder: null, agent: null, landlord: null })).toBe('landlord not paid');
  });
  it('the strip: stages in order, the slowest desk past 3 days red with ▲, empty desks green, then SOLD TODAY', () => {
    const t = stageTiles(readStages(STAGES), { n: 8, ugx: 4450000 });
    expect(t.map((x) => x.label)).toEqual(['SUBMITTED', 'SERVICE CENTRE', 'AGENT OPS', 'TENANT OPS', 'LANDLORD OPS', 'COO APPROVAL', 'FUNDERS BOARD', 'SELECTED, WAITING', 'SOLD TODAY']);
    expect(t[0]).toMatchObject({ value: '7', sub: 'today' });
    expect(t[1]).toMatchObject({ value: '221', sub: '32.2 d to clear', tone: 'red', bottleneck: true });
    expect(t[2]).toMatchObject({ value: '0', sub: '40 cleared today', tone: 'clear' });
    expect(t[5]).toMatchObject({ value: '14', sub: '0.8 d to clear', tone: 'none' });
    expect(t[6]).toMatchObject({ value: '34', sub: 'UGX 19.35M', tone: 'board', bottleneck: false });
    expect(t[7]).toMatchObject({ value: '5', tone: 'selected' });
    expect(t[8]).toMatchObject({ value: '8', sub: 'UGX 4.45M', tone: 'sold' });
    expect(t.filter((x) => x.bottleneck)).toHaveLength(1);
  });
  it('screen 2 uses the same tiles without SOLD TODAY, with each stage\'s waiting UGX and rate', () => {
    const t = stageTiles(readStages(STAGES), null);
    expect(t).toHaveLength(8);
    expect(t[1].detail).toBe('UGX 42.22M waiting · 6.9 / day');
    expect(t[2].detail).toBe('16.3 / day');
    expect(t[6].detail).toBe('2.6 / day');
  });
  it('screen 2 lead, in the desks\' words', () => {
    expect(pipelineLead(readStages(STAGES))).toBe('6.9 new requests a day come in; the slowest stage, Service Centre, clears 6.9 a day.');
    expect(pipelineLead(readStages(STAGES.map((s) => ({ ...s, waiting: s.waiting === null ? null : 0 }))))).toBe('6.9 new requests a day come in. Nothing is waiting at any desk.');
    expect(pipelineLead([])).toBeNull();
  });
  it('layer counts: the KPI where there is one, else what the layer holds', () => {
    const m = read();
    expect(layerCount(m, 'desks')).toBe(3814);
    expect(layerCount(m, 'arrearsToday')).toBe(213);
    expect(layerCount(m, 'agents')).toBe(2);
    expect(layerCount(m, 'emptyHouses')).toBe(200);
    expect(desksSub(m.stages)).toBe('SC 221 · COO 14');
  });
});

describe('readBoardFeed: which screen', () => {
  const headline = Object.fromEntries(['today', '7d', '30d', '90d', 'all'].map((p) => [p, { posted: { n: 1, ugx: 1 }, sold: { n: 0, ugx: 0 }, selected: { n: 0, ugx: 0 }, waiting: { n: 1, ugx: 1 } }]));
  const base = { generated_at: '2026-11-13T08:00:00Z', headline, stages: STAGES };
  it('a funders link (or none named) has no map and no stages', () => {
    const f = readBoardFeed({ ...base, display: { label: 'Boardroom screen 1', screen: 'funders' } });
    expect(f.display.screen).toBe('funders');
    expect(f.map).toBeNull();
    expect(f).not.toHaveProperty('stages');
    expect(readBoardFeed({ ...base, display: { label: 'x' } }).display.screen).toBe('funders');
  });
  it('a map link carries the map, its stages from feed.stages', () => {
    const f = readBoardFeed({ ...base, display: { label: 'Boardroom screen 3', screen: 'map' }, map: MAP });
    expect(f.display.screen).toBe('map');
    expect(f.map?.stages).toHaveLength(8);
  });
  it('a pipeline link carries the stages', () => {
    const f = readBoardFeed({ ...base, display: { label: 'Boardroom screen 2', screen: 'pipeline' } });
    expect(f.stages).toHaveLength(8);
    expect(f.map).toBeNull();
  });
});
