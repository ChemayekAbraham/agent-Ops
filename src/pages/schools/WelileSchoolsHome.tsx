import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle, ArrowLeft, Banknote, Building2, Check, ChevronDown, ChevronRight, ClipboardCheck, CloudOff, DoorOpen, FileSignature, GraduationCap,
  Handshake, Hourglass, IdCard, Loader2, LogIn, MapPin, MessageCircle, MessageSquareText, Receipt, RotateCcw, School,
  Smartphone, TrendingDown, UserPlus, Users,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import WelileSchoolsBrand from '@/components/welile-schools/WelileSchoolsBrand';
import { wordmarkClass } from '@/components/welile-schools/wordmark';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { WHATSAPP_URL } from '@/components/ai-chat/assistantConfig';
import SchoolsOnboarding from '@/components/welile-schools/SchoolsOnboarding';
import SchoolsPhotoCarousel from '@/components/welile-schools/SchoolsPhotoCarousel';
import {
  computeGateMovementSummary, readLockedSchool, readPendingGateLogs, readPendingProfiles, writeLockedSchool,
  type SchoolGateLogRow, type SchoolRow,
} from '@/lib/welileSchools';
import { STATUS_LABEL, fetchSchoolSetup, missingForSubmit, todayKampala, type PartnershipStatus } from '@/lib/welileSchoolsPartnership';
import {
  ROLE_INTRO, SCHOOLS_ROLES, SCHOOLS_ROLE_LABEL, agentAttention, canWorkAsSchoolAgent, clearStoredSchoolsRole,
  readStoredSchoolsRole, roleFromQuery, writeStoredSchoolsRole,
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

const ROLE_ICON: Record<SchoolsRole, typeof Users> = { parent: Users, school: Building2, agent: IdCard };
const SHORT_LABEL: Record<SchoolsRole, string> = { parent: 'Parent', school: 'School', agent: 'Agent' };

function whatsapp(text: string) {
  return `${WHATSAPP_URL}?text=${encodeURIComponent(text)}`;
}

/**
 * /schools — public Welile Schools entry point. First visit: an onboarding funnel
 * (welcome → who are you → what you get). After that: a separate home per role
 * (parent, school owner, Welile agent) with a switcher. No sign-in needed; only
 * the agent's real work asks for one.
 */
export default function WelileSchoolsHome() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, roles, loading } = useAuth();
  const [role, setRole] = useState<SchoolsRole | null>(() => roleFromQuery(location.search) ?? readStoredSchoolsRole());

  useEffect(() => {
    const fromLink = roleFromQuery(location.search);
    if (fromLink) { setRole(fromLink); writeStoredSchoolsRole(fromLink); }
  }, [location.search]);

  // Back leaves Welile Schools: agents to their dashboard, other signed-in people to theirs, visitors to the home page.
  const backTarget = canWorkAsSchoolAgent(roles) ? '/dashboard/agent' : user ? '/dashboard' : '/';

  const choose = (r: SchoolsRole) => { setRole(r); writeStoredSchoolsRole(r); window.scrollTo({ top: 0 }); };
  const restart = () => { clearStoredSchoolsRole(); setRole(null); window.scrollTo({ top: 0 }); };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-xl items-center gap-2 px-3 py-2">
          <Button variant="ghost" size="icon" className="h-11 w-11 rounded-full" aria-label="Back" onClick={() => navigate(backTarget)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <WelileSchoolsBrand />
          {role !== null && <RoleSwitcher role={role} onChange={choose} onRestart={restart} />}
        </div>
      </header>

      <main className="mx-auto max-w-xl px-3 pt-3">
        {role === null ? (
          <SchoolsOnboarding wordmarkClass={wordmarkClass} onDone={choose} />
        ) : (
          <>
            {role === 'parent' && <ParentHome />}
            {role === 'school' && <SchoolOwnerHome />}
            {role === 'agent' && (
              loading ? <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
                : user && canWorkAsSchoolAgent(roles) ? <AgentHome userId={user.id} />
                  : <AgentExplore signedIn={!!user} />
            )}
          </>
        )}
      </main>
    </div>
  );
}

