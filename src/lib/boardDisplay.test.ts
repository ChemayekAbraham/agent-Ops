import { describe, expect, it } from 'vitest';
import { BOARD_IDLE_MS, BOARD_POLL_MS, BOARD_PULSE_MS, BOARD_RETRY_MS, boardDisplayToken, boardIsStale, boardStageDoneOnly, boardUpdatedText, isBoardDisplayPath, isBoardLinkError, readBoardFeed } from './boardDisplay';
const feed = () => ({ generated_at: '2026-11-09T08:00:00Z', display: { label: 'Boardroom 1' }, headline: Object.fromEntries(['today','7d','30d','90d','all'].map(p => [p, { posted: { n: 0, ugx: 0 }, sold: { n: 1, ugx: 10000 }, waiting: { n: 2, ugx: 20000 } }])), stages: [] });
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
  it('Submitted shows only what came in over 24 hours', () => {
    expect(boardStageDoneOnly({ ord: 0, stage: 'Submitted', waiting: 4 })).toBe(true);
    expect(boardStageDoneOnly({ ord: 2, stage: 'Agent Ops', waiting: 9 })).toBe(false);
    expect(boardStageDoneOnly({ ord: 8, stage: 'Landlord paid', waiting: null })).toBe(true);
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
  it('rejects incomplete totals rather than inventing zero', () => {
    expect(() => readBoardFeed({ ...feed(), headline: {} })).toThrow('totals are unavailable');
  });
});