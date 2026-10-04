import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Ban } from 'lucide-react';
import { format } from 'date-fns';

/**
 * Read-only operator audit trail for the email→withdrawal auto-matcher.
 * Pulls the latest rows from `email_payout_match_attempts` and shows
 * matched phone, amount, TID, outcome, error, and timestamp.
 */

interface AuditRow {
  id: string;
  attempted_at: string;
  operator_id: string | null;
  withdrawal_id: string | null;
  email_id: string | null;
  email_transaction_id: string | null;
  withdrawal_amount: number | null;
  email_amount: number | null;
  amount_delta: number | null;
  recipient_phone_target: string | null;
  recipient_phone_email: string | null;
  payment_method: string | null;
  outcome: string;
  error_message: string | null;
  tolerance_amount_ugx: number | null;
  tolerance_phone_tail: number | null;
}

const OUTCOMES: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'matched_auto_approved', label: 'Auto-approved' },
  { value: 'matched_approve_failed', label: 'Auto-approve failed' },
  { value: 'matched_manual_retry_ok', label: 'Manual retry OK' },
  { value: 'matched_manual_retry_failed', label: 'Manual retry failed' },
  { value: 'tid_burned_skip', label: 'TID already used' },
];

const fmtUgx = (n: number | null) => (n == null ? '—' : `UGX ${Math.round(n).toLocaleString()}`);

function outcomeBadge(outcome: string) {
  switch (outcome) {
    case 'matched_auto_approved':
    case 'matched_manual_retry_ok':
      return (
        <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 gap-1">
          <CheckCircle2 className="h-3 w-3" /> {outcome === 'matched_auto_approved' ? 'Auto-approved' : 'Manual OK'}
        </Badge>
      );
    case 'matched_approve_failed':
    case 'matched_manual_retry_failed':
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="h-3 w-3" /> {outcome === 'matched_approve_failed' ? 'Auto failed' : 'Manual failed'}
        </Badge>
      );
    case 'tid_burned_skip':
      return (
        <Badge variant="secondary" className="gap-1">
          <Ban className="h-3 w-3" /> TID burned
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="gap-1">
          <AlertTriangle className="h-3 w-3" /> {outcome}
        </Badge>
      );
  }
}

export function EmailPayoutMatchAuditPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [limit, setLimit] = useState<number>(25);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let q = supabase
        .from('email_payout_match_attempts')
        .select(
          'id,attempted_at,operator_id,withdrawal_id,email_id,email_transaction_id,withdrawal_amount,email_amount,amount_delta,recipient_phone_target,recipient_phone_email,payment_method,outcome,error_message,tolerance_amount_ugx,tolerance_phone_tail',
        )
        .order('attempted_at', { ascending: false })
        .limit(limit);
      if (filter !== 'all') q = q.eq('outcome', filter);
      const { data, error: err } = await q;
      if (err) throw err;
      setRows((data ?? []) as AuditRow[]);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load audit trail');
    } finally {
      setLoading(false);
    }
  }, [filter, limit]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const summary = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.outcome] = (c[r.outcome] ?? 0) + 1;
    return c;
  }, [rows]);

  return (
    <div className="p-3 sm:p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs font-semibold text-muted-foreground">Audit trail</div>
        <div className="flex-1" />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="text-xs border rounded-md bg-background px-2 py-1"
        >
          {OUTCOMES.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="text-xs border rounded-md bg-background px-2 py-1"
        >
          {[25, 50, 100, 200].map((n) => (
            <option key={n} value={n}>Last {n}</option>
          ))}
        </select>
        <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-1.5">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5 text-[10px]">
        {Object.entries(summary).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1">{outcomeBadge(k)} <span className="text-muted-foreground">×{v}</span></span>
        ))}
        {rows.length === 0 && !loading && (
          <span className="text-muted-foreground">No attempts recorded yet for this filter.</span>
        )}
      </div>

      {error && (
        <div className="text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-2">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr className="text-left">
              <th className="px-2 py-1.5 font-medium">When</th>
              <th className="px-2 py-1.5 font-medium">Outcome</th>
              <th className="px-2 py-1.5 font-medium">Phone (req → email)</th>
              <th className="px-2 py-1.5 font-medium">Amount (req → email)</th>
              <th className="px-2 py-1.5 font-medium">Δ</th>
              <th className="px-2 py-1.5 font-medium">TID</th>
              <th className="px-2 py-1.5 font-medium">Tol.</th>
              <th className="px-2 py-1.5 font-medium">Error</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="px-2 py-1.5 whitespace-nowrap font-mono">
                  {format(new Date(r.attempted_at), 'MMM d HH:mm:ss')}
                </td>
                <td className="px-2 py-1.5">{outcomeBadge(r.outcome)}</td>
                <td className="px-2 py-1.5 font-mono whitespace-nowrap">
                  {r.recipient_phone_target ?? '—'}
                  <span className="text-muted-foreground"> → </span>
                  {r.recipient_phone_email ?? '—'}
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  {fmtUgx(r.withdrawal_amount)}
                  <span className="text-muted-foreground"> → </span>
                  {fmtUgx(r.email_amount)}
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap font-mono">
                  {r.amount_delta == null
                    ? '—'
                    : `${r.amount_delta > 0 ? '+' : ''}${Math.round(r.amount_delta).toLocaleString()}`}
                </td>
                <td className="px-2 py-1.5 font-mono">{r.email_transaction_id ?? '—'}</td>
                <td className="px-2 py-1.5 font-mono whitespace-nowrap text-muted-foreground">
                  ±{(r.tolerance_amount_ugx ?? 0).toLocaleString()} · {r.tolerance_phone_tail ?? '—'}d
                </td>
                <td className="px-2 py-1.5 text-destructive max-w-[260px] truncate" title={r.error_message ?? ''}>
                  {r.error_message ?? ''}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="px-2 py-6 text-center text-muted-foreground">
                  No match attempts logged.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}