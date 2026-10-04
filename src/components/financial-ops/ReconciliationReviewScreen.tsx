import { useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  CheckCircle2,
  XCircle,
  Search,
  Loader2,
  Receipt,
  Users,
  PlusCircle,
  RotateCcw,
  ScanLine,
  ListChecks,
  AlertTriangle,
  ShieldCheck,
} from 'lucide-react';
import {
  decodeAllocationsFromNote,
  type TenantAllocation,
} from '@/components/payments/OperationalFloatTenantAllocator';

/**
 * Reconciliation Review Screen
 * --------------------------------------------------------------
 * Operator pastes one or more receipt numbers / bank refs / TIDs
 * (one per line). For each line we run the same lookup that the
 * field flow uses and bucket the result as either:
 *
 *   • matched      → linked deposit + decoded tenant allocations
 *   • unmatched    → with a clear reason and two next actions:
 *                      - Search again (re-run the query)
 *                      - Create new allocation (jump to the
 *                        Verify Deposits hub to file it manually)
 *
 * This is a presentation surface only — it never mutates ledgers
 * or wallets. Approval still happens in TID Verification.
 */

const PLACEHOLDERS = new Set(['', 'NONE', 'N/A', 'NA', 'PENDING', 'TBD', 'UNKNOWN']);

type Status = 'matched' | 'unmatched';

interface ReconRow {
  reference: string;
  status: Status;
  /** Why we couldn't match (only populated when status === 'unmatched'). */
  reason?:
    | 'no_deposit'
    | 'placeholder_only'
    | 'already_approved'
    | 'too_short'
    | 'error';
  reasonDetail?: string;
  // Match payload
  depositId?: string;
  amount?: number;
  userName?: string;
  createdAt?: string;
  depositStatus?: string;
  depositPurpose?: string | null;
  matchedVia?: 'tid' | 'notes';
  allocations?: TenantAllocation[];
  /** Audit trail of how the depositor chose the purpose. Used to show
   *  whether an agent personal-deposit went through the in-app
   *  confirmation gate. */
  purposeAudit?: Record<string, unknown> | null;
}

function reasonCopy(r: ReconRow['reason']): { title: string; hint: string } {
  switch (r) {
    case 'no_deposit':
      return {
        title: 'No deposit found for this reference',
        hint: 'The user may not have submitted a deposit yet, or the reference was typed wrong.',
      };
    case 'placeholder_only':
      return {
        title: 'Only placeholder TIDs matched',
        hint: 'A draft deposit exists but the real receipt was never attached. Try searching by amount or create the allocation manually.',
      };
    case 'already_approved':
      return {
        title: 'Deposit already approved',
        hint: 'This receipt has been processed previously — no action required.',
      };
    case 'too_short':
      return {
        title: 'Reference is too short to search',
        hint: 'Enter at least 6 characters of the receipt or bank reference.',
      };
    case 'error':
      return {
        title: 'Search failed',
        hint: 'A backend error occurred — try again in a moment.',
      };
    default:
      return { title: 'Unmatched', hint: '' };
  }
}

