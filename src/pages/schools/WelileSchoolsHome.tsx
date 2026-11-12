import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle, ArrowLeft, Banknote, Building2, Check, ChevronDown, ChevronRight, ClipboardCheck, CloudOff, DoorOpen, FileSignature, GraduationCap,
  Handshake, Hourglass, IdCard, Loader2, LogIn, MapPin, MessageCircle, MessageSquareText, Plus, Receipt, RotateCcw, School,
  Smartphone, TrendingDown, UserPlus, Users,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import WelileSchoolsBrand from '@/components/welile-schools/WelileSchoolsBrand';
import { wordmarkClass } from '@/components/welile-schools/wordmark';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import StickyCta from '@/components/welile-schools/StickyCta';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { WHATSAPP_URL } from '@/components/ai-chat/assistantConfig';
import SchoolsOnboarding from '@/components/welile-schools/SchoolsOnboarding';
import SchoolsPhotoCarousel from '@/components/welile-schools/SchoolsPhotoCarousel';
import SchoolFeesPlanCard from '@/components/welile-schools/SchoolFeesPlanCard';
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
      <HeroHeader
        icon={Building2}
        eyebrow="For school owners"
        title={ROLE_INTRO.school.title}
        body="Partner with Welile and get paid upfront for students whose families pay daily."
      />

      <BenefitTiles items={[
        { icon: Banknote, title: 'Paid upfront', body: 'Full fees at the start of term.' },
        { icon: Hourglass, title: 'No chasing', body: 'Parents repay Welile, not your bursar.' },
        { icon: Users, title: 'More students', body: 'Families can afford to enrol.' },
      ]} />

      <section aria-labelledby="ws-owner-steps">
        <h2 id="ws-owner-steps" className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">How the partnership works</h2>
        <Timeline steps={steps} />
      </section>

      <StickyCta note="Opens WhatsApp. A Welile agent will arrange a visit.">
        <Button asChild className="min-h-[52px] w-full gap-2 rounded-2xl text-base">
          <a href={whatsapp('Hello Welile, I run a school and would like to become a Welile Schools partner.')} target="_blank" rel="noopener noreferrer">
            <MessageCircle className="h-5 w-5" aria-hidden />Partner with Welile
          </a>
        </Button>
      </StickyCta>
    </div>
  );
}

// ─── Shared pieces for the role homes ─────────────────────────────────────────

