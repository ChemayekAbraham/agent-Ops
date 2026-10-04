import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// --- Mock the location gate so we can drive its "Do it later" action ---
// The real gate renders GPS capture UI; for this test we only care that
// tapping "Do it later" invokes `onCancel`, which the dialog uses to set
// `locationSkipped` and proceed to the allocation form.
vi.mock('./AgentContactLocationGate', () => ({
  __esModule: true,
  default: ({ onCancel }: { onCancel?: () => void }) => (
    <div>
      <span>location-gate</span>
      <button onClick={() => onCancel?.()}>Do it later</button>
    </div>
  ),
}));

// Force the gate to be required so the dialog starts on the gate screen.
vi.mock('@/hooks/useRequireContactLocation', () => ({
  useRequireContactLocation: () => ({
    needsCapture: true,
    targetId: 'tenant-1',
    targetRole: 'tenant',
    targetName: 'Test Tenant',
    gateOpen: false,
    openGate: vi.fn(),
    closeGate: vi.fn(),
    onCaptured: vi.fn(),
    requireLocation: (fn: () => void) => fn(),
  }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'agent-1' } }),
}));

vi.mock('@/hooks/useAgentBalances', () => ({
  useAgentBalances: () => ({ floatBalance: 500000, refetch: vi.fn() }),
}));

vi.mock('@/hooks/useCreditAccessLimit', () => ({
  useCreditAccessLimit: () => ({ limit: { totalLimit: 1000000 } }),
  invalidateCreditAccessLimit: vi.fn(),
  formatCreditAmount: (n: number) => `UGX ${n}`,
}));

vi.mock('@/contexts/OfflineContext', () => ({
  useOffline: () => ({ isOnline: true }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: vi.fn(),
    functions: { invoke: vi.fn() },
    from: vi.fn(),
  },
}));

vi.mock('@/lib/criticalFlowGuard', () => ({
  setCriticalFlowActive: vi.fn(),
}));

vi.mock('@/lib/offlineCollectionDrafts', () => ({
  captureOfflineDraft: vi.fn(),
}));

vi.mock('./CommissionCelebration', () => ({
  CommissionCelebration: () => null,
}));

import { AgentTenantCollectDialog } from './AgentTenantCollectDialog';

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AgentTenantCollectDialog
        open
        onOpenChange={vi.fn()}
        tenant={{ id: 'tenant-1', full_name: 'Test Tenant', phone: '0700000000' }}
        rentRequestId="rent-1"
        outstandingBalance={300000}
      />
    </QueryClientProvider>,
  );
}

describe('AgentTenantCollectDialog — "Do it later" location skip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the location gate first, not the allocation form', () => {
    renderDialog();
    expect(screen.getByText('location-gate')).toBeInTheDocument();
    expect(screen.queryByText('Pay for Test Tenant')).not.toBeInTheDocument();
  });

  it('continues to the allocation form when "Do it later" is tapped', () => {
    renderDialog();

    fireEvent.click(screen.getByText('Do it later'));

    // The allocation form is now shown (dialog title for the entry step) and
    // the gate is gone — allocation is NOT blocked by skipping location.
    expect(screen.getByText('Pay for Test Tenant')).toBeInTheDocument();
    expect(screen.queryByText('location-gate')).not.toBeInTheDocument();
  });
});