import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { AlertTriangle, Copy, CheckCheck } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';

/**
 * Surfaces any other operational-float deposit_requests that share the
 * same normalized MoMo TID as this one. Powered by the server-side
 * `flag_operational_float_tid_duplicates` trigger which also stamps
 * `audit_flagged = true` and writes an audit_logs row when it fires.
 *
 * Renders nothing when the request isn't operational-float or has no
 * digit-bearing TID, or when no conflicts exist.
 */

interface Props {
  request: {
    id?: string | null;
    transaction_id?: string | null;
    deposit_purpose?: string | null;
  } | null | undefined;
}

interface ConflictRow {
  id: string;
  amount: number | null;
  status: string | null;
  transaction_id: string | null;
  provider: string | null;
  created_at: string | null;
  user_id: string | null;
  deposit_purpose: string | null;
}

function normalize(tid: string | null | undefined): string | null {
  if (!tid) return null;
  const digits = tid.replace(/[^0-9]/g, '');
  return digits.length >= 6 ? digits : null;
}

export function DuplicateTidPanel({ request }: Props) {
  const [conflicts, setConflicts] = useState<ConflictRow[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  const normalized = normalize(request?.transaction_id);
  const applicable =
    request?.deposit_purpose === 'operational_float' && !!normalized && !!request?.id;

  useEffect(() => {
    if (!applicable) {
      setConflicts([]);
      return;
    }
    let cancelled = false;
    (async () => {
      // Pull every live op-float row and filter client-side by normalized
      // TID. Volume per agent is tiny and this avoids needing a custom RPC.
      const { data, error } = await supabase
        .from('deposit_requests')
        .select(
          'id, amount, status, transaction_id, provider, created_at, user_id, deposit_purpose',
        )
        .eq('deposit_purpose', 'operational_float')
        .neq('status', 'cancelled')
        .neq('id', request!.id!);
      if (cancelled || error || !data) return;
      const matches = (data as ConflictRow[]).filter(
        (r) => normalize(r.transaction_id) === normalized,
      );
      setConflicts(matches);
    })();
    return () => {
      cancelled = true;
    };
  }, [applicable, normalized, request?.id]);

  if (!applicable || conflicts.length === 0) return null;

  const copyId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
    toast.success('Request ID copied');
  };

  return (
    <div className="rounded-2xl border-2 border-warning/40 bg-warning/5 p-4 space-y-2">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-warning-foreground">
            Duplicate MoMo TID detected
          </p>
          <p className="text-[11px] text-muted-foreground">
            {conflicts.length} other operational-float row
            {conflicts.length === 1 ? '' : 's'} share the normalized TID{' '}
            <span className="font-mono font-semibold">{normalized}</span>. Verify
            which submission represents the real cash drop before approving.
          </p>
        </div>
      </div>
      <div className="space-y-1">
        {conflicts.map((c) => (
          <div
            key={c.id}
            className="rounded-lg border border-warning/30 bg-background p-2 space-y-0.5"
          >
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => copyId(c.id)}
                className="text-[10px] font-mono text-muted-foreground hover:text-foreground flex items-center gap-1"
                aria-label="Copy request ID"
              >
                {c.id.slice(0, 8)}…
                {copied === c.id ? (
                  <CheckCheck className="h-3 w-3 text-emerald-600" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </button>
              <span className="text-[10px] uppercase font-semibold">
                {c.status || '—'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
              <span>TID</span>
              <span className="font-mono text-right truncate">
                {c.transaction_id || '—'}
              </span>
              <span>Amount</span>
              <span className="text-right font-semibold tabular-nums">
                {c.amount != null ? formatUGX(c.amount) : '—'}
              </span>
              {c.provider && (
                <>
                  <span>Provider</span>
                  <span className="text-right uppercase">{c.provider}</span>
                </>
              )}
              {c.created_at && (
                <>
                  <span>Created</span>
                  <span className="text-right">
                    {format(new Date(c.created_at), 'MMM d, HH:mm')}
                  </span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default DuplicateTidPanel;