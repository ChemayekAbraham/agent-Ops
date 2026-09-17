import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { captureGps, isGpsRequiredError } from '@/lib/captureGps';
import { generateWelileAiId, getRiskTierLabel } from '@/lib/welileAiId';
import { formatUGX, calculateRequestFee } from '@/lib/rentCalculations';
import { getEffectiveRentRequestAmounts } from '@/lib/rentRequestAmounts';
import { useAgentBalances } from '@/hooks/useAgentBalances';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Loader2, ArrowLeft, Phone, Mail, MapPin, Home, User, Shield, Calendar,
  CreditCard, TrendingUp, Copy, CheckCircle2, Wallet, Banknote, History,
  UserCheck, Star, AlertTriangle, ChevronDown, ChevronUp, Navigation, Share2, Smartphone,
  MessageCircle, Pencil, Zap, Bot, RefreshCw, FileText, ExternalLink,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { toast as sonnerToast } from 'sonner';
import { useCaptureLocation } from '@/hooks/useCaptureLocation';
import { createShortLink } from '@/lib/createShortLink';
import { AgentTenantCollectDialog } from './AgentTenantCollectDialog';
import { ReverseAllocationDialog } from './ReverseAllocationDialog';
import { TenantFieldCollectDialog } from './TenantFieldCollectDialog';
import { Undo2 } from 'lucide-react';
import { shareTenantProfileWhatsApp, type TenantProfilePdfData } from '@/lib/tenantProfilePdf';
import { shareOrDownloadRepaymentSheet, openRepaymentSheetPdf, type RepaymentSheetData, type DailyScheduleRow } from '@/lib/agentRepaymentSheetPdf';
import { shareOrDownloadFloatAllocations, shareFloatAllocationsWhatsApp } from '@/lib/floatAllocationsPdf';
import {
  generateTenantRepaymentReportPdf,
  buildTenantRepaymentReportFilename,
  type TenantRepaymentPlanBlock,
} from '@/lib/tenantRepaymentReportPdf';
import { UserAvatar } from '@/components/UserAvatar';
import { EditTenantDialog } from './EditTenantDialog';
import { TenantQuickActionsSheet } from './TenantQuickActionsSheet';
import { RentAccessLimitCard } from './RentAccessLimitCard';
import RentAccessLimitActivity from './RentAccessLimitActivity';
import { TenantPaymentCalendar } from './TenantPaymentCalendar';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sparkles, ChevronRight } from 'lucide-react';
import AgentContactLocationGate from './AgentContactLocationGate';
import { useRequireContactLocation } from '@/hooks/useRequireContactLocation';
import { RenewalAgreementDialog } from './RenewalAgreementDialog';
import { TenantDocumentsSection } from './TenantDocumentsSection';
import { TenantPropertyCard } from './TenantPropertyCard';

interface TenantProfileViewProps {
  tenantId: string;
  onBack: () => void;
  autoEdit?: boolean;
}

interface TenantProfile {
  id: string;
  full_name: string;
  phone: string;
  email: string;
  created_at: string;
  monthly_rent: number | null;
  verified: boolean;
  national_id: string | null;
  avatar_url: string | null;
  tenant_status?: string | null;
  previous_full_name?: string | null;
}

interface RentRequestRow {
  id: string;
  rent_amount: number;
  total_repayment: number;
  amount_repaid: number;
  status: string | null;
  created_at: string;
  disbursed_at: string | null;
  duration_days: number;
  daily_repayment: number;
  landlord_id?: string | null;
  lc1_id?: string | null;
  registration_type?: string | null;
  initial_outstanding_balance?: number | null;
  outstanding_grace_days?: number | null;
  house_category?: string | null;
  tenant_no_smartphone?: boolean | null;
  request_latitude?: number | null;
  request_longitude?: number | null;
  landlord?: {
    name: string;
    property_address: string;
    house_category?: string;
    phone?: string | null;
    village?: string | null;
    sub_county?: string | null;
    district?: string | null;
  } | null;
  lc1?: { name?: string | null; phone?: string | null; village?: string | null; verified?: boolean | null } | null;
}

interface RepaymentRow {
  id: string;
  amount: number;
  created_at: string;
  rent_request_id: string;
}

interface WalletData {
  balance: number;
  total_in: number;
  total_out: number;
}

const PAGE_SIZE = 5;
/** Rows pulled per database page for the repayment/collection history. */
const REPAY_FETCH_SIZE = 200;
/** Rows revealed per "Load more" click in the flat repayment history. */
const REPAY_VISIBLE_STEP = 20;

/* ---------- Small presentational helpers (local, no new files) ---------- */

function SectionCard({
  icon: Icon,
  title,
  badge,
  tone = 'neutral',
  children,
}: {
  icon: any;
  title: string;
  badge?: React.ReactNode;
  tone?: 'neutral' | 'primary' | 'destructive' | 'success';
  children: React.ReactNode;
}) {
  const toneRing =
    tone === 'primary' ? 'border-primary/30'
    : tone === 'destructive' ? 'border-destructive/30'
    : tone === 'success' ? 'border-success/30'
    : 'border-border/60';
  const toneIcon =
    tone === 'primary' ? 'text-primary'
    : tone === 'destructive' ? 'text-destructive'
    : tone === 'success' ? 'text-success'
    : 'text-muted-foreground';
  return (
    <section className={`rounded-2xl border ${toneRing} bg-card p-4 sm:p-5 space-y-4`}>
      <header className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-bold text-foreground">
          <Icon className={`h-5 w-5 ${toneIcon}`} aria-hidden="true" />
          {title}
        </h3>
        {badge}
      </header>
      {children}
    </section>
  );
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'default' | 'success' | 'destructive' | 'primary' | 'warning';
}) {
  const valueTone =
    tone === 'success' ? 'text-success'
    : tone === 'destructive' ? 'text-destructive'
    : tone === 'primary' ? 'text-primary'
    : tone === 'warning' ? 'text-warning'
    : 'text-foreground';
  return (
    <div className="bg-muted/40 rounded-xl p-3 text-center">
      <p className="text-[11px] sm:text-xs text-muted-foreground uppercase tracking-wider font-medium">{label}</p>
      <p className={`text-base sm:text-lg font-bold font-mono mt-1 ${valueTone}`}>{value}</p>
    </div>
  );
}

/* ---------- Main component ---------- */

