import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addDays, format, startOfDay, subDays } from 'date-fns';
import {
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  History,
  Loader2,
  Phone,
  Search,
  Users,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { unmatchedRepayments } from '@/lib/rentReceipts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UserDrilldownDrawer } from '@/components/ops/UserDrilldownDrawer';
import { AgentPaymentPosition } from './AgentPaymentPosition';
import { RentAnalysis } from './RentAnalysis';
import {
  describePlanSchedule,
  scheduleAwareStatus,
  type AgentScheduleStatus,
  type PlanSchedule,
} from '@/lib/agentMonitoringSchedule';


interface ActiveRentRequest {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  landlord_id: string | null;
  daily_repayment: number | null;
  total_repayment: number | null;
  amount_repaid: number | null;
  status: string;
  created_at: string;
  house_category: string | null;
  landlord_name?: string | null;
  property_address?: string | null;
  repayment_frequency: string | null;
  repayment_starts_on: string | null;
}

interface Profile {
  id: string;
  full_name: string | null;
  phone: string | null;
  created_at: string | null;
}

interface Collection {
  id: string;
  agent_id: string | null;
  tenant_id: string;
  amount: number | null;
  created_at: string;
  /** Authoritative link to the rent plan the receipt was posted against. */
  rent_request_id: string | null;
}

/** One recorded receipt, as already stored by the collection flow. */
interface PaymentRecord {
  id: string;
  rent_request_id: string | null;
  tenant_id: string;
  agent_id: string | null;
  amount: number | null;
  created_at: string;
  payment_method: string | null;
  is_partial: boolean | null;
  expected_amount: number | null;
  momo_provider: string | null;
  tracking_id: string | null;
  /** Where the receipt was recorded: agent collection or tenant self-payment. */
  source: 'agent' | 'tenant';
}

/** A tenant self-payment row, the other authoritative receipt table. */
interface RepaymentRow {
  id: string;
  rent_request_id: string | null;
  tenant_id: string;
  amount: number | null;
  created_at: string;
  payment_method: string | null;
  paid_by: string | null;
  external_reference: string | null;
}

/** Shared receipt pairing rule — see `src/lib/rentReceipts.ts`. */


interface AgentRow {
  id: string;
  name: string;
  phone: string | null;
  tenantCount: number;
  /** UGX genuinely due on the selected day, per each tenant's own schedule. */
  expected: number;
  collected: number;
  requestCount: number;
  tenants: ActiveRentRequest[];
  /** Tenants whose schedule places an obligation on the selected day. */
  dueCount: number;
  /** Due tenants already settled by earlier over-payment. */
  coveredAheadCount: number;
  dailyCount: number;
  weeklyCount: number;
  /** Total UGX owed for periods already due across the portfolio. */
  arrears: number;
  behindCount: number;
  aheadCount: number;
}


const PAGE_SIZE = 1000;

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Unable to load agent monitoring data.';

async function fetchAll<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await query(from, from + PAGE_SIZE - 1);
    if (result.error) throw new Error(result.error.message);
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function dayBounds(day: Date) {
  const date = format(day, 'yyyy-MM-dd');
  const from = new Date(`${date}T00:00:00+03:00`);
  const to = new Date(`${format(addDays(day, 1), 'yyyy-MM-dd')}T00:00:00+03:00`);
  return { from: from.toISOString(), to: to.toISOString() };
}

type CollectionStatus = AgentScheduleStatus;

const collectionStatus = scheduleAwareStatus;

const STATUS_LABEL: Record<CollectionStatus, string> = {
  full: 'On target',
  partial: 'Partial',
  critical: 'Critical',
  none: 'Nothing due',
};

function StatusIndicator({ status }: { status: CollectionStatus }) {
  if (status === 'none') {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground">
        <CircleDot className="h-3 w-3" /> {STATUS_LABEL.none}
      </Badge>
    );
  }
  if (status === 'full') {
    return (
      <Badge className="gap-1 bg-success text-success-foreground hover:bg-success/90">
        <CircleCheck className="h-3 w-3" /> {STATUS_LABEL.full}
      </Badge>
    );
  }
  if (status === 'partial') {
    return (
      <Badge className="gap-1 bg-warning text-warning-foreground hover:bg-warning/90">
        <CircleDot className="h-3 w-3" /> {STATUS_LABEL.partial}
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="gap-1">
      <CircleAlert className="h-3 w-3" /> {STATUS_LABEL.critical}
    </Badge>
  );
}


function formatStatus(status: string) {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function FrequencyTag({ schedule }: { schedule: PlanSchedule }) {
  const weekly = schedule.weekly;
  return (
    <div className="flex flex-col gap-0.5">
      <Badge
        variant="outline"
        className={cn(
          'w-fit gap-1 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide',
          weekly ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-blue-300 bg-blue-50 text-blue-700',
        )}
      >
        {weekly ? <CalendarDays className="h-3 w-3" /> : <CircleDot className="h-3 w-3" />}
        {weekly ? 'Weekly' : 'Daily'}
      </Badge>
      {weekly && schedule.nextDueDate && (
        <span className="text-[10px] text-muted-foreground">
          Next: {format(new Date(`${schedule.nextDueDate}T00:00:00`), 'dd MMM yyyy')}
        </span>
      )}
    </div>
  );
}

/** Small pill describing a tenant's position against their own schedule. */
function SchedulePositionTag({ schedule }: { schedule: PlanSchedule }) {
  const unit = schedule.unit;
  if (schedule.arrears > 0) {
    const behind = schedule.periodsBehind;
    return (
      <Badge variant="outline" className="w-fit gap-1 border-destructive/40 bg-destructive/10 px-1.5 py-0 text-[10px] font-medium text-destructive">
        {formatUGX(schedule.arrears)} behind{behind > 0 ? ` · ${behind} ${unit}${behind === 1 ? '' : 's'}` : ''}
      </Badge>
    );
  }
  if (schedule.periodsAhead > 0) {
    return (
      <Badge variant="outline" className="w-fit gap-1 border-success/40 bg-success/10 px-1.5 py-0 text-[10px] font-medium text-success">
        {schedule.periodsAhead} {unit}{schedule.periodsAhead === 1 ? '' : 's'} paid ahead
      </Badge>
    );
  }
  if (schedule.dueState === 'due_this_week') {
    return (
      <Badge variant="outline" className="w-fit gap-1 border-amber-300 bg-amber-50 px-1.5 py-0 text-[10px] font-medium text-amber-700">
        Due this week
        {schedule.nextDueDate
          ? ` · ${format(new Date(`${schedule.nextDueDate}T00:00:00`), 'EEE dd MMM')}`
          : ''}
      </Badge>
    );
  }
  if (schedule.dueState === 'due_today') {
    return (
      <Badge variant="outline" className="w-fit px-1.5 py-0 text-[10px] font-medium text-foreground">
        Due today
      </Badge>
    );
  }
  if (!schedule.dueOnDay) {
    return (
      <Badge variant="outline" className="w-fit px-1.5 py-0 text-[10px] font-medium text-muted-foreground">
        Not due
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="w-fit px-1.5 py-0 text-[10px] font-medium text-muted-foreground">
      On schedule
    </Badge>
  );
}


/** Recorded receipts for one rent plan, newest first. */
function TenantPaymentHistory({
  payments,
  loading,
  planAgentId,
  nameFor,
}: {
  payments: PaymentRecord[];
  loading: boolean;
  planAgentId: string;
  nameFor: (id: string) => string;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? payments : payments.slice(0, 5);

  if (loading) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading payment history…
      </p>
    );
  }

  if (payments.length === 0) {
    return <p className="text-[11px] text-muted-foreground">No payments recorded on this rent plan yet.</p>;
  }

  const total = payments.reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          <History className="h-3 w-3" /> Recent payments
        </Label>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {payments.length} payment{payments.length === 1 ? '' : 's'} · {formatUGX(total)} received
        </span>
      </div>
      <ul className="divide-y rounded-md border">
        {visible.map((payment) => {
          const collector = payment.source === 'tenant'
            ? 'paid by the tenant'
            : payment.agent_id && payment.agent_id !== planAgentId
              ? `received by ${nameFor(payment.agent_id)}`
              : null;
          const method = (payment.payment_method || '').replace(/_/g, ' ');
          return (
            <li key={payment.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2.5 py-1.5 text-[11px]">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium tabular-nums">{format(new Date(payment.created_at), 'dd MMM yyyy')}</span>
                <span className="text-muted-foreground tabular-nums">{format(new Date(payment.created_at), 'HH:mm')}</span>
                {method && (
                  <Badge variant="outline" className="px-1.5 py-0 text-[9px] uppercase tracking-wide text-muted-foreground">
                    {payment.momo_provider ? `${method} · ${payment.momo_provider}` : method}
                  </Badge>
                )}
                {payment.is_partial && (
                  <Badge variant="outline" className="border-warning/40 bg-warning/10 px-1.5 py-0 text-[9px] text-warning-foreground">
                    Partial{payment.expected_amount ? ` of ${formatUGX(Number(payment.expected_amount))}` : ''}
                  </Badge>
                )}
                {collector && <span className="truncate text-muted-foreground">{collector}</span>}
              </div>
              <span className="font-semibold tabular-nums">{formatUGX(Number(payment.amount ?? 0))}</span>
            </li>
          );
        })}
      </ul>
      {payments.length > 5 && (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setShowAll((value) => !value)}>
          {showAll ? 'Show less' : `Show full history (${payments.length})`}
        </Button>
      )}
    </div>
  );
}


/** Presentation-only summary tile: big scannable figure, quiet label, no overflow. */
const STAT_ACCENT: Record<'neutral' | 'primary' | 'success' | 'danger' | 'info', string> = {
  neutral: 'text-foreground',
  primary: 'text-primary',
  success: 'text-emerald-600 dark:text-emerald-400',
  danger: 'text-destructive',
  info: 'text-sky-600 dark:text-sky-400',
};

function StatCard({
  label,
  value,
  hint,
  accent = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: keyof typeof STAT_ACCENT;
}) {
  return (
    <Card className="overflow-hidden border-border/70 shadow-sm transition-shadow hover:shadow-md">
      <CardContent className="flex h-full min-w-0 flex-col p-3 sm:p-4">
        <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:text-[11px]">
          {label}
        </p>
        <p
          className={cn(
            'mt-1.5 break-words text-lg font-bold leading-tight tabular-nums sm:text-xl',
            STAT_ACCENT[accent],
          )}
        >
          {value}
        </p>
        {hint && <p className="mt-1 break-words text-[10px] leading-snug text-muted-foreground sm:text-xs">{hint}</p>}
      </CardContent>
    </Card>
  );
}

type AgentMonitoringTab = 'all' | 'after-aug-2026' | 'before-aug-2026' | 'position' | 'rent-analysis';

/** Same boundary for both cohort tabs — one date rule, read from the existing added date. */
const AUG_2026_BOUNDARY = '2026-08-02T00:00:00+03:00';

export function AgentMonitoring() {
  const [tab, setTab] = useState<AgentMonitoringTab>('all');
  const [day, setDay] = useState(() => startOfDay(new Date()));
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | CollectionStatus>('all');
  const [frequencyFilter, setFrequencyFilter] = useState<'all' | 'daily' | 'weekly'>('all');

  const [selectedAgent, setSelectedAgent] = useState<AgentRow | null>(null);
  const [selectedTenant, setSelectedTenant] = useState<string | null>(null);
  const bounds = useMemo(() => dayBounds(day), [day]);
  const createdAfter = tab === 'after-aug-2026' ? AUG_2026_BOUNDARY : undefined;
  const createdBefore = tab === 'before-aug-2026' ? AUG_2026_BOUNDARY : undefined;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['tenant-ops-agent-monitoring', format(day, 'yyyy-MM-dd')],
    queryFn: async () => {
      const eligibility = await fetchAll<{ rent_request_id: string }>((from, to) =>
        supabase.from('v_tenant_daily_eligibility').select('rent_request_id').range(from, to),
      );
      const eligibleIds = new Set(eligibility.map((row) => row.rent_request_id));
      if (eligibleIds.size === 0) return { requests: [], collections: [], repayments: [] as RepaymentRow[], profiles: [] as Profile[], requestCounts: new Map<string, number>() };

      const requests = await fetchAll<ActiveRentRequest>((from, to) =>
        supabase
          .from('rent_requests')
          .select('id, tenant_id, agent_id, landlord_id, daily_repayment, total_repayment, amount_repaid, status, created_at, house_category, repayment_frequency, repayment_starts_on')
          .in('status', ['funded', 'disbursed', 'repaying'])
          .range(from, to),
      );
      const activeRequests = requests.filter((request) => eligibleIds.has(request.id) && request.agent_id);
      /* Every receipt posted against a plan on this day counts, whoever keyed it
         in — a payment recorded by a previous agent, a sub-agent or ops is still
         the tenant's payment. Only rows with no plan link fall back to the
         legacy agent+tenant pairing below. */
      const { data: collections, error: collectionsError } = await supabase
        .from('agent_collections')
        .select('id, agent_id, tenant_id, amount, created_at, rent_request_id')
        .gte('created_at', bounds.from)
        .lt('created_at', bounds.to);
      if (collectionsError) throw collectionsError;

      /* Tenants also pay themselves (wallet, mobile money, deposit bridge). Those
         receipts land in `repayments` and never in `agent_collections`, so a day
         settled by the tenant used to read as a missed day. */
      const { data: dayRepayments, error: repaymentsError } = await supabase
        .from('repayments')
        .select('id, rent_request_id, tenant_id, amount, created_at, payment_method, paid_by, external_reference')
        .gte('created_at', bounds.from)
        .lt('created_at', bounds.to)
        .not('rent_request_id', 'is', null);
      if (repaymentsError) throw repaymentsError;

      const agentIds = new Set<string>(activeRequests.map((request) => request.agent_id).filter((id): id is string => Boolean(id)));
      const requestCounts = new Map<string, number>();
      const allRequests = await fetchAll<{ agent_id: string | null }>((from, to) =>
        supabase.from('rent_requests').select('agent_id').not('agent_id', 'is', null).range(from, to),
      );
      allRequests.forEach((request) => {
        if (request.agent_id) requestCounts.set(request.agent_id, (requestCounts.get(request.agent_id) ?? 0) + 1);
      });
      (collections ?? []).forEach((collection) => { if (collection.agent_id) agentIds.add(collection.agent_id); });

      const ids = Array.from(new Set([
        ...Array.from(agentIds),
        ...activeRequests.map((request) => request.tenant_id),
      ]));
      const profiles: Profile[] = [];
      const CHUNK = 300;
      for (let index = 0; index < ids.length; index += CHUNK) {
        const { data: batch, error: profileError } = await supabase
          .from('profiles')
          .select('id, full_name, phone, created_at')
          .in('id', ids.slice(index, index + CHUNK));
        if (profileError) throw profileError;
        profiles.push(...((batch ?? []) as Profile[]));
      }

      return {
        requests: activeRequests,
        collections: (collections ?? []) as Collection[],
        repayments: unmatchedRepayments((dayRepayments ?? []) as RepaymentRow[], (collections ?? []) as Collection[]),
        profiles,
        requestCounts,
      };

    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const profileMap = useMemo(() => new Map((data?.profiles ?? []).map((profile) => [profile.id, profile])), [data?.profiles]);
  /**
   * A receipt belongs to the rent plan it was posted against, not to whoever
   * happened to key it in. Attributing by `agent_id + tenant_id` hid every
   * payment recorded by a different agent (transfers, sub-agents, ops entries)
   * from the plan's own agent, which made paying tenants look like missed days.
   * `rent_request_id` is the authoritative link; the agent+tenant map only
   * still serves legacy rows that carry no plan reference.
   */
  const collectionMap = useMemo(() => {
    const byPlan = new Map<string, number>();
    const byAgentTenant = new Map<string, number>();
    (data?.collections ?? []).forEach((collection) => {
      const amount = Number(collection.amount ?? 0);
      if (collection.rent_request_id) {
        byPlan.set(collection.rent_request_id, (byPlan.get(collection.rent_request_id) ?? 0) + amount);
        return;
      }
      const key = `${collection.agent_id}:${collection.tenant_id}`;
      byAgentTenant.set(key, (byAgentTenant.get(key) ?? 0) + amount);
    });
    // Tenant self-payments settle the same day's obligation.
    (data?.repayments ?? []).forEach((row) => {
      if (!row.rent_request_id) return;
      byPlan.set(row.rent_request_id, (byPlan.get(row.rent_request_id) ?? 0) + Number(row.amount ?? 0));
    });
    return {
      forPlan: (agentId: string, request: Pick<ActiveRentRequest, 'id' | 'tenant_id'>) =>
        (byPlan.get(request.id) ?? 0) + (byAgentTenant.get(`${agentId}:${request.tenant_id}`) ?? 0),
    };
  }, [data?.collections, data?.repayments]);


  /** One schedule reading per rent plan, computed once for the selected day. */
  const scheduleMap = useMemo(() => {
    const map = new Map<string, PlanSchedule>();
    (data?.requests ?? []).forEach((request) => {
      map.set(request.id, describePlanSchedule(request, day));
    });
    return map;
  }, [data?.requests, day]);

  const agents = useMemo<AgentRow[]>(() => {
    const grouped = new Map<string, ActiveRentRequest[]>();
    (data?.requests ?? []).forEach((request) => {
      if (!request.agent_id) return;
      const rows = grouped.get(request.agent_id) ?? [];
      rows.push(request);
      grouped.set(request.agent_id, rows);
    });
    (data?.collections ?? []).forEach((collection) => {
      if (!grouped.has(collection.agent_id)) grouped.set(collection.agent_id, []);
    });

    return Array.from(grouped.entries())
      .map(([agentId, allTenants]) => {
        const tenants = frequencyFilter === 'all'
          ? allTenants
          : allTenants.filter((request) => {
            const schedule = scheduleMap.get(request.id);
            return frequencyFilter === 'weekly' ? schedule?.weekly : !schedule?.weekly;
          });

        let expected = 0;
        let dueCount = 0;
        let coveredAheadCount = 0;
        let dailyCount = 0;
        let weeklyCount = 0;
        let arrears = 0;
        let behindCount = 0;
        let aheadCount = 0;

        tenants.forEach((request) => {
          const schedule = scheduleMap.get(request.id);
          if (!schedule) return;
          expected += schedule.expectedOnDay;
          if (schedule.expectedOnDay > 0) dueCount += 1;
          if (schedule.coveredByAdvance) coveredAheadCount += 1;
          if (schedule.weekly) weeklyCount += 1; else dailyCount += 1;
          arrears += schedule.arrears;
          if (schedule.arrears > 0) behindCount += 1;
          if (schedule.periodsAhead > 0) aheadCount += 1;
        });

        const collected = tenants.reduce(
          (sum, request) => sum + collectionMap.forPlan(agentId, request),
          0,
        );
        const profile = profileMap.get(agentId);
        return {
          id: agentId,
          name: profile?.full_name || 'Unnamed agent',
          phone: profile?.phone ?? null,
          tenantCount: new Set(tenants.map((request) => request.tenant_id)).size,
          expected,
          collected,
          requestCount: data?.requestCounts.get(agentId) ?? 0,
          tenants,
          dueCount,
          coveredAheadCount,
          dailyCount,
          weeklyCount,
          arrears,
          behindCount,
          aheadCount,
        };
      })
      .filter((agent) => {
        if (frequencyFilter !== 'all' && agent.tenants.length === 0) return false;
        if (!createdAfter && !createdBefore) return true;
        const profile = profileMap.get(agent.id);
        if (!profile?.created_at) return false;
        const added = new Date(profile.created_at);
        if (createdAfter) return added >= new Date(createdAfter);
        return added < new Date(createdBefore as string);
      })
      .sort((a, b) => b.expected - a.expected || a.name.localeCompare(b.name));
  }, [collectionMap, createdAfter, createdBefore, data?.collections, data?.requests, data?.requestCounts, frequencyFilter, profileMap, scheduleMap]);

  const filteredAgents = useMemo(() => {
    const query = search.trim().toLowerCase();
    return agents.filter((agent) => {
      const matchesSearch = !query || `${agent.name} ${agent.phone ?? ''}`.toLowerCase().includes(query);
      const status = collectionStatus(agent.expected, agent.collected);
      return matchesSearch && (statusFilter === 'all' || statusFilter === status);
    });
  }, [agents, search, statusFilter]);

  const totals = useMemo(() => filteredAgents.reduce(
    (sum, agent) => ({
      expected: sum.expected + agent.expected,
      collected: sum.collected + agent.collected,
      dueCount: sum.dueCount + agent.dueCount,
      tenantCount: sum.tenantCount + agent.tenantCount,
      dailyCount: sum.dailyCount + agent.dailyCount,
      weeklyCount: sum.weeklyCount + agent.weeklyCount,
      arrears: sum.arrears + agent.arrears,
      behindCount: sum.behindCount + agent.behindCount,
      aheadCount: sum.aheadCount + agent.aheadCount,
      nothingDue: sum.nothingDue + (agent.expected <= 0 ? 1 : 0),
    }),
    { expected: 0, collected: 0, dueCount: 0, tenantCount: 0, dailyCount: 0, weeklyCount: 0, arrears: 0, behindCount: 0, aheadCount: 0, nothingDue: 0 },
  ), [filteredAgents]);

  const selectedAgentRows = useMemo(() => {
    if (!selectedAgent) return [];
    return selectedAgent.tenants.map((request) => ({
      request,
      tenant: profileMap.get(request.tenant_id),
      collected: collectionMap.forPlan(selectedAgent.id, request),
      schedule: scheduleMap.get(request.id) ?? describePlanSchedule(request, day),
    }));
  }, [collectionMap, day, profileMap, scheduleMap, selectedAgent]);

  const selectedPlanIds = useMemo(
    () => (selectedAgent ? selectedAgent.tenants.map((request) => request.id).sort() : []),
    [selectedAgent],
  );

  /**
   * The full receipt history for the open agent's plans, from both authoritative
   * receipt tables: `agent_collections` (keyed in by whichever agent collected —
   * current or previous) and `repayments` (tenant self-payments and the other
   * supported channels). Repayment rows that mirror a collection are dropped so
   * the same money is never listed twice.
   */
  const { data: paymentHistory, isLoading: historyLoading } = useQuery({
    queryKey: ['tenant-ops-agent-monitoring-history', selectedPlanIds],
    enabled: selectedPlanIds.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const collections: Collection[] = [];
      const rows: PaymentRecord[] = [];
      const selfPayments: RepaymentRow[] = [];
      const CHUNK = 100;
      for (let index = 0; index < selectedPlanIds.length; index += CHUNK) {
        const slice = selectedPlanIds.slice(index, index + CHUNK);
        const [collected, repaid] = await Promise.all([
          supabase
            .from('agent_collections')
            .select('id, rent_request_id, tenant_id, agent_id, amount, created_at, payment_method, is_partial, expected_amount, momo_provider, tracking_id')
            .in('rent_request_id', slice)
            .order('created_at', { ascending: false }),
          supabase
            .from('repayments')
            .select('id, rent_request_id, tenant_id, amount, created_at, payment_method, paid_by, external_reference')
            .in('rent_request_id', slice)
            .order('created_at', { ascending: false }),
        ]);
        if (collected.error) throw collected.error;
        if (repaid.error) throw repaid.error;
        const batch = (collected.data ?? []) as unknown as Omit<PaymentRecord, 'source'>[];
        collections.push(...(batch as unknown as Collection[]));
        rows.push(...batch.map((row) => ({ ...row, payment_method: row.payment_method, source: 'agent' as const })));
        selfPayments.push(...((repaid.data ?? []) as RepaymentRow[]));
      }
      unmatchedRepayments(selfPayments, collections).forEach((row) => {
        rows.push({
          id: row.id,
          rent_request_id: row.rent_request_id,
          tenant_id: row.tenant_id,
          agent_id: null,
          amount: row.amount,
          created_at: row.created_at,
          payment_method: row.payment_method,
          is_partial: null,
          expected_amount: null,
          momo_provider: null,
          tracking_id: row.external_reference,
          source: 'tenant',
        });
      });
      const byPlan = new Map<string, PaymentRecord[]>();
      rows
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .forEach((row) => {
          if (!row.rent_request_id) return;
          const list = byPlan.get(row.rent_request_id) ?? [];
          list.push(row);
          byPlan.set(row.rent_request_id, list);
        });
      return byPlan;
    },
  });





  const renderAgentRow = (agent: AgentRow, compact = false) => {
    const rate = agent.expected > 0 ? Math.min(100, (agent.collected / agent.expected) * 100) : null;
    const callHref = agent.phone ? `tel:${agent.phone.replace(/[^\d+]/g, '')}` : null;

    if (compact) {
      return (
        <div key={agent.id} className="rounded-xl border border-border/70 bg-card p-3 shadow-sm">
          <button
            type="button"
            className="flex w-full items-start justify-between gap-3 text-left"
            onClick={() => setSelectedAgent(agent)}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold leading-tight">{agent.name}</p>
              <p className="truncate text-xs text-muted-foreground">{agent.phone || 'No phone number'} · {agent.tenantCount} tenants</p>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                <span className="text-base font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{formatUGX(agent.collected)}</span>
                <span className="text-xs tabular-nums text-muted-foreground">of {formatUGX(agent.expected)}</span>
                <span className="text-xs font-semibold tabular-nums">· {rate === null ? '—' : `${rate.toFixed(1)}%`}</span>
              </div>
              {agent.arrears > 0 && (
                <p className="mt-1 break-words text-xs font-medium tabular-nums text-destructive">
                  Arrears {formatUGX(agent.arrears)} · {agent.behindCount} behind
                </p>
              )}
            </div>
            <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusIndicator status={collectionStatus(agent.expected, agent.collected)} />
            {callHref && (
              <Button asChild size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
                <a href={callHref}><Phone className="h-3.5 w-3.5" /> Call</a>
              </Button>
            )}
          </div>
        </div>
      );
    }

    return (
      <TableRow key={agent.id} className="cursor-pointer transition-colors hover:bg-muted/40" onClick={() => setSelectedAgent(agent)}>
        <TableCell>
          <div className="min-w-[170px]">
            <p className="font-semibold leading-tight">{agent.name}</p>
            <p className="text-xs text-muted-foreground">{agent.phone || 'No phone number'}</p>
          </div>
        </TableCell>
        <TableCell className="whitespace-nowrap text-right tabular-nums">
          <span className="font-semibold">{agent.tenantCount}</span>
          <span className="block text-[10px] text-muted-foreground">{agent.dailyCount}D / {agent.weeklyCount}W</span>
        </TableCell>
        <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums">{agent.dueCount}</TableCell>
        <TableCell className="whitespace-nowrap text-right tabular-nums">{formatUGX(agent.expected)}</TableCell>
        <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{formatUGX(agent.collected)}</TableCell>
        <TableCell className="whitespace-nowrap text-right tabular-nums">
          <span className={cn('font-semibold', agent.arrears > 0 && 'text-destructive')}>{formatUGX(agent.arrears)}</span>
          <span className="block text-[10px] text-muted-foreground">{agent.behindCount} behind · {agent.aheadCount} ahead</span>
        </TableCell>

        <TableCell className="whitespace-nowrap text-right font-bold tabular-nums">
          {rate === null ? '—' : `${rate.toFixed(1)}%`}
        </TableCell>
        <TableCell className="text-right tabular-nums">{agent.requestCount}</TableCell>
        <TableCell><StatusIndicator status={collectionStatus(agent.expected, agent.collected)} /></TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            {callHref && (
              <Button
                asChild
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                aria-label={`Call ${agent.name}`}
                onClick={(event) => event.stopPropagation()}
              >
                <a href={callHref}><Phone className="h-4 w-4" /></a>
              </Button>
            )}
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </div>
        </TableCell>
      </TableRow>
    );
  };


  const body = (
    <>
      <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10">
            <Users className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold leading-tight tracking-tight sm:text-xl">Agent Monitoring</h1>
            <p className="truncate text-xs text-muted-foreground">Daily expected collections and field performance</p>
          </div>
        </div>
        <div className="flex w-full items-center gap-1 rounded-xl border bg-muted/40 p-1 sm:w-auto">
          <Button variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0" onClick={() => setDay((value) => subDays(value, 1))} aria-label="Previous day">←</Button>
          <div className="min-w-0 flex-1 truncate text-center text-xs font-semibold tabular-nums sm:flex-none sm:min-w-[132px]">{format(day, 'dd MMM yyyy')}</div>
          <Button variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0" onClick={() => setDay((value) => addDays(value, 1))} aria-label="Next day">→</Button>
          <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5 text-xs" onClick={() => setDay(startOfDay(new Date()))}>
            <CalendarDays className="h-3.5 w-3.5" /> Today
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 xl:grid-cols-6">
        <StatCard label="Agents monitored" value={String(filteredAgents.length)} hint={`${totals.nothingDue} with nothing due`} accent="neutral" />
        <StatCard label="Due this day" value={String(totals.dueCount)} hint={`of ${totals.tenantCount} tenants`} accent="primary" />
        <StatCard label="Collected today" value={formatUGX(totals.collected)} hint={`of ${formatUGX(totals.expected)} expected`} accent="success" />
        <StatCard label="Total arrears" value={formatUGX(totals.arrears)} hint={`${totals.behindCount} tenants behind`} accent={totals.arrears > 0 ? 'danger' : 'neutral'} />
        <StatCard label="Paid ahead" value={String(totals.aheadCount)} hint="tenants covering future periods" accent="info" />
        <StatCard label="Daily / weekly" value={`${totals.dailyCount} / ${totals.weeklyCount}`} hint="plans by payment period" accent="neutral" />
      </div>

      <Card className="overflow-hidden border-border/70 shadow-sm">
        <CardHeader className="flex flex-col gap-3 border-b bg-muted/30 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-sm font-semibold tracking-tight sm:text-base">Collection performance</CardTitle>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
            <div className="relative w-full sm:w-56">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search agent or phone" className="h-8 w-full bg-background pl-8 text-xs" />
            </div>
            <div className="flex flex-wrap gap-1 rounded-lg border bg-background p-0.5" role="group" aria-label="Payment frequency filter">
              {(['all', 'daily', 'weekly'] as const).map((value) => (
                <Button key={value} variant={frequencyFilter === value ? 'secondary' : 'ghost'} size="sm" className="h-7 px-2.5 text-xs font-medium capitalize" onClick={() => setFrequencyFilter(value)}>
                  {value === 'all' ? 'All plans' : value}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1 rounded-lg border bg-background p-0.5" role="group" aria-label="Collection status filter">
              {(['all', 'full', 'partial', 'critical', 'none'] as const).map((value) => (
                <Button key={value} variant={statusFilter === value ? 'secondary' : 'ghost'} size="sm" className="h-7 px-2.5 text-xs font-medium" onClick={() => setStatusFilter(value)}>
                  {value === 'all' ? 'All' : STATUS_LABEL[value]}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading agent collections…</div>
          ) : isError ? (
            <div className="flex flex-col items-center gap-3 p-10 text-center"><AlertTriangle className="h-5 w-5 text-destructive" /><p className="text-sm text-muted-foreground">{getErrorMessage(error)}</p><Button variant="outline" size="sm" onClick={() => void refetch()}>Try again</Button></div>
          ) : filteredAgents.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-10 text-center"><CircleAlert className="h-5 w-5 text-muted-foreground" /><p className="text-sm font-medium">No agents match this view</p><p className="text-xs text-muted-foreground">Try clearing the search or status filter.</p></div>
          ) : (
            <>
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader className="[&_th]:whitespace-nowrap [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide"><TableRow className="bg-muted/20"><TableHead>Agent name / phone</TableHead><TableHead className="text-right">Tenants</TableHead><TableHead className="text-right">Due</TableHead><TableHead className="text-right">Expected</TableHead><TableHead className="text-right">Collected</TableHead><TableHead className="text-right">Arrears</TableHead><TableHead className="text-right">Collection %</TableHead><TableHead className="text-right">Requests submitted</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
                  <TableBody>{filteredAgents.map((agent) => renderAgentRow(agent))}</TableBody>
                </Table>
              </div>
              <div className="space-y-2 p-3 md:hidden">{filteredAgents.map((agent) => renderAgentRow(agent, true))}</div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={Boolean(selectedAgent)} onOpenChange={(open) => { if (!open) setSelectedAgent(null); }}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="break-words pr-6 text-base sm:text-lg">{selectedAgent?.name || 'Agent'} — collection details</DialogTitle>
            <DialogDescription className="break-words">{selectedAgent?.phone || 'No phone number'} · {format(day, 'dd MMM yyyy')}</DialogDescription>
          </DialogHeader>
          {selectedAgent && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">Tenants</p><p className="mt-1 font-bold tabular-nums">{selectedAgent.tenantCount}</p></CardContent></Card>
                <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">Expected</p><p className="mt-1 font-bold tabular-nums">{formatUGX(selectedAgent.expected)}</p></CardContent></Card>
                <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">Paid today</p><p className="mt-1 font-bold tabular-nums">{formatUGX(selectedAgent.collected)}</p></CardContent></Card>
                <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">Requests submitted</p><p className="mt-1 font-bold tabular-nums">{selectedAgent.requestCount}</p></CardContent></Card>
              </div>
              {selectedAgent.phone && (
                <Button asChild variant="outline" size="sm" className="w-full gap-2 sm:w-auto">
                  <a href={`tel:${selectedAgent.phone.replace(/[^\d+]/g, '')}`}>
                    <Phone className="h-4 w-4" /> Call {selectedAgent.name}
                  </a>
                </Button>
              )}
              <Separator />
              <div className="space-y-2">
                <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Active tenants</h3><StatusIndicator status={collectionStatus(selectedAgent.expected, selectedAgent.collected)} /></div>
                {selectedAgentRows.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">No active daily-collection tenants for this agent.</p> : (
                  <div className="space-y-2">
                    {selectedAgentRows.map(({ request, tenant, collected, schedule }) => {
                      const unit = schedule.unit;
                      return (
                        <div key={request.id} className="border p-3">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <Button variant="link" className="h-auto p-0 text-left font-semibold" onClick={() => setSelectedTenant(request.tenant_id)}>{tenant?.full_name || 'Unknown tenant'}</Button>
                              <p className="text-xs text-muted-foreground">
                                {tenant?.phone ? (
                                  <a href={`tel:${tenant.phone.replace(/[^\d+]/g, '')}`} className="underline underline-offset-2">{tenant.phone}</a>
                                ) : 'No phone number'}{request.house_category ? ` · ${request.house_category}` : ''}
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">Rent Plan: {formatStatus(request.status)} · Started {format(new Date(request.created_at), 'dd MMM yyyy')}</p>
                            </div>
                            <div className="flex flex-col items-start gap-1.5 sm:items-end">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <FrequencyTag schedule={schedule} />
                                <StatusIndicator status={collectionStatus(schedule.expectedOnDay, collected)} />
                              </div>
                              <SchedulePositionTag schedule={schedule} />
                            </div>
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
                            <div><Label className="text-[10px] text-muted-foreground">Scheduled / {unit}</Label><p className="font-semibold tabular-nums">{formatUGX(schedule.periodAmount)}</p></div>
                            <div><Label className="text-[10px] text-muted-foreground">Due this day</Label><p className="font-semibold tabular-nums">{schedule.expectedOnDay > 0 ? formatUGX(schedule.expectedOnDay) : 'Not due'}</p></div>
                            <div><Label className="text-[10px] text-muted-foreground">Paid today</Label><p className="font-semibold tabular-nums">{formatUGX(collected)}</p></div>
                            <div><Label className="text-[10px] text-muted-foreground">Arrears</Label><p className="font-semibold tabular-nums">{formatUGX(schedule.arrears)}{schedule.periodsBehind > 0 ? ` · ${schedule.periodsBehind} ${unit}${schedule.periodsBehind === 1 ? '' : 's'}` : ''}</p></div>
                            <div><Label className="text-[10px] text-muted-foreground">Paid ahead</Label><p className="font-semibold tabular-nums">{formatUGX(schedule.aheadAmount)}{schedule.periodsAhead > 0 ? ` · ${schedule.periodsAhead} ${unit}${schedule.periodsAhead === 1 ? '' : 's'}` : ''}</p></div>
                            <div><Label className="text-[10px] text-muted-foreground">Outstanding plan</Label><p className="font-semibold tabular-nums">{formatUGX(schedule.outstandingPlan)}</p></div>
                          </div>
                          <Separator className="my-3" />
                          <TenantPaymentHistory
                            payments={paymentHistory?.get(request.id) ?? []}
                            loading={historyLoading}
                            planAgentId={selectedAgent.id}
                            nameFor={(id) => profileMap.get(id)?.full_name || 'another agent'}
                          />
                        </div>
                      );
                    })}

                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <UserDrilldownDrawer
        open={Boolean(selectedTenant)}
        onOpenChange={(open) => { if (!open) setSelectedTenant(null); }}
        tenantId={selectedTenant}
        agentId={selectedAgent?.id}
        defaultTab="tenant"
      />
    </>
  );

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as AgentMonitoringTab)} className="space-y-4">
      <div className="overflow-x-auto scrollbar-hide -mx-1 px-1">
        <TabsList variant="pills" className="w-max">
          <TabsTrigger value="all" variant="pills" className="text-xs">All agents</TabsTrigger>
          <TabsTrigger value="after-aug-2026" variant="pills" className="text-xs">After 1 Aug 2026</TabsTrigger>
          <TabsTrigger value="before-aug-2026" variant="pills" className="text-xs">Before 1 Aug 2026</TabsTrigger>
          <TabsTrigger value="position" variant="pills" className="text-xs">Expected vs paid</TabsTrigger>
          <TabsTrigger value="rent-analysis" variant="pills" className="text-xs">Rent Analysis</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="all" className="space-y-4">{body}</TabsContent>
      <TabsContent value="after-aug-2026" className="space-y-4">{body}</TabsContent>
      <TabsContent value="before-aug-2026" className="space-y-4">{body}</TabsContent>
      <TabsContent value="position" className="space-y-4"><AgentPaymentPosition /></TabsContent>
      <TabsContent value="rent-analysis" className="space-y-4"><RentAnalysis /></TabsContent>
    </Tabs>
  );
}

export default AgentMonitoring;
