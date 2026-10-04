import { useEffect, useState } from 'react';
import { Loader2, ShieldAlert, ShieldCheck, Wallet } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

/**
 * CTO-only "wallet ops maintenance" switch.
 *
 * Flips `treasury_controls.withdrawals_paused` — which our shared
 * `treasuryGuard.ts` enforces for BOTH `wallet-transfer` and
 * `approve-withdrawal` edge functions. Rent collections
 * (`agent-allocate-tenant-payment`) and rent-request creation do NOT go
 * through the guard, so agents can keep collecting and posting rent
 * requests while wallet transfers / withdrawals are frozen.
 */
export default function WalletOpsMaintenanceCard() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('treasury_controls')
      .select('enabled, updated_at')
      .eq('control_key', 'withdrawals_paused')
      .maybeSingle();
    setActive(!!data?.enabled);
    setUpdatedAt((data as any)?.updated_at ?? null);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const setPaused = async (next: boolean) => {
    setBusy(true);
    const { error } = await supabase
      .from('treasury_controls')
      .update({ enabled: next, updated_at: new Date().toISOString() })
      .eq('control_key', 'withdrawals_paused');
    if (error) {
      toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    } else {
      // Wallet ops maintenance is a scoped freeze — wallet transfers and
      // withdrawals only. It must NEVER coexist with the platform-wide
      // maintenance lock, which would block agents from collecting rent or
      // posting rent requests. Turning wallet ops maintenance ON forces the
      // platform lock OFF so users keep full access to everything else.
      if (next) {
        await supabase
          .from('treasury_controls')
          .update({ enabled: false, updated_at: new Date().toISOString() })
          .eq('control_key', 'maintenance_mode');
      }
      await load();
      toast({
        title: next ? 'Wallet ops FROZEN' : 'Wallet ops resumed',
        description: next
          ? 'Wallet transfers and withdrawals are blocked platform-wide. Platform maintenance banner turned OFF so agents keep collecting rent and posting rent requests.'
          : 'Wallet transfers and withdrawals are live again.',
      });
    }
    setBusy(false);
  };

  return (
    <div
      className={`rounded-2xl border-2 p-4 sm:p-5 ${
        active
          ? 'border-destructive/60 bg-destructive/5'
          : 'border-border bg-card'
      }`}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            {active ? (
              <ShieldAlert className="h-4 w-4 text-destructive" />
            ) : (
              <ShieldCheck className="h-4 w-4 text-green-600" />
            )}
            Wallet Ops Maintenance
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Freezes wallet transfers and withdrawals platform-wide while agents
            keep collecting rent and posting rent requests.
          </p>
        </div>
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${
            active
              ? 'bg-destructive/10 text-destructive'
              : 'bg-green-500/10 text-green-600'
          }`}
        >
          {loading ? '…' : active ? 'FROZEN' : 'LIVE'}
        </span>
      </div>

      <div className="rounded-lg bg-background/60 border border-border/60 p-3 mb-3 text-xs space-y-1">
        <div className="flex items-start gap-2">
          <ShieldAlert className="h-3.5 w-3.5 mt-0.5 text-destructive shrink-0" />
          <span>
            <strong>Blocked while active:</strong> wallet-to-wallet transfers,
            withdrawals to mobile money / bank, ROI cash-outs, partner
            wallet moves.
          </span>
        </div>
        <div className="flex items-start gap-2">
          <Wallet className="h-3.5 w-3.5 mt-0.5 text-green-600 shrink-0" />
          <span>
            <strong>Still working:</strong> agents collecting rent from
            tenants, posting new rent requests, tenant deposits, landlord
            registration.
          </span>
        </div>
      </div>

      {updatedAt && (
        <p className="text-[10px] text-muted-foreground mb-2">
          Last changed {new Date(updatedAt).toLocaleString()}
        </p>
      )}

      <div className="flex gap-2 flex-wrap">
        <Button
          variant={active ? 'outline' : 'destructive'}
          size="sm"
          disabled={busy || loading || active}
          onClick={() => void setPaused(true)}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1" />
          ) : (
            <ShieldAlert className="h-4 w-4 mr-1" />
          )}
          Freeze wallet ops for maintenance
        </Button>
        <Button
          variant="default"
          size="sm"
          disabled={busy || loading || !active}
          onClick={() => void setPaused(false)}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1" />
          ) : (
            <ShieldCheck className="h-4 w-4 mr-1" />
          )}
          Resume wallet ops
        </Button>
      </div>
    </div>
  );
}