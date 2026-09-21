/**
 * The person and the call behind a concern.
 *
 * Everything shown here already exists elsewhere in the system and is read back
 * through one guarded reader (`cc_concern_context`), which returns nothing unless
 * the signed-in person may see the concern. No person is created here and no
 * figure is recalculated.
 */
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Phone, PhoneIncoming, PhoneOutgoing, UserRound } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useConcernCaseContext } from '@/hooks/useConcernAttachments';

const stamp = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const titleCase = (v?: string | null) => (v ? String(v).replace(/_/g, ' ') : null);

function Field({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <p className="min-w-0">
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-semibold">{value}</span>
    </p>
  );
}

export function ConcernCaseContextPanel({ concernId, fallbackName }: { concernId: string; fallbackName?: string | null }) {
  const q = useConcernCaseContext(concernId);
  const ctx = q.data ?? null;

  if (q.isLoading) return <Skeleton className="h-24 w-full rounded-xl" />;
  if (!ctx) return null;

  const received = ctx.call.kind === 'received_call';
  const person = ctx.person ?? {};
  const registered = !!ctx.person_id;
  const plan = person.active_plan ?? null;
  const name = person.full_name || ctx.call.caller_name_recorded || ctx.caller_name || fallbackName || 'Caller';
  const phone = person.phone || ctx.call.caller_phone_recorded || null;

  return (
    <div className="space-y-2 rounded-xl border border-border/70 bg-muted/20 p-2.5 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-bold">
          <UserRound className="h-3.5 w-3.5 text-primary" />
          {name}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="gap-1 text-[10px]">
            {received ? <PhoneIncoming className="h-3 w-3" /> : <PhoneOutgoing className="h-3 w-3" />}
            {received ? 'Call that came in' : 'Call we made'}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {registered ? 'Registered person' : 'Not registered'}
          </Badge>
          {ctx.subject_type && (
            <Badge variant="outline" className="text-[10px] capitalize">
              {titleCase(ctx.subject_type)}
            </Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-1 border-t border-border/60 pt-1.5 sm:grid-cols-2">
        <Field label="Phone" value={phone} />
        <Field label="Email" value={person.email} />
        <Field label="District" value={person.district} />
        <Field label="National ID" value={person.national_id} />
        <Field label="Responsible agent" value={person.agent_name} />
        <Field label="Agent phone" value={person.agent_phone} />
        <Field label="Account reference" value={person.user_id ? person.user_id.slice(0, 8).toUpperCase() : null} />
        <Field label="On the platform since" value={person.created_at ? stamp(person.created_at) : null} />
        {!registered && ctx.call.caller_name_recorded && (
          <Field label="Caller as recorded" value={ctx.call.caller_name_recorded} />
        )}
      </div>

      {plan && (
        <div className="grid grid-cols-1 gap-1 border-t border-border/60 pt-1.5 sm:grid-cols-2">
          <Field label="Rent Plan" value={titleCase(plan.status)} />
          <Field label="Rent amount" value={plan.rent_amount != null ? formatUGX(plan.rent_amount) : null} />
          <Field label="Plan total" value={plan.total_repayment != null ? formatUGX(plan.total_repayment) : null} />
          <Field label="Repaid so far" value={plan.amount_repaid != null ? formatUGX(plan.amount_repaid) : null} />
          <Field label="Daily payment" value={plan.daily_repayment != null ? formatUGX(plan.daily_repayment) : null} />
          <Field label="Plan started" value={plan.created_at ? stamp(plan.created_at) : null} />
        </div>
      )}

      <div className="space-y-1 border-t border-border/60 pt-1.5">
        <p className="flex items-center gap-1.5 font-bold">
          <Phone className="h-3 w-3 text-primary" />
          The original call
        </p>
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          <Field label="When" value={stamp(ctx.call.called_at)} />
          <Field label="Handled by" value={ctx.call.recorded_by_name} />
          <Field label="Call status" value={titleCase(ctx.call.call_status)} />
          <Field label="Outcome" value={titleCase(ctx.call.attempt_outcome)} />
          <Field label="Channel" value={titleCase(ctx.call.channel)} />
          <Field label="Attempt" value={ctx.call.attempt_no ? `No. ${ctx.call.attempt_no}` : null} />
          <Field label="Queue state" value={titleCase(ctx.call.row_state)} />
          <Field label="Feedback" value={ctx.call.feedback_category} />
          <Field label="Severity" value={titleCase(ctx.call.feedback_severity)} />
          <Field label="Follow-up due" value={ctx.call.follow_up_at ? stamp(ctx.call.follow_up_at) : null} />
        </div>
        {ctx.call.concern && (
          <p className="leading-snug">
            <span className="text-muted-foreground">What the caller said: </span>
            {ctx.call.concern}
          </p>
        )}
        {ctx.call.notes && (
          <p className="leading-snug">
            <span className="text-muted-foreground">Call notes: </span>
            {ctx.call.notes}
          </p>
        )}
        {ctx.call.feedback_note && (
          <p className="leading-snug">
            <span className="text-muted-foreground">Officer's note: </span>
            {ctx.call.feedback_note}
          </p>
        )}
        {ctx.call.follow_up_note && (
          <p className="leading-snug">
            <span className="text-muted-foreground">Follow-up note: </span>
            {ctx.call.follow_up_note}
          </p>
        )}
      </div>
    </div>
  );
}
