import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Wrench, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import DepositFlow from '@/components/payments/DepositFlow';

type StuckDeposit = {
  id: string;
  amount: number;
  transaction_id: string | null;
  provider: string | null;
  created_at: string;
  notes: string | null;
};

interface Props {
  agentId: string;
}

/**
 * Lists deposits this agent logged that ended up status='approved' but were
 * never posted to the general_ledger (typically auto-matched from Gmail MoMo
 * receipts before the guardrail was added). Lets the agent reopen each one
 * and re-confirm the purpose through the standard DepositFlow, so the right
 * wallet bucket (operational float, withdrawable, etc) is credited.
 */
export function StuckDepositsRepairPanel({ agentId }: Props) {
  const [rows, setRows] = useState<StuckDeposit[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [flowOpen, setFlowOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 1) Fetch agent's approved deposits (recent window)
      const { data: deposits, error } = await supabase
        .from('deposit_requests')
        .select('id, amount, transaction_id, provider, created_at, notes')
        .or(`agent_id.eq.${agentId},user_id.eq.${agentId}`)
        .eq('status', 'approved')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;

      const candidateIds = (deposits ?? []).map((d) => d.id);
      if (!candidateIds.length) {
        setRows([]);
        return;
      }

      // 2) Find which of those have NO general_ledger entry
      const { data: posted, error: glErr } = await supabase
        .from('general_ledger')
        .select('source_id')
        .eq('source_table', 'deposit_requests')
        .in('source_id', candidateIds);
      if (glErr) throw glErr;

      const postedSet = new Set((posted ?? []).map((p) => p.source_id));
      const stuck = (deposits ?? []).filter((d) => !postedSet.has(d.id));
      setRows(stuck as StuckDeposit[]);
    } catch (e: any) {
      console.error('[StuckDepositsRepairPanel] load failed', e);
      toast.error('Could not load stuck deposits');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { load(); }, [load]);

  const handleRepair = async (id: string) => {
    setBusyId(id);
    try {
      const { data, error } = await supabase.rpc('reopen_deposit_for_repair', { p_deposit_id: id });
      if (error) throw error;
      const ok = (data as any)?.ok;
      if (!ok) throw new Error('Reopen failed');
      toast.success('Deposit reopened — confirm the purpose to credit the right wallet');
      setEditId(id);
      setFlowOpen(true);
    } catch (e: any) {
      const msg = e?.message ?? 'Could not reopen deposit';
      toast.error(msg.length > 160 ? msg.slice(0, 160) + '…' : msg);
    } finally {
      setBusyId(null);
    }
  };

  // After the DepositFlow closes, refresh — the repaired row should no longer be stuck.
  const handleFlowChange = (open: boolean) => {
    setFlowOpen(open);
    if (!open) {
      setEditId(null);
      load();
    }
  };

  if (loading) {
    return null; // stay silent on first load; nothing scary to surface
  }

  if (!rows.length) {
    return null; // no stuck deposits → render nothing
  }

  return (
    <>
      <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-xl bg-amber-500 text-white shrink-0">
            <AlertTriangle className="h-5 w-5" strokeWidth={2.2} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-sm text-foreground">
              {rows.length} stuck deposit{rows.length === 1 ? '' : 's'} need{rows.length === 1 ? 's' : ''} repair
            </div>
            <div className="text-[11px] text-muted-foreground leading-relaxed">
              These were auto-marked approved but never reached a wallet. Tap <b>Repair</b> on each
              one and confirm the purpose (operational float, customer deposit, etc) so the right
              wallet bucket is credited.
            </div>
          </div>
        </div>

        <ul className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-3 rounded-xl bg-card border border-border/60 p-3"
            >
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm text-foreground">
                  UGX {Number(r.amount).toLocaleString()}
                  {r.provider ? <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">{r.provider}</span> : null}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {r.transaction_id ? `TID ${r.transaction_id} · ` : ''}
                  {new Date(r.created_at).toLocaleString()}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busyId === r.id}
                onClick={() => handleRepair(r.id)}
                className="shrink-0"
              >
                {busyId === r.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Wrench className="h-4 w-4 mr-1.5" /> Repair
                  </>
                )}
              </Button>
            </li>
          ))}
        </ul>
      </div>

      <DepositFlow
        open={flowOpen}
        onOpenChange={handleFlowChange}
        editRequestId={editId ?? undefined}
        requirePurposeChoice
      />
    </>
  );
}

export default StuckDepositsRepairPanel;