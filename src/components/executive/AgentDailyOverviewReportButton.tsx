import { useState } from 'react';
import { FileBarChart, Loader2, ChevronDown } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  format,
  startOfDay,
  endOfDay,
  subDays,
  startOfMonth,
  endOfMonth,
  subMonths,
  differenceInCalendarDays,
  min as minDate,
} from 'date-fns';
import {
  generateAgentDailyOverviewPdf,
  type AgentDailyOverviewRow,
} from '@/lib/agentDailyOverviewPdf';
import { ACTIVE_RENT_STATUSES } from '@/hooks/useAgentCapacityMap';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type Preset = {
  id: string;
  label: string;
  /** Resolves the inclusive [start, end] range the report covers. */
  range: () => { start: Date; end: Date };
};

const PRESETS: Preset[] = [
  { id: 'today', label: 'Today', range: () => ({ start: new Date(), end: new Date() }) },
  {
    id: 'yesterday',
    label: 'Yesterday',
    range: () => ({ start: subDays(new Date(), 1), end: subDays(new Date(), 1) }),
  },
  {
    id: 'last7',
    label: 'Last 7 days',
    range: () => ({ start: subDays(new Date(), 6), end: new Date() }),
  },
  {
    id: 'last30',
    label: 'Last 30 days',
    range: () => ({ start: subDays(new Date(), 29), end: new Date() }),
  },
  {
    id: 'this-month',
    label: 'This month',
    range: () => ({ start: startOfMonth(new Date()), end: new Date() }),
  },
  {
    id: 'last-month',
    label: 'Last month',
    range: () => {
      const ref = subMonths(new Date(), 1);
      return { start: startOfMonth(ref), end: endOfMonth(ref) };
    },
  },
];

// Active-book definition MUST mirror the live Agent Ops capacity map
// (`ACTIVE_RENT_STATUSES`); the previous literal list used statuses that do
// not exist in `rent_requests`, which is why Tenants/Expected/Rate read 0.
const ACTIVE_STATUSES = ACTIVE_RENT_STATUSES;
const UNASSIGNED_AGENT_KEY = '__unassigned__';


/**
 * Paged select helper — Supabase caps single requests at 1000 rows. The
 * Agent Ops view spans every active rent plan and every collection logged
 * on the report date, both of which can exceed 1000 in production.
 */
