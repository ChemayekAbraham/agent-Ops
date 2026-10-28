import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RDDashboard from '@/pages/rd/Dashboard';
import { RD_UPDATES_KEY, rdNewUpdateDate } from '@/lib/rdWeeklyUpdates';

vi.mock('@/pages/rd/IdeaCanvasBoard', () => ({ default: () => null }));
vi.mock('@/components/WelileLogo', () => ({ default: () => null }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/rdGeneralReportPdf', () => ({ downloadRdGeneralReport: vi.fn() }));
vi.mock('@/lib/rdPeriodReportPdf', () => ({ downloadRdPeriodReport: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn() } }));

describe('R&D period recording', () => {
  beforeEach(() => { cleanup(); localStorage.clear(); });
  for (const [label, period] of [['Last 7 days', 'last'], ['Next 7 days', 'next']] as const) {
    it(`opens recording for ${label} and saves to the existing record`, () => {
      render(<MemoryRouter><RDDashboard /></MemoryRouter>);
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByLabelText('Update date')).toHaveValue(rdNewUpdateDate(period));
      expect(localStorage.getItem(RD_UPDATES_KEY)).toBeNull();
      fireEvent.change(screen.getByLabelText('Recorded update'), { target: { value: 'Called the project partner' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save update' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      const saved = JSON.parse(localStorage.getItem(RD_UPDATES_KEY) ?? '{}');
      expect(saved['Welile Car']).toEqual([{ id: expect.any(String), date: rdNewUpdateDate(period), text: 'Called the project partner' }]);
      expect(screen.getByDisplayValue('Called the project partner')).toBeInTheDocument();
    });
  }
});