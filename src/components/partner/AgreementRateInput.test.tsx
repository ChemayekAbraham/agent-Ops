import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AgreementRateInput from './AgreementRateInput';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), toast: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

describe('agreement Returns rate workflow', () => {
  beforeEach(() => vi.clearAllMocks());
  const portfolios = [{ id: 'portfolio-1', portfolio_code: 'WIP-1', roi_percentage: 15 }];
  it('sends the selected rate through the existing server workflow', async () => {
    mocks.rpc.mockResolvedValue({ data: { rate_in_force: 20, awaits_cfo: false }, error: null });
    const saved = vi.fn();
    render(<AgreementRateInput portfolios={portfolios} onRateSaved={saved} />);
    fireEvent.change(screen.getByLabelText('Monthly Returns rate (%)'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(20));
    expect(mocks.rpc).toHaveBeenCalledWith('set_portfolio_renewal_rate', { p_portfolio_id: 'portfolio-1', p_requested_rate: 20 });
  });
  it('keeps the active rate when the request awaits CFO approval', async () => {
    mocks.rpc.mockResolvedValue({ data: { rate_in_force: 15, awaits_cfo: true }, error: null });
    const saved = vi.fn();
    render(<AgreementRateInput portfolios={portfolios} onRateSaved={saved} />);
    fireEvent.change(screen.getByLabelText('Monthly Returns rate (%)'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(15));
    expect(saved).not.toHaveBeenCalledWith(20);
  });
  it('does not save a rate outside the server range', () => {
    render(<AgreementRateInput portfolios={portfolios} onRateSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Monthly Returns rate (%)'), { target: { value: '101' } });
    expect(screen.getByRole('button', { name: 'Save rate' })).toBeDisabled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});