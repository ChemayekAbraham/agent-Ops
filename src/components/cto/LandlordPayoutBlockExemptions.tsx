import { useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { useLandlordPayoutBlockQueue } from '@/hooks/useLandlordPayoutBlockQueue';

/**
 * Shown under "Block landlord payouts from queue" while it is ON: every
 * landlord payout the block is holding back, with a checkbox to select and
 * allow specific ones through to the Merchant Agent Payout Queue (or
 * re-block them). Enforced server-side — see
 * 20260924100000_landlord_payout_block_exemptions.sql.
 */
export function LandlordPayoutBlockExemptions() {
  const { toast } = useToast();
  const { rows, loading, saving, error, reload, setAllowed } = useLandlordPayoutBlockQueue();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const allowedCount = useMemo(() => rows.filter((r) => r.exempt_at).length, [rows]);
  const selectedRows = rows.filter((r) => selected.has(r.withdrawal_id));
  const toAllow = selectedRows.filter((r) => !r.exempt_at).map((r) => r.withdrawal_id);
  const toBlock = selectedRows.filter((r) => r.exempt_at).map((r) => r.withdrawal_id);

  const toggleOne = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const apply = async (ids: string[], allow: boolean) => {
    try {
      const n = await setAllowed(ids, allow);
      setSelected(new Set());
      toast({
        title: allow ? `${n} landlord payout${n === 1 ? '' : 's'} allowed` : `${n} landlord payout${n === 1 ? '' : 's'} blocked again`,
        description: n < ids.length
          ? `${ids.length - n} could not be changed — already claimed by a merchant agent or no longer open.`
          : allow
            ? 'They are now visible and claimable in the Merchant Agent Payout Queue.'
            : 'They are hidden from the Merchant Agent Payout Queue again.',
      });
    } catch (e: unknown) {
      toast({ title: 'Update failed', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    }
  };

  return (
    <div className="rounded-lg border border-border/60 p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Allow selected landlord payouts</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {rows.length} landlord payout{rows.length === 1 ? '' : 's'} waiting · {allowedCount} allowed through, {rows.length - allowedCount} blocked.
            Tick the ones merchant agents may pay now.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void reload()} disabled={loading || saving}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {!loading && !error && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">No landlord payouts are waiting in the queue.</p>
      )}

      {rows.length > 0 && (
        <div className="max-h-80 overflow-y-auto space-y-2">
          {rows.map((r) => (
            <label
              key={r.withdrawal_id}
              className="flex items-start gap-3 rounded-md border border-border/50 p-2 cursor-pointer"
            >
              <Checkbox
                className="mt-0.5"
                checked={selected.has(r.withdrawal_id)}
                disabled={saving}
                onCheckedChange={(v) => toggleOne(r.withdrawal_id, v === true)}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{formatUGX(Number(r.amount))}</span>
                  <span className="text-sm truncate">{r.landlord_name || r.mobile_money_name || 'Landlord'}</span>
                  {r.exempt_at ? <Badge variant="secondary">Allowed</Badge> : <Badge variant="outline">Blocked</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  Agent: {r.agent_name || '—'}{r.agent_phone ? ` (${r.agent_phone})` : ''} · To: {r.mobile_money_number || r.landlord_phone || '—'} ·{' '}
                  {new Date(r.created_at).toLocaleString()}
                  {r.exempt_at && ` · allowed by ${r.exempt_by_name || 'staff'}`}
                </p>
              </div>
            </label>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={saving || toAllow.length === 0} onClick={() => void apply(toAllow, true)}>
            {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Allow selected ({toAllow.length})
          </Button>
          <Button size="sm" variant="outline" disabled={saving || toBlock.length === 0} onClick={() => void apply(toBlock, false)}>
            Block selected again ({toBlock.length})
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() =>
              setSelected(selected.size === rows.length ? new Set() : new Set(rows.map((r) => r.withdrawal_id)))
            }
          >
            {selected.size === rows.length ? 'Clear selection' : 'Select all'}
          </Button>
        </div>
      )}
    </div>
  );
}

export default LandlordPayoutBlockExemptions;
