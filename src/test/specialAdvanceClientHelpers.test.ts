// @vitest-environment node
/**
 * Special Advances client helpers for the CFO screens (Gemini hand-off, docs/special-advances/gemini-ui-handoff.md):
 * isMissingServerFunction (a phase not applied yet) and getSpecialAdvanceProofUrl (short-lived link to a proof file).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), createSignedUrl: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { storage: { from: mocks.from } } }));
import { getSpecialAdvanceProofUrl } from '@/hooks/useSpecialAdvances';
import { isMissingServerFunction, SPECIAL_ADVANCE_PROOF_BUCKET, SPECIAL_ADVANCE_PROOF_LINK_SECONDS } from '@/lib/specialAdvances';

const PATH = 'advances/0b6f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e/9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b.pdf';

describe('isMissingServerFunction', () => {
  it('recognises a function that is not in this database yet (PostgREST or Postgres)', () => {
    expect(isMissingServerFunction({ code: 'PGRST202', message: 'Could not find the function public.special_advance_record_correction' })).toBe(true);
    expect(isMissingServerFunction({ code: '42883', message: 'function does not exist' })).toBe(true);
    expect(isMissingServerFunction({ message: 'Could not find the function public.x(p_id) in the schema cache' })).toBe(true);
  });

  it('does not mistake a real refusal or an empty value for a missing function', () => {
    expect(isMissingServerFunction({ code: '42501', message: 'NOT_AUTHORIZED' })).toBe(false);
    expect(isMissingServerFunction({ code: '22023', message: 'PROOF_REQUIRED' })).toBe(false);
    expect(isMissingServerFunction(null)).toBe(false);
    expect(isMissingServerFunction(undefined)).toBe(false);
  });
});

describe('getSpecialAdvanceProofUrl', () => {
  beforeEach(() => {
    mocks.from.mockReset().mockReturnValue({ createSignedUrl: mocks.createSignedUrl });
    mocks.createSignedUrl.mockReset();
  });

  it('asks the private proofs bucket for a 60-second link to exactly that file', async () => {
    mocks.createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://example.test/signed' }, error: null });
    await expect(getSpecialAdvanceProofUrl(PATH)).resolves.toBe('https://example.test/signed');
    expect(mocks.from).toHaveBeenCalledWith(SPECIAL_ADVANCE_PROOF_BUCKET);
    expect(mocks.createSignedUrl).toHaveBeenCalledWith(PATH, SPECIAL_ADVANCE_PROOF_LINK_SECONDS);
    expect(SPECIAL_ADVANCE_PROOF_LINK_SECONDS).toBe(60);
  });

  it('never sends a malformed path (another folder, another file type, path tricks)', async () => {
    for (const bad of ['', '../secret.pdf', 'advances/x/y.pdf', `${PATH}.exe`, PATH.replace('.pdf', '.html'), `other/${PATH}`]) {
      await expect(getSpecialAdvanceProofUrl(bad), bad).rejects.toThrow(/not valid/);
    }
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it('passes on a refusal from storage (policy not applied yet, or no authenticator-verified session)', async () => {
    mocks.createSignedUrl.mockResolvedValue({ data: null, error: { message: 'new row violates row-level security policy' } });
    await expect(getSpecialAdvanceProofUrl(PATH)).rejects.toThrow(/row-level security/);
    mocks.createSignedUrl.mockResolvedValue({ data: { signedUrl: '' }, error: null });
    await expect(getSpecialAdvanceProofUrl(PATH)).rejects.toThrow(/could not be opened/);
  });
});