/** Top-right role picker: the current role as one button, the others in a dropdown. */
function RoleSwitcher({ role, onChange, onRestart }: { role: SchoolsRole; onChange: (r: SchoolsRole) => void; onRestart: () => void }) {
  const Current = ROLE_ICON[role];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-10 shrink-0 gap-1.5 rounded-full px-3 text-sm font-semibold" aria-label={`Viewing as ${SCHOOLS_ROLE_LABEL[role]}. Change role`}>
          <Current className="h-4 w-4 text-primary" aria-hidden />
          {SHORT_LABEL[role]}
          <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Explore Welile Schools as</DropdownMenuLabel>
        {SCHOOLS_ROLES.map((key) => {
          const Icon = ROLE_ICON[key];
          return (
            <DropdownMenuItem key={key} onSelect={() => onChange(key)} className="min-h-[44px] gap-3">
              <Icon className="h-4 w-4 text-primary" aria-hidden />
              <span className="flex-1">{SCHOOLS_ROLE_LABEL[key]}</span>
              {key === role && <Check className="h-4 w-4 text-primary" aria-label="Current" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRestart} className="min-h-[44px] gap-3 text-muted-foreground">
          <RotateCcw className="h-4 w-4" aria-hidden />
          See the introduction again
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── School owner view ────────────────────────────────────────────────────────

function SchoolOwnerHome() {
  const steps = [
    { icon: MapPin, title: 'A Welile agent visits your school', body: 'They register the school and agree a partnership with you.' },
    { icon: FileSignature, title: 'You share your terms and fees', body: 'Term dates, fee per class, and the account Welile pays into.' },
    { icon: ClipboardCheck, title: 'Welile approves the partnership', body: 'Families at your school can then apply for School Fees Plans.' },
    { icon: Banknote, title: 'Fees arrive at the start of term', body: 'For every student on a plan, paid straight to your account.' },
  ];
  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-5">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
          <Building2 className="h-6 w-6 text-primary" aria-hidden />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-bold leading-tight">{ROLE_INTRO.school.title}</h2>
          <p className="text-sm text-muted-foreground">Partner with Welile and get paid upfront for students whose families pay daily.</p>
        </div>
        <ul className="space-y-3">
          {ROLE_INTRO.school.points.map((p) => (
            <li key={p.title} className="flex gap-3">
              <TrendingDown className="mt-0.5 h-5 w-5 shrink-0 rotate-180 text-primary" aria-hidden />
              <span><span className="block text-sm font-semibold">{p.title}</span><span className="block text-sm text-muted-foreground">{p.body}</span></span>
            </li>
          ))}
        </ul>
      </Card>

      <section aria-labelledby="ws-owner-steps">
        <h2 id="ws-owner-steps" className="mb-2 text-sm font-semibold">How the partnership works</h2>
        <ol className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
          {steps.map(({ icon: Icon, title, body }, i) => (
            <li key={title} className="flex gap-3 p-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">{i + 1}</span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-semibold"><Icon className="h-4 w-4 text-primary" aria-hidden />{title}</span>
                <span className="block text-sm text-muted-foreground">{body}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <Button asChild className="min-h-[52px] w-full gap-2 text-base">
        <a href={whatsapp('Hello Welile, I run a school and would like to become a Welile Schools partner.')} target="_blank" rel="noopener noreferrer">
          <MessageCircle className="h-5 w-5" aria-hidden />Partner with Welile
        </a>
      </Button>
      <p className="text-center text-xs text-muted-foreground">Opens WhatsApp. A Welile agent will arrange a visit.</p>
    </div>
  );
}

// ─── Agent view for visitors (not signed in, or not a Welile agent) ──────────

function AgentExplore({ signedIn }: { signedIn: boolean }) {
  const navigate = useNavigate();
  const tools = [
    { icon: DoorOpen, title: 'Gate log', body: 'Record everyone in and out each day.' },
    { icon: UserPlus, title: 'Register students', body: 'Each student with their parent or guardian.' },
    { icon: Building2, title: 'School set-up', body: 'Partnership, terms, fees and payout account.' },
    { icon: Receipt, title: 'Sign up families', body: 'Start School Fees Plans and follow up payments.' },
  ];
  return (
    <div className="space-y-4">
      <Card className="space-y-2 p-5">
        <h2 className="text-lg font-bold leading-tight">{ROLE_INTRO.agent.title}</h2>
        <p className="text-sm text-muted-foreground">Welile agents run Welile Schools at each partner school. These are the tools you get.</p>
      </Card>
      <div className="grid grid-cols-2 gap-2">
        {tools.map(({ icon: Icon, title, body }) => (
          <div key={title} className="rounded-2xl border border-border bg-card p-3">
            <Icon className="h-5 w-5 text-primary" aria-hidden />
            <p className="mt-2 text-sm font-semibold">{title}</p>
            <p className="text-xs text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>
      {signedIn ? (
        <>
          <Button asChild className="min-h-[52px] w-full gap-2 text-base">
            <a href={whatsapp('Hello Welile, I would like to become a Welile Schools agent.')} target="_blank" rel="noopener noreferrer">
              <MessageCircle className="h-5 w-5" aria-hidden />Become a Welile agent
            </a>
          </Button>
          <p className="text-center text-xs text-muted-foreground">Your account is not a Welile agent account yet.</p>
        </>
      ) : (
        <>
          <Button className="min-h-[52px] w-full gap-2 text-base" onClick={() => navigate('/auth')}>
            <LogIn className="h-5 w-5" aria-hidden />Sign in to start
          </Button>
          <p className="text-center text-xs text-muted-foreground">Already a Welile agent? Sign in to open your schools.</p>
        </>
      )}
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
      <SchoolsPhotoCarousel />
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
        <ActionTile icon={UserPlus} label="Register a student" hint="With parent or guardian details" onClick={() => open('register')} />
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
      <SchoolsPhotoCarousel />
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

      <Button asChild variant="outline" className="min-h-[48px] w-full gap-2">
        <a href={whatsapp('Hello Welile, I would like to know more about School Fees Plans for my child.')} target="_blank" rel="noopener noreferrer">
          <MessageCircle className="h-5 w-5" aria-hidden />Ask Welile on WhatsApp
        </a>
      </Button>
    </div>
  );
}
