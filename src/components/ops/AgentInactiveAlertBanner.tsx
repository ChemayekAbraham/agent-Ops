import { useState } from 'react';
import {
  useAgentInactivations,
  useInactivationReview,
  type AgentInactivationRow,
} from '@/hooks/useAgentInactivations';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Phone,
  MapPin,
  UserX,
  Check,
  CheckCircle2,
  Loader2,
  Home,
  Shield,
  CalendarClock,
  Wallet,
  Undo2,
  MessageSquare,
} from 'lucide-react';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function Detail({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'muted' }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/60 px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={
          'text-xs font-semibold truncate ' +
          (tone === 'danger' ? 'text-destructive' : tone === 'muted' ? 'text-muted-foreground' : 'text-foreground')
        }
      >
        {value}
      </p>
    </div>
  );
}

interface Props {
  opsUserId: string | null;
  onOpenBehavior?: (tenantId: string) => void;
}

/**
 * Prominent Tenant Ops alert: tenants an agent recently flagged as "not paying".
 * Realtime — appears the moment an agent marks a tenant inactive.
 */
export function AgentInactiveAlertBanner({ opsUserId, onOpenBehavior }: Props) {
  const { data } = useAgentInactivations(opsUserId);
  const [expanded, setExpanded] = useState(true);

  const rows = data ?? [];
  if (rows.length === 0) return null;

  return (
    <div className="rounded-xl border-2 border-destructive/40 bg-destructive/5 overflow-hidden animate-fade-in">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 p-3.5 text-left hover:bg-destructive/10 transition-colors"
      >
        <div className="p-2 rounded-lg bg-destructive/15 shrink-0">
          <UserX className="h-5 w-5 text-destructive" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-destructive flex items-center gap-2">
            {rows.length} tenant{rows.length > 1 ? 's' : ''} flagged inactive by agents
            <Badge variant="destructive" className="h-5">Action needed</Badge>
          </p>
          <p className="text-xs text-muted-foreground">Agents marked these tenants as not paying. Review and follow up.</p>
        </div>
        {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <ul className="divide-y divide-destructive/15 border-t border-destructive/20">
          {rows.map((row) => (
            <InactivationRow key={row.rent_request_id} row={row} onOpenBehavior={onOpenBehavior} />
          ))}
        </ul>
      )}
    </div>
  );
}

