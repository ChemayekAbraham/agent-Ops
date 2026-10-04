import { describe, it, expect } from 'vitest';
import {
  isAutoCancelledDuplicate,
  DUPLICATE_REASON_PREFIX,
} from '../depositDuplicateDetection';

describe('isAutoCancelledDuplicate (retro-cancellation of pending deposits)', () => {
  it('flags a rejected row whose reason starts with the duplicate prefix', () => {
    expect(
      isAutoCancelledDuplicate({
        status: 'rejected',
        rejection_reason: `${DUPLICATE_REASON_PREFIX} (TID 40781351736)`,
      }),
    ).toBe(true);
  });

  it('flags retro-cancelled rows even with extra trailing detail', () => {
    expect(
      isAutoCancelledDuplicate({
        status: 'rejected',
        rejection_reason: `${DUPLICATE_REASON_PREFIX} — already approved on 2026-05-18`,
      }),
    ).toBe(true);
  });

  it('does NOT flag a genuinely rejected deposit (different reason)', () => {
    expect(
      isAutoCancelledDuplicate({
        status: 'rejected',
        rejection_reason: 'TID does not match any receipt',
      }),
    ).toBe(false);
  });

  it('does NOT flag a still-pending deposit awaiting auto-match', () => {
    expect(
      isAutoCancelledDuplicate({
        status: 'pending',
        rejection_reason: null,
      }),
    ).toBe(false);
  });

  it('does NOT flag an approved deposit', () => {
    expect(
      isAutoCancelledDuplicate({
        status: 'approved',
        rejection_reason: null,
      }),
    ).toBe(false);
  });

  it('does NOT flag rejected rows with empty/null reason', () => {
    expect(
      isAutoCancelledDuplicate({ status: 'rejected', rejection_reason: null }),
    ).toBe(false);
    expect(
      isAutoCancelledDuplicate({ status: 'rejected', rejection_reason: '' }),
    ).toBe(false);
  });

  it('is case-sensitive on the prefix (guards against accidental drift)', () => {
    expect(
      isAutoCancelledDuplicate({
        status: 'rejected',
        rejection_reason: DUPLICATE_REASON_PREFIX.toLowerCase(),
      }),
    ).toBe(false);
  });
});