async function fetchAll<T>(
  build: (from: number, to: number) => any,
): Promise<T[]> {
  const pageSize = 1000;
  const out: T[] = [];
  for (let page = 0; page < 100; page++) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await build(from, to);
    if (error) throw error;
    const rows = (data as T[]) || [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

export function AgentDailyOverviewReportButton() {
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (preset: Preset) => {
    if (busy !== null) return;
    setBusy(preset.id);
    try {
      const { start, end } = preset.range();
      const rangeStart = startOfDay(start);
      // Never look past "now" — future days have no collections and would dilute expectations.
      const rangeEnd = endOfDay(minDate([end, new Date()]));
      // Inclusive day count drives the expected (daily_repayment × days) figure.
      const dayCount = Math.max(1, differenceInCalendarDays(rangeEnd, rangeStart) + 1);
      const dayStart = rangeStart.toISOString();
      const dayEnd = rangeEnd.toISOString();

      // 1. All active rent plans (paged)
      const requests = await fetchAll<any>((from, to) =>
        supabase
          .from('rent_requests')
          .select('agent_id, tenant_id, rent_amount, daily_repayment, total_repayment, amount_repaid, status, registration_type, initial_outstanding_balance')
          .in('status', ACTIVE_STATUSES)
          .range(from, to),
      );

      // 2. Collections logged inside the selected range (paged)
      const collections = await fetchAll<any>((from, to) =>
        supabase
          .from('agent_collections')
          .select('agent_id, tenant_id, amount, created_at')
          .gte('created_at', dayStart)
          .lte('created_at', dayEnd)
          .range(from, to),
      );

      // 2b. Live eligibility snapshot — the same source the Agent Rent
      //     Capacity panel shows on screen. It is authoritative for the
      //     active-tenant count and the daily expected target, so the PDF
      //     always reconciles with the dashboard.
      const eligibility = await fetchAll<any>((from, to) =>
        supabase
          .from('v_agent_daily_eligibility')
          .select('agent_id, active_count, expected_daily')
          .range(from, to),
      );
      const eligMap = new Map<string, { active: number; expectedDaily: number }>();
      eligibility.forEach((e: any) => {
        if (!e.agent_id) return;
        eligMap.set(e.agent_id, {
          active: Number(e.active_count) || 0,
          expectedDaily: Number(e.expected_daily) || 0,
        });
      });


      // 3. Agent profile lookup
      const agentIds = Array.from(
        new Set([
          ...requests.map((r) => r.agent_id),
          ...collections.map((c) => c.agent_id),
          ...Array.from(eligMap.keys()),
        ].filter(Boolean)),
      );

      const profileMap = new Map<string, { full_name: string | null; phone: string | null }>();
      // Profiles fetched in chunks of 500 ids to stay within URL limits.
      const chunk = 500;
      for (let i = 0; i < agentIds.length; i += chunk) {
        const slice = agentIds.slice(i, i + chunk);
        const { data, error } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', slice);
        if (error) throw error;
        (data || []).forEach((p: any) => profileMap.set(p.id, p));
      }

      // 4. Aggregate per agent
      type Agg = AgentDailyOverviewRow & { tenantSet: Set<string>; paidSet: Set<string> };
      const map = new Map<string, Agg>();
      const ensure = (agentId: string): Agg => {
        let a = map.get(agentId);
        if (!a) {
          const isUnassigned = agentId === UNASSIGNED_AGENT_KEY;
          const p = isUnassigned ? null : profileMap.get(agentId);
          a = {
            agentName: isUnassigned ? 'Unassigned' : (p?.full_name || 'Unknown agent'),
            agentPhone: isUnassigned ? '' : (p?.phone || ''),
            activeTenants: 0,
            expectedToday: 0,
            collectedToday: 0,
            tenantsPaidToday: 0,
            paymentsToday: 0,
            principalPaid: 0,
            outstanding: 0,
            tenantSet: new Set<string>(),
            paidSet: new Set<string>(),
          };
          map.set(agentId, a);
        }
        return a;
      };

      requests.forEach((r: any) => {
        const a = ensure(r.agent_id || UNASSIGNED_AGENT_KEY);
        // Outstanding-balance plans are legacy carry-over debts, not new
        // disbursements: principal = expected = initial_outstanding_balance,
        // and the 1.33× formula does not apply. Normal plans use the
        // canonical trigger-computed total_repayment.
        const isOB = r.registration_type === 'outstanding_balance';
        const principal = isOB
          ? Number(r.initial_outstanding_balance || 0)
          : Number(r.rent_amount || 0);
        const expected = isOB
          ? Number(r.initial_outstanding_balance || 0)
          : Number(r.total_repayment || 0);
        a.expectedToday += Number(r.daily_repayment || 0) * dayCount;
        a.principalPaid += principal;
        a.outstanding += Math.max(0, expected - Number(r.amount_repaid || 0));
        if (r.tenant_id) a.tenantSet.add(r.tenant_id);
      });

      collections.forEach((c: any) => {
        const a = ensure(c.agent_id || UNASSIGNED_AGENT_KEY);
        a.collectedToday += Number(c.amount || 0);
        a.paymentsToday += 1;
        if (c.tenant_id) a.paidSet.add(c.tenant_id);
      });

      // Make sure every agent carrying a live book appears, even when their
      // plans sit in a status the aggregation above did not pick up.
      eligMap.forEach((e, agentId) => {
        if (e.active > 0 || e.expectedDaily > 0) ensure(agentId);
      });

      const rows: AgentDailyOverviewRow[] = Array.from(map.entries())
        .map(([agentId, a]) => {
          const elig = eligMap.get(agentId);
          // Live figures win; the ledger-derived fallbacks keep historical
          // ranges and the "Unassigned" bucket meaningful.
          const activeTenants = elig ? elig.active : a.tenantSet.size;
          const expectedToday = elig && elig.expectedDaily > 0
            ? elig.expectedDaily * dayCount
            : a.expectedToday;
          return {
            agentName: a.agentName,
            agentPhone: a.agentPhone,
            activeTenants,
            expectedToday,
            collectedToday: a.collectedToday,
            tenantsPaidToday: a.paidSet.size,
            paymentsToday: a.paymentsToday,
            principalPaid: a.principalPaid,
            outstanding: a.outstanding,
          };
        })

        // Show best performers first: highest collection rate, then highest expected
        .sort((x, y) => {
          const rx = x.expectedToday > 0 ? x.collectedToday / x.expectedToday : 1;
          const ry = y.expectedToday > 0 ? y.collectedToday / y.expectedToday : 1;
          if (rx !== ry) return ry - rx;
          return y.expectedToday - x.expectedToday;
        });

      const blob = generateAgentDailyOverviewPdf({
        reportDate: rangeStart,
        rangeEnd,
        periodLabel: preset.label,
        generatedAt: new Date(),
        rows,
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        dayCount > 1
          ? `agent-performance-${format(rangeStart, 'yyyy-MM-dd')}_to_${format(rangeEnd, 'yyyy-MM-dd')}.pdf`
          : `agent-daily-performance-${format(rangeStart, 'yyyy-MM-dd')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      toast.success(
        dayCount > 1
          ? `${preset.label} report (${format(rangeStart, 'dd MMM')} – ${format(rangeEnd, 'dd MMM yyyy')}) downloaded`
          : `Performance report for ${format(rangeStart, 'dd MMM yyyy')} downloaded`,
      );
    } catch (err: any) {
      console.error('[AgentDailyOverviewReportButton]', err);
      toast.error(err?.message || 'Failed to generate report');
    } finally {
      setBusy(null);
    }
  };

  const isBusy = busy !== null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={isBusy}
          className="h-9 px-3 rounded-full border border-border bg-card flex items-center gap-1.5 text-xs font-semibold text-foreground hover:border-primary/30 active:scale-95 transition-all touch-manipulation disabled:opacity-60 disabled:cursor-wait"
          aria-label="Download agent daily performance PDF"
        >
          {isBusy ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : (
            <FileBarChart className="h-4 w-4 text-primary" />
          )}
        <span className="hidden xs:inline">Performance PDF</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Agent performance period
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {PRESETS.map((p) => {
          const { start, end } = p.range();
          const sameDay = format(start, 'yyyy-MM-dd') === format(end, 'yyyy-MM-dd');
          return (
            <DropdownMenuItem
              key={p.id}
              disabled={isBusy}
              onClick={() => run(p)}
              className="gap-2 cursor-pointer"
            >
              {busy === p.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              ) : (
                <FileBarChart className="h-3.5 w-3.5 text-primary" />
              )}
              <span className="text-sm font-medium">{p.label}</span>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {sameDay
                  ? format(start, 'dd MMM')
                  : `${format(start, 'dd MMM')}–${format(end, 'dd MMM')}`}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}