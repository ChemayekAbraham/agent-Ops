import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { listRates, setRate } from '../api';
import { RATE_TIERS } from '../components/RateStrip';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function RatesTab() {
  const [rates, setRates] = useState<Record<string, { amount: number | null; updated_at: string | null }>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ tier: string; label: string; amount: number } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await listRates();
      const map: Record<string, { amount: number | null; updated_at: string | null }> = {};
      r.forEach((x: any) => { map[x.tier] = { amount: x.amount_ugx != null ? Number(x.amount_ugx) : null, updated_at: x.updated_at ?? null }; });
      setRates(map);
      setDrafts(Object.fromEntries(RATE_TIERS.map((t) => [t.tier, map[t.tier]?.amount != null ? String(map[t.tier]!.amount) : ''])));
    } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    try { await setRate({ p_tier: pending.tier, p_amount: pending.amount }); toast.success(`${pending.label} rate saved`); }
    catch (e) { toast.error(errText(e)); }
    finally { setBusy(false); setPending(null); await load(); }
  }

  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {RATE_TIERS.map(({ tier, label }) => {
        const cur = rates[tier];
        const draft = drafts[tier] ?? '';
        const n = Number(draft.replace(/,/g, ''));
        const valid = draft.trim() !== '' && Number.isFinite(n) && n >= 0;
        return (
          <div key={tier} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
            <div className="min-w-[8rem] flex-1">
              <p className="text-sm font-medium">{label}</p>
              <p className="text-xs text-muted-foreground">
                {cur?.amount != null ? formatUGX(cur.amount) : 'Not set'}
                {cur?.updated_at ? ` · updated ${new Date(cur.updated_at).toLocaleDateString()}` : ''}
              </p>
            </div>
            <Input inputMode="numeric" className="w-40" placeholder="UGX" value={draft}
              onChange={(e) => setDrafts((d) => ({ ...d, [tier]: e.target.value }))} />
            <Button size="sm" disabled={!valid || busy || n === cur?.amount}
              onClick={() => setPending({ tier, label, amount: n })}>Save</Button>
          </div>
        );
      })}

      <AlertDialog open={!!pending} onOpenChange={(o) => { if (!o && !busy) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm rate</AlertDialogTitle>
            <AlertDialogDescription>
              {pending && `Set ${pending.label} to ${formatUGX(pending.amount)}? This applies to videos accepted from now on. Videos already accepted keep their rate.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); void confirm(); }}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
