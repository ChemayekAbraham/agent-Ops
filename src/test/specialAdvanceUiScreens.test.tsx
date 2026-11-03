import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpecialAdvancesPanel } from '@/components/cfo/special-advances/SpecialAdvancesPanel';
import { SpecialAdvanceDetailSheet } from '@/components/cfo/special-advances/SpecialAdvanceDetailSheet';
import { SpecialAdvanceProofInput, SpecialAdvanceProofLink } from '@/components/cfo/special-advances/SpecialAdvanceProofInput';
import { SpecialAdvanceProvisionsTab } from '@/components/cfo/special-advances/SpecialAdvanceProvisionsTab';
import { SpecialAdvanceCorrectionDialog } from '@/components/cfo/special-advances/SpecialAdvanceCorrectionDialog';
import { SpecialAdvanceWriteOffDialog } from '@/components/cfo/special-advances/SpecialAdvanceWriteOffDialog';
import { describeSpecialAdvanceError } from '@/lib/specialAdvances';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  storage: {
    from: vi.fn(() => ({
      upload: vi.fn(),
      createSignedUrl: vi.fn(),
    })),
  },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  auth: {
    mfa: {
      getAuthenticatorAssuranceLevel: vi.fn(() => Promise.resolve({ data: { currentLevel: 'aal1' } })),
      listFactors: vi.fn(() => Promise.resolve({ data: { totp: [{ id: 'factor-1' }] } })),
      challengeAndVerify: vi.fn(),
      enroll: vi.fn(),
      unenroll: vi.fn(),
    },
    signOut: vi.fn(),
    refreshSession: vi.fn(),
  },
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    storage: mocks.storage,
    auth: mocks.auth,
  },
}));

vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/components/cfo/SpecialAdvanceModal', () => ({
  SpecialAdvanceModal: ({ open }: { open: boolean }) => (open ? <div>record modal open</div> : null),
}));

const mockAdvance = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  reference: `SA-00000${id}`,
  status,
  borrower_kind: 'welile_user',
  borrower_user_id: 'u1',
  borrower_name: `Borrower ${id}`,
  external_borrower: null,
  principal: 500000,
  rate_percent: 28,
  rate_basis: 'monthly',
  term_days: 90,
  frequency: 'monthly',
  access_fee: 420000,
  registration_fee: 20000,
  total_repayable: 940000,
  instalments: 3,
  purpose: 'Working capital for inventory',
  planned_payout_date: null,
  payout_date: status === 'disbursed' || status === 'written_off' ? '2026-10-20' : null,
  payout_method: status === 'disbursed' || status === 'written_off' ? 'wallet' : null,
  payout_reference: null,
  decision_reason: null,
  created_at: '2026-10-27T08:00:00Z',
  updated_at: `2026-10-27T08:00:0${id}Z`,
  events: [
    { event_type: 'created', from_status: null, to_status: 'pending_approval', actor_id: 'c', actor_name: 'CFO', reason: null, details: null, created_at: '2026-10-27T08:00:00Z' },
  ],
  position: {
    total_repayable: 940000,
    total_paid: 0,
    outstanding: status === 'disbursed' ? 940000 : 0,
    paid_out: status === 'disbursed' || status === 'written_off',
    scheduled_outstanding: 940000,
    outstanding_access_fee: 0,
    outstanding_registration_fee: 0,
    outstanding_principal: 0,
    overdue_amount: 0,
    overdue_instalments: 0,
    instalments: [{ number: 1, due_date: null, amount: 940000, paid: 0, outstanding: 940000, status: 'due' }],
  },
  repayments: [] as Array<Record<string, unknown>>,
  corrections: [] as Array<Record<string, unknown>>,
  write_offs: [] as Array<Record<string, unknown>>,
  recoveries: [] as Array<Record<string, unknown>>,
  allowance_held: 0,
  ...over,
});

const renderWithClient = (ui: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};

beforeEach(() => {
  vi.clearAllMocks();
  if (typeof document !== 'undefined' && !document.elementFromPoint) {
    document.elementFromPoint = () => null;
  }
  mocks.rpc.mockImplementation((fn: string) => {
    switch (fn) {
      case 'special_advance_list':
        return Promise.resolve({ data: { issuance_enabled: true, total_count: 1, items: [mockAdvance('1', 'pending_approval')] }, error: null });
      case 'special_advance_reconciliation':
        return Promise.resolve({
          data: {
            a24_ledger_balance: 940000,
            subledger_outstanding: 940000,
            difference: 0,
            balanced: true,
            a25_ledger_balance: 94000,
            allowance_subledger: 94000,
            allowance_difference: 0,
            net_receivable: 846000,
            mismatched_advances: [],
            mismatched_allowances: [],
          },
          error: null,
        });
      case 'special_advance_provision_preview':
        return Promise.resolve({
          data: {
            as_of_date: '2026-11-02',
            lines: [{
              advance_id: '1',
              reference: 'SA-000001',
              gross_outstanding: 940000,
              days_past_due: 15,
              minimum_rate: 10,
              individual_rate: null,
              applied_rate: 10,
              required_allowance: 94000,
              held_before: 0,
              delta: 94000,
            }],
            total_delta: 94000,
            allowance_held: 0,
          },
          error: null,
        });
      default:
        return Promise.resolve({ data: null, error: null });
    }
  });
});
afterEach(cleanup);

