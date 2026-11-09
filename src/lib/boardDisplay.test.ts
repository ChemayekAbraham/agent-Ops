import { describe, expect, it } from 'vitest';
import {
  BOARD_IDLE_MS, BOARD_PANEL_IDLE_MS, BOARD_PERIOD_KEY, BOARD_POLL_MS, BOARD_PULSE_MS, BOARD_RETRY_MS, boardDays, boardDisplayToken, boardIsStale,
  boardUpdatedText, isBoardDisplayPath, isBoardLinkError, kampalaDate, readBoardFeed, readBoardList, readBoardPeriod, storeBoardPeriod,
} from './boardDisplay';
const feed = () => ({ generated_at: '2026-11-09T08:00:00Z', display: { label: 'Boardroom 1' }, headline: Object.fromEntries(['today','7d','30d','90d','all'].map(p => [p, { posted: { n: 0, ugx: 0 }, sold: { n: 1, ugx: 10000 }, waiting: { n: 2, ugx: 20000 } }])) });
const memory = (seed: Record<string, string> = {}) => {
  const m = new Map(Object.entries(seed));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
};
describe('Board display rules', () => {
  it('accepts path and query secret links without matching other routes', () => {
    expect(boardDisplayToken('/board/secret', '')).toBe('secret');
    expect(boardDisplayToken('/board', '?t=other')).toBe('other');
    expect(isBoardDisplayPath('/board/secret')).toBe(true);
    expect(isBoardDisplayPath('/boardroom')).toBe(false);
  });
  it('answers on /b/:code too, and nowhere else that starts with b', () => {
    expect(isBoardDisplayPath('/b/t9rywfp4fza4')).toBe(true);
    expect(boardDisplayToken('/b/t9rywfp4fza4', '')).toBe('t9rywfp4fza4');
    expect(boardDisplayToken('/b/t9rywfp4fza4/', '')).toBe('t9rywfp4fza4');
    for (const path of ['/blog', '/b2b', '/b/x/y', '/desk/cfo', '/']) expect(isBoardDisplayPath(path)).toBe(false);
  });
  it('a refused link (SQLSTATE 28000) is a link error; anything else is not', () => {
    expect(isBoardLinkError({ code: '28000', message: 'This display link has been switched off' })).toBe(true);
    expect(isBoardLinkError(new Error('Failed to fetch'))).toBe(false);
    expect(isBoardLinkError(null)).toBe(false);
  });
  it('the LIVE line reads in Kampala time', () => {
    expect(boardUpdatedText('2026-11-09T08:05:09Z')).toBe('LIVE · updated 11:05:09 Kampala');
  });
  it('polls every 30 seconds and retries errors every 60 seconds', () => {
    expect(BOARD_POLL_MS).toBe(30000); expect(BOARD_RETRY_MS).toBe(60000);
  });
  it('becomes stale only after two minutes since last good update', () => {
    expect(boardIsStale(1000, 121000)).toBe(false);
    expect(boardIsStale(1000, 121001)).toBe(true);
  });
  it('hides the cursor at three seconds and highlights changes for 0.8 seconds', () => {
    expect(BOARD_IDLE_MS).toBe(3000); expect(BOARD_PULSE_MS).toBe(800);
  });
  it('keeps zero totals and strips private extra fields', () => {
    const result = readBoardFeed({ ...feed(), names: ['private'], phone: 'private', request_ids: ['private'] });
    expect(result.headline.today.posted).toEqual({ n: 0, ugx: 0 });
    expect(result).not.toHaveProperty('names'); expect(result).not.toHaveProperty('phone'); expect(result).not.toHaveProperty('request_ids');
  });
  it('no longer needs or keeps the pipeline stages', () => {
    expect(() => readBoardFeed(feed())).not.toThrow();
    expect(readBoardFeed({ ...feed(), stages: [{ ord: 1, stage: 'x' }] })).not.toHaveProperty('stages');
  });
  it('rejects incomplete totals rather than inventing zero', () => {
    expect(() => readBoardFeed({ ...feed(), headline: {} })).toThrow('totals are unavailable');
  });
});

describe('Board period choice', () => {
  it('defaults to Today and remembers a valid choice', () => {
    expect(readBoardPeriod(memory())).toBe('today');
    expect(readBoardPeriod(memory({ [BOARD_PERIOD_KEY]: 'bogus' }))).toBe('today');
    const s = memory();
    storeBoardPeriod(s, '30d');
    expect(s.m.get(BOARD_PERIOD_KEY)).toBe('30d');
    expect(readBoardPeriod(s)).toBe('30d');
  });
  it('survives blocked storage', () => {
    const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readBoardPeriod(blocked)).toBe('today');
    expect(() => storeBoardPeriod(blocked, '7d')).not.toThrow();
    expect(readBoardPeriod(null)).toBe('today');
  });
});

describe('Board list (board_display_list)', () => {
  it('whitelists ref, area, rent, dates and status: no names, phones or ids', () => {
    const l = readBoardList({ count: 412, ugx: 9_000_000, shown: 300, rows: [{
      ref: 'a1b2c3d4e5', area: 'Kireka, Wakiso', rent: '300000', posted_at: '2026-11-08T08:00:00Z', days_since_posted: 1.5, status_label: 'Repaying',
      money_released_at: '2026-11-09T07:00:00Z', tenant: 'Private Name', tenant_phone: '0700', landlord_phone: '0701', id: 'uuid', partner: 'Private',
    }] }, '7d', 'sold');
    expect(l).toMatchObject({ period: '7d', kind: 'sold', count: 412, ugx: 9_000_000, shown: 300 });
    expect(l.rows[0]).toEqual({ ref: 'a1b2c3d4', area: 'Kireka, Wakiso', rent: 300000, posted_at: '2026-11-08T08:00:00Z', days_since_posted: 1.5, status_label: 'Repaying', money_released_at: '2026-11-09T07:00:00Z' });
    expect(JSON.stringify(l)).not.toMatch(/Private|0700|0701|uuid/);
  });
  it('an empty or missing list is zero, not an error', () => {
    expect(readBoardList(null, 'today', 'posted')).toEqual({ period: 'today', kind: 'posted', count: 0, ugx: 0, shown: 0, rows: [] });
  });
  it('dates and days read in Kampala terms', () => {
    expect(kampalaDate('2026-11-08T22:30:00Z')).toBe('9 Nov 2026');
    expect(kampalaDate(null)).toBe('—');
    expect(boardDays(1)).toBe('1 day');
    expect(boardDays(3.46)).toBe('3.5 days');
    expect(boardDays(null)).toBe('—');
  });
  it('the panel closes itself after a minute', () => {
    expect(BOARD_PANEL_IDLE_MS).toBe(60000);
  });
});
