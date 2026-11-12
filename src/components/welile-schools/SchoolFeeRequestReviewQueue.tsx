import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { withUuidIds } from '@/lib/isUuid';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { STATUS_LABEL as PARTNERSHIP_LABEL, type PartnershipStatus } from '@/lib/welileSchoolsPartnership';
import {
  FEE_REQUEST_STATUS_LABEL, feeReviewErrorMessage, reviewFeeRequest,
  type FeeRequestDecision, type FeeRequestRow, type FeeRequestStatus,
} from '@/lib/welileSchoolsFeeRequests';

// Not in the generated Supabase types until Lovable regenerates them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;
const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString('en-UG')}`;
const QUEUE_KEY = ['welile-school-fee-request-queue'];

type Filter = 'submitted' | 'all';
type Person = { id: string; full_name: string | null; phone: string | null };

async function fetchQueue() {
  const { data, error } = await db.from('welile_school_fee_requests').select('*').order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  const rows = (data ?? []) as (FeeRequestRow & { requested_by: string; reviewed_at: string | null })[];
  const schoolIds = Array.from(new Set(rows.map((r) => r.school_id)));
  const agentIds = Array.from(new Set(rows.map((r) => r.requested_by)));
  const [schoolsRes, partnershipsRes, agentsRes] = await Promise.all([
    schoolIds.length ? db.from('welile_schools').select('id, name, district').in('id', schoolIds) : { data: [] },
    schoolIds.length ? db.from('welile_school_partnerships').select('school_id, status').in('school_id', schoolIds) : { data: [] },
    agentIds.length ? withUuidIds(agentIds, (ids) => db.from('profiles').select('id, full_name, phone').in('id', ids)) : { data: [] },
  ]);
  const schools: Record<string, { name: string; district: string | null }> = {};
  ((schoolsRes.data ?? []) as { id: string; name: string; district: string | null }[]).forEach((s) => { schools[s.id] = s; });
  const partnership: Record<string, PartnershipStatus> = {};
  ((partnershipsRes.data ?? []) as { school_id: string; status: PartnershipStatus }[]).forEach((p) => { partnership[p.school_id] = p.status; });
  const agents: Record<string, Person> = {};
  ((((agentsRes as { data?: Person[] | null }).data) ?? [])).forEach((a) => { agents[a.id] = a; });
  return { rows, schools, partnership, agents };
}

const TONE: Record<FeeRequestStatus, string> = {
  submitted: 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200',
  approved: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200',
  rejected: 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200',
  cancelled: 'bg-muted text-muted-foreground',
};

/**
 * Agent Ops → Welile Schools → Fee requests: School Fees Plan requests sent by school agents.
 * Ops approve (needs the school's partnership approved) or reject with a reason.
 * Approving does not pay the school yet; that is a later step.
 */
export default function SchoolFeeRequestReviewQueue() {
  const [filter, setFilter] = useState<Filter>('submitted');
  const { data, isLoading, error } = useQuery({ queryKey: QUEUE_KEY, queryFn: fetchQueue, staleTime: 30_000 });
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const waiting = rows.filter((r) => r.status === 'submitted');
  const shown = useMemo(() => rows.filter((r) => filter === 'all' || r.status === 'submitted'), [rows, filter]);

  if (isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>;
  if (error) return <Card className="p-4 text-sm text-destructive">Could not load fee requests: {feeReviewErrorMessage(error)}</Card>;

  const waitingTotal = waiting.reduce((s, r) => s + Number(r.term_fee), 0);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Card className="p-3"><p className="text-xs text-muted-foreground">Waiting for approval</p><p className="text-xl font-bold tabular-nums">{waiting.length}</p></Card>
        <Card className="p-3"><p className="text-xs text-muted-foreground">Fees requested (waiting)</p><p className="text-xl font-bold tabular-nums">{ugx(waitingTotal)}</p></Card>
        <Card className="p-3"><p className="text-xs text-muted-foreground">Approved</p><p className="text-xl font-bold tabular-nums">{rows.filter((r) => r.status === 'approved').length}</p></Card>
      </div>

      <div className="flex flex-wrap gap-2">
        {([['submitted', `Waiting for approval (${waiting.length})`], ['all', 'All requests']] as const).map(([k, label]) => (
          <Button key={k} size="sm" variant={filter === k ? 'default' : 'outline'} className="min-h-[40px]" onClick={() => setFilter(k)}>{label}</Button>
        ))}
      </div>

      {shown.length === 0 && (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          {filter === 'submitted' ? 'No fee request is waiting for approval.' : 'No school agent has requested school fees yet.'}
        </Card>
      )}
      {shown.map((r) => (
        <RequestCard key={r.id} r={r} school={data!.schools[r.school_id]} partnership={data!.partnership[r.school_id] ?? null} agent={data!.agents[r.requested_by]} />
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-medium">{value || '—'}</span>
    </div>
  );
}

function RequestCard({ r, school, partnership, agent }: {
  r: FeeRequestRow & { reviewed_at: string | null };
  school?: { name: string; district: string | null };
  partnership: PartnershipStatus | null;
  agent?: Person;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<FeeRequestDecision | null>(null);
  const schoolReady = partnership === 'approved';

  const decide = async (decision: FeeRequestDecision) => {
    if (decision === 'reject' && note.trim().length < 5) { toast.error('Write a reason for the agent (at least 5 characters)'); return; }
    setBusy(decision);
    try {
      await reviewFeeRequest(r.id, decision, note.trim());
      toast.success(decision === 'approve' ? `${r.student_name}'s request approved` : 'Request rejected');
      setNote('');
      qc.invalidateQueries({ queryKey: QUEUE_KEY });
      qc.invalidateQueries({ queryKey: ['welile-school-fee-requests', r.school_id] });
    } catch (e) {
      toast.error('Could not save the decision', { description: feeReviewErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">{r.student_name}{r.class_grade ? <span className="font-normal text-muted-foreground"> · {r.class_grade}</span> : null}</p>
          <p className="text-xs text-muted-foreground">{[school?.name, school?.district].filter(Boolean).join(' · ') || 'Unknown school'}</p>
        </div>
        <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold', TONE[r.status])}>{FEE_REQUEST_STATUS_LABEL[r.status]}</span>
      </div>

      {/* The money side of the plan, as fixed when the agent sent it. */}
      <div className="grid grid-cols-3 gap-2 rounded-xl bg-primary/5 p-3 text-center">
        <div><p className="text-[11px] text-muted-foreground">Term fee</p><p className="text-sm font-bold tabular-nums">{ugx(Number(r.term_fee))}</p></div>
        <div><p className="text-[11px] text-muted-foreground">Plan length</p><p className="text-sm font-bold tabular-nums">{r.plan_days} days</p></div>
        <div><p className="text-[11px] text-muted-foreground">On schedule</p><p className="text-sm font-bold tabular-nums">{ugx(Number(r.total_on_schedule))}</p></div>
      </div>

      <div className="space-y-1.5 rounded-xl bg-muted/50 p-3">
        <Row label="Parent / guardian" value={[r.guardian_name, r.guardian_phone].filter(Boolean).join(' · ')} />
        <Row label="Guarantor" value={[r.guarantor_name, r.guarantor_phone].filter(Boolean).join(' · ')} />
        <Row label="Term" value={`${r.term_start ? `${r.term_start} to ` : 'ends '}${r.term_end} · plan due ${r.plan_due_date}`} />
        <Row label="Daily fee rate" value={`${(Number(r.daily_rate) * 100).toFixed(3)}% on the balance`} />
        <Row label="School agent" value={[agent?.full_name, agent?.phone].filter(Boolean).join(' · ')} />
        <Row label="Sent" value={new Date(r.created_at).toLocaleString('en-UG')} />
        <Row label="School partnership" value={partnership ? PARTNERSHIP_LABEL[partnership] : 'Not started'} />
      </div>

      {r.review_note && r.status !== 'submitted' ? <p className="text-sm"><span className="text-muted-foreground">Note: </span>{r.review_note}</p> : null}

      {r.status === 'submitted' && (
        <div className="space-y-2 border-t border-border pt-3">
          {!schoolReady && (
            <p className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              Approve the school's partnership first (Partnerships tab). Welile can only pay a school whose payout account is verified.
            </p>
          )}
          <Textarea aria-label="Note for the agent" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the agent (required to reject)" rows={2} />
          <div className="grid grid-cols-2 gap-2">
            <Button className="min-h-[44px] gap-2 bg-emerald-600 text-white hover:bg-emerald-700" disabled={!!busy || !schoolReady} onClick={() => decide('approve')}>
              {busy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Approve
            </Button>
            <Button variant="outline" className="min-h-[44px] gap-2 border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={!!busy} onClick={() => decide('reject')}>
              {busy === 'reject' ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}Reject
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Approving does not pay the school yet. Paying the school is the next step.</p>
        </div>
      )}
    </Card>
  );
}
