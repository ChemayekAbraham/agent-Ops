import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

/**
 * Company receipts to place.
 *
 * Money a merchant desk sent to the company from a phone number the system did not connect to that desk, so the
 * desk's float was never cut. The automatic float return matches the SENDER'S PHONE to a profile; a second number,
 * or a second profile, slips through. Finance picks the desk here and the database books the receipt as that
 * desk's float return exactly as the automatic return does (it calls the same function). "Not a desk return"
 * takes a receipt off the list with a reason (a customer's own transfer, for example).
 */
interface ReceiptRow {
  gmail_transaction_id: string;
  received_at: string;
  channel: string;
  amount: number;
  transaction_id: string;
  counterparty: string | null;
  counterparty_name: string | null;
  kind: 'unmatched' | 'no_float_return';
  booked_agent_name: string | null;
  excess_amount: number;
  suggested_agent_id: string | null;
  suggested_agent_name: string | null;
  times_seen: number;
}

export interface PlaceableDesk {
  agentId: string;
  name: string;
  float: number;
}

const KEY = ['company-receipts-to-place'];

export function CompanyReceiptsToPlacePanel({ desks }: { desks: PlaceableDesk[] }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'unmatched' | 'no_float_return'>('all');
  const [placing, setPlacing] = useState<ReceiptRow | null>(null);
  const [dismissing, setDismissing] = useState<ReceiptRow | null>(null);
  const [deskQuery, setDeskQuery] = useState('');
  const [remember, setRemember] = useState(true);
  const [reason, setReason] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: KEY,
    retry: false,
    staleTime: 20_000,
    queryFn: async (): Promise<ReceiptRow[]> => {
      const { data, error } = await supabase.rpc('get_company_receipts_to_place' as any, { p_days: 14 });
      if (error) throw error;
      return ((data ?? []) as any[]).map((r) => ({ ...r, amount: Number(r.amount), excess_amount: Number(r.excess_amount ?? 0), times_seen: Number(r.times_seen ?? 1) }));
    },
  });

  const place = useMutation({
    mutationFn: async (input: { receipt: ReceiptRow; desk: PlaceableDesk }) => {
      const { error } = await supabase.rpc('place_company_receipt_as_float_return' as any, {
        p_gmail_transaction_id: input.receipt.gmail_transaction_id,
        p_agent_id: input.desk.agentId,
        p_remember_number: remember,
      });
      if (error) throw error;
      return input;
    },
    onSuccess: ({ receipt, desk }) => {
      toast.success(`Booked as ${desk.name}'s float return (${receipt.transaction_id}).`);
      setPlacing(null);
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['merchant-float-positions'] });
      qc.invalidateQueries({ queryKey: ['merchant-desk-statement'] });
    },
    onError: (e: any) => toast.error(e?.message ?? 'That could not be booked.'),
  });

  const dismiss = useMutation({
    mutationFn: async (input: { receipt: ReceiptRow; reason: string }) => {
      const { error } = await supabase.rpc('dismiss_company_receipt' as any, {
        p_gmail_transaction_id: input.receipt.gmail_transaction_id,
        p_reason: input.reason,
      });
      if (error) throw error;
      return input;
    },
    onSuccess: ({ receipt }) => {
      toast.success(`Taken off the list (${receipt.transaction_id}).`);
      setDismissing(null);
      setReason('');
      qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: any) => toast.error(e?.message ?? 'That could not be saved.'),
  });

  const rows = data ?? [];
  const shown = useMemo(() => rows.filter((r) => filter === 'all' || r.kind === filter), [rows, filter]);
  const total = useMemo(() => rows.reduce((s, r) => s + (r.kind === 'unmatched' ? r.amount : r.excess_amount), 0), [rows]);
  const visibleDesks = useMemo(() => {
    const q = deskQuery.trim().toLowerCase();
    return desks.filter((d) => !q || d.name.toLowerCase().includes(q)).sort((a, b) => b.float - a.float || a.name.localeCompare(b.name));
  }, [desks, deskQuery]);

  return (
    <div className="rounded-2xl border border-border bg-card p-5 min-w-0">
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-xl bg-warning/15 flex items-center justify-center shrink-0">
          <ArrowRightLeft className="h-5 w-5 text-warning" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">COMPANY RECEIPTS TO PLACE</p>
          <p className="mt-1 font-mono text-xl font-bold tabular-nums text-foreground break-all">{isLoading ? '—' : formatUGX(total)}</p>
          <p className="text-[11px] text-muted-foreground">
            {rows.length} receipt{rows.length === 1 ? '' : 's'} of UGX 1,000,000 or more in the last 14 days that never cut a desk&apos;s float.
          </p>
        </div>
      </div>

      {error && <p className="mt-3 text-[11px] text-destructive">Could not load this list. {(error as any)?.message ?? ''}</p>}
      {!isLoading && !error && rows.length === 0 && (
        <p className="mt-3 text-[11px] text-muted-foreground">Nothing to place. Every receipt from a desk has cut that desk&apos;s float.</p>
      )}

      {rows.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {([
            ['all', 'All'],
            ['unmatched', 'Nothing claimed it'],
            ['no_float_return', 'Booked, nothing cut'],
          ] as const).map(([k, label]) => (
            <Button key={k} size="sm" variant={filter === k ? 'default' : 'outline'} onClick={() => setFilter(k)}>
              {label}
            </Button>
          ))}
        </div>
      )}

      <ul className="mt-3 space-y-2">
        {shown.map((r) => (
          <li key={r.gmail_transaction_id} className="rounded-xl border border-border/60 bg-muted/20 p-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <p className="text-[12px] font-semibold text-foreground">
                  {r.channel === 'airtel_money' ? 'Airtel' : 'MTN'} ·{' '}
                  {new Date(r.received_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  From {[r.counterparty_name, r.counterparty].filter(Boolean).join(' · ') || 'unknown'} · ref {r.transaction_id}
                </p>
                {r.kind === 'no_float_return' && (
                  <p className="text-[10px] text-destructive">Booked to {r.booked_agent_name ?? 'another profile'} with no float to cut.</p>
                )}
                {r.times_seen > 1 && <p className="text-[10px] text-muted-foreground">This number appears {r.times_seen} times in the list.</p>}
                {r.suggested_agent_name && (
                  <p className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">Known number of {r.suggested_agent_name}.</p>
                )}
              </div>
              <p className="font-mono text-sm font-bold tabular-nums text-foreground shrink-0">
                {formatUGX(r.kind === 'unmatched' ? r.amount : r.excess_amount)}
              </p>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setPlacing(r);
                  setDeskQuery('');
                  setRemember(true);
                }}
              >
                Place on a desk
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDismissing(r)}>
                Not a desk return
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-3 rounded-xl border border-primary/10 bg-primary/5 p-3 text-[11px] leading-relaxed text-muted-foreground">
        Placing a receipt cuts that desk&apos;s float by the amount and marks the money as used, so it can never also be credited as a deposit.
        A customer&apos;s own transfer is not a desk return: use &ldquo;Not a desk return&rdquo; and say why.
      </p>

      <Dialog open={!!placing} onOpenChange={(v) => !v && !place.isPending && setPlacing(null)}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Place {placing ? formatUGX(placing.amount) : ''} on which desk?</DialogTitle>
            <DialogDescription>
              Ref {placing?.transaction_id}. The desk&apos;s float is cut by this amount, or by what float it has.
            </DialogDescription>
          </DialogHeader>
          <Input placeholder="Search a desk" value={deskQuery} onChange={(e) => setDeskQuery(e.target.value)} />
          <label className="flex items-center gap-2 text-[12px]">
            <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
            Remember {placing?.counterparty ?? 'this number'} for this desk
          </label>
          <ul className="divide-y divide-border">
            {visibleDesks.length === 0 && <li className="py-2 text-[12px] text-muted-foreground">No desks to show.</li>}
            {visibleDesks.map((d) => (
              <li key={d.agentId}>
                <button
                  type="button"
                  disabled={place.isPending}
                  onClick={() => placing && place.mutate({ receipt: placing, desk: d })}
                  className="flex w-full items-center justify-between gap-3 py-2.5 text-left hover:bg-muted/40 disabled:opacity-50"
                >
                  <span className="truncate text-sm font-semibold">{d.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{formatUGX(d.float)}</span>
                </button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>

      <Dialog open={!!dismissing} onOpenChange={(v) => !v && !dismiss.isPending && setDismissing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Not a desk return?</DialogTitle>
            <DialogDescription>
              {dismissing ? formatUGX(dismissing.amount) : ''} · ref {dismissing?.transaction_id}. It leaves this list. Say why, so it can be checked later.
            </DialogDescription>
          </DialogHeader>
          <Input placeholder="Reason (at least 5 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={dismiss.isPending} onClick={() => setDismissing(null)}>
              Cancel
            </Button>
            <Button
              disabled={dismiss.isPending || reason.trim().length < 5}
              onClick={() => dismissing && dismiss.mutate({ receipt: dismissing, reason: reason.trim() })}
            >
              {dismiss.isPending ? 'Saving…' : 'Take it off'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
