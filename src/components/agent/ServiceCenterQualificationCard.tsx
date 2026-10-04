import { useState } from 'react';
import { Lock, RefreshCw, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { hapticTap } from '@/lib/haptics';
import { useServiceCenterQualification } from '@/hooks/useServiceCenterQualification';
import { ServiceCenterRequestDialog } from './ServiceCenterRequestDialog';

const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`;

function Metric({
  label,
  value,
  target,
  met,
}: {
  label: string;
  value: number;
  target: number;
  met?: boolean;
}) {
  const pct = target ? Math.min(100, (value / target) * 100) : 100;
  return (
    <div className="space-y-2">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      <div className="text-3xl font-semibold tabular-nums leading-none text-primary">
        {value}
        <span className="text-base font-normal text-muted-foreground"> / {target}</span>
      </div>
      <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-500', met ? 'bg-success' : 'bg-primary')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function ServiceCenterQualificationCard({ agentId }: { agentId: string }) {
  const { data, isLoading, isError, refetch } = useServiceCenterQualification(agentId);
  const [infoOpen, setInfoOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border/60 bg-card p-5 space-y-5">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-3 w-64" />
        <div className="grid grid-cols-2 gap-6">
          <Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" />
        </div>
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-xl border border-border/60 bg-card p-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          We could not load your service center qualification progress.
        </p>
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
        </Button>
      </div>
    );
  }

  const status: string = data.request_status;
  const subsLeft = data.remaining_sub_agents;
  const tenantsLeft = data.remaining_personal_tenants;

  let message: string;
  if (status === 'pending_review') message = 'Your service center request is under review.';
  else if (status === 'approved') message = 'Your free Welile Service Center has been approved.';
  else if (status === 'rejected') message = 'Your request was not approved. Review the feedback and apply again when eligible.';
  else if (data.is_qualified) message = 'You have completed the service center qualification requirements.';
  else if (subsLeft > 0 && tenantsLeft > 0)
    message = `You need ${plural(subsLeft, 'more active sub-agent')} and ${plural(tenantsLeft, 'more personal tenant')} to qualify.`;
  else if (subsLeft === 0)
    message = `Your team requirement is complete. Add ${plural(tenantsLeft, 'more active tenant')} to qualify.`;
  else
    message = `Your personal tenant requirement is complete. Activate ${plural(subsLeft, 'more sub-agent')} to qualify.`;

  const badge =
    status === 'approved'
      ? { label: 'Approved', cls: 'bg-success/15 text-success', Icon: CheckCircle2 }
      : status === 'pending_review'
      ? { label: 'Under review', cls: 'bg-primary/15 text-primary', Icon: Clock }
      : status === 'rejected'
      ? { label: 'Not approved', cls: 'bg-destructive/15 text-destructive', Icon: XCircle }
      : data.is_qualified
      ? { label: 'Qualified', cls: 'bg-success/15 text-success', Icon: CheckCircle2 }
      : { label: 'Not qualified', cls: 'bg-warning/15 text-warning', Icon: Clock };

  const buttonLabel =
    status === 'pending_review' ? 'Request Under Review'
    : status === 'approved' ? 'Service Center Approved'
    : status === 'rejected' ? 'Review Request'
    : data.is_qualified ? 'Request Free Service Center'
    : 'Request Service Center';

  const buttonDisabled =
    status === 'pending_review' || status === 'approved' || (status !== 'rejected' && !data.is_qualified);

  const onButton = () => {
    hapticTap();
    if (status === 'rejected') { setInfoOpen(true); return; }
    setRequestOpen(true);
  };

  const locked = buttonDisabled && !data.is_qualified && status !== 'rejected';

  return (
    <div className="rounded-xl border border-border/60 bg-card p-5 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-primary">Free Service Center</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Build an active rent-collection team to qualify.
          </p>
        </div>
        <span className={cn('shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium', badge.cls)}>
          <badge.Icon className="h-3 w-3" /> {badge.label}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <Metric
          label="Active sub-agents"
          value={data.qualifying_sub_agents}
          target={data.required_sub_agents}
          met={data.sub_agent_requirement_met}
        />
        <Metric
          label="Your active tenants"
          value={data.main_agent_active_tenants}
          target={data.required_main_agent_tenants}
          met={data.personal_tenant_requirement_met}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        Network active tenants: <span className="tabular-nums">{data.network_active_tenants}</span>
      </p>

      <p className="text-[13px] leading-snug text-foreground">{message}</p>
      {status === 'rejected' && data.decision_reason && (
        <p className="text-xs text-destructive">Feedback: {data.decision_reason}</p>
      )}

      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <button
          type="button"
          className="sm:order-1 self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => { hapticTap(); setInfoOpen(true); }}
        >
          How qualification works
        </button>
        <div className="sm:order-2 sm:ml-auto w-full sm:w-auto space-y-1.5">
          <Button
            className={cn('w-full sm:w-auto', locked && 'bg-muted text-muted-foreground hover:bg-muted')}
            disabled={buttonDisabled}
            onClick={onButton}
          >
            {locked && <Lock className="h-3.5 w-3.5 mr-1.5" />}
            {buttonLabel}
          </Button>
          {locked && (
            <p className="text-[11px] text-muted-foreground sm:text-right">Complete both requirements to unlock.</p>
          )}
        </div>
      </div>

      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>How qualification works</DialogTitle></DialogHeader>
          <ul className="space-y-2 text-sm text-muted-foreground list-disc pl-4">
            <li>An active sub-agent must manage at least one active tenant with a live rent collection or repayment arrangement.</li>
            <li>You must personally manage at least {data.required_main_agent_tenants} active tenants.</li>
            <li>Network active tenants are informational only and do not affect eligibility.</li>
            <li>All activity must be valid and verified.</li>
            <li>Qualification unlocks the request but does not guarantee immediate approval.</li>
          </ul>
          {status === 'rejected' && data.decision_reason && (
            <p className="text-sm text-destructive">Review feedback: {data.decision_reason}</p>
          )}
        </DialogContent>
      </Dialog>

      <ServiceCenterRequestDialog
        open={requestOpen}
        onOpenChange={setRequestOpen}
        agentId={agentId}
        qualification={data}
        onSubmitted={() => refetch()}
      />
    </div>
  );
}

export default ServiceCenterQualificationCard;