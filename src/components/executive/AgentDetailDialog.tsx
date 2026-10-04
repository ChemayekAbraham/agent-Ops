import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import {
  Wallet, ArrowUpFromLine, Banknote, CreditCard, Phone, Mail, MapPin, Calendar,
  CheckCircle2, XCircle, AlertTriangle, Receipt, Award, Activity,
} from 'lucide-react';
import { AgentEvaluationSection } from './AgentEvaluationSection';
import { AgentPromissoryNotesSection } from './AgentPromissoryNotesSection';


type Props = {
  agentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const fmt = (n: number | null | undefined) => {
  const v = Number(n ?? 0);
  return v.toLocaleString();
};
const fmtShort = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : Math.round(n).toLocaleString();

export function AgentDetailDialog({ agentId, open, onOpenChange }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-detail-full', agentId],
    enabled: !!agentId && open,
    queryFn: async () => {
      if (!agentId) return null;
      const sb: any = supabase;
      const queries = [
        sb.from('profiles').select('id, full_name, phone, email, avatar_url, verified, created_at, territory, city, country, national_id, mobile_money_number, mobile_money_provider, agent_type, is_frozen, frozen_reason').eq('id', agentId).maybeSingle(),
        sb.from('wallets').select('balance, withdrawable_balance, float_balance, advance_balance, updated_at').eq('user_id', agentId).maybeSingle(),
        sb.from('user_roles').select('role, enabled, created_at').eq('user_id', agentId),
        sb.from('agent_float_limits').select('*').eq('agent_id', agentId).maybeSingle(),
        sb.from('agent_float_funding').select('id, amount, status, created_at, bank_name, bank_reference, notes').eq('agent_id', agentId).order('created_at', { ascending: false }).limit(20),
        sb.from('agent_collections').select('id, amount, payment_method, created_at, momo_payer_name, momo_phone, location_name, notes, tenant_id').is('reversed_at', null).eq('agent_id', agentId).order('created_at', { ascending: false }).limit(50),
        sb.from('agent_earnings').select('id, amount, earning_type, description, created_at').eq('agent_id', agentId).order('created_at', { ascending: false }).limit(20),
        sb.from('agent_advances').select('id, principal, outstanding_balance, status, monthly_rate, issued_at, expires_at, cycle_days').eq('agent_id', agentId).order('created_at', { ascending: false }).limit(10),
        sb.from('agent_commission_payouts').select('id, amount, status, requested_at, processed_at, mobile_money_number, mobile_money_provider, rejection_reason').eq('agent_id', agentId).order('created_at', { ascending: false }).limit(10),
        sb.from('agent_escalations').select('id, title, severity, status, escalation_type, created_at, resolved_at').eq('agent_id', agentId).order('created_at', { ascending: false }).limit(15),
        sb.from('agent_tasks').select('id, title, status, priority, due_date, created_at').eq('assigned_to', agentId).order('created_at', { ascending: false }).limit(15),
        sb.from('agent_landlord_assignments').select('id, status, assigned_at, landlord_id').eq('agent_id', agentId).order('assigned_at', { ascending: false }).limit(50),
        sb.from('general_ledger').select('id, amount, direction, category, description, created_at').eq('user_id', agentId).order('created_at', { ascending: false }).limit(30),
        sb.from('agent_collection_streaks').select('current_streak, longest_streak, last_collection_date, total_badges, streak_multiplier').eq('agent_id', agentId).maybeSingle(),
        sb.from('agent_goals').select('goal_month, target_registrations, target_activations, notes').eq('agent_id', agentId).order('goal_month', { ascending: false }).limit(3),
      ];
      const results: any[] = await Promise.all(queries);
      const [
        profileRes, walletRes, rolesRes, floatLimitsRes, floatFundingRes,
        collectionsRes, earningsRes, advancesRes, commissionsRes,
        escalationsRes, tasksRes, landlordsRes, ledgerRes, streakRes, goalsRes,
      ] = results;

      // Resolve landlord names
      const landlordIds = (landlordsRes.data || []).map((l: any) => l.landlord_id).filter(Boolean);
      const landlordMap: Record<string, any> = {};
      if (landlordIds.length > 0) {
        const { data: lls } = await sb.from('landlords').select('id, name, phone, property_address').in('id', landlordIds);
        for (const l of lls || []) landlordMap[l.id] = l;
      }
      const assignments = (landlordsRes.data || []).map((a: any) => ({
        ...a,
        landlord: landlordMap[a.landlord_id] || null,
      }));

      // Resolve tenant names for collections (so float allocations show who got paid)
      const tenantIds = Array.from(new Set(
        (collectionsRes.data || []).map((c: any) => c.tenant_id).filter(Boolean)
      ));
      const tenantMap: Record<string, any> = {};
      if (tenantIds.length > 0) {
        const { data: ts } = await sb.from('profiles').select('id, full_name, phone').in('id', tenantIds);
        for (const t of ts || []) tenantMap[t.id] = t;
      }
      const collectionsEnriched = (collectionsRes.data || []).map((c: any) => ({
        ...c,
        tenant: c.tenant_id ? tenantMap[c.tenant_id] : null,
        is_allocation: (c.notes || '').toLowerCase().includes('float allocation'),
      }));

      return {
        profile: profileRes.data,
        wallet: walletRes.data,
        roles: rolesRes.data || [],
        floatLimits: floatLimitsRes.data,
        floatFunding: floatFundingRes.data || [],
        collections: collectionsEnriched,
        allocations: collectionsEnriched.filter((c: any) => c.is_allocation),
        earnings: earningsRes.data || [],
        advances: advancesRes.data || [],
        commissions: commissionsRes.data || [],
        escalations: escalationsRes.data || [],
        tasks: tasksRes.data || [],
        assignments,
        ledger: ledgerRes.data || [],
        streak: streakRes.data,
        goals: goalsRes.data || [],
      };
    },
    staleTime: 30_000,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] sm:max-h-[85vh] p-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-4 sm:px-6 pt-4 pb-2 border-b border-border shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Activity className="h-5 w-5 text-primary" />
            Agent 360° Profile
          </DialogTitle>
        </DialogHeader>

        {isLoading || !data ? (
          <div className="p-4 space-y-3 flex-1 min-h-0 overflow-y-auto">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            <div className="p-4 sm:p-6 space-y-4">
              {/* Header card */}
              <ProfileHeader profile={data.profile} roles={data.roles} streak={data.streak} />

              {/* Wallet buckets */}
              <WalletBuckets wallet={data.wallet} />

              {/* Tabs */}
              <Tabs defaultValue="evaluation" className="w-full">
                <TabsList className="w-full justify-start overflow-x-auto flex-nowrap h-auto p-1">
                  <TabsTrigger value="evaluation" className="text-xs">Evaluation</TabsTrigger>
                  <TabsTrigger value="overview" className="text-xs">Overview</TabsTrigger>
                  <TabsTrigger value="float" className="text-xs">Float</TabsTrigger>
                  <TabsTrigger value="allocations" className="text-xs">Allocations</TabsTrigger>
                  <TabsTrigger value="collections" className="text-xs">Collections</TabsTrigger>
                  <TabsTrigger value="earnings" className="text-xs">Earnings</TabsTrigger>
                  <TabsTrigger value="advances" className="text-xs">Advances</TabsTrigger>
                  <TabsTrigger value="commissions" className="text-xs">Payouts</TabsTrigger>
                  <TabsTrigger value="ops" className="text-xs">Ops</TabsTrigger>
                  <TabsTrigger value="landlords" className="text-xs">Landlords</TabsTrigger>
                  <TabsTrigger value="promissory" className="text-xs">Promissory Notes</TabsTrigger>
                </TabsList>

                <TabsContent value="evaluation" className="mt-3">
                  <AgentEvaluationSection agentId={agentId} />
                </TabsContent>

                <TabsContent value="overview" className="mt-3 space-y-3">
                  <ContactCard profile={data.profile} />
                  {data.goals.length > 0 && <GoalsCard goals={data.goals} />}
                  {data.streak && <StreakCard streak={data.streak} />}
                </TabsContent>

                <TabsContent value="float" className="mt-3 space-y-3">
                  <FloatLimitsCard limits={data.floatLimits} />
                  <FloatFundingList items={data.floatFunding} />
                </TabsContent>

                <TabsContent value="allocations" className="mt-3">
                  <AllocationsList items={data.allocations} />
                </TabsContent>

                <TabsContent value="collections" className="mt-3">
                  <CollectionsList items={data.collections} />
                </TabsContent>

                <TabsContent value="earnings" className="mt-3">
                  <EarningsList items={data.earnings} />
                </TabsContent>

                <TabsContent value="advances" className="mt-3">
                  <AdvancesList items={data.advances} />
                </TabsContent>

                <TabsContent value="commissions" className="mt-3">
                  <CommissionPayoutsList items={data.commissions} />
                </TabsContent>

                <TabsContent value="ops" className="mt-3 space-y-3">
                  <EscalationsList items={data.escalations} />
                  <TasksList items={data.tasks} />
                </TabsContent>

                <TabsContent value="landlords" className="mt-3">
                  <LandlordsList items={data.assignments} />
                </TabsContent>

                <TabsContent value="promissory" className="mt-3">
                  {agentId && <AgentPromissoryNotesSection agentId={agentId} />}
                </TabsContent>
              </Tabs>

            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ===== Sub components =====

function ProfileHeader({ profile, roles, streak }: any) {
  if (!profile) return <div className="text-sm text-muted-foreground">Profile not found</div>;
  const initials = (profile.full_name || '?').split(' ').map((s: string) => s[0]).join('').slice(0, 2).toUpperCase();
  const activeRoles = (roles || []).filter((r: any) => r.enabled).map((r: any) => r.role);
  return (
    <div className="flex items-start gap-3 sm:gap-4 rounded-2xl border border-border bg-card p-3 sm:p-4">
      <div className="h-14 w-14 sm:h-16 sm:w-16 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-lg shrink-0">
        {profile.avatar_url ? <img src={profile.avatar_url} alt="" className="h-full w-full rounded-full object-cover" /> : initials}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-bold text-base sm:text-lg truncate">{profile.full_name || 'Unnamed'}</h3>
          {profile.verified ? (
            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 border-emerald-500/30 text-[10px]">
              <CheckCircle2 className="h-3 w-3 mr-1" />Verified
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px]"><XCircle className="h-3 w-3 mr-1" />Unverified</Badge>
          )}
          {profile.is_frozen && (
            <Badge variant="destructive" className="text-[10px]"><AlertTriangle className="h-3 w-3 mr-1" />Frozen</Badge>
          )}
          {profile.agent_type && <Badge variant="secondary" className="text-[10px] capitalize">{profile.agent_type}</Badge>}
        </div>
        <div className="flex flex-wrap gap-1 mt-1.5">
          {activeRoles.map((r: string) => (
            <span key={r} className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary/10 text-primary capitalize">{r}</span>
          ))}
        </div>
        <div className="text-xs text-muted-foreground mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
          {profile.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{profile.phone}</span>}
          {profile.territory && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{profile.territory}</span>}
          {profile.created_at && <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />Joined {format(new Date(profile.created_at), 'MMM yyyy')}</span>}
        </div>
        {profile.is_frozen && profile.frozen_reason && (
          <div className="mt-2 text-xs text-destructive bg-destructive/10 rounded-md px-2 py-1">
            Reason: {profile.frozen_reason}
          </div>
        )}
      </div>
      {streak?.current_streak > 0 && (
        <div className="hidden sm:flex flex-col items-center bg-amber-500/10 text-amber-700 rounded-xl px-3 py-2">
          <Award className="h-5 w-5" />
          <div className="text-lg font-bold leading-none mt-1">{streak.current_streak}</div>
          <div className="text-[9px] uppercase tracking-wider">Streak</div>
        </div>
      )}
    </div>
  );
}

function WalletBuckets({ wallet }: any) {
  const w = wallet || {};
  const cards = [
    { label: 'Total', value: Number(w.balance ?? 0), icon: Wallet, tone: 'bg-primary/10 text-primary' },
    { label: 'Withdrawable', value: Number(w.withdrawable_balance ?? 0), icon: ArrowUpFromLine, tone: 'bg-emerald-500/10 text-emerald-700' },
    { label: 'Float (Ops)', value: Number(w.float_balance ?? 0), icon: Banknote, tone: 'bg-blue-500/10 text-blue-700' },
    { label: 'Advance', value: Number(w.advance_balance ?? 0), icon: CreditCard, tone: 'bg-amber-500/10 text-amber-700' },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border border-border bg-card p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <div className={cn('p-1 rounded-md', c.tone)}><c.icon className="h-3 w-3" /></div>
            <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">{c.label}</span>
          </div>
          <div className="text-base sm:text-lg font-bold tabular-nums">{fmt(c.value)}</div>
          <div className="text-[10px] text-muted-foreground">UGX</div>
        </div>
      ))}
    </div>
  );
}

