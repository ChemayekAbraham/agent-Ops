import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Loader2, CheckCircle2, Banknote, Briefcase, TrendingUp,
  Users, Wallet, Percent, Calendar,
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { TreasuryImpactBanner } from './TreasuryImpactBanner';
import { CfoApprovalGate } from '@/components/cfo/CfoApprovalGate';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-UG', {
    style: 'currency',
    currency: 'UGX',
    maximumFractionDigits: 0,
  }).format(n);

// Business advance economics (matches repay-business-advance edge function)
const DAILY_RATE = 0.01;          // 1% daily compounding interest accrued on outstanding
const AGENT_COMMISSION = 0.04;    // 4% paid to originating agent on each repayment
const PROJECTION_DAYS = 30;       // default projection horizon for revenue display

// Compound: outstanding * (1 + r)^days  →  interest = outstanding * ((1+r)^days - 1)
function projectInterest(principal: number, days: number) {
  return Math.round(principal * (Math.pow(1 + DAILY_RATE, days) - 1));
}

interface ApprovedAdvance {
  id: string;
  principal: number;
  business_name: string;
  tenant_id: string;
  agent_id: string | null;
  created_at: string;
  coo_approved_at: string | null;
  tenant_name: string;
  agent_name: string;
}

export function BusinessAdvanceDisbursementQueue() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchRef, setBatchRef] = useState('');
  const qc = useQueryClient();

  const { data: items = [], isLoading } = useQuery<ApprovedAdvance[]>({
    queryKey: ['business-advance-disbursement-queue'],
    queryFn: async () => {
      const { data: advances, error } = await supabase
        .from('business_advances')
        .select('id, principal, business_name, tenant_id, agent_id, created_at, coo_approved_at')
        .eq('status', 'coo_approved')
        .order('coo_approved_at', { ascending: true, nullsFirst: false });

      if (error) throw error;
      if (!advances?.length) return [];

      const userIds = [
        ...new Set(advances.flatMap(a => [a.tenant_id, a.agent_id].filter(Boolean) as string[])),
      ];
      const profileMap = new Map<string, string>();
      if (userIds.length) {
        const { data: profiles } = await supabase
          .from('profiles').select('id, full_name').in('id', userIds);
        for (const p of profiles || []) profileMap.set(p.id, p.full_name || 'Unknown');
      }

      return advances.map(a => ({
        ...a,
        principal: Number(a.principal) || 0,
        tenant_name: profileMap.get(a.tenant_id) || 'Unknown Tenant',
        agent_name: a.agent_id ? (profileMap.get(a.agent_id) || 'Unknown Agent') : 'No Agent',
      }));
    },
    staleTime: 15_000,
  });

  const selectedItems = useMemo(() => items.filter(i => selected.has(i.id)), [items, selected]);
  const allSelected = items.length > 0 && selected.size === items.length;

  // Aggregate economics across the whole queue (helps the CFO see portfolio-level revenue)
  const queueTotals = useMemo(() => {
    const principal = items.reduce((s, i) => s + i.principal, 0);
    const interest30 = items.reduce((s, i) => s + projectInterest(i.principal, PROJECTION_DAYS), 0);
    const commission = Math.round(principal * AGENT_COMMISSION);
    return { principal, interest30, commission, net: interest30 - commission };
  }, [items]);

  const selectedTotals = useMemo(() => {
    const principal = selectedItems.reduce((s, i) => s + i.principal, 0);
    const interest30 = selectedItems.reduce((s, i) => s + projectInterest(i.principal, PROJECTION_DAYS), 0);
    const commission = Math.round(principal * AGENT_COMMISSION);
    return { principal, interest30, commission, net: interest30 - commission };
  }, [selectedItems]);

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(items.map(i => i.id)));
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const singleDisburse = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.functions.invoke('disburse-business-advance', {
        body: { advance_id: id, notes: 'Single CFO disbursement' },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast.success('Business advance disbursed');
      qc.invalidateQueries({ queryKey: ['business-advance-disbursement-queue'] });
      qc.invalidateQueries({ queryKey: ['treasury-cash-snapshot'] });
      qc.invalidateQueries({ queryKey: ['cfo-overview'] });
    },
    onError: (e: any) => toast.error(e.message || 'Disbursement failed'),
  });

  const batchDisburse = useMutation({
    mutationFn: async () => {
      if (!batchRef.trim()) throw new Error('Enter a batch reference');
      const errors: string[] = [];
      for (const id of selected) {
        const { error, data } = await supabase.functions.invoke('disburse-business-advance', {
          body: { advance_id: id, notes: `Batch: ${batchRef}` },
        });
        if (error) errors.push(`${id.slice(0, 8)}: ${error.message}`);
        else if (data?.error) errors.push(`${id.slice(0, 8)}: ${data.error}`);
      }
      if (errors.length) throw new Error(`${errors.length} failed: ${errors[0]}`);
    },
    onSuccess: () => {
      toast.success(`${selected.size} business advances disbursed`);
      setSelected(new Set());
      setBatchRef('');
      qc.invalidateQueries({ queryKey: ['business-advance-disbursement-queue'] });
      qc.invalidateQueries({ queryKey: ['treasury-cash-snapshot'] });
      qc.invalidateQueries({ queryKey: ['cfo-overview'] });
    },
    onError: (e: any) => toast.error(e.message || 'Batch disbursement failed'),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Briefcase className="h-4 w-4 text-primary" />
          Business Advance Disbursement Queue
          {items.length > 0 && (
            <Badge variant="outline" className="text-[10px] ml-1 bg-primary/10 text-primary border-primary/30">
              {items.length} approved · {fmt(queueTotals.principal)}
            </Badge>
          )}
        </CardTitle>
        {items.length > 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            COO-approved business advances ready for CFO disbursement to tenant wallets.
            Projected 30-day gross interest:{' '}
            <span className="font-bold text-emerald-600">{fmt(queueTotals.interest30)}</span>
          </p>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-emerald-500" />
            <p className="font-medium">No Pending Business Advances</p>
            <p className="text-xs">All COO-approved business advances have been disbursed</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Portfolio-level revenue projection (always visible) */}
            <div className="rounded-lg border-2 border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 p-3 space-y-2">
              <p className="text-xs font-bold flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                <TrendingUp className="h-3.5 w-3.5" />
                How we make money on this queue
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                <div>
                  <p className="text-[10px] text-muted-foreground flex items-center justify-center gap-1">
                    <Wallet className="h-2.5 w-2.5" /> Principal Out
                  </p>
                  <p className="font-bold text-sm text-orange-600">{fmt(queueTotals.principal)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground flex items-center justify-center gap-1">
                    <Percent className="h-2.5 w-2.5" /> Gross Interest (30d)
                  </p>
                  <p className="font-bold text-sm text-emerald-600">{fmt(queueTotals.interest30)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground flex items-center justify-center gap-1">
                    <Users className="h-2.5 w-2.5" /> Agent Commission (4%)
                  </p>
                  <p className="font-bold text-sm text-amber-600">−{fmt(queueTotals.commission)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground flex items-center justify-center gap-1">
                    <TrendingUp className="h-2.5 w-2.5" /> Net Profit (30d)
                  </p>
                  <p className="font-bold text-sm text-primary">{fmt(queueTotals.net)}</p>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground italic">
                Revenue model: 1% daily compounding interest on outstanding balance · 4% of every repayment goes to the originating agent.
              </p>
            </div>

            {/* Select all */}
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                Select all ({items.length})
              </label>
              {selected.size > 0 && (
                <Badge className="bg-primary/10 text-primary border-primary/30">
                  {selected.size} selected · {fmt(selectedTotals.principal)}
                </Badge>
              )}
            </div>

            {/* Selection economics */}
            {selected.size > 0 && (
              <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
                <p className="text-xs font-bold flex items-center gap-1.5">
                  <Briefcase className="h-3.5 w-3.5 text-primary" />
                  Selected disbursement projection
                </p>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-[10px] text-muted-foreground">Pay Out Now</p>
                    <p className="font-bold text-sm text-orange-600">{fmt(selectedTotals.principal)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground">We Earn (30d gross)</p>
                    <p className="font-bold text-sm text-emerald-600">{fmt(selectedTotals.interest30)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground">Net Platform Profit</p>
                    <p className="font-bold text-sm text-primary">{fmt(selectedTotals.net)}</p>
                  </div>
                </div>
                <TreasuryImpactBanner payoutAmount={selectedTotals.principal} />
              </div>
            )}

            {/* List */}
            <div className="space-y-1.5 max-h-[350px] overflow-y-auto">
              {items.map(item => {
                const interest30 = projectInterest(item.principal, PROJECTION_DAYS);
                const commission = Math.round(item.principal * AGENT_COMMISSION);
                return (
                  <div
                    key={item.id}
                    className={cn(
                      'flex items-start gap-3 p-2.5 rounded-lg border text-sm transition-colors',
                      selected.has(item.id) && 'bg-primary/5 border-primary/20'
                    )}
                  >
                    <Checkbox
                      checked={selected.has(item.id)}
                      onCheckedChange={() => toggle(item.id)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">{item.tenant_name}</p>
                        <span className="text-[10px] text-muted-foreground">·</span>
                        <p className="font-medium truncate text-primary">{item.business_name}</p>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                          <Users className="h-2.5 w-2.5 mr-0.5" />
                          {item.agent_name}
                        </Badge>
                        <Badge className="text-[9px] px-1.5 py-0 bg-emerald-100 text-emerald-700 border-emerald-200">
                          <Wallet className="h-2.5 w-2.5 mr-0.5" />
                          Tenant Wallet
                        </Badge>
                        <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                          <Calendar className="h-2.5 w-2.5" />
                          {format(new Date(item.coo_approved_at || item.created_at), 'dd MMM')}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-[10px] flex-wrap">
                        <span>Principal: <b className="text-orange-600">{fmt(item.principal)}</b></span>
                        <span>30d gross: <b className="text-emerald-600">+{fmt(interest30)}</b></span>
                        <span>Agent 4%: <b className="text-amber-600">−{fmt(commission)}</b></span>
                        <span className="font-medium">Net: <b className="text-primary">{fmt(interest30 - commission)}</b></span>
                      </div>
                    </div>
                    <CfoApprovalGate>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 text-xs h-7"
                        onClick={() => singleDisburse.mutate(item.id)}
                        disabled={singleDisburse.isPending}
                      >
                        {singleDisburse.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Banknote className="h-3 w-3 mr-1" />}
                        Pay
                      </Button>
                    </CfoApprovalGate>
                  </div>
                );
              })}
            </div>

            {/* Batch actions */}
            {selected.size > 0 && (
              <CfoApprovalGate>
              <div className="flex items-center gap-2 pt-2 border-t">
                <Input
                  placeholder="Batch ref (e.g. BizAdv-2024-01)"
                  value={batchRef}
                  onChange={e => setBatchRef(e.target.value)}
                  className="h-8 text-sm flex-1"
                />
                <Button
                  size="sm"
                  onClick={() => batchDisburse.mutate()}
                  disabled={batchDisburse.isPending || !batchRef.trim()}
                >
                  {batchDisburse.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Banknote className="h-3 w-3 mr-1" />}
                  Disburse ({selected.size})
                </Button>
              </div>
              </CfoApprovalGate>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
