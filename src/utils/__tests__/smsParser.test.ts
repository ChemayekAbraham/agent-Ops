import { describe, it, expect } from 'vitest';
import { parseSMS, parsePayoutConfirmationSms } from '../smsParser';

describe('parseSMS', () => {
  it('parses Airtel-style SMS with space-separated TID and month-name date', () => {
    const sms =
      'PAID.TID 146525101664. UGX 300,000 to WELILE TECHNOLOGIES LIMITED Charge UGX 0. Bal UGX 323,546. 04-May-2026 16:20';
    const r = parseSMS(sms);
    expect(r.amount).toBe(300000);
    expect(r.transactionId).toBe('TID146525101664');
    expect(r.date).toBe('2026-05-04');
    expect(r.time).toBe('16:20');
  });

  it('parses MTN MP… style TID', () => {
    const sms =
      "Y'ello, you have received UGX 50,000 from JOHN. TID MP260504A12345. New balance UGX 150,000. 04/05/2026 16:20";
    const r = parseSMS(sms);
    expect(r.amount).toBe(50000);
    expect(r.transactionId?.startsWith('MP')).toBe(true);
    expect(r.date).toBe('2026-05-04');
    expect(r.time).toBe('16:20');
  });

  it('skips Bal/Charge tokens when picking the amount', () => {
    const sms =
      'Bal UGX 999,000. Charge UGX 0. PAID UGX 25,000 TID 12345678. 04-May-2026 09:05';
    const r = parseSMS(sms);
    expect(r.amount).toBe(25000);
    expect(r.transactionId).toBe('TID12345678');
  });

  it('leaves time undefined when SMS has no time token', () => {
    const sms = 'PAID UGX 10,000 TID 99887766. 01-Jan-2026';
    const r = parseSMS(sms);
    expect(r.amount).toBe(10000);
    expect(r.date).toBe('2026-01-01');
    expect(r.time).toBeUndefined();
  });

  it('parses MTN "sent" SMS with ISO date+time and "ID :" TID', () => {
    const sms =
      'You have sent UGX 150000 to LYDIA NAMUGENYI, 256767652611 on 2026-05-05 15:08:28, fee: 1000. Reason: Rent Paid. New balance: 4736158. ID :40479927536. Download MoMo App http://bit.ly/3KGlEJJ to get 500MBs.';
    const r = parseSMS(sms);
    expect(r.amount).toBe(150000);
    expect(r.transactionId).toBe('40479927536');
    expect(r.date).toBe('2026-05-05');
    expect(r.time).toBe('15:08');
  });

  it('parses MTN "Financial Transaction Id" label', () => {
    const sms =
      'Financial Transaction Id: 40479927536. You have sent UGX 150,000 to LYDIA (256767652611). Fee UGX 1,000. Bal UGX 4,736,158.';
    const r = parseSMS(sms);
    expect(r.amount).toBe(150000);
    expect(r.transactionId).toBe('40479927536');
  });

  it('handles trailing "/=" currency form', () => {
    const r = parseSMS('You have sent 50,000/= to JOHN. Ref 12345678. New balance 4,736,158/=');
    expect(r.amount).toBe(50000);
    expect(r.transactionId).toBe('12345678');
  });

  it('handles amount with currency AFTER the number', () => {
    const r = parseSMS('PAID 300,000 UGX to WELILE. TID 146525101664. Bal 323,546 UGX. 04-May-2026 16:20');
    expect(r.amount).toBe(300000);
    expect(r.transactionId).toBe('TID146525101664');
  });

  it('handles no-space currency prefix (UGX50,000)', () => {
    const r = parseSMS('You have received UGX50,000 from JANE. TID12345678. Bal UGX150,000');
    expect(r.amount).toBe(50000);
    expect(r.transactionId).toBe('TID12345678');
  });

  it('recognises "U.Sh" currency spelling', () => {
    const r = parseSMS('Sent U.Sh 30,000 to MARY. TID 55667788. Bal U.Sh 5,000');
    expect(r.amount).toBe(30000);
    expect(r.transactionId).toBe('TID55667788');
  });

  it('recognises "Shs" / "UShs" currency spelling', () => {
    expect(parseSMS('You have received Shs 10,000 from PETER. Txn ID: ABC12345. Balance Shs 20,000').amount).toBe(10000);
    expect(parseSMS('Payment of UShs 75,000 received. Ref: FT98765432. New balance UShs 200,000').amount).toBe(75000);
  });

  it('captures the value after connective words ("Reference number 5647…")', () => {
    const r = parseSMS('Cash out of UGX 40,000 successful. Reference number 5647382910. Charge UGX 800');
    expect(r.amount).toBe(40000);
    expect(r.transactionId).toBe('5647382910');
  });

  it('does not mistake the English word "Reference" for a bank ref', () => {
    const r = parseSMS('Please quote your Reference in all correspondence. You have sent UGX 20,000. TID 88776655.');
    expect(r.transactionId).toBe('TID88776655');
  });
});