function ContactCard({ profile }: any) {
  if (!profile) return null;
  const items = [
    { icon: Phone, label: 'Phone', value: profile.phone },
    { icon: Mail, label: 'Email', value: profile.email },
    { icon: MapPin, label: 'Territory', value: profile.territory },
    { icon: MapPin, label: 'City', value: profile.city },
    { icon: Receipt, label: 'National ID', value: profile.national_id },
    { icon: Banknote, label: 'MoMo', value: profile.mobile_money_number ? `${profile.mobile_money_number} (${profile.mobile_money_provider || '—'})` : null },
  ].filter((i) => i.value);
  return (
    <Section title="Contact & KYC">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {items.map((i, idx) => (
          <div key={idx} className="flex items-center gap-2 text-sm">
            <i.icon className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground text-xs">{i.label}:</span>
            <span className="font-medium truncate">{i.value}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function GoalsCard({ goals }: any) {
  return (
    <Section title="Monthly Goals">
      <div className="space-y-2">
        {goals.map((g: any) => (
          <div key={g.goal_month} className="flex items-center justify-between text-sm">
            <span className="font-medium">{format(new Date(g.goal_month), 'MMM yyyy')}</span>
            <div className="flex gap-3 text-xs text-muted-foreground">
              <span>Reg: <strong className="text-foreground">{g.target_registrations}</strong></span>
              <span>Act: <strong className="text-foreground">{g.target_activations ?? '—'}</strong></span>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function StreakCard({ streak }: any) {
  return (
    <Section title="Collection Streak">
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Current" value={streak.current_streak ?? 0} />
        <Stat label="Longest" value={streak.longest_streak ?? 0} />
        <Stat label="Badges" value={streak.total_badges ?? 0} />
      </div>
      {streak.last_collection_date && (
        <div className="text-xs text-muted-foreground mt-2 text-center">
          Last collection: {format(new Date(streak.last_collection_date), 'dd MMM yyyy')}
        </div>
      )}
    </Section>
  );
}

function FloatLimitsCard({ limits }: any) {
  if (!limits) return <Section title="Float Limits"><Empty text="No float limits assigned" /></Section>;
  const used = Number(limits.collected_today ?? 0);
  const limit = Number(limits.float_limit ?? 0);
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <Section title="Float Limits & Cash on Hand">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
        <Stat label="Float Limit" value={fmtShort(limit)} />
        <Stat label="Collected Today" value={fmtShort(used)} />
        <Stat label="Cash on Hand" value={fmtShort(Number(limits.cash_on_hand ?? 0))} />
        <Stat label="Daily Txn Limit" value={fmtShort(Number(limits.daily_txn_limit ?? 0))} />
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className={cn('h-full transition-all', pct >= 90 ? 'bg-destructive' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[10px] text-muted-foreground mt-1">{pct.toFixed(0)}% of limit used today</div>
      {limits.is_paused && <Badge variant="destructive" className="mt-2 text-[10px]">Paused</Badge>}
    </Section>
  );
}

function FloatFundingList({ items }: any) {
  if (!items?.length) return <Section title="Float Funding History"><Empty text="No funding records" /></Section>;
  return (
    <Section title={`Float Funding History (${items.length})`}>
      <div className="space-y-1.5 max-h-64 overflow-auto">
        {items.map((f: any) => (
          <Row key={f.id}
            primary={`${fmt(f.amount)} UGX`}
            secondary={`${f.bank_name || 'Manual'} · ${f.bank_reference || '—'}`}
            meta={format(new Date(f.created_at), 'dd MMM yy HH:mm')}
            badge={f.status} />
        ))}
      </div>
    </Section>
  );
}

function CollectionsList({ items }: any) {
  if (!items?.length) return <Section title="Recent Collections"><Empty text="No collections yet" /></Section>;
  return (
    <Section title={`Recent Collections (${items.length})`}>
      <div className="space-y-1.5 max-h-96 overflow-auto">
        {items.map((c: any) => {
          const who = c.tenant?.full_name || c.momo_payer_name || c.location_name || (c.is_allocation ? 'Tenant payment' : '—');
          const label = c.is_allocation ? 'Float allocation' : (c.payment_method || '—');
          return (
            <Row key={c.id}
              primary={`${c.is_allocation ? '−' : '+'}${fmt(c.amount)} UGX`}
              secondary={`${label} · ${who}`}
              meta={format(new Date(c.created_at), 'dd MMM HH:mm')}
              badge={c.is_allocation ? 'allocation' : c.payment_method}
              tone={c.is_allocation ? 'text-blue-700' : 'text-emerald-700'} />
          );
        })}
      </div>
    </Section>
  );
}

function AllocationsList({ items }: any) {
  if (!items?.length) return <Section title="Float Allocations to Tenants"><Empty text="No allocations yet" /></Section>;
  const total = items.reduce((s: number, a: any) => s + Number(a.amount), 0);
  const totalCommission = Math.round(total * 0.10);
  return (
    <Section title={`Float Allocations · ${items.length} · Total ${fmtShort(total)} UGX`}>
      <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-2 mb-2 text-xs text-emerald-800">
        💰 Estimated commission earned: <strong>+{fmtShort(totalCommission)} UGX</strong> (10% of allocations)
      </div>
      <div className="space-y-1.5 max-h-96 overflow-auto">
        {items.map((a: any) => {
          const tenantName = a.tenant?.full_name || 'Unknown tenant';
          const tenantPhone = a.tenant?.phone ? ` · ${a.tenant.phone}` : '';
          const commission = Math.round(Number(a.amount) * 0.10);
          return (
            <Row key={a.id}
              primary={`${fmt(a.amount)} UGX → ${tenantName}`}
              secondary={`Commission +${fmt(commission)}${tenantPhone}`}
              meta={format(new Date(a.created_at), 'dd MMM HH:mm')}
              badge="paid"
              tone="text-blue-700" />
          );
        })}
      </div>
    </Section>
  );
}

function EarningsList({ items }: any) {
  if (!items?.length) return <Section title="Recent Earnings"><Empty text="No earnings recorded" /></Section>;
  const total = items.reduce((s: number, e: any) => s + Number(e.amount), 0);
  return (
    <Section title={`Recent Earnings · Total ${fmtShort(total)}`}>
      <div className="space-y-1.5 max-h-96 overflow-auto">
        {items.map((e: any) => (
          <Row key={e.id}
            primary={`+${fmt(e.amount)} UGX`}
            secondary={e.description || e.earning_type}
            meta={format(new Date(e.created_at), 'dd MMM HH:mm')}
            badge={e.earning_type}
            tone="text-emerald-700" />
        ))}
      </div>
    </Section>
  );
}

function AdvancesList({ items }: any) {
  if (!items?.length) return <Section title="Advances"><Empty text="No advances issued" /></Section>;
  return (
    <Section title={`Advances (${items.length})`}>
      <div className="space-y-1.5 max-h-96 overflow-auto">
        {items.map((a: any) => (
          <Row key={a.id}
            primary={`${fmt(a.principal)} UGX principal`}
            secondary={`Outstanding: ${fmt(a.outstanding_balance)} · ${a.monthly_rate}%/mo · ${a.cycle_days}d cycle`}
            meta={`Issued ${format(new Date(a.issued_at), 'dd MMM yy')}`}
            badge={a.status} />
        ))}
      </div>
    </Section>
  );
}

function CommissionPayoutsList({ items }: any) {
  if (!items?.length) return <Section title="Commission Payout Requests"><Empty text="No payout requests" /></Section>;
  return (
    <Section title={`Commission Payouts (${items.length})`}>
      <div className="space-y-1.5 max-h-96 overflow-auto">
        {items.map((c: any) => (
          <Row key={c.id}
            primary={`${fmt(c.amount)} UGX`}
            secondary={`${c.mobile_money_number} (${c.mobile_money_provider})${c.rejection_reason ? ' · ' + c.rejection_reason : ''}`}
            meta={format(new Date(c.requested_at), 'dd MMM yy')}
            badge={c.status} />
        ))}
      </div>
    </Section>
  );
}

function EscalationsList({ items }: any) {
  if (!items?.length) return <Section title="Escalations"><Empty text="No escalations" /></Section>;
  return (
    <Section title={`Escalations (${items.length})`}>
      <div className="space-y-1.5 max-h-64 overflow-auto">
        {items.map((e: any) => (
          <Row key={e.id}
            primary={e.title}
            secondary={`${e.escalation_type} · ${e.severity}`}
            meta={format(new Date(e.created_at), 'dd MMM yy')}
            badge={e.status}
            tone={e.severity === 'critical' ? 'text-destructive' : ''} />
        ))}
      </div>
    </Section>
  );
}

function TasksList({ items }: any) {
  if (!items?.length) return <Section title="Tasks"><Empty text="No tasks assigned" /></Section>;
  return (
    <Section title={`Tasks (${items.length})`}>
      <div className="space-y-1.5 max-h-64 overflow-auto">
        {items.map((t: any) => (
          <Row key={t.id}
            primary={t.title}
            secondary={`Priority: ${t.priority || 'normal'}${t.due_date ? ' · Due ' + format(new Date(t.due_date), 'dd MMM') : ''}`}
            meta={format(new Date(t.created_at), 'dd MMM yy')}
            badge={t.status} />
        ))}
      </div>
    </Section>
  );
}

function LandlordsList({ items }: any) {
  if (!items?.length) return <Section title="Assigned Landlords"><Empty text="No landlord assignments" /></Section>;
  return (
    <Section title={`Assigned Landlords (${items.length})`}>
      <div className="space-y-1.5 max-h-96 overflow-auto">
        {items.map((a: any) => (
          <Row key={a.id}
            primary={a.landlord?.name || 'Unknown landlord'}
            secondary={`${a.landlord?.phone || '—'}${a.landlord?.property_address ? ' · ' + a.landlord.property_address : ''}`}
            meta={format(new Date(a.assigned_at), 'dd MMM yy')}
            badge={a.status} />
        ))}
      </div>
    </Section>
  );
}

// ===== Primitives =====
function Section({ title, children }: any) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">{title}</h4>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: any }) {
  return (
    <div className="rounded-lg bg-muted/40 p-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm font-bold tabular-nums">{value}</div>
    </div>
  );
}

function Row({ primary, secondary, meta, badge, tone }: any) {
  return (
    <div className="flex items-start justify-between gap-2 p-2 rounded-lg hover:bg-muted/40 transition-colors">
      <div className="min-w-0 flex-1">
        <div className={cn('text-sm font-semibold tabular-nums truncate', tone)}>{primary}</div>
        {secondary && <div className="text-[11px] text-muted-foreground truncate">{secondary}</div>}
      </div>
      <div className="text-right shrink-0">
        {badge && (
          <Badge variant="outline" className="text-[9px] capitalize mb-1">{badge}</Badge>
        )}
        {meta && <div className="text-[10px] text-muted-foreground">{meta}</div>}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-xs text-muted-foreground text-center py-4">{text}</div>;
}