export function TenantProfileView({ tenantId, onBack, autoEdit }: TenantProfileViewProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const { floatBalance: agentFloatBalance, isLoading: floatLoading, error: floatError, refetch: refetchFloat } = useAgentBalances(user?.id);
  // Agent Field Mandate — tenant location capture banner + gate.
  const tenantLoc = useRequireContactLocation(tenantId, 'tenant');
  const [profile, setProfile] = useState<TenantProfile | null>(null);
  const [requests, setRequests] = useState<RentRequestRow[]>([]);
  const [repayments, setRepayments] = useState<RepaymentRow[]>([]);
  // Every field/wallet collection recorded for this tenant. Needed because many
  // payments only ever land in `agent_collections` (no `repayments` row), and the
  // self-repayment tag lives on the collection row.
  const [tenantCollections, setTenantCollections] = useState<
    { id: string; amount: number; created_at: string; rent_request_id: string | null; payment_method: string | null; notes: string | null }[]
  >([]);
  const [walletData, setWalletData] = useState<WalletData | null>(null);
  const [floatAllocations, setFloatAllocations] = useState<
    { date: string; amount: number; status: 'active' | 'reversed'; reason: string | null }[]
  >([]);
  // Float-allocation viewer filters (date range + status).
  const [allocFrom, setAllocFrom] = useState<string>('');
  const [allocTo, setAllocTo] = useState<string>('');
  const [allocStatus, setAllocStatus] = useState<'all' | 'active' | 'reversed'>('all');
  const [allocCaption, setAllocCaption] = useState<string>('');
  const [downloadingAllocPdf, setDownloadingAllocPdf] = useState(false);
  const [sharingAllocWa, setSharingAllocWa] = useState(false);
  const [showAllAllocations, setShowAllAllocations] = useState(false);

  const [partnershipAmount, setPartnershipAmount] = useState(0);
  const [loading, setLoading] = useState(true);
  // GPS persistence state (the reading is saved server-side, not just held in React).
  const [savingGps, setSavingGps] = useState(false);
  const [gpsSavedAt, setGpsSavedAt] = useState<string | null>(null);
  // Secondary (financial history) datasets stream in after the sheet paints.
  const [secondaryLoading, setSecondaryLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  
  const [showAllRequests, setShowAllRequests] = useState(false);
  /** Per-plan "load more" counters for the in-plan repayment history (10 per load). */
  const [planRepayVisible, setPlanRepayVisible] = useState<Record<string, number>>({});
  const [exportingRepayReport, setExportingRepayReport] = useState(false);
  /**
   * Flat repayment history paging.
   * The first burst pulls `REPAY_FETCH_SIZE` rows (newest first); "Load more"
   * reveals another `REPAY_VISIBLE_STEP` rows and, when the local cache runs
   * out, pulls the next page straight from the database so long histories are
   * never silently truncated.
   */
  const [repayVisible, setRepayVisible] = useState(REPAY_VISIBLE_STEP);
  const [repayHasMoreServer, setRepayHasMoreServer] = useState(false);
  const [loadingMoreRepayments, setLoadingMoreRepayments] = useState(false);


  const [collectDialogOpen, setCollectDialogOpen] = useState(false);

  const { location: gpsLocation, loading: gpsLoading, error: gpsError, captureLocation } = useCaptureLocation();

  const [sharingLink, setSharingLink] = useState(false);
  const [sharingProfile, setSharingProfile] = useState(false);
  const [generatingSheet, setGeneratingSheet] = useState(false);
  const [openingSheet, setOpeningSheet] = useState(false);
  const [sheetRangeOpen, setSheetRangeOpen] = useState(false);
  const [sheetFrom, setSheetFrom] = useState<string>('');
  const [sheetTo, setSheetTo] = useState<string>('');
  const [sheetConfirm, setSheetConfirm] = useState(false);
  const [sheetStatusFilter, setSheetStatusFilter] = useState<DailyScheduleRow['status'][]>([
    'allocated',
    'partial',
    'missed',
    'extra',
  ]);

  const [userRoles, setUserRoles] = useState<string[]>([]);

  const [fieldCollectOpen, setFieldCollectOpen] = useState(false);

  const [autoCollecting, setAutoCollecting] = useState(false);
  const [reopening, setReopening] = useState(false);

  const [editDialogOpen, setEditDialogOpen] = useState(false);

  const [lastAllocation, setLastAllocation] = useState<{ id: string; amount: number; created_at: string } | null>(null);
  const [reverseDialogOpen, setReverseDialogOpen] = useState(false);
  const [rentLimitOpen, setRentLimitOpen] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [renewalAgreementOpen, setRenewalAgreementOpen] = useState(false);
  const [historyRange, setHistoryRange] = useState<'all' | '7d' | '30d' | 'month' | 'custom'>('all');
  const [historyFrom, setHistoryFrom] = useState<string>('');
  const [historyTo, setHistoryTo] = useState<string>('');

  // One round trip powers BOTH the full allocation log and the "reverse last"
  // action — no separate query for the latest reversible row.
  const loadAllocations = async () => {
    if (!user?.id) return;
    const { data } = await supabase
      .from('agent_collections')
      .select('id, amount, created_at, notes').is('reversed_at', null)
      .eq('agent_id', user.id)
      .eq('tenant_id', tenantId)
      .ilike('notes', '%float allocation%')
      .order('created_at', { ascending: true })
      .limit(400);
    const rows = (data || []) as any[];
    setFloatAllocations(
      rows.map((r: any) => {
        const notes = String(r.notes || '');
        const isReversed = notes.toLowerCase().includes('[reversed');
        const reasonMatch = notes.match(/\[reversed[:\s-]*([^\]]*)\]/i);
        return {
          date: r.created_at,
          amount: Number(r.amount) || 0,
          status: (isReversed ? 'reversed' : 'active') as 'active' | 'reversed',
          reason: reasonMatch ? (reasonMatch[1].trim() || null) : null,
        };
      }),
    );
    const reversible = [...rows].reverse().find((r: any) => !(r.notes || '').toLowerCase().includes('[reversed'));
    setLastAllocation(reversible ? { id: reversible.id, amount: Number(reversible.amount), created_at: reversible.created_at } : null);
  };

  // Back-compat alias — post-action refreshes call this.
  const loadLastAllocation = loadAllocations;

  /**
   * All collections recorded against this tenant (any agent, any channel).
   * Reversed allocations are dropped so a cancelled entry never shows as paid.
   */
  const loadTenantCollections = async () => {
    const { data } = await supabase
      .from('agent_collections')
      .select('id, amount, created_at, rent_request_id, payment_method, notes').is('reversed_at', null)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(500);
    const rows = ((data || []) as any[]).filter(
      (r) => !String(r.notes || '').toLowerCase().includes('[reversed'),
    );
    setTenantCollections(
      rows.map((r) => ({
        id: String(r.id),
        amount: Number(r.amount) || 0,
        created_at: r.created_at,
        rent_request_id: r.rent_request_id ? String(r.rent_request_id) : null,
        payment_method: r.payment_method ?? null,
        notes: r.notes ?? null,
      })),
    );
  };


  const aiId = generateWelileAiId(tenantId);
  const navigate = useNavigate();

  useEffect(() => {
    // Header/identity first (single RPC), everything else streams in behind it.
    loadFullProfile();
    refetchFloat();
  }, [tenantId, user?.id]);

  // When opened in "edit" mode (e.g. the prominent Edit button on a tenant
  // card), pop the edit dialog as soon as the profile has loaded.
  useEffect(() => {
    if (autoEdit && profile && !loading) {
      setEditDialogOpen(true);
    }
  }, [autoEdit, profile, loading]);

  const responseOrNull = (result: PromiseSettledResult<any>, label: string) => {
    if (result.status === 'rejected') {
      console.warn(`[TenantProfileView] ${label} request failed`, result.reason);
      return null;
    }
    if (result.value?.error) {
      console.warn(`[TenantProfileView] ${label} returned an error`, result.value.error);
    }
    return result.value;
  };

  /**
   * Stage 1 — the identity RPC only. As soon as it resolves the sheet paints
   * (header, AI ID, contacts, roles), so the agent never stares at a spinner
   * while financial history is still in flight.
   */
  const loadFullProfile = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const [profileRes] = (await Promise.allSettled([
        supabase.rpc('get_agent_tenant_profile', { p_tenant_id: tenantId }),
      ])).map((r, i) => responseOrNull(r, ['profile'][i]));
      const profileRow = Array.isArray(profileRes?.data) ? profileRes.data[0] : profileRes?.data;
      setProfile(profileRow ? (profileRow as unknown as TenantProfile) : null);
    } catch (err) {
      console.error('Failed to load tenant profile:', err);
    } finally {
      if (!opts?.silent) setLoading(false);
      // Fire-and-forget: secondary data hydrates the sections in place.
      void loadSecondary();
    }
  };

  /**
   * Stage 2 — every dependent dataset in a single parallel burst (no
   * sequential follow-ups, no N+1). Sections render skeleton/empty until it
   * lands, then fill in.
   */
  const loadSecondary = async () => {
    setSecondaryLoading(true);
    try {
      const settled = await Promise.allSettled([
        supabase
          .from('rent_requests')
          .select('id, rent_amount, total_repayment, amount_repaid, status, created_at, disbursed_at, funded_at, repayment_starts_on, duration_days, daily_repayment, registration_type, initial_outstanding_balance, outstanding_grace_days, landlord_id, lc1_id, house_category, tenant_no_smartphone, request_latitude, request_longitude, landlord:landlords(name, property_address, house_category, phone, village, sub_county, district), lc1:lc1_chairpersons(name, phone, village, verified)')
          .eq('tenant_id', tenantId)
          .order('created_at', { ascending: false }),
        supabase
          .from('repayments')
          .select('id, amount, created_at, rent_request_id')
          .eq('tenant_id', tenantId)
          .order('created_at', { ascending: false })
          .limit(REPAY_FETCH_SIZE + 1),
        supabase
          .from('wallets')
          .select('balance')
          .eq('user_id', tenantId)
          .maybeSingle(),
        supabase
          .from('investor_portfolios')
          .select('investment_amount')
          .eq('investor_id', tenantId)
          .in('status', ['active', 'pending', 'pending_approval']),
        supabase
          .from('general_ledger')
          .select('amount, direction')
          .eq('user_id', tenantId)
          .eq('ledger_scope', 'wallet')
          .limit(200),
        supabase
          .from('user_roles')
          .select('role, enabled')
          .eq('user_id', tenantId),
        // Allocations run inside the same burst instead of after it.
        user?.id ? loadAllocations() : Promise.resolve(null),
        loadTenantCollections(),
        // Landlord float allocations for this tenant — a row with money still
        // remaining means the landlord has NOT been paid yet, so collection
        // must stay closed even when the request status says repaying.
        supabase
          .from('agent_landlord_float_allocations')
          .select('rent_request_id, remaining_amount')
          .eq('tenant_id', tenantId),
      ]);

      const [rentRes, repaymentRes, walletRes, portfolioRes, ledgerRes, rolesRes, , , landlordAllocRes] = settled.map((result, idx) =>
        responseOrNull(result, ['rent requests', 'repayments', 'wallet', 'portfolio', 'ledger', 'roles', 'allocations', 'collections', 'landlord allocations'][idx]),
      );

      const unpaidLandlordIds = new Set<string>(
        ((landlordAllocRes?.data || []) as { rent_request_id: string | null; remaining_amount: number | null }[])
          .filter(a => a.rent_request_id && Number(a.remaining_amount || 0) > 0)
          .map(a => a.rent_request_id as string),
      );
      setLandlordUnpaidRequestIds(unpaidLandlordIds);

      setRequests(((rentRes?.data as unknown as RentRequestRow[]) || []).map((req) => {
        const effective = getEffectiveRentRequestAmounts(req);
        return {
          ...req,
          total_repayment: effective.totalRepayment,
          daily_repayment: effective.dailyRepayment,
        };
      }));
      const repayRows = (repaymentRes?.data as RepaymentRow[]) || [];
      setRepayHasMoreServer(repayRows.length > REPAY_FETCH_SIZE);
      setRepayments(repayRows.slice(0, REPAY_FETCH_SIZE));
      setRepayVisible(REPAY_VISIBLE_STEP);

      const ledgerEntries = (ledgerRes?.data || []) as any[];
      const totalIn = ledgerEntries.filter(e => e.direction === 'cash_in').reduce((s: number, e: any) => s + (e.amount || 0), 0);
      const totalOut = ledgerEntries.filter(e => e.direction === 'cash_out').reduce((s: number, e: any) => s + (e.amount || 0), 0);
      setWalletData({
        balance: walletRes?.data?.balance ?? 0,
        total_in: totalIn,
        total_out: totalOut,
      });

      const pAmount = (portfolioRes?.data || []).reduce((s: number, p: any) => s + (p.investment_amount || 0), 0);
      setPartnershipAmount(pAmount);

      const enabledRoles = ((rolesRes?.data || []) as any[])
        .filter(r => r.enabled === null || r.enabled === true)
        .map(r => r.role as string);
      setUserRoles(enabledRoles);
    } catch (err) {
      console.error('Failed to load tenant profile details:', err);
    } finally {
      setSecondaryLoading(false);
    }
  };

  const summary = useMemo(() => {
    // Exclude soft-deleted requests from any KPI aggregations so the
    // "Rent Payment Behavior" panel reflects real activity only.
    const visible = requests.filter(r => (r.status || '') !== 'deleted_by_agent');
    // Funded/repayable requests contribute to totals; rejected/pending ones
    // that were never funded should not inflate "Total Funded".
    const fundedStatuses = new Set(['approved', 'funded', 'disbursed', 'repaying', 'completed']);
    const fundedRequests = visible.filter(r => fundedStatuses.has(r.status || ''));
    const totalFunded = fundedRequests.reduce((s, r) => s + (r.total_repayment || 0), 0);
    // Prefer the actual `repayments` ledger — it's the source of truth for
    // money the tenant has paid back. Fall back to amount_repaid if there
    // are no repayment rows fetched yet.
    const repaymentsSum = (repayments || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const amountRepaidSum = fundedRequests.reduce((s, r) => s + (r.amount_repaid || 0), 0);
    const totalRepaid = repaymentsSum > 0 ? repaymentsSum : amountRepaidSum;
    const completedCount = visible.filter(r => r.status === 'completed').length;
    const completionBase = visible.filter(r => fundedStatuses.has(r.status || '')).length;
    // A cycle only counts as "active" (i.e. blocks renewal and shows an
    // outstanding balance) when it still owes money. A funded/repaying cycle
    // that has been fully repaid — or an empty/stub cycle with a zero total —
    // is effectively paid up and must NOT keep the tenant looking unpaid or
    // block a renewal.
    const stillOwes = (r: RentRequestRow) =>
      (Number(r.total_repayment || 0) - Number(r.amount_repaid || 0)) > 0;
    // Active = standard funded/repaying cycles that still owe, OR an
    // outstanding-balance row that was rejected (still owes money, agent
    // should be able to reopen + collect).
    const activeRequest =
      requests.find(
        r => ['approved', 'funded', 'disbursed', 'repaying'].includes(r.status || '') && stillOwes(r),
      ) ||
      requests.find(
        r =>
          r.status === 'rejected' &&
          r.registration_type === 'outstanding_balance' &&
          stillOwes(r),
      );
    const outstanding = activeRequest ? (activeRequest.total_repayment - activeRequest.amount_repaid) : 0;
    const latest = visible[0] || requests[0];

    return {
      totalRequests: visible.length,
      totalFunded,
      totalRepaid,
      totalOwing: Math.max(0, totalFunded - totalRepaid),
      completionRate: completionBase > 0 ? Math.round((completedCount / completionBase) * 100) : 0,
      activeRequest,
      currentOutstanding: Math.max(0, outstanding),
      latestLandlord: latest?.landlord?.name || null,
      latestLandlordPhone: latest?.landlord?.phone || null,
      latestAddress: latest?.landlord?.property_address || null,
      latestHouseType: latest?.landlord?.house_category || null,
      latestRequestId: latest?.id || null,
      latestLandlordRow: latest?.landlord || null,
      latestLc1: latest?.lc1 || null,
      latestStatus: latest?.status || null,
    };
  }, [requests, repayments]);

  const earningRating = useMemo(() => {
    if (summary.totalRequests === 0) return { stars: 0, label: 'New User' };
    const rate = summary.completionRate;
    if (rate >= 90) return { stars: 5, label: 'Excellent' };
    if (rate >= 75) return { stars: 4, label: 'Good' };
    if (rate >= 50) return { stars: 3, label: 'Average' };
    if (rate >= 25) return { stars: 2, label: 'Below Average' };
    return { stars: 1, label: 'Needs Improvement' };
  }, [summary]);

  const riskLevel = summary.completionRate >= 80 ? 'good' : summary.completionRate >= 50 ? 'standard' : summary.totalRequests === 0 ? 'new' : 'caution';
  const riskTier = getRiskTierLabel(riskLevel);

  /**
   * Auto-detect monthly rent when the profile field is empty.
   * Strategy: use the most recent rent_request.rent_amount as a strong signal —
   * it's the same number the agent already entered when issuing rent.
   * Falls back to the median across all requests if the latest one looks off.
   */
  const detectedMonthlyRent = useMemo<number | null>(() => {
    const amounts = requests
      .map(r => Number(r.rent_amount) || 0)
      .filter(a => a >= 10000);
    if (amounts.length === 0) return null;
    // Most recent first (requests are loaded ordered by created_at desc)
    return amounts[0] || null;
  }, [requests]);

  const effectiveMonthlyRent =
    profile?.monthly_rent && profile.monthly_rent > 0 ? profile.monthly_rent : detectedMonthlyRent;

  const copyAiId = () => {
    navigator.clipboard.writeText(aiId);
    setCopied(true);
    toast({ title: 'AI ID copied' });
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCaptureGPS = async () => {
    const loc = await captureLocation();
    if (!loc) return;
    // Persist the reading server-side — a captured coordinate that only lives
    // in React state is worthless for payouts/collections gating.
    setSavingGps(true);
    try {
      const { error } = await supabase.rpc('agent_capture_contact_location' as any, {
        p_target_id: tenantId,
        p_target_role: 'tenant',
        p_address: {},
        p_latitude: loc.latitude,
        p_longitude: loc.longitude,
        p_accuracy: loc.accuracy ?? undefined,
      } as any);
      if (error) throw error;
      setGpsSavedAt(new Date().toISOString());
      toast({
        title: '📍 GPS saved',
        description: `Lat ${loc.latitude.toFixed(5)}, Lng ${loc.longitude.toFixed(5)} stored on ${profile?.full_name || 'this tenant'}'s profile.`,
      });
      tenantLoc.onCaptured?.();
      loadFullProfile({ silent: true });
    } catch (err: any) {
      toast({
        title: 'Could not save GPS',
        description: err?.message || 'The location was read but not stored. Try again.',
        variant: 'destructive',
      });
    } finally {
      setSavingGps(false);
    }
  };

  const handleSendDashboardLink = async () => {
    if (!user || !profile) return;
    setSharingLink(true);
    try {
      const shortUrl = await createShortLink(user.id, '/auth', { phone: profile.phone, ref: user.id });
      if (navigator.share) {
        await navigator.share({
          title: 'Welile Dashboard',
          text: `Hi ${profile.full_name}, access your Welile dashboard here:`,
          url: shortUrl,
        });
      } else {
        await navigator.clipboard.writeText(shortUrl);
        toast({ title: '🔗 Link copied', description: 'Share it via WhatsApp or SMS' });
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        toast({ title: 'Failed to share link', variant: 'destructive' });
      }
    } finally {
      setSharingLink(false);
    }
  };

  const handleShareProfile = async () => {
    if (!profile) return;
    setSharingProfile(true);
    try {
      const pdfData: TenantProfilePdfData = {
        aiId,
        fullName: profile.full_name,
        phone: profile.phone,
        email: profile.email,
        nationalId: profile.national_id,
        verified: profile.verified,
        memberSince: profile.created_at,
        monthlyRent: profile.monthly_rent,
        riskLabel: riskTier.label,
        completionRate: summary.completionRate,
        earningLabel: earningRating.label,
        earningStars: earningRating.stars,
        totalRequests: summary.totalRequests,
        totalRepaid: summary.totalRepaid,
        totalOwing: summary.totalOwing,
        currentOutstanding: summary.currentOutstanding,
        walletBalance: walletData?.balance ?? 0,
        landlordName: summary.latestLandlord,
        propertyAddress: summary.latestAddress,
        houseType: summary.latestHouseType,
        rentPlans: requests.map(r => ({
          date: r.created_at,
          rentAmount: r.rent_amount,
          totalRepayment: r.total_repayment,
          amountRepaid: r.amount_repaid,
          status: r.status || 'unknown',
        })),
        latitude: gpsLocation?.latitude,
        longitude: gpsLocation?.longitude,
      };
      await shareTenantProfileWhatsApp(pdfData);
      toast({ title: '📄 Profile shared' });
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        toast({ title: 'Failed to share profile', variant: 'destructive' });
      }
    } finally {
      setSharingProfile(false);
    }
  };

  const handleAutoCollectFromWallet = async () => {
    if (!profile || !summary.activeRequest || !walletData) return;
    if (awaitingLandlord) {
      sonnerToast.error("Landlord not paid yet", {
        description: "The landlord float is with you, but the landlord has not been paid. Collection opens once the landlord is paid.",
      });
      return;
    }
    const collectAmount = Math.min(walletData.balance, summary.currentOutstanding);
    if (collectAmount <= 0) {
      toast({ title: 'No funds available', description: 'Tenant wallet is empty', variant: 'destructive' });
      return;
    }
    setAutoCollecting(true);
    try {
      const { error } = await supabase.functions.invoke('tenant-pay-rent', {
        body: {
          tenant_id: tenantId,
          rent_request_id: summary.activeRequest.id,
          amount: collectAmount,
        },
      });
      if (error) throw error;
      toast({ title: `✅ Auto-collected ${formatUGX(collectAmount)}`, description: 'From tenant wallet' });
      loadFullProfile();
    } catch (err: any) {
      toast({ title: 'Auto-collect failed', description: err.message, variant: 'destructive' });
    } finally {
      setAutoCollecting(false);
    }
  };

  const handleReopenRejectedCycle = async () => {
    if (!summary.activeRequest || summary.activeRequest.status !== 'rejected') return;
    const reqId = summary.activeRequest.id;
    setReopening(true);
    try {
      const { error } = await supabase
        .from('rent_requests')
        .update({ status: 'repaying', rejected_reason: null })
        .eq('id', reqId);
      if (error) throw error;

      // Mandatory audit trail (10-char minimum reason).
      await supabase.from('audit_logs').insert({
        action_type: 'rent_request_reopened',
        table_name: 'rent_requests',
        record_id: reqId,
        actor_id: user?.id ?? null,
        reason: 'Agent reopened rejected outstanding-balance cycle to resume collection.',
        metadata: { previous_status: 'rejected', new_status: 'repaying', tenant_id: tenantId },
      } as any);

      toast({ title: '✅ Cycle reopened', description: 'You can now collect from your float.' });
      loadFullProfile();
    } catch (err: any) {
      toast({ title: 'Reopen failed', description: err.message, variant: 'destructive' });
    } finally {
      setReopening(false);
    }
  };

  const progressPct = summary.totalFunded > 0 ? Math.min(100, Math.round((summary.totalRepaid / summary.totalFunded) * 100)) : 0;
  // Repayment opens the day AFTER the landlord is paid — enforced in the
  // database by rent_request_default_repayment_start, which stamps
  // repayment_starts_on = funded_at + 1 day. Until then the collection RPC
  // refuses with REPAYMENT_NOT_STARTED, so showing a live Pay button sends the
  // agent to a tenant who cannot legally pay yet. Count it down instead.
  const todayEAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(new Date());
  const repaymentStartsOn: string | null =
    (summary.activeRequest as { repayment_starts_on?: string | null } | undefined)?.repayment_starts_on ?? null;
  const daysUntilStart =
    repaymentStartsOn && repaymentStartsOn > todayEAT
      ? Math.max(1, Math.round(
          (Date.parse(`${repaymentStartsOn}T00:00:00Z`) - Date.parse(`${todayEAT}T00:00:00Z`)) / 86400000))
      : 0;
  const repaymentNotStarted = daysUntilStart > 0;
  // Landlord float has been released to the agent, but the landlord has not
  // actually been paid yet — collection must stay closed until that happens.
  // Landlord not paid yet when the request is still at `approved` (float just
  // released) OR the landlord float allocation for this plan still holds money
  // (paid_out < allocated). Status alone is not enough — a plan can read
  // `repaying` while the landlord was never paid.
  const awaitingLandlord =
    summary.activeRequest?.status === 'approved' ||
    (!!summary.activeRequest && landlordUnpaidRequestIds.has(summary.activeRequest.id));

  const activePct = summary.activeRequest && summary.activeRequest.total_repayment > 0
    ? Math.min(100, Math.round((summary.activeRequest.amount_repaid / summary.activeRequest.total_repayment) * 100))
    : 0;

  // Latest fully-completed cycle (used for one-tap renew). `requests` is ordered desc by created_at.
  const lastCompletedRequest = useMemo(
    () => requests.find(r => (r.status || '').toLowerCase() === 'completed') || null,
    [requests],
  );
  const canRenew = !!lastCompletedRequest && !summary.activeRequest;

  const handleRenewCycle = async (skipAgreementPrompt = false) => {
    // Surface guard failures instead of returning silently — a no-op tap is
    // indistinguishable from a broken button to the user.
    if (renewing) return;
    if (!user?.id) {
      toast({ title: 'Please sign in', description: 'Your session expired. Sign in again to renew this rent cycle.', variant: 'destructive' });
      return;
    }
    if (!profile || !lastCompletedRequest) {
      toast({ title: 'Cannot renew', description: 'No completed rent cycle was found to re-post.', variant: 'destructive' });
      return;
    }
    const req = lastCompletedRequest;
    if (!req.landlord_id) {
      toast({ title: 'Cannot renew', description: 'Landlord info missing on prior request.', variant: 'destructive' });
      return;
    }
    if (!skipAgreementPrompt) {
      setRenewalAgreementOpen(true);
      return;
    }

    setRenewing(true);
    try {
      // Guard against a stale/expired session: an expired token makes the RPC
      // hang on a silent refresh instead of returning an error.
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData?.session) {
        throw new Error('Your session expired. Please sign in again and retry.');
      }
      // One atomic call. The RPC re-posts the prior plan server-side, bypasses
      // the daily-eligibility gate (renewals of fully-repaid tenants are exempt)
      // and lets the rent-formula trigger fill in the canonical fees. Any guard
      // failure surfaces as a real error instead of a silent no-op.
      // Never let the request hang forever — a stuck spinner reads as a broken
      // button. Time it out and tell the user what happened.
      const postRenewal = (gps?: { latitude: number; longitude: number }) => Promise.race([
        supabase.rpc('renew_rent_request' as any, {
          p_prev_request_id: req.id,
          ...(gps ? { p_latitude: gps.latitude, p_longitude: gps.longitude } : {}),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('The renewal request timed out. Check your connection and try again — the plan may still have been posted.')), 25000),
        ),
      ]) as Promise<{ data: string | null; error: any }>;

      let { data: newId, error } = await postRenewal();
      // No property GPS on record anywhere — capture it here at the house and retry once.
      if (error && isGpsRequiredError(error?.message)) {
        sonnerToast.info('Capturing the property GPS at the house…');
        const gps = await captureGps();
        ({ data: newId, error } = await postRenewal(gps));
      }
      if (error) throw error;
      if (!newId) throw new Error('The rent request could not be posted. Please try again.');
      toast({ title: 'Rent request renewed ✅', description: `Posted for ${profile.full_name}` });
      sonnerToast.success(`Rent request renewed for ${profile.full_name}`);
      loadFullProfile();
    } catch (err: any) {
      console.error('Renew failed:', err);
      const raw = err?.message || err?.error_description || err?.details || err?.hint || '';
      // Translate the most common backend guard into plain language.
      const friendly = raw.includes('DAILY_ELIGIBILITY_BLOCKED')
        ? 'Collect from your existing tenants first — you must reach 50% of your daily target before posting a new rent request.'
        : (raw || 'Something went wrong. Please try again.');
      toast({ title: 'Renew failed', description: friendly, variant: 'destructive' });
      sonnerToast.error(friendly);
    } finally {
      setRenewing(false);
    }
  };

  const visibleRepayments = repayments.slice(0, repayVisible);
  const visibleRequests = showAllRequests ? requests : requests.slice(0, PAGE_SIZE);

  /** Pull the next database page of repayments (oldest beyond what is cached). */
  const fetchNextRepaymentPage = async (): Promise<RepaymentRow[]> => {
    const { data, error } = await supabase
      .from('repayments')
      .select('id, amount, created_at, rent_request_id')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .range(repayments.length, repayments.length + REPAY_FETCH_SIZE);
    if (error) throw error;
    const rows = (data as RepaymentRow[]) || [];
    setRepayHasMoreServer(rows.length > REPAY_FETCH_SIZE);
    const page = rows.slice(0, REPAY_FETCH_SIZE);
    if (page.length) setRepayments((prev) => [...prev, ...page]);
    return page;
  };

  /** "Load more" — reveal the next batch, fetching from the server when needed. */
  const handleLoadMoreRepayments = async () => {
    if (loadingMoreRepayments) return;
    const needsServer = repayVisible >= repayments.length && repayHasMoreServer;
    if (!needsServer) {
      setRepayVisible((v) => v + REPAY_VISIBLE_STEP);
      return;
    }
    setLoadingMoreRepayments(true);
    try {
      await fetchNextRepaymentPage();
      setRepayVisible((v) => v + REPAY_VISIBLE_STEP);
    } catch (err: any) {
      toast({ title: 'Could not load more payments', description: err?.message, variant: 'destructive' });
    } finally {
      setLoadingMoreRepayments(false);
    }
  };

  /**
   * Pull every repayment row for this tenant so exports cover the full history
   * regardless of what is currently cached in state.
   */
  const fetchAllRepayments = async (): Promise<RepaymentRow[]> => {
    const all: RepaymentRow[] = [];
    for (let page = 0; page < 50; page += 1) {
      const from = page * REPAY_FETCH_SIZE;
      const { data, error } = await supabase
        .from('repayments')
        .select('id, amount, created_at, rent_request_id')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .range(from, from + REPAY_FETCH_SIZE - 1);
      if (error) throw error;
      const rows = (data as RepaymentRow[]) || [];
      all.push(...rows);
      if (rows.length < REPAY_FETCH_SIZE) break;
    }
    return all;
  };



  /**
   * Repayment history aggregated per rent plan.
   *
   * Accuracy rules:
   * - both sources count: `repayments` rows and `agent_collections` rows carrying
   *   this plan's `rent_request_id`. Many payments (field cash, wallet self-pay)
   *   only ever produce a collection row, so using `repayments` alone under-reports;
   * - when a collection and a repayment describe the same money (identical amount
   *   within a 5-minute window) they are shown once — the collection wins because
   *   it carries the channel/self-pay information;
   * - a payment is tagged "Paid by tenant" when its collection row is an in-app
   *   wallet movement or a recorded self-repayment; otherwise "Agent collected";
   * - the running balance is computed oldest-first as
   *   `total_repayment − cumulative paid`, floored at 0;
   * - anything left over on `amount_repaid` after both sources is surfaced as an
   *   "other sources" note instead of being folded into a payment row.
   */
  const buildPlanRepaymentHistory = (rows: RepaymentRow[]) => {
    const map = new Map<string, {
      rows: { id: string; date: string; amount: number; remaining: number; selfPaid: boolean }[];
      ledgerPaid: number;
      selfPaid: number;
      otherSources: number;
      remaining: number;
    }>();

    const MATCH_WINDOW_MS = 5 * 60 * 1000;
    const isSelfPaid = (c: { payment_method: string | null; notes: string | null }) =>
      (c.payment_method || '').toLowerCase() === 'in_app_wallet' ||
      /self[-\s]?repay/i.test(c.notes || '');

    for (const req of requests) {
      const totalDue = Number(req.total_repayment) || 0;

      const planCollections = tenantCollections
        .filter((c) => c.rent_request_id === req.id)
        .map((c) => ({
          id: `col-${c.id}`,
          date: c.created_at,
          amount: Number(c.amount) || 0,
          selfPaid: isSelfPaid(c),
        }));

      // Repayment rows that are NOT already represented by a collection row.
      const usedCollections = new Set<string>();
      const extraRepayments = rows
        .filter((r) => r.rent_request_id === req.id)
        .filter((r) => {
          const amount = Number(r.amount) || 0;
          const t = new Date(r.created_at).getTime();
          const twin = planCollections.find(
            (c) =>
              !usedCollections.has(c.id) &&
              c.amount === amount &&
              Math.abs(new Date(c.date).getTime() - t) <= MATCH_WINDOW_MS,
          );
          if (twin) {
            usedCollections.add(twin.id);
            return false;
          }
          return true;
        })
        .map((r) => ({
          id: `rep-${r.id}`,
          date: r.created_at,
          amount: Number(r.amount) || 0,
          // A repayment row with no matching collection is a wallet/ledger
          // movement the tenant drove themselves.
          selfPaid: true,
        }));

      const merged = [...planCollections, ...extraRepayments].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
      );

      let cumulative = 0;
      let selfPaidTotal = 0;
      const built = merged.map((r) => {
        cumulative += r.amount;
        if (r.selfPaid) selfPaidTotal += r.amount;
        return { ...r, remaining: Math.max(0, totalDue - cumulative) };
      });

      const amountRepaid = Number(req.amount_repaid) || 0;
      map.set(req.id, {
        // newest-first for display
        rows: built.reverse(),
        ledgerPaid: cumulative,
        selfPaid: selfPaidTotal,
        otherSources: Math.max(0, amountRepaid - cumulative),
        remaining: Math.max(0, totalDue - Math.max(cumulative, amountRepaid)),
      });
    }
    return map;
  };

  const planRepaymentHistory = useMemo(
    () => buildPlanRepaymentHistory(repayments),
    [requests, repayments, tenantCollections],
  );


  /** Export the full per-plan repayment history (all rows, not just loaded ones). */
  const handleExportRepaymentReport = async () => {
    if (!profile) return;
    setExportingRepayReport(true);
    try {
      // Always export against the complete server-side history.
      const allRows = await fetchAllRepayments();
      const fullHistory = buildPlanRepaymentHistory(allRows);
      const plans: TenantRepaymentPlanBlock[] = requests.map((req) => {
        const agg = fullHistory.get(req.id);
        return {
          planDate: req.created_at,
          status: req.status || 'unknown',
          rentAmount: Number(req.rent_amount) || 0,
          totalRepayment: Number(req.total_repayment) || 0,
          totalRepaid: Math.max(agg?.ledgerPaid ?? 0, Number(req.amount_repaid) || 0),
          remaining: agg?.remaining ?? Math.max(0, (Number(req.total_repayment) || 0) - (Number(req.amount_repaid) || 0)),
          landlordName: req.landlord?.name ?? null,
          propertyAddress: req.landlord?.property_address ?? null,
          rows: (agg?.rows ?? []).map((r) => ({ date: r.date, amount: r.amount, remaining: r.remaining })),
        };
      });


      const blob = await generateTenantRepaymentReportPdf({
        tenantName: profile.full_name,
        phone: profile.phone,
        aiId,
        generatedBy: (user?.user_metadata?.full_name as string) || (user?.email as string) || null,
        plans,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = buildTenantRepaymentReportFilename(profile.full_name);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast({ title: '📄 Repayment report downloaded' });
    } catch (err: any) {
      toast({ title: 'Export failed', description: err?.message, variant: 'destructive' });
    } finally {
      setExportingRepayReport(false);
    }
  };

  // Build the repayment-sheet payload (shared by the download + open actions).
  // Includes the agent's day-by-day float allocations with exact date & time.
  const buildSheetData = (opts?: { allTime?: boolean }): RepaymentSheetData | null => {
    if (!profile) return null;
    return {
      aiId,
      tenantName: profile.full_name,
      phone: profile.phone,
      agentName: (user?.user_metadata?.full_name as string) || (user?.email as string) || 'Welile Agent',
      periodFrom: opts?.allTime ? null : (sheetFrom || null),
      periodTo: opts?.allTime ? null : (sheetTo || null),
      scheduleStatusFilter: sheetStatusFilter,
      plans: requests.map((r) => ({
        date: r.created_at,
        disbursedAt: r.disbursed_at,
        durationDays: r.duration_days,
        status: r.status || 'unknown',
        registrationType: r.registration_type,
        rentAmount: r.rent_amount,
        totalRepayment: r.total_repayment,
        amountRepaid: r.amount_repaid,
        dailyRepayment: r.daily_repayment,
        initialOutstanding: r.initial_outstanding_balance,
        landlordName: r.landlord?.name ?? null,
        propertyAddress: r.landlord?.property_address ?? null,
      })),
      transactions: repayments.map((rp) => ({ date: rp.created_at, amount: rp.amount })),
      allocations: floatAllocations
        .filter((a) => a.status === 'active')
        .map((a) => ({ date: a.date, amount: a.amount })),
    };
  };

  // One-tap export: builds the all-time repayment sheet and downloads/shares it
  // immediately, with no period picker or confirm step.
  const handleQuickExportRepaymentSheet = async () => {
    const sheet = buildSheetData({ allTime: true });
    if (!sheet) return;
    setGeneratingSheet(true);
    try {
      await shareOrDownloadRepaymentSheet(sheet);
      toast({ title: '📄 Repayment sheet ready' });
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        toast({ title: 'Failed to generate sheet', description: err?.message, variant: 'destructive' });
      }
    } finally {
      setGeneratingSheet(false);
    }
  };

  const handleGenerateRepaymentSheet = async () => {
    const sheet = buildSheetData();
    if (!sheet) return;
    setGeneratingSheet(true);
    try {
      await shareOrDownloadRepaymentSheet(sheet);
      setSheetRangeOpen(false);
      toast({ title: '📄 Repayment sheet ready' });
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        toast({ title: 'Failed to generate sheet', description: err?.message, variant: 'destructive' });
      }
    } finally {
      setGeneratingSheet(false);
    }
  };

  // Open/preview the repayment sheet inline (new tab) so the agent can read the
  // full day-by-day allocation log on screen without downloading first.
  const handleOpenRepaymentSheet = async () => {
    const sheet = buildSheetData();
    if (!sheet) return;
    // Open the tab synchronously (inside the click) to dodge popup blockers,
    // then redirect it to the generated PDF once ready.
    const preopened = window.open('', '_blank');
    setOpeningSheet(true);
    try {
      await openRepaymentSheetPdf(sheet, preopened);
      setSheetRangeOpen(false);
      toast({ title: '📄 Repayment sheet opened' });
    } catch (err: any) {
      preopened?.close?.();
      toast({ title: 'Failed to open sheet', description: err?.message, variant: 'destructive' });
    } finally {
      setOpeningSheet(false);
    }
  };

  // ── Float-allocation viewer: apply date-range + status filters ──
  const filteredAllocations = useMemo(() => {
    const fromMs = allocFrom ? new Date(allocFrom).getTime() : null;
    const toMs = allocTo ? new Date(allocTo + 'T23:59:59').getTime() : null;
    return floatAllocations.filter((a) => {
      if (allocStatus !== 'all' && a.status !== allocStatus) return false;
      const ms = new Date(a.date).getTime();
      if (fromMs !== null && ms < fromMs) return false;
      if (toMs !== null && ms > toMs) return false;
      return true;
    });
  }, [floatAllocations, allocFrom, allocTo, allocStatus]);

  const allocationTotals = useMemo(() => {
    const active = filteredAllocations.filter((a) => a.status === 'active');
    const reversed = filteredAllocations.filter((a) => a.status === 'reversed');
    return {
      activeCount: active.length,
      reversedCount: reversed.length,
      activeTotal: active.reduce((s, a) => s + a.amount, 0),
      reversedTotal: reversed.reduce((s, a) => s + a.amount, 0),
    };
  }, [filteredAllocations]);

  const applyAllocPreset = (preset: 'all' | 'thisMonth' | '30d' | '90d') => {
    const today = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    if (preset === 'all') {
      setAllocFrom('');
      setAllocTo('');
      return;
    }
    if (preset === 'thisMonth') {
      setAllocFrom(iso(new Date(today.getFullYear(), today.getMonth(), 1)));
      setAllocTo(iso(today));
      return;
    }
    const days = preset === '30d' ? 30 : 90;
    const from = new Date(today);
    from.setDate(from.getDate() - days);
    setAllocFrom(iso(from));
    setAllocTo(iso(today));
  };

  const handleDownloadAllocationsPdf = async () => {
    if (!profile) return;
    setDownloadingAllocPdf(true);
    try {
      await shareOrDownloadFloatAllocations({
        aiId,
        tenantName: profile.full_name,
        phone: profile.phone,
        agentName: (user?.user_metadata?.full_name as string) || (user?.email as string) || 'Welile Agent',
        rows: filteredAllocations.map((a) => ({
          date: a.date,
          amount: a.amount,
          status: a.status,
          reason: a.reason,
        })),
        periodFrom: allocFrom || null,
        periodTo: allocTo || null,
        statusFilter: allocStatus,
        caption: allocCaption.trim() || null,
      });
      toast({ title: '📄 Float allocations PDF ready' });
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        toast({ title: 'Failed to generate PDF', description: err?.message, variant: 'destructive' });
      }
    } finally {
      setDownloadingAllocPdf(false);
    }
  };

  const handleShareAllocationsWhatsApp = async () => {
    if (!profile) return;
    setSharingAllocWa(true);
    try {
      await shareFloatAllocationsWhatsApp({
        aiId,
        tenantName: profile.full_name,
        phone: profile.phone,
        agentName: (user?.user_metadata?.full_name as string) || (user?.email as string) || 'Welile Agent',
        rows: filteredAllocations.map((a) => ({
          date: a.date,
          amount: a.amount,
          status: a.status,
          reason: a.reason,
        })),
        periodFrom: allocFrom || null,
        periodTo: allocTo || null,
        statusFilter: allocStatus,
        caption: allocCaption.trim() || null,
      });
      toast({ title: '📲 Ready to send on WhatsApp' });
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        toast({ title: 'Failed to share PDF', description: err?.message, variant: 'destructive' });
      }
    } finally {
      setSharingAllocWa(false);
    }
  };

  // Quick presets for the repayment-sheet reporting window.
  const applySheetPreset = (preset: 'all' | 'thisMonth' | '30d' | '90d') => {
    const today = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    if (preset === 'all') {
      setSheetFrom('');
      setSheetTo('');
      return;
    }
    if (preset === 'thisMonth') {
      setSheetFrom(iso(new Date(today.getFullYear(), today.getMonth(), 1)));
      setSheetTo(iso(today));
      return;
    }
    const days = preset === '30d' ? 30 : 90;
    const from = new Date(today);
    from.setDate(from.getDate() - days);
    setSheetFrom(iso(from));
    setSheetTo(iso(today));
  };

  // Live preview of what the repayment sheet will contain for the chosen window.
  const sheetPreview = useMemo(() => {
    let totalRentToLandlord = 0, totalAccess = 0, totalReg = 0, totalDue = 0, totalRepaid = 0, totalOutstanding = 0;
    for (const r of requests) {
      const isOB = r.registration_type === 'outstanding_balance';
      if (isOB) {
        const due = Number(r.initial_outstanding_balance ?? r.total_repayment ?? 0);
        totalRentToLandlord += due;
        totalDue += due;
        totalRepaid += Number(r.amount_repaid || 0);
        totalOutstanding += Math.max(0, due - Number(r.amount_repaid || 0));
      } else {
        const rent = Number(r.rent_amount || 0);
        const reg = calculateRequestFee(rent);
        const due = Number(r.total_repayment || 0);
        const access = Math.max(0, due - rent - reg);
        totalRentToLandlord += rent;
        totalReg += reg;
        totalAccess += access;
        totalDue += due;
        totalRepaid += Number(r.amount_repaid || 0);
        totalOutstanding += Math.max(0, due - Number(r.amount_repaid || 0));
      }
    }

    const fromMs = sheetFrom ? new Date(sheetFrom).getTime() : null;
    const toMs = sheetTo ? new Date(sheetTo + 'T23:59:59').getTime() : null;
    const periodTxns = repayments.filter((rp) => {
      const ms = new Date(rp.created_at).getTime();
      if (fromMs !== null && ms < fromMs) return false;
      if (toMs !== null && ms > toMs) return false;
      return true;
    });
    const collectedInPeriod = periodTxns.reduce((s, t) => s + Number(t.amount || 0), 0);

    return {
      isAllTime: !sheetFrom && !sheetTo,
      totalRentToLandlord,
      totalAccess,
      totalReg,
      totalDue,
      totalRepaid,
      totalOutstanding,
      collectionRate: totalDue > 0 ? Math.round((totalRepaid / totalDue) * 100) : 0,
      periodCount: periodTxns.length,
      collectedInPeriod,
    };
  }, [requests, repayments, sheetFrom, sheetTo]);


  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="p-4">
        <Button variant="ghost" size="lg" onClick={onBack} className="mb-4 gap-2 text-base">
          <ArrowLeft className="h-5 w-5" /> Back
        </Button>
        <p className="text-base text-muted-foreground text-center">Profile not found</p>
      </div>
    );
  }

  const phoneIntl = (profile.phone ?? '').replace(/^0/, '256').replace(/[^0-9]/g, '');

  return (
    <div className="flex flex-col h-full bg-muted/20">
      {/* ── Sticky compact header (back + name + share/edit) ── */}
      <div className="sticky top-0 z-20 bg-background/95 backdrop-blur-md border-b border-border/50 px-3 sm:px-4 py-2.5 flex items-center gap-2">
        <Button
          variant="ghost"
          onClick={onBack}
          className="h-11 px-3 rounded-xl shrink-0 gap-1.5 text-base font-semibold hover:bg-primary/10"
          aria-label="Back to tenants list"
          title="Back to tenants list"
        >
          <ArrowLeft className="h-5 w-5" />
          <span className="inline">Tenants</span>
        </Button>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-base sm:text-lg leading-tight truncate">{profile.full_name}</p>
          <p className="text-xs text-muted-foreground">Tenant Profile</p>
        </div>
        <Button
          variant="outline"
          onClick={() => setEditDialogOpen(true)}
          className="h-11 px-3 rounded-xl shrink-0 gap-1.5 font-semibold border-primary/40 text-primary hover:bg-primary/10"
          aria-label="Edit tenant details"
          title="Edit tenant details"
        >
          <Pencil className="h-4 w-4" />
          <span className="text-sm">Edit</span>
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={handleShareProfile}
          disabled={sharingProfile}
          className="h-11 w-11 rounded-xl shrink-0"
          aria-label="Share profile"
          title="Share profile"
        >
          {sharingProfile ? <Loader2 className="h-5 w-5 animate-spin" /> : <Share2 className="h-5 w-5" />}
        </Button>
      </div>

      {secondaryLoading && (
        <div className="px-3 sm:px-4 pt-2">
          <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading rent history, wallet & allocations…
          </div>
        </div>
      )}

      <EditTenantDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        tenant={{
          id: profile.id,
          full_name: profile.full_name,
          phone: profile.phone,
          email: profile.email,
          national_id: profile.national_id,
          tenant_status: profile.tenant_status,
        }}
        onSaved={(updated) => {
          setProfile(prev => prev ? { ...prev, ...updated } : prev);
          loadFullProfile({ silent: true });
        }}
      />

      {tenantLoc.needsCapture && (
        <div className="px-3 sm:px-4 pt-3">
          <button
            type="button"
            onClick={tenantLoc.openGate}
            className="w-full rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-left flex items-center gap-2"
          >
            <span className="text-warning text-sm font-semibold flex-1">
              📍 Capture this tenant's location — required before payouts/collections
            </span>
            <span className="text-xs text-warning font-bold">Tap</span>
          </button>
        </div>
      )}
      <AgentContactLocationGate
        open={tenantLoc.gateOpen}
        targetId={tenantId}
        targetRole="tenant"
        targetName={profile.full_name}
        blocking={false}
        onComplete={tenantLoc.onCaptured}
        onCancel={tenantLoc.closeGate}
      />

      <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 space-y-4 max-w-2xl mx-auto w-full">

        {/* ── Hero: identity + AI ID + risk ── */}
        <section className="rounded-2xl bg-gradient-to-br from-primary/10 via-card to-card border border-primary/20 p-4 sm:p-5">
          <div className="flex items-center gap-3 sm:gap-4">
            <UserAvatar avatarUrl={profile.avatar_url} fullName={profile.full_name} size="lg" />
            <div className="min-w-0 flex-1">
              {profile.previous_full_name && profile.previous_full_name !== profile.full_name ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="group flex items-center gap-1.5 text-left max-w-full"
                    >
                      <h2 className="text-lg sm:text-xl font-bold leading-tight truncate underline decoration-dotted decoration-primary/50 underline-offset-4">
                        {profile.full_name}
                      </h2>
                      <History className="h-3.5 w-3.5 shrink-0 text-primary/70 group-hover:text-primary" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-64 p-3 space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Name history
                    </p>
                    <div>
                      <p className="text-[11px] text-muted-foreground">Previous name</p>
                      <p className="text-sm line-through text-muted-foreground">{profile.previous_full_name}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-muted-foreground">Current name</p>
                      <p className="text-sm font-semibold">{profile.full_name}</p>
                    </div>
                  </PopoverContent>
                </Popover>
              ) : (
                <h2 className="text-lg sm:text-xl font-bold leading-tight truncate">{profile.full_name}</h2>
              )}
              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                {profile.verified ? (
                  <Badge className="bg-success/15 text-success border-0 text-xs">✓ Verified</Badge>
                ) : (
                  <Badge className="bg-warning/15 text-warning border-0 text-xs">⏳ Unverified</Badge>
                )}
                <Badge variant="outline" className="text-xs">
                  <Shield className={`h-3 w-3 mr-1 ${riskTier.color}`} />
                  <span className={riskTier.color}>{riskTier.label}</span>
                </Badge>
                {summary.totalRequests > 0 && (
                  <Badge variant="outline" className="text-xs">{summary.completionRate}% completion</Badge>
                )}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => navigate(`/profile/${aiId}`)}
            className="mt-4 w-full text-left rounded-xl bg-background/70 border border-primary/20 hover:border-primary/40 active:scale-[0.99] transition-all p-3 sm:p-4 flex items-center justify-between gap-3"
            aria-label={`Open Welile AI ID ${aiId}`}
          >
            <div className="min-w-0">
              <p className="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">Welile AI ID</p>
              <p className="text-xl sm:text-2xl font-black font-mono tracking-wider text-primary truncate">{aiId}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); copyAiId(); }}
                className="h-11 w-11 rounded-xl bg-primary/10 hover:bg-primary/15 flex items-center justify-center active:scale-90 transition-transform"
                aria-label="Copy AI ID"
                title="Copy AI ID"
              >
                {copied ? <CheckCircle2 className="h-5 w-5 text-success" /> : <Copy className="h-5 w-5 text-primary" />}
              </button>
              <span className="text-xs text-primary font-semibold pr-1 hidden sm:inline">View →</span>
            </div>
          </button>
        </section>

        {/* ── Rent Access Limit CTA (prominent, minimalist) ── */}
        <button
          type="button"
          onClick={() => setRentLimitOpen(true)}
          className="group relative w-full overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-r from-primary/10 via-primary/5 to-background p-4 sm:p-5 text-left active:scale-[0.99] transition-all hover:border-primary/50 shadow-sm"
          aria-label="View tenant's Rent Access Limit"
        >
          <div className="absolute -top-8 -right-8 h-24 w-24 rounded-full bg-primary/15 blur-2xl pointer-events-none" />
          <div className="relative flex items-center gap-3">
            <div className="h-12 w-12 shrink-0 rounded-xl bg-primary/15 flex items-center justify-center">
              <Sparkles className="h-6 w-6 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase tracking-widest text-primary/80">
                Powered by Welile
              </p>
              <p className="text-base sm:text-lg font-bold leading-tight text-foreground">
                Your Rent Access Limit
              </p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                Tap to see how much rent {profile.full_name.split(' ')[0]} can access today
              </p>
            </div>
            <ChevronRight className="h-5 w-5 text-primary shrink-0 group-hover:translate-x-0.5 transition-transform" />
          </div>
        </button>

        {/* ── Rent Collection (consolidated; replaces both old collection cards) ── */}
        {summary.activeRequest && summary.currentOutstanding > 0 && (
          <SectionCard
            icon={Banknote}
            title="Rent Collection"
            tone="primary"
            badge={
              <Badge variant="destructive" className="text-sm font-mono">
                {formatUGX(summary.currentOutstanding)}
              </Badge>
            }
          >
            {/* Paid / Remaining / Target — matches Manager tenant card layout.
                Target = principal + 33%/30 access fee + registration fee
                (already encoded in rent_requests.total_repayment). */}
            {summary.activeRequest.status === 'rejected' && (
              <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 sm:p-4 flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-warning">This rent cycle was rejected</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    The tenant still owes <strong className="font-mono">{formatUGX(summary.currentOutstanding)}</strong>.
                    Reopen the cycle to collect from your float and earn 10% commission.
                  </p>
                  <Button
                    onClick={handleReopenRejectedCycle}
                    disabled={reopening}
                    variant="warning"
                    size="sm"
                    className="mt-2.5 gap-1.5"
                  >
                    {reopening ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
                    {reopening ? 'Reopening…' : 'Reopen cycle to collect'}
                  </Button>
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div className="rounded-xl border border-success/30 bg-success/10 p-3 text-center">
                <p className="text-[11px] uppercase tracking-wider text-success/80 font-semibold">Paid</p>
                <p className="text-base sm:text-lg font-bold font-mono text-success mt-0.5 tabular-nums">
                  {formatUGX(summary.activeRequest.amount_repaid)}
                </p>
              </div>
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-center">
                <p className="text-[11px] uppercase tracking-wider text-destructive/80 font-semibold">Remaining</p>
                <p className="text-base sm:text-lg font-bold font-mono text-destructive mt-0.5 tabular-nums">
                  {formatUGX(summary.currentOutstanding)}
                </p>
              </div>
              <div className="rounded-xl border border-primary/30 bg-primary/10 p-3 text-center">
                <p className="text-[11px] uppercase tracking-wider text-primary/80 font-semibold">Target</p>
                <p className="text-base sm:text-lg font-bold font-mono text-primary mt-0.5 tabular-nums">
                  {formatUGX(summary.activeRequest.total_repayment)}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">incl. fees</p>
              </div>
            </div>

            {/* Ops float context (kept for collection action) */}
            <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-xs">
              <span className="text-muted-foreground">Your Ops Float</span>
              <span className="font-bold font-mono tabular-nums text-success">
                {floatLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin inline" /> : formatUGX(agentFloatBalance)}
              </span>
            </div>

            {/* Progress */}
            <div>
              <div className="flex justify-between text-xs sm:text-sm text-muted-foreground mb-1.5">
                <span>Repayment progress</span>
                <span className="font-bold text-foreground">{activePct}%</span>
              </div>
              <div className="h-3 rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={activePct} aria-valuemin={0} aria-valuemax={100}>
                <div
                  className={`h-full rounded-full transition-all ${activePct >= 100 ? 'bg-success' : activePct >= 50 ? 'bg-primary' : 'bg-destructive'}`}
                  style={{ width: `${activePct}%` }}
                />
              </div>
            </div>

            {/* Payment history — each cash-in with running Paid / Remaining */}
            {(() => {
              const target = summary.activeRequest!.total_repayment;
              const cycleRepayments = repayments
                .filter(r => r.rent_request_id === summary.activeRequest!.id)
                .slice()
                .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

              // Broaden to match the progress bar: include payments that updated
              // amount_repaid directly (e.g. agent float allocation, supporter
              // top-ups, system adjustments) but never wrote a `repayments` row.
              const repaymentsSum = cycleRepayments.reduce((s, r) => s + (r.amount || 0), 0);
              const amountRepaid = Number(summary.activeRequest!.amount_repaid || 0);
              const otherSourcesAmount = Math.max(0, amountRepaid - repaymentsSum);
              const allCycleRepayments: Array<{ id: string; amount: number; created_at: string; source?: 'repayment' | 'other' }> = [
                ...(otherSourcesAmount > 0
                  ? [{
                      id: `other-${summary.activeRequest!.id}`,
                      amount: otherSourcesAmount,
                      created_at: (summary.activeRequest as any).disbursed_at || summary.activeRequest!.created_at,
                      source: 'other' as const,
                    }]
                  : []),
                ...cycleRepayments.map(r => ({ id: r.id, amount: r.amount || 0, created_at: r.created_at, source: 'repayment' as const })),
              ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

              // Determine date window
              const now = new Date();
              let fromTs: number | null = null;
              let toTs: number | null = null;
              if (historyRange === '7d') {
                fromTs = now.getTime() - 7 * 86400000;
              } else if (historyRange === '30d') {
                fromTs = now.getTime() - 30 * 86400000;
              } else if (historyRange === 'month') {
                fromTs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
              } else if (historyRange === 'custom') {
                if (historyFrom) fromTs = new Date(historyFrom).getTime();
                if (historyTo) toTs = new Date(historyTo).getTime() + 86399000; // include end day
              }

              // Compute running totals on full history, then filter view by date
              let running = 0;
              const allRows = allCycleRepayments.map(r => {
                running += r.amount || 0;
                return {
                  id: r.id,
                  amount: r.amount || 0,
                  date: r.created_at,
                  paid: running,
                  remaining: Math.max(0, target - running),
                  source: r.source,
                };
              });
              const filteredRows = allRows.filter(row => {
                const t = new Date(row.date).getTime();
                if (fromTs !== null && t < fromTs) return false;
                if (toTs !== null && t > toTs) return false;
                return true;
              });
              const periodTotal = filteredRows.reduce((s, r) => s + r.amount, 0);
              const rows = filteredRows.slice().reverse(); // newest first

              const rangeChips: { key: typeof historyRange; label: string }[] = [
                { key: 'all', label: 'All' },
                { key: '7d', label: '7d' },
                { key: '30d', label: '30d' },
                { key: 'month', label: 'This month' },
                { key: 'custom', label: 'Custom' },
              ];

              if (allCycleRepayments.length === 0) {
                return (
                  <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-3 text-center text-xs text-muted-foreground">
                    No payments collected yet for this cycle.
                  </div>
                );
              }
              return (
                <div className="rounded-xl border border-border/60 overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 bg-muted/40">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Payment History
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {filteredRows.length} of {allCycleRepayments.length} · {formatUGX(periodTotal)}
                    </p>
                  </div>
                  {/* Date range filter */}
                  <div className="px-3 py-2 bg-muted/20 border-b border-border/60 space-y-2">
                    <div className="flex flex-wrap gap-1">
                      {rangeChips.map(chip => (
                        <button
                          key={chip.key}
                          type="button"
                          onClick={() => setHistoryRange(chip.key)}
                          className={`px-2 py-1 rounded-md text-[10px] font-medium border transition-colors ${
                            historyRange === chip.key
                              ? 'bg-primary text-primary-foreground border-primary'
                              : 'bg-background text-muted-foreground border-border/60 hover:bg-muted'
                          }`}
                        >
                          {chip.label}
                        </button>
                      ))}
                    </div>
                    {historyRange === 'custom' && (
                      <div className="flex items-center gap-2">
                        <input
                          type="date"
                          value={historyFrom}
                          onChange={(e) => setHistoryFrom(e.target.value)}
                          className="flex-1 text-[11px] px-2 py-1 rounded-md border border-border/60 bg-background"
                        />
                        <span className="text-[10px] text-muted-foreground">to</span>
                        <input
                          type="date"
                          value={historyTo}
                          onChange={(e) => setHistoryTo(e.target.value)}
                          className="flex-1 text-[11px] px-2 py-1 rounded-md border border-border/60 bg-background"
                        />
                      </div>
                    )}
                  </div>
                  <div className="divide-y divide-border/60 max-h-64 overflow-y-auto">
                    {rows.length === 0 && (
                      <div className="px-3 py-3 text-center text-xs text-muted-foreground">
                        No payments in this period.
                      </div>
                    )}
                    {rows.map(row => (
                      <div key={row.id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-sm font-bold font-mono tabular-nums text-success">
                            +{formatUGX(row.amount)}
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {row.source === 'other'
                              ? 'Funded by float / other channels'
                              : format(new Date(row.date), 'MMM d, yyyy · HH:mm')}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Paid / Remaining</p>
                          <p className="text-xs font-mono tabular-nums">
                            <span className="text-success font-semibold">{formatUGX(row.paid)}</span>
                            <span className="text-muted-foreground"> / </span>
                            <span className="text-destructive font-semibold">{formatUGX(row.remaining)}</span>
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Float warnings */}
            {!floatLoading && floatError && (
              <div className="flex items-center gap-2 bg-warning/10 border border-warning/30 rounded-xl p-3">
                <AlertTriangle className="h-5 w-5 text-warning shrink-0" />
                <div className="flex-1">
                  <p className="text-sm text-warning font-semibold">Couldn't load your Wallet Float.</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => refetchFloat()} className="shrink-0 text-xs h-9">
                  Retry
                </Button>
              </div>
            )}

            {!floatLoading && !floatError && agentFloatBalance < 500 && (
              <div className="flex items-center gap-2 bg-destructive/10 border border-destructive/30 rounded-xl p-3">
                <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
                <p className="text-sm text-destructive font-semibold">Insufficient wallet float. Top up Agent Float Allocation to collect.</p>
              </div>
            )}

            {/* Pay from float */}
            <div className="rounded-xl border border-success/30 bg-success/5 p-3 sm:p-4 space-y-2.5">
              <div className="flex items-start gap-2.5">
                <Wallet className="h-5 w-5 text-success mt-0.5 shrink-0" />
                <div>
                  <p className="text-base font-bold text-success">Pay from Wallet Float</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Deducts from <strong>your wallet float</strong>. You earn <strong className="text-success">10% commission</strong> instantly.
                  </p>
                </div>
              </div>
              <Button
                onClick={() => {
                  console.log('[TenantProfileView] Pay-from-Float tapped', {
                    hasActiveRequest: !!summary.activeRequest,
                    currentOutstanding: summary.currentOutstanding,
                    agentFloatBalance,
                    floatLoading,
                    floatError,
                    rejected: summary.activeRequest?.status === 'rejected',
                    awaitingLandlord,
                    profileId: profile?.id,
                  });
                  if (awaitingLandlord) {
                    sonnerToast.error("Landlord not paid yet", {
                      description: "The landlord float is with you, but the landlord has not been paid. Collection opens once the landlord is paid.",
                    });
                    return;
                  }
                  if (floatLoading) {
                    sonnerToast.info("Loading your float…", {
                      description: "Hold on a moment while we fetch your wallet float balance.",
                    });
                    return;
                  }
                  if (floatError) {
                    sonnerToast.error("Couldn't load your Wallet Float", {
                      description: "Tap Retry above, or check your connection and try again.",
                    });
                    return;
                  }
                  if (agentFloatBalance < 500) {
                    sonnerToast.error("Insufficient wallet float", {
                      description: `You have ${formatUGX(agentFloatBalance)} in wallet float. Top up Agent Float Allocation before paying tenant rent.`,
                    });
                    return;
                  }
                  if (summary.activeRequest?.status === 'rejected') {
                    sonnerToast.error("This rent request was rejected", {
                      description: "You can't pay from float on a rejected request. Resubmit or start a new request for this tenant.",
                    });
                    return;
                  }
                  if (summary.currentOutstanding <= 0) {
                    sonnerToast.info("Nothing outstanding to pay", {
                      description: "This tenant has no outstanding rent right now.",
                    });
                    return;
                  }
                  if (repaymentNotStarted) {
                    sonnerToast.info(
                      daysUntilStart === 1 ? "This tenant starts paying tomorrow" : `This tenant starts paying in ${daysUntilStart} days`,
                      { description: `Rent was paid to the landlord, so repayment opens on ${repaymentStartsOn}. Collection is not open yet.` },
                    );
                    return;
                  }
                  setCollectDialogOpen(true);
                }}
                disabled={repaymentNotStarted || awaitingLandlord}
                className="w-full gap-2 text-base h-14 font-bold rounded-xl shadow-lg active:scale-[0.97] transition-transform"
                variant={awaitingLandlord ? "warning" : "success"}
                size="xl"
              >
                {floatLoading ? <Loader2 className="h-6 w-6 animate-spin" /> : awaitingLandlord ? <AlertTriangle className="h-6 w-6" /> : <Banknote className="h-6 w-6" />}
                {floatLoading
                  ? 'Loading float...'
                  : awaitingLandlord
                    ? 'Landlord not paid'
                    : repaymentNotStarted
                      ? (daysUntilStart === 1 ? 'Starts tomorrow' : `Starts in ${daysUntilStart} days`)
                      : `Pay ${formatUGX(Math.min(summary.currentOutstanding, agentFloatBalance))}`}
              </Button>
              {awaitingLandlord && (
                <p className="text-xs text-warning leading-relaxed">
                  Landlord float has been sent to you, but the landlord has not been paid yet. Collection opens once the landlord is paid.
                </p>
              )}
              {repaymentNotStarted && (
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Rent has been paid to the landlord. This tenant&apos;s first payment is due on{' '}
                  <strong>{repaymentStartsOn}</strong> — collection opens then.
                </p>
              )}
              {lastAllocation && (
                <Button
                  onClick={() => setReverseDialogOpen(true)}
                  variant="outline"
                  className="w-full gap-2 text-sm h-11 border-warning/40 text-warning hover:bg-warning/10 hover:text-warning"
                >
                  <Undo2 className="h-4 w-4" />
                  Reverse last — {formatUGX(lastAllocation.amount)}
                </Button>
              )}
            </div>

            {/* Auto-collect from tenant wallet */}
            {walletData && walletData.balance > 0 && (
              <div className="rounded-xl border border-border/50 bg-muted/30 p-3 sm:p-4 space-y-2.5">
                <div className="flex items-start gap-2.5">
                  <Bot className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                  <div>
                    <p className="text-base font-bold">Auto-Collect from Tenant Wallet</p>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      Pull <strong className="font-mono">{formatUGX(Math.min(walletData.balance, summary.currentOutstanding))}</strong> from tenant wallet
                      (<strong className="font-mono text-primary">{formatUGX(walletData.balance)}</strong> available). No cash needed.
                    </p>
                  </div>
                </div>
                <Button
                  onClick={handleAutoCollectFromWallet}
                  disabled={autoCollecting || awaitingLandlord}
                  variant="outline"
                  className={`w-full gap-2 text-base h-12 rounded-xl active:scale-[0.97] transition-transform ${
                    awaitingLandlord
                      ? "border-warning/40 text-warning blur-[1.5px] opacity-60 pointer-events-none"
                      : "border-primary/30"
                  }`}
                >
                  {autoCollecting ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : awaitingLandlord ? (
                    <AlertTriangle className="h-5 w-5" />
                  ) : (
                    <Bot className="h-5 w-5 text-primary" />
                  )}
                  {awaitingLandlord
                    ? "Landlord not paid"
                    : `Auto-Collect ${formatUGX(Math.min(walletData.balance, summary.currentOutstanding))}`}
                </Button>
                {awaitingLandlord && (
                  <p className="text-xs text-warning leading-relaxed">
                    Collection opens once the landlord has been paid.
                  </p>
                )}
              </div>
            )}

          </SectionCard>
        )}

        {/* ── Renew Rent Cycle (only when previous cycle is fully repaid and no active rent) ── */}
        {lastCompletedRequest && (
          <SectionCard
            icon={RefreshCw}
            title="Renew Rent Cycle"
            tone={canRenew ? 'success' : 'neutral'}
            badge={
              canRenew ? (
                <Badge variant="success" className="text-xs">Ready</Badge>
              ) : (
                <Badge variant="outline" className="text-xs">Active cycle in progress</Badge>
              )
            }
          >
            <p className="text-sm text-muted-foreground leading-relaxed">
              {canRenew
                ? <>Re-post the same rent plan for <strong>{profile.full_name.split(' ')[0]}</strong> — {formatUGX(lastCompletedRequest.rent_amount)} for {lastCompletedRequest.duration_days} days. Landlord and house details are reused.</>
                : <>This tenant still has an active rent cycle. Renew unlocks once the current cycle is fully repaid.</>}
            </p>
            <Button
              onClick={() => handleRenewCycle()}
              disabled={!canRenew || renewing}
              variant={canRenew ? 'success' : 'outline'}
              size="xl"
              className="w-full gap-2 text-base h-14 font-bold rounded-xl shadow-lg active:scale-[0.97] transition-transform"
            >
              {renewing ? <Loader2 className="h-6 w-6 animate-spin" /> : <RefreshCw className="h-6 w-6" />}
              {renewing ? 'Renewing…' : canRenew ? 'Renew Rent' : 'Renew (locked)'}
            </Button>
          </SectionCard>
        )}

        {/* ── Quick Actions ── */}
        <SectionCard icon={Zap} title="Quick Actions">
          <div className="grid grid-cols-2 gap-2.5">
            <Button
              variant="default"
              className="gap-2 text-sm h-auto py-3.5 flex-col items-center rounded-xl col-span-2"
              onClick={() => setFieldCollectOpen(true)}
            >
              <CreditCard className="h-6 w-6" />
              <span className="font-semibold">Collect Rent</span>
            </Button>
            <Button
              variant="outline"
              className="gap-2 text-sm h-auto py-3.5 flex-col items-center rounded-xl"
              onClick={handleSendDashboardLink}
              disabled={sharingLink}
            >
              {sharingLink ? <Loader2 className="h-6 w-6 animate-spin" /> : <Smartphone className="h-6 w-6 text-primary" />}
              <span className="font-semibold">Dashboard Link</span>
            </Button>
          </div>
        </SectionCard>

        {/* ── Roles & Verification ── */}
        <SectionCard icon={UserCheck} title="Roles & Verification">
          <div className="flex flex-wrap gap-1.5">
            {userRoles.map(role => (
              <Badge key={role} variant="outline" className="capitalize text-sm py-1 px-2.5">{role}</Badge>
            ))}
            {userRoles.length === 0 && <Badge variant="outline" className="capitalize text-sm py-1 px-2.5">Tenant</Badge>}
            {profile.national_id && <Badge className="bg-primary/10 text-primary border-0 text-sm py-1 px-2.5">ID on file</Badge>}
          </div>

          <p className="text-sm text-muted-foreground flex items-center gap-1.5">
            <Calendar className="h-4 w-4" />
            Joined {format(new Date(profile.created_at), 'dd MMM yyyy')}
          </p>
        </SectionCard>

        {/* ── Documents (passport photo, house photos, LC letter) ── */}
        <TenantDocumentsSection tenantId={profile.id} tenantName={profile.full_name} />

        {/* ── Contact Details ── */}
        <SectionCard icon={Phone} title="Contact Details">
          <div className="space-y-3">
            {/* Phone */}
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-xl bg-muted flex items-center justify-center shrink-0">
                <Phone className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground flex flex-wrap items-center gap-1.5 font-medium">
                  Phone
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-success bg-success/10 rounded-full px-1.5 py-0.5">
                    <MessageCircle className="h-2.5 w-2.5" /> WhatsApp
                  </span>
                </p>
                <a href={`tel:${profile.phone}`} className="text-sm sm:text-base font-semibold text-primary break-all">{profile.phone}</a>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <a
                  href={`https://wa.me/${phoneIntl}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h-10 w-10 sm:h-11 sm:w-11 rounded-xl bg-success/15 flex items-center justify-center active:scale-90 transition-transform"
                  style={{ touchAction: 'manipulation' }}
                  aria-label="Open WhatsApp chat"
                >
                  <MessageCircle className="h-4 w-4 sm:h-5 sm:w-5 text-success" />
                </a>
                <button
                  onClick={() => setEditDialogOpen(true)}
                  className="h-10 w-10 sm:h-11 sm:w-11 rounded-xl bg-warning/15 flex items-center justify-center active:scale-90 transition-transform"
                  style={{ touchAction: 'manipulation' }}
                  aria-label="Edit phone number"
                  title="Edit phone number"
                >
                  <Pencil className="h-4 w-4 sm:h-5 sm:w-5 text-warning" />
                </button>
              </div>
            </div>

            {/* Email */}
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 sm:h-11 sm:w-11 rounded-xl bg-muted flex items-center justify-center shrink-0">
                <Mail className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground font-medium">Email</p>
                <p className="text-sm sm:text-base font-semibold truncate">{profile.email || 'Not set'}</p>
              </div>
              <button
                onClick={() => setEditDialogOpen(true)}
                className="h-10 w-10 sm:h-11 sm:w-11 rounded-xl bg-warning/15 flex items-center justify-center active:scale-90 transition-transform shrink-0"
                style={{ touchAction: 'manipulation' }}
                aria-label="Edit email address"
                title="Edit email address"
              >
                <Pencil className="h-4 w-4 sm:h-5 sm:w-5 text-warning" />
              </button>
            </div>

            {profile.national_id && (
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 sm:h-11 sm:w-11 rounded-xl bg-muted flex items-center justify-center shrink-0">
                  <CreditCard className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground font-medium">National ID</p>
                  <p className="text-sm sm:text-base font-semibold font-mono break-all">{profile.national_id}</p>
                </div>
              </div>
            )}

            <div className="flex items-center gap-3">
              <div className="h-10 w-10 sm:h-11 sm:w-11 rounded-xl bg-muted flex items-center justify-center shrink-0">
                <Calendar className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground font-medium">Member Since</p>
                <p className="text-sm sm:text-base font-semibold">{format(new Date(profile.created_at), 'dd MMM yyyy')}</p>
              </div>
            </div>
          </div>

          {/* GPS */}
          <div className="pt-3 border-t border-border/40 space-y-2">
            <Button
              variant="outline"
              size="lg"
              className="w-full gap-2 text-sm sm:text-base h-11 sm:h-12 rounded-xl"
              onClick={handleCaptureGPS}
              disabled={gpsLoading || savingGps}
            >
              {gpsLoading || savingGps ? <Loader2 className="h-4 w-4 sm:h-5 sm:w-5 animate-spin" /> : <Navigation className="h-4 w-4 sm:h-5 sm:w-5" />}
              {savingGps ? 'Saving location…' : gpsLoading ? 'Reading GPS…' : 'Capture & Save GPS Location'}
            </Button>
            {gpsLocation && (
              <div className="bg-muted/40 rounded-xl p-3 flex items-center gap-2">
                <MapPin className="h-5 w-5 text-success shrink-0" />
                <div className="text-xs sm:text-sm">
                  <span className="font-mono font-semibold">{gpsLocation.latitude.toFixed(5)}</span>
                  <span className="text-muted-foreground mx-1">,</span>
                  <span className="font-mono font-semibold">{gpsLocation.longitude.toFixed(5)}</span>
                  {gpsLocation.accuracy && (
                    <span className="text-[10px] sm:text-xs text-muted-foreground ml-2">±{Math.round(gpsLocation.accuracy)}m</span>
                  )}
                  {gpsSavedAt && (
                    <span className="block text-xs text-success font-semibold">Saved to profile ✓</span>
                  )}
                </div>
              </div>
            )}
            {gpsError && (
              <p className="text-sm text-destructive">{gpsError}</p>
            )}
          </div>
        </SectionCard>

        {/* ── Wallet Usage ── */}
        {walletData && (
          <SectionCard icon={Wallet} title="Wallet Usage">
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Balance" value={formatUGX(walletData.balance)} tone="primary" />
              <Stat label="Total In" value={formatUGX(walletData.total_in)} tone="success" />
              <Stat label="Total Out" value={formatUGX(walletData.total_out)} tone="destructive" />
            </div>
          </SectionCard>
        )}

        {/* ── Current Property ── */}
        {summary.latestLandlord && (
          <TenantPropertyCard
            requestId={summary.latestRequestId}
            landlord={summary.latestLandlordRow}
            lc1={summary.latestLc1}
            onSaved={() => loadFullProfile({ silent: true })}
          />
        )}

        {/* ── Rent Payment Behavior ── */}
        <SectionCard icon={TrendingUp} title="Rent Payment Behavior">
          {(() => {
            const latestFunded = requests.find(r =>
              ['approved', 'funded', 'disbursed', 'repaying', 'completed'].includes(r.status || ''),
            );
            const monthlyRent = Number(profile?.monthly_rent) || Number(latestFunded?.rent_amount) || 0;
            const dailyRent = Number(summary.activeRequest?.daily_repayment) || Number(latestFunded?.daily_repayment) || 0;
            if (monthlyRent <= 0 && dailyRent <= 0) return null;
            return (
              <div className="mb-2.5 space-y-2.5">
                <div className="rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 to-primary/5 p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-primary/80">Monthly Rent</p>
                    <p className="text-2xl sm:text-3xl font-extrabold text-primary tabular-nums">
                      {monthlyRent > 0 ? `${formatUGX(monthlyRent)}/mo` : '—'}
                    </p>
                  </div>
                  <Home className="h-8 w-8 text-primary/60 shrink-0" />
                </div>
                {dailyRent > 0 && (
                  <Stat label="Daily Repayment" value={`${formatUGX(dailyRent)}/day`} tone="primary" />
                )}
              </div>
            );
          })()}
          <div className="grid grid-cols-2 gap-2.5">
            <Stat label="Rent Plans" value={summary.totalRequests} />
            <Stat
              label="Completion"
              value={`${summary.completionRate}%`}
              tone={summary.completionRate >= 80 ? 'success' : summary.completionRate >= 50 ? 'primary' : 'destructive'}
            />
            <Stat label="Total Repaid" value={formatUGX(summary.totalRepaid)} tone="success" />
            <Stat
              label="Total Owing"
              value={summary.totalOwing > 0 ? formatUGX(summary.totalOwing) : 'Clear ✓'}
              tone={summary.totalOwing > 0 ? 'destructive' : 'success'}
            />
          </div>

          {summary.totalFunded > 0 && (
            <div>
              <div className="flex justify-between text-xs sm:text-sm text-muted-foreground mb-1.5">
                <span>Overall repayment</span>
                <span className="font-bold text-foreground">{progressPct}%</span>
              </div>
              <div className="h-3 rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}>
                <div
                  className={`h-full rounded-full transition-all ${progressPct >= 100 ? 'bg-success' : progressPct >= 50 ? 'bg-primary' : 'bg-destructive'}`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}
        </SectionCard>

        {/* ── Rent Plan History ── */}
        {requests.length > 0 && (
          <SectionCard
            icon={Home}
            title="Rent Plan History"
            badge={<Badge variant="outline" className="text-xs">{requests.length}</Badge>}
          >
            <Button
              variant="soft"
              className="w-full h-10 gap-2 text-sm"
              onClick={handleExportRepaymentReport}
              disabled={exportingRepayReport}
            >
              {exportingRepayReport
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Building report…</>
                : <><FileText className="h-4 w-4" /> Export repayment report (PDF)</>}
            </Button>
            <div className="space-y-2">
              {visibleRequests.map(req => {
                const owing = Math.max(0, req.total_repayment - req.amount_repaid);
                const pct = req.total_repayment > 0 ? Math.round((req.amount_repaid / req.total_repayment) * 100) : 0;
                const agg = planRepaymentHistory.get(req.id);
                const planRows = agg?.rows ?? [];
                const shown = planRepayVisible[req.id] ?? 10;
                const visiblePlanRows = planRows.slice(0, shown);
                return (
                  <div key={req.id} className="bg-muted/40 rounded-xl p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm sm:text-base font-semibold">{format(new Date(req.created_at), 'dd MMM yyyy')}</span>
                      <Badge variant="outline" className="text-xs capitalize">{req.status}</Badge>
                    </div>
                    <div className="flex justify-between text-xs sm:text-sm text-muted-foreground gap-2 flex-wrap">
                      <span>Rent: <span className="font-bold text-foreground font-mono">{formatUGX(req.rent_amount)}</span></span>
                      <span>Owing: <span className={`font-bold font-mono ${owing > 0 ? 'text-destructive' : 'text-success'}`}>{owing > 0 ? formatUGX(owing) : 'Cleared'}</span></span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div className={`h-full rounded-full ${pct >= 100 ? 'bg-success' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
                    </div>
                    {req.landlord?.name && (
                      <p className="text-xs sm:text-sm text-muted-foreground">📍 {req.landlord.name} — {req.landlord.property_address || 'N/A'}</p>
                    )}

                    {/* ── Repayment history for this plan (date & time, amount, balance left) ── */}
                    <div className="pt-2 border-t border-border/50 space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Repayment history
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {(agg?.selfPaid ?? 0) > 0 && (
                            <Badge variant="secondary" className="text-[10px]">
                              {formatUGX(agg!.selfPaid)} paid by tenant
                            </Badge>
                          )}
                          <Badge variant="outline" className="text-[10px]">
                            {planRows.length} payment{planRows.length === 1 ? '' : 's'} · {formatUGX(agg?.ledgerPaid ?? 0)}
                          </Badge>
                        </div>
                      </div>

                      {planRows.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No repayments recorded on this plan yet.</p>
                      ) : (
                        <>
                          <div className="space-y-1">
                            {visiblePlanRows.map((r) => (
                              <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg bg-background/70 px-2.5 py-2">
                                <div className="min-w-0">
                                  <p className="text-xs font-mono text-muted-foreground">
                                    [{format(new Date(r.date), 'dd/MM/yy')}] {format(new Date(r.date), 'HH:mm')}
                                  </p>
                                  <p className="text-sm font-bold font-mono text-success">{formatUGX(r.amount)}</p>
                                  <Badge
                                    variant={r.selfPaid ? 'secondary' : 'outline'}
                                    className="mt-1 text-[9px] px-1.5 py-0"
                                  >
                                    {r.selfPaid ? 'Paid by tenant' : 'Agent collected'}
                                  </Badge>
                                </div>
                                <div className="text-right shrink-0">
                                  <p className="text-[10px] text-muted-foreground">Balance left</p>
                                  <p className={`text-sm font-bold font-mono ${r.remaining > 0 ? 'text-destructive' : 'text-success'}`}>
                                    {r.remaining > 0 ? formatUGX(r.remaining) : 'Cleared'}
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>

                          {planRows.length > shown && (
                            <Button
                              variant="ghost"
                              className="w-full h-9 gap-1 text-xs"
                              onClick={() => setPlanRepayVisible((prev) => ({ ...prev, [req.id]: shown + 10 }))}
                            >
                              <ChevronDown className="h-4 w-4" />
                              Load more ({planRows.length - shown} left)
                            </Button>
                          )}
                        </>
                      )}

                      {(agg?.otherSources ?? 0) > 0 && (
                        <p className="text-[11px] text-muted-foreground">
                          + {formatUGX(agg!.otherSources)} recorded on this plan from other sources (offline top-ups or
                          adjustments without an itemised payment record).
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {requests.length > PAGE_SIZE && (
              <Button variant="ghost" className="w-full text-sm gap-1 h-11" onClick={() => setShowAllRequests(!showAllRequests)}>
                {showAllRequests ? <><ChevronUp className="h-4 w-4" /> Show Less</> : <><ChevronDown className="h-4 w-4" /> Show All ({requests.length})</>}
              </Button>
            )}
          </SectionCard>
        )}

        {/* ── Repayment History ── */}
        {(() => {
          const ACTIVE_STATUSES = ['repaying', 'disbursed', 'funded'];
          const active =
            requests.find(r => ACTIVE_STATUSES.includes((r.status || '').toLowerCase())) ||
            requests[0];
          if (!active) return null;
          const startIso = (active as any).disbursed_at || active.created_at;
          const duration = Number(active.duration_days) || 0;
          const daily = Number(active.daily_repayment) || 0;
          if (!startIso || duration <= 0 || daily <= 0) return null;
          return (
            <SectionCard
              icon={Calendar}
              title="Payment Calendar"
              badge={<Badge variant="outline" className="text-xs">Active plan</Badge>}
            >
              <TenantPaymentCalendar
                plan={{
                  id: active.id,
                  startDate: startIso,
                  durationDays: duration,
                  dailyExpected: daily,
                }}
                repayments={repayments.map(r => ({
                  amount: Number(r.amount),
                  created_at: r.created_at,
                  rent_request_id: (r as any).rent_request_id ?? null,
                }))}
              />
            </SectionCard>
          );
        })()}

        {repayments.length > 0 && (
          <SectionCard
            icon={History}
            title="Repayment / Collection History"
            badge={<Badge variant="outline" className="text-xs">{repayments.length}{repayHasMoreServer ? '+' : ''}</Badge>}
          >
            <Button
              variant="soft"
              className="w-full h-10 gap-2 text-sm"
              onClick={handleExportRepaymentReport}
              disabled={exportingRepayReport}
            >
              {exportingRepayReport
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Building PDF…</>
                : <><FileText className="h-4 w-4" /> Export collections history (PDF)</>}
            </Button>
            <div className="space-y-1.5">
              {visibleRepayments.map(r => (
                <div key={r.id} className="flex items-center justify-between py-2.5 px-3 bg-muted/40 rounded-xl gap-2">
                  <div className="min-w-0">
                    <p className="text-base font-semibold font-mono text-success">{formatUGX(r.amount)}</p>
                    <p className="text-xs sm:text-sm text-muted-foreground">{format(new Date(r.created_at), 'dd MMM yyyy, HH:mm')}</p>
                  </div>
                  <CheckCircle2 className="h-5 w-5 text-success/70 shrink-0" />
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              {(repayVisible < repayments.length || repayHasMoreServer) && (
                <Button
                  variant="ghost"
                  className="w-full text-sm gap-1 h-11"
                  onClick={handleLoadMoreRepayments}
                  disabled={loadingMoreRepayments}
                >
                  {loadingMoreRepayments
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> Loading…</>
                    : <><ChevronDown className="h-4 w-4" /> Load more payments</>}
                </Button>
              )}
              {repayVisible > REPAY_VISIBLE_STEP && (
                <Button
                  variant="ghost"
                  className="w-full text-sm gap-1 h-10"
                  onClick={() => setRepayVisible(REPAY_VISIBLE_STEP)}
                >
                  <ChevronUp className="h-4 w-4" /> Show less
                </Button>
              )}
            </div>
          </SectionCard>
        )}


        {/* ── Monthly Rent ── */}
        {profile.monthly_rent && profile.monthly_rent > 0 && (
          <SectionCard icon={Banknote} title="Monthly Rent">
            <p className="text-2xl sm:text-3xl font-black font-mono text-primary">{formatUGX(profile.monthly_rent)}</p>
          </SectionCard>
        )}

        {/* ── Float Allocations viewer — filter by date range & status, download PDF ── */}
        {floatAllocations.length > 0 && (
          <SectionCard
            icon={Wallet}
            title="Float Allocations"
            tone="primary"
            badge={<Badge variant="outline" className="text-[10px]">{floatAllocations.length} total</Badge>}
          >
            {/* Status filter */}
            <div className="flex flex-wrap gap-2">
              {(['all', 'active', 'reversed'] as const).map((s) => (
                <Button
                  key={s}
                  type="button"
                  size="sm"
                  variant={allocStatus === s ? 'default' : 'soft'}
                  className="h-9 rounded-lg capitalize"
                  onClick={() => { setAllocStatus(s); setShowAllAllocations(false); }}
                >
                  {s === 'all' ? 'All' : s}
                </Button>
              ))}
            </div>

            {/* Date range presets */}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="soft" size="sm" className="h-8 rounded-lg text-xs" onClick={() => applyAllocPreset('all')}>All time</Button>
              <Button type="button" variant="soft" size="sm" className="h-8 rounded-lg text-xs" onClick={() => applyAllocPreset('thisMonth')}>This month</Button>
              <Button type="button" variant="soft" size="sm" className="h-8 rounded-lg text-xs" onClick={() => applyAllocPreset('30d')}>Last 30 days</Button>
              <Button type="button" variant="soft" size="sm" className="h-8 rounded-lg text-xs" onClick={() => applyAllocPreset('90d')}>Last 90 days</Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs font-medium text-muted-foreground space-y-1">
                <span>From</span>
                <input
                  type="date"
                  value={allocFrom}
                  max={allocTo || undefined}
                  onChange={(e) => { setAllocFrom(e.target.value); setShowAllAllocations(false); }}
                  className="w-full h-10 rounded-lg border border-border/60 bg-background px-2 text-sm text-foreground"
                />
              </label>
              <label className="text-xs font-medium text-muted-foreground space-y-1">
                <span>To</span>
                <input
                  type="date"
                  value={allocTo}
                  min={allocFrom || undefined}
                  onChange={(e) => { setAllocTo(e.target.value); setShowAllAllocations(false); }}
                  className="w-full h-10 rounded-lg border border-border/60 bg-background px-2 text-sm text-foreground"
                />
              </label>
            </div>

            {/* Summary */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-success/10 px-3 py-2">
                <p className="text-[11px] text-muted-foreground">Active allocated ({allocationTotals.activeCount})</p>
                <p className="text-base font-black font-mono text-success">{formatUGX(allocationTotals.activeTotal)}</p>
              </div>
              <div className="rounded-xl bg-destructive/10 px-3 py-2">
                <p className="text-[11px] text-muted-foreground">Reversed ({allocationTotals.reversedCount})</p>
                <p className="text-base font-black font-mono text-destructive">{formatUGX(allocationTotals.reversedTotal)}</p>
              </div>
            </div>

            {/* Filtered list */}
            {filteredAllocations.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-3">No allocations match these filters.</p>
            ) : (
              <div className="space-y-2">
                {(showAllAllocations ? filteredAllocations : filteredAllocations.slice(0, PAGE_SIZE)).map((a, i) => (
                  <div
                    key={`${a.date}-${i}`}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-muted/30 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">
                        {format(new Date(a.date), 'dd MMM yyyy, HH:mm')}
                      </p>
                      {a.reason && <p className="text-[11px] text-muted-foreground truncate">{a.reason}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${a.status === 'reversed' ? 'border-destructive/40 text-destructive' : 'border-success/40 text-success'}`}
                      >
                        {a.status === 'reversed' ? 'Reversed' : 'Active'}
                      </Badge>
                      <span className={`font-mono font-bold text-sm ${a.status === 'reversed' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                        {formatUGX(a.amount)}
                      </span>
                    </div>
                  </div>
                ))}
                {filteredAllocations.length > PAGE_SIZE && (
                  <Button variant="ghost" className="w-full text-sm gap-1 h-10" onClick={() => setShowAllAllocations(!showAllAllocations)}>
                    {showAllAllocations ? <><ChevronUp className="h-4 w-4" /> Show Less</> : <><ChevronDown className="h-4 w-4" /> Show All ({filteredAllocations.length})</>}
                  </Button>
                )}
              </div>
            )}

            {/* Agent caption for WhatsApp / PDF */}
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Add a note (optional)</span>
              <textarea
                value={allocCaption}
                onChange={(e) => setAllocCaption(e.target.value)}
                placeholder="e.g. Please confirm receipt of this allocation report."
                rows={2}
                className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40"
              />
              {allocCaption.trim().length > 0 && (
                <p className="text-[10px] text-muted-foreground">{allocCaption.trim().length}/200 characters</p>
              )}
            </label>

            <div className="flex flex-col sm:flex-row gap-2">
              <Button
                size="lg"
                disabled={sharingAllocWa || filteredAllocations.length === 0}
                onClick={handleShareAllocationsWhatsApp}
                className="w-full h-11 rounded-xl gap-2 font-semibold bg-success text-success-foreground hover:bg-success/90"
                aria-label="Share filtered float allocations PDF on WhatsApp"
              >
                {sharingAllocWa ? <Loader2 className="h-5 w-5 animate-spin" /> : <MessageCircle className="h-5 w-5" />}
                {sharingAllocWa ? 'Preparing…' : 'Share on WhatsApp'}
              </Button>
              <Button
                variant="outline"
                size="lg"
                disabled={downloadingAllocPdf || filteredAllocations.length === 0}
                onClick={handleDownloadAllocationsPdf}
                className="w-full h-11 rounded-xl gap-2 font-semibold"
                aria-label="Download filtered float allocations PDF"
              >
                {downloadingAllocPdf ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileText className="h-5 w-5" />}
                {downloadingAllocPdf ? 'Generating…' : 'Download PDF'}
              </Button>
            </div>
          </SectionCard>
        )}

        {/* ── One-tap export: all-time repayment sheet PDF, no extra navigation ── */}
        <Button
          variant="default"
          size="lg"
          disabled={requests.length === 0 || generatingSheet}
          onClick={handleQuickExportRepaymentSheet}
          className="w-full h-12 rounded-xl gap-2 text-base font-semibold"
          aria-label="Export repayment sheet PDF in one tap"
        >
          {generatingSheet ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileText className="h-5 w-5" />}
          {generatingSheet ? 'Preparing PDF…' : 'Export Repayment Sheet (PDF)'}
        </Button>

        {/* ── Repayment sheet PDF — pick a period, then generate ── */}
        <Popover
          open={sheetRangeOpen}
          onOpenChange={(open) => {
            setSheetRangeOpen(open);
            if (!open) setSheetConfirm(false);
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="lg"
              disabled={requests.length === 0}
              className="w-full h-11 rounded-xl gap-2 text-sm font-semibold"
              aria-label="Generate repayment sheet PDF for a chosen period"
            >
              <Calendar className="h-4 w-4" />
              Choose period &amp; export…
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="center"
            collisionPadding={12}
            className="w-[min(92vw,22rem)] max-h-[80vh] overflow-y-auto p-4 space-y-3"
          >
            {!sheetConfirm ? (
              <>
                <div>
                  <p className="text-sm font-bold text-foreground">Choose a period</p>
                  <p className="text-xs text-muted-foreground">
                    Leave blank for all-time. Transactions are filtered to this window.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="soft" size="sm" onClick={() => applySheetPreset('all')}>All time</Button>
                  <Button type="button" variant="soft" size="sm" onClick={() => applySheetPreset('thisMonth')}>This month</Button>
                  <Button type="button" variant="soft" size="sm" onClick={() => applySheetPreset('30d')}>Last 30 days</Button>
                  <Button type="button" variant="soft" size="sm" onClick={() => applySheetPreset('90d')}>Last 90 days</Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs font-medium text-muted-foreground space-y-1">
                    <span>From</span>
                    <input
                      type="date"
                      value={sheetFrom}
                      max={sheetTo || undefined}
                      onChange={(e) => setSheetFrom(e.target.value)}
                      className="w-full h-10 rounded-lg border border-border/60 bg-background px-2 text-sm text-foreground"
                    />
                  </label>
                  <label className="text-xs font-medium text-muted-foreground space-y-1">
                    <span>To</span>
                    <input
                      type="date"
                      value={sheetTo}
                      min={sheetFrom || undefined}
                      onChange={(e) => setSheetTo(e.target.value)}
                      className="w-full h-10 rounded-lg border border-border/60 bg-background px-2 text-sm text-foreground"
                    />
                  </label>
                </div>
                {/* Status filter for the day-by-day schedule */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Show days
                    </p>
                    {sheetStatusFilter.length < 4 && (
                      <button
                        type="button"
                        onClick={() => setSheetStatusFilter(['allocated', 'partial', 'missed', 'extra'])}
                        className="text-[10px] font-medium text-primary hover:text-primary/80 transition-colors"
                      >
                        Clear filters
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {([
                      { key: 'allocated', label: 'Allocated', color: 'text-green-600' },
                      { key: 'partial', label: 'Partial', color: 'text-amber-600' },
                      { key: 'missed', label: 'Missed', color: 'text-red-600' },
                      { key: 'extra', label: 'Extra', color: 'text-indigo-600' },
                    ] as { key: DailyScheduleRow['status']; label: string; color: string }[]).map((s) => {
                      const active = sheetStatusFilter.includes(s.key);
                      return (
                        <button
                          key={s.key}
                          type="button"
                          onClick={() =>
                            setSheetStatusFilter((prev) =>
                              active ? prev.filter((x) => x !== s.key) : [...prev, s.key],
                            )
                          }
                          className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
                            active
                              ? 'bg-primary/10 border-primary/40 text-foreground'
                              : 'bg-muted/40 border-border/40 text-muted-foreground'
                          }`}
                        >
                          <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle ${s.color.replace('text-', 'bg-')}`} />
                          {s.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {/* Live preview of the selected window before generating */}
                <SheetPeriodPreview
                  title="Preview"
                  preview={sheetPreview}
                  periodLabel={
                    sheetPreview.isAllTime
                      ? 'All time'
                      : `${sheetFrom ? format(new Date(sheetFrom), 'dd MMM yyyy') : '…'} – ${sheetTo ? format(new Date(sheetTo), 'dd MMM yyyy') : '…'}`
                  }
                  caption="Fee & balance totals cover all rent plans; only the “collected in period” figure and the PDF transaction log are filtered to the selected dates."
                />
                <Button
                  variant="default"
                  size="lg"
                  onClick={() => setSheetConfirm(true)}
                  disabled={generatingSheet}
                  className="w-full h-11 rounded-xl gap-2 font-semibold"
                >
                  <ChevronRight className="h-5 w-5" />
                  Review &amp; Confirm
                </Button>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-success" />
                  <p className="text-sm font-bold text-foreground">Confirm Repayment Sheet</p>
                </div>
                <SheetPeriodPreview
                  title="Period"
                  preview={sheetPreview}
                  periodLabel={
                    sheetPreview.isAllTime
                      ? 'All time'
                      : `${sheetFrom ? format(new Date(sheetFrom), 'dd MMM yyyy') : '…'} – ${sheetTo ? format(new Date(sheetTo), 'dd MMM yyyy') : '…'}`
                  }
                  caption="Review the figures above, then open the sheet on screen or download it. The PDF lists every day the agent allocated — with the exact amount, date & time."
                />
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button
                    variant="outline"
                    size="lg"
                    onClick={handleOpenRepaymentSheet}
                    disabled={generatingSheet || openingSheet}
                    className="w-full h-11 rounded-xl gap-2 font-semibold border-2 border-primary/40"
                    aria-label="Open repayment sheet PDF on screen"
                  >
                    {openingSheet ? <Loader2 className="h-5 w-5 animate-spin" /> : <ExternalLink className="h-5 w-5" />}
                    {openingSheet ? 'Opening…' : 'Open / View'}
                  </Button>
                  <Button
                    variant="default"
                    size="lg"
                    onClick={handleGenerateRepaymentSheet}
                    disabled={generatingSheet || openingSheet}
                    className="w-full h-11 rounded-xl gap-2 font-semibold"
                    aria-label="Download repayment sheet PDF"
                  >
                    {generatingSheet ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileText className="h-5 w-5" />}
                    {generatingSheet ? 'Generating…' : 'Download'}
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSheetConfirm(false)}
                  disabled={generatingSheet}
                  className="w-full h-9 rounded-xl gap-2 text-xs"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back to Edit
                </Button>
              </>
            )}
          </PopoverContent>
        </Popover>

        {/* ── Bottom "Back to Tenants" so agents don't scroll back up ── */}
        <Button
          variant="outline"
          size="lg"
          onClick={onBack}
          className="w-full h-12 rounded-xl gap-2 text-base font-semibold"
          aria-label="Back to tenants list"
        >
          <ArrowLeft className="h-5 w-5" />
          Back to Tenants
        </Button>

        {/* Spacer so sticky bottom toolbar doesn't cover the last card on mobile */}
        <div className="h-24 sm:h-4" />
      </div>

      {/* ── Mobile-only swipeable bottom-sheet quick actions ── */}
      <TenantQuickActionsSheet
        tenantName={profile.full_name}
        phone={profile.phone}
        phoneIntl={phoneIntl}
        onCollect={() => setCollectDialogOpen(true)}
        onShare={handleShareProfile}
        collectDisabled={
          !summary.activeRequest ||
          summary.currentOutstanding <= 0 ||
          floatLoading ||
          !!floatError ||
          agentFloatBalance < 500
        }
        shareLoading={sharingProfile}
      />

      {/* Float payment dialog */}
      {summary.activeRequest && profile && (
        <AgentTenantCollectDialog
          open={collectDialogOpen}
          onOpenChange={setCollectDialogOpen}
          tenant={{ id: profile.id, full_name: profile.full_name, phone: profile.phone }}
          rentRequestId={summary.activeRequest.id}
          outstandingBalance={summary.currentOutstanding}
          onSuccess={() => {
            setCollectDialogOpen(false);
            loadFullProfile();
            refetchFloat();
            loadLastAllocation();
          }}
        />
      )}

      <ReverseAllocationDialog
        open={reverseDialogOpen}
        onOpenChange={setReverseDialogOpen}
        collectionId={lastAllocation?.id || null}
        amount={lastAllocation?.amount || 0}
        tenantName={profile?.full_name}
        onReversed={() => {
          loadFullProfile();
          refetchFloat();
          loadLastAllocation();
        }}
      />

      {profile && lastCompletedRequest && lastCompletedRequest.landlord_id && (
        <RenewalAgreementDialog
          open={renewalAgreementOpen}
          onOpenChange={setRenewalAgreementOpen}
          landlordId={lastCompletedRequest.landlord_id}
          landlordName={lastCompletedRequest.landlord?.name || 'the landlord'}
          landlordPhone={lastCompletedRequest.landlord?.phone}
          propertyAddress={lastCompletedRequest.landlord?.property_address}
          monthlyRent={lastCompletedRequest.rent_amount || profile.monthly_rent}
          onContinue={() => { void handleRenewCycle(true); }}
        />
      )}

      <TenantFieldCollectDialog
        open={fieldCollectOpen}
        onOpenChange={setFieldCollectOpen}
        tenantId={profile.id}
        tenantName={profile.full_name}
        tenantPhone={profile.phone}
      />

      {/* Rent Access Limit — opens minimalist sheet with full card */}
      <Sheet open={rentLimitOpen} onOpenChange={setRentLimitOpen}>
        <SheetContent
          side="bottom"
          className="h-[88vh] rounded-t-3xl flex flex-col p-0 gap-0 overflow-hidden"
        >
          <SheetHeader className="px-4 sm:px-5 pt-5 pb-3 text-left">
            <SheetTitle className="text-lg font-bold">Rent Access Limit</SheetTitle>
            <SheetDescription className="text-xs">
              {profile.full_name}'s live limit — recalculated daily from repayments.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-3 sm:px-4 pb-6 space-y-3">
            <RentAccessLimitCard
              tenantId={profile.id}
              tenantName={profile.full_name}
              tenantPhone={profile.phone}
              monthlyRent={effectiveMonthlyRent}
              detectedFromHistory={
                (!profile.monthly_rent || profile.monthly_rent <= 0) && !!detectedMonthlyRent
              }
              suggestedRent={detectedMonthlyRent}
              onRentSaved={(rent) => {
                setProfile(prev => (prev ? { ...prev, monthly_rent: rent } : prev));
              }}
              repayments={repayments.map(r => ({ amount: r.amount, created_at: r.created_at }))}
              aiId={aiId}
            />
            <RentAccessLimitActivity
              tenantName={profile.full_name}
              monthlyRent={effectiveMonthlyRent}
              repayments={repayments.map(r => ({ amount: r.amount, created_at: r.created_at }))}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

interface SheetPeriodPreviewData {
  isAllTime: boolean;
  periodCount: number;
  collectedInPeriod: number;
  totalRentToLandlord: number;
  totalAccess: number;
  totalReg: number;
  totalDue: number;
  totalRepaid: number;
  totalOutstanding: number;
  collectionRate: number;
}

/**
 * Mobile-friendly repayment-sheet preview. The day-by-day allocation totals
 * wrap their labels and the value column never gets clipped — on very narrow
 * phones the figures table scrolls horizontally instead of overflowing.
 */
function SheetPeriodPreview({
  title,
  periodLabel,
  caption,
  preview,
}: {
  title: string;
  periodLabel: string;
  caption: string;
  preview: SheetPeriodPreviewData;
}) {
  const rows: { label: string; value: string; className?: string }[] = [
    { label: 'Rent to landlords', value: formatUGX(preview.totalRentToLandlord) },
    { label: 'Access fees', value: formatUGX(preview.totalAccess) },
    { label: 'Registration fees', value: formatUGX(preview.totalReg) },
    { label: 'Total due', value: formatUGX(preview.totalDue) },
    { label: 'Total repaid', value: formatUGX(preview.totalRepaid), className: 'text-success' },
    {
      label: 'Outstanding',
      value: formatUGX(preview.totalOutstanding),
      className: preview.totalOutstanding > 0 ? 'text-destructive' : 'text-success',
    },
    { label: 'Collection rate', value: `${preview.collectionRate}%` },
  ];

  return (
    <div className="rounded-xl border border-border/60 bg-muted/40 p-2.5 sm:p-3 space-y-1.5 sm:space-y-2">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-2">
        <p className="text-[10px] sm:text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</p>
        <Badge variant="outline" className="text-[10px] shrink-0 max-w-full sm:max-w-[60%] truncate">
          {periodLabel}
        </Badge>
      </div>
      <div className="rounded-lg bg-success/10 px-2.5 sm:px-3 py-1.5 sm:py-2">
        <p className="text-[10px] sm:text-[11px] text-muted-foreground">
          Collected in period ({preview.periodCount} payment{preview.periodCount === 1 ? '' : 's'})
        </p>
        <p className="text-base sm:text-lg font-black font-mono text-success break-all">{formatUGX(preview.collectedInPeriod)}</p>
      </div>
      {/* Figures table — responsive grid so labels never collide with values on tiny screens */}
      <div className="overflow-x-auto">
        <div className="min-w-[12rem] sm:min-w-[15rem] divide-y divide-border/40">
          {rows.map((r) => (
            <div key={r.label} className="grid grid-cols-[1fr_auto] items-center gap-2 py-1 sm:py-1.5">
              <span className="text-[10px] sm:text-xs text-muted-foreground break-words leading-snug">{r.label}</span>
              <span
                className={`text-right text-[10px] sm:text-xs font-semibold font-mono tabular-nums whitespace-nowrap ${r.className ?? ''}`}
              >
                {r.value}
              </span>
            </div>
          ))}
        </div>
      </div>
      <p className="text-[9px] sm:text-[10px] text-muted-foreground leading-snug">{caption}</p>
    </div>
  );
}