describe('parseSMS · amount formatting (commas / spacing / decimals)', () => {
  it('parses a plain amount with no thousands comma', () => {
    expect(parseSMS('You have sent UGX 5000 to JOHN. TID 12345678.').amount).toBe(5000);
  });

  it('parses millions with multiple comma groups', () => {
    expect(parseSMS('You have received UGX 1,234,567 from JANE. TID 12345678.').amount).toBe(1234567);
  });

  it('parses decimals and rounds to the nearest shilling', () => {
    expect(parseSMS('You have sent UGX 50,000.00 to JOHN. TID 12345678.').amount).toBe(50000);
    expect(parseSMS('You have sent UGX 1,500.50 to JOHN. TID 12345678.').amount).toBe(1501);
  });

  it('tolerates extra spaces between the currency and the number', () => {
    expect(parseSMS('You have sent UGX    75,000 to JOHN. TID 12345678.').amount).toBe(75000);
  });

  it('collapses newlines and tabs before parsing', () => {
    const sms = 'You have sent\n\tUGX 42,000\nto JOHN.\nTID 12345678.';
    expect(parseSMS(sms).amount).toBe(42000);
  });

  it('handles a dot separator between currency and amount ("UGX. 12,000")', () => {
    expect(parseSMS('Paid UGX. 12,000 to SHOP. TID 12345678.').amount).toBe(12000);
  });
});

describe('parseSMS · currency wording variants', () => {
  const cases: Array<[string, string]> = [
    ['UGX', 'You have sent UGX 30,000 to X. TID 12345678.'],
    ['USh', 'You have sent USh 30,000 to X. TID 12345678.'],
    ['UShs', 'You have sent UShs 30,000 to X. TID 12345678.'],
    ['U.Sh', 'You have sent U.Sh 30,000 to X. TID 12345678.'],
    ['U.Shs', 'You have sent U.Shs 30,000 to X. TID 12345678.'],
    ['Shs', 'You have sent Shs 30,000 to X. TID 12345678.'],
    ['Sh', 'You have sent Sh 30,000 to X. TID 12345678.'],
    ['Ush.', 'You have sent Ush. 30,000 to X. TID 12345678.'],
    ['UG.Shs', 'You have sent UG.Shs 30,000 to X. TID 12345678.'],
  ];
  it.each(cases)('recognises the "%s" currency spelling', (_label, sms) => {
    expect(parseSMS(sms).amount).toBe(30000);
  });

  it('recognises the trailing "/-" currency form', () => {
    expect(parseSMS('Withdrawn 15,000/- from agent. Ref 12345678.').amount).toBe(15000);
  });

  it('recognises the trailing "/=" currency form', () => {
    expect(parseSMS('Withdrawn 15,000/= from agent. Ref 12345678.').amount).toBe(15000);
  });
});

describe('parseSMS · transaction id formats', () => {
  it('extracts an Airtel "TID" and normalises with a TID prefix', () => {
    expect(parseSMS('PAID. TID 146525101664. UGX 300,000 to X.').transactionId).toBe('TID146525101664');
  });

  it('extracts a legacy MTN "MP…" reference', () => {
    expect(parseSMS('Received UGX 10,000. MP260504A12345 confirmed.').transactionId).toBe('MP260504A12345');
  });

  it('extracts a Flutterwave "FLW…" reference', () => {
    expect(parseSMS('Payment of UGX 25,000 received. FLW1234567 recorded.').transactionId).toBe('FLW1234567');
  });

  it('extracts bank "FT…" style references', () => {
    expect(parseSMS('You have received UGX 500,000. Ref FT98765432. Bal UGX 1,000,000.').transactionId).toBe('FT98765432');
  });

  it('extracts an MTN numeric "ID :" reference', () => {
    expect(parseSMS('You have sent UGX 150000 to X on 2026-05-05. ID :40479927536.').transactionId).toBe('40479927536');
  });

  it('extracts a "Financial Transaction Id" label', () => {
    expect(parseSMS('Financial Transaction Id: 40479927536. You have sent UGX 150,000.').transactionId).toBe('40479927536');
  });

  it('extracts a generic "Txn ID" label', () => {
    expect(parseSMS('Cash out UGX 40,000. Txn ID: ABC12345. Charge UGX 800.').transactionId).toBe('ABC12345');
  });
});

