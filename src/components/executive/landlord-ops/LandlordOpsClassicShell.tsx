import { useEffect } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

/**
 * Compatibility redirect for the retired `?view=` Landlord Ops shell.
 *
 * Landlord Ops is now a layout route with one URL per destination
 * (`/landlord-ops/verify/houses`, …) — see `src/pages/landlord-ops/`. This
 * component only exists so the Executive Hub tab and every old
 * `…?view=<key>` bookmark land on the equivalent new route instead of a shell
 * whose sidebar keys no longer match anything it can render.
 *
 * Nine destinations were folded away in the rebuild; those keys map to the
 * closest surviving destination, and anything unrecognised goes to Today.
 */
const VIEW_TO_PATH: Record<string, string> = {
  home: '',
  today: '',

  // Verify
  verify: 'verify/houses',
  'agent-verify-requests': 'verify/landlords',
  'residence-verify': 'verify/landlords',
  'lc1-inbox': 'verify/lc1',
  'lc1-requests': 'verify/lc1',

  // Pipeline
  'rent-pipeline-queue': 'pipeline/rent-requests',
  'rejected-queue': 'pipeline/rent-requests',
  pipeline: 'pipeline/rent-requests',
  'advance-requests': 'pipeline/advances',

  // Payouts
  'payout-review': 'payouts/review',
  'landlords-paid': 'payouts/paid',
  'agent-landlord-float': 'payouts/float',

  // Fix-ups
  chain: 'fixups/chain-health',
  'lc1-duplicates': 'fixups/lc1-duplicates',
  locations: 'fixups/locations',
  'no-landlord': 'fixups/no-landlord',
  matching: 'fixups/matching',

  // Registers
  landlords: 'registers/landlords',
  'landlords-tenants': 'registers/houses-tenants',
  'houses-by-landlord': 'registers/houses-tenants',
  'all-requests': 'registers/requests',
  lc1: 'registers/lc1',

  // Across everything
  'calling-hub': 'calling',
  calling: 'calling',
  cities: 'coverage',
  empty: 'coverage',
  occupied: 'coverage',
  coverage: 'coverage',
  'agent-capacity': 'agent-capacity',
  agents: 'agent-capacity',
  'service-centres': 'service-centres',
  reports: 'reports',
  analytics: 'reports',
};

export function LandlordOpsDashboardShell() {
  const [params] = useSearchParams();
  const raw = (params.get('view') || '').toLowerCase();

  // A new-style path already in `?view=` (e.g. `verify/houses`) passes through.
  const target = raw.includes('/') ? raw : VIEW_TO_PATH[raw] ?? '';

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);

  return (
    <>
      <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Opening Landlord Operations…
      </div>
      <Navigate to={`/landlord-ops${target ? `/${target}` : ''}`} replace />
    </>
  );
}
