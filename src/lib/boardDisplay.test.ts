import { describe, expect, it } from 'vitest';
import { BOARD_IDLE_MS, BOARD_POLL_MS, BOARD_PULSE_MS, BOARD_RETRY_MS, boardDisplayToken, boardIsStale, isBoardDisplayPath, readBoardFeed } from './boardDisplay';
const feed = () => ({ generated_at: '2026-11-09T08:00:00Z', display: { label: 'Boardroom 1' }, headline: Object.fromEntries(['today','7d','30d','90d','all'].map(p => [p, { posted: { n: 0, ugx: 0 }, sold: { n: 1, ugx: 10000 }, waiting: { n: 2, ugx: 20000 } }])), stages: [] });
describe('Board display rules', () => {
  it('accepts path and query secret links without matching other routes', () => {
    expect(boardDisplayToken('/board/secret', '')).toBe('secret');
    expect(boardDisplayToken('/board', '?t=other')).toBe('other');
    expect(isBoardDisplayPath('/board/secret')).toBe(true);
    expect(isBoardDisplayPath('/boardroom')).toBe(false);
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
  it('rejects incomplete totals rather than inventing zero', () => {
    expect(() => readBoardFeed({ ...feed(), headline: {} })).toThrow('totals are unavailable');
  });
});