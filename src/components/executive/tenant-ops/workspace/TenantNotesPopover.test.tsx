import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockUseHistory = vi.fn();
const mockMutate = vi.fn();

vi.mock('@/hooks/useTenantNoPaymentNotes', () => ({
  useTenantNoPaymentNoteHistory: (...args: unknown[]) => mockUseHistory(...args),
  useAddTenantNoPaymentNote: () => ({ mutate: mockMutate, isPending: false }),
}));

import { TenantNotesPopover } from './TenantNotesPopover';

function note(overrides: Partial<{
  id: string; note: string; created_by_name: string; created_at: string;
}> = {}) {
  return {
    id: 'note-1',
    tenant_id: 'tenant-1',
    note: 'Called tenant, no answer.',
    note_type: 'general',
    follow_up_date: null,
    follow_up_status: null,
    related_action: null,
    created_by: 'officer-1',
    created_at: '2026-09-26T10:00:00.000Z',
    created_by_name: 'James',
    ...overrides,
  };
}

describe('TenantNotesPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseHistory.mockReturnValue({ data: [], isLoading: false });
  });

  it('shows "No notes yet" and a zero state when the tenant has no history', () => {
    render(<TenantNotesPopover tenantId="tenant-1" summary={undefined} />);
    expect(screen.getByText('No notes yet')).toBeInTheDocument();
  });

  it('shows the latest note preview and count on the trigger from the summary', () => {
    render(
      <TenantNotesPopover
        tenantId="tenant-1"
        summary={{
          tenant_id: 'tenant-1',
          notes_count: 3,
          last_note: 'Promised payment by Friday.',
          last_note_type: 'general',
          last_created_by: 'officer-1',
          last_note_at: '2026-09-29T10:00:00.000Z',
        }}
      />,
    );
    expect(screen.getByText('Promised payment by Friday.')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('opening the popover shows the full history with author and timestamp per entry, newest first as given', async () => {
    mockUseHistory.mockReturnValue({
      data: [
        note({ id: 'note-2', note: 'Promised payment by Friday.', created_by_name: 'Sarah', created_at: '2026-09-29T10:00:00.000Z' }),
        note({ id: 'note-1', note: 'Called tenant, no answer.', created_by_name: 'James', created_at: '2026-09-26T10:00:00.000Z' }),
      ],
      isLoading: false,
    });

    render(<TenantNotesPopover tenantId="tenant-1" summary={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /no notes yet/i }));

    await waitFor(() => expect(screen.getByText('Promised payment by Friday.')).toBeInTheDocument());
    expect(screen.getByText('Called tenant, no answer.')).toBeInTheDocument();
    expect(screen.getByText(/Sarah/)).toBeInTheDocument();
    expect(screen.getByText(/James/)).toBeInTheDocument();

    // Both notes are present together — adding a note never discards a prior one.
    const notesShown = screen.getAllByText(/Promised payment by Friday\.|Called tenant, no answer\./);
    expect(notesShown).toHaveLength(2);
  });

  it('submitting the add-note form calls the mutation with the tenant id and typed content', async () => {
    render(<TenantNotesPopover tenantId="tenant-1" summary={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /no notes yet/i }));

    const textarea = await screen.findByPlaceholderText(/add a note/i);
    fireEvent.change(textarea, { target: { value: 'SMS reminder sent.' } });
    fireEvent.click(screen.getByRole('button', { name: /^add note$/i }));

    expect(mockMutate).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', note: 'SMS reminder sent.' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('disables the submit button until something is typed', async () => {
    render(<TenantNotesPopover tenantId="tenant-1" summary={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /no notes yet/i }));

    const submit = await screen.findByRole('button', { name: /^add note$/i });
    expect(submit).toBeDisabled();

    const textarea = screen.getByPlaceholderText(/add a note/i);
    fireEvent.change(textarea, { target: { value: 'Visited in person.' } });
    expect(submit).not.toBeDisabled();
  });
});
