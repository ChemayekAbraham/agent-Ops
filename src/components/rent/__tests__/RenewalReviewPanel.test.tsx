import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const rpcMock = vi.fn();
let notesRows: any[] = [];
const fromMock = vi.fn((table: string) => {
  const result = table === 'rent_request_review_notes' ? notesRows : [{ id: 'u-1', full_name: 'Joy Ops' }];
  const chain: any = { select: () => chain, eq: () => chain, in: () => chain, order: () => Promise.resolve({ data: result, error: null }), then: (r: any) => r({ data: result, error: null }) };
  return chain;
});
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: (t: string) => fromMock(t) } }));
let roles: string[] = ['tenant_ops'];
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u-1' }, roles }) }));
vi.mock('../RentRequestDetailDrawer', () => ({ RentRequestDetailDrawer: ({ requestId, open }: any) => (open ? <div>previous plan drawer {requestId}</div> : null) }));

import { RenewalListTags, RenewalReviewPanel, isRenewalChanged, renewalChangeLabel, type RenewalReviewFields } from '../RenewalReviewPanel';

const changed: RenewalReviewFields = {
  id: 'req-2', registration_type: 'renewal', rent_amount: 450000, duration_days: 60,
  renewal_previous_rent: 300000, renewal_previous_days: 30,
  renewal_advice_snapshot: {
    prev_request_id: 'prev-1', chosen_days: 60, suggested_max_rent: 360000, computed_at: '2026-10-14T10:00:00Z',
    reasons: ['92% of due days were paid on time.', 'That is band A.', 'Suggested maximum rent. This is advice only.'],
  },
  renewal_above_suggestion: true, renewal_above_by: 90000,
  renewal_change_reason_code: 'landlord_raised', renewal_change_explanation: 'The landlord raised the rent from next month.',
  renewal_evidence_url: 'https://x.test/note.webp',
};

beforeEach(() => {
  rpcMock.mockReset(); fromMock.mockClear(); notesRows = []; roles = ['tenant_ops'];
  rpcMock.mockResolvedValue({ data: 'note-1', error: null });
});

describe('renewal helpers', () => {
  it('a renewal is changed only when the server filled the previous figures', () => {
    expect(isRenewalChanged(changed)).toBe(true);
    expect(isRenewalChanged({ registration_type: 'renewal', renewal_previous_rent: null, renewal_previous_days: null })).toBe(false);
    expect(isRenewalChanged({ registration_type: 'new', renewal_previous_rent: 1, renewal_previous_days: 30 })).toBe(false);
  });
  it('labels rent, days, or both', () => {
    expect(renewalChangeLabel(changed)).toBe('Renewal — rent and days changed');
    expect(renewalChangeLabel({ ...changed, duration_days: 30 })).toBe('Renewal — rent changed');
    expect(renewalChangeLabel({ ...changed, rent_amount: 300000 })).toBe('Renewal — days changed');
  });
});

describe('RenewalListTags', () => {
  it('shows the change badge with the percent, and the amber tag when above the suggestion', () => {
    render(<RenewalListTags request={changed} />);
    expect(screen.getByText(/Renewal — rent and days changed \(\+50%\)/)).toBeInTheDocument();
    expect(screen.getByText(/Above suggestion by UGX\s90,000/)).toBeInTheDocument();
  });
  it('shows no amber tag when the rent was within the suggestion, and nothing for an unchanged renewal', () => {
    const { rerender, container } = render(<RenewalListTags request={{ ...changed, renewal_above_suggestion: false }} />);
    expect(screen.queryByText(/Above suggestion/)).not.toBeInTheDocument();
    rerender(<RenewalListTags request={{ id: 'x', registration_type: 'renewal', rent_amount: 1, duration_days: 30 }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('RenewalReviewPanel', () => {
  it('shows what changed, the advice as it was, the reason and explanation, the evidence, and the link to the previous plan', async () => {
    render(<RenewalReviewPanel request={changed} />);
    expect(screen.getByText('Renewal — rent and days changed')).toBeInTheDocument();
    expect(screen.getByText(/UGX\s300,000/)).toBeInTheDocument();
    expect(screen.getByText('(+50%)')).toBeInTheDocument();
    expect(screen.getByText(/Advice at renewal: suggested up to UGX\s360,000/)).toBeInTheDocument();
    expect(screen.getByText('92% of due days were paid on time.')).toBeInTheDocument();
    expect(screen.getByText('Landlord raised rent')).toBeInTheDocument();
    expect(screen.getByText('The landlord raised the rent from next month.')).toBeInTheDocument();
    expect(screen.getByAltText('Landlord note')).toHaveAttribute('src', 'https://x.test/note.webp');
    await userEvent.click(screen.getByRole('button', { name: /View previous plan/ }));
    expect(await screen.findByText('previous plan drawer prev-1')).toBeInTheDocument();
  });

  it('renders nothing for a request that is not a renewal', () => {
    const { container } = render(<RenewalReviewPanel request={{ ...changed, registration_type: 'new' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a same-rent renewal shows no change details but still carries the notes thread', async () => {
    render(<RenewalReviewPanel request={{ id: 'req-3', registration_type: 'renewal', rent_amount: 300000, duration_days: 30 }} />);
    expect(screen.getByText('Renewal — same rent and days')).toBeInTheDocument();
    expect(screen.queryByText(/Advice at renewal/)).not.toBeInTheDocument();
    expect(await screen.findByText('No notes yet.')).toBeInTheDocument();
  });

  it('lists the notes with author and role, and adds a note of 10+ characters through the RPC', async () => {
    notesRows = [{ id: 'n1', request_id: 'req-2', author: 'u-1', author_role: 'agent_ops', stage: 'pending', note: 'Called the landlord, rent confirmed.', created_at: '2026-10-14T09:00:00Z' }];
    render(<RenewalReviewPanel request={changed} />);
    expect(await screen.findByText('Called the landlord, rent confirmed.')).toBeInTheDocument();
    expect(screen.getByText(/Joy Ops · Agent Ops/)).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('Add a note for the next reviewers'), 'short');
    await userEvent.click(screen.getByRole('button', { name: /Add note/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A note needs at least 10 characters.');
    expect(rpcMock).not.toHaveBeenCalled();
    await userEvent.type(screen.getByPlaceholderText('Add a note for the next reviewers'), ' and now long enough');
    await userEvent.click(screen.getByRole('button', { name: /Add note/ }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('add_rent_request_review_note', { p_request_id: 'req-2', p_note: 'short and now long enough' }));
  });

  it('does not offer the add-note box to someone who is not a reviewer, and says why when the database refuses', async () => {
    roles = ['agent'];
    const { unmount } = render(<RenewalReviewPanel request={changed} />);
    await screen.findByText('No notes yet.');
    expect(screen.queryByPlaceholderText('Add a note for the next reviewers')).not.toBeInTheDocument();
    unmount();
    roles = ['cfo'];
    rpcMock.mockResolvedValue({ data: null, error: { message: 'NOT_A_REVIEWER: nope' } });
    render(<RenewalReviewPanel request={changed} />);
    await userEvent.type(await screen.findByPlaceholderText('Add a note for the next reviewers'), 'A long enough note here');
    await userEvent.click(screen.getByRole('button', { name: /Add note/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only reviewers can add a note to a request.');
  });
});