describe('Special Advances UI - Accounting and Status Figures', () => {
  it('displays "Repayable after payout" when paid_out is false', async () => {
    const unposted = mockAdvance('1', 'pending_approval', {
      position: {
        paid_out: false,
        scheduled_outstanding: 940000,
        outstanding: 0,
        total_repayable: 940000,
        total_paid: 0,
        overdue_amount: 0,
        overdue_instalments: 0,
        instalments: [],
      },
    });

    mocks.rpc.mockImplementation((fn: string) => {
      if (fn === 'special_advance_statement') return Promise.resolve({ data: unposted, error: null });
      return Promise.resolve({ data: null, error: null });
    });

    renderWithClient(<SpecialAdvanceDetailSheet advanceId="1" issuanceEnabled={true} onOpenChange={() => {}} />);
    expect(await screen.findByText('Repayable after payout')).toBeTruthy();
    expect(screen.queryByText('Outstanding', { selector: 'dt' })).toBeNull();
  });

  it('displays A25 allowance and Net receivable in reconciliation when returned from server', async () => {
    renderWithClient(<SpecialAdvancesPanel />);
    await userEvent.click(screen.getByText('Reconciliation & Balances'));
    expect(await screen.findByText('Account A25 (Impairment Allowance)')).toBeTruthy();
    expect(await screen.findByText('Net Special Advances Receivable')).toBeTruthy();
  });
});

describe('Special Advances UI - Proof Inputs and Links', () => {
  it('validates file types and sizes before upload', () => {
    const onFileChange = vi.fn();
    render(<SpecialAdvanceProofInput file={null} onFileChange={onFileChange} />);

    const input = document.getElementById('special-advance-proof-file') as HTMLInputElement;

    // Invalid type: zip
    const badFile = new File(['content'], 'test.zip', { type: 'application/zip' });
    fireEvent.change(input, { target: { files: [badFile] } });
    expect(screen.getByRole('alert').textContent).toMatch(/JPEG, PNG or WebP image, or a PDF/);
    expect(onFileChange).toHaveBeenCalledWith(null);

    // Valid type: pdf
    const goodFile = new File(['pdf content'], 'receipt.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [goodFile] } });
    expect(onFileChange).toHaveBeenCalledWith(goodFile);
  });

  it('"View proof" link calls getSpecialAdvanceProofUrl on click only', async () => {
    const createSignedUrl = vi.fn(() => Promise.resolve({ data: { signedUrl: 'https://example.com/proof.pdf' }, error: null }));
    mocks.storage.from.mockReturnValue({ createSignedUrl, upload: vi.fn() });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(<SpecialAdvanceProofLink path="advances/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.pdf" />);

    expect(createSignedUrl).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('View proof'));

    await waitFor(() => {
      expect(createSignedUrl).toHaveBeenCalledWith(
        'advances/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.pdf',
        60
      );
      expect(openSpy).toHaveBeenCalledWith('https://example.com/proof.pdf', '_blank', 'noopener,noreferrer');
    });

    openSpy.mockRestore();
  });
});

