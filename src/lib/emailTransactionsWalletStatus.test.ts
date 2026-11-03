import { describe, expect, it } from 'vitest';
import { deriveWalletStatus, type GmailTx, type WalletStatusInput } from './emailTransactionsLogic';

const row = (over: Partial<GmailTx> = {}): GmailTx => ({
  id: 'r1', gmail_message_id: 'm1', from_email: null, from_name: null, subject: null, snippet: null,
  amount: 100000, transaction_id: 'T1', parsed: true, internal_date: null, direction: 'in', channel: 'mtn',
  counterparty: null, counterparty_name: null, fee: null, balance: null,
  linked_deposit_request_id: null, auto_matched_at: null, ...over,
});
const input = (over: Partial<WalletStatusInput> = {}): WalletStatusInput => ({
  history: [], credited: [], manualMark: null, ledgerHit: false, justRouted: false, ...over,
});
const h = (route: string, reason: string) => ({
  route, reason, amount: 100000, created_at: '2026-10-22T08:00:00Z', target_user_name: 'A',
});

describe('deriveWalletStatus', () => {
  it('flags an unreadable email for review', () => {
    expect(deriveWalletStatus(row({ parsed: false, amount: null }), input())).toEqual({ label: 'Needs review', tone: 'red' });
  });
  it('an untouched deposit is awaiting routing, an untouched payout is not charged yet', () => {
    expect(deriveWalletStatus(row(), input())?.label).toBe('Awaiting routing');
    expect(deriveWalletStatus(row({ direction: 'out' }), input())?.label).toBe('Not charged yet');
  });
  it('fully vs partially credited', () => {
    const full = input({ credited: [{ amount: 100000, credited_at: null, user_name: 'A' }] });
    const part = input({ credited: [{ amount: 40000, credited_at: null, user_name: 'A' }] });
    expect(deriveWalletStatus(row(), full)?.label).toBe('Credited');
    expect(deriveWalletStatus(row(), part)?.label).toBe('Partially credited');
  });
  it('a reversal wins over everything else', () => {
    const s = input({ history: [h('wallet', 'Reversed by ops')], credited: [{ amount: 100000, credited_at: null, user_name: 'A' }] });
    expect(deriveWalletStatus(row(), s)?.label).toBe('Reversed');
  });
  it('auto-debits read as charged, proxy debits say so, plain routing is routed', () => {
    expect(deriveWalletStatus(row({ direction: 'out' }), input({ history: [h('withdrawable_debit', 'DEBIT (auto, mtn): x')] }))?.label).toBe('Charged');
    expect(deriveWalletStatus(row({ direction: 'out' }), input({ history: [h('withdrawable_debit', 'DEBIT (auto, mtn, via managed proxy for P): x')] }))?.label).toBe('Charged (proxy)');
    expect(deriveWalletStatus(row(), input({ history: [h('wallet', 'manual')] }))?.label).toBe('Routed');
  });
  it('a manual "not paid in" mark keeps the deposit awaiting routing', () => {
    expect(deriveWalletStatus(row(), input({ manualMark: { mark: 'uncredited' } }))?.label).toBe('Awaiting routing');
  });
  it('bank echoes of our own payouts have no wallet status', () => {
    const echo = row({ channel: 'bank', counterparty: 'WELILE TECHNOLOGIES LIMITED' });
    expect(deriveWalletStatus(echo, input())).toBeNull();
  });
});
