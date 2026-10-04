/**
 * Promissory note: partner name captured in parts, inserted as one string.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const insertSpy = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getUser: async () => ({ data: { user: { id: 'agent-1' } } }) },
    from: () => ({
      insert: (payload: any) => {
        insertSpy(payload);
        return { select: () => ({ single: async () => ({ data: { id: 'n1', ...payload }, error: null }) }) };
      },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PromissoryNoteDialog } from '@/components/agent/PromissoryNoteDialog';

const fill = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('PromissoryNoteDialog — partner name', () => {
  beforeEach(() => insertSpy.mockClear());

  it('inserts the concatenated partner name', async () => {
    render(<PromissoryNoteDialog open onOpenChange={() => {}} />);
    fill(/First name/i, 'John');
    fill(/Other names/i, 'Ssalongo');
    fill(/Last name/i, 'Mukasa');
    fireEvent.change(screen.getAllByPlaceholderText('0780000000')[0], { target: { value: '0780000000' } });
    fireEvent.change(screen.getByPlaceholderText(/e.g. 500000/i), { target: { value: '500000' } });
    fireEvent.click(screen.getByRole('button', { name: /Create/i }));
    await waitFor(() => expect(insertSpy).toHaveBeenCalled());
    expect(insertSpy.mock.calls[0][0].partner_name).toBe('John Ssalongo Mukasa');
  });

  it('blocks submission when the first name is blank', () => {
    render(<PromissoryNoteDialog open onOpenChange={() => {}} />);
    fill(/Last name/i, 'Mukasa');
    fireEvent.change(screen.getAllByPlaceholderText('0780000000')[0], { target: { value: '0780000000' } });
    fireEvent.change(screen.getByPlaceholderText(/e.g. 500000/i), { target: { value: '500000' } });
    expect(screen.getByRole('button', { name: /Create/i })).toBeDisabled();
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