function InactivationRow({
  row,
  onOpenBehavior,
}: {
  row: AgentInactivationRow;
  onOpenBehavior?: (tenantId: string) => void;
}) {
  const { toast } = useToast();
  const { roles } = useAuth();
  const { acknowledge, resolve, reject, cancelTenant } = useInactivationReview();
  const [resolving, setResolving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [notes, setNotes] = useState('');
  const isAcknowledged = row.review_status === 'acknowledged';
  const busy =
    acknowledge.isPending || resolve.isPending || reject.isPending || cancelTenant.isPending;

  /** Cancelling a tenant recalls money, so it is CFO / Finance Ops / COO / Operations only. */
  const canCancelTenant = (roles ?? []).some((r) =>
    ['cfo', 'financial_ops', 'coo', 'operations', 'manager', 'super_admin'].includes(r),
  );

  const closeForms = () => {
    setResolving(false);
    setRejecting(false);
    setCommenting(false);
    setCancelling(false);
    setNotes('');
  };


  const handleAcknowledge = async () => {
    try {
      await acknowledge.mutateAsync({ rentRequestId: row.rent_request_id });
      toast({ title: 'Marked as reviewed' });
    } catch (e: any) {
      toast({ title: 'Could not acknowledge', description: e?.message, variant: 'destructive' });
    }
  };

  const handleComment = async () => {
    if (notes.trim().length < 10) {
      toast({ title: 'Add a comment', description: 'At least 10 characters required.', variant: 'destructive' });
      return;
    }
    try {
      await acknowledge.mutateAsync({ rentRequestId: row.rent_request_id, notes });
      toast({ title: 'Comment saved' });
      closeForms();
    } catch (e: any) {
      toast({ title: 'Could not save comment', description: e?.message, variant: 'destructive' });
    }
  };

  const handleReject = async () => {
    if (notes.trim().length < 10) {
      toast({ title: 'Add a rejection reason', description: 'At least 10 characters required.', variant: 'destructive' });
      return;
    }
    try {
      await reject.mutateAsync({ rentRequestId: row.rent_request_id, notes });
      toast({
        title: 'Sent back to the agent',
        description: 'Tenant is back on the agent’s book with a follow-up task.',
      });
      closeForms();
    } catch (e: any) {
      toast({ title: 'Could not reject', description: e?.message, variant: 'destructive' });
    }
  };

  const handleResolve = async () => {
    if (notes.trim().length < 10) {
      toast({ title: 'Add resolution notes', description: 'At least 10 characters required.', variant: 'destructive' });
      return;
    }
    try {
      await resolve.mutateAsync({ rentRequestId: row.rent_request_id, notes });
      toast({ title: 'Marked as resolved' });
      closeForms();
    } catch (e: any) {
      toast({ title: 'Could not resolve', description: e?.message, variant: 'destructive' });
    }
  };

  const handleCancelTenant = async () => {
    if (notes.trim().length < 10) {
      toast({ title: 'Add a reason', description: 'At least 10 characters required.', variant: 'destructive' });
      return;
    }
    try {
      const res = await cancelTenant.mutateAsync({ rentRequestId: row.rent_request_id, reason: notes });
      const returned = Number(res?.float_returned ?? 0);
      const spent = Number(res?.float_already_paid_out ?? 0);
      toast({
        title: 'Tenant cancelled',
        description:
          `${formatUGX(returned)} landlord float returned to the platform.` +
          (spent > 0 ? ` ${formatUGX(spent)} was already paid out and is logged for CFO recovery.` : ''),
      });
      closeForms();
    } catch (e: any) {
      toast({ title: 'Could not cancel the tenant', description: e?.message, variant: 'destructive' });
    }
  };

  const formOpen = resolving || rejecting || commenting || cancelling;
  const formLabel = rejecting
    ? 'Why is this flag being rejected? The agent will see this. (required, min 10 characters)'
    : commenting
      ? 'Add a review comment for this tenant (required, min 10 characters)'
      : cancelling
        ? 'Why is this tenant being cancelled? The landlord float will be returned. (required, min 10 characters)'
        : 'What was done to resolve this? (required, min 10 characters)';


  return (
    <li className="p-3.5 flex flex-col gap-2 bg-card/40">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate flex items-center gap-2">
            {row.tenant_name ?? 'Unknown tenant'}
            {isAcknowledged && (
              <Badge variant="secondary" className="h-5 gap-1">
                <Check className="h-3 w-3" /> Reviewed
              </Badge>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground mt-0.5">
            {row.tenant_phone && (
              <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{row.tenant_phone}</span>
            )}
            {row.tenant_city && (
              <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{row.tenant_city}</span>
            )}
            {row.house_title && (
              <span className="flex items-center gap-1 truncate"><Home className="h-3 w-3" />{row.house_title}</span>
            )}
            {typeof row.trust_score === 'number' && (
              <span className="flex items-center gap-1"><Shield className="h-3 w-3" />Trust {Math.round(row.trust_score)}</span>
            )}
          </div>
        </div>
        <span className="text-[11px] text-muted-foreground whitespace-nowrap">{timeAgo(row.marked_at)}</span>
      </div>

      {/* Key tenant facts Ops needs before deciding */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
        <Detail label="Outstanding" value={formatUGX(row.outstanding ?? 0)} tone="danger" />
        <Detail label="Daily amount" value={formatUGX(row.daily_repayment ?? 0)} />
        <Detail label="Repaid" value={`${formatUGX(row.amount_repaid ?? 0)} / ${formatUGX(row.total_repayment ?? 0)}`} />
        <Detail
          label="Last collection"
          value={
            row.last_collection_at
              ? `${formatUGX(row.last_collection_amount ?? 0)} · ${row.days_since_last_collection ?? 0}d ago`
              : 'Never collected'
          }
          tone={row.last_collection_at ? undefined : 'danger'}
        />
        <Detail label="Collections" value={String(row.collections_count ?? 0)} />
        <Detail
          label="Funded"
          value={row.funded_at ? `${row.days_since_funded ?? 0}d ago` : 'Not funded'}
        />
        <Detail label="Landlord" value={row.landlord_name ?? '—'} tone={row.landlord_name ? undefined : 'muted'} />
        <Detail label="Agent" value={row.agent_name ?? '—'} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1"><Wallet className="h-3 w-3" />Rent {formatUGX(row.rent_amount ?? 0)}</span>
        {row.house_area && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{row.house_area}</span>}
        {row.landlord_phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />Landlord {row.landlord_phone}</span>}
        {row.agent_phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />Agent {row.agent_phone}</span>}
        {row.tenancy_status && (
          <span className="flex items-center gap-1"><CalendarClock className="h-3 w-3" />Tenancy {row.tenancy_status}</span>
        )}
      </div>

      <div className="flex items-start gap-2 rounded-lg bg-destructive/5 border border-destructive/15 p-2">
        <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
        <p className="text-xs text-foreground/80">
          <span className="text-muted-foreground">By {row.agent_name ?? 'agent'}:</span>{' '}
          {row.reason ?? 'No reason provided'}
        </p>
      </div>

      {isAcknowledged && (row.review_notes || row.reviewer_name) && (
        <p className="text-[11px] text-muted-foreground">
          {row.reviewer_name && <span>Reviewed by {row.reviewer_name}</span>}
          {row.acknowledged_at && <span> · {timeAgo(row.acknowledged_at)}</span>}
          {row.review_notes && <span className="block text-foreground/70 mt-0.5">“{row.review_notes}”</span>}
        </p>
      )}

      {formOpen ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-background/60 p-2">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={formLabel}
            rows={2}
            className="text-xs resize-none"
          />
          <div className="flex items-center gap-2">
            {rejecting ? (
              <Button size="sm" variant="destructive" className="h-8 gap-1" onClick={handleReject} disabled={busy}>
                {reject.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
                Reject &amp; send to agent
              </Button>
            ) : commenting ? (
              <Button size="sm" className="h-8 gap-1" onClick={handleComment} disabled={busy}>
                {acknowledge.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
                Save comment
              </Button>
            ) : (
              <Button size="sm" className="h-8 gap-1" onClick={handleResolve} disabled={busy}>
                {resolve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Confirm resolved
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-8" onClick={closeForms} disabled={busy}>
              Cancel
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            {rejecting
              ? 'Rejecting puts the tenant back as “paying” on the agent’s book and creates a high-priority follow-up task on their dashboard.'
              : 'Notes are saved to the audit trail.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {onOpenBehavior && (
            <Button variant="outline" size="sm" className="h-8" onClick={() => onOpenBehavior(row.tenant_id)}>
              Open tenant
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1"
            onClick={() => { setNotes(''); setCommenting(true); }}
            disabled={busy}
          >
            <MessageSquare className="h-4 w-4" /> Comment
          </Button>
          {!isAcknowledged && (
            <Button variant="secondary" size="sm" className="h-8 gap-1" onClick={handleAcknowledge} disabled={busy}>
              {acknowledge.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Acknowledge
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            className="h-8 gap-1"
            onClick={() => { setNotes(''); setRejecting(true); }}
            disabled={busy}
          >
            <Undo2 className="h-4 w-4" /> Reject
          </Button>
          <Button size="sm" className="h-8 gap-1" onClick={() => { setNotes(''); setResolving(true); }} disabled={busy}>
            <CheckCircle2 className="h-4 w-4" /> Resolve
          </Button>
        </div>
      )}
    </li>
  );
}

export default AgentInactiveAlertBanner;