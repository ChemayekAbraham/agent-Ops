import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Loader2, ArrowDownLeft, ArrowUpRight, Copy } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';

/**
 * Full detail view for a single general_ledger entry (Fin Ops surface).
 * Shows every stored column on the leg plus the sibling legs that belong to the
 * same transaction group, so an operator can see both sides of the movement.
 */

interface FullLedgerRow {
  id: string;
  created_at: string;
  transaction_date: string;
  amount: number;
  direction: string;
  category: string | null;
  sub_category: string | null;
  description: string | null;
  reference_id: string | null;
  user_id: string | null;
  linked_party: string | null;
  source_table: string | null;
  source_id: string | null;
  running_balance: number | null;
  account: string | null;
  transaction_group_id: string | null;
  ledger_scope: string | null;
  currency: string | null;
  classification: string | null;
  idempotency_key: string | null;
  wallet_id: string | null;
  recipient_type: string | null;
  wallet_bucket: string | null;
  routing_source: string | null;
  solvency_bypass_reason: string | null;
  withdrawable_after: string | null;
  maturity_condition: string | null;
  maturity_met: boolean | null;
  matured_at: string | null;
}

const FULL_COLS =
  'id, created_at, transaction_date, amount, direction, category, sub_category, description, reference_id, user_id, linked_party, source_table, source_id, running_balance, account, transaction_group_id, ledger_scope, currency, classification, idempotency_key, wallet_id, recipient_type, wallet_bucket, routing_source, solvency_bypass_reason, withdrawable_after, maturity_condition, maturity_met, matured_at';

function fmtTs(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`text-xs break-words ${mono ? 'font-mono tabular-nums' : ''}`}>{value ?? '—'}</p>
    </div>
  );
}

