import { describe, expect, it } from 'vitest';
import { normaliseFloatTid, parseFloatCreditMessage } from './floatCreditMessage';

// Shapes copied from real gmail_transactions rows (names/numbers altered).
const AIRTEL = 'RECEIVED. TID157623817657 UGX 4,000,000 from 759209694 referenceAPCUG217953071866432. BalUGX 16,020,923.';
const MTN_PAREN = 'You have received UGX 2,500,000 from (ALLAN MABONGO) 256766749975. Your new MoMoPay balance: 30267625.53. Transaction ID: 43855674774.';
const MTN_AT = 'You have received UGX 45000 from SHAKIRAH NAKIMBUGWE at 2026-09-29 12:11:39. Fee: 225. Message: Till:090777. New balance is: UGX 30783626. Transaction ID: 43852271098.';
const MTN_SENT = 'You have sent UGX 300,000 to JOHN DOE 256700000000 at 2026-09-29 09:00:00. Fee: 1,000. Transaction ID: 43800000001.';

describe('parseFloatCreditMessage', () => {
  it('Airtel: digits-only TID, amount (not balance), no time', () => {
    const r = parseFloatCreditMessage(AIRTEL);
    expect(r.tid).toBe('157623817657');
    expect(r.amount).toBe(4_000_000);
    expect(r.timeMissing).toBe(true);
    expect(r.depositedAtLocal).toBeUndefined();
    expect(r.nameParts).toBeUndefined();
    expect(r.senderPhone).toBe('759209694');
    expect(r.direction).toBe('in');
  });

  it('MTN with (NAME): TID, amount, name, no time', () => {
    const r = parseFloatCreditMessage(MTN_PAREN);
    expect(r.tid).toBe('43855674774');
    expect(r.amount).toBe(2_500_000);
    expect(r.nameParts).toEqual({ firstName: 'Allan', otherNames: '', lastName: 'Mabongo' });
    expect(r.senderPhone).toBe('256766749975');
    expect(r.timeMissing).toBe(true);
  });

  it('MTN with "at <date time>": date/time filled, fee not taken as amount', () => {
    const r = parseFloatCreditMessage(MTN_AT);
    expect(r.tid).toBe('43852271098');
    expect(r.amount).toBe(45_000);
    expect(r.depositedAtLocal).toBe('2026-09-29T12:11');
    expect(r.timeMissing).toBe(false);
    expect(r.nameParts).toEqual({ firstName: 'Shakirah', otherNames: '', lastName: 'Nakimbugwe' });
  });

  it('flags a money-SENT message', () => {
    expect(parseFloatCreditMessage(MTN_SENT).direction).toBe('out');
  });

  it('empty input', () => {
    expect(parseFloatCreditMessage('')).toEqual({ timeMissing: true });
  });
});

describe('normaliseFloatTid', () => {
  it('strips the Airtel TID prefix, spaces and stray punctuation', () => {
    expect(normaliseFloatTid('TID157623817657')).toBe('157623817657');
    expect(normaliseFloatTid('tid 1576 2381 7657')).toBe('157623817657');
    expect(normaliseFloatTid('157144620810.')).toBe('157144620810');
    expect(normaliseFloatTid('EQbd8f88d6')).toBe('EQbd8f88d6');
  });
});
