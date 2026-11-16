import { describe, expect, it } from 'vitest';
import { copyFromPayoutReceipt } from '@/lib/payoutReceiptCopy';
import { buildReceiptCopyPdf } from '@/lib/receiptCopy';
import type { PayoutReceiptData } from '@/lib/payoutReceiptPdf';

// Synthetic receipt shaped like get_payout_receipt_by_token. The commission is set on purpose: it must never reach the copy.
const mobileMoney: PayoutReceiptData = {
  paid: true,
  amount: 1_500_000,
  commission: 7_500,
  payout_method: 'mobile_money',
  reference: '161122301673',
  receipt_token: 'abc123def456abc123def456abc123de',
  receipt_number: 'WD261111-6EFB5B',
  transaction_type: 'Cash Withdrawal',
  processed_at: '2026-11-11T08:00:00.000Z',
  recipient_name: 'TEST RECIPIENT',
  processor_name: 'TEST AGENT',
  merchant_branch: 'Merchant Agent',
  mobile_money_number: '0751899158',
  mobile_money_name: 'Test Registered',
  mobile_money_provider: 'Airtel',
};

describe('copyFromPayoutReceipt', () => {
  it('carries every fact the recipient page shows, in the paper-book lines', () => {
    const c = copyFromPayoutReceipt(mobileMoney, null);
    expect(c.direction).toBe('out');
    expect(c.numberLabel).toBe('WD261111-6EFB5B');
    expect(c.lines.map((l) => l.label)).toEqual(['Paid to:', 'A sum of Shillings:', 'Paid by:', 'Merchant agent:', 'Transaction ID (TID):']);
    const text = c.lines.map((l) => l.value).join(' | ');
    expect(text).toContain('TEST RECIPIENT');
    expect(text).toContain('Mobile Money - Airtel');
    expect(text).toContain('0751 899 158');
    expect(text).toContain('registered name: Test Registered');
    expect(text).toContain('TEST AGENT, Merchant Agent');
    expect(text).toContain('161122301673');
    expect(c.amount).toBe(1_500_000);
  });

  it('never carries the merchant commission', () => {
    const c = copyFromPayoutReceipt(mobileMoney, null);
    const everything = JSON.stringify(c).toLowerCase();
    expect(everything).not.toContain('commission');
    expect(everything).not.toContain('7500');
    expect(everything).not.toContain('7,500');
  });

  it('puts the same checksum in the printed code and the QR link', () => {
    const c = copyFromPayoutReceipt(mobileMoney, null);
    const fromQr = new URL(c.qrText).searchParams.get('c');
    expect(fromQr).not.toBeNull();
    expect(c.verifyCode.toLowerCase()).toBe(fromQr!.toLowerCase());
  });

  it('describes a bank payout with the bank, account and account name', () => {
    const c = copyFromPayoutReceipt(
      { ...mobileMoney, payout_method: 'bank_transfer', bank_name: 'Test Bank', bank_account_number: '000111', bank_account_name: 'Test Holder' },
      null,
    );
    const paidBy = c.lines.find((l) => l.label === 'Paid by:')!.value;
    expect(paidBy).toBe('Bank Transfer, Test Bank, A/c 000111, (Test Holder)');
  });

  it('marks a reprint on the copy', () => {
    expect(copyFromPayoutReceipt(mobileMoney, 'Reprint printed X. Not the original.').reprintNote).toContain('Not the original');
  });
});

describe('buildReceiptCopyPdf', () => {
  it('builds a one-page A5 landscape PDF for a payout copy', async () => {
    const doc = await buildReceiptCopyPdf(copyFromPayoutReceipt(mobileMoney, null));
    expect(doc.getNumberOfPages()).toBe(1);
    expect(doc.internal.pageSize.getWidth()).toBeGreaterThan(doc.internal.pageSize.getHeight());
  });
});
