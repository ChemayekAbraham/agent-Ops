import { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerFooter,
  DrawerClose,
} from '@/components/ui/drawer';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Loader2,
  ChevronLeft,
  ChevronRight,
  Send,
  CheckCircle2,
  XCircle,
  User,
  Building,
  Calendar,
  MessageSquare,
  Banknote,
  Pencil,
  RefreshCw,
  Phone,
  MapPin,
  ChevronRight as ChevronRightIcon,
  Hash,
  Clock,
  Search,
  Filter,
  X,
  FileSpreadsheet,
  AlertCircle,
  Eye,
  FileCheck,
  Landmark,
  Wallet,
  HandCoins,
  ArrowUpDown,
  Trash2,
  ClipboardCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { format, isToday, isThisWeek, isThisMonth } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { useAgentRejectedRequests } from '@/hooks/useAgentRejectedRequests';
import { AgentEditRentRequestDialog } from './AgentEditRentRequestDialog';
import type { AgentRejectedRequest } from '@/hooks/useAgentRejectedRequests';

export type PipelineTab = 'submitted' | 'approved' | 'rejected' | 'landlords';

const PAGE_SIZE = 10;

export const SUBMITTED_STATUSES = [
  'pending',
  'service_center_review',
  'tenant_ops_approved',
  'agent_verified',
  'agent_ops_approved',
  'landlord_ops_approved',
  'partner_ops_approved',
  'coo_approved',
];

export const APPROVED_STATUSES = ['funded', 'disbursed'];

const STAGE_LABEL: Record<string, string> = {
  service_center_review: 'Service Center review',
  pending: 'Agent Ops review',
  agent_ops_approved: 'Tenant Ops review',
  agent_verified: 'Tenant Ops review',
  tenant_ops_approved: 'Landlord Ops review',
  landlord_ops_approved: 'Partner Ops review',
  partner_ops_approved: 'COO review',
  coo_approved: 'CFO funding',
  funded: 'Funded — awaiting disbursal',
  disbursed: 'Disbursed — ready to collect',
};


const STAGE_NEXT: Record<string, string> = {
  service_center_review: 'Next: Agent Ops review',
  pending: 'Next: Tenant Ops review',
  agent_verified: 'Next: Landlord Ops review',
  agent_ops_approved: 'Next: Landlord Ops review',
  tenant_ops_approved: 'Next: Partner Ops review',
  landlord_ops_approved: 'Next: Partner Ops review',
  partner_ops_approved: 'Next: COO review',
  coo_approved: 'Next: Funds sent to landlord',
  funded: 'Next: Tenant starts repayments',
  disbursed: 'Next: Collect rent from tenant',
  rejected: 'Next: Edit & resubmit',
};

const EVENT_LABEL: Record<string, string> = {
  rent_request_created: 'Submitted for review',
  'rent_request.returned_for_correction': 'Returned for correction',
  'rent_request.resubmitted_by_agent': 'Resubmitted by agent',
  rent_request_force_approved: 'Force approved',
  rent_request_funded: 'Funded',
  rent_request_disbursed: 'Disbursed',
};

const STAGE_ICON: Record<string, typeof Eye> = {
  service_center_review: ClipboardCheck,
  pending: Eye,
  agent_ops_approved: FileCheck,
  agent_verified: FileCheck,
  tenant_ops_approved: User,
  landlord_ops_approved: Landmark,
  partner_ops_approved: Landmark,
  coo_approved: FileCheck,
  funded: Wallet,
  disbursed: HandCoins,
  rejected: XCircle,
};

const STAGE_STRIP: Record<string, { bg: string; text: string; iconBg: string }> = {
  service_center_review: { bg: 'bg-orange-500', text: 'text-white', iconBg: 'bg-white/20' },
  pending: { bg: 'bg-amber-500', text: 'text-white', iconBg: 'bg-white/20' },
  agent_ops_approved: { bg: 'bg-sky-500', text: 'text-white', iconBg: 'bg-white/20' },
  agent_verified: { bg: 'bg-sky-500', text: 'text-white', iconBg: 'bg-white/20' },
  tenant_ops_approved: { bg: 'bg-indigo-500', text: 'text-white', iconBg: 'bg-white/20' },
  landlord_ops_approved: { bg: 'bg-violet-500', text: 'text-white', iconBg: 'bg-white/20' },
  partner_ops_approved: { bg: 'bg-purple-500', text: 'text-white', iconBg: 'bg-white/20' },
  coo_approved: { bg: 'bg-teal-500', text: 'text-white', iconBg: 'bg-white/20' },
  funded: { bg: 'bg-emerald-500', text: 'text-white', iconBg: 'bg-white/20' },
  disbursed: { bg: 'bg-emerald-600', text: 'text-white', iconBg: 'bg-white/20' },
  rejected: { bg: 'bg-destructive', text: 'text-destructive-foreground', iconBg: 'bg-white/20' },
};


interface PipelineRow {
  id: string;
  rent_amount: number;
  total_repayment: number;
  duration_days: number;
  amount_repaid: number;
  status: string;
  created_at: string;
  disbursed_at: string | null;
  tenant_id: string;
  landlord_id: string;
  resubmitted_at: string | null;
  resubmission_count: number | null;
  tenant_name?: string;
  tenant_phone?: string;
  landlord_name?: string;
  /** True once a payout against this tenant's landlord float allocation has
   *  been recorded — the tenant has moved from "Ready to pay" to collections. */
  landlord_settled?: boolean;
  landlord_address?: string;
}

