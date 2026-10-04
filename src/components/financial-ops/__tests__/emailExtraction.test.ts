import { describe, it, expect } from 'vitest';
import {
  normalizeUgPhone,
  extractPhones,
  extractFromPhones,
  extractToPhones,
  extractReferences,
} from '@/components/financial-ops/emailExtraction';

/**
 * Sample emails are condensed from real MTN MoMo, Airtel Money and Equity
 * Bank Uganda confirmation messages. These tests guard the recipient-phone
 * detection used by the money-out flow on the Email Transactions panel.
 */

describe('normalizeUgPhone', () => {
  it('canonicalizes the three common Ugandan phone shapes', () => {
    expect(normalizeUgPhone('+256 772 123 456')).toBe('256772123456');
    expect(normalizeUgPhone('256772123456')).toBe('256772123456');
    expect(normalizeUgPhone('0772123456')).toBe('256772123456');
    expect(normalizeUgPhone('2560772123456')).toBe('256772123456'); // leading-zero quirk
  });

  it('rejects clearly non-Uganda numbers', () => {
    expect(normalizeUgPhone('')).toBeNull();
    expect(normalizeUgPhone('1234')).toBeNull();
    expect(normalizeUgPhone('+1 555 123 4567')).toBeNull();
  });
});

describe('money-out recipient extraction — MTN MoMo', () => {
  const row = {
    from_email: 'no-reply@mtn.com',
    from_name: 'MTN Mobile Money',
    subject: 'Payment Confirmation',
    snippet:
      'You have sent UGX 50,000 to 256772123456 JOHN DOE. Charge: UGX 1,100. New balance: UGX 12,400. TID: MP240501.0000.A12345',
    counterparty: 'JOHN DOE',
    transaction_id: 'MP240501.0000.A12345',
  };

  it('extracts the recipient after "to" as a high-signal match', () => {
    expect(extractToPhones(row)).toEqual(['256772123456']);
  });

  it('also surfaces the phone via the generic phone extractor', () => {
    expect(extractPhones(row)).toContain('256772123456');
  });

  it('does NOT mis-classify the recipient as a "from" match', () => {
    expect(extractFromPhones(row)).toEqual([]);
  });

  it('captures the TID as an upper-cased reference', () => {
    expect(extractReferences(row)).toEqual(['MP240501.0000.A12345']);
  });
});

describe('money-out recipient extraction — Airtel Money', () => {
  const row = {
    from_email: 'noreply@airtel.co.ug',
    from_name: 'Airtel Money',
    subject: 'Airtel Money Transaction',
    snippet:
      'Confirmed. UGX 25,000 sent to 0703987654 MARY NABUKEERA on 02-May. Fee UGX 750. Ref: AIR.250502.0703.998877',
    counterparty: 'MARY NABUKEERA',
    transaction_id: 'AIR.250502.0703.998877',
  };

  it('normalizes a 0-prefixed recipient phone behind "to"', () => {
    expect(extractToPhones(row)).toEqual(['256703987654']);
  });

  it('captures the Airtel reference', () => {
    expect(extractReferences(row)).toEqual(['AIR.250502.0703.998877']);
  });
});

describe('money-out recipient extraction — Equity Bank Uganda', () => {
  const row = {
    from_email: 'alerts@equitybank.co.ug',
    from_name: 'Equity Bank',
    subject: 'Funds Transfer Alert',
    snippet:
      'Dear customer, UGX 1,250,000 has been transferred to +256 781 444 555 PETER OKELLO via EazzyPay. Charges UGX 2,500. Ref EQB-TRF-20250503-99812',
    counterparty: 'PETER OKELLO',
    transaction_id: 'EQB-TRF-20250503-99812',
  };

  it('extracts the +256-formatted recipient phone behind "to"', () => {
    expect(extractToPhones(row)).toEqual(['256781444555']);
  });

  it('captures the Equity reference', () => {
    expect(extractReferences(row)).toEqual(['EQB-TRF-20250503-99812']);
  });
});

describe('deposit (money-in) sanity — must not regress', () => {
  const row = {
    from_email: 'no-reply@mtn.com',
    from_name: 'MTN Mobile Money',
    subject: 'Deposit Received',
    snippet:
      'You have received UGX 100,000 from 256759111222 ALICE NAKATO. New balance: UGX 245,300. TID: MP240501.1234.B98765',
    counterparty: 'ALICE NAKATO',
    transaction_id: 'MP240501.1234.B98765',
  };

  it('extracts depositor phone behind "from"', () => {
    expect(extractFromPhones(row)).toEqual(['256759111222']);
  });

  it('does NOT mis-classify the depositor as a "to" recipient', () => {
    expect(extractToPhones(row)).toEqual([]);
  });
});

describe('edge cases', () => {
  it('handles multiple recipients in a single email body', () => {
    const row = {
      snippet:
        'Batch payout: UGX 10,000 to 256772000111 JOHN, UGX 12,000 to 256703222333 MARY.',
    };
    expect(extractToPhones(row).sort()).toEqual(
      ['256703222333', '256772000111'].sort(),
    );
  });

  it('ignores phones that are not preceded by "to" when extracting recipients', () => {
    const row = {
      snippet: 'Balance enquiry for 256772123456 completed.',
    };
    expect(extractToPhones(row)).toEqual([]);
    expect(extractPhones(row)).toEqual(['256772123456']);
  });

  it('returns an empty array when no phone is present', () => {
    expect(extractPhones({ snippet: 'No numbers here.' })).toEqual([]);
    expect(extractToPhones({ snippet: 'No numbers here.' })).toEqual([]);
    expect(extractFromPhones({ snippet: 'No numbers here.' })).toEqual([]);
  });

  it('dedupes repeated phones', () => {
    const row = {
      snippet: 'Sent to 256772123456. Confirmation to 0772123456 succeeded.',
    };
    expect(extractPhones(row)).toEqual(['256772123456']);
  });
});