import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { FunderUiV3PreviewState } from './useFunderUiV3Preview';

let previewState: FunderUiV3PreviewState = { on: false, resolved: false };

vi.mock('./useFunderUiV3Preview', () => ({
  useFunderUiV3PreviewState: () => previewState,
}));

vi.mock('@/lib/lazyWithRetry', () => ({
  lazyWithRetry: (loader: () => Promise<unknown>) => {
    const name = String(loader).includes('SupporterDashboard') ? 'old' : 'v3';
    return () => <div data-testid={`dash-${name}`} />;
  },
}));

import FunderDashboardGate from './FunderDashboardGate';

function renderAt(path: string) {
  // The gate's props are passed straight through; the stubs ignore them.
  const props = { user: { id: 'u1' } } as unknown as Parameters<typeof FunderDashboardGate>[0];
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard/funder" element={<><span data-testid="at-funder" /><FunderDashboardGate {...props} /></>} />
        <Route path="/dashboard/funder-v3" element={<FunderDashboardGate {...props} forceV3 />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('FunderDashboardGate', () => {
  beforeEach(() => {
    previewState = { on: false, resolved: false };
  });

  it('/dashboard/funder: live dashboard unless the switch is on', () => {
    previewState = { on: false, resolved: true };
    renderAt('/dashboard/funder');
    expect(screen.getByTestId('dash-old')).toBeTruthy();
  });

  it('/dashboard/funder: V3 with the switch on', () => {
    previewState = { on: true, resolved: true };
    renderAt('/dashboard/funder');
    expect(screen.getByTestId('dash-v3')).toBeTruthy();
  });

  it('/dashboard/funder-v3: waits for the switch read, renders nothing', () => {
    renderAt('/dashboard/funder-v3');
    expect(screen.queryByTestId('dash-old')).toBeNull();
    expect(screen.queryByTestId('dash-v3')).toBeNull();
    expect(screen.queryByTestId('at-funder')).toBeNull();
  });

  it('/dashboard/funder-v3: without the switch goes to /dashboard/funder', () => {
    previewState = { on: false, resolved: true };
    renderAt('/dashboard/funder-v3');
    expect(screen.getByTestId('at-funder')).toBeTruthy();
    expect(screen.getByTestId('dash-old')).toBeTruthy();
  });

  it('/dashboard/funder-v3: V3 with the switch on', () => {
    previewState = { on: true, resolved: true };
    renderAt('/dashboard/funder-v3');
    expect(screen.getByTestId('dash-v3')).toBeTruthy();
  });
});
