import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RefreshCw, ShieldCheck, Inbox } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';

interface ReviewRow {
  id: string;
  partner_id: string;
  partner_name: string;
  partner_phone: string | null;
  portfolio_code: string | null;
  amount: number;
  lines_count: number;
  prorata_amount: number;
  prorata_days: number;
  days_in_cycle: number;
  monthly_rate: number | null;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  review_notes: string | null;
  rejection_reason: string | null;
  partner_available_balance: number;
}

type StatusFilter = 'pending_review' | 'approved' | 'rejected';

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'pending_review', label: 'Awaiting review' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

/**
 * Partner Ops review queue for self-managed partner top-ups.
 * The partner's capital stays in their wallet until a reviewer confirms here.
 */
export function SelfManagedTopUpReviews() {
  const [status, setStatus] = useState<StatusFilter>('pending_review');
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<ReviewRow | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('partner_ops_list_self_topup_reviews', {
      p_status: status,
      p_limit: 100,
    });
    if (error) {
      toast.error(error.message);
      setRows([]);
    } else {
      const payload = (data ?? {}) as { rows?: ReviewRow[] };
      setRows(payload.rows ?? []);
    }
    setLoading(false);
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = async (row: ReviewRow) => {
    setBusyId(row.id);
    const { error } = await supabase.rpc('partner_ops_approve_self_topup', {
      p_topup_id: row.id,
      p_notes: null,
    });
    setBusyId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    // Approval already released the principal as landlord float and queued the
    // agent notices (DB-side). Drain the SMS queue — never blocks the approval.
    void supabase.functions.invoke('notify-partner-float-agents', {
      body: { commitment_id: (row as any).commitment_id ?? null },
    });
    // Partner confirmation email for the deployed top-up (fire-and-forget).
    void supabase.functions.invoke('notify-self-topup-approved', {
      body: { topup_id: row.id },
    });
    toast.success(`Top-up of ${formatUGX(Number(row.amount))} confirmed and now earning.`);
    await load();
  };

  const reject = async () => {
    if (!rejectTarget) return;
    if (reason.trim().length < 10) {
      toast.error('Please give a reason of at least 10 characters.');
      return;
    }
    setBusyId(rejectTarget.id);
    const { error } = await supabase.rpc('partner_ops_reject_self_topup', {
      p_topup_id: rejectTarget.id,
      p_reason: reason.trim(),
    });
    setBusyId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success('Top-up rejected. The selected plans are back in the pool.');
    setRejectTarget(null);
    setReason('');
    await load();
  };

  return (
    <Card className="p-4 rounded-2xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary shrink-0" />
            <h3 className="text-sm font-black tracking-tight">Self-managed top-ups — review</h3>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">
            Partners see their top-up as submitted, but the capital stays in their wallet until you
            confirm it here. Approving moves the capital and attaches the tenant plans.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            size="sm"
            variant={status === f.key ? 'default' : 'outline'}
            className="rounded-full text-[11px] h-7"
            onClick={() => setStatus(f.key)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-20 w-full rounded-xl" />
        </div>
      ) : rows.length === 0 ? (
        <div className="flex items-center gap-2 rounded-xl bg-muted/40 px-3 py-4">
          <Inbox className="h-4 w-4 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">Nothing here right now.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const short = Number(row.partner_available_balance) < Number(row.amount);
            return (
              <div key={row.id} className="rounded-xl border border-border p-3 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold truncate">{row.partner_name}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {row.portfolio_code ?? 'Portfolio'} · {row.lines_count} plan
                      {row.lines_count === 1 ? '' : 's'} ·{' '}
                      {format(new Date(row.created_at), 'd MMM yyyy, HH:mm')}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-black">{formatUGX(Number(row.amount))}</p>
                    <Badge variant="secondary" className="text-[10px] mt-1">
                      {row.status === 'pending_review'
                        ? 'Awaiting review'
                        : row.status === 'approved'
                          ? 'Approved'
                          : 'Rejected'}
                    </Badge>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {[
                    {
                      label: 'Rest of month',
                      value: formatUGX(Number(row.prorata_amount)),
                    },
                    {
                      label: 'Monthly rate',
                      value: `${Number(row.monthly_rate ?? 15)}%`,
                    },
                    {
                      label: 'Wallet available',
                      value: formatUGX(Number(row.partner_available_balance)),
                    },
                  ].map((f) => (
                    <div key={f.label} className="rounded-lg bg-muted/40 px-2 py-1.5 min-w-0">
                      <p className="text-[9px] uppercase tracking-wide font-semibold text-muted-foreground truncate">
                        {f.label}
                      </p>
                      <p className="text-[11px] font-black mt-0.5 truncate">{f.value}</p>
                    </div>
                  ))}
                </div>

                {row.status === 'pending_review' && short && (
                  <p className="text-[10px] font-semibold text-destructive">
                    Partner wallet no longer covers this top-up — approval will be blocked.
                  </p>
                )}

                {row.review_notes && (
                  <p className="text-[10px] text-muted-foreground">Notes: {row.review_notes}</p>
                )}
                {row.rejection_reason && (
                  <p className="text-[10px] text-destructive">Reason: {row.rejection_reason}</p>
                )}

                {row.status === 'pending_review' && (
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      className="rounded-xl text-[11px] h-8"
                      disabled={busyId === row.id}
                      onClick={() => void approve(row)}
                    >
                      {busyId === row.id ? 'Confirming…' : 'Confirm & apply capital'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-xl text-[11px] h-8"
                      disabled={busyId === row.id}
                      onClick={() => {
                        setRejectTarget(row);
                        setReason('');
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={!!rejectTarget} onOpenChange={(v) => !v && setRejectTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Reject top-up</DialogTitle>
            <DialogDescription className="text-xs">
              The selected tenant plans go back to the open pool and no capital moves.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this top-up rejected? (minimum 10 characters)"
            className="text-xs"
          />
          <p className="text-[10px] text-muted-foreground">{reason.trim().length}/10 characters</p>
          <Button
            variant="destructive"
            className="rounded-xl"
            disabled={reason.trim().length < 10 || !!busyId}
            onClick={() => void reject()}
          >
            Confirm rejection
          </Button>
        </DialogContent>
      </Dialog>
    </Card>
  );
}