function usePipelineRequests(
  statuses: string[],
  page: number,
  enabled: boolean,
  cacheKey: string,
  sortOrder: 'newest' | 'oldest' = 'newest',
  selectedStatus: string = 'all',
) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['agent-pipeline', cacheKey, user?.id, page, sortOrder, selectedStatus],
    enabled: enabled && !!user,
    queryFn: async (): Promise<{ rows: PipelineRow[]; total: number }> => {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const effectiveStatuses =
        selectedStatus !== 'all' && statuses.includes(selectedStatus)
          ? [selectedStatus]
          : statuses;

      let query = supabase
        .from('rent_requests')
        .select(
          'id, rent_amount, total_repayment, duration_days, amount_repaid, status, created_at, disbursed_at, tenant_id, landlord_id, resubmitted_at, resubmission_count',
          { count: 'exact' },
        )
        .eq('agent_id', user!.id)
        .in('status', effectiveStatuses);

      if (sortOrder === 'oldest') {
        query = query.order('created_at', { ascending: true });
      } else {
        query = query
          .order('resubmitted_at', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false });
      }

      const { data, error, count } = await query.range(from, to);
      if (error) throw error;
      const rows = (data ?? []) as PipelineRow[];
      if (rows.length === 0) return { rows: [], total: count ?? 0 };

      const tenantIds = [...new Set(rows.map((r) => r.tenant_id).filter(Boolean))];
      const landlordIds = [...new Set(rows.map((r) => r.landlord_id).filter(Boolean))];
      const [{ data: profiles }, { data: landlords }, { data: allocations }] = await Promise.all([
        tenantIds.length
          ? supabase.from('profiles').select('id, full_name, phone').in('id', tenantIds)
          : Promise.resolve({ data: [] as any[] }),
        landlordIds.length
          ? supabase.from('landlords').select('id, name, property_address').in('id', landlordIds)
          : Promise.resolve({ data: [] as any[] }),
        // Landlord float payout progress per request. A recorded payout means
        // the landlord money has physically gone out, so the tenant belongs to
        // the owing / collections list — not "Ready to pay" — and must not
        // appear in both places at once.
        supabase
          .from('agent_landlord_float_allocations')
          .select('rent_request_id, paid_out_amount')
          .in('rent_request_id', rows.map((r) => r.id)),
      ]);
      const pmap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      const lmap = new Map((landlords ?? []).map((l: any) => [l.id, l]));
      const settled = new Set(
        (allocations ?? [])
          .filter((a: any) => Number(a.paid_out_amount || 0) > 0)
          .map((a: any) => a.rent_request_id),
      );
      return {
        rows: rows.map((r) => ({
          ...r,
          tenant_name: pmap.get(r.tenant_id)?.full_name ?? 'Unknown tenant',
          tenant_phone: pmap.get(r.tenant_id)?.phone ?? '',
          landlord_name: lmap.get(r.landlord_id)?.name ?? '',
          landlord_address: lmap.get(r.landlord_id)?.property_address ?? '',
          landlord_settled: settled.has(r.id),
        })),
        total: count ?? rows.length,
      };
    },
  });
}

interface LandlordRow {
  id: string;
  name: string;
  phone: string | null;
  property_address: string | null;
  verified: boolean | null;
  created_at: string;
}

/**
 * Standalone landlords an agent has registered. These do NOT create a
 * rent_request, so they never appear in the rent-request pipeline above —
 * which is exactly why agents (and operators) couldn't see freshly
 * registered landlords. This surfaces them in a dedicated tab.
 */
function useRegisteredLandlords(enabled: boolean) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['agent-registered-landlords', user?.id],
    enabled: enabled && !!user,
    queryFn: async (): Promise<LandlordRow[]> => {
      const { data, error } = await supabase
        .from('landlords')
        .select('id, name, phone, property_address, verified, created_at')
        .eq('registered_by', user!.id)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as LandlordRow[];
    },
  });
}