export function ReconciliationReviewScreen({
  onCreateNewAllocation,
}: {
  /** Optional callback to jump the operator to the Verify Deposits hub
   *  with the unmatched reference pre-filled. */
  onCreateNewAllocation?: (reference: string) => void;
}) {
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<ReconRow[]>([]);
  const [retryingRef, setRetryingRef] = useState<string | null>(null);

  const refs = useMemo(
    () =>
      input
        .split(/[\n,;\t]/)
        .map(s => s.trim())
        .filter(Boolean)
        // de-dupe while preserving order
        .filter((v, i, a) => a.indexOf(v) === i),
    [input]
  );

  const stats = useMemo(() => {
    const matched = rows.filter(r => r.status === 'matched').length;
    const unmatched = rows.filter(r => r.status === 'unmatched').length;
    const total = rows.length;
    return { matched, unmatched, total, pct: total ? Math.round((matched / total) * 100) : 0 };
  }, [rows]);

  const lookupOne = async (reference: string): Promise<ReconRow> => {
    const ref = reference.trim();
    if (ref.length < 6) {
      return { reference: ref, status: 'unmatched', reason: 'too_short' };
    }
    try {
      // Search both transaction_id and notes (covers receipt-pasted matches).
      const { data, error } = await supabase
        .from('deposit_requests')
        .select(
          'id, amount, transaction_id, notes, status, deposit_purpose, purpose_audit, created_at, user_id'
        )
        .or(`transaction_id.ilike.%${ref}%,notes.ilike.%${ref}%`)
        .order('created_at', { ascending: false })
        .limit(5);

      if (error) throw error;
      const hits = data ?? [];
      if (hits.length === 0) {
        return { reference: ref, status: 'unmatched', reason: 'no_deposit' };
      }

      // Prefer a real (non-placeholder) TID match; fall back to notes match.
      const real = hits.find(
        h =>
          h.transaction_id &&
          !PLACEHOLDERS.has(h.transaction_id.trim().toUpperCase()) &&
          h.transaction_id.toLowerCase().includes(ref.toLowerCase())
      );
      const noteHit = hits.find(h => h.notes && h.notes.toLowerCase().includes(ref.toLowerCase()));
      const pick = real ?? noteHit ?? hits[0];

      // Edge case: every hit was a placeholder TID.
      if (
        !real &&
        !noteHit &&
        hits.every(
          h =>
            !h.transaction_id ||
            PLACEHOLDERS.has((h.transaction_id ?? '').trim().toUpperCase())
        )
      ) {
        return { reference: ref, status: 'unmatched', reason: 'placeholder_only' };
      }

      // Resolve user display name (best effort — non-blocking on failure).
      let userName = 'Unknown user';
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, phone')
        .eq('id', pick.user_id)
        .maybeSingle();
      if (profile?.full_name) userName = profile.full_name;
      else if (profile?.phone) userName = profile.phone;

      const allocations =
        pick.deposit_purpose === 'operational_float' && pick.notes
          ? decodeAllocationsFromNote(pick.notes)?.allocations ?? []
          : [];

      const matchedVia: 'tid' | 'notes' = real ? 'tid' : 'notes';

      // Note: we still surface already-approved as a *match* but flag it,
      // because the operator's question is "did this reconcile?" — yes it did.
      return {
        reference: ref,
        status: 'matched',
        depositId: pick.id,
        amount: Number(pick.amount),
        userName,
        createdAt: pick.created_at,
        depositStatus: pick.status,
        depositPurpose: pick.deposit_purpose,
        matchedVia,
        allocations,
        purposeAudit: ((pick as any).purpose_audit ?? null) as Record<string, unknown> | null,
      };
    } catch (err: any) {
      return {
        reference: ref,
        status: 'unmatched',
        reason: 'error',
        reasonDetail: err?.message ?? 'Unexpected error',
      };
    }
  };

  const runReconciliation = async () => {
    if (refs.length === 0) {
      toast.error('Paste at least one receipt or reference to reconcile.');
      return;
    }
    setRunning(true);
    setRows([]);
    try {
      // Run lookups in parallel — they're all independent reads.
      const results = await Promise.all(refs.map(lookupOne));
      setRows(results);
      const matched = results.filter(r => r.status === 'matched').length;
      toast.success(`Reconciled ${matched}/${results.length} reference${results.length === 1 ? '' : 's'}`);
    } finally {
      setRunning(false);
    }
  };

  const retryOne = async (reference: string) => {
    setRetryingRef(reference);
    try {
      const next = await lookupOne(reference);
      setRows(prev => prev.map(r => (r.reference === reference ? next : r)));
      if (next.status === 'matched') {
        toast.success(`Found a match for ${reference}`);
      } else {
        toast.message(`Still unmatched: ${reasonCopy(next.reason).title}`);
      }
    } finally {
      setRetryingRef(null);
    }
  };

  const handleCreate = (reference: string) => {
    if (onCreateNewAllocation) {
      onCreateNewAllocation(reference);
      return;
    }
    // Fallback: copy to clipboard so the operator can paste in Verify Deposits.
    navigator.clipboard?.writeText(reference).catch(() => {});
    toast.message('Reference copied — open Verify Deposits to file the allocation.');
  };

  const reset = () => {
    setInput('');
    setRows([]);
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2.5">
          <ScanLine className="h-6 w-6 text-primary" />
          Reconciliation Review
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Paste receipts or bank references — we'll show what matched, what didn't, and what to do next.
        </p>
      </div>

      {/* Input card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Receipt className="h-4 w-4" />
            References to reconcile
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={'One reference per line\nMP240712.0931.A12345\nFT24190ABCDE\nAR240712.1102.X9988'}
            className="font-mono text-sm min-h-[120px]"
          />
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs text-muted-foreground">
              {refs.length} reference{refs.length === 1 ? '' : 's'} ready
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={reset}
                disabled={running || (!input && rows.length === 0)}
              >
                Clear
              </Button>
              <Button onClick={runReconciliation} disabled={running || refs.length === 0} size="sm">
                {running ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Reconciling…
                  </>
                ) : (
                  <>
                    <Search className="h-4 w-4 mr-1.5" /> Reconcile {refs.length || ''}
                  </>
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary strip */}
      {rows.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <Card className="border-emerald-500/30 bg-emerald-500/5">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-wide">Matched</span>
              </div>
              <p className="text-2xl font-bold mt-1">{stats.matched}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{stats.pct}% of total</p>
            </CardContent>
          </Card>
          <Card className="border-destructive/30 bg-destructive/5">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-destructive">
                <XCircle className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-wide">Unmatched</span>
              </div>
              <p className="text-2xl font-bold mt-1">{stats.unmatched}</p>
              <p className="text-xs text-muted-foreground mt-0.5">need attention</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground">
                <ListChecks className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-wide">Total</span>
              </div>
              <p className="text-2xl font-bold mt-1">{stats.total}</p>
              <p className="text-xs text-muted-foreground mt-0.5">references checked</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Results list */}
      {rows.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Results</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="max-h-[640px]">
              <ul className="divide-y divide-border">
                {rows.map(r => (
                  <li key={r.reference} className="p-4">
                    {r.status === 'matched' ? (
                      <MatchedRow row={r} />
                    ) : (
                      <UnmatchedRow
                        row={r}
                        retrying={retryingRef === r.reference}
                        onRetry={() => retryOne(r.reference)}
                        onCreate={() => handleCreate(r.reference)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {rows.length === 0 && !running && (
        <Card className="border-dashed">
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            Paste receipts above and tap <span className="font-medium text-foreground">Reconcile</span> to begin.
            <br />
            Each reference is checked against pending and approved deposits.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ─────────────── Sub-rows ─────────────── */

function MatchedRow({ row }: { row: ReconRow }) {
  const isOpFloat = row.depositPurpose === 'operational_float';
  const tenants = row.allocations ?? [];
  const allocTotal = tenants.reduce((s, a) => s + Number(a.amount || 0), 0);
  const isApproved = row.depositStatus === 'approved';
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-9 w-9 rounded-lg bg-emerald-500/15 flex items-center justify-center shrink-0">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          </div>
          <div className="min-w-0">
            <p className="font-mono text-sm font-medium truncate">{row.reference}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {row.userName} · {row.createdAt ? format(new Date(row.createdAt), 'MMM d, HH:mm') : '—'}
            </p>
            {isApproved && (
              <p className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-1 flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" />
                Already reconciled — cannot be matched again
              </p>
            )}
          </div>
        </div>
        <div className="text-right">
          <p className="text-base font-bold">{formatUGX(row.amount ?? 0)}</p>
          <div className="flex items-center gap-1 justify-end mt-0.5">
            {row.depositStatus && (
              <Badge
                variant="outline"
                className={
                  row.depositStatus === 'approved'
                    ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400'
                    : ''
                }
              >
                {row.depositStatus}
              </Badge>
            )}
            {row.matchedVia === 'notes' && (
              <Badge variant="secondary" className="text-[10px]">via receipt</Badge>
            )}
            {row.depositPurpose === 'personal_deposit' && (() => {
              const audit = (row.purposeAudit ?? {}) as Record<string, unknown>;
              const isAgentRow = audit.is_agent === true;
              const confirmedAt = audit.agent_personal_confirmed_at;
              if (isAgentRow && confirmedAt) {
                return (
                  <Badge className="bg-emerald-600/15 text-emerald-700 text-[10px] border border-emerald-600/30">
                    💰 Personal — confirmed
                  </Badge>
                );
              }
              if (isAgentRow && !confirmedAt) {
                return (
                  <Badge className="bg-amber-500/15 text-amber-700 text-[10px] border border-amber-500/40">
                    ⚠️ Personal — no confirm
                  </Badge>
                );
              }
              return (
                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                  💰 Personal
                </Badge>
              );
            })()}
            {row.depositPurpose === 'operational_float' && (
              <Badge className="bg-primary/15 text-primary text-[10px] border border-primary/30">
                🏘️ Float
              </Badge>
            )}
          </div>
        </div>
      </div>

      {isOpFloat && tenants.length > 0 && (
        <div className="ml-12 mt-2 rounded-lg border border-border/60 bg-muted/30 p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-2">
            <Users className="h-3.5 w-3.5" />
            {tenants.length} tenant allocation{tenants.length === 1 ? '' : 's'}
          </div>
          <ul className="space-y-1">
            {tenants.map((a, i) => (
              <li key={i} className="flex items-center justify-between text-sm">
                <span className="truncate text-foreground/90">
                  {a.tenant_name || a.tenant_id}
                </span>
                <span className="font-mono text-foreground">{formatUGX(Number(a.amount || 0))}</span>
              </li>
            ))}
          </ul>
          <Separator className="my-2" />
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Allocated total</span>
            <span className="font-mono font-medium">{formatUGX(allocTotal)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function UnmatchedRow({
  row,
  retrying,
  onRetry,
  onCreate,
}: {
  row: ReconRow;
  retrying: boolean;
  onRetry: () => void;
  onCreate: () => void;
}) {
  const copy = reasonCopy(row.reason);
  const showCreate = row.reason !== 'too_short';
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-destructive/15 flex items-center justify-center shrink-0">
          <XCircle className="h-5 w-5 text-destructive" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-medium truncate">{row.reference}</p>
          <p className="text-sm font-medium text-foreground mt-1 flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
            {copy.title}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {row.reasonDetail || copy.hint}
          </p>
        </div>
      </div>
      <div className="flex gap-2 ml-12 flex-wrap">
        <Button
          size="sm"
          variant="outline"
          onClick={onRetry}
          disabled={retrying}
        >
          {retrying ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
          )}
          Search again
        </Button>
        {showCreate && (
          <Button size="sm" onClick={onCreate}>
            <PlusCircle className="h-3.5 w-3.5 mr-1.5" />
            Create new allocation
          </Button>
        )}
      </div>
    </div>
  );
}