import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle, ArrowLeft, Building2, ChevronRight, CloudOff, DoorOpen, GraduationCap, Handshake, Hourglass,
  IdCard, Loader2, MapPin, MessageSquareText, Receipt, School, Smartphone, TrendingDown, UserPlus, Users,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  computeGateMovementSummary, readLockedSchool, readPendingGateLogs, readPendingProfiles, writeLockedSchool,
  type SchoolGateLogRow, type SchoolRow,
} from '@/lib/welileSchools';
import { STATUS_LABEL, fetchSchoolSetup, missingForSubmit, todayKampala, type PartnershipStatus } from '@/lib/welileSchoolsPartnership';
import {
  agentAttention, availableSchoolsRoles, readStoredSchoolsRole, resolveSchoolsRole, writeStoredSchoolsRole,
  type AttentionItem, type SchoolsRole,
} from '@/lib/welileSchoolsHome';

// These tables are not in the generated Supabase types yet (Lovable regenerates them).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const WORKSPACE = '/agent/welile-schools';

const STATUS_TONE: Record<PartnershipStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  submitted: 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200',
  changes_requested: 'bg-orange-100 text-orange-900 dark:bg-orange-900/30 dark:text-orange-200',
  approved: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200',
  rejected: 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200',
  suspended: 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200',
};

/** /schools — one Welile Schools home for school agents and parents, with a role switcher. */
export default function WelileSchoolsHome() {
  const navigate = useNavigate();
  const { user, roles, loading } = useAuth();
  const available = useMemo(() => availableSchoolsRoles(roles ?? []), [roles]);
  const [role, setRole] = useState<SchoolsRole>(() => resolveSchoolsRole(available, readStoredSchoolsRole()));

  useEffect(() => { setRole((r) => resolveSchoolsRole(available, r)); }, [available]);
  useEffect(() => { if (!loading && !user) navigate('/auth', { replace: true }); }, [loading, user, navigate]);

  const choose = (r: SchoolsRole) => { setRole(r); writeStoredSchoolsRole(r); };

  if (loading || !user) {
    return <div className="flex min-h-screen items-center justify-center bg-background"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-xl items-center gap-2 px-3 py-2">
          <Button variant="ghost" size="icon" className="h-11 w-11" aria-label="Back" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/dashboard'))}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <GraduationCap className="h-5 w-5 text-primary" aria-hidden />
          <h1 className="flex-1 text-base font-bold">Welile Schools</h1>
        </div>
      </header>

      <main className="mx-auto max-w-xl space-y-4 p-3">
        {available.length > 1 && (
          <div role="tablist" aria-label="View Welile Schools as" className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
            {([['agent', 'School agent', IdCard], ['parent', 'Parent', Users]] as const).map(([key, label, Icon]) => (
              <button key={key} type="button" role="tab" aria-selected={role === key} onClick={() => choose(key)}
                className={cn('flex min-h-[44px] items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors',
                  role === key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                <Icon className="h-4 w-4" aria-hidden />{label}
              </button>
            ))}
          </div>
        )}
        {role === 'agent' ? <AgentHome userId={user.id} /> : <ParentHome />}
      </main>
    </div>
  );
}

// ─── Agent view ───────────────────────────────────────────────────────────────

function useAgentHomeData(userId: string, school: SchoolRow | null) {
  return useQuery({
    queryKey: ['welile-schools-home', userId, school?.id ?? null],
    staleTime: 30_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 36 * 3_600_000).toISOString();
      const [schoolsRes, partnershipsRes, gateRes, registeredRes, setup] = await Promise.all([
        db.from('welile_schools').select('*').order('created_at', { ascending: false }).limit(200),
        db.from('welile_school_partnerships').select('school_id, status'),
        school ? db.from('welile_school_gate_logs').select('*').eq('school_id', school.id).gte('recorded_at', since).limit(5000) : Promise.resolve({ data: [] }),
        school ? db.from('welile_school_profiles').select('id', { count: 'exact', head: true }).eq('school_id', school.id).eq('registered_by', userId) : Promise.resolve({ count: 0 }),
        school ? fetchSchoolSetup(school.id).catch(() => null) : Promise.resolve(null),
      ]);
      if (schoolsRes.error) throw schoolsRes.error;
      const statusBySchool: Record<string, PartnershipStatus> = {};
      ((partnershipsRes.data ?? []) as { school_id: string; status: PartnershipStatus }[]).forEach((p) => { statusBySchool[p.school_id] = p.status; });
      const gate = computeGateMovementSummary((gateRes.data ?? []) as SchoolGateLogRow[]);
      return {
        schools: (schoolsRes.data ?? []) as SchoolRow[],
        statusBySchool,
        enteredToday: gate.enteredToday,
        insideNow: gate.currentlyInside,
        registered: registeredRes.count ?? 0,
        setup,
      };
    },
  });
}