describe('Special Advances UI - Corrections (one step, CFO decision 2026-11-03)', () => {
  const pdf = () => new File(['%PDF-1.4'], 'statement.pdf', { type: 'application/pdf' });
  const uploadsWork = () => {
    mocks.storage.from.mockReturnValue({ upload: vi.fn().mockResolvedValue({ error: null }), createSignedUrl: vi.fn() });
  };

  it('has no approval queue: no "Awaiting" tab and no second-CFO wording', async () => {
    renderWithClient(<SpecialAdvancesPanel />);
    await screen.findByText(/^Agreements [(]/);
    expect(screen.queryByText(/Awaiting/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/second CFO|second-CFO|two-CFO|maker-checker/i);
    expect(mocks.rpc.mock.calls.map(([fn]) => fn)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^special_advance_list_(corrections|provision_reviews|write_offs)$/)]));
  });

  it('a correction is posted in one action: one call to special_advance_record_correction with reason, proof and key', async () => {
    uploadsWork();
    mocks.rpc.mockImplementation((fn: string) => Promise.resolve(fn === 'special_advance_record_correction'
      ? { data: { id: 'c1', reference: 'SAC-000001', replayed: false }, error: null } : { data: null, error: null }));
    const onSuccess = vi.fn();
    renderWithClient(<SpecialAdvanceCorrectionDialog open onOpenChange={() => {}} kind="repayment_reversal" repaymentId="r1"
      repaymentAmount={200000} repaymentReference="MM-1" onSuccess={onSuccess}
      advance={mockAdvance('1', 'disbursed', { id: '0b6f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e' }) as never} />);
    expect(screen.getByText('Posts immediately')).toBeTruthy();
    fireEvent.change(document.getElementById('correction-reason') as HTMLTextAreaElement, { target: { value: 'Recorded against the wrong advance in error' } });
    fireEvent.change(document.getElementById('correction-proof') as HTMLInputElement, { target: { files: [pdf()] } });
    fireEvent.click(screen.getByText('Post correction'));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const calls = mocks.rpc.mock.calls.filter(([fn]) => String(fn).startsWith('special_advance_'));
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('special_advance_record_correction');
    expect(calls[0][1].p_request).toMatchObject({ kind: 'repayment_reversal', repayment_id: 'r1', reason: 'Recorded against the wrong advance in error' });
    expect(mocks.toast.success).toHaveBeenCalledWith('Correction SAC-000001 posted');
  });

  it('a write-off is posted in one action and sends the balance the CFO saw', async () => {
    uploadsWork();
    mocks.rpc.mockImplementation((fn: string) => Promise.resolve(fn === 'special_advance_write_off'
      ? { data: { id: 'w1', reference: 'SAW-000001', replayed: false }, error: null } : { data: null, error: null }));
    const onSuccess = vi.fn();
    renderWithClient(<SpecialAdvanceWriteOffDialog open onOpenChange={() => {}} onSuccess={onSuccess}
      advance={mockAdvance('1', 'disbursed', { id: '0b6f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e' }) as never} />);
    fireEvent.change(document.getElementById('writeoff-reason') as HTMLTextAreaElement, { target: { value: 'Borrower unreachable for 120 days now' } });
    fireEvent.change(document.getElementById('writeoff-proof') as HTMLInputElement, { target: { files: [pdf()] } });
    fireEvent.click(screen.getByText('Post write-off'));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const calls = mocks.rpc.mock.calls.filter(([fn]) => String(fn).startsWith('special_advance_'));
    expect(calls.map(([fn]) => fn)).toEqual(['special_advance_write_off']);
    expect(calls[0][1].p_request).toMatchObject({ expected_gross_amount: 940000, reason: 'Borrower unreachable for 120 days now' });
  });

  it('shows reversed repayments struck through as "Reversed (SAC-...)" and not counted', async () => {
    const advanceWithReversedRepayment = mockAdvance('1', 'disbursed', {
      repayments: [
        {
          id: 'rep-1',
          amount: 150000,
          received_date: '2026-10-25',
          method: 'mobile_money',
          reference: 'MM-TXN-01',
          proof_path: 'advances/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000001.pdf',
          reversed_by_correction: 'SAC-000001',
        },
      ],
    });

    mocks.rpc.mockImplementation((fn: string) => {
      if (fn === 'special_advance_statement') return Promise.resolve({ data: advanceWithReversedRepayment, error: null });
      return Promise.resolve({ data: null, error: null });
    });

    renderWithClient(<SpecialAdvanceDetailSheet advanceId="1" issuanceEnabled={true} onOpenChange={() => {}} />);
    expect(await screen.findByText(/Reversed \(SAC-000001\)/)).toBeTruthy();
    expect(screen.queryByText('Reverse this repayment')).toBeNull();
  });
});

describe('Special Advances UI - no authenticator (CFO decision 2026-11-03)', () => {
  it('words a leftover MFA_REQUIRED from a server without the change, never asking for a code', () => {
    expect(describeSpecialAdvanceError({ message: 'MFA_REQUIRED' })).toMatch(/not been applied yet/);
    expect(describeSpecialAdvanceError({ message: 'MFA_REQUIRED' })).not.toMatch(/authenticator app first/);
  });
});

describe('Special Advances UI - Missing Server Functions (PGRST202)', () => {
  it('shows quiet "Not available yet" message when Phase C function returns PGRST202', async () => {
    mocks.rpc.mockImplementation((fn: string) => {
      if (fn === 'special_advance_provision_preview') {
        return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function special_advance_provision_preview' } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    renderWithClient(<SpecialAdvanceProvisionsTab />);

    expect(await screen.findByText(/not available yet on this database/i, {}, { timeout: 4000 })).toBeTruthy();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
});
