import { useMemo, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ExecutiveDataTable, Column } from './ExecutiveDataTable';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

interface ActivityRow {
  type: string;
  partner_name: string;
  amount: number;
  status: string;
  date: string;
  reference: string;
  description: string;
}

const statusBadge = (status: string) => {
  const s = status.toLowerCase();
  const cls = s === 'approved' || s === 'completed'
    ? 'bg-success/15 text-success border-success/30'
    : s === 'pending' || s === 'processing'
      ? 'bg-warning/15 text-warning border-warning/30'
      : 'bg-destructive/15 text-destructive border-destructive/30';
  return <Badge variant="outline" className={cn('text-[10px] capitalize', cls)}>{status}</Badge>;
};

const typeBadge = (type: string) => {
  const colors: Record<string, string> = {
    'Payout': 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30',
    'Withdrawal': 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
    'Top-up': 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
    'Retraction': 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
    'Deposit': 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  };
  return <Badge variant="outline" className={cn('text-[10px]', colors[type] || '')}>{type}</Badge>;
};

const columns: Column<ActivityRow>[] = [
  { key: 'type', label: 'Type', render: (v) => typeBadge(String(v)) },
  { key: 'partner_name', label: 'Partner' },
  { key: 'amount', label: 'Amount', render: (v) => `UGX ${Number(v).toLocaleString()}` },
  { key: 'status', label: 'Status', render: (v) => statusBadge(String(v)) },
  { key: 'date', label: 'Date', render: (v) => v ? format(new Date(String(v)), 'dd MMM yyyy HH:mm') : '—' },
  { key: 'reference', label: 'Reference' },
  { key: 'description', label: 'Description' },
];

export function PartnerFinancialActivity() {
  const queryClient = useQueryClient();

  // ═══ REALTIME: auto-refresh when Financial Ops / CFO approve/reject ═══
  useEffect(() => {
    const channel = supabase
      .channel('partner-fin-activity-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pending_wallet_operations' }, () => {
        queryClient.invalidateQueries({ queryKey: ['partner-financial-ops'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wallet_deductions' }, () => {
        queryClient.invalidateQueries({ queryKey: ['partner-financial-deductions'] });
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [queryClient]);

  // Fetch pending_wallet_operations
  const { data: walletOps, isLoading: loadingOps } = useQuery({
    queryKey: ['partner-financial-ops'],
    queryFn: async () => {
      const { data } = await supabase
        .from('pending_wallet_operations')
        .select('id, operation_type, amount, status, created_at, target_wallet_user_id, metadata, category, source_id')
        .order('created_at', { ascending: false })
        .limit(500);
      return data || [];
    },
    staleTime: 30000,
  });

  // Fetch wallet_deductions
  const { data: deductions, isLoading: loadingDed } = useQuery({
    queryKey: ['partner-financial-deductions'],
    queryFn: async () => {
      const { data } = await supabase
        .from('wallet_deductions')
        .select('id, target_user_id, amount, category, reason, deducted_by, created_at')
        .order('created_at', { ascending: false })
        .limit(500);
      return data || [];
    },
    staleTime: 30000,
  });

  // Collect all user IDs from both sources + metadata initiated_by
  const allUserIds = useMemo(() => {
    const ids = new Set<string>();
    (walletOps || []).forEach(op => {
      if (op.target_wallet_user_id) ids.add(op.target_wallet_user_id);
      const meta = (op.metadata || {}) as Record<string, any>;
      if (meta.initiated_by) ids.add(meta.initiated_by);
    });
    (deductions || []).forEach(d => {
      if (d.target_user_id) ids.add(d.target_user_id);
      if (d.deducted_by) ids.add(d.deducted_by);
    });
    return Array.from(ids);
  }, [walletOps, deductions]);

  const { data: profileMap } = useQuery({
    queryKey: ['partner-fin-profiles', allUserIds.join(',')],
    queryFn: async () => {
      if (allUserIds.length === 0) return {};
      const { data } = await supabase.from('profiles').select('id, full_name').in('id', allUserIds);
      const map: Record<string, string> = {};
      (data || []).forEach(p => { map[p.id] = p.full_name; });
      return map;
    },
    enabled: allUserIds.length > 0,
    staleTime: 300000,
  });

  const names = profileMap || {};

  // Normalize into unified rows
  const rows: ActivityRow[] = useMemo(() => {
    const result: ActivityRow[] = [];

    (walletOps || []).forEach(op => {
      const opType = (op.operation_type || '').toLowerCase();
      const cat = (op.category || '').toLowerCase();
      let type = 'Deposit';
      if (opType.includes('roi') || opType.includes('payout')) type = 'Payout';
      else if (cat === 'withdrawal' || opType.includes('withdraw')) type = 'Withdrawal';
      else if (opType.includes('topup') || opType.includes('top_up') || cat.includes('topup')) type = 'Top-up';

      const meta = (op.metadata || {}) as Record<string, any>;

      // Resolve partner name: metadata first, then profile lookup, then initiated_by name
      const partnerName =
        meta.partner_name
        || (op.target_wallet_user_id && names[op.target_wallet_user_id])
        || (meta.initiated_by && names[meta.initiated_by])
        || (meta.portfolio_code ? `Portfolio ${meta.portfolio_code}` : null)
        || op.operation_type?.replace(/_/g, ' ')
        || '—';

      // Build description with portfolio ref for ROI payouts
      let description = meta.reason || meta.pay_mode || op.operation_type?.replace(/_/g, ' ') || '—';
      if (type === 'Payout' && (op as any).source_id) {
        const portfolioRef = meta.portfolio_code || (op as any).source_id?.slice(0, 8);
        if (portfolioRef) {
          description = `ROI payout · Portfolio: ${portfolioRef}`;
        }
      }

      result.push({
        type,
        partner_name: partnerName,
        amount: op.amount || 0,
        status: op.status || 'pending',
        date: op.created_at,
        reference: op.id?.slice(0, 8) || '—',
        description,
      });
    });

    (deductions || []).forEach(d => {
      result.push({
        type: 'Retraction',
        partner_name: names[d.target_user_id] || d.target_user_id?.slice(0, 8) || '—',
        amount: d.amount || 0,
        status: 'completed',
        date: d.created_at,
        reference: d.id?.slice(0, 8) || '—',
        description: d.reason || d.category?.replace(/_/g, ' ') || '—',
      });
    });

    result.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return result;
  }, [walletOps, deductions, names]);

  const filters = [
    {
      key: 'type',
      label: 'Type',
      options: [
        { value: 'Payout', label: 'Payouts' },
        { value: 'Withdrawal', label: 'Withdrawals' },
        { value: 'Top-up', label: 'Top-ups' },
        { value: 'Retraction', label: 'Retractions' },
        { value: 'Deposit', label: 'Deposits' },
      ],
    },
    {
      key: 'status',
      label: 'Status',
      options: [
        { value: 'pending', label: 'Pending' },
        { value: 'approved', label: 'Approved' },
        { value: 'completed', label: 'Completed' },
        { value: 'rejected', label: 'Rejected' },
      ],
    },
  ];

  return (
    <ExecutiveDataTable
      data={rows}
      columns={columns}
      filters={filters}
      title="Partner Financial Activity"
      loading={loadingOps || loadingDed}
      limit={100}
    />
  );
}
