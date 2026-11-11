import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileText, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { withUuidIds } from '@/lib/isUuid';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { SchoolRow } from '@/lib/welileSchools';
import {
  STATUS_LABEL, agreementUrl, partnershipErrorMessage, reviewPartnership,
  type FeeRow, type PartnershipRow, type PartnershipStatus, type ReviewDecision, type TermRow,
} from '@/lib/welileSchoolsPartnership';

const db = supabase as any;
const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString('en-UG')}`;
const FILTERS: { key: 'submitted' | 'all'; label: string }[] = [
  { key: 'submitted', label: 'Waiting for approval' },
  { key: 'all', label: 'All partnerships' },
];

async function fetchQueue() {
  const { data: partnerships, error } = await db.from('welile_school_partnerships').select('*').order('submitted_at', { ascending: false, nullsFirst: false });
  if (error) throw error;
  const rows = (partnerships ?? []) as PartnershipRow[];
  const schoolIds = rows.map((p) => p.school_id);
  const agentIds = Array.from(new Set(rows.map((p) => p.agent_id)));
  const [schoolsRes, termsRes, agentsRes] = await Promise.all([
    schoolIds.length ? db.from('welile_schools').select('*').in('id', schoolIds) : { data: [] },
    schoolIds.length ? db.from('welile_school_terms').select('*').in('school_id', schoolIds).order('start_date') : { data: [] },
    agentIds.length ? withUuidIds(agentIds, (ids) => db.from('profiles').select('id, full_name, phone').in('id', ids)) : { data: [] },
  ]);
  const terms = (termsRes.data ?? []) as TermRow[];
  let fees: FeeRow[] = [];
  if (terms.length) {
    const { data } = await db.from('welile_school_fee_structures').select('*').in('term_id', terms.map((t) => t.id)).order('class_name');
    fees = (data ?? []) as FeeRow[];
  }
  const schools: Record<string, SchoolRow> = {};
  ((schoolsRes.data ?? []) as SchoolRow[]).forEach((s) => { schools[s.id] = s; });
  const agents: Record<string, { full_name: string | null; phone: string | null }> = {};
  ((agentsRes as any).data ?? []).forEach((a: any) => { agents[a.id] = a; });
  return { partnerships: rows, schools, terms, fees, agents };
}

/** Ops queue for Welile Schools partnerships (PRD screen 3). */
export default function SchoolPartnershipReviewQueue() {
  const [filter, setFilter] = useState<'submitted' | 'all'>('submitted');
  const { data, isLoading, error } = useQuery({ queryKey: ['welile-school-partnership-queue'], queryFn: fetchQueue, staleTime: 30_000 });

  const shown = useMemo(
    () => (data?.partnerships ?? []).filter((p) => filter === 'all' || p.status === 'submitted'),
    [data, filter],
  );
  const waiting = (data?.partnerships ?? []).filter((p) => p.status === 'submitted').length;

  if (isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>;
  if (error) return <Card className="p-4 text-sm text-destructive">Could not load partnerships: {partnershipErrorMessage(error)}</Card>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button key={f.key} size="sm" variant={filter === f.key ? 'default' : 'outline'} className="min-h-[40px]" onClick={() => setFilter(f.key)}>
            {f.label}{f.key === 'submitted' ? ` (${waiting})` : ''}
          </Button>
        ))}
      </div>
      {shown.length === 0 && (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          {filter === 'submitted' ? 'No school is waiting for approval.' : 'No school has started a partnership yet.'}
        </Card>
      )}
      {shown.map((p) => (
        <PartnershipCard key={p.id} p={p} school={data!.schools[p.school_id]} agent={data!.agents[p.agent_id]}
          terms={data!.terms.filter((t) => t.school_id === p.school_id)} fees={data!.fees} />
      ))}
    </div>
  );
}

const TONE: Record<PartnershipStatus, string> = {
  draft: 'bg-muted text-foreground',
  submitted: 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200',
  changes_requested: 'bg-orange-100 text-orange-900 dark:bg-orange-900/30 dark:text-orange-200',
  approved: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200',
  rejected: 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200',
  suspended: 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200',
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right font-medium break-words">{value || '—'}</span>
    </div>
  );
}

function PartnershipCard({ p, school, agent, terms, fees }: {
  p: PartnershipRow; school?: SchoolRow; agent?: { full_name: string | null; phone: string | null }; terms: TermRow[]; fees: FeeRow[];
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<ReviewDecision | null>(null);

  const decide = async (decision: ReviewDecision) => {
    if (decision !== 'approve' && note.trim().length < 5) { toast.error('Write a note for the agent (at least 5 characters)'); return; }
    setBusy(decision);
    try {
      await reviewPartnership(p.id, decision, note.trim());
      toast.success(decision === 'approve' ? `${school?.name ?? 'School'} approved` : decision === 'reject' ? 'Partnership rejected' : 'Sent back to the agent');
      setNote('');
      qc.invalidateQueries({ queryKey: ['welile-school-partnership-queue'] });
      qc.invalidateQueries({ queryKey: ['welile-school-setup', p.school_id] });
    } catch (e) {
      toast.error('Could not save the decision', { description: partnershipErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const openAgreement = async () => {
    if (!p.agreement_path) return;
    const url = await agreementUrl(p.agreement_path);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    else toast.error('Could not open the agreement');
  };

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">{school?.name ?? 'Unknown school'}</p>
          <p className="text-xs text-muted-foreground">{[school?.school_level, school?.district, school?.village].filter(Boolean).join(' · ')}</p>
        </div>
        <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold', TONE[p.status])}>{STATUS_LABEL[p.status]}</span>
      </div>

      <div className="space-y-1.5 rounded-xl bg-muted/50 p-3">
        <Row label="School agent" value={[agent?.full_name, agent?.phone].filter(Boolean).join(' · ')} />
        <Row label="Head teacher" value={[school?.head_name, school?.head_phone].filter(Boolean).join(' · ')} />
        <Row label="Bursar" value={[p.bursar_name, p.bursar_phone].filter(Boolean).join(' · ')} />
        <Row label="Pay fees to" value={p.payout_method ? `${p.payout_method === 'bank' ? 'Bank' : 'Mobile money'}: ${p.payout_provider ?? ''}` : null} />
        <Row label="Account" value={[p.payout_account_name, p.payout_account_number].filter(Boolean).join(' · ')} />
        <Row label="Submitted" value={p.submitted_at ? new Date(p.submitted_at).toLocaleString('en-UG') : null} />
      </div>

      <div className="space-y-2">
        {terms.length === 0 && <p className="text-sm text-muted-foreground">No terms recorded.</p>}
        {terms.map((t) => (
          <div key={t.id} className="rounded-xl border border-border p-3">
            <p className="text-sm font-medium">{t.name}</p>
            <p className="text-xs text-muted-foreground">{t.start_date} to {t.end_date} · plans due {t.plan_due_date}</p>
            <ul className="mt-1.5 space-y-0.5">
              {fees.filter((f) => f.term_id === t.id).map((f) => (
                <li key={f.id} className="flex justify-between gap-2 text-sm">
                  <span>{f.class_name} <span className="text-muted-foreground">· {f.boarding_status === 'boarding' ? 'Boarding' : 'Day'}</span></span>
                  <span className="tabular-nums">{ugx(Number(f.amount))}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <Button variant="outline" className="min-h-[44px] w-full gap-2" disabled={!p.agreement_path} onClick={openAgreement}>
        <FileText className="h-4 w-4" />{p.agreement_path ? 'Open the signed agreement' : 'No agreement uploaded'}
      </Button>

      {p.review_note && p.status !== 'submitted' && <p className="text-sm"><span className="text-muted-foreground">Last note: </span>{p.review_note}</p>}

      {p.status === 'submitted' && (
        <div className="space-y-2 border-t border-border pt-3">
          <Textarea aria-label="Note for the agent" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the agent (required to send back or reject)" rows={2} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Button className="min-h-[44px] gap-2 bg-emerald-600 text-white hover:bg-emerald-700" disabled={!!busy} onClick={() => decide('approve')}>
              {busy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Approve
            </Button>
            <Button variant="outline" className="min-h-[44px] gap-2" disabled={!!busy} onClick={() => decide('request_changes')}>
              {busy === 'request_changes' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}Ask for changes
            </Button>
            <Button variant="outline" className="min-h-[44px] gap-2 border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={!!busy} onClick={() => decide('reject')}>
              {busy === 'reject' ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}Reject
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
