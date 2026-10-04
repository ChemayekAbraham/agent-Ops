import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture jsPDF calls via a mock instance.
const textCalls: any[] = [];
const saveCalls: string[] = [];

vi.mock('jspdf', () => {
  class FakePdf {
    internal = {
      pageSize: { getWidth: () => 595, getHeight: () => 842 },
    };
    setFont() {}
    setFontSize() {}
    setTextColor() {}
    setDrawColor() {}
    setFillColor() {}
    roundedRect() {}
    line() {}
    getTextWidth() { return 50; }
    splitTextToSize(t: string) {
      return [t];
    }
    text(t: any, ..._rest: any[]) {
      textCalls.push(t);
    }
    save(name: string) {
      saveCalls.push(name);
    }
    output() { return new Blob([], { type: 'application/pdf' }); }
  }
  return { default: FakePdf };
});

import { downloadWithdrawalReceiptPdf } from '@/lib/withdrawalReceiptPdf';

describe('downloadWithdrawalReceiptPdf', () => {
  beforeEach(() => {
    textCalls.length = 0;
    saveCalls.length = 0;
  });

  it('writes reference, processed timestamp and amount, then triggers download', async () => {
    const date = new Date('2026-05-19T08:30:00Z');
    await downloadWithdrawalReceiptPdf({
      reference: 'REQ-ABC123DEF456',
      amount: 125000,
      currency: 'UGX',
      recipient: 'MTN - 0772000111',
      method: 'Mobile Money',
      date,
      status: 'Pending disbursement',
    });

    const flat = textCalls.flat().join(' | ');

    // Reference appears
    expect(flat).toContain('REQ-ABC123DEF456');
    // Amount formatted with currency + thousands separator
    expect(flat).toContain('UGX 125,000');
    // Processed timestamp rendered via date-fns MMM d, yyyy HH:mm
    expect(flat).toMatch(/May 19, 2026 \d{2}:\d{2}/);
    // Status label present
    expect(flat).toContain('Pending disbursement');
    // Fee breakdown panel renders zero-fee assurance lines + net total
    expect(flat).toContain('Fee Breakdown');
    expect(flat).toContain('Platform service fee');
    expect(flat).toContain('Transaction expenses');
    expect(flat).toContain('Net amount payable');
    expect(flat).toContain('UGX 125,000');

    // Download was actually triggered with a safe filename including the ref
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]).toBe('withdrawal_REQ-ABC123DEF456.pdf');
  });

  it('falls back to a safe filename when reference is missing', async () => {
    await downloadWithdrawalReceiptPdf({
      reference: '',
      amount: 1000,
      currency: 'UGX',
      recipient: 'Cash Pickup',
      method: 'Cash Pickup',
      date: new Date(),
    });
    expect(saveCalls[0]).toBe('withdrawal_receipt.pdf');
  });
});
