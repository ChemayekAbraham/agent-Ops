import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn(), invoke: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: mocks.from, functions: { invoke: mocks.invoke } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null, loading: true }) }));
import PortfolioInviteTest from '@/pages/PortfolioInviteTest';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,test');
});

it('allows a signed-out test submission without reading or writing live portfolio data', async () => {
  render(<MemoryRouter><PortfolioInviteTest /></MemoryRouter>);
  await screen.findByRole('button', { name: 'Submit test' });
  fireEvent.change(screen.getByLabelText('National ID / Passport number'), { target: { value: 'TEST123456' } });
  fireEvent.change(screen.getByLabelText('Residential address'), { target: { value: 'Test address' } });
  fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Test Kin' } });
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '0700000000' } });
  fireEvent.change(screen.getByLabelText('Mobile money number'), { target: { value: '0700000000' } });
  fireEvent.change(screen.getByLabelText('Name on mobile money (as it appears when we send)'), { target: { value: 'Test Supporter' } });
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('Signature canvas missing');
  canvas.setPointerCapture = vi.fn();
  fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
  fireEvent.click(screen.getByRole('button', { name: 'Submit test' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Test submission complete' })).toBeInTheDocument());
  expect(mocks.from).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalled();
});