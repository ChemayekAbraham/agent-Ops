import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DirectPayHeldPlan, DirectPayStartButton, DirectPayPartnerPayments } from './DirectPayPartner';
import { DirectPayOpsQueue } from './DirectPayOps';
import { DirectPayAgentItems } from './DirectPayAgent';
import type { DirectPayView, DirectPayQueueRow } from '@/lib/directPay';

const mock = vi.hoisted(() => ({
  claim: vi.fn(), upload: vi.fn(), release: vi.fn(), refresh: vi.fn(),
  approve: vi.fn(), reject: vi.fn(), send: vi.fn(), record: vi.fn(), photo: vi.fn(),
  photos: vi.fn(), next: vi.fn(), refetch: vi.fn(), canAct: true, error: false,
  rows: [] as unknown[], payments: [] as unknown[], agents: [] as unknown[],
}));
vi.mock('@/hooks/useDirectPay', () => {
  const mutation = (mutateAsync: unknown) => ({ mutateAsync, isPending: false });
  return {
    useDirectPayClaim: () => mutation(mock.claim), useDirectPayUploadProof: () => mutation(mock.upload),
    useDirectPayRelease: () => mutation(mock.release), useDirectPayRefresh: () => mutation(mock.refresh),
    useDirectPayApprove: () => mutation(mock.approve), useDirectPayReject: () => mutation(mock.reject),
    useDirectPaySendOtp: () => mutation(mock.send), useDirectPayRecordLandlordReceipt: () => mutation(mock.record),
    useDirectPayUploadLandlordReceiptPhoto: () => mutation(mock.photo),
    useMyDirectPayments: () => ({ data: mock.payments, isError: mock.error, refetch: mock.refetch }),
    useDirectPayAgentItems: () => ({ data: mock.agents, isError: mock.error, refetch: mock.refetch }),
    useDirectPayQueue: () => ({ data: { pages: [{ can_act: mock.canAct, rows: mock.rows }] }, isError: mock.error, hasNextPage: true, fetchNextPage: mock.next, refetch: mock.refetch }),
    useDirectPayProofPhotos: (paths: string[]) => { mock.photos(paths); return { data: Object.fromEntries(paths.map((path) => [path, `/proof/${path}`])) }; },
  };
});

const held: DirectPayView = {
  ok: true, code: null, payment_id: 'payment-1', rent_request_id: 'plan-1', status: 'held',
  tenant_first_name: 'Mary', landlord_name: 'Sarah', landlord_number: '+256700123456',
  amount_due: 500000, amount_received: 0, amount_short: 500000, cover_fee: 10000,
  float_available: 20000, hold_expires_at: new Date(Date.now() + 48 * 3600000).toISOString(), proofs: [],
};
const row: DirectPayQueueRow = {
  payment_id: 'payment-1', rent_request_id: 'plan-1', status: 'pending', created_at: '2026-11-13',
  has_flags: true, flags: ['wrong_number'], waiting_hours: 25, over_24h: true, decided_at: null,
  amount_due: 500000, amount_received: 500000, cover_fee: 10000, cover_fee_status: 'held',
  partner: { id: 'partner-1', name: 'Partner', phone: '+256700000001' }, tenant: { name: 'Mary', phone: null },
  agent: { id: 'agent-1', name: 'Agent', phone: null }, landlord: { name: 'Sarah', phone_on_file: '+256700123456', verified_number: '+256700123456' },
  call_note: null, flag_reason: null, reject_note: null, otp: null,
  proofs: ['a.jpg', 'b.jpg'].map((path) => ({ id: path, photo_path: path, provider: 'mtn', amount_read: 250000, amount_typed: null, tid_read: path, tid_typed: null, recipient_read: null, paid_at_read: null, reader_status: 'read', created_at: '2026-11-13' })),
};

beforeEach(() => {
  cleanup(); vi.clearAllMocks(); mock.canAct = true; mock.error = false;
  mock.rows = [row]; mock.payments = []; mock.agents = [];
  mock.claim.mockResolvedValue(held); mock.upload.mockResolvedValue({ ...held, status: 'pending' });
  mock.send.mockResolvedValue({ ok: true, sent_to: '***456', expires_at: '2026-11-13T10:10:00Z' });
  mock.approve.mockResolvedValue({ ok: true, receipt_number: 'WLR-1', receipt_code: 'receipt-1' });
  mock.reject.mockResolvedValue({ ok: true }); mock.record.mockResolvedValue({ ok: true });
});

