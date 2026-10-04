import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { CheckCircle2, Clock, XCircle, Wallet } from 'lucide-react';

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  earned: { label: 'Earned', color: 'bg-amber-500/10 text-amber-700 border-amber-500/30', icon: Clock },
  approved: { label: 'Approved', color: 'bg-blue-500/10 text-blue-700 border-blue-500/30', icon: CheckCircle2 },
  paid: { label: 'Paid', color: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30', icon: Wallet },
  rejected: { label: 'Rejected', color: 'bg-destructive/10 text-destructive border-destructive/30', icon: XCircle },
};

const ROLE_LABELS: Record<string, string> = {
  source_agent: 'Source',
  tenant_manager: 'Manager',
  recruiter_override: 'Recruiter',
  event_bonus: 'Bonus',
};

const EVENT_LABELS: Record<string, string> = {
  repayment: 'Repayment',
  rent_request_posted: 'Rent Request',
  rent_posted_listed: 'Listed Rent Posted',
  rent_landlord_verified: 'Landlord Verified',
  house_listed: 'House Listed',
  tenant_replacement: 'Replacement',
  subagent_registration: 'Sub-Agent Reg',
};

export function CommissionAccrualLedger() {
  const [statusFilter, setStatusFilter] = useState('all');

  const { data, isLoading } = useQuery({
    queryKey: ['commission-accrual-ledger', statusFilter],
    queryFn: async () => {
      let q = supabase.from('commission_accrual_ledger')
        .select('*, agent:agent_id(full_name), tenant:tenant_id(full_name)')
        .order('created_at', { ascending: false }).limit(200);
      if (statusFilter !== 'all') q = q.eq('status', statusFilter);
      const { data } = await q;
      return data || [];
    },
  });

  const totals = (data || []).reduce((acc, e) => {
    acc[e.status] = (acc[e.status] || 0) + e.amount;
    acc.total += e.amount;
    return acc;
  }, { earned: 0, approved: 0, paid: 0, rejected: 0, total: 0 } as Record<string, number>);

  return (
    <div className="space-y-3">
      {/* Pipeline Summary */}
      <div className="grid grid-cols-4 gap-1.5">
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
          const Icon = cfg.icon;
          return (
            <Card key={key} className={key === statusFilter ? 'ring-2 ring-primary' : ''}>
              <CardContent className="p-2 text-center cursor-pointer" onClick={() => setStatusFilter(key === statusFilter ? 'all' : key)}>
                <Icon className={`h-3.5 w-3.5 mx-auto mb-0.5 ${cfg.color.split(' ')[1]}`} />
                <p className="text-[9px] text-muted-foreground">{cfg.label}</p>
                <p className="text-sm font-black">{formatUGX(totals[key] || 0)}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-[10px] text-muted-foreground text-center">
        ✅ Commissions flow automatically as a platform expense — no approval required
      </p>

      {/* Entries */}
      <div className="space-y-2">
        {isLoading ? (
          <p className="text-xs text-muted-foreground text-center py-6">Loading...</p>
        ) : (data || []).length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">No commissions recorded</p>
        ) : (data || []).map(entry => {
          const cfg = STATUS_CONFIG[entry.status] || STATUS_CONFIG.paid;
          const Icon = cfg.icon;
          return (
            <Card key={entry.id}>
              <CardContent className="p-3">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-xs font-semibold">{(entry as any).agent?.full_name || 'Unknown'}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {EVENT_LABELS[(entry as any).event_type] || entry.source_type} · {ROLE_LABELS[(entry as any).commission_role] || ''} · {(entry as any).tenant?.full_name || '—'}
                    </p>
                    {(entry as any).percentage != null && (
                      <p className="text-[10px] font-medium text-primary mt-0.5">{(entry as any).percentage}% of {formatUGX((entry as any).repayment_amount || 0)}</p>
                    )}
                    {entry.description && <p className="text-[10px] text-muted-foreground mt-0.5">{entry.description}</p>}
                    <p className="text-[9px] text-muted-foreground mt-0.5">{format(new Date(entry.earned_at), 'MMM d, HH:mm')}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <p className="text-sm font-bold">{formatUGX(entry.amount)}</p>
                    <Badge variant="outline" className={`text-[9px] ${cfg.color}`}>
                      <Icon className="h-2.5 w-2.5 mr-0.5" /> {cfg.label}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