describe('parseSMS · fee and balance', () => {
  it('extracts fee and balance without confusing them for the amount', () => {
    const r = parseSMS('You have sent UGX 150,000 to X. Fee UGX 1,000. New balance UGX 4,736,158. ID :40479927536.');
    expect(r.amount).toBe(150000);
    expect(r.fee).toBe(1000);
    expect(r.balance).toBe(4736158);
  });

  it('treats a zero charge as no charge (still detects the real amount)', () => {
    const r = parseSMS('PAID. TID 12345678. UGX 300,000 to X. Charge UGX 0. Bal UGX 323,546.');
    expect(r.amount).toBe(300000);
    expect(r.fee).toBe(undefined);
    expect(r.balance).toBe(323546);
  });
});

describe('parseSMS · direction and channel', () => {
  it('detects an inbound (received) direction', () => {
    expect(parseSMS('You have received UGX 50,000 from JOHN. TID 12345678.').direction).toBe('in');
  });

  it('detects an outbound (sent) direction', () => {
    expect(parseSMS('You have sent UGX 50,000 to JOHN. TID 12345678.').direction).toBe('out');
  });

  it('detects a charge direction', () => {
    expect(parseSMS('A charge of UGX 500 was applied for airtime.').direction).toBe('charge');
  });

  it('detects the MTN MoMo channel', () => {
    expect(parseSMS('MTN MoMo: you have received UGX 10,000.').channel).toBe('mtn_momo');
  });

  it('detects the bank channel from a bank name', () => {
    expect(parseSMS('Stanbic Bank: your account was credited UGX 500,000. Ref FT98765432.').channel).toBe('bank');
  });
});

describe('parseSMS · counterparty', () => {
  it('extracts a person name after "from"', () => {
    expect(parseSMS('You have received UGX 50,000 from JANE AKELLO on 2026-05-05. TID 12345678.').counterparty)
      .toBe('JANE AKELLO');
  });

  it('falls back to a phone number when no name is present', () => {
    expect(parseSMS('You have received UGX 20,000 from 0700123456. TID 9988776655.').counterparty)
      .toBe('0700123456');
  });
});

describe('parseSMS · date and time', () => {
  it('parses an ISO date + 24h time', () => {
    const r = parseSMS('Sent UGX 10,000 to X on 2026-05-05 15:08:28. ID :40479927536.');
    expect(r.date).toBe('2026-05-05');
    expect(r.time).toBe('15:08');
  });

  it('parses a DD/MM/YYYY date', () => {
    expect(parseSMS('Sent UGX 10,000. TID 12345678. 05/05/2026 09:05').date).toBe('2026-05-05');
  });

  it('parses a 2-digit year (D-M-YY)', () => {
    expect(parseSMS('Sent UGX 10,000. TID 12345678. 5-5-26').date).toBe('2026-05-05');
  });

  it('parses a named-month date', () => {
    expect(parseSMS('Sent UGX 10,000. TID 12345678. 04-May-2026 16:20').date).toBe('2026-05-04');
  });

  it('parses a 12h AM/PM time into 24h', () => {
    expect(parseSMS('Sent UGX 10,000. TID 12345678. 04-May-2026 3:08 PM').time).toBe('15:08');
  });
});

describe('parseSMS · edge cases / robustness', () => {
  it('returns an empty object for empty input', () => {
    expect(parseSMS('')).toEqual({});
  });

  it('leaves amount undefined for text with no monetary value', () => {
    expect(parseSMS('Welcome to MoMo. Dial *165# to get started.').amount).toBeUndefined();
  });

  it('does not throw on random noise', () => {
    expect(() => parseSMS('!!! ??? @@@ ... 12:99 99:99')).not.toThrow();
  });
});

