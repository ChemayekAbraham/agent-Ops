import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, SlidersHorizontal, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import MaintenanceToggleCard from '@/components/cto/MaintenanceToggleCard';
import WalletOpsMaintenanceCard from '@/components/cto/WalletOpsMaintenanceCard';

/**
 * CTO Platform Controls
 * -------------------------------------------------------------------
 * Central place for the CTO to update platform-wide operational
 * switches stored in `public.treasury_controls`. The CTO already has
 * UPDATE on this table; a companion SELECT policy lets this panel show
 * the current state.
 *
 * Each toggle writes a single row (`enabled`) and re-fetches the truth
 * from the database — never optimistic. Maintenance mode keeps its own
 * dedicated card (it carries a custom lock message).
 */

interface ControlDef {
  key: string;
  label: string;
  description: string;
  /** When true, ON is the "safe/protective" state (green when on). */
  protective?: boolean;
  /** When true, ON means a pause/halt (amber/red when on). */
  danger?: boolean;
}

const AUTOMATION_CONTROLS: ControlDef[] = [
  { key: 'auto_commissions', label: 'Auto commissions', description: 'Automatically credit agent commissions as transactions settle.' },
  { key: 'auto_advances', label: 'Auto advances', description: 'Allow the engine to auto-issue eligible agent advances.' },
  { key: 'auto_roi', label: 'Auto returns (ROI)', description: 'Run the automated supporter returns payout cycle.' },
  { key: 'auto_salaries', label: 'Auto salaries', description: 'Run automated payroll batches on schedule.' },
];

const HALT_CONTROLS: ControlDef[] = [
  { key: 'credits_paused', label: 'Pause credit access', description: 'Block all new credit draws / rent plan disbursements.', danger: true },
  { key: 'withdrawals_paused', label: 'Pause withdrawals', description: 'Block all wallet withdrawals platform-wide.', danger: true },
  {
    key: 'advance_withdrawals_paused',
    label: 'Halt advance withdrawals',
    description: 'ON: money that reached an agent wallet through an advance (and has not been spent yet) is removed from the spendable balance — agents can only withdraw earned money. Commissions, rent collections and other credits keep flowing.',
    danger: true,
  },
];


const UI_OVERRIDE_CONTROLS: ControlDef[] = [
  {
    key: 'payouts_ui_enabled',
    label: 'Enable Claim & Withdraw buttons',
    description: 'Re-enable the "Withdraw" buttons (agent hero, funder actions) and the merchant "Claim" button. Leave OFF while payouts are frozen; flip ON when payouts are available.',
    protective: true,
  },
  {
    key: 'landlord_payout_priority',
    label: 'Show Landlord Payouts first',
    description: 'ON: Landlord float payouts are Priority #1 — they show at the top of the Merchant Agent Payout Queue and no other payout can be claimed until they are handled. OFF: landlord payouts process in the usual order alongside other withdrawals.',
    protective: true,
  },
  {
    key: 'landlord_payouts_blocked',
    label: 'Block landlord payouts from queue',
    description: 'ON: Landlord float payouts are hidden from the Merchant Agent Payout Queue and cannot be claimed by anyone. The withdrawal requests are NOT cancelled — they stay queued and reappear the moment this is switched back OFF. OFF (default): landlord payouts flow normally.',
    danger: true,
  },
  {
    key: 'proxy_payout_priority',
    label: 'Show Proxy Agent withdrawals first',
    description: 'ON: Proxy Agent withdrawals are Priority #1 — they show at the top of the Merchant Agent Payout Queue and no normal withdrawal can be claimed until they are handled. OFF: the hold is released and merchant agents process normal customer withdrawals in the usual order.',
    protective: true,
  },
];

const GUARD_CONTROLS: ControlDef[] = [
  { key: 'enforce_cash_guard', label: 'Enforce cash guard', description: 'Block disbursements that would breach available cash.', protective: true },
  { key: 'enforce_roi_coverage', label: 'Enforce returns coverage', description: 'Require sufficient coverage before paying supporter returns.', protective: true },
  { key: 'enforce_wallet_lock', label: 'Enforce wallet lock', description: 'Block any direct wallet mutation outside the ledger path.', protective: true },
  { key: 'strict_mode', label: 'Strict ledger mode', description: 'Reject any ledger entry using a non-allowlisted category.', protective: true },
];

const ALL_KEYS = [...AUTOMATION_CONTROLS, ...HALT_CONTROLS, ...GUARD_CONTROLS, ...UI_OVERRIDE_CONTROLS].map((c) => c.key);

export function PlatformControlsPanel() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, boolean>>({});

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('treasury_controls')
      .select('control_key, enabled')
      .in('control_key', ALL_KEYS);
    if (error) {
      toast({ title: 'Failed to load controls', description: error.message, variant: 'destructive' });
    } else {
      const next: Record<string, boolean> = {};
      (data ?? []).forEach((r: any) => { next[r.control_key] = !!r.enabled; });
      setState(next);
    }
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const toggle = async (def: ControlDef, next: boolean) => {
    setBusyKey(def.key);
    const { error } = await supabase
      .from('treasury_controls')
      .update({ enabled: next, updated_at: new Date().toISOString() })
      .eq('control_key', def.key);
    if (error) {
      toast({ title: 'Update failed', description: error.message, variant: 'destructive' });
    } else {
      // Re-fetch the truth rather than trusting the click.
      await load();
      toast({
        title: `${def.label} ${next ? 'enabled' : 'disabled'}`,
        description: def.description,
      });
    }
    setBusyKey(null);
  };

  const renderGroup = (title: string, subtitle: string, controls: ControlDef[]) => (
    <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
      </div>
      <div className="space-y-3">
        {controls.map((c) => {
          const on = !!state[c.key];
          return (
            <div key={c.key} className="flex items-start justify-between gap-3 rounded-lg border border-border/60 p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{c.label}</p>
                  {c.danger && on && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-destructive">
                      <AlertTriangle className="h-3 w-3" /> ACTIVE
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{c.description}</p>
              </div>
              <div className="shrink-0 pt-0.5">
                {busyKey === c.key ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <Switch checked={on} disabled={loading} onCheckedChange={(v) => void toggle(c, v)} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="space-y-4 pb-20">
      <div className="flex items-center gap-2">
        <SlidersHorizontal className="h-5 w-5 text-primary" />
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-bold">Platform Controls</h2>
          <p className="text-xs text-muted-foreground">
            Update platform-wide operational switches. Changes take effect immediately across the system.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      <WalletOpsMaintenanceCard />
      <MaintenanceToggleCard />
      {renderGroup('Automation engines', 'Turn scheduled money movements on or off.', AUTOMATION_CONTROLS)}
      {renderGroup('Emergency halts', 'Immediately stop credit or withdrawals during an incident.', HALT_CONTROLS)}
      {renderGroup('Payout queue & UI overrides', 'Re-enable payout buttons (Claim / Withdraw) and choose whether Proxy Agent withdrawals hold the merchant queue.', UI_OVERRIDE_CONTROLS)}
      {renderGroup('Safety guards', 'Protective checks that keep the ledger and cash safe. Keep these ON unless instructed.', GUARD_CONTROLS)}
    </div>
  );
}

export default PlatformControlsPanel;