function Pager({
  page,
  total,
  onPage,
  loading,
}: {
  page: number;
  total: number;
  onPage: (p: number) => void;
  loading: boolean;
}) {
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  if (total <= PAGE_SIZE) return null;
  return (
    <div className="flex items-center justify-between gap-2 pt-2">
      <Button
        variant="outline"
        size="sm"
        disabled={page === 0 || loading}
        onClick={() => onPage(Math.max(0, page - 1))}
        className="gap-1"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Prev
      </Button>
      <p className="text-xs text-muted-foreground">
        Page {page + 1} of {lastPage + 1} · {total} total
      </p>
      <Button
        variant="outline"
        size="sm"
        disabled={page >= lastPage || loading}
        onClick={() => onPage(Math.min(lastPage, page + 1))}
        className="gap-1"
      >
        Next
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function StatusStrip({ status, label }: { status: string; label: string }) {
  const strip = STAGE_STRIP[status] ?? { bg: 'bg-muted', text: 'text-muted-foreground', iconBg: 'bg-foreground/10' };
  const Icon = STAGE_ICON[status] ?? Eye;
  const next = STAGE_NEXT[status];
  return (
    <div className={`${strip.bg} ${strip.text}`}>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <div className={`flex items-center justify-center h-6 w-6 rounded-full ${strip.iconBg}`}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <span className="text-xs font-bold tracking-wide">{label}</span>
      </div>
      {next && (
        <div className="px-3 pb-1.5 pt-0">
          <span className="text-[10px] font-medium opacity-90">{next}</span>
        </div>
      )}
    </div>
  );
}

function RowCard({
  row,
  tone,
  stageLabel,
  rightSlot,
  onClick,
  highlighted,
}: {
  row: PipelineRow;
  tone: 'amber' | 'emerald' | 'destructive';
  stageLabel: string;
  rightSlot?: React.ReactNode;
  onClick?: () => void;
  highlighted?: boolean;
}) {
  const toneClass =
    tone === 'amber'
      ? 'border-amber-500/40 bg-amber-500/5'
      : tone === 'emerald'
        ? 'border-emerald-500/40 bg-emerald-500/5'
        : 'border-destructive/40 bg-destructive/5';
  return (
    <Card
      data-row-id={row.id}
      className={`border-2 overflow-hidden ${toneClass} ${
        onClick ? 'cursor-pointer transition-shadow hover:shadow-md active:scale-[0.99]' : ''
      } ${highlighted ? 'ring-2 ring-primary ring-offset-2 ring-offset-background animate-pulse' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      style={onClick ? { touchAction: 'manipulation' } : undefined}
    >
      <StatusStrip status={row.status} label={stageLabel} />
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-0.5">
              <User className="h-4 w-4 text-primary shrink-0" />
              <span className="font-semibold truncate text-sm">{row.tenant_name}</span>
              {(row.resubmission_count ?? 0) > 0 && (
                <Badge
                  variant="outline"
                  className="text-[10px] border-amber-500/60 bg-amber-500/10 text-amber-700 gap-1"
                  title={
                    row.resubmitted_at
                      ? `Resubmitted ${format(new Date(row.resubmitted_at), 'MMM d, h:mm a')}`
                      : 'Resubmitted'
                  }
                >
                  <RefreshCw className="h-3 w-3" />
                  Resubmitted{(row.resubmission_count ?? 0) > 1 ? ` ×${row.resubmission_count}` : ''}
                </Badge>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground space-y-0.5">
              {row.landlord_name && (
                <div className="flex items-center gap-1.5">
                  <Building className="h-3 w-3" />
                  <span className="truncate">
                    {row.landlord_name}
                    {row.landlord_address ? ` · ${row.landlord_address}` : ''}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <Calendar className="h-3 w-3" />
                <span>Submitted {format(new Date(row.created_at), 'MMM d, yyyy')}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <div className="text-right">
              <p className="text-sm font-bold tabular-nums">{formatUGX(row.rent_amount)}</p>
              <p className="text-[10px] text-muted-foreground">{row.duration_days} days</p>
            </div>
            {onClick && <ChevronRightIcon className="h-4 w-4 text-muted-foreground/60" />}
          </div>
        </div>
        {rightSlot}
        {onClick && (
          <div className="flex items-center justify-center gap-1.5 mt-1 py-1.5 rounded-lg bg-foreground/5 text-xs font-semibold text-foreground/70">
            Tap to view details
            <ChevronRightIcon className="h-3.5 w-3.5" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function AgentRequestPipelineView({
  initialTab,
  highlightId,
  activeTab,
  onTabChange,
}: {
  initialTab?: PipelineTab;
  highlightId?: string | null;
  activeTab?: PipelineTab;
  onTabChange?: (tab: PipelineTab) => void;
} = {}) {
  const queryClient = useQueryClient();
  const [internalTab, setInternalTab] = useState<PipelineTab>(initialTab ?? 'submitted');
  const tab = activeTab ?? internalTab;
  const setTab = (t: PipelineTab) => {
    if (onTabChange) onTabChange(t);
    setInternalTab(t);
  };
  const [submittedPage, setSubmittedPage] = useState(0);
  const [approvedPage, setApprovedPage] = useState(0);
  const [rejectedPage, setRejectedPage] = useState(0);
  const [editing, setEditing] = useState<AgentRejectedRequest | null>(null);
  const [detailRow, setDetailRow] = useState<PipelineRow | null>(null);

  // When opening straight to a freshly submitted record, scroll it into view
  // and flash a highlight ring so the agent sees exactly what they just added.
  const [activeHighlight, setActiveHighlight] = useState<string | null>(highlightId ?? null);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setActiveHighlight(highlightId ?? null);
  }, [highlightId]);

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [landlordStatusFilter, setLandlordStatusFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<string>('all');
  const [tenantSort, setTenantSort] = useState<'newest' | 'oldest'>('newest');
  const [showFilters, setShowFilters] = useState(false);

  const submitted = usePipelineRequests(
    SUBMITTED_STATUSES,
    submittedPage,
    tab === 'submitted',
    'submitted',
    tenantSort,
    statusFilter,
  );
  const approved = usePipelineRequests(
    APPROVED_STATUSES,
    approvedPage,
    tab === 'approved',
    'approved',
    'newest',
    statusFilter,
  );
  const rejectedQuery = useAgentRejectedRequests();
  const rejectedAll = rejectedQuery.data ?? [];
  const landlordsQuery = useRegisteredLandlords(tab === 'landlords');

  // Client-side filtering helpers
  const filterBySearch = (row: PipelineRow | AgentRejectedRequest) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const tenant = (row as any).tenant_name ?? '';
    const tenantPhone = (row as any).tenant_phone ?? '';
    const landlord = (row as any).landlord_name ?? '';
    return (
      tenant.toLowerCase().includes(q) ||
      tenantPhone.toLowerCase().includes(q) ||
      landlord.toLowerCase().includes(q)
    );
  };

  const filterByStatus = (row: PipelineRow) => {
    if (statusFilter === 'all') return true;
    return row.status === statusFilter;
  };

  const filterByDate = (row: PipelineRow) => {
    if (dateFilter === 'all') return true;
    const d = new Date(row.created_at);
    if (dateFilter === 'today') return isToday(d);
    if (dateFilter === 'week') return isThisWeek(d);
    if (dateFilter === 'month') return isThisMonth(d);
    return true;
  };

  const activeFiltersCount =
    (searchQuery.trim() ? 1 : 0) +
    (statusFilter !== 'all' ? 1 : 0) +
    (landlordStatusFilter !== 'all' ? 1 : 0) +
    (dateFilter !== 'all' ? 1 : 0);

  const submittedRows = useMemo(
    () =>
      (submitted.data?.rows ?? [])
        .filter(filterBySearch)
        .filter(filterByStatus)
        .filter(filterByDate),
    [submitted.data?.rows, searchQuery, statusFilter, dateFilter],
  );

  const approvedRows = useMemo(
    () =>
      (approved.data?.rows ?? [])
        .filter(filterBySearch)
        .filter(filterByStatus)
        .filter(filterByDate)
        // "Ready to pay" = landlord money released to the agent's float but not
        // yet paid out, and no tenant repayment recorded yet. Once the landlord
        // payout is recorded (or the tenant starts repaying) the request lives
        // in the owing / collections list instead, so it drops off this tab.
        .filter((r) => !r.landlord_settled && Number(r.amount_repaid || 0) <= 0),
    [approved.data?.rows, searchQuery, statusFilter, dateFilter],
  );

  const filteredRejected = useMemo(
    () => rejectedAll.filter(filterBySearch),
    [rejectedAll, searchQuery],
  );
  const rejectedPaged = useMemo(
    () => filteredRejected.slice(rejectedPage * PAGE_SIZE, rejectedPage * PAGE_SIZE + PAGE_SIZE),
    [filteredRejected, rejectedPage],
  );

  const landlordRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return (landlordsQuery.data ?? []).filter((l) => {
      if (q) {
        const matchesSearch =
          (l.name ?? '').toLowerCase().includes(q) ||
          (l.phone ?? '').toLowerCase().includes(q) ||
          (l.property_address ?? '').toLowerCase().includes(q);
        if (!matchesSearch) return false;
      }
      if (landlordStatusFilter === 'pending') return !l.verified;
      if (landlordStatusFilter === 'verified') return l.verified === true;
      return true;
    });
  }, [landlordsQuery.data, searchQuery]);

  const rowsToExport =
    tab === 'submitted'
      ? submittedRows
      : tab === 'approved'
        ? approvedRows
        : tab === 'rejected'
          ? filteredRejected
          : [];

  // Once the targeted record renders, scroll to it and clear the ring after a
  // few seconds so the highlight is a one-time visual cue.
  useEffect(() => {
    if (!activeHighlight) return;
    const t = setTimeout(() => {
      const el = containerRef.current?.querySelector(
        `[data-row-id="${activeHighlight}"]`,
      ) as HTMLElement | null;
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 150);
    const clear = setTimeout(() => setActiveHighlight(null), 4000);
    return () => {
      clearTimeout(t);
      clearTimeout(clear);
    };
  }, [activeHighlight, submittedRows, approvedRows, landlordRows, tab]);

  const exportToCSV = () => {
    if (rowsToExport.length === 0) {
      toast.error('No records to export');
      return;
    }
    const escape = (val: string | number | null | undefined) => {
      const s = val == null ? '' : String(val);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Tenant Name', 'Tenant Phone', 'Landlord Name', 'Property Address', 'Status', 'Rent Amount (UGX)', 'Duration (Days)', 'Submitted Date'];
    const rows = rowsToExport.map((r: any) => [
      escape(r.tenant_name),
      escape(r.tenant_phone),
      escape(r.landlord_name),
      escape(r.landlord_address),
      escape(STAGE_LABEL[r.status] ?? r.status),
      escape(r.rent_amount),
      escape(r.duration_days),
      escape(format(new Date(r.created_at), 'yyyy-MM-dd')),
    ]);
    const csv = [header.join(','), ...rows.map((row) => row.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const tabLabel = tab === 'submitted' ? 'submitted' : tab === 'approved' ? 'ready-to-pay' : 'rejected';
    link.download = `rent-requests-${tabLabel}-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rowsToExport.length} record${rowsToExport.length === 1 ? '' : 's'} as CSV`);
  };

  const tabs: { key: PipelineTab; label: string; icon: typeof Send; count: number; tone: string }[] = [
    {
      key: 'submitted',
      label: 'Submitted',
      icon: Send,
      count: submitted.data?.total ?? submittedRows.length,
      tone: 'bg-amber-500 text-white',
    },
    {
      key: 'approved',
      label: 'Ready to pay',
      icon: CheckCircle2,
      count: approved.data?.total ?? approvedRows.length,
      tone: 'bg-emerald-600 text-white',
    },
    {
      key: 'rejected',
      label: 'Rejected',
      icon: XCircle,
      count: filteredRejected.length,
      tone: 'bg-destructive text-destructive-foreground',
    },
    {
      key: 'landlords',
      label: 'Landlords',
      icon: Landmark,
      count: landlordRows.length,
      tone: 'bg-indigo-600 text-white',
    },
  ];

  return (
    <div className="space-y-3" ref={containerRef}>
      {/* Tab strip */}
      <div className="flex gap-1.5">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 flex flex-col items-center justify-center gap-1 px-1 py-2 rounded-xl text-[11px] sm:text-sm font-semibold transition-all ${
                active ? t.tone + ' shadow-sm' : 'bg-muted/50 text-muted-foreground'
              }`}
              style={{ touchAction: 'manipulation', minHeight: '52px' }}
            >
              <div className="flex items-center gap-1">
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span
                  className={`min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center text-[10px] font-bold ${
                    active ? 'bg-background/25' : 'bg-background/60'
                  }`}
                >
                  {t.count}
                </span>
              </div>
              <span className="leading-none">{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* Search & Filter bar */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              type="text"
              inputMode="search"
              placeholder="Search by name or phone"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSubmittedPage(0);
                setApprovedPage(0);
                setRejectedPage(0);
              }}
              className="pl-9 pr-9 h-12 text-base"
            />
            {searchQuery && (
              <button
                onClick={() => {
                  setSearchQuery('');
                  setSubmittedPage(0);
                  setApprovedPage(0);
                  setRejectedPage(0);
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
            className={`relative flex items-center gap-1.5 px-3.5 rounded-md border text-sm font-semibold transition-colors ${
              showFilters || activeFiltersCount > 0
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-input bg-background text-muted-foreground'
            }`}
            style={{ touchAction: 'manipulation', minHeight: '48px' }}
          >
            <Filter className="h-4 w-4" />
            Filter
            {activeFiltersCount > 0 && (
              <span className="ml-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">
                {activeFiltersCount}
              </span>
            )}
          </button>
        </div>

        {showFilters && (
        <div className="flex gap-2">
          {(tab === 'submitted' || tab === 'approved') && (
            <div className="flex items-center gap-2 flex-1">
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v);
                  setSubmittedPage(0);
                  setApprovedPage(0);
                }}
              >
                <SelectTrigger className="h-11 text-sm flex-1">
                  <Filter className="h-3.5 w-3.5 mr-1.5 text-muted-foreground shrink-0" />
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {tab === 'submitted' ? (
                    <>
                      <SelectItem value="pending">Agent Ops review</SelectItem>
                      <SelectItem value="tenant_ops_approved">Tenant Ops review</SelectItem>
                      <SelectItem value="agent_verified">Tenant Ops review</SelectItem>
                      <SelectItem value="agent_ops_approved">Landlord Ops review</SelectItem>
                      <SelectItem value="landlord_ops_approved">COO review</SelectItem>
                      <SelectItem value="coo_approved">CFO funding</SelectItem>
                    </>
                  ) : (
                    <>
                      <SelectItem value="funded">Funded — awaiting disbursal</SelectItem>
                      <SelectItem value="disbursed">Disbursed — ready to collect</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
              {statusFilter !== 'all' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setStatusFilter('all')}
                  className="h-11 px-3 shrink-0 gap-1.5 text-xs font-semibold border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Reset
                </Button>
              )}
            </div>
          )}
          {tab === 'submitted' && (
            <Select
              value={tenantSort}
              onValueChange={(v: 'newest' | 'oldest') => {
                setTenantSort(v);
                setSubmittedPage(0);
              }}
            >
              <SelectTrigger className="h-11 text-sm flex-1">
                <ArrowUpDown className="h-3.5 w-3.5 mr-1.5 text-muted-foreground shrink-0" />
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="oldest">Oldest first</SelectItem>
              </SelectContent>
            </Select>
          )}
          {tab === 'landlords' && (
            <div className="flex items-center gap-2 flex-1">
              <Select
                value={landlordStatusFilter}
                onValueChange={(v) => {
                  setLandlordStatusFilter(v);
                }}
              >
                <SelectTrigger className="h-11 text-sm flex-1">
                  <Filter className="h-3.5 w-3.5 mr-1.5 text-muted-foreground shrink-0" />
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="pending">Pending verification</SelectItem>
                  <SelectItem value="verified">Verified</SelectItem>
                </SelectContent>
              </Select>
              {landlordStatusFilter !== 'all' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLandlordStatusFilter('all')}
                  className="h-11 px-3 shrink-0 gap-1.5 text-xs font-semibold border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Reset
                </Button>
              )}
            </div>
          )}
          <Select
            value={dateFilter}
            onValueChange={(v) => {
              setDateFilter(v);
              setSubmittedPage(0);
              setApprovedPage(0);
              setRejectedPage(0);
            }}
          >
            <SelectTrigger className="h-11 text-sm flex-1">
              <Calendar className="h-3.5 w-3.5 mr-1.5 text-muted-foreground shrink-0" />
              <SelectValue placeholder="Date" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All time</SelectItem>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="week">This week</SelectItem>
              <SelectItem value="month">This month</SelectItem>
            </SelectContent>
          </Select>
        </div>
        )}

        <div className="flex items-center justify-between">
          <p className="text-[11px] text-muted-foreground">
            {(() => {
              const n =
                tab === 'submitted'
                  ? submittedRows.length
                  : tab === 'approved'
                    ? approvedRows.length
                    : tab === 'landlords'
                      ? landlordRows.length
                      : filteredRejected.length;
              return activeFiltersCount > 0
                ? `Showing ${n} result${n !== 1 ? 's' : ''}`
                : `${n} record${n !== 1 ? 's' : ''}`;
            })()}
          </p>
          <div className="flex items-center gap-1">
            {activeFiltersCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearchQuery('');
                  setStatusFilter('all');
                  setLandlordStatusFilter('all');
                  setDateFilter('all');
                  setSubmittedPage(0);
                  setApprovedPage(0);
                  setRejectedPage(0);
                }}
                className="h-7 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
                Clear all
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={exportToCSV}
              disabled={rowsToExport.length === 0}
              className="h-7 text-[11px] gap-1.5 font-semibold border-primary/30 text-primary hover:bg-primary/10"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              CSV
            </Button>
          </div>
        </div>
      </div>

      {/* Submitted */}
      {tab === 'submitted' && (
        <div className="space-y-2">
          {submitted.isLoading ? (
            <Skeleton className="h-28 w-full rounded-xl" />
          ) : submittedRows.length === 0 ? (
            <EmptyState
              icon={Send}
              title={activeFiltersCount > 0 ? 'No matches found' : 'Nothing submitted yet'}
              subtitle={activeFiltersCount > 0 ? 'Try adjusting your search or filters.' : 'Rent requests waiting on review will appear here.'}
            />
          ) : (
            <>
              {submittedRows.map((r) => (
                <RowCard
                  key={r.id}
                  row={r}
                  tone="amber"
                  stageLabel={STAGE_LABEL[r.status] ?? 'In review'}
                  onClick={() => setDetailRow(r)}
                  highlighted={activeHighlight === r.id}
                />
              ))}
              <Pager
                page={submittedPage}
                total={submitted.data?.total ?? 0}
                onPage={setSubmittedPage}
                loading={submitted.isFetching}
              />
            </>
          )}
        </div>
      )}

      {/* Approved (ready to pay) */}
      {tab === 'approved' && (
        <div className="space-y-2">
          {approved.isLoading ? (
            <Skeleton className="h-28 w-full rounded-xl" />
          ) : approvedRows.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title={activeFiltersCount > 0 ? 'No matches found' : 'Nothing ready to pay'}
              subtitle={activeFiltersCount > 0 ? 'Try adjusting your search or filters.' : 'Approved requests awaiting tenant repayment will appear here.'}
            />
          ) : (
            <>
              {approvedRows.map((r) => (
                <RowCard
                  key={r.id}
                  row={r}
                  tone="emerald"
                  stageLabel={STAGE_LABEL[r.status] ?? 'Approved'}
                  onClick={() => setDetailRow(r)}
                  highlighted={activeHighlight === r.id}
                  rightSlot={
                    <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-emerald-500/20">
                      <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                        <Banknote className="h-3 w-3" />
                        Total to repay:{' '}
                        <span className="font-semibold text-foreground tabular-nums">
                          {formatUGX(r.total_repayment)}
                        </span>
                      </span>
                      <span className="text-[11px] text-emerald-700 font-semibold">
                        Collect from tenant
                      </span>
                    </div>
                  }
                />
              ))}
              <Pager
                page={approvedPage}
                total={approved.data?.total ?? 0}
                onPage={setApprovedPage}
                loading={approved.isFetching}
              />
            </>
          )}
        </div>
      )}

      {/* Rejected */}
      {tab === 'rejected' && (
        <div className="space-y-2">
          {rejectedQuery.isLoading ? (
            <Skeleton className="h-28 w-full rounded-xl" />
          ) : filteredRejected.length === 0 ? (
            <EmptyState
              icon={XCircle}
              title={activeFiltersCount > 0 ? 'No matches found' : 'No rejections'}
              subtitle={activeFiltersCount > 0 ? 'Try adjusting your search or filters.' : "When a request is rejected, the reviewer's reason will show here."}
            />
          ) : (
            <>
              {rejectedPaged.map((r) => (
                <Card
                  key={r.id}
                  className="border-2 border-destructive/40 bg-destructive/5 overflow-hidden"
                >
                  <StatusStrip status="rejected" label={`Rejected at ${r.stage_label}`} />
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <User className="h-4 w-4 text-primary shrink-0" />
                          <span className="font-semibold truncate text-sm">{r.tenant_name}</span>
                          <Badge variant="destructive" className="text-[10px]">
                            Rejected at {r.stage_label}
                          </Badge>
                        </div>
                        <div className="text-[11px] text-muted-foreground space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <Building className="h-3 w-3" />
                            <span className="truncate">{r.landlord_name}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Calendar className="h-3 w-3" />
                            <span>
                              {r.rejected_at
                                ? `Rejected ${format(new Date(r.rejected_at), 'MMM d, yyyy')}`
                                : `Submitted ${format(new Date(r.created_at), 'MMM d, yyyy')}`}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-bold tabular-nums">{formatUGX(r.rent_amount)}</p>
                        <p className="text-[10px] text-muted-foreground">{r.duration_days} days</p>
                      </div>
                    </div>
                    {/* Prominent reason block */}
                    <div className="rounded-lg border-2 border-destructive/40 bg-background p-2.5">
                      <div className="flex items-center gap-1.5 mb-1">
                        <MessageSquare className="h-3.5 w-3.5 text-destructive" />
                        <p className="text-[10px] font-bold uppercase tracking-wide text-destructive">
                          Reason — {r.reviewer_name}
                        </p>
                      </div>
                      <p className="text-sm text-foreground/90 whitespace-pre-wrap font-medium">
                        {r.rejected_reason || 'No reason provided.'}
                      </p>
                    </div>
                      <div className="flex justify-end pt-1">
                        <Button
                          size="sm"
                          onClick={() => setEditing(r)}
                          className="gap-1.5 h-8"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          Edit & Resubmit
                        </Button>
                      </div>
                  </CardContent>
                </Card>
              ))}
              <Pager
                page={rejectedPage}
                total={rejectedAll.length}
                onPage={setRejectedPage}
                loading={rejectedQuery.isFetching}
              />
            </>
          )}
        </div>
      )}

      {/* Landlords (standalone registrations) */}
      {tab === 'landlords' && (
        <div className="space-y-2">
          {landlordsQuery.isLoading ? (
            <Skeleton className="h-24 w-full rounded-xl" />
          ) : landlordRows.length === 0 ? (
            <EmptyState
              icon={Landmark}
              title={activeFiltersCount > 0 ? 'No matches found' : 'No landlords yet'}
              subtitle={activeFiltersCount > 0 ? 'Try adjusting your search.' : 'Landlords you register will appear here right away.'}
            />
          ) : (
            landlordRows.map((l) => (
              <Card
                key={l.id}
                data-row-id={l.id}
                className={`border-2 border-indigo-500/30 bg-indigo-500/5 overflow-hidden ${
                  activeHighlight === l.id ? 'ring-2 ring-primary ring-offset-2 ring-offset-background animate-pulse' : ''
                }`}
              >
                <CardContent className="p-4 space-y-3">
                  {/* Name + status: status sits on its own row on phones so the
                      name never gets squeezed or truncated awkwardly. */}
                  <div className="flex items-start gap-2.5">
                    <div className="flex items-center justify-center h-9 w-9 rounded-full bg-indigo-500/15 shrink-0">
                      <Landmark className="h-5 w-5 text-indigo-600" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-base leading-snug break-words">
                        {l.name || 'Unnamed landlord'}
                      </p>
                      <Badge
                        className={`mt-1 text-[11px] ${l.verified ? 'bg-emerald-600 text-white' : 'bg-amber-500 text-white'}`}
                      >
                        {l.verified ? 'Verified' : 'Pending verification'}
                      </Badge>
                    </div>
                  </div>

                  {/* Details: full-width rows, generous spacing, tap-to-call. */}
                  <div className="space-y-2.5 text-sm">
                    {l.phone && (
                      <a
                        href={`tel:${l.phone}`}
                        className="flex items-center gap-2.5 text-foreground active:opacity-70"
                        style={{ touchAction: 'manipulation' }}
                      >
                        <Phone className="h-4 w-4 text-indigo-600 shrink-0" />
                        <span className="font-medium underline-offset-2">{l.phone}</span>
                      </a>
                    )}
                    {l.property_address && (
                      <div className="flex items-start gap-2.5 text-muted-foreground">
                        <MapPin className="h-4 w-4 text-indigo-600 shrink-0 mt-0.5" />
                        <span className="break-words">{l.property_address}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-2.5 text-muted-foreground">
                      <Calendar className="h-4 w-4 text-indigo-600 shrink-0" />
                      <span>Registered {format(new Date(l.created_at), 'MMM d, yyyy')}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}

      <AgentEditRentRequestDialog
        request={editing}
        open={!!editing}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        onResubmitted={() => {
          setEditing(null);
          // Refresh both lists so the request leaves Rejected and appears under Submitted
          rejectedQuery.refetch();
          queryClient.invalidateQueries({ queryKey: ['agent-pipeline', 'submitted'] });
          setSubmittedPage(0);
          setTab('submitted');
        }}
      />

      <RequestDetailDrawer
        row={detailRow}
        stageLabel={detailRow ? STAGE_LABEL[detailRow.status] ?? 'In review' : ''}
        onClose={() => setDetailRow(null)}
      />
    </div>
  );
}

function DetailRow({
  icon: Icon,
  label,
  value,
  emphasis,
}: {
  icon: typeof User;
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <span className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <span
        className={`text-right break-words ${
          emphasis ? 'text-sm font-bold tabular-nums text-foreground' : 'text-sm font-medium text-foreground'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function RequestDetailDrawer({
  row,
  stageLabel,
  onClose,
}: {
  row: PipelineRow | null;
  stageLabel: string;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const dailyRepay =
    row && row.duration_days > 0 ? Math.round(row.total_repayment / row.duration_days) : 0;
  const canCancel =
    !!row && !!user && SUBMITTED_STATUSES.includes(row.status);
  const handleCancel = async () => {
    if (!row || !user) return;
    if (cancelReason.trim().length < 10) {
      toast.error('Reason required', {
        description: 'Please give at least 10 characters explaining why you are cancelling.',
      });
      return;
    }
    setCancelling(true);
    try {
      const { error } = await (supabase as any).rpc('agent_cancel_rent_request', {
        p_request_id: row.id,
        p_reason: cancelReason.trim(),
      });
      if (error) throw error;
      toast.success('Request cancelled', { description: 'The rent request has been removed.' });
      setConfirmCancel(false);
      setCancelReason('');
      queryClient.invalidateQueries({ queryKey: ['agent-pipeline'] });
      onClose();
    } catch (e: any) {
      toast.error('Could not cancel', { description: e?.message || 'Please try again.' });
    } finally {
      setCancelling(false);
    }
  };
  const history = useQuery({
    queryKey: ['agent-request-history', row?.id],
    enabled: !!row?.id,
    queryFn: async (): Promise<{
      events: { id: string; event_type: string; metadata: any; created_at: string }[];
      repayments: { id: string; amount: number; created_at: string }[];
    }> => {
      const { data, error } = await supabase.rpc('get_agent_request_history', {
        p_request_id: row!.id,
      });
      if (error) throw error;
      const d = (data ?? {}) as any;
      return {
        events: Array.isArray(d.events) ? d.events : [],
        repayments: Array.isArray(d.repayments) ? d.repayments : [],
      };
    },
  });
  return (
    <Drawer open={!!row} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DrawerContent className="z-[200] max-h-[90vh]" overlayClassName="z-[190]">
        {row && (
          <div className="mx-auto w-full max-w-md flex flex-col min-h-0 max-h-[90vh]">
            <DrawerHeader className="text-left shrink-0">
              <div className="flex items-center justify-between gap-2">
                <DrawerTitle className="text-base">Request details</DrawerTitle>
                <Badge variant="secondary" className="text-[10px]">{stageLabel}</Badge>
              </div>
              <DrawerDescription>
                Submitted {format(new Date(row.created_at), 'MMM d, yyyy · h:mm a')}
              </DrawerDescription>
            </DrawerHeader>

            <div className="px-4 pb-2 space-y-3 flex-1 min-h-0 overflow-y-auto">
              {/* Tenant */}
              <div className="rounded-xl border bg-muted/30 px-3.5">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground pt-3">
                  Tenant
                </p>
                <div className="divide-y divide-border/60">
                  <DetailRow icon={User} label="Name" value={row.tenant_name || 'Unknown tenant'} />
                  {row.tenant_phone && (
                    <DetailRow icon={Phone} label="Phone" value={row.tenant_phone} />
                  )}
                </div>
              </div>

              {/* Landlord */}
              <div className="rounded-xl border bg-muted/30 px-3.5">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground pt-3">
                  Landlord
                </p>
                <div className="divide-y divide-border/60">
                  <DetailRow
                    icon={Building}
                    label="Name"
                    value={row.landlord_name || 'Not provided'}
                  />
                  {row.landlord_address && (
                    <DetailRow icon={MapPin} label="Property" value={row.landlord_address} />
                  )}
                </div>
              </div>

              {/* Amounts */}
              <div className="rounded-xl border bg-muted/30 px-3.5">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground pt-3">
                  Amounts
                </p>
                <div className="divide-y divide-border/60">
                  <DetailRow icon={Banknote} label="Rent amount" value={formatUGX(row.rent_amount)} emphasis />
                  <DetailRow icon={Banknote} label="Total to repay" value={formatUGX(row.total_repayment)} emphasis />
                  <DetailRow icon={Banknote} label="Daily repayment" value={formatUGX(dailyRepay)} />
                  {row.amount_repaid > 0 && (
                    <DetailRow icon={Banknote} label="Repaid so far" value={formatUGX(row.amount_repaid)} />
                  )}
                  <DetailRow icon={Clock} label="Duration" value={`${row.duration_days} days`} />
                </div>
              </div>

              {/* Reference */}
              <div className="rounded-xl border bg-muted/30 px-3.5">
                <div className="divide-y divide-border/60">
                  <DetailRow icon={Hash} label="Reference" value={row.id.slice(0, 8).toUpperCase()} />
                  {(row.resubmission_count ?? 0) > 0 && (
                    <DetailRow
                      icon={RefreshCw}
                      label="Resubmissions"
                      value={`×${row.resubmission_count}`}
                    />
                  )}
                </div>
              </div>

              {/* Status history */}
              <div className="rounded-xl border bg-muted/30 px-3.5 py-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-2">
                  Status history
                </p>
                {history.isLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                  </div>
                ) : (history.data?.events.length ?? 0) === 0 ? (
                  <p className="text-xs text-muted-foreground py-1">No status changes recorded yet.</p>
                ) : (
                  <ol className="relative space-y-3 pl-4 before:absolute before:left-[5px] before:top-1.5 before:bottom-1.5 before:w-px before:bg-border">
                    {history.data!.events.map((ev) => (
                      <li key={ev.id} className="relative">
                        <span className="absolute -left-4 top-1 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-background" />
                        <p className="text-xs font-semibold text-foreground">
                          {EVENT_LABEL[ev.event_type] ?? ev.event_type.replace(/[._]/g, ' ')}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {format(new Date(ev.created_at), 'MMM d, yyyy · h:mm a')}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              {/* Transaction history */}
              <div className="rounded-xl border bg-muted/30 px-3.5 py-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-2">
                  Transaction history
                </p>
                {history.isLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                  </div>
                ) : (history.data?.repayments.length ?? 0) === 0 ? (
                  <p className="text-xs text-muted-foreground py-1">No repayments recorded yet.</p>
                ) : (
                  <div className="divide-y divide-border/60">
                    {history.data!.repayments.map((tx) => (
                      <div key={tx.id} className="flex items-center justify-between gap-2 py-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="flex items-center justify-center h-7 w-7 rounded-full bg-emerald-500/10 shrink-0">
                            <Banknote className="h-3.5 w-3.5 text-emerald-600" />
                          </div>
                          <span className="text-[11px] text-muted-foreground truncate">
                            {format(new Date(tx.created_at), 'MMM d, yyyy · h:mm a')}
                          </span>
                        </div>
                        <span className="text-sm font-bold tabular-nums text-emerald-600 shrink-0">
                          +{formatUGX(tx.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <DrawerFooter className="shrink-0 gap-2 border-t bg-background">
              {canCancel && (
                <Button
                  variant="destructive"
                  className="w-full"
                  onClick={() => setConfirmCancel(true)}
                  disabled={cancelling}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Reject / Cancel request
                </Button>
              )}
              <DrawerClose asChild>
                <Button variant="outline" className="w-full">Close</Button>
              </DrawerClose>
            </DrawerFooter>
          </div>
        )}
      </DrawerContent>
      <AlertDialog
        open={confirmCancel}
        onOpenChange={(o) => { if (!cancelling) { setConfirmCancel(o); if (!o) setCancelReason(''); } }}
      >
        <AlertDialogContent className="z-[210]">
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this rent request?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the rent request from the pipeline. A reason is required and is
              recorded against your name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Why are you cancelling? e.g. duplicate submission, wrong rent amount captured…"
              rows={3}
              disabled={cancelling}
            />
            <p className="text-xs text-muted-foreground">
              {cancelReason.trim().length}/10 characters minimum
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelling}>Keep request</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleCancel(); }}
              disabled={cancelling || cancelReason.trim().length < 10}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelling ? 'Cancelling…' : 'Yes, cancel'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Drawer>
  );
}

function EmptyState({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: typeof Send;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="text-center py-12 px-4">
      <Icon className="h-10 w-10 mx-auto mb-3 text-muted-foreground/40" />
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
    </div>
  );
}