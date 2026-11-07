import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));

import {
  attachLc1Letter,
  familySizeProblem,
  fetchRequestsMissingDetails,
  isFullName,
  lc1LetterProblem,
  normalizeMissingRows,
  noteLc1Missing,
  saveIntakeDetails,
  workProblem,
} from '@/lib/agentIntakeDetails';

beforeEach(() => vi.clearAllMocks());

describe('intake rules that block Submit', () => {
  it('family size must be a whole number from 1 to 30', () => {
    expect(familySizeProblem('')).not.toBeNull();
    expect(familySizeProblem('0')).not.toBeNull();
    expect(familySizeProblem('31')).not.toBeNull();
    expect(familySizeProblem('2.5')).not.toBeNull();
    expect(familySizeProblem('1')).toBeNull();
    expect(familySizeProblem('30')).toBeNull();
  });

  it('work needs 3+ characters', () => {
    expect(workProblem('')).not.toBeNull();
    expect(workProblem('  ab ')).not.toBeNull();
    expect(workProblem('Tailor')).toBeNull();
  });

  it('LC1 letter: a photo, or "No LC1 letter yet" with a 10+ character reason', () => {
    expect(lc1LetterProblem({ hasLetter: false, noLetterYet: false, reason: '' })).not.toBeNull();
    expect(lc1LetterProblem({ hasLetter: false, noLetterYet: false, reason: 'A long enough reason' })).not.toBeNull();
    expect(lc1LetterProblem({ hasLetter: false, noLetterYet: true, reason: 'too short' })).not.toBeNull();
    expect(lc1LetterProblem({ hasLetter: false, noLetterYet: true, reason: 'LC1 is away' })).toBeNull();
    expect(lc1LetterProblem({ hasLetter: true, noLetterYet: false, reason: '' })).toBeNull();
  });

  it('a full name has at least two names', () => {
    expect(isFullName('Mukasa')).toBe(false);
    expect(isFullName('  ')).toBe(false);
    expect(isFullName('John Mukasa')).toBe(true);
  });
});

describe('intake RPCs', () => {
  it('saveIntakeDetails calls agent_save_intake_details with the request id and details', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    const res = await saveIntakeDetails('req-1', { familySize: 4, workBusiness: ' Tailor ', workLocation: 'Owino' });
    expect(res).toEqual({ ok: true, message: null });
    expect(mocks.rpc).toHaveBeenCalledWith('agent_save_intake_details', {
      p_request_id: 'req-1', p_family_size: 4, p_work_business: 'Tailor', p_work_location: 'Owino',
    });
  });

  it('saveIntakeDetails sends a blank work location as null and returns the server error as-is', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'NOT_YOUR_REQUEST: request req-1 belongs to another agent' } });
    const res = await saveIntakeDetails('req-1', { familySize: 2, workBusiness: 'Boda rider', workLocation: '  ' });
    expect(mocks.rpc).toHaveBeenCalledWith('agent_save_intake_details', expect.objectContaining({ p_work_location: null }));
    expect(res).toEqual({ ok: false, message: 'NOT_YOUR_REQUEST: request req-1 belongs to another agent' });
  });

  it('attachLc1Letter calls agent_attach_lc1_letter with the request id and storage path', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await attachLc1Letter('req-1', 'agent-1/req-1/lc_letter.jpg');
    expect(mocks.rpc).toHaveBeenCalledWith('agent_attach_lc1_letter', { p_request_id: 'req-1', p_path: 'agent-1/req-1/lc_letter.jpg' });
  });

  it('noteLc1Missing calls agent_note_lc1_missing with the request id and trimmed reason', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, intake_id: 7 }, error: null });
    const res = await noteLc1Missing('req-1', '  LC1 is away until Friday ');
    expect(res).toEqual({ ok: true, message: null });
    expect(mocks.rpc).toHaveBeenCalledWith('agent_note_lc1_missing', { p_request_id: 'req-1', p_reason: 'LC1 is away until Friday' });
  });

  it('fetchRequestsMissingDetails keeps only known missing items and drops complete rows', async () => {
    mocks.rpc.mockResolvedValue({
      data: { rows: [
        { id: 'a', req: 'RR-1', tenant: 'Jane Doe', status: 'pending', submitted_at: '2026-11-01', rent: '300000', missing: ['family_size', 'bogus'] },
        { id: 'b', missing: [] },
        { id: 'c', missing: ['bogus'] },
        { nope: true },
      ] },
      error: null,
    });
    const rows = await fetchRequestsMissingDetails();
    expect(mocks.rpc).toHaveBeenCalledWith('agent_requests_missing_details', undefined);
    expect(rows).toEqual([{ id: 'a', req: 'RR-1', tenant: 'Jane Doe', status: 'pending', submitted_at: '2026-11-01', rent: 300000, missing: ['family_size'] }]);
  });

  it('normalizeMissingRows tolerates an empty or odd payload', () => {
    expect(normalizeMissingRows(null)).toEqual([]);
    expect(normalizeMissingRows({})).toEqual([]);
    expect(normalizeMissingRows({ rows: 'x' })).toEqual([]);
  });
});