function AgentHome({ userId }: { userId: string }) {
  const navigate = useNavigate();
  const [school, setSchool] = useState<SchoolRow | null>(() => readLockedSchool());
  const { data, isLoading } = useAgentHomeData(userId, school);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingUploads = readPendingProfiles().length + readPendingGateLogs().length;

  const status = school ? data?.setup?.partnership?.status ?? null : null;
  const missing = data?.setup ? missingForSubmit(data.setup.partnership, data.setup.terms, data.setup.fees, todayKampala()) : [];
  const attention = agentAttention({ hasCurrentSchool: !!school, partnershipStatus: status, missingForSubmit: missing, pendingUploads });

  const pick = (s: SchoolRow) => { writeLockedSchool(s); setSchool(s); toast.success(`You're at ${s.name}`); };
  const open = (mode: 'gate' | 'register' | 'partner') => {
    if (!school) { toast.message('Choose the school you are at first'); listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    navigate(`${WORKSPACE}?mode=${mode}`);
  };
  const onAttention = (item: AttentionItem) => {
    if (item.kind === 'pick_school') listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (item.kind === 'offline_queue') navigate(`${WORKSPACE}?mode=gate`);
    else navigate(`${WORKSPACE}?mode=partner`);
  };

  const ATTENTION_ICON = { pick_school: MapPin, finish_setup: Handshake, changes_requested: AlertCircle, rejected: AlertCircle, awaiting_approval: Hourglass, offline_queue: CloudOff } as const;
  const TONE = { danger: 'text-destructive', warning: 'text-amber-600 dark:text-amber-400', info: 'text-muted-foreground' } as const;

  return (
    <div className="space-y-4">
      {school ? (
        <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
          <MapPin className="h-5 w-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">You're at {school.name}</p>
            <p className="truncate text-xs text-muted-foreground">{[school.district, school.gate_name].filter(Boolean).join(' · ')}</p>
          </div>
          <Button variant="ghost" size="sm" className="min-h-[40px] text-primary" onClick={() => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Change</Button>
        </div>
      ) : null}

      {school && (
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'In today', value: data?.enteredToday },
            { label: 'Inside now', value: data?.insideNow },
            { label: 'You registered', value: data?.registered },
          ].map((s) => (
            <div key={s.label} className="rounded-xl bg-muted/60 p-3">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="mt-0.5 text-xl font-bold tabular-nums">{isLoading || s.value == null ? '…' : s.value.toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}

      <section aria-labelledby="ws-attention">
        <h2 id="ws-attention" className="mb-2 text-sm font-semibold">Needs your attention</h2>
        {attention.length === 0 ? (
          <p className="rounded-2xl border border-border bg-card p-3 text-sm text-muted-foreground">All caught up at this school.</p>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
            {attention.map((item) => {
              const Icon = ATTENTION_ICON[item.kind];
              return (
                <button key={item.kind} type="button" onClick={() => onAttention(item)} className="flex min-h-[56px] w-full items-center gap-3 p-3 text-left hover:bg-muted/50">
                  <Icon className={cn('h-5 w-5 shrink-0', TONE[item.tone])} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{item.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section aria-label="Quick actions" className="grid grid-cols-2 gap-2">
        <ActionTile icon={DoorOpen} label="Gate log" hint="Record in and out" primary onClick={() => open('gate')} />
        <ActionTile icon={UserPlus} label="Register a person" hint="Pupils, staff, parents" onClick={() => open('register')} />
        <ActionTile icon={Building2} label="School set-up" hint={status ? STATUS_LABEL[status] : 'Partnership, terms, fees'} onClick={() => open('partner')} />
        <ActionTile icon={Receipt} label="Sign up a family" hint="Coming soon"
          onClick={() => toast.message('Family sign-up for School Fees Plans opens soon', { description: 'It starts once this school is an approved partner.' })} />
      </section>

      <section ref={listRef} aria-labelledby="ws-schools" className="scroll-mt-20">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="ws-schools" className="text-sm font-semibold">Schools</h2>
          <Button variant="ghost" size="sm" className="min-h-[40px] text-primary" onClick={() => navigate(`${WORKSPACE}?new=1`)}>+ Add a school</Button>
        </div>
        {isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
        ) : (data?.schools.length ?? 0) === 0 ? (
          <p className="rounded-2xl border border-border bg-card p-3 text-sm text-muted-foreground">No schools registered yet. Add the first one.</p>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
            {data!.schools.map((s) => {
              const st = data!.statusBySchool[s.id];
              const current = school?.id === s.id;
              return (
                <button key={s.id} type="button" onClick={() => pick(s)} aria-current={current ? 'true' : undefined}
                  className={cn('flex min-h-[56px] w-full items-center gap-3 p-3 text-left hover:bg-muted/50', current && 'bg-primary/5')}>
                  <School className={cn('h-5 w-5 shrink-0', current ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{s.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{[s.school_level, s.district].filter(Boolean).join(' · ')}</span>
                  </span>
                  {st ? <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', STATUS_TONE[st])}>{STATUS_LABEL[st]}</span>
                    : current ? <span className="shrink-0 text-xs font-semibold text-primary">Current</span> : null}
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function ActionTile({ icon: Icon, label, hint, onClick, primary }: { icon: typeof DoorOpen; label: string; hint: string; onClick: () => void; primary?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={cn('flex min-h-[88px] flex-col items-start justify-between gap-2 rounded-2xl border p-3 text-left transition-colors',
        primary ? 'border-primary/40 bg-primary/10 hover:bg-primary/15' : 'border-border bg-card hover:bg-muted/50')}>
      <Icon className={cn('h-5 w-5', primary ? 'text-primary' : 'text-foreground')} aria-hidden />
      <span>
        <span className={cn('block text-sm font-semibold', primary && 'text-primary')}>{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

// ─── Parent view ──────────────────────────────────────────────────────────────

function ParentHome() {
  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-5">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
          <GraduationCap className="h-6 w-6 text-primary" aria-hidden />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-bold leading-tight">Spread school fees into small daily payments</h2>
          <p className="text-sm text-muted-foreground">
            With a School Fees Plan, Welile pays your child's term fees straight to the school. You clear them in small daily payments by mobile money.
          </p>
        </div>
        <ul className="space-y-3">
          {[
            { icon: TrendingDown, title: 'Pay early, pay less', body: 'The facilitation fee is worked out daily on what you still owe.' },
            { icon: MessageSquareText, title: 'A receipt after every payment', body: 'An SMS with your new balance each time you pay.' },
            { icon: Smartphone, title: 'Pay any day from your phone', body: 'MTN or Airtel, any amount, any day.' },
          ].map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-3">
              <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
              <span>
                <span className="block text-sm font-semibold">{title}</span>
                <span className="block text-sm text-muted-foreground">{body}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-2 p-4">
        <h3 className="text-sm font-semibold">How to start</h3>
        <p className="text-sm text-muted-foreground">
          School Fees Plans open soon at Welile partner schools. The Welile agent at your child's school will sign you up and show your plan here.
        </p>
      </Card>

      <div className="flex items-start gap-3 rounded-2xl bg-muted/60 p-3">
        <Receipt className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">Your plan, today's amount and your payments will appear here once you have a plan.</p>
      </div>
    </div>
  );
}
