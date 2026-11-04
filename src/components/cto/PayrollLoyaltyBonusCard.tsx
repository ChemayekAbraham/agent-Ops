import { useEffect, useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';

/**
 * The daily 0.5% payroll loyalty bonus switch. Everyone in the executive team can see it; only the owner can flip it.
 * The database enforces that (set_payroll_loyalty_bonus + a trigger on treasury_controls), so this card only mirrors it:
 * `can_change` comes from the server, never from the client.
 */
interface Status {
  enabled: boolean;
  can_change: boolean;
  updated_at: string | null;
  updated_by: string | null;
  people_paid: number;
  total_paid: number;
  active_people: number;
  active_balance: number;
}

const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString('en-UG')}`;

export default function PayrollLoyaltyBonusCard() {
  const { toast } = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_payroll_loyalty_bonus_status' as never);
    if (error) {
      toast({ title: 'Could not load the loyalty bonus switch', description: error.message, variant: 'destructive' });
    } else {
      setStatus(data as unknown as Status);
    }
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const flip = async (next: boolean) => {
    setBusy(true);
    const { error } = await supabase.rpc('set_payroll_loyalty_bonus' as never, { p_enabled: next } as never);
    if (error) {
      toast({ title: 'Not changed', description: error.message, variant: 'destructive' });
    } else {
      toast({
        title: `Payroll loyalty bonus ${next ? 'on' : 'off'}`,
        description: next ? 'The next daily run (00:00 UTC) will post 0.5% again.' : 'The next daily run (00:00 UTC) will post nothing.',
      });
    }
    await load();
    setBusy(false);
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">Payroll loyalty bonus (0.5% a day)</h3>
            {status && !status.can_change && <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label="Owner only" />}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            ON: every un-withdrawn payroll balance is credited 0.5% once a day (00:00 UTC), and that credit also grows. OFF: nothing is posted.
            Only the owner can change this switch.
          </p>
          {status && (
            <p className="text-[11px] text-muted-foreground mt-1.5">
              {status.people_paid} people paid {ugx(status.total_paid)} so far · {status.active_people} earning now on {ugx(status.active_balance)}
              {status.updated_by && status.updated_at ? ` · last changed by ${status.updated_by}, ${new Date(status.updated_at).toLocaleString('en-UG')}` : ''}
            </p>
          )}
        </div>
        <div className="shrink-0 pt-0.5">
          {loading || busy ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Switch checked={!!status?.enabled} disabled={!status?.can_change} onCheckedChange={(v) => void flip(v)} />
          )}
        </div>
      </div>
      {status && !status.can_change && (
        <p className="text-[11px] text-muted-foreground mt-2">Read only. Only the owner can switch this on or off.</p>
      )}
    </div>
  );
}
