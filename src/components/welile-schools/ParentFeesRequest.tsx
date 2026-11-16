import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronDown, Loader2, LogIn, Search, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import {
  PARENT_STATUS_LABEL, createParentRequest, emptyParentRequest, fetchMyParentRequests, fetchPartnerSchools,
  isOpenParentRequest, parentRequestErrorMessage, parentRequestErrors, updateParentRequest,
  type ParentRequestDraft, type ParentRequestRow, type ParentRequestStatus, type PartnerSchool,
} from '@/lib/welileSchoolsParentRequests';

const STATUS_TONE: Record<ParentRequestStatus, string> = {
  new: 'bg-primary/10 text-primary',
  contacted: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  sent_to_welile: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  declined: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
};

function Field({ label, htmlFor, error, children }: { label: string; htmlFor?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * The parent's "Request school fees" section: pick the child's school (Welile partners only), give
 * the child's details, and send. The request goes first to the Welile agent at that school.
 */
export default function ParentFeesRequest() {
  const { user } = useAuth();
  const navigate = useNavigate();

  if (!user) {
    return (
      <section className="space-y-3 rounded-3xl border border-border/70 bg-card p-4 shadow-sm">
        <h3 className="text-base font-semibold">Request school fees for your child</h3>
        <p className="text-sm text-muted-foreground">Sign in, choose your child's school and send your request. The Welile agent at that school will contact you.</p>
        <Button className="min-h-[52px] w-full gap-2 rounded-2xl text-base" onClick={() => navigate(`/auth?redirect=${encodeURIComponent('/schools?role=parent')}`)}>
          <LogIn className="h-5 w-5" />Sign in to request
        </Button>
      </section>
    );
  }
  return <SignedInParentRequest userId={user.id} />;
}

function SignedInParentRequest({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const schools = useQuery({ queryKey: ['welile-partner-schools'], queryFn: fetchPartnerSchools, staleTime: 5 * 60_000, retry: 1 });
  const mine = useQuery({ queryKey: ['welile-parent-requests', userId], queryFn: () => fetchMyParentRequests(userId), retry: 1 });
  const [d, setD] = useState<ParentRequestDraft>(emptyParentRequest);
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<ParentRequestRow | null>(null);
  const [schoolSearch, setSchoolSearch] = useState('');
  const set = (patch: Partial<ParentRequestDraft>) => setD((x) => ({ ...x, ...patch }));
  const errors = parentRequestErrors(d);

  // Fill the parent's own name and phone from their account, once.
  useEffect(() => {
    supabase.from('profiles').select('full_name, phone').eq('id', userId).maybeSingle().then(({ data }) => {
      if (!data) return;
      setD((x) => ({ ...x, parent_name: x.parent_name || data.full_name || '', parent_phone: x.parent_phone || data.phone || '' }));
    });
  }, [userId]);

  const schoolList = useMemo(() => schools.data ?? [], [schools.data]);
  const needle = schoolSearch.trim().toLowerCase();
  const shownSchools = useMemo(() => schoolList.filter((s) => !needle || [s.name, s.district, s.town].some((v) => v?.toLowerCase().includes(needle))), [schoolList, needle]);
  const chosen = schoolList.find((s) => s.id === d.school_id) ?? null;
  const schoolName = (id: string) => schoolList.find((s) => s.id === id)?.name ?? 'your child\'s school';

  const send = async () => {
    setTried(true);
    if (Object.keys(errors).length) { toast.error('Check the highlighted fields'); return; }
    setSending(true);
    try {
      const row = await createParentRequest(d);
      setSent(row);
      setD((x) => ({ ...emptyParentRequest(), parent_name: x.parent_name, parent_phone: x.parent_phone }));
      setTried(false);
      qc.invalidateQueries({ queryKey: ['welile-parent-requests', userId] });
    } catch (e) {
      toast.error('Could not send your request', { description: parentRequestErrorMessage(e) });
    } finally {
      setSending(false);
    }
  };

  const cancel = async (r: ParentRequestRow) => {
    try {
      await updateParentRequest(r.id, 'cancelled');
      toast.success('Request cancelled');
      qc.invalidateQueries({ queryKey: ['welile-parent-requests', userId] });
    } catch (e) {
      toast.error('Could not cancel', { description: parentRequestErrorMessage(e) });
    }
  };

  return (
    <div className="space-y-4">
      <section aria-labelledby="ws-parent-request" className="space-y-4 rounded-3xl border border-border/70 bg-card p-4 shadow-sm">
        <div>
          <h3 id="ws-parent-request" className="text-base font-semibold">Request school fees for your child</h3>
          <p className="text-sm text-muted-foreground">Your request goes to the Welile agent at your child's school. They will call you to finish it.</p>
        </div>

        {sent ? (
          <div className="space-y-3">
            <p className="flex items-start gap-2 rounded-2xl bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-200">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
              <span><span className="font-semibold">Request sent.</span> The Welile agent at {schoolName(sent.school_id)} will contact you on {sent.parent_phone} about {sent.child_name}'s School Fees Plan.</span>
            </p>
            <Button variant="outline" className="min-h-[48px] w-full rounded-2xl" onClick={() => setSent(null)}>Request for another child</Button>
          </div>
        ) : schools.isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
        ) : schools.error ? (
          <p className="rounded-2xl bg-muted/60 p-3 text-sm text-muted-foreground">{parentRequestErrorMessage(schools.error)}</p>
        ) : schoolList.length === 0 ? (
          <p className="rounded-2xl bg-muted/60 p-3 text-sm text-muted-foreground">No schools have joined Welile Schools yet. Check back soon, or ask your child's school to partner with Welile.</p>
        ) : (
          <>
            <Field label="Your child's school" error={tried ? errors.school_id : undefined}>
              {chosen ? (
                <div className="flex items-center gap-2 rounded-2xl border border-primary/40 bg-primary/5 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{chosen.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{[chosen.school_level, chosen.town, chosen.district].filter(Boolean).join(' · ')}</p>
                  </div>
                  <Button variant="ghost" size="sm" className="min-h-[40px] rounded-full text-primary" onClick={() => set({ school_id: '' })}>Change</Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input aria-label="Search schools" placeholder="Search school name or district" className="h-12 rounded-2xl pl-9" value={schoolSearch} onChange={(e) => setSchoolSearch(e.target.value)} />
                  </div>
                  <div className={cn('max-h-64 divide-y divide-border/60 overflow-y-auto rounded-2xl border', tried && errors.school_id ? 'border-destructive' : 'border-border/70')}>
                    {shownSchools.map((s: PartnerSchool) => (
                      <button key={s.id} type="button" onClick={() => set({ school_id: s.id })} className="flex min-h-[52px] w-full flex-col justify-center px-3 py-2 text-left hover:bg-muted/50">
                        <span className="text-sm font-medium">{s.name}</span>
                        <span className="text-xs text-muted-foreground">{[s.school_level, s.town, s.district].filter(Boolean).join(' · ')}</span>
                      </button>
                    ))}
                    {!shownSchools.length && <p className="p-3 text-sm text-muted-foreground">No partner school matches.</p>}
                  </div>
                </div>
              )}
            </Field>

            <Field label="Child's full name" htmlFor="wspr-child" error={tried ? errors.child_name : undefined}>
              <Input id="wspr-child" value={d.child_name} onChange={(e) => set({ child_name: e.target.value })} className={cn('h-12 rounded-2xl', tried && errors.child_name && 'border-destructive')} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Class" htmlFor="wspr-class">
                <Input id="wspr-class" placeholder="e.g. P4, S2" value={d.class_grade} onChange={(e) => set({ class_grade: e.target.value })} className="h-12 rounded-2xl" />
              </Field>
              <Field label="Day or boarding" htmlFor="wspr-boarding">
                <div className="relative">
                  <select id="wspr-boarding" value={d.boarding_status} onChange={(e) => set({ boarding_status: e.target.value as ParentRequestDraft['boarding_status'] })}
                    className="h-12 w-full appearance-none rounded-2xl border border-input bg-background pl-3 pr-9 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
                    <option value="">Not sure</option>
                    <option value="day">Day</option>
                    <option value="boarding">Boarding</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                </div>
              </Field>
            </div>
            <Field label="Term fees (UGX, if you know them)" htmlFor="wspr-fee" error={tried ? errors.term_fee : undefined}>
              <Input id="wspr-fee" inputMode="numeric" placeholder="e.g. 850,000" className="h-12 rounded-2xl"
                value={d.term_fee ? Number(d.term_fee.replace(/\D/g, '') || 0).toLocaleString('en-UG') : ''}
                onChange={(e) => set({ term_fee: e.target.value.replace(/\D/g, '') })} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Your name" htmlFor="wspr-parent" error={tried ? errors.parent_name : undefined}>
                <Input id="wspr-parent" value={d.parent_name} onChange={(e) => set({ parent_name: e.target.value })} className={cn('h-12 rounded-2xl', tried && errors.parent_name && 'border-destructive')} />
              </Field>
              <Field label="Your phone" htmlFor="wspr-phone" error={tried ? errors.parent_phone : undefined}>
                <Input id="wspr-phone" inputMode="tel" placeholder="07XX XXX XXX" value={d.parent_phone} onChange={(e) => set({ parent_phone: e.target.value })} className={cn('h-12 rounded-2xl', tried && errors.parent_phone && 'border-destructive')} />
              </Field>
            </div>
            <Field label="Anything the agent should know (optional)" htmlFor="wspr-note">
              <textarea id="wspr-note" rows={2} maxLength={500} value={d.note} onChange={(e) => set({ note: e.target.value })}
                className="w-full rounded-2xl border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30" />
            </Field>
            <Button className="min-h-[52px] w-full gap-2 rounded-2xl text-base" disabled={sending} onClick={send}>
              {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}Send to the school's Welile agent
            </Button>
          </>
        )}
      </section>

      {(mine.data?.length ?? 0) > 0 && (
        <section aria-labelledby="ws-parent-mine" className="space-y-2">
          <h3 id="ws-parent-mine" className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your requests</h3>
          <div className="divide-y divide-border/60 overflow-hidden rounded-3xl border border-border/70 bg-card">
            {mine.data!.map((r) => (
              <div key={r.id} className="space-y-1.5 p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{r.child_name}</p>
                    <p className="truncate text-xs text-muted-foreground">{[schoolName(r.school_id), r.class_grade, r.term_fee ? formatDynamic(Number(r.term_fee)) : null].filter(Boolean).join(' · ')}</p>
                  </div>
                  <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold', STATUS_TONE[r.status])}>{PARENT_STATUS_LABEL[r.status]}</span>
                </div>
                {r.agent_note && (r.status === 'declined' || r.status === 'contacted' || r.status === 'sent_to_welile') && (
                  <p className="rounded-xl bg-muted/60 px-3 py-2 text-xs"><span className="font-semibold">Agent: </span>{r.agent_note}</p>
                )}
                {r.status === 'new' && isOpenParentRequest(r.status) && (
                  <Button variant="ghost" size="sm" className="min-h-[36px] gap-1 rounded-full px-2 text-muted-foreground" onClick={() => cancel(r)}>
                    <X className="h-4 w-4" />Cancel request
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