describe('direct-payment partner workflow', () => {
  it('claims a plan and opens the server-provided held view', async () => {
    render(<DirectPayStartButton rentRequestId="plan-1" />);
    fireEvent.click(screen.getByRole('button', { name: "I'll pay the landlord myself" }));
    await screen.findByRole('dialog'); expect(mock.claim).toHaveBeenCalledWith('plan-1');
    expect(screen.getByRole('timer').textContent).toMatch(/47h|48h/);
  });
  it('handles the not_available claim without opening a held plan', async () => {
    mock.claim.mockResolvedValue({ ok: false, code: 'not_available' });
    render(<DirectPayStartButton rentRequestId="plan-1" />);
    fireEvent.click(screen.getByRole('button', { name: "I'll pay the landlord myself" }));
    await screen.findByRole('alert'); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('only asks for amount after amount_missing and sends the entered SMS data', async () => {
    mock.upload.mockResolvedValueOnce({ ok: false, code: 'amount_missing' });
    render(<DirectPayHeldPlan payment={held} />);
    expect(screen.queryByLabelText('Amount')).toBeNull();
    const photo = new File(['sms'], 'sms.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByLabelText('SMS photo'), { target: { files: [photo] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload SMS' }));
    await screen.findByLabelText('Amount');
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '500000' } });
    fireEvent.change(screen.getByLabelText('Transaction ID (optional)'), { target: { value: 'TID123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Airtel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upload SMS' }));
    await waitFor(() => expect(mock.upload).toHaveBeenLastCalledWith({ paymentId: 'payment-1', rentRequestId: 'plan-1', photo, tidTyped: 'TID123', provider: 'airtel', amountTyped: 500000 }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Upload SMS' })).toBeNull());
  });
  it('does not offer release once a proof exists', () => {
    render(<DirectPayHeldPlan payment={{ ...held, proofs: [{ id: 'proof-1', amount: 500000, tid_last4: '1234', created_at: '2026-11-13' }] }} />);
    expect(screen.queryByRole('button', { name: 'Let go of this plan' })).toBeNull();
  });
  it('shows unavailable lists politely', () => {
    mock.error = true; render(<DirectPayPartnerPayments />);
    expect(screen.getByRole('alert')).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mock.refetch).toHaveBeenCalledOnce();
  });
});

describe('Landlord Ops review', () => {
  it('batches every loaded proof path and forwards OTP, note and flagged reason', async () => {
    render(<DirectPayOpsQueue />); expect(mock.photos).toHaveBeenCalledWith(['a.jpg', 'b.jpg']);
    fireEvent.click(screen.getByRole('button', { name: 'Send OTP' }));
    await waitFor(() => expect(mock.send).toHaveBeenCalledWith('payment-1'));
    fireEvent.change(screen.getByLabelText("Landlord's 6-digit code"), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('Call note'), { target: { value: 'Landlord confirmed receipt.' } });
    fireEvent.change(screen.getByLabelText('Why is it safe to approve?'), { target: { value: 'Confirmed correct recipient by call.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mock.approve).toHaveBeenCalledWith({ paymentId: 'payment-1', otp: '123456', callNote: 'Landlord confirmed receipt.', flagReason: 'Confirmed correct recipient by call.' }));
    expect(await screen.findByRole('link', { name: 'WLR-1' })).toHaveAttribute('href', 'https://welileapp.com/r/receipt-1');
  });
  it('passes rejection reason without changing the payment locally', async () => {
    render(<DirectPayOpsQueue />); fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.change(screen.getByLabelText('Reason for rejecting'), { target: { value: 'Landlord did not receive payment.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    await waitFor(() => expect(mock.reject).toHaveBeenCalledWith({ paymentId: 'payment-1', reason: 'Landlord did not receive payment.' }));
  });
  it('respects server read-only authority', () => {
    mock.canAct = false; render(<DirectPayOpsQueue />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send OTP' })).toBeNull();
  });
  it('keeps COO and super-admin read-only even when passed an actionable page', () => {
    render(<DirectPayOpsQueue readOnly />); expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
  it('loads the next page through the infinite query', () => {
    render(<DirectPayOpsQueue />); fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(mock.next).toHaveBeenCalledOnce();
  });
  it('shows the decision helper refusal instead of success', async () => {
    mock.approve.mockResolvedValue({ ok: false, code: 'otp_wrong', attempts_left: 2 });
    render(<DirectPayOpsQueue />); fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByRole('status'); expect(screen.queryByRole('link', { name: 'WLR-1' })).toBeNull();
  });
});

describe('agent receipt workflow', () => {
  it('records the signed receipt number and never offers to pay again', async () => {
    mock.agents = [{ payment_id: 'payment-1', rent_request_id: 'plan-1', amount: 500000, partner_first_name: 'Ruth', tenant_name: 'Mary', landlord_name: 'Sarah', receipt_code: 'receipt-1', receipt_number: 'WLR-1', needs_landlord_receipt: true }];
    render(<DirectPayAgentItems />);
    expect(screen.queryByRole('button', { name: /pay the landlord/i })).toBeNull();
    fireEvent.change(screen.getByLabelText("Number on the landlord's signed receipt"), { target: { value: 'LR-12345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record landlord receipt' }));
    await waitFor(() => expect(mock.record).toHaveBeenCalledWith({ paymentId: 'payment-1', receiptNumber: 'LR-12345', photoPath: null }));
  });
});