describe('parsePayoutConfirmationSms · merchant payout focus', () => {
  it('extracts amount, TID, date and time from an Airtel SMS', () => {
    const r = parsePayoutConfirmationSms(
      'PAID.TID 146525101664. UGX 300,000 to WELILE TECHNOLOGIES LIMITED Charge UGX 0. Bal UGX 323,546. 04-May-2026 16:20',
    );
    expect(r.amount).toBe(300000);
    expect(r.transactionId).toBe('TID146525101664');
    expect(r.date).toBe('2026-05-04');
    expect(r.time).toBe('16:20');
    expect(r.phone).toBeUndefined();
  });

  it('extracts only amount and TID from an MTN sent SMS', () => {
    const r = parsePayoutConfirmationSms(
      'You have sent UGX 150000 to LYDIA NAMUGENYI, 256767652611 on 2026-05-05 15:08:28, fee: 1000. Reason: Rent Paid. New balance: 4736158. ID :40479927536.',
    );
    expect(r.amount).toBe(150000);
    expect(r.transactionId).toBe('40479927536');
  });

  it('picks the largest currency-prefixed amount when no strong verb is present', () => {
    const r = parsePayoutConfirmationSms(
      'Bal UGX 4,736,158. Fee UGX 1,000. UGX 150,000 to LYDIA. TID 40479927536.',
    );
    expect(r.amount).toBe(150000);
    expect(r.transactionId).toBe('TID40479927536');
  });

  it('ignores balance and fee labels even when they are larger', () => {
    const r = parsePayoutConfirmationSms(
      'Sent UGX 25,000. Charge UGX 0. New balance UGX 999,000. TID 12345678.',
    );
    expect(r.amount).toBe(25000);
    expect(r.transactionId).toBe('TID12345678');
  });

  it('extracts bank references', () => {
    const r = parsePayoutConfirmationSms(
      'Bank transfer of UGX 500,000 to JOHN DOE. Reference FT98765432.',
    );
    expect(r.amount).toBe(500000);
    expect(r.transactionId).toBe('FT98765432');
  });

  it('extracts trailing-currency amounts', () => {
    const r = parsePayoutConfirmationSms('You have sent 75,000/= to MARY. TID 55667788.');
    expect(r.amount).toBe(75000);
    expect(r.transactionId).toBe('TID55667788');
  });

  it('returns an empty object for empty input', () => {
    expect(parsePayoutConfirmationSms('')).toEqual({});
  });

  it('does not throw on random noise', () => {
    expect(() => parsePayoutConfirmationSms('!!! ??? @@@ ... 12:99 99:99')).not.toThrow();
  });
});

describe('parsePayoutConfirmationSms · date, time and phone (proof-of-payment cross-check evidence)', () => {
  it('extracts an ISO date + 24h time and the recipient phone after "to"', () => {
    const r = parsePayoutConfirmationSms(
      'You have sent UGX 150000 to LYDIA NAMUGENYI, 0767652611 on 2026-05-05 15:08:28, fee: 1000. New balance: 4736158. ID :40479927536.',
    );
    expect(r.date).toBe('2026-05-05');
    expect(r.time).toBe('15:08');
    expect(r.phone).toBe('0767652611');
  });

  it('normalises a 12h AM/PM time into 24h', () => {
    const r = parsePayoutConfirmationSms('Sent UGX 10,000. TID 12345678. 04-May-2026 3:08 PM');
    expect(r.time).toBe('15:08');
  });

  it('extracts a +256-prefixed phone number', () => {
    const r = parsePayoutConfirmationSms('PAID.TID 146525101664. UGX 300,000 to +256701234567 on 04-May-2026 16:20');
    expect(r.phone).toBe('+256701234567');
  });

  it('extracts a phone number in parentheses after a name', () => {
    const r = parsePayoutConfirmationSms('You have sent UGX 150,000 to LYDIA (0767652611). Fee UGX 1,000. TID 40479927536.');
    expect(r.phone).toBe('0767652611');
  });

  it('leaves date, time and phone undefined when none are present, without throwing', () => {
    const r = parsePayoutConfirmationSms('Sent UGX 25,000. TID 12345678.');
    expect(r.amount).toBe(25000);
    expect(r.date).toBeUndefined();
    expect(r.time).toBeUndefined();
    expect(r.phone).toBeUndefined();
  });
});