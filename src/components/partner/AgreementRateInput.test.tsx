import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AgreementRateInput from './AgreementRateInput';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), toast: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

describe('agreement Returns rate workflow', () => {
  beforeEach(() => vi.clearAllMocks());
  const portfolios = [{ id: 'portfolio-1', portfolio_code: 'WIP-1', roi_percentage: 15 }];
  it('updates the draft contract rate while typing, without saving or counter-signing', () => {
    const preview = vi.fn();
    render(<AgreementRateInput portfolios={portfolios} onRateSaved={vi.fn()} onRatePreview={preview} />);
    fireEvent.change(screen.getByLabelText('Monthly Returns rate (%)'), { target: { value: '20' } });
    expect(preview).toHaveBeenCalledWith(20, true);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('allows drafting a rate before a portfolio exists', () => {
    const preview = vi.fn();
    render(<AgreementRateInput portfolios={[]} initialRate={15} onRateSaved={vi.fn()} onRatePreview={preview} />);
    fireEvent.change(screen.getByLabelText('Monthly Returns rate (%)'), { target: { value: '12' } });
    expect(preview).toHaveBeenCalledWith(12, true);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('previews every valid typed rate without writing actual Returns', () => {
    const preview = vi.fn();
    render(<AgreementRateInput portfolios={portfolios} onRateSaved={vi.fn()} onRatePreview={preview} />);
    const input = screen.getByLabelText('Monthly Returns rate (%)');
    for (const value of ['2', '20', '20.5']) {
      fireEvent.change(input, { target: { value } });
    }
    expect(preview.mock.calls).toEqual([[2, true], [20, true], [20.5, true]]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
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