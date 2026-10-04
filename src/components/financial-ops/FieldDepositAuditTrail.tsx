import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import {
  CheckCircle2,
  Coins,
  FileText,
  PackagePlus,
  Loader2,
  XCircle,
  Ban,
} from 'lucide-react';
import {
  BatchAuditEntry,
  BatchAuditEvent,
  auditEventLabel,
  listBatchAuditTrail,
} from '@/lib/fieldDepositBatches';

const ICONS: Record<BatchAuditEvent, JSX.Element> = {
  created: <PackagePlus className="h-3.5 w-3.5" />,
  proof_submitted: <FileText className="h-3.5 w-3.5" />,
  finops_verified: <CheckCircle2 className="h-3.5 w-3.5" />,
  allocation_completed: <Coins className="h-3.5 w-3.5" />,
  rejected: <XCircle className="h-3.5 w-3.5" />,
  cancelled: <Ban className="h-3.5 w-3.5" />,
};

const TONE: Record<BatchAuditEvent, string> = {
  created: 'bg-muted text-muted-foreground',
  proof_submitted: 'bg-primary/10 text-primary',
  finops_verified: 'bg-success/10 text-success',
  allocation_completed: 'bg-success/10 text-success',
  rejected: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
};

function formatDetails(e: BatchAuditEntry): string | null {
  const d = e.details ?? {};
  switch (e.event) {
    case 'created':
      return d.channel ? `Channel: ${d.channel}` : null;
    case 'proof_submitted':
      return d.proof_reference ? `Ref: ${d.proof_reference}` : null;
    case 'finops_verified':
      return d.proof_entered ? `Verified ref: ${d.proof_entered}` : null;
    case 'allocation_completed':
      return `${d.allocations ?? 0} tenant(s) · commission booked`;
    case 'rejected':
      return d.reason ?? null;
    default:
      return null;
  }
}

interface Props {
  batchId: string;
}

export function FieldDepositAuditTrail({ batchId }: Props) {
  const [entries, setEntries] = useState<BatchAuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    listBatchAuditTrail(batchId)
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? 'Failed to load audit trail');
      });
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  return (
    <div>
      <div className="text-xs font-semibold text-muted-foreground mb-2">Audit trail</div>
      <div className="rounded-lg border bg-background/40 p-3">
        {entries === null && !error && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        )}
        {error && <div className="text-xs text-destructive">{error}</div>}
        {entries && entries.length === 0 && (
          <div className="text-xs text-muted-foreground">No events recorded yet.</div>
        )}
        {entries && entries.length > 0 && (
          <ol className="space-y-2.5">
            {entries.map((e) => {
              const detail = formatDetails(e);
              return (
                <li key={e.id} className="flex gap-2.5 text-xs">
                  <span
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${TONE[e.event]}`}
                  >
                    {ICONS[e.event]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground">
                        {auditEventLabel(e.event)}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {format(new Date(e.created_at), 'MMM d, HH:mm')}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      by {e.actor_name ?? (e.actor_role ?? 'system')}
                    </div>
                    {detail && (
                      <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/90">
                        {detail}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}