/** Photo carousel with the role's headline in a card that overlaps it, like an app's home header. */
function HeroHeader({ icon: Icon, eyebrow, title, body }: { icon: typeof Users; eyebrow: string; title: string; body: string }) {
  return (
    <div>
      <SchoolsPhotoCarousel dotsAtTop />
      <div className="relative z-10 -mt-6 mx-2 rounded-3xl border border-border/70 bg-card p-4 shadow-lg">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="h-4 w-4" aria-hidden /></span>
          <p className="text-xs font-semibold uppercase tracking-wider text-primary">{eyebrow}</p>
        </div>
        <h2 className="mt-2 text-lg font-bold leading-snug">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

/** Three benefits as compact tiles in a row (icon + short title), with the detail underneath. */
function BenefitTiles({ items }: { items: { icon: typeof Users; title: string; body: string }[] }) {
  return (
    <ul className="grid grid-cols-3 gap-2">
      {items.map(({ icon: Icon, title, body }) => (
        <li key={title} className="flex flex-col gap-1.5 rounded-2xl bg-muted/50 p-3">
          <Icon className="h-5 w-5 text-primary" aria-hidden />
          <span className="text-xs font-semibold leading-snug">{title}</span>
          <span className="text-[11px] leading-snug text-muted-foreground">{body}</span>
        </li>
      ))}
    </ul>
  );
}

/** Numbered steps joined by a line, in one card. */
function Timeline({ steps }: { steps: { icon: typeof Users; title: string; body: string }[] }) {
  return (
    <ol className="rounded-3xl border border-border/70 bg-card p-4">
      {steps.map(({ icon: Icon, title, body }, i) => (
        <li key={title} className="relative flex gap-3 pb-4 last:pb-0">
          {i < steps.length - 1 ? <span className="absolute left-[15px] top-8 h-[calc(100%-2rem)] w-0.5 bg-primary/20" aria-hidden /> : null}
          <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Icon className="h-4 w-4" aria-hidden /></span>
          <span className="min-w-0 pt-0.5">
            <span className="block text-sm font-semibold">{title}</span>
            <span className="block text-sm text-muted-foreground">{body}</span>
          </span>
        </li>
      ))}
    </ol>
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
      <HeroHeader
        icon={IdCard}
        eyebrow="For Welile agents"
        title={ROLE_INTRO.agent.title}
        body="Welile agents run Welile Schools at each partner school. These are the tools you get."
      />
      <div className="grid grid-cols-2 gap-2">
        {tools.map(({ icon: Icon, title, body }) => (
          <div key={title} className="rounded-2xl bg-muted/50 p-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="h-5 w-5" aria-hidden /></span>
            <p className="mt-2 text-sm font-semibold">{title}</p>
            <p className="text-xs text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>
      {signedIn ? (
        <StickyCta note="Your account is not a Welile agent account yet.">
          <Button asChild className="min-h-[52px] w-full gap-2 rounded-2xl text-base">
            <a href={whatsapp('Hello Welile, I would like to become a Welile Schools agent.')} target="_blank" rel="noopener noreferrer">
              <MessageCircle className="h-5 w-5" aria-hidden />Become a Welile agent
            </a>
          </Button>
        </StickyCta>
      ) : (
        <StickyCta note="Already a Welile agent? Sign in to open your schools.">
          <Button className="min-h-[52px] w-full gap-2 rounded-2xl text-base" onClick={() => navigate('/auth')}>
            <LogIn className="h-5 w-5" aria-hidden />Sign in to start
          </Button>
        </StickyCta>
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
  // Two tabs keep the home short: what to do today, and the list of schools.
  const [tab, setTab] = useState<'today' | 'schools'>(() => (readLockedSchool() ? 'today' : 'schools'));
  const pendingUploads = readPendingProfiles().length + readPendingGateLogs().length;

  const status = school ? data?.setup?.partnership?.status ?? null : null;
  const missing = data?.setup ? missingForSubmit(data.setup.partnership, data.setup.terms, data.setup.fees, todayKampala()) : [];
  const attention = agentAttention({ hasCurrentSchool: !!school, partnershipStatus: status, missingForSubmit: missing, pendingUploads });

  const showSchools = () => { setTab('schools'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const pick = (s: SchoolRow) => { writeLockedSchool(s); setSchool(s); setTab('today'); toast.success(`You're at ${s.name}`); };
  const open = (mode: 'gate' | 'register' | 'partner') => {
    if (!school) { toast.message('Choose the school you are at first'); showSchools(); return; }
    navigate(`${WORKSPACE}?mode=${mode}`);
  };
  const onAttention = (item: AttentionItem) => {
    if (item.kind === 'pick_school') showSchools();
    else if (item.kind === 'offline_queue') navigate(`${WORKSPACE}?mode=gate`);
    else navigate(`${WORKSPACE}?mode=partner`);
  };

  const ATTENTION_ICON = { pick_school: MapPin, finish_setup: Handshake, changes_requested: AlertCircle, rejected: AlertCircle, awaiting_approval: Hourglass, offline_queue: CloudOff } as const;
  const TONE = { danger: 'text-destructive', warning: 'text-amber-600 dark:text-amber-400', info: 'text-muted-foreground' } as const;

  return (
    <div className="space-y-4 pb-6">
      <SchoolsPhotoCarousel />

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'today' | 'schools')} className="w-full">
        <TabsList className="grid h-11 w-full grid-cols-2 rounded-full bg-muted p-1">
          <TabsTrigger value="today" className="rounded-full">Today</TabsTrigger>
          <TabsTrigger value="schools" className="rounded-full">Schools{data ? ` (${data.schools.length})` : ''}</TabsTrigger>
        </TabsList>

        <TabsContent value="today" className="mt-3 space-y-4">
          {/* Current school, with today's numbers inside the same card. */}
          {school ? (
            <section className="rounded-3xl border border-border/70 bg-card p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary"><School className="h-5 w-5" aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">You're at</p>
                  <p className="truncate text-sm font-bold">{school.name}</p>
                </div>
                <Button variant="ghost" size="sm" className="min-h-[40px] rounded-full text-primary" onClick={showSchools}>Change</Button>
              </div>
              <div className="mt-3 grid grid-cols-3 divide-x divide-border/60 rounded-2xl bg-muted/50 py-2.5 text-center">
                {[
                  { label: 'In today', value: data?.enteredToday },
                  { label: 'Inside now', value: data?.insideNow },
                  { label: 'You registered', value: data?.registered },
                ].map((s) => (
                  <div key={s.label} className="px-1">
                    <p className="text-lg font-bold tabular-nums">{isLoading || s.value == null ? '…' : s.value.toLocaleString()}</p>
                    <p className="text-[11px] text-muted-foreground">{s.label}</p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* Quick actions as a row of round icons, like an app's shortcut bar. */}
          <section aria-label="Quick actions" className="grid grid-cols-4 gap-1">
            <ActionTile icon={DoorOpen} label="Gate log" primary onClick={() => open('gate')} />
            <ActionTile icon={UserPlus} label="Register" onClick={() => open('register')} />
            <ActionTile icon={Building2} label="Set-up" onClick={() => open('partner')} />
            <ActionTile icon={Receipt} label="Families" soon
              onClick={() => toast.message('Family sign-up for School Fees Plans opens soon', { description: 'It starts once this school is an approved partner.' })} />
          </section>

          <section aria-labelledby="ws-attention">
            <h2 id="ws-attention" className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Needs your attention</h2>
            {attention.length === 0 ? (
              <p className="flex items-center gap-2 rounded-2xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-200">
                <Check className="h-4 w-4" aria-hidden />All caught up at this school.
              </p>
            ) : (
              <div className="divide-y divide-border/60 overflow-hidden rounded-3xl border border-border/70 bg-card">
                {attention.map((item) => {
                  const Icon = ATTENTION_ICON[item.kind];
                  return (
                    <button key={item.kind} type="button" onClick={() => onAttention(item)} className="flex min-h-[60px] w-full items-center gap-3 p-3 text-left hover:bg-muted/50">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted"><Icon className={cn('h-4 w-4', TONE[item.tone])} aria-hidden /></span>
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
        </TabsContent>

        <TabsContent value="schools" className="mt-3 space-y-3">
          <Button variant="outline" className="min-h-[48px] w-full gap-2 rounded-2xl border-dashed border-primary/50 text-primary hover:bg-primary/5 hover:text-primary" onClick={() => navigate(`${WORKSPACE}?new=1`)}>
            <Plus className="h-4 w-4" aria-hidden />Add a school
          </Button>
          {isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
          ) : (data?.schools.length ?? 0) === 0 ? (
            <p className="rounded-2xl bg-muted/50 p-3 text-sm text-muted-foreground">No schools registered yet. Add the first one.</p>
          ) : (
            <div className="divide-y divide-border/60 overflow-hidden rounded-3xl border border-border/70 bg-card">
              {data!.schools.map((s) => {
                const st = data!.statusBySchool[s.id];
                const current = school?.id === s.id;
                return (
                  <button key={s.id} type="button" onClick={() => pick(s)} aria-current={current ? 'true' : undefined}
                    className={cn('flex min-h-[60px] w-full items-center gap-3 p-3 text-left hover:bg-muted/50', current && 'bg-primary/5')}>
                    <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', current ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
                      <School className="h-4 w-4" aria-hidden />
                    </span>
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
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** One shortcut: a round icon with a short label underneath. */
function ActionTile({ icon: Icon, label, onClick, primary, soon }: { icon: typeof DoorOpen; label: string; onClick: () => void; primary?: boolean; soon?: boolean }) {
  return (
    <button type="button" onClick={onClick} className="flex min-h-[84px] flex-col items-center gap-1.5 rounded-2xl p-1 text-center transition active:scale-[0.97]">
      <span className={cn('relative flex h-14 w-14 items-center justify-center rounded-2xl',
        primary ? 'bg-primary text-primary-foreground shadow-md' : 'bg-primary/10 text-primary')}>
        <Icon className="h-6 w-6" aria-hidden />
        {soon ? <span className="absolute -right-1 -top-1 rounded-full bg-muted px-1.5 text-[9px] font-bold text-muted-foreground ring-2 ring-background">Soon</span> : null}
      </span>
      <span className="text-xs font-semibold leading-tight">{label}</span>
    </button>
  );
}

// ─── Parent view ──────────────────────────────────────────────────────────────

function ParentHome() {
  return (
    <div className="space-y-4 pb-8">
      <HeroHeader
        icon={GraduationCap}
        eyebrow="For parents"
        title="Spread school fees into small daily payments"
        body="Welile pays your child's term fees straight to the school. You clear them in small daily payments by mobile money."
      />

      <BenefitTiles items={[
        { icon: TrendingDown, title: 'Pay early, pay less', body: 'The fee is worked out daily on what you still owe.' },
        { icon: MessageSquareText, title: 'SMS receipt', body: 'Your new balance after every payment.' },
        { icon: Smartphone, title: 'Pay any day', body: 'MTN or Airtel, any amount.' },
      ]} />

      {/* Where the plan will live once the family has one; for now, what a plan would cost. */}
      <SchoolFeesPlanCard />
    </div>
  );
}
