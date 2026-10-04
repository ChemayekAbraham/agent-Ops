import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { PhoneCall, PhoneMissed, CheckCircle2, Loader2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import {
  useLogTenantCall,
  useTenantCallHistory,
  TENANT_CALL_STATUS_LABEL,
  type TenantCallStatus,
} from '@/hooks/useTenantCallReports';

interface Props {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  tenantName: string;
  tenantPhone?: string;
  rentRequestId?: string | null;
  missedDays?: number;
  dailyRepayment?: number;
  outstandingBalance?: number;
}

const STATUS_OPTIONS: {
  value: TenantCallStatus;
  icon: typeof PhoneCall;
  active: string;
  hint: string;
}[] = [
  { value: 'pending', icon: PhoneCall, active: 'border-amber-500/50 bg-amber-500/10 text-amber-600', hint: 'Follow-up still needed' },
  { value: 'closed', icon: CheckCircle2, active: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600', hint: 'Resolved, no more calls' },
  { value: 'missed', icon: PhoneMissed, active: 'border-destructive/50 bg-destructive/10 text-destructive', hint: 'Tenant not reached' },
];

export const callStatusBadgeClass = (status?: TenantCallStatus | null) =>
  status === 'closed'
    ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
    : status === 'missed'
      ? 'bg-destructive/15 text-destructive border-destructive/30'
      : 'bg-amber-500/15 text-amber-600 border-amber-500/30';

/** Records one call attempt. History is append-only — nothing is overwritten. */
export function LogTenantCallDialog({
  open, onClose, tenantId, tenantName, tenantPhone, rentRequestId,
  missedDays = 0, dailyRepayment = 0, outstandingBalance = 0,
}: Props) {
  const [status, setStatus] = useState<TenantCallStatus | null>(null);
  const [comment, setComment] = useState('');
  const logCall = useLogTenantCall();
  const { data: history, isLoading: histLoading } = useTenantCallHistory(open ? tenantId : null);

  const submit = async () => {
    if (!status) return;
    await logCall.mutateAsync({ tenantId, status, comment, rentRequestId });
    setStatus(null);
    setComment('');
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Log call · {tenantName}</DialogTitle>
          <DialogDescription className="text-xs">
            {tenantPhone || 'No phone on file'} · {history?.length || 0} call{(history?.length || 0) === 1 ? '' : 's'} recorded
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div className="rounded-lg bg-muted/50 p-2">
            <p className="text-[10px] text-muted-foreground">Days missed</p>
            <p className="text-sm font-semibold">{missedDays}</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2">
            <p className="text-[10px] text-muted-foreground">Daily payment</p>
            <p className="text-sm font-semibold break-all">{formatUGX(dailyRepayment)}</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2">
            <p className="text-[10px] text-muted-foreground">Total owed</p>
            <p className="text-sm font-semibold break-all">{formatUGX(outstandingBalance)}</p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {STATUS_OPTIONS.map(o => (
            <button
              key={o.value}
              onClick={() => setStatus(o.value)}
              title={o.hint}
              className={cn(
                'flex flex-col items-center justify-center gap-1 rounded-lg border py-3 text-[11px] font-medium transition-all',
                status === o.value ? o.active : 'border-border text-muted-foreground',
              )}
            >
              <o.icon className="h-4 w-4" />
              {TENANT_CALL_STATUS_LABEL[o.value]}
            </button>
          ))}
        </div>
        {status && (
          <p className="text-[11px] text-muted-foreground -mt-1">
            {STATUS_OPTIONS.find(o => o.value === status)?.hint}
          </p>
        )}

        <Textarea
          placeholder="Comment (optional) — what the tenant said, agreed date, etc."
          value={comment}
          onChange={e => setComment(e.target.value)}
          rows={3}
          className="text-xs"
        />

        <Button onClick={submit} disabled={!status || logCall.isPending} className="w-full h-10 text-xs">
          {logCall.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save call record'}
        </Button>

        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold text-muted-foreground">Call history</p>
          {histLoading ? (
            <p className="text-[11px] text-muted-foreground">Loading…</p>
          ) : !history?.length ? (
            <p className="text-[11px] text-muted-foreground">No calls recorded yet.</p>
          ) : (
            history.map(h => {
              const s = (h.status || (h.outcome === 'missed' ? 'missed' : 'pending')) as TenantCallStatus;
              return (
                <div key={h.id} className="rounded-lg border border-border/60 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="outline" className={cn('text-[9px] px-1.5', callStatusBadgeClass(s))}>
                      {TENANT_CALL_STATUS_LABEL[s]}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">
                      {format(new Date(h.called_at), 'dd MMM yyyy · HH:mm')}
                    </span>
                  </div>
                  {h.comment && <p className="mt-1 text-[11px] text-foreground">{h.comment}</p>}
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
