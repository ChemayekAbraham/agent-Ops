import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Check, CheckCircle2, ChevronDown, Loader2, Search, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import { fetchSchoolSetup } from '@/lib/welileSchoolsPartnership';
import { planDaysUntil, planSummary } from '@/lib/welileSchoolsFeePlan';
import {
  FEE_REQUEST_STATUS_LABEL, fetchFeeRequests, feeRequestErrorMessage, submitFeeRequest,
  type FeeRequestRow,
} from '@/lib/welileSchoolsFeeRequests';
import type { SchoolRow } from '@/lib/welileSchools';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface StudentOption {
  id: string;
  full_name: string | null;
  class_grade: string | null;
  boarding_status: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
}

const OPEN: FeeRequestRow['status'][] = ['submitted', 'approved'];

function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <div className="space-y-3 rounded-3xl border border-border/70 bg-card p-4">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><Label className="text-sm">{label}</Label>{children}</div>;
}

/**
 * Agent: request a School Fees Plan for a registered student. The agent picks the student,
 * the term and its fee, confirms the guardian who repays and names a guarantor. The request
 * goes to Welile ops for approval; nothing is paid from this screen.
 */
export default function SchoolFeesRequest({ school, onRegisterStudent }: { school: SchoolRow; onRegisterStudent: () => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [student, setStudent] = useState<StudentOption | null>(null);
  const [termId, setTermId] = useState<string>('');
  const [termEnd, setTermEnd] = useState(() => isoDate(new Date(Date.now() + 90 * 86_400_000)));
  const [fee, setFee] = useState(0);
  const [guardianName, setGuardianName] = useState('');
  const [guardianPhone, setGuardianPhone] = useState('');
  const [guarantorName, setGuarantorName] = useState('');
  const [guarantorPhone, setGuarantorPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [sent, setSent] = useState<FeeRequestRow | null>(null);

  const students = useQuery({
    queryKey: ['welile-school-students', school.id],
    queryFn: async () => {
      const { data, error } = await db.from('welile_school_profiles')
        .select('id, full_name, class_grade, boarding_status, guardian_name, guardian_phone')
        .eq('school_id', school.id).eq('role', 'pupil').order('full_name').limit(2000);
      if (error) throw error;
      return (data ?? []) as StudentOption[];
    },
  });
  const setup = useQuery({ queryKey: ['welile-school-setup', school.id], queryFn: () => fetchSchoolSetup(school.id).catch(() => null) });
  const requests = useQuery({ queryKey: ['welile-school-fee-requests', school.id], queryFn: () => fetchFeeRequests(school.id) });

  const openFor = useMemo(() => new Set((requests.data ?? []).filter((r) => OPEN.includes(r.status)).map((r) => r.profile_id)), [requests.data]);
  const today = isoDate(new Date());
  const terms = (setup.data?.terms ?? []).filter((t) => t.end_date > today);
  const term = terms.find((t) => t.id === termId) ?? null;
  const effectiveEnd = term ? term.end_date : termEnd;
  const days = planDaysUntil(new Date(`${effectiveEnd}T00:00:00`));
  const summary = planSummary(fee, days);

  const needle = search.trim().toLowerCase();
  const shown = (students.data ?? []).filter((s) => !needle || [s.full_name, s.class_grade].some((v) => v?.toLowerCase().includes(needle)));

  /** The school's fee for this student's class and day/boarding in the chosen term, when set up. */
  const suggestFee = (s: StudentOption | null, tId: string) => {
    if (!s || !tId) return;
    const board = (s.boarding_status || 'day').toLowerCase().startsWith('board') ? 'boarding' : 'day';
    const row = (setup.data?.fees ?? []).find((f) => f.term_id === tId && f.boarding_status === board
      && f.class_name.trim().toLowerCase() === (s.class_grade ?? '').trim().toLowerCase());
    if (row) setFee(Number(row.amount));
  };

  const pickStudent = (s: StudentOption) => {
    setStudent(s);
    setGuardianName(s.guardian_name ?? '');
    setGuardianPhone(s.guardian_phone ?? '');
    suggestFee(s, termId);
  };

  const reset = () => {
    setSent(null); setStudent(null); setFee(0); setGuarantorName(''); setGuarantorPhone(''); setSearch('');
  };

  const submit = async () => {
    if (!student) { toast.error('Choose the student'); return; }
    if (!(fee > 0)) { toast.error('Enter the term fee'); return; }
    if (days < 14) { toast.error('Too close to the end of term for a plan'); return; }
    if (!guardianName.trim() || guardianPhone.replace(/\D/g, '').length < 9) { toast.error("Enter the parent or guardian's name and phone"); return; }
    setSaving(true);
    try {
      const row = await submitFeeRequest({
        profileId: student.id, termId: term?.id ?? null, termEnd: term ? null : termEnd, termFee: fee,
        guardianName, guardianPhone, guarantorName, guarantorPhone,
      });
      setSent(row);
      qc.invalidateQueries({ queryKey: ['welile-school-fee-requests', school.id] });
      toast.success('Request sent', { description: `${row.student_name}'s School Fees Plan is waiting for approval.` });
    } catch (e) {
      toast.error(feeRequestErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (sent) {
    return (
      <div className="space-y-4">
        <section className="space-y-3 rounded-3xl border border-border/70 bg-card p-5 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" aria-hidden />
          <h2 className="text-lg font-bold">Request sent</h2>
          <p className="text-sm text-muted-foreground">{sent.student_name}'s School Fees Plan is waiting for Welile's approval. Nothing has been paid yet.</p>
          <dl className="divide-y divide-border/60 rounded-2xl bg-muted/50 px-3 text-left text-sm">
            <div className="flex justify-between gap-3 py-2.5"><dt className="text-muted-foreground">Term fee</dt><dd className="font-semibold">{formatDynamic(Number(sent.term_fee))}</dd></div>
            <div className="flex justify-between gap-3 py-2.5"><dt className="text-muted-foreground">Plan length</dt><dd className="font-semibold">{sent.plan_days} days</dd></div>
            <div className="flex justify-between gap-3 py-2.5"><dt className="text-muted-foreground">Total if paid on schedule</dt><dd className="font-semibold">{formatDynamic(Number(sent.total_on_schedule))}</dd></div>
          </dl>
        </section>
        <Button className="min-h-[52px] w-full rounded-2xl text-base" onClick={reset}>Request for another student</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="px-1">
        <h2 className="text-lg font-bold leading-tight">Request school fees</h2>
        <p className="text-xs text-muted-foreground">Welile pays the school; the parent repays daily. Ops approve every request.</p>
      </div>

      <Section title="Student">
        {student ? (
          <div className="flex items-center gap-3 rounded-2xl bg-primary/5 p-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{(student.full_name || '?').charAt(0).toUpperCase()}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{student.full_name}</p>
              <p className="truncate text-xs text-muted-foreground">{[student.class_grade, student.boarding_status].filter(Boolean).join(' · ') || 'Class not recorded'}</p>
            </div>
            <Button variant="ghost" size="sm" className="min-h-[40px] rounded-full text-primary" onClick={() => setStudent(null)}>Change</Button>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input aria-label="Search students" placeholder="Search name or class" className="h-12 rounded-full pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="max-h-72 divide-y divide-border/60 overflow-y-auto rounded-2xl border border-border/60">
              {students.isLoading ? (
                <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
              ) : shown.length === 0 ? (
                <div className="space-y-2 p-4 text-center">
                  <p className="text-sm text-muted-foreground">No registered student matches.</p>
                  <Button variant="outline" size="sm" className="min-h-[40px] rounded-full" onClick={onRegisterStudent}>Register the student first</Button>
                </div>
              ) : shown.map((s) => {
                const open = openFor.has(s.id);
                return (
                  <button key={s.id} type="button" disabled={open} onClick={() => pickStudent(s)}
                    className="flex min-h-[56px] w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/50 disabled:opacity-60">
                    <UserRound className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{s.full_name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{s.class_grade || 'Class not recorded'}</span>
                    </span>
                    {open ? <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">Request open</span> : null}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </Section>

      <Section title="Term and fee">
        {terms.length > 0 ? (
          <Field label="Term">
            <div className="relative">
              <select aria-label="Term" value={termId} onChange={(e) => { setTermId(e.target.value); suggestFee(student, e.target.value); }}
                className="flex h-12 w-full appearance-none rounded-lg border border-input bg-background px-4 pr-10 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring">
                <option value="">Another date (enter below)</option>
                {terms.map((t) => <option key={t.id} value={t.id}>{t.name} · ends {t.end_date}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            </div>
          </Field>
        ) : null}
        {!term && (
          <Field label="End of term">
            <div className="relative">
              <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input type="date" className="h-12 pl-9" value={termEnd} min={today} onChange={(e) => setTermEnd(e.target.value)} />
            </div>
          </Field>
        )}
        <Field label="Term fee">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">UGX</span>
            <Input inputMode="numeric" aria-label="Term fee" className="h-12 pl-12 text-base font-semibold" value={fee ? fee.toLocaleString('en-UG') : ''}
              onChange={(e) => setFee(Number(e.target.value.replace(/\D/g, '')) || 0)} />
          </div>
        </Field>
        {summary ? (
          <div className="rounded-2xl bg-primary p-3 text-primary-foreground">
            <p className="text-xs text-primary-foreground/80">Parent pays about</p>
            <p className="text-xl font-bold">{formatDynamic(Math.ceil(summary.averageDailyPayment / 100) * 100)} <span className="text-sm font-medium">a day for {summary.days} days</span></p>
            <p className="text-xs text-primary-foreground/80">Total {formatDynamic(Math.round(summary.totalOnSchedule))} if paid on schedule. Less if paid early.</p>
          </div>
        ) : fee > 0 ? (
          <p className="rounded-2xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-100">Too close to the end of term. Plans are cleared 14 days before the term ends.</p>
        ) : null}
      </Section>

      <Section title="Who repays">
        <Field label="Parent or guardian"><Input value={guardianName} onChange={(e) => setGuardianName(e.target.value)} /></Field>
        <Field label="Their mobile money number"><Input inputMode="tel" value={guardianPhone} onChange={(e) => setGuardianPhone(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Guarantor (optional)"><Input value={guarantorName} onChange={(e) => setGuarantorName(e.target.value)} /></Field>
          <Field label="Guarantor phone"><Input inputMode="tel" value={guarantorPhone} onChange={(e) => setGuarantorPhone(e.target.value)} /></Field>
        </div>
      </Section>

      {(requests.data?.length ?? 0) > 0 ? (
        <Section title="Your requests at this school">
          <ul className="-my-1 divide-y divide-border/60">
            {requests.data!.slice(0, 20).map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.student_name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{formatDynamic(Number(r.term_fee))} · {r.plan_days} days</span>
                </span>
                <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                  r.status === 'approved' ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200'
                    : r.status === 'submitted' ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'
                      : 'bg-muted text-muted-foreground')}>
                  {r.status === 'approved' ? <Check className="mr-0.5 inline h-3 w-3" aria-hidden /> : null}{FEE_REQUEST_STATUS_LABEL[r.status]}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <div className="sticky bottom-0 z-10 -mx-3 border-t border-border/60 bg-background/95 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
        <Button className="min-h-[52px] w-full rounded-2xl text-base" disabled={saving} onClick={submit}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Send request for approval
        </Button>
      </div>
    </div>
  );
}
