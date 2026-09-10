import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { AlertTriangle, Navigation, Phone, Ban, CheckCircle2, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { differenceInDays } from 'date-fns';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { RentPaymentStatusSheet } from './RentPaymentStatusSheet';
import type { AgentPaymentStatus } from '@/hooks/useRentPaymentStatusMutation';
import {
  COLLECTIBLE_STATUSES,
  hasDisbursementEvidence,
  type AllocationSettlement,
} from '@/lib/collectibleRentRequests';

interface CollectionItem {
  rent_request_id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string;
  rent_amount: number;
  daily_repayment: number;
  amount_repaid: number;
  outstanding: number;
  days_overdue: number;
  priority_score: number;
  latitude?: number | null;
  longitude?: number | null;
  risk_level: 'low' | 'medium' | 'high' | 'critical' | 'completed';
  agent_payment_status: AgentPaymentStatus;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
}

export function PriorityCollectionQueue({ open, onOpenChange, agentId }: Props) {
  const [editTarget, setEditTarget] = useState<CollectionItem | null>(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 15;

  const { data: queue = [], isLoading } = useQuery({
    queryKey: ['priority-collection-queue', agentId],
    queryFn: async () => {
      const { data: requests } = await supabase
        .from('rent_requests')
        .select('id, tenant_id, rent_amount, daily_repayment, amount_repaid, total_repayment, disbursed_at, status, request_latitude, request_longitude, agent_payment_status')
        .eq('agent_id', agentId)
        // Only tenants Welile has actually funded can owe anything. Pre-funding
        // statuses already carry total_repayment, so a status blacklist showed
        // un-disbursed requests as owing.
        .in('status', COLLECTIBLE_STATUSES as unknown as string[]);

      if (!requests?.length) return [];

      // Landlord settlement evidence, same rule as v_agent_daily_eligibility.
      const { data: allocs } = await supabase
        .from('agent_landlord_float_allocations')
        .select('rent_request_id, status, paid_out_amount')
        .in('rent_request_id', requests.map(r => r.id));

      const settlementMap: Record<string, AllocationSettlement> = {};
      (allocs || []).forEach(a => {
        const key = (a as any).rent_request_id as string;
        if (!key) return;
        const cur = settlementMap[key] || { openAllocations: 0, paidOutAmount: 0 };
        if ((a as any).status === 'open') cur.openAllocations += 1;
        cur.paidOutAmount += Number((a as any).paid_out_amount) || 0;
        settlementMap[key] = cur;
      });

      const collectible = requests.filter(r =>
        hasDisbursementEvidence(Number(r.amount_repaid) || 0, settlementMap[r.id]),
      );
      if (!collectible.length) return [];

      const tenantIds = [...new Set(collectible.map(r => r.tenant_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', tenantIds);

      const profileMap: Record<string, { name: string; phone: string }> = {};
      (profiles || []).forEach(p => { profileMap[p.id] = { name: p.full_name, phone: p.phone || '' }; });

      const items: CollectionItem[] = collectible.map(r => {
        const outstanding = (r.total_repayment || 0) - (r.amount_repaid || 0);
        const daysOverdue = r.disbursed_at
          ? Math.max(0, differenceInDays(new Date(), new Date(r.disbursed_at)) - Math.floor((r.amount_repaid || 0) / (r.daily_repayment || 1)))
          : 0;
        const priorityScore = daysOverdue * outstanding;
        const actualOutstanding = Math.max(0, outstanding);
        const isCompleted = actualOutstanding === 0;
        const risk: CollectionItem['risk_level'] = isCompleted ? 'completed' : daysOverdue >= 10 ? 'critical' : daysOverdue >= 5 ? 'high' : daysOverdue >= 2 ? 'medium' : 'low';

        return {
          rent_request_id: r.id,
          tenant_id: r.tenant_id,
          tenant_name: profileMap[r.tenant_id]?.name || 'Unknown',
          tenant_phone: profileMap[r.tenant_id]?.phone || '',
          rent_amount: r.rent_amount,
          daily_repayment: r.daily_repayment,
          amount_repaid: r.amount_repaid || 0,
          outstanding: actualOutstanding,
          days_overdue: daysOverdue,
          priority_score: priorityScore,
          latitude: r.request_latitude,
          longitude: r.request_longitude,
          risk_level: risk,
          agent_payment_status: ((r as any).agent_payment_status ?? 'paying') as AgentPaymentStatus,
        };
      }).sort((a, b) => {
        if (a.risk_level === 'completed' && b.risk_level !== 'completed') return 1;
        if (a.risk_level !== 'completed' && b.risk_level === 'completed') return -1;
        return b.priority_score - a.priority_score;
      });

      return items;
    },
    enabled: open,
    staleTime: 60000,
  });

  useEffect(() => {
    if (open) setPage(1);
  }, [open]);

  useEffect(() => {
    setPage(1);
  }, [queue.length]);

  const totalPages = Math.max(1, Math.ceil(queue.length / PAGE_SIZE));
  const paginatedQueue = queue.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const riskColors = {
    low: 'border-success/30 bg-success/5',
    medium: 'border-warning/30 bg-warning/5',
    high: 'border-destructive/30 bg-destructive/5',
    critical: 'border-destructive/50 bg-destructive/10 ring-1 ring-destructive/20',
    completed: 'border-success/20 bg-success/5 opacity-75',
  };

  const riskLabels = {
    low: { text: 'On Track', color: 'text-success' },
    medium: { text: 'Slipping', color: 'text-warning' },
    high: { text: 'Overdue', color: 'text-destructive' },
    critical: { text: '🚨 Critical', color: 'text-destructive font-bold' },
    completed: { text: '✅ Paid Up', color: 'text-success' },
  };

  // Inactive ("Not Paying") tenants are excluded from the owed total — their
  // house has been freed back to Priority 1, so they no longer count.
  const totalOwed = queue.reduce(
    (s, i) => s + (i.agent_payment_status === 'not_paying' ? 0 : i.outstanding),
    0,
  );
  const notPayingCount = queue.filter(q => q.agent_payment_status === 'not_paying').length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[85vh] rounded-t-2xl p-0">
        <SheetHeader className="p-4 pb-2 border-b border-border/40">
          <SheetTitle className="text-left flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" />
            Priority Collections
          </SheetTitle>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {queue.length} tenants{notPayingCount > 0 ? ` · ${notPayingCount} not paying` : ''}
            </span>
            <span className="font-bold text-destructive">{formatUGX(totalOwed)} owed</span>
          </div>
          <p className="text-[11px] text-muted-foreground text-left">
            Tap a tenant's status pill to mark them as Not Paying. They will be excluded from your daily 20% target.
          </p>
        </SheetHeader>

        <div className="overflow-y-auto p-3 space-y-2" style={{ maxHeight: 'calc(85vh - 100px)' }}>
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">Loading...</div>
          ) : queue.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-success font-semibold">🎉 All tenants are up to date!</p>
            </div>
          ) : (
            paginatedQueue.map((item, idx) => (
              <div
                key={item.tenant_id + idx}
                className={cn(
                  "rounded-xl border p-3 space-y-2 transition-all",
                  riskColors[item.risk_level],
                  item.agent_payment_status === 'not_paying' && 'opacity-60'
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-bold text-muted-foreground w-5 shrink-0">#{(page - 1) * PAGE_SIZE + idx + 1}</span>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate">{item.tenant_name}</p>
                      <p className={cn("text-[10px] font-medium", riskLabels[item.risk_level].color)}>
                        {riskLabels[item.risk_level].text} • {item.days_overdue}d overdue
                      </p>
                    </div>
                  </div>
                  <p className="font-bold text-sm text-destructive shrink-0">{formatUGX(item.outstanding)}</p>
                </div>

                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>Daily: {formatUGX(item.daily_repayment)}</span>
                  <span>•</span>
                  <span>Paid: {formatUGX(item.amount_repaid)}</span>
                </div>

                <button
                  type="button"
                  onClick={() => setEditTarget(item)}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-semibold border transition-colors',
                    item.agent_payment_status === 'not_paying'
                      ? 'border-destructive/40 bg-destructive/10 text-destructive'
                      : 'border-success/40 bg-success/10 text-success'
                  )}
                  aria-label={`Toggle paying status for ${item.tenant_name}`}
                >
                  {item.agent_payment_status === 'not_paying'
                    ? (<><Ban className="h-3 w-3" /> Not Paying — tap to restore</>)
                    : (<><CheckCircle2 className="h-3 w-3" /> Paying — tap if not paying</>)}
                </button>

                <div className="flex items-center gap-1.5">
                  {item.tenant_phone && (
                    <a href={`tel:${item.tenant_phone}`} className="flex-1">
                      <Button size="sm" variant="outline" className="w-full h-8 text-xs gap-1">
                        <Phone className="h-3 w-3" /> Call
                      </Button>
                    </a>
                  )}
                  {item.latitude && item.longitude && (
                    <a
                      href={`https://www.google.com/maps/dir/?api=1&destination=${item.latitude},${item.longitude}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1"
                    >
                      <Button size="sm" variant="outline" className="w-full h-8 text-xs gap-1">
                        <Navigation className="h-3 w-3" /> Navigate
                      </Button>
                    </a>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {queue.length > PAGE_SIZE && (
          <div className="sticky bottom-0 bg-background/95 backdrop-blur border-t border-border/40 p-3 flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              className="h-9 gap-1"
            >
              <ChevronLeft className="h-4 w-4" /> Prev
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages} ({queue.length})
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              className="h-9 gap-1"
            >
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}

        <RentPaymentStatusSheet
          open={!!editTarget}
          onOpenChange={(v) => { if (!v) setEditTarget(null); }}
          rentRequestId={editTarget?.rent_request_id ?? null}
          tenantName={editTarget?.tenant_name}
          currentStatus={editTarget?.agent_payment_status ?? 'paying'}
          agentId={agentId}
        />
      </SheetContent>
    </Sheet>
  );
}
