/**
 * CFO — Tenant Balance Changes Approvals Page.
 *
 * Dedicated executive desk for deciding on tenant rent and balance changes
 * proposed by Tenant Operations.
 *
 * Tenant Operations can propose a new rent amount or outstanding balance, but
 * nothing moves on the tenant's plan until the designated CFO approver decides
 * here. The figures shown are read live, so the CFO always sees what the plan
 * owes now — not what it owed when the change was proposed.
 */
import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import {
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Coins,
  History,
  RefreshCw,
  Scale,
  ScrollText,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CFOTenantBalanceApprovals } from '@/components/cfo/CFOTenantBalanceApprovals';

interface PendingEdit {
  edit_id: string;
  rent_request_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  agent_name: string | null;
  editor_name: string | null;
  submitted_at: string;
  reason: string | null;
  current_rent_amount: number | null;
  current_outstanding: number | null;
  target_rent_amount: number | null;
  target_outstanding: number | null;
  can_decide: boolean;
}

export default function CfoTenantBalanceChangesPage() {
  const qc = useQueryClient();

  const { data: edits = [], isLoading, isRefetching, refetch } = useQuery({
    queryKey: ['cfo-tenant-balance-edits'],
    queryFn: async (): Promise<PendingEdit[]> => {
      const { data, error } = await supabase.rpc('tenant_balance_edits_pending' as any);
      if (error) throw error;
      return (data as PendingEdit[]) ?? [];
    },
    staleTime: 30_000,
  });

  const kpis = useMemo(() => {
    let balanceEditsCount = 0;
    let rentEditsCount = 0;
    let netBalanceDelta = 0;

    for (const r of edits) {
      const balMoves =
        r.target_outstanding != null &&
        Number(r.target_outstanding) !== Number(r.current_outstanding ?? 0);
      const rentMoves =
        r.target_rent_amount != null &&
        Number(r.target_rent_amount) !== Number(r.current_rent_amount ?? 0);

      if (balMoves) {
        balanceEditsCount += 1;
        netBalanceDelta +=
          Number(r.target_outstanding ?? 0) - Number(r.current_outstanding ?? 0);
      }
      if (rentMoves) {
        rentEditsCount += 1;
      }
    }

    return {
      totalPending: edits.length,
      balanceEditsCount,
      rentEditsCount,
      netBalanceDelta,
    };
  }, [edits]);

  return (
    <div className="space-y-6">
      {/* Executive Command Header */}
      <div className="flex flex-col gap-4 rounded-xl border border-border/80 bg-card p-5 shadow-xs sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <ScrollText className="h-5 w-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Tenant Balance Changes
            </h1>
            <Badge variant="outline" className="border-primary/30 bg-primary/5 text-primary text-xs font-semibold">
              <ShieldCheck className="h-3 w-3 mr-1 inline" /> CFO Authority
            </Badge>
            <Badge variant="secondary" className="text-xs font-medium">
              Tenant Operations Gate
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground sm:text-sm max-w-3xl">
            Review and sign off on rent amount adjustments and outstanding balance modifications proposed
            by Tenant Operations before changes take effect on tenant rent plans.
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-center">
          <Button
            size="sm"
            variant="outline"
            className="h-9 gap-1.5 text-xs font-medium"
            disabled={isLoading || isRefetching}
            onClick={() => refetch()}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* KPI Summary Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-border/80 bg-card p-3.5 shadow-xs">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-semibold uppercase tracking-wider">Awaiting Decision</span>
            <Clock className="h-4 w-4 text-amber-600" />
          </div>
          <p className="mt-1 text-base font-bold text-foreground sm:text-lg">
            {kpis.totalPending} {kpis.totalPending === 1 ? 'proposal' : 'proposals'}
          </p>
          <p className="text-[11px] text-muted-foreground">Tenant Ops submissions</p>
        </div>

        <div className="rounded-xl border border-border/80 bg-card p-3.5 shadow-xs">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-semibold uppercase tracking-wider">Balance Moves</span>
            <Scale className="h-4 w-4 text-primary" />
          </div>
          <p className="mt-1 text-base font-bold text-foreground sm:text-lg">{kpis.balanceEditsCount}</p>
          <p className="text-[11px] text-muted-foreground">Target outstanding edits</p>
        </div>

        <div className="rounded-xl border border-border/80 bg-card p-3.5 shadow-xs">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-semibold uppercase tracking-wider">Rent Adjustments</span>
            <Coins className="h-4 w-4 text-blue-600" />
          </div>
          <p className="mt-1 text-base font-bold text-foreground sm:text-lg">{kpis.rentEditsCount}</p>
          <p className="text-[11px] text-muted-foreground">Base rent modifications</p>
        </div>

        <div className="rounded-xl border border-border/80 bg-card p-3.5 shadow-xs">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-semibold uppercase tracking-wider">Net Balance Delta</span>
            {kpis.netBalanceDelta > 0 ? (
              <TrendingUp className="h-4 w-4 text-destructive" />
            ) : (
              <TrendingDown className="h-4 w-4 text-emerald-600" />
            )}
          </div>
          <p
            className={`mt-1 text-base font-bold sm:text-lg ${
              kpis.netBalanceDelta > 0
                ? 'text-destructive'
                : kpis.netBalanceDelta < 0
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-foreground'
            }`}
          >
            {kpis.netBalanceDelta !== 0
              ? `${kpis.netBalanceDelta > 0 ? '+' : ''}${formatUGX(kpis.netBalanceDelta)}`
              : 'UGX 0'}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {kpis.netBalanceDelta < 0 ? 'Total write-down requested' : 'Net portfolio change'}
          </p>
        </div>
      </div>

      {/* Main Approvals Interface */}
      <CFOTenantBalanceApprovals hideIfEmpty={false} />
    </div>
  );
}