export function LedgerEntryDetailDialog({
  entryId,
  open,
  onOpenChange,
}: {
  entryId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['ledger-entry-detail', entryId],
    enabled: open && !!entryId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data: entry, error: e1 } = await supabase
        .from('general_ledger')
        .select(FULL_COLS)
        .eq('id', entryId as string)
        .maybeSingle();
      if (e1) throw e1;
      if (!entry) return { entry: null, legs: [] as FullLedgerRow[], names: {} as Record<string, string> };

      const row = entry as unknown as FullLedgerRow;

      let legs: FullLedgerRow[] = [];
      if (row.transaction_group_id) {
        const { data: sib, error: e2 } = await supabase
          .from('general_ledger')
          .select(FULL_COLS)
          .eq('transaction_group_id', row.transaction_group_id)
          .order('created_at', { ascending: true })
          .limit(50);
        if (e2) throw e2;
        legs = (sib ?? []) as unknown as FullLedgerRow[];
      }

      const ids = new Set<string>();
      for (const l of [row, ...legs]) {
        if (l.user_id) ids.add(l.user_id);
        if (l.linked_party && /^[0-9a-f-]{36}$/i.test(l.linked_party)) ids.add(l.linked_party);
      }
      const names: Record<string, string> = {};
      if (ids.size) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', Array.from(ids));
        for (const p of profs ?? []) {
          names[p.id] = [p.full_name, p.phone].filter(Boolean).join(' · ') || p.id;
        }
      }
      return { entry: row, legs, names };
    },
  });

  const entry = data?.entry ?? null;
  const names = data?.names ?? {};
  const isIn = entry?.direction === 'cash_in';

  const copy = async (label: string, value: string | null) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Transaction detail</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading transaction…
          </div>
        ) : error ? (
          <p className="py-8 text-center text-sm text-destructive">Could not load this transaction.</p>
        ) : !entry ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Transaction not found.</p>
        ) : (
          <div className="space-y-5">
            {/* Headline */}
            <div className="rounded-xl border border-border bg-muted/30 p-4 text-center">
              <p className="text-xs text-muted-foreground capitalize">{entry.category ?? 'movement'}</p>
              <p className={`text-2xl font-bold font-mono tabular-nums ${isIn ? 'text-emerald-600' : 'text-destructive'}`}>
                <span className="inline-flex items-center gap-2">
                  {isIn ? <ArrowDownLeft className="h-5 w-5" /> : <ArrowUpRight className="h-5 w-5" />}
                  {isIn ? '+' : '−'}{formatUGX(Number(entry.amount))}
                </span>
              </p>
              <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
                <Badge variant="outline">{entry.direction}</Badge>
                {entry.wallet_bucket && <Badge variant="secondary">{entry.wallet_bucket}</Badge>}
                {entry.ledger_scope && <Badge variant="outline">{entry.ledger_scope}</Badge>}
                {entry.classification && <Badge variant="outline">{entry.classification}</Badge>}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{fmtTs(entry.transaction_date)}</p>
            </div>

            {entry.description && (
              <div className="rounded-lg border border-border p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Description</p>
                <p className="text-sm">{entry.description}</p>
              </div>
            )}

            {/* Who */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Field label="Wallet owner" value={entry.user_id ? (names[entry.user_id] ?? entry.user_id) : '—'} />
              <Field
                label="Linked party"
                value={entry.linked_party ? (names[entry.linked_party] ?? entry.linked_party) : '—'}
              />
              <Field label="Recipient type" value={entry.recipient_type ?? '—'} />
              <Field label="Account" value={entry.account ?? '—'} />
              <Field label="Sub category" value={entry.sub_category ?? '—'} />
              <Field label="Routing source" value={entry.routing_source ?? '—'} />
              <Field label="Currency" value={entry.currency ?? 'UGX'} />
              <Field label="Running balance" mono value={entry.running_balance !== null ? formatUGX(Number(entry.running_balance)) : '—'} />
              <Field label="Posted at" mono value={fmtTs(entry.created_at)} />
            </div>

            {/* Traceability */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => copy('Entry ID', entry.id)}
                className="text-left rounded-lg border border-border p-2 hover:bg-muted/40 transition-colors"
              >
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                  Entry ID <Copy className="h-3 w-3" />
                </p>
                <p className="font-mono text-[11px] break-all">{entry.id}</p>
              </button>
              <button
                type="button"
                onClick={() => copy('Transaction group', entry.transaction_group_id)}
                className="text-left rounded-lg border border-border p-2 hover:bg-muted/40 transition-colors"
              >
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                  Transaction group <Copy className="h-3 w-3" />
                </p>
                <p className="font-mono text-[11px] break-all">{entry.transaction_group_id ?? '—'}</p>
              </button>
              <Field label="Reference" mono value={entry.reference_id ?? '—'} />
              <Field label="Idempotency key" mono value={entry.idempotency_key ?? '—'} />
              <Field label="Source table" mono value={entry.source_table ?? '—'} />
              <Field label="Source ID" mono value={entry.source_id ?? '—'} />
              <Field label="Wallet ID" mono value={entry.wallet_id ?? '—'} />
              <Field label="Solvency bypass reason" value={entry.solvency_bypass_reason ?? '—'} />
            </div>

            {(entry.withdrawable_after || entry.maturity_condition) && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <Field label="Withdrawable after" mono value={fmtTs(entry.withdrawable_after)} />
                <Field label="Maturity condition" value={entry.maturity_condition ?? '—'} />
                <Field label="Matured at" mono value={fmtTs(entry.matured_at)} />
              </div>
            )}

            {/* Both sides */}
            <div>
              <p className="text-xs font-semibold mb-2">
                Transaction legs{' '}
                <span className="text-muted-foreground font-normal">
                  ({(data?.legs ?? []).length || 1})
                </span>
              </p>
              <div className="rounded-lg border border-border overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr className="text-left">
                      <th className="px-2 py-1.5 font-medium">Scope</th>
                      <th className="px-2 py-1.5 font-medium">Owner</th>
                      <th className="px-2 py-1.5 font-medium">Category</th>
                      <th className="px-2 py-1.5 font-medium">Bucket</th>
                      <th className="px-2 py-1.5 font-medium text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.legs?.length ? data.legs : [entry]).map((l) => {
                      const legIn = l.direction === 'cash_in';
                      return (
                        <tr
                          key={l.id}
                          className={`border-t border-border/50 ${l.id === entry.id ? 'bg-primary/5' : ''}`}
                        >
                          <td className="px-2 py-1.5">{l.ledger_scope ?? '—'}</td>
                          <td className="px-2 py-1.5 max-w-[160px] truncate" title={l.user_id ?? ''}>
                            {l.user_id ? (names[l.user_id] ?? l.user_id) : 'platform'}
                          </td>
                          <td className="px-2 py-1.5">{l.category ?? '—'}</td>
                          <td className="px-2 py-1.5">{l.wallet_bucket ?? '—'}</td>
                          <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${legIn ? 'text-emerald-600' : 'text-destructive'}`}>
                            {legIn ? '+' : '−'}{formatUGX(Number(l.amount))}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
