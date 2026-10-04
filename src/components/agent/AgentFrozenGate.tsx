import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ShieldAlert, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ListingBlock {
  blocked?: boolean;
  blocked_until?: string;
  reason?: string;
  freeze_scope?: string;
}

/**
 * Full-screen gate shown when the signed-in agent is under a FULL account freeze
 * (freeze_scope === 'all'). While frozen, NO agent activities are available in the
 * UI. Server-side triggers enforce the same rule on every agent write table.
 */
export function AgentFrozenGate({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: ['my-listing-block-gate'],
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc('get_my_listing_block');
      if (error) throw error;
      return (data as ListingBlock) ?? { blocked: false };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const frozen = !!data?.blocked && data?.freeze_scope === 'all';

  if (isLoading || !frozen) {
    return <>{children}</>;
  }

  const until = data?.blocked_until ? new Date(data.blocked_until) : null;
  const untilStr = until
    ? until.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'Africa/Kampala',
      })
    : null;

  return (
    <div
      role="alert"
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center overflow-y-auto bg-red-700 p-6 text-center text-white"
    >
      <div className="w-full max-w-lg rounded-2xl border border-white/30 bg-red-800/60 p-6 sm:p-8 shadow-2xl backdrop-blur-sm">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-white/15">
          <ShieldAlert className="h-9 w-9 text-white" />
        </div>
        <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
          Account Restricted
        </h1>

        <div className="mt-5 space-y-4 text-sm sm:text-[15px] leading-relaxed text-white/95 text-left">
          <p>
            Your account has been restricted due to suspected activity that may violate
            our Terms and Conditions or applicable laws. As a result, access to your
            account and its services has been suspended pending review.
          </p>
          <p>
            If investigations confirm fraudulent, unauthorized, or other unlawful
            activities, the matter may be referred to the relevant law enforcement
            authorities. Such conduct may result in civil or criminal penalties,
            including fines or imprisonment, where provided for under applicable law.
          </p>
          <p>
            If you believe this restriction was made in error, please contact our
            support team to request a review.
          </p>
        </div>

        {untilStr && (
          <p className="mt-5 text-sm">
            <span className="text-white/80">Restricted until </span>
            <span className="font-semibold">{untilStr}</span>
          </p>
        )}

        {data?.reason && (
          <div className="mt-4 rounded-lg border border-white/25 bg-white/10 p-3 text-left">
            <p className="text-xs font-medium uppercase tracking-wide text-white/70">Reason</p>
            <p className="mt-1 text-sm font-medium text-white">{data.reason}</p>
          </div>
        )}

        <Button
          variant="outline"
          className="mt-6 w-full border-white/40 bg-card text-red-700 hover:bg-white/90 hover:text-red-800"
          onClick={() => window.open('tel:+256777607640', '_self')}
        >
          <Phone className="mr-2 h-4 w-4" />
          Contact support: +256 777 607 640
        </Button>
      </div>
    </div>
  );
}

export default AgentFrozenGate;