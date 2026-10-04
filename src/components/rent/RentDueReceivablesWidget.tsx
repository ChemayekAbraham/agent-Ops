import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Clock, Home, MapPin, Loader2, User, Pencil,
  TrendingUp, Calendar, ChevronDown, ChevronUp,
  CalendarDays, Receipt, FileDown, MessageCircle, Trash2
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { addDays, format, subDays, startOfDay, endOfDay, startOfWeek, startOfMonth, startOfYear } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';
import { EditApprovedRentDialog } from './EditApprovedRentDialog';
import { RentRequestDetailDrawer } from './RentRequestDetailDrawer';
import { useAuth } from '@/hooks/useAuth';
import { exportToPDF } from '@/lib/exportUtils';
import { shareViaWhatsApp } from '@/lib/shareReceipt';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type ReceivablePeriod = 'all' | 'today' | '7days' | '30days' | 'this_week' | 'this_month' | 'this_year';

const PERIOD_OPTIONS: { value: ReceivablePeriod; label: string }[] = [
  { value: 'all', label: 'All Time' },
  { value: 'today', label: 'Today' },
  { value: '7days', label: 'Last 7 Days' },
  { value: 'this_week', label: 'This Week' },
  { value: '30days', label: 'Last 30 Days' },
  { value: 'this_month', label: 'This Month' },
  { value: 'this_year', label: 'This Year' },
];

function getPeriodDateRange(period: ReceivablePeriod): { start: Date | null; end: Date } {
  const now = new Date();
  switch (period) {
    case 'today': return { start: startOfDay(now), end: endOfDay(now) };
    case '7days': return { start: startOfDay(subDays(now, 7)), end: endOfDay(now) };
    case '30days': return { start: startOfDay(subDays(now, 30)), end: endOfDay(now) };
    case 'this_week': return { start: startOfWeek(now, { weekStartsOn: 1 }), end: endOfDay(now) };
    case 'this_month': return { start: startOfMonth(now), end: endOfDay(now) };
    case 'this_year': return { start: startOfYear(now), end: endOfDay(now) };
    default: return { start: null, end: endOfDay(now) };
  }
}
interface SubscriptionStatus {
  status: string;
  total_charged: number;
  accumulated_debt: number;
  charges_remaining: number;
  charges_completed: number;
  next_charge_date: string;
  frequency: string;
  charge_amount: number;
}

interface ApprovedRequest {
  id: string;
  tenant_id: string;
  rent_amount: number;
  duration_days: number;
  status: string;
  approved_at: string | null;
  created_at: string;
  house_category: string | null;
  request_city: string | null;
  access_fee: number;
  request_fee: number;
  total_repayment: number;
  daily_repayment: number;
  number_of_payments: number | null;
  amount_repaid: number;
  funded_at: string | null;
  tenant: { full_name: string; phone: string } | null;
  agent: { full_name: string } | null;
  subscription?: SubscriptionStatus | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  'single-room': 'Single Room',
  'double-room': 'Double Room',
  '1-bed': '1 Bed House',
  '2-bed': '2 Bedroom',
  '2-bed-full': '2 Bed Full',
  '3-bed': '3 Bedroom',
  '3-bed-luxury': '3 Bed Luxury',
  '4-bed': '4+ Bed Villa',
  'shop': 'Shop / Lock-up Shop',
  'market-stall': 'Market Stall',
  'kiosk': 'Kiosk / Container',
  'salon-workshop': 'Salon / Workshop',
  'office': 'Office Space',
  'warehouse': 'Warehouse / Store',
  'commercial': 'Other Commercial Premises',
};

interface RentDueReceivablesWidgetProps {
  mode: 'manager' | 'agent';
  /** Called with total receivable amount so parent can show it on the button */
  onTotalChange?: (total: number) => void;
}

function RequestBreakdownRow({ req, onViewDetails, isManager, onDeleteUser }: { 
  req: ApprovedRequest; 
  onViewDetails?: (id: string) => void;
  isManager?: boolean;
  onDeleteUser?: (userId: string, name: string, requestId?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const remaining = Math.max(0, req.total_repayment - (req.amount_repaid || 0));

  const weeklyRepayment = Math.ceil(req.total_repayment / Math.ceil(req.duration_days / 7));
  const monthlyRepayment = Math.ceil(req.total_repayment / Math.ceil(req.duration_days / 30));
  const dueDate = req.approved_at
    ? format(addDays(new Date(req.approved_at), req.duration_days), 'dd MMM yyyy')
    : '—';
  const approvedDate = req.approved_at ? format(new Date(req.approved_at), 'dd MMM yyyy') : '—';

  return (
    <div className="border-b border-success/20 last:border-b-0">
      {/* Summary row */}
      <button
        className="w-full text-left px-4 py-3 hover:bg-success/10 transition-colors flex items-start gap-2"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="font-bold text-sm truncate">
              {req.tenant?.full_name || 'Unknown Tenant'}
            </p>
            <div className="flex items-center gap-1.5 shrink-0">
              <div className="text-right">
                <p className={`font-extrabold text-sm ${remaining > 0 ? 'text-warning' : 'text-success'}`}>
                  {remaining > 0 ? formatUGX(remaining) : '✓ Paid'}
                </p>
                {req.amount_repaid > 0 && remaining > 0 && (
                  <p className="text-[9px] text-success">+{formatUGX(req.amount_repaid)} paid</p>
                )}
              </div>
              {open ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
            </div>
          </div>
           <div className="flex items-center gap-2 flex-wrap mt-1">
            {/* Auto-charge status badge */}
            {req.subscription ? (
              <Badge 
                variant={req.subscription.status === 'active' ? 'default' : 'secondary'}
                className="text-[10px] px-1.5 py-0 gap-0.5"
              >
                {req.subscription.status === 'active' ? '⚡ Auto-charging' : '✓ Completed'}
              </Badge>
            ) : req.funded_at ? (
              <Badge variant="destructive" className="text-[10px] px-1.5 py-0 gap-0.5">
                ⚠ No schedule
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-0.5">
                Awaiting funding
              </Badge>
            )}
            {req.subscription?.accumulated_debt && req.subscription.accumulated_debt > 0 ? (
              <Badge variant="destructive" className="text-[10px] px-1.5 py-0 gap-0.5">
                Debt: {formatUGX(req.subscription.accumulated_debt)}
              </Badge>
            ) : null}
            {req.house_category && (
              <Badge variant="success" className="text-[10px] px-1.5 py-0 gap-0.5">
                <Home className="h-2.5 w-2.5" />
                {CATEGORY_LABELS[req.house_category] || req.house_category}
              </Badge>
            )}
            {req.request_city && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                <MapPin className="h-2.5 w-2.5" />
                {req.request_city}
              </span>
            )}
            <span className="text-[10px] text-muted-foreground">•</span>
            <span className="text-[10px] text-muted-foreground">{req.duration_days}d</span>
            <span className="text-[10px] text-muted-foreground">• Due {dueDate}</span>
          </div>
        </div>
      </button>

      {/* Expanded breakdown */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-3">
              {/* Dates */}
              <div className="flex gap-2 flex-wrap">
                <div className="flex items-center gap-1.5 bg-muted/50 rounded-lg px-2.5 py-1.5">
                  <Calendar className="h-3 w-3 text-muted-foreground" />
                  <div>
                    <p className="text-[9px] text-muted-foreground">Approved</p>
                    <p className="text-[11px] font-semibold">{approvedDate}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 bg-destructive/10 rounded-lg px-2.5 py-1.5">
                  <CalendarDays className="h-3 w-3 text-destructive" />
                  <div>
                    <p className="text-[9px] text-muted-foreground">Due Date</p>
                    <p className="text-[11px] font-semibold text-destructive">{dueDate}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 bg-muted/50 rounded-lg px-2.5 py-1.5">
                  <Clock className="h-3 w-3 text-muted-foreground" />
                  <div>
                    <p className="text-[9px] text-muted-foreground">Duration</p>
                    <p className="text-[11px] font-semibold">{req.duration_days} days</p>
                  </div>
                </div>
              </div>

              {/* Fee Breakdown */}
              <div className="rounded-xl border border-success/30 bg-success/5 overflow-hidden">
                <div className="px-3 py-2 bg-success/15 border-b border-success/20">
                  <p className="text-[10px] font-bold text-success uppercase tracking-wide">Fee Breakdown</p>
                </div>
                <div className="p-3 space-y-2">
                  {/* Principal */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-primary" />
                      <span className="text-xs text-muted-foreground">Principal (Rent)</span>
                    </div>
                    <span className="text-xs font-bold">{formatUGX(req.rent_amount)}</span>
                  </div>
                  {/* Access Fee */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-warning" />
                      <span className="text-xs text-muted-foreground">Access Fee (33%/mo)</span>
                    </div>
                    <span className="text-xs font-bold text-warning">{formatUGX(req.access_fee || 0)}</span>
                  </div>
                  {/* Platform/Request Fee */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-accent" />
                      <span className="text-xs text-muted-foreground">Platform Fee</span>
                    </div>
                    <span className="text-xs font-bold text-accent-foreground">{formatUGX(req.request_fee || 0)}</span>
                  </div>
                  {/* Collected + Remaining */}
                  <div className="border-t border-success/30 pt-2 space-y-1">
                    {req.amount_repaid > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-success">✓ Collected</span>
                        <span className="text-xs font-bold text-success">{formatUGX(req.amount_repaid)}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className={`text-xs font-extrabold ${remaining > 0 ? 'text-warning' : 'text-success'}`}>
                        {remaining > 0 ? 'Outstanding' : '✓ Fully Repaid'}
                      </span>
                      <span className={`text-sm font-extrabold ${remaining > 0 ? 'text-warning' : 'text-success'}`}>
                        {formatUGX(remaining)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Repayment Schedule Summary */}
              <div className="rounded-xl border border-primary/20 bg-primary/5 overflow-hidden">
                <div className="px-3 py-2 bg-primary/10 border-b border-primary/20">
                  <p className="text-[10px] font-bold text-primary uppercase tracking-wide">Expected Collections</p>
                </div>
                <div className="grid grid-cols-3 divide-x divide-primary/20">
                  <div className="p-2.5 text-center">
                    <p className="text-[9px] text-muted-foreground mb-0.5">Per Day</p>
                    <p className="text-[11px] font-extrabold text-primary">{formatUGX(req.daily_repayment || 0)}</p>
                  </div>
                  <div className="p-2.5 text-center">
                    <p className="text-[9px] text-muted-foreground mb-0.5">Per Week</p>
                    <p className="text-[11px] font-extrabold text-primary">{formatUGX(weeklyRepayment)}</p>
                  </div>
                  <div className="p-2.5 text-center">
                    <p className="text-[9px] text-muted-foreground mb-0.5">Per Month</p>
                    <p className="text-[11px] font-extrabold text-primary">{formatUGX(monthlyRepayment)}</p>
                  </div>
                </div>
              </div>

              {/* Tenant contact */}
              {req.tenant?.phone && (
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <User className="h-3 w-3" />
                  <span>{req.tenant.full_name}</span>
                  <span>•</span>
                  <span>{req.tenant.phone}</span>
                </div>
              )}

              {/* View Full Details button */}
              {onViewDetails && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs gap-1.5 mt-1"
                  onClick={() => onViewDetails(req.id)}
                >
                  View Full Details
                </Button>
              )}

              {/* Delete User button - Manager only */}
              {isManager && onDeleteUser && req.tenant_id && (
                <Button
                  variant="destructive"
                  size="sm"
                  className="w-full text-xs gap-1.5 mt-1 min-h-[44px] touch-manipulation"
                  onClick={() => onDeleteUser(req.tenant_id, req.tenant?.full_name || 'Unknown', req.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete Rent Request & Ledger
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function RentDueReceivablesWidget({ mode, onTotalChange }: RentDueReceivablesWidgetProps) {
  const { user } = useAuth();
  const [requests, setRequests] = useState<ApprovedRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingRequest, setEditingRequest] = useState<ApprovedRequest | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [fieldCollections, setFieldCollections] = useState(0);
  const [fieldCollectionCount, setFieldCollectionCount] = useState(0);
  const [period, setPeriod] = useState<ReceivablePeriod>('all');
  const [exporting, setExporting] = useState(false);
  const [detailRequestId, setDetailRequestId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState<{ requestId: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const statementRef = useRef<HTMLDivElement>(null);

  const fetchRequests = useCallback(async () => {
    if (!user) return;

    const { start } = getPeriodDateRange(period);
    
    let query = supabase
      .from('rent_requests')
      .select('id, rent_amount, duration_days, status, approved_at, created_at, house_category, request_city, access_fee, request_fee, total_repayment, daily_repayment, number_of_payments, amount_repaid, tenant_id, agent_id, funded_at')
      .in('status', ['approved', 'funded'])
      .order('approved_at', { ascending: false })
      .limit(50);

    if (start) {
      query = query.gte('approved_at', start.toISOString());
    }

    if (mode === 'agent') {
      query = query.eq('agent_id', user.id);
    }

    const { data, error } = await query;

    if (!error && data) {
      const tenantIds = [...new Set(data.map((r: any) => r.tenant_id))];
      const agentIds = [...new Set(data.map((r: any) => r.agent_id).filter(Boolean))] as string[];
      const allIds = [...new Set([...tenantIds, ...agentIds])];
      const requestIds = data.map((r: any) => r.id);

      // Fetch profiles and subscription statuses in parallel
      const [profilesRes, subscriptionsRes] = await Promise.all([
        allIds.length > 0
          ? supabase.from('profiles').select('id, full_name, phone').in('id', allIds)
          : Promise.resolve({ data: [] }),
        requestIds.length > 0
          ? supabase.from('subscription_charges').select('rent_request_id, status, total_charged, accumulated_debt, charges_remaining, charges_completed, next_charge_date, frequency, charge_amount').in('rent_request_id', requestIds)
          : Promise.resolve({ data: [] }),
      ]);

      const profileMap = new Map((profilesRes.data || []).map((p: any) => [p.id, p]));
      const subMap = new Map((subscriptionsRes.data || []).map((s: any) => [s.rent_request_id, s]));

      const enriched = data.map((r: any) => ({
        ...r,
        amount_repaid: r.amount_repaid ?? 0,
        funded_at: r.funded_at,
        tenant: profileMap.get(r.tenant_id) ? { full_name: profileMap.get(r.tenant_id)!.full_name, phone: profileMap.get(r.tenant_id)!.phone } : null,
        agent: r.agent_id && profileMap.get(r.agent_id) ? { full_name: profileMap.get(r.agent_id)!.full_name } : null,
        subscription: subMap.get(r.id) || null,
      }));

      setRequests(enriched);

      // Fetch field collections (tenant_merchant_payments)
      let fieldQuery = supabase
        .from('tenant_merchant_payments')
        .select('amount');
      
      if (mode === 'agent') {
        fieldQuery = fieldQuery.eq('agent_id', user.id);
      }

      const { data: fieldPayments } = await fieldQuery;
      const fieldTotal = (fieldPayments || []).reduce((sum: number, p: any) => sum + (p.amount || 0), 0);
      setFieldCollections(fieldTotal);
      setFieldCollectionCount((fieldPayments || []).length);

      // Notify parent of total REMAINING receivable (not yet repaid)
      const total = enriched.reduce((sum: number, r: any) => sum + Math.max(0, (r.total_repayment || 0) - (r.amount_repaid || 0)), 0);
      onTotalChange?.(total);
    }
    setLoading(false);
  }, [user, mode, onTotalChange, period]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  // Aggregate totals — use REMAINING balance (total - repaid)
  const totalCollected = requests.reduce((sum, r) => sum + (r.amount_repaid || 0), 0);
  const totalReceivable = requests.reduce((sum, r) => sum + Math.max(0, (r.total_repayment || 0) - (r.amount_repaid || 0)), 0);
  const totalGross = requests.reduce((sum, r) => sum + (r.total_repayment || 0), 0);
  const totalDaily = requests.reduce((sum, r) => sum + (r.daily_repayment || 0), 0);
  const totalWeekly = requests.reduce((sum, r) => {
    const w = Math.ceil(r.total_repayment / Math.ceil(r.duration_days / 7));
    return sum + w;
  }, 0);
  const totalMonthly = requests.reduce((sum, r) => {
    const m = Math.ceil(r.total_repayment / Math.ceil(r.duration_days / 30));
    return sum + m;
  }, 0);

  if (loading) {
    return (
      <Card className="border-2 border-success/50 bg-success/5">
        <CardContent className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-success" />
        </CardContent>
      </Card>
    );
  }

  // Income statement aggregates
  const totalPrincipal = requests.reduce((sum, r) => sum + (r.rent_amount || 0), 0);
  const totalAccessFees = requests.reduce((sum, r) => sum + (r.access_fee || 0), 0);
  const totalPlatformFees = requests.reduce((sum, r) => sum + (r.request_fee || 0), 0);
  const netOutstanding = Math.max(0, totalReceivable - fieldCollections);
  const periodLabel = PERIOD_OPTIONS.find(p => p.value === period)?.label || 'All Time';

  // ── REVENUE RECOGNITION ──
  // Revenue = Access Fees + Platform Fees (Welile's earned income)
  // Principal is pass-through capital (not Welile revenue)
  const totalWelileRevenue = totalAccessFees + totalPlatformFees;
  // Collected revenue = proportion of collections that represent fees (not principal)
  const feeRatio = totalGross > 0 ? totalWelileRevenue / totalGross : 0;
  const collectedRevenue = Math.round(totalCollected * feeRatio);
  const uncollectedRevenue = totalWelileRevenue - collectedRevenue;

  // Auto-charge summary
  const activeSubscriptions = requests.filter(r => r.subscription?.status === 'active').length;
  const completedSubscriptions = requests.filter(r => r.subscription?.status === 'completed').length;
  const noSchedule = requests.filter(r => r.funded_at && !r.subscription).length;
  const totalDebt = requests.reduce((sum, r) => sum + (r.subscription?.accumulated_debt || 0), 0);
  const fundedRequests = requests.filter(r => r.funded_at).length;

  const buildWhatsAppText = () => {
    const lines = [
      `📊 *Welile Receivables Statement*`,
      `━━━━━━━━━━━━━━━━`,
      `📅 *Period:* ${periodLabel}`,
      `📋 *Requests:* ${requests.length}`,
      ``,
      `💰 *Rent Receivables*`,
      `  Principal: ${formatUGX(totalPrincipal)}`,
      `  Access Fee: ${formatUGX(totalAccessFees)}`,
      `  Platform Fee: ${formatUGX(totalPlatformFees)}`,
      ``,
      `📥 *Collections*`,
      `  Wallet Collected: ${formatUGX(totalCollected)}`,
    ];
    if (fieldCollections > 0) {
      lines.push(`  Field Collections: ${formatUGX(fieldCollections)}`);
    }
    lines.push(
      ``,
      `💰 *Welile Revenue*`,
      `  Access Fee Revenue: ${formatUGX(totalAccessFees)}`,
      `  Platform Fee Revenue: ${formatUGX(totalPlatformFees)}`,
      `  *Total Revenue:* ${formatUGX(totalWelileRevenue)}`,
      `  Revenue Collected: ${formatUGX(collectedRevenue)}`,
      `  Revenue Uncollected: ${formatUGX(uncollectedRevenue)}`,
      ``,
      `📊 *Expected Collections*`,
      `  Daily: ${formatUGX(totalDaily)}`,
      `  Weekly: ${formatUGX(totalWeekly)}`,
      `  Monthly: ${formatUGX(totalMonthly)}`,
      ``,
      `⚡ *Auto-Charge*`,
      `  Active: ${activeSubscriptions} | Completed: ${completedSubscriptions}`,
      totalDebt > 0 ? `  ⚠ Debt: ${formatUGX(totalDebt)}` : '',
      ``,
      `━━━━━━━━━━━━━━━━`,
      `💵 *Gross Receivable:* ${formatUGX(totalGross)}`,
      `✅ *Total Collected:* ${formatUGX(totalCollected + fieldCollections)}`,
      `⚠️ *Net Outstanding:* ${formatUGX(netOutstanding)}`,
      `━━━━━━━━━━━━━━━━`,
      `Generated: ${format(new Date(), 'dd MMM yyyy, HH:mm')}`,
      `Powered by Welile`,
    );
    return lines.join('\n');
  };

  const handleShareWhatsApp = () => {
    shareViaWhatsApp(buildWhatsAppText());
  };

  const handleExportPDF = async () => {
    if (!statementRef.current) return;
    setExporting(true);
    try {
      await exportToPDF(statementRef.current, 'receivables_statement', `Receivables Statement — ${periodLabel}`);
      toast.success('PDF exported');
    } catch {
      toast.error('PDF export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
    >
      <Card className="border-2 border-success/60 overflow-hidden shadow-lg shadow-success/10">
        <CardContent className="p-0" ref={statementRef}>

          {/* ── Statement Header ── */}
          <div className="flex items-center gap-3 px-4 py-3 bg-success/20 border-b border-success/30">
            <div className="p-2 rounded-full bg-success/30">
              <TrendingUp className="h-5 w-5 text-success" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-base text-success">Receivables Statement</h3>
              <p className="text-[10px] text-success/70">
                {periodLabel} · {requests.length} {requests.length === 1 ? 'request' : 'requests'} · {formatUGX(totalCollected)} collected
              </p>
            </div>
          </div>

          {/* ── Period Filter ── */}
          <div className="px-4 py-2 bg-muted/30 border-b border-border/40 flex items-center gap-2 overflow-x-auto no-scrollbar">
            {PERIOD_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setPeriod(opt.value)}
                className={`whitespace-nowrap px-3 py-1.5 rounded-full text-[11px] font-semibold transition-all ${
                  period === opt.value
                    ? 'bg-success text-success-foreground shadow-sm'
                    : 'bg-background border border-border/60 text-muted-foreground hover:bg-accent/30'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* ── Action Buttons ── */}
          <div className="px-4 py-2 border-b border-border/40 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportPDF}
              disabled={exporting || requests.length === 0}
              className="gap-1.5 text-xs"
            >
              <FileDown className="h-3.5 w-3.5" />
              {exporting ? 'Exporting…' : 'PDF'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleShareWhatsApp}
              disabled={requests.length === 0}
              className="gap-1.5 text-xs text-success border-success/40 hover:bg-success/10"
            >
              <MessageCircle className="h-3.5 w-3.5" />
              WhatsApp
            </Button>
          </div>

          {requests.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              No approved rent requests yet
            </div>
          ) : (
            <>
              {/* ── Income Statement Body ── */}
              <div className="px-5 py-4 space-y-5">

                {/* SECTION: Rent Receivables */}
                <div className="space-y-2">
                  <p className="text-[10px] font-semibold text-success uppercase tracking-wider border-b border-success/20 pb-1">
                    Rent Receivables
                  </p>

                  <div className="space-y-1.5 pl-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Principal (Rent Facilitated)</span>
                      <span className="font-mono font-medium">{formatUGX(totalPrincipal)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Access Fee Income (33%/mo)</span>
                      <span className="font-mono font-medium">{formatUGX(totalAccessFees)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Platform Fee Income</span>
                      <span className="font-mono font-medium">{formatUGX(totalPlatformFees)}</span>
                    </div>
                  </div>

                  {/* Collected vs Remaining */}
                  <div className="space-y-1 pt-1.5 border-t border-border/60">
                    <div className="flex justify-between text-sm text-success font-medium">
                      <span>✓ Collected</span>
                      <span className="font-mono">{formatUGX(totalCollected)}</span>
                    </div>
                    <div className="flex justify-between font-semibold">
                      <span className="text-sm">Remaining Receivable</span>
                      <span className={`font-mono ${totalReceivable > 0 ? 'text-warning' : 'text-success'}`}>{formatUGX(totalReceivable)}</span>
                    </div>
                  </div>
                </div>

                {/* ══ REVENUE RECOGNITION ══ */}
                <div className="space-y-2">
                  <p className="text-[10px] font-semibold text-primary uppercase tracking-wider border-b border-primary/20 pb-1 flex items-center gap-1">
                    💰 Welile Revenue Recognition
                  </p>
                  <p className="text-[9px] text-muted-foreground italic">
                    Revenue = Access Fees + Platform Fees. Principal is pass-through capital, not Welile income.
                  </p>
                  <div className="space-y-1.5 pl-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Access Fee Revenue</span>
                      <span className="font-mono font-medium text-primary">{formatUGX(totalAccessFees)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Platform Fee Revenue</span>
                      <span className="font-mono font-medium text-primary">{formatUGX(totalPlatformFees)}</span>
                    </div>
                    <div className="flex justify-between text-sm font-bold border-t border-primary/20 pt-1">
                      <span className="text-primary">Total Recognized Revenue</span>
                      <span className="font-mono text-primary">{formatUGX(totalWelileRevenue)}</span>
                    </div>
                  </div>
                  <div className="space-y-1 pt-1.5 border-t border-border/60">
                    <div className="flex justify-between text-sm text-success font-medium">
                      <span>✓ Revenue Collected</span>
                      <span className="font-mono">{formatUGX(collectedRevenue)}</span>
                    </div>
                    <div className="flex justify-between text-sm font-semibold">
                      <span className={uncollectedRevenue > 0 ? 'text-warning' : 'text-success'}>Uncollected Revenue</span>
                      <span className={`font-mono ${uncollectedRevenue > 0 ? 'text-warning' : 'text-success'}`}>{formatUGX(uncollectedRevenue)}</span>
                    </div>
                  </div>
                </div>

                {/* ══ AUTO-CHARGE STATUS ══ */}
                <div className="space-y-2">
                  <p className="text-[10px] font-semibold text-accent-foreground uppercase tracking-wider border-b border-accent/30 pb-1 flex items-center gap-1">
                    ⚡ Wallet Auto-Charge Status
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-primary/10 p-2.5 text-center">
                      <p className="text-lg font-extrabold text-primary">{activeSubscriptions}</p>
                      <p className="text-[9px] text-muted-foreground">Active Charges</p>
                    </div>
                    <div className="rounded-lg bg-success/10 p-2.5 text-center">
                      <p className="text-lg font-extrabold text-success">{completedSubscriptions}</p>
                      <p className="text-[9px] text-muted-foreground">Completed</p>
                    </div>
                    <div className="rounded-lg bg-muted/50 p-2.5 text-center">
                      <p className="text-lg font-extrabold">{fundedRequests}</p>
                      <p className="text-[9px] text-muted-foreground">Funded Tenants</p>
                    </div>
                    {noSchedule > 0 && (
                      <div className="rounded-lg bg-destructive/10 p-2.5 text-center">
                        <p className="text-lg font-extrabold text-destructive">{noSchedule}</p>
                        <p className="text-[9px] text-muted-foreground">Missing Schedule ⚠</p>
                      </div>
                    )}
                  </div>
                  {totalDebt > 0 && (
                    <div className="flex justify-between text-sm font-semibold bg-destructive/10 rounded-lg px-3 py-2">
                      <span className="text-destructive">⚠ Accumulated Debt</span>
                      <span className="font-mono text-destructive">{formatUGX(totalDebt)}</span>
                    </div>
                  )}
                </div>

                {fieldCollections > 0 && (
                  <div className="space-y-2">
                    <p className="text-[10px] font-semibold text-emerald-600 uppercase tracking-wider border-b border-emerald-500/20 pb-1 flex items-center gap-1">
                      <Receipt className="h-3 w-3" />
                      Agent Field Collections
                    </p>
                    <div className="space-y-1.5 pl-1">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Payments Recorded</span>
                        <span className="font-mono font-medium">{fieldCollectionCount} payments</span>
                      </div>
                      <div className="flex justify-between text-sm font-semibold">
                        <span className="text-emerald-600">Total Field Collections</span>
                        <span className="font-mono text-emerald-600">{formatUGX(fieldCollections)}</span>
                      </div>
                    </div>
                    <p className="text-[9px] text-muted-foreground italic">
                      Off-ledger cash collected by agents via "Record Payment" — not yet reconciled with receivables
                    </p>
                  </div>
                )}

                {/* SECTION: Expected Collections */}
                <div className="space-y-2">
                  <p className="text-[10px] font-semibold text-primary uppercase tracking-wider border-b border-primary/20 pb-1">
                    Expected Collections
                  </p>
                  <div className="space-y-1.5 pl-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Per Day</span>
                      <span className="font-mono font-medium">{formatUGX(totalDaily)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Per Week</span>
                      <span className="font-mono font-medium">{formatUGX(totalWeekly)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Per Month</span>
                      <span className="font-mono font-medium">{formatUGX(totalMonthly)}</span>
                    </div>
                  </div>
                </div>

                {/* ── NET TOTAL ── */}
                <div className="space-y-1 pt-3 border-t-2 border-success/40">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium text-muted-foreground">Gross Receivable</span>
                    <span className="font-mono text-sm text-muted-foreground">{formatUGX(totalGross)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium text-muted-foreground">Wallet Collections</span>
                    <span className="font-mono text-sm text-success">-{formatUGX(totalCollected)}</span>
                  </div>
                  {fieldCollections > 0 && (
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium text-muted-foreground">Field Collections (off-ledger)</span>
                      <span className="font-mono text-sm text-emerald-600">-{formatUGX(fieldCollections)}</span>
                    </div>
                  )}
                  <div className="flex justify-between items-center pt-1 border-t border-success/20">
                    <span className="text-base font-bold text-success">Net Outstanding</span>
                    <span className={`font-mono text-lg font-extrabold ${(totalReceivable - fieldCollections) > 0 ? 'text-warning' : 'text-success'}`}>
                      {formatUGX(Math.max(0, totalReceivable - fieldCollections))}
                    </span>
                  </div>
                </div>
              </div>

              {/* ── Per-request detail list ── */}
              <div className="border-t border-border/50">
                <div className="px-4 py-2 bg-muted/30">
                  <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                    Line Items · tap to expand
                  </p>
                </div>
                <div className="divide-y divide-border/40">
                  {requests.map((req) => (
                    <div key={req.id} className="relative">
                      <RequestBreakdownRow 
                        req={req} 
                        onViewDetails={(id) => { setDetailRequestId(id); setDetailOpen(true); }}
                        isManager={mode === 'manager'}
                        onDeleteUser={mode === 'manager' ? (_userId, name, requestId) => setDeleteDialog({ requestId: requestId || '', name }) : undefined}
                      />
                      {mode === 'manager' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="absolute top-2.5 right-10 h-7 w-7"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingRequest(req);
                            setEditOpen(true);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <EditApprovedRentDialog
        request={editingRequest}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={fetchRequests}
      />

      <RentRequestDetailDrawer
        requestId={detailRequestId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />

      {/* Delete Rent Request & Ledger Entries Dialog */}
      <AlertDialog open={!!deleteDialog} onOpenChange={(open) => !open && setDeleteDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" />
              Delete Rent Request & Ledger?
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>You are about to delete <strong>{deleteDialog?.name}</strong>'s rent request and all associated ledger entries.</p>
              <p className="text-destructive font-semibold">This removes the rent request, repayments, and ledger entries linked to it. The user account will NOT be deleted. This cannot be undone.</p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 min-h-[44px] touch-manipulation"
              disabled={deleting}
              onClick={async (e) => {
                e.preventDefault();
                if (!deleteDialog?.requestId) return;
                setDeleting(true);
                try {
                  const reqId = deleteDialog.requestId;
                  const { error } = await supabase.functions.invoke('delete-rent-request', {
                    body: { rent_request_id: reqId },
                  });
                  if (error) throw error;
                  toast.success(`${deleteDialog.name}'s rent request and ledger entries deleted`);
                  setDeleteDialog(null);
                  fetchRequests();
                  window.dispatchEvent(new Event('user-deleted'));
                } catch (err: any) {
                  toast.error('Failed to delete', { description: err.message });
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
              Delete Request & Ledger
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}
