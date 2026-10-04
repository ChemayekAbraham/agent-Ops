import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { ShieldAlert, Phone } from 'lucide-react';
import WelileLogo from '@/components/WelileLogo';
import { Button } from '@/components/ui/button';
import { useEffect } from 'react';
import { loginTelemetry as lt } from '@/lib/loginTelemetry';

interface ListingBlock {
  blocked?: boolean;
  blocked_until?: string;
  reason?: string;
  freeze_scope?: string;
}

/**
 * Account-wide freeze gate. Renders a full-screen "Account Restricted" overlay
 * on every dashboard (agent, tenant, landlord, partner, staff, etc.) when the
 * signed-in user is frozen via either:
 *   - `profiles.is_frozen = true` (set from Platform Users / KYC / Manager tools), OR
 *   - the CTO Agent Freeze panel with scope = 'all' (get_my_listing_block RPC).
 *
 * Mounted once inside AuthProvider so it applies to the entire authenticated app.
 */
export function AccountFrozenGate({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  const { data: profileFreeze } = useQuery({
    queryKey: ['account-frozen-profile', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('is_frozen, frozen_reason')
        .eq('id', user!.id)
        .maybeSingle();
      if (error) throw error;
      return data as { is_frozen: boolean | null; frozen_reason: string | null } | null;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const { data: listingBlock } = useQuery({
    queryKey: ['account-frozen-listing-block', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc('get_my_listing_block');
      if (error) return { blocked: false } as ListingBlock;
      return (data as ListingBlock) ?? { blocked: false };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const profileFrozen = !!profileFreeze?.is_frozen;
  const listingFrozen = !!listingBlock?.blocked && listingBlock?.freeze_scope === 'all';
  const frozen = !!user && (profileFrozen || listingFrozen);

  useEffect(() => {
    if (!user?.id) return;
    lt.mark('gate.account_frozen.check', {
      profileFrozen,
      listingFrozen,
    }, frozen ? 'frozen' : 'ok');
  }, [user?.id, profileFrozen, listingFrozen, frozen]);

  if (!frozen) return <>{children}</>;

  const reason =
    (profileFreeze?.frozen_reason && profileFreeze.frozen_reason.trim()) ||
    (listingBlock?.reason && listingBlock.reason.trim()) ||
    null;

  return (
    <div
      role="alert"
      className="fixed inset-0 z-[10000] flex flex-col items-center justify-center overflow-y-auto bg-background p-4 sm:p-6"
    >
      <div className="w-full max-w-lg mx-auto rounded-2xl border border-border bg-card p-6 sm:p-8 shadow-xl">
        <div className="flex justify-center mb-6">
          <WelileLogo size="lg" linkToHome={false} />
        </div>

        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
          <ShieldAlert className="h-7 w-7 text-destructive" />
        </div>

        <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">
          Account suspended
        </h1>
        <p className="mt-3 text-center text-sm leading-relaxed text-muted-foreground">
          Access to your Welile account has been temporarily suspended pending review.
          If you believe this is an error, please contact our support team and we will
          review your case as quickly as possible.
        </p>

        {reason && (
          <div className="mt-5 rounded-lg border border-border bg-muted/40 p-3 text-left">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Reason
            </p>
            <p className="mt-1 text-sm font-medium text-foreground">{reason}</p>
          </div>
        )}

        <div className="mt-6 flex flex-col gap-2">
          <Button
            variant="default"
            className="w-full"
            onClick={() => window.open('tel:+256777607640', '_self')}
          >
            <Phone className="mr-2 h-4 w-4" />
            Contact support: +256 777 607 640
          </Button>
        </div>
      </div>
    </div>
  );
}

export default AccountFrozenGate;