/**
 * NameCompletionGate — consolidated split-name capture.
 * Asserts hydration from the stored single string, the join on save,
 * blocked save with a blank last name, and no write on mount.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const updateSpy = vi.fn().mockResolvedValue({ error: null });
const storedName = { value: '' };

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/loginTelemetry', () => ({
  loginTelemetry: { start: () => () => {} },
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { full_name: storedName.value }, error: null }) }) }),
      update: (patch: any) => { updateSpy(patch); return { eq: async () => ({ error: null }) }; },
    }),
  },
}));

async function renderGate(full_name: string) {
  storedName.value = full_name;
  const Gate = (await import('@/components/notifications/NameCompletionGate')).default;
  render(<Gate />);
  await waitFor(() => expect(screen.getByLabelText(/First name/i)).toBeInTheDocument());
}

beforeEach(() => {
  updateSpy.mockClear();
  vi.resetModules();
  try { localStorage.clear(); } catch { /* noop */ }
});

describe('NameCompletionGate', () => {
  it('hydrates a 1-token stored name into first name only, without writing on mount', async () => {
    await renderGate('jd');
    expect((screen.getByLabelText(/First name/i) as HTMLInputElement).value).toBe('jd');
    expect((screen.getByLabelText(/Last name/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/Other names/i) as HTMLInputElement).value).toBe('');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('hydrates a 3-token stored name as first + other + last', async () => {
    await renderGate('hshseh q zz');
    expect((screen.getByLabelText(/First name/i) as HTMLInputElement).value).toBe('hshseh');
    expect((screen.getByLabelText(/Other names/i) as HTMLInputElement).value).toBe('q');
    expect((screen.getByLabelText(/Last name/i) as HTMLInputElement).value).toBe('zz');
  });

  it('saves the normalised joined string including other names', async () => {
    await renderGate('jd');
    fireEvent.change(screen.getByLabelText(/First name/i), { target: { value: '  Timothy ' } });
    fireEvent.change(screen.getByLabelText(/Other names/i), { target: { value: 'Christian' } });
    fireEvent.change(screen.getByLabelText(/Last name/i), { target: { value: 'Waniaye' } });
    fireEvent.click(screen.getByRole('button', { name: /Save my full name/i }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith({ full_name: 'Timothy Christian Waniaye' }));
  });

  it('blocks save when the last name is blank', async () => {
    const { toast } = await import('sonner');
    await renderGate('jd');
    fireEvent.change(screen.getByLabelText(/First name/i), { target: { value: 'Timothy' } });
    fireEvent.click(screen.getByRole('button', { name: /Save my full name/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
