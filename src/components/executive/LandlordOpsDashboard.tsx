import { useState, useEffect, useMemo, Fragment } from 'react';
import { useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { HOUSE_LISTING_SELECT } from '@/lib/landlord-ops/queries';
import { fetchListingProfileMaps, enrichListingsWithProfiles } from '@/lib/landlord-ops/profile-utils';
import { RentPipelineQueue } from './RentPipelineQueue';
import { RejectedRequestsQueue } from './RejectedRequestsQueue';
import { BusinessAdvanceQueue } from '@/components/ops/BusinessAdvanceQueue';
import { RentHistoryVerificationQueue } from '@/components/ops/RentHistoryVerificationQueue';
import { ServiceCentreNoteLoader } from '@/components/ops/ServiceCentreNoteLoader';
import { LandlordOpsPayoutReview } from '@/components/cfo/LandlordOpsPayoutReview';
import { AgentRentCapacityPanel } from './AgentRentCapacityPanel';
import { KPICard } from './KPICard';
import { DrilldownTable, type DrilldownColumn } from './DrilldownTable';
import { EntityDetailSheet } from './EntityDetailSheet';
import {
  Home, Banknote, CheckCircle2, MapPin, AlertTriangle, ShieldCheck, ShieldQuestion,
  Phone, MessageCircle, Image, MapPinned, DoorOpen, TrendingDown, Users,
  Building2, UserCheck, Smartphone, Handshake, GitBranch, Link2,
  ArrowLeft, ChevronRight, Search, X, Globe, UserX, UserPlus,
  Table2, Printer, CalendarIcon, Loader2, Upload, RotateCcw, Mail, Clock,
} from 'lucide-react';
import { Eye, EyeOff } from 'lucide-react';
import { LayoutGrid } from 'lucide-react';
import { Layers } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { ChainHealthTab } from './landlord-ops/ChainHealthTab';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  useLandlordOpsTotals,
  useLandlordOpsList,
  useLandlordScopedCounts,
  fetchLandlordReport,
  type LandlordCategory as LandlordOpsCategory,
  type LandlordPendingFilter as LandlordOpsPendingFilter,
  type LandlordSort as LandlordOpsSort,
} from '@/hooks/useLandlordOps';
import {
  setLandlordVerification,
  VERIFICATION_STATUS_META,
  verificationSourceLabel,
  type LandlordVerificationStatus,
} from '@/lib/landlord-ops/verification';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger,
} from '@/components/ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { toast as sonnerToast } from 'sonner';
import { ExecutiveDataTable, Column } from './ExecutiveDataTable';
import { generateLandlordOpsReportPdf } from '@/lib/generateLandlordOpsReportPdf';
import { generateHouseVerificationReportPdf, type HouseReportRow } from '@/lib/generateHouseVerificationReportPdf';
import {
  generateLandlordVerificationReportPdf,
  type LandlordReportScope,
} from '@/lib/generateLandlordVerificationReportPdf';
import {
  generateLandlordFundedReportPdf,
  landlordFundedFileName,
} from '@/lib/generateLandlordFundedReportPdf';
import {
  useLandlordFundedStats,
  fetchLandlordFundedStats,
} from '@/hooks/useLandlordFundedStats';
import { generateLc1VerificationReportPdf, lc1ReportFileName, type Lc1ReportRow } from '@/lib/generateLc1VerificationReportPdf';
import {
  LandlordOpsExtractCenter,
  type LandlordExtractKind,
  type LandlordExtractTargetView,
} from './landlord-ops/LandlordOpsExtractCenter';
import { FileDown } from 'lucide-react';
import { RentAdjustmentDialog } from './RentAdjustmentDialog';
import { VacancyAnalytics } from './VacancyAnalytics';
import { TenantMatchingQueue } from './landlord-ops/TenantMatchingQueue';
import { DealPipeline } from './landlord-ops/DealPipeline';
import { ListingBonusApprovalQueue } from './ListingBonusApprovalQueue';
import { VerificationTimelinePanel } from './landlord-ops/VerificationTimelinePanel';
import { EmptyHouseActionDialog } from './landlord-ops/EmptyHouseActionDialog';
import { AgentListingBlockControl } from './landlord-ops/AgentListingBlockControl';
import { Trash2, XCircle, Pencil } from 'lucide-react';
import { EditLandlordDialog } from './landlord-ops/EditLandlordDialog';
import { ReverseVerificationDialog } from './landlord-ops/ReverseVerificationDialog';
import { EditLC1Dialog } from './landlord-ops/EditLC1Dialog';
import { BulkImportLC1Dialog } from './landlord-ops/BulkImportLC1Dialog';
import { BulkImportLandlordsDialog } from './landlord-ops/BulkImportLandlordsDialog';
import { AssignPersonDialog } from './landlord-ops/AssignPersonDialog';
import { StorageImage } from '@/components/ui/StorageImage';
import { ChevronLeft } from 'lucide-react';

import { VerifyLandlordButton } from '@/components/verification/VerifyLandlordButton';
import { LandlordsPaidView } from './landlord-ops/LandlordsPaidView';
import { LandlordsWithTenantsView } from './landlord-ops/LandlordsWithTenantsView';
import { LandlordHousesPanel } from './landlord-ops/LandlordHousesPanel';
import { AgentVerificationRequestsPanel } from './landlord-ops/AgentVerificationRequestsPanel';
import { Lc1VerificationInboxPanel } from './landlord-ops/Lc1VerificationInboxPanel';
import { Lc1DuplicatesPanel } from './landlord-ops/Lc1DuplicatesPanel';
import { ResidenceVerificationPanel } from './landlord-ops/ResidenceVerificationPanel';
import { HubEntryCard } from '@/components/ops/HubEntryCard';
import { ServiceCentreManagerNetworkPanel } from '@/components/executive/ServiceCentreManagerNetworkPanel';
import { HubHeader } from '@/components/ops/HubHeader';

/**
 * Thin wrapper that fetches active listing blocks + recent rejection counts
 * for ALL agent IDs currently visible in the Verification Queue in a SINGLE
 * batched query, then hands the per-agent slice down to the underlying
 * `AgentListingBlockControl` via `preloadedStatus`.
 *
 * Every rendered card shares the same react-query key (`agentIdsInView`
 * joined + sorted), so react-query dedupes the fetch to a single request
 * regardless of how many cards are mounted. This replaces what used to be
 * `2 × N` per-card queries (blocks + rejections) with `2` total per page.
 */
function BatchedAgentListingBlockControl({
  agentId,
  agentName,
  agentIdsInView,
}: {
  agentId: string;
  agentName?: string | null;
  agentIdsInView: string[];
}) {
  const batchKey = useMemo(
    () => Array.from(new Set(agentIdsInView.filter(Boolean))).sort().join(','),
    [agentIdsInView],
  );
  const { data: statusMap } = useQuery({
    queryKey: ['agent-posting-status-batch', batchKey],
    queryFn: async () => {
      const ids = batchKey ? batchKey.split(',') : [];
      const empty = new Map<string, { block: any; recentRejections: number }>();
      if (ids.length === 0) return empty;
      const nowIso = new Date().toISOString();
      const [blocksRes, rejsRes] = await Promise.all([
        supabase
          .from('agent_listing_blocks')
          .select('agent_id, id, blocked_until, reason, auto_blocked, rejection_count, created_at')
          .in('agent_id', ids)
          .eq('active', true)
          .gt('blocked_until', nowIso),
        supabase
          .from('agent_listing_rejections')
          .select('agent_id')
          .in('agent_id', ids),
      ]);
      const m = new Map<string, { block: any; recentRejections: number }>();
      ids.forEach((id) => m.set(id, { block: null, recentRejections: 0 }));
      (blocksRes.data || []).forEach((b: any) => {
        const cur = m.get(b.agent_id) || { block: null, recentRejections: 0 };
        m.set(b.agent_id, { ...cur, block: b });
      });
      const counts: Record<string, number> = {};
      (rejsRes.data || []).forEach((r: any) => {
        counts[r.agent_id] = (counts[r.agent_id] || 0) + 1;
      });
      ids.forEach((id) => {
        const cur = m.get(id)!;
        m.set(id, { ...cur, recentRejections: counts[id] || 0 });
      });
      return m;
    },
    enabled: !!batchKey,
    staleTime: 60_000,
  });
  const preloaded = statusMap
    ? statusMap.get(agentId) ?? { block: null, recentRejections: 0 }
    : undefined;
  return (
    <AgentListingBlockControl
      agentId={agentId}
      agentName={agentName}
      preloadedStatus={preloaded}
    />
  );
}


interface ListingWithLandlord {
  id: string;
  title: string;
  house_category: string;
  monthly_rent: number;
  daily_rate: number;
  number_of_rooms: number;
  address: string;
  district: string | null;
  village: string | null;
  region: string;
  latitude: number | null;
  longitude: number | null;
  image_urls: string[] | null;
  lc1_chairperson_name: string | null;
  lc1_chairperson_phone: string | null;
  lc1_chairperson_village: string | null;
  agent_id: string;
  landlord_id: string | null;
  tenant_id: string | null;
  verified: boolean | null;
  listing_bonus_paid: boolean | null;
  created_at: string;
  status: string;
  is_hidden: boolean | null;
  landlords?: {
    id: string;
    name: string;
    phone: string;
    verified: boolean | null;
    mobile_money_name: string | null;
    mobile_money_number: string | null;
    has_smartphone: boolean | null;
    number_of_houses: number | null;
    bank_name: string | null;
    account_number: string | null;
    monthly_rent: number | null;
    caretaker_name: string | null;
    caretaker_phone: string | null;
    tin: string | null;
    electricity_meter_number: string | null;
    water_meter_number: string | null;
    village: string | null;
    district: string | null;
    region: string | null;
  } | null;
  agent_name?: string;
  agent_phone?: string;
  agent_email?: string | null;
  tenant_name?: string;
  tenant_phone?: string;
}

interface TenantWithoutLandlord {
  id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  rent_amount: number;
  request_city: string | null;
  house_category: string | null;
  status: string;
  created_at: string;
}

function PhoneLinks({ phone, name }: { phone: string; name?: string }) {
  const cleanPhone = phone.replace(/\s/g, '');
  const intlPhone = cleanPhone.startsWith('0') ? `+256${cleanPhone.slice(1)}` : cleanPhone.startsWith('+') ? cleanPhone : `+256${cleanPhone}`;
  return (
    <div className="flex items-center gap-1.5">
      <a href={`tel:${intlPhone}`} className="inline-flex items-center gap-1 text-primary hover:underline text-xs font-medium">
        <Phone className="h-3 w-3" />
        {phone}
      </a>
      <a
        href={`https://wa.me/${intlPhone.replace('+', '')}?text=${encodeURIComponent(`Hello ${name || ''}, this is Welile Operations.`)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center justify-center h-7 w-7 rounded-full bg-[#25D366]/20 text-[#25D366] hover:bg-[#25D366]/30 transition-colors min-h-[28px]"
        title="WhatsApp"
      >
        <MessageCircle className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

function ListPropertyCTA({ phone, name, role }: { phone: string; name?: string; role: 'tenant' | 'agent' }) {
  const cleanPhone = phone.replace(/\s/g, '');
  const intlPhone = cleanPhone.startsWith('0') ? `+256${cleanPhone.slice(1)}` : cleanPhone.startsWith('+') ? cleanPhone : `+256${cleanPhone}`;
  const waNumber = intlPhone.replace('+', '');
  const message = role === 'tenant'
    ? `Hello ${name || ''}, this is Welile Landlord Operations. We noticed your property isn't listed yet. Please list your landlord's property on Welile and earn UGX 2,000 listing bonus! 🏠💰 Ask your agent for help or contact us.`
    : `Hello ${name || ''}, this is Welile Landlord Operations. You have tenants without landlord property listings. Please help them list their landlord's properties on Welile — each listing earns UGX 2,000 bonus! 🏠💰`;

  return (
    <div className="flex items-center gap-1.5">
      <a href={`tel:${intlPhone}`} className="inline-flex items-center justify-center h-8 w-8 rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors min-h-[32px]" title="Call">
        <Phone className="h-3.5 w-3.5" />
      </a>
      <a
        href={`https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-[#25D366]/15 text-[#25D366] hover:bg-[#25D366]/25 transition-colors text-xs font-medium min-h-[32px]"
        title="WhatsApp: List property & earn UGX 2,000"
      >
        <MessageCircle className="h-3.5 w-3.5" />
        List & Earn 5K
      </a>
    </div>
  );
}

function ImagePreviewDialog({ images, open, onClose, title, startIndex = 0 }: { images: string[]; open: boolean; onClose: () => void; title: string; startIndex?: number }) {
  const [current, setCurrent] = useState(startIndex);
  useEffect(() => { setCurrent(startIndex); }, [startIndex, open]);
  if (!images.length) return null;
  const prev = () => setCurrent(c => (c - 1 + images.length) % images.length);
  const next = () => setCurrent(c => (c + 1) % images.length);
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl p-2">
        <DialogHeader className="px-2 pt-2">
          <DialogTitle className="text-sm">{title} ({current + 1}/{images.length})</DialogTitle>
        </DialogHeader>
        <div className="relative bg-black/90 rounded-lg flex items-center justify-center" style={{ minHeight: '60vh' }}>
          <StorageImage src={images[current]} alt={title} className="w-full rounded-lg max-h-[80vh] object-contain" expandable={false} />
          {images.length > 1 && (
            <>
              <button onClick={prev} aria-label="Previous" className="absolute left-2 top-1/2 -translate-y-1/2 h-9 w-9 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80">
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button onClick={next} aria-label="Next" className="absolute right-2 top-1/2 -translate-y-1/2 h-9 w-9 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80">
                <ChevronRight className="h-5 w-5" />
              </button>
            </>
          )}
        </div>
        {images.length > 1 && (
          <div className="flex gap-2 overflow-x-auto px-2 pb-2 pt-2">
            {images.map((url, i) => (
              <button
                key={i}
                onClick={() => setCurrent(i)}
                className={`shrink-0 h-16 w-16 rounded-md overflow-hidden border-2 transition-colors ${i === current ? 'border-primary' : 'border-transparent opacity-70 hover:opacity-100'}`}
              >
                <StorageImage src={url} alt={`${title} ${i + 1}`} className="w-full h-full object-cover" expandable={false} />
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type View = 'home' | 'landlords' | 'locations' | 'lc1' | 'lc1-requests' | 'residence-verify' | 'lc1-duplicates' | 'empty' | 'occupied' | 'verify' | 'pipeline' | 'chain' | 'matching' | 'agents' | 'analytics' | 'cities' | 'no-landlord' | 'advance-requests' | 'landlords-paid' | 'landlords-tenants' | 'all-requests' | 'houses-by-landlord' | 'agent-verify-requests' | 'lc1-inbox' | 'rent-pipeline-queue' | 'rejected-queue' | 'payout-review' | 'agent-capacity' | 'service-centres' | 'reports';

/** Public alias so the sidebar shell can type its nav keys against the exact
 *  same view union Classic already routes on. */
export type LandlordOpsClassicView = View;


// ─── Hub section titles (dedicated workspaces reached from the dashboard) ───
const hubTitles: Partial<Record<View, string>> = {
  'agent-verify-requests': 'Agent Verification Requests',
  'lc1-inbox': 'LC1 Verification Inbox',
  'rent-pipeline-queue': 'Rent Pipeline',
  'rejected-queue': 'Rejected at Landlord Ops',
  'payout-review': 'Landlord Payout Review',
  'agent-capacity': 'Agent Rent Capacity',
  reports: 'Reports & Exports',
};

// ─── Navigation Items ───
const navItems: { id: View; label: string; icon: typeof Building2; color: string; description: string; priority?: boolean }[] = [
  { id: 'landlords', label: 'All Landlords', icon: Building2, color: 'bg-sky-500/10 text-sky-600 border-sky-500/30', description: 'Directory with contacts & properties', priority: true },
  { id: 'landlords-tenants', label: 'Landlords & Tenants', icon: Users, color: 'bg-indigo-500/10 text-indigo-600 border-indigo-500/30', description: 'All landlords with their tenants & paid/pending status', priority: true },
  { id: 'houses-by-landlord', label: 'Houses by Landlord', icon: Home, color: 'bg-primary/10 text-primary border-primary/30', description: 'Bind / swap / remove tenants on each house · reassign agents', priority: true },
  { id: 'landlords-paid', label: 'Landlords Paid', icon: Banknote, color: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30', description: 'Disbursements from tenant rent', priority: true },
  { id: 'all-requests', label: 'All Requests', icon: Table2, color: 'bg-slate-500/10 text-muted-foreground border-slate-500/30', description: 'Full table of every rent request (landlord lens)', priority: true },
  { id: 'locations', label: 'Locations', icon: MapPin, color: 'bg-purple-500/10 text-purple-600 border-purple-500/30', description: 'Regions, districts & house counts', priority: true },
  { id: 'lc1-requests', label: 'Agents requesting LC1 verification', icon: ShieldQuestion, color: 'bg-amber-500/10 text-amber-600 border-amber-500/30', description: 'Single inbox — approve or reject every LC1 chairperson', priority: true },
  { id: 'lc1', label: 'LC1 Chairpersons', icon: ShieldCheck, color: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30', description: 'Approved & rejected LC1 chairpersons · reports', priority: true },
  { id: 'residence-verify', label: 'Landlord GPS Verification', icon: MapPin, color: 'bg-sky-500/10 text-sky-600 border-sky-500/30', description: 'Set landlord GPS verification status (pending/verified/rejected)', priority: true },
  { id: 'lc1-duplicates', label: 'LC1 Duplicates', icon: Layers, color: 'bg-rose-500/10 text-rose-600 border-rose-500/30', description: 'Review & merge duplicate LC1 phone rows' },
  { id: 'cities', label: 'Cities We Operate In', icon: Globe, color: 'bg-teal-500/10 text-teal-600 border-teal-500/30', description: 'All cities with tenants & properties', priority: true },
  { id: 'no-landlord', label: 'No Landlord Listed', icon: UserX, color: 'bg-orange-500/10 text-orange-600 border-orange-500/30', description: 'Tenants without landlord — contact to list & earn 5K', priority: true },
  { id: 'empty', label: 'Empty Houses', icon: DoorOpen, color: 'bg-red-500/10 text-red-600 border-red-500/30', description: 'Vacant properties losing revenue' },
  { id: 'occupied', label: 'Occupied Houses', icon: UserCheck, color: 'bg-green-500/10 text-green-600 border-green-500/30', description: 'Properties with active tenants' },
  { id: 'verify', label: 'Verification Queue', icon: ShieldCheck, color: 'bg-amber-500/10 text-amber-600 border-amber-500/30', description: 'Listings pending verification' },
  { id: 'pipeline', label: 'Deal Pipeline', icon: GitBranch, color: 'bg-blue-500/10 text-blue-600 border-blue-500/30', description: 'Rent approvals & deal flow' },
  { id: 'chain', label: 'Chain Health', icon: Link2, color: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30', description: 'Property chain completeness' },
  { id: 'matching', label: 'Tenant Matching', icon: Handshake, color: 'bg-primary/10 text-primary border-primary/30', description: 'Match tenants to empty houses' },
  { id: 'agents', label: 'Listing Agents', icon: Users, color: 'bg-indigo-500/10 text-indigo-600 border-indigo-500/30', description: 'Agent performance rankings' },
  { id: 'analytics', label: 'Analytics', icon: Banknote, color: 'bg-orange-500/10 text-orange-600 border-orange-500/30', description: 'Photos, GPS & vacancy stats' },
  { id: 'advance-requests', label: 'Business Advances', icon: Banknote, color: 'bg-purple-500/10 text-purple-600 border-purple-500/30', description: 'Business advances & rent history' },
];

function TenantStatusFilter({
  tenants,
  landlordName,
  onOpenTenant,
}: {
  tenants: { id: string; name: string; phone: string | null; status: string }[];
  landlordName: string;
  onOpenTenant: (type: 'tenant', data: Record<string, unknown>) => void;
}) {
  const [activeStatus, setActiveStatus] = useState<string | null>(null);
  const statusCounts = tenants.reduce<Record<string, number>>((acc, t) => {
    const s = (t.status || 'listed').toLowerCase();
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  const filtered = activeStatus
    ? tenants.filter(t => (t.status || 'listed').toLowerCase() === activeStatus)
    : tenants;

  const statusColorMap: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-700 border-amber-300 hover:bg-amber-200',
    verified: 'bg-emerald-100 text-emerald-700 border-emerald-300 hover:bg-emerald-200',
    listed: 'bg-sky-100 text-sky-700 border-sky-300 hover:bg-sky-200',
    hidden: 'bg-muted text-muted-foreground border-border hover:bg-slate-200',
    rejected: 'bg-rose-100 text-rose-700 border-rose-300 hover:bg-rose-200',
    default: 'bg-muted text-muted-foreground border-border hover:bg-accent',
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
          Tenants Summary
        </p>
        <Badge variant="outline" className="text-[10px]">{filtered.length} / {tenants.length}</Badge>
      </div>
      {Object.keys(statusCounts).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(statusCounts).map(([status, count]) => {
            const active = activeStatus === status;
            const colorClass = statusColorMap[status] || statusColorMap.default;
            return (
              <button
                key={status}
                type="button"
                onClick={() => setActiveStatus(active ? null : status)}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-semibold capitalize transition-all ${
                  active ? 'ring-1 ring-offset-1 ' + colorClass : colorClass
                }`}
                aria-pressed={active}
                title={active ? 'Click to clear filter' : `Show only ${status} tenants`}
              >
                {status.replace(/_/g, ' ')}
                <span className={`text-[9px] font-bold px-1 py-0 rounded-full ${active ? 'bg-white/40' : 'bg-black/5'}`}>
                  {count}
                </span>
              </button>
            );
          })}
          {activeStatus && (
            <button
              type="button"
              onClick={() => setActiveStatus(null)}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-[10px] font-semibold text-muted-foreground hover:bg-muted transition-all"
            >
              Reset
            </button>
          )}
        </div>
      )}
      <div className="space-y-1">
        {filtered.map((tn, idx) => (
          <button
            key={tn.id || idx}
            type="button"
            onClick={() => onOpenTenant('tenant', { ...tn, landlord_name: landlordName })}
            className="flex w-full items-center justify-between gap-2 rounded-lg bg-green-500/10 px-2.5 py-1.5 text-left transition-colors hover:bg-green-500/20 active:scale-[0.99] touch-manipulation"
          >
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs font-medium truncate">{tn.name}</span>
              <Badge variant="outline" className="text-[9px] px-1 py-0 capitalize shrink-0">
                {(tn.status || 'listed').replace(/_/g, ' ')}
              </Badge>
            </span>
            <span className="text-[10px] font-semibold text-green-700 shrink-0">View</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Classic Landlord Ops. Standalone by default (own `view` state + the mobile
 * card overview). When `view` / `onViewChange` are passed the parent shell owns
 * navigation instead, and `hideOverview` suppresses the legacy overview because
 * the shell's sidebar and landing page replace it. Every working view, query,
 * dialog and handler below is unchanged.
 */
export function LandlordOpsDashboard({
  view: controlledView,
  onViewChange,
  hideOverview = false,
}: {
  view?: View;
  onViewChange?: (view: View) => void;
  hideOverview?: boolean;
} = {}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [internalView, setInternalView] = useState<View>('home');
  const view = controlledView ?? internalView;
  const setView = (next: View) => {
    if (controlledView === undefined) setInternalView(next);
    onViewChange?.(next);
  };

  const [search, setSearch] = useState('');
  const [navSheetOpen, setNavSheetOpen] = useState(false);
  const [landlordPage, setLandlordPage] = useState(1);
  // Default to the Verified filter so ops only sees trusted landlords by
  // default. Search bypasses this filter at the RPC level so unverified
  // matches still surface — flagged with a red "Not Verified" badge.
  const [landlordCategory, setLandlordCategory] = useState('verified');
  const [verifying, setVerifying] = useState<string | null>(null);
  const queryClient = useQueryClient();
  // Optimistically removed from the verification queue (until refetch confirms or rollback restores).
  const [optimisticallyVerifiedIds, setOptimisticallyVerifiedIds] = useState<Set<string>>(new Set());
  const [previewImages, setPreviewImages] = useState<{ images: string[]; title: string; startIndex?: number } | null>(null);
  const [adjustListing, setAdjustListing] = useState<ListingWithLandlord | null>(null);
  const [actionDialog, setActionDialog] = useState<{ listing: ListingWithLandlord; type: 'delete' | 'delist' | 'reject' } | null>(null);
  const [editLandlord, setEditLandlord] = useState<{ id: string; name: string; phone: string; [k: string]: any } | null>(null);
  // Ops-only: undo a landlord verification (and its bonus payment) done by mistake.
  const [reverseLandlord, setReverseLandlord] = useState<{ id: string; name: string | null } | null>(null);
  const [editLC1, setEditLC1] = useState<{ id: string; name: string; phone: string | null; village: string | null; listingIds: string[] } | null>(null);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [bulkImportLandlordsOpen, setBulkImportLandlordsOpen] = useState(false);
  const [deleteLandlord, setDeleteLandlord] = useState<{ id: string; name: string } | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [assignPerson, setAssignPerson] = useState<{ listingId: string; title: string; type: 'landlord' | 'agent' } | null>(null);
  // Landlord verification moderation (frontend session state).
  // NOTE: rejections are persisted state (landlords.verification_status), never
  // session state — a rejected landlord must survive a refresh and appear under
  // the Rejected tab.
  const [expandedLandlordId, setExpandedLandlordId] = useState<string | null>(null);
  // Drilldown row → entity detail sheet (cities / no-landlord tenants / landlords)
  const [entityDetail, setEntityDetail] = useState<
    | { type: 'city'; data: any }
    | { type: 'no-landlord'; data: any }
    | { type: 'landlord'; data: any }
    | { type: 'tenant'; data: any }
    | null
  >(null);
  // Deep-link params for shareable entity detail links (?entity=…&eid=…)
  const [searchParams, setSearchParams] = useSearchParams();

  const entityId = (type: 'city' | 'no-landlord' | 'landlord' | 'tenant', data: any): string =>
    type === 'city' ? data.city : data.id;

  const openEntity = (type: 'city' | 'no-landlord' | 'landlord' | 'tenant', data: any) => {
    setEntityDetail({ type, data });
    const next = new URLSearchParams(searchParams);
    next.set('entity', type);
    next.set('eid', entityId(type, data));
    setSearchParams(next, { replace: false });
  };

  const closeEntity = () => {
    setEntityDetail(null);
    const next = new URLSearchParams(searchParams);
    next.delete('entity');
    next.delete('eid');
    setSearchParams(next, { replace: true });
  };

  // ─── Verification Queue Search & Filters ───
  const [verifySearch, setVerifySearch] = useState('');
  type VerifyFilter = 'all' | 'has_landlord' | 'no_landlord' | 'has_images' | 'has_gps' | 'has_lc1' | 'hidden' | 'visible';
  const [verifyFilter, setVerifyFilter] = useState<VerifyFilter>('all');
  // Scope: pending | verified | rejected | all — thumb-friendly status chips.
  // "Hidden" is deliberately NOT a scope: 99% of hidden houses are verified
  // houses that ops temporarily pulled off the tenant feed, so a sibling chip
  // double-counted them and split the verified backlog in two. Hidden is now a
  // sub-filter (quick chip) inside Verified / All houses.
  type HouseStatusFilter = 'pending' | 'verified' | 'rejected' | 'all';
  const [houseStatusFilter, setHouseStatusFilter] = useState<HouseStatusFilter>(() => {
    const saved = localStorage.getItem('landlordOpsHouseFilter');
    // Legacy persisted 'hidden' scope migrates to Verified + hidden sub-filter.
    if (saved === 'hidden') return 'verified';
    if (saved === 'pending' || saved === 'verified' || saved === 'rejected' || saved === 'all') return saved;
    return 'pending';
  });
  useEffect(() => {
    localStorage.setItem('landlordOpsHouseFilter', houseStatusFilter);
  }, [houseStatusFilter]);
  // hidden/visible only make sense inside Verified / All houses — drop them
  // when the operator switches to Pending or Rejected.
  useEffect(() => {
    if (
      (verifyFilter === 'hidden' || verifyFilter === 'visible')
      && houseStatusFilter !== 'verified'
      && houseStatusFilter !== 'all'
    ) {
      setVerifyFilter('all');
    }
  }, [houseStatusFilter, verifyFilter]);
  const [togglingHide, setTogglingHide] = useState<Record<string, boolean>>({});
  const [editingRentId, setEditingRentId] = useState<string | null>(null);
  const [editRentValue, setEditRentValue] = useState<string>('');
  const [savingRentId, setSavingRentId] = useState<string | null>(null);
  // ─── Verification Queue bulk selection ───
  const [verifySelectedIds, setVerifySelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<null | 'hide' | 'unhide' | 'verify' | 'reject'>(null);
  const [bulkProgress, setBulkProgress] = useState<null | { done: number; total: number }>(null);
  const [bulkResult, setBulkResult] = useState<null | {
    action: string;
    results: { id: string; title: string; ok: boolean; error?: string }[];
  }>(null);
  // ─── Verification Queue pagination (client-side, keeps DOM light) ───
  const VERIFY_PAGE_SIZE = 30;
  const [verifyPage, setVerifyPage] = useState(1);
  // ─── Verification Queue PDF export ───
  const [exportingHouseReport, setExportingHouseReport] = useState(false);

  // ─── Landlord Pending Quick Filters ───
  type PendingFilter = 'all' | 'has_address' | 'has_phone' | 'has_smartphone' | 'has_bank' | 'has_momo';
  const [pendingFilter, setPendingFilter] = useState<PendingFilter>('all');

  // ─── Landlord verification date-range filter + PDF export ───
  // Mirrors the Houses verification queue: the range is applied to the
  // landlord's STATE date (registration date for pending, decision date for
  // verified / rejected / resubmitted), never blindly to created_at.
  const [landlordDateFrom, setLandlordDateFrom] = useState<string>('');
  const [landlordDateTo, setLandlordDateTo] = useState<string>('');
  const [exportingLandlordReport, setExportingLandlordReport] = useState(false);
  // "Landlords Funded" statistics + its own comprehensive export.
  const [exportingFundedReport, setExportingFundedReport] = useState(false);

  // ─── LC1 Verification Filter ───
  // Keys on the canonical `verification_status` (verified / rejected / pending)
  // so approved chairpersons live here and rejected ones are never lost.
  type LC1VerifyFilter = 'all' | 'verified' | 'rejected' | 'pending';
  const [lc1VerifyFilter, setLc1VerifyFilter] = useState<LC1VerifyFilter>('verified');
  const [lc1Exporting, setLc1Exporting] = useState(false);

  // ─── Sorting ───
  type SortOption = 'newest' | 'oldest' | 'highest_rent' | 'recently_updated';
  const [verifySort, setVerifySort] = useState<SortOption>(() => {
    const saved = localStorage.getItem('landlordOpsVerifySort');
    if (saved === 'newest' || saved === 'oldest' || saved === 'highest_rent' || saved === 'recently_updated') return saved;
    return 'newest';
  });
  const [landlordSort, setLandlordSort] = useState<SortOption>(() => {
    const saved = localStorage.getItem('landlordOpsLandlordSort');
    if (saved === 'newest' || saved === 'oldest' || saved === 'highest_rent') return saved;
    return 'newest';
  });

  // ─── Verification date-range filter ───
  const [verifyDateFrom, setVerifyDateFrom] = useState<string>('');
  const [verifyDateTo, setVerifyDateTo] = useState<string>('');
  // Reset queue pagination whenever any filter/sort/scope changes so the user
  // never sees "Load more" leftover from a previous, larger result set.
  useEffect(() => {
    setVerifyPage(1);
  }, [verifySearch, verifyFilter, houseStatusFilter, verifyDateFrom, verifyDateTo, verifySort]);
  useEffect(() => {
    localStorage.setItem('landlordOpsVerifySort', verifySort);
  }, [verifySort]);
  useEffect(() => {
    localStorage.setItem('landlordOpsLandlordSort', landlordSort);
  }, [landlordSort]);

  // ─── Server-side landlord ops totals & paginated list ─────────────────────
  // Powers the "All Landlords" view + home KPI counters without ever loading
  // the entire landlords table client-side (33k+ rows). See mem://architecture/agent-ops-scale.
  const debouncedLandlordSearch = useDebouncedValue(search, 300);
  const { data: landlordOpsTotalsData } = useLandlordOpsTotals();
  const landlordOpsTotals = landlordOpsTotalsData?.totals;
  // ISO bounds for the landlord date range (end of the "to" day is inclusive).
  const landlordDateFromIso = landlordDateFrom ? new Date(landlordDateFrom).toISOString() : null;
  const landlordDateToIso = landlordDateTo
    ? new Date(new Date(landlordDateTo).getTime() + 24 * 60 * 60 * 1000 - 1).toISOString()
    : null;
  const landlordOpsListParams = {
    search: debouncedLandlordSearch,
    sort: (landlordSort === 'recently_updated' ? 'newest' : landlordSort) as LandlordOpsSort,
    category: (landlordCategory || 'all') as LandlordOpsCategory,
    pendingFilter: pendingFilter as LandlordOpsPendingFilter,
    page: landlordPage,
    perPage: 20,
    enabled: view === 'landlords',
    dateFrom: landlordDateFromIso,
    dateTo: landlordDateToIso,
  };
  const {
    data: landlordOpsList,
    isFetching: landlordOpsListFetching,
  } = useLandlordOpsList(landlordOpsListParams);
  // True per-status counts honouring the active search + date range, so a chip
  // and the list it opens can never disagree.
  const { data: landlordScopedCountsData, isFetching: landlordCountsFetching } = useLandlordScopedCounts({
    search: debouncedLandlordSearch,
    dateFrom: landlordDateFromIso,
    dateTo: landlordDateToIso,
    enabled: view === 'landlords',
  });
  const landlordScopedCounts = landlordScopedCountsData?.counts;
  // ─── Landlords Funded statistics (same search + date range as the tab) ───
  // A landlord is FUNDED when company money was committed to their property
  // inside the window. The RPC also returns the previous equal-length window so
  // the tile and the export can show a like-for-like comparison.
  const {
    data: landlordFundedStats,
    isFetching: landlordFundedFetching,
  } = useLandlordFundedStats({
    dateFrom: landlordDateFrom,
    dateTo: landlordDateTo,
    search: debouncedLandlordSearch,
    enabled: view === 'landlords',
  });

  /**
   * Export the full "Landlords Funded" management pack for the period on
   * screen: KPI comparisons, daily trend chart, district bar chart, and the
   * per-district / per-agent / per-service-centre tables plus the register.
   */
  const exportFundedReportPdf = async (
    overrides?: { dateFrom?: string; dateTo?: string; search?: string },
  ) => {
    const fundedFrom = overrides?.dateFrom ?? landlordDateFrom;
    const fundedTo = overrides?.dateTo ?? landlordDateTo;
    const fundedSearch = overrides?.search ?? debouncedLandlordSearch;
    setExportingFundedReport(true);
    try {
      const stats = await fetchLandlordFundedStats({
        dateFrom: fundedFrom,
        dateTo: fundedTo,
        search: fundedSearch,
      });
      if (!stats?.summary?.landlords_funded) {
        sonnerToast.error('No landlords were funded in this period — nothing to export');
        return;
      }
      const blob = generateLandlordFundedReportPdf(stats, {
        dateFrom: fundedFrom || null,
        dateTo: fundedTo || null,
        search: fundedSearch || null,
        generatedBy: user?.email ?? null,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = landlordFundedFileName({ dateFrom: fundedFrom, dateTo: fundedTo });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      sonnerToast.success(
        `Landlords funded report downloaded (${stats.summary.landlords_funded.toLocaleString()} landlords)`,
      );
    } catch (err: any) {
      sonnerToast.error(err?.message || 'Failed to generate the landlords funded report');
    } finally {
      setExportingFundedReport(false);
    }
  };
  // Reset to page 1 when the user changes any filter/search/sort.
  useEffect(() => {
    setLandlordPage(1);
  }, [debouncedLandlordSearch, landlordSort, landlordCategory, pendingFilter, landlordDateFrom, landlordDateTo]);

  /**
   * Export a fully comprehensive landlord PDF for exactly the filters on screen.
   * Pulls a dedicated report payload (verifier name, reason, location, payout
   * details, tenants, agent) via the `report` action instead of reusing the
   * paginated list rows, so the export is never a partial page.
   */
  const exportLandlordReportPdf = async (
    overrides?: {
      scope?: LandlordOpsCategory;
      pendingFilter?: LandlordOpsPendingFilter;
      search?: string;
      dateFrom?: string | null;
      dateTo?: string | null;
    },
  ) => {
    setExportingLandlordReport(true);
    try {
      const scope = (overrides?.scope ?? (landlordCategory || 'all')) as LandlordOpsCategory;
      const quick = (overrides?.pendingFilter ?? pendingFilter) as LandlordOpsPendingFilter;
      const searchTerm = overrides?.search ?? debouncedLandlordSearch;
      const fromIso = overrides ? (overrides.dateFrom ?? null) : landlordDateFromIso;
      const toIso = overrides ? (overrides.dateTo ?? null) : landlordDateToIso;
      const { rows, totalMatched } = await fetchLandlordReport({
        category: scope,
        pendingFilter: quick,
        search: searchTerm,
        dateFrom: fromIso,
        dateTo: toIso,
      });
      if (!rows.length) {
        sonnerToast.error('No landlords match these filters — nothing to export');
        return;
      }
      const blob = generateLandlordVerificationReportPdf(rows, {
        scope: scope as LandlordReportScope,
        quickFilter: scope === 'pending' ? quick : 'all',
        search: searchTerm || null,
        dateFrom: fromIso,
        dateTo: toIso,
        totalMatches: totalMatched,
        generatedBy: user?.email ?? null,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `welile-landlords-${scope}-${format(new Date(), 'yyyy-MM-dd-HHmm')}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      sonnerToast.success(`${scope} landlords report downloaded (${rows.length.toLocaleString()} landlords)`);
    } catch (err: any) {
      sonnerToast.error(err?.message || 'Failed to generate the landlord report');
    } finally {
      setExportingLandlordReport(false);
    }
  };

  // ─── All Requests delete state (mirrors Tenant Ops UX) ───
  const [allReqSelectedIds, setAllReqSelectedIds] = useState<string[]>([]);
  const [allReqDeleteDialog, setAllReqDeleteDialog] = useState<{ open: boolean; requestId: string; tenantName: string }>({ open: false, requestId: '', tenantName: '' });
  const [allReqBulkDeleteOpen, setAllReqBulkDeleteOpen] = useState(false);
  const [allReqDeleting, setAllReqDeleting] = useState(false);

  const handleDeleteOneRentRequest = async () => {
    if (!allReqDeleteDialog.requestId) return;
    setAllReqDeleting(true);
    try {
      const { error } = await supabase
        .from('rent_requests')
        .delete()
        .eq('id', allReqDeleteDialog.requestId);
      if (error) throw error;
      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'delete_rent_request_landlord_ops',
        table_name: 'rent_requests',
        record_id: allReqDeleteDialog.requestId,
        metadata: {
          reason: 'Deleted from Landlord Ops All Requests view',
          tenant_name: allReqDeleteDialog.tenantName,
        },
      });
      sonnerToast.success(`Request for "${allReqDeleteDialog.tenantName}" deleted`);
      setAllReqDeleteDialog({ open: false, requestId: '', tenantName: '' });
      queryClient.invalidateQueries({ queryKey: ['exec-landlord-ops-all-requests'] });
    } catch (e: any) {
      sonnerToast.error(e?.message || 'Failed to delete rent request');
    } finally {
      setAllReqDeleting(false);
    }
  };

  const handleBulkDeleteRentRequests = async () => {
    if (allReqSelectedIds.length === 0) return;
    setAllReqDeleting(true);
    try {
      const { error } = await supabase
        .from('rent_requests')
        .delete()
        .in('id', allReqSelectedIds);
      if (error) throw error;
      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'delete_rent_request_landlord_ops',
        table_name: 'rent_requests',
        record_id: allReqSelectedIds[0],
        metadata: {
          reason: 'Bulk deleted from Landlord Ops All Requests view',
          deleted_ids: allReqSelectedIds,
          deleted_count: allReqSelectedIds.length,
        },
      });
      sonnerToast.success(`${allReqSelectedIds.length} request${allReqSelectedIds.length === 1 ? '' : 's'} deleted`);
      setAllReqSelectedIds([]);
      setAllReqBulkDeleteOpen(false);
      queryClient.invalidateQueries({ queryKey: ['exec-landlord-ops-all-requests'] });
    } catch (e: any) {
      sonnerToast.error(e?.message || 'Failed to bulk delete rent requests');
    } finally {
      setAllReqDeleting(false);
    }
  };

  const handleAssignPerson = (listingId: string, title: string, type: 'landlord' | 'agent') => {
    setAssignPerson({ listingId, title, type });
  };

  // ─── Print Report (Landlord Payouts) state ───
  const [reportFrom, setReportFrom] = useState<Date | undefined>(undefined);
  const [reportTo, setReportTo] = useState<Date | undefined>(undefined);
  const [printingPdf, setPrintingPdf] = useState(false);
  // Which centralized extract is running (null when idle) — mirrors the Tenant
  // Ops Extract card's single busy key.
  const [extractingKind, setExtractingKind] = useState<LandlordExtractKind | null>(null);

  const handlePrintReport = async () => {
    setPrintingPdf(true);
    try {
      const fromIso = reportFrom ? reportFrom.toISOString() : null;
      const toIso = (() => {
        if (!reportTo) return null;
        const end = new Date(reportTo);
        end.setHours(23, 59, 59, 999);
        return end.toISOString();
      })();

      // 1) Pull landlord payouts from the ledger (source of truth)
      let payQ = supabase
        .from('general_ledger')
        .select('user_id, amount, transaction_date, category, direction')
        .in('category', ['landlord_payout', 'rent_disbursement'])
        .eq('direction', 'cash_out');
      if (fromIso) payQ = payQ.gte('transaction_date', fromIso);
      if (toIso) payQ = payQ.lte('transaction_date', toIso);
      const { data: payouts, error: payErr } = await payQ;
      if (payErr) throw payErr;

      if (!payouts || payouts.length === 0) {
        sonnerToast.error('No landlord payouts found for the selected period');
        return;
      }

      const landlordIds = [...new Set(payouts.map(p => p.user_id).filter(Boolean) as string[])];
      const [llRes, rrRes] = await Promise.all([
        landlordIds.length
          ? supabase.from('landlords').select('id, name, phone').in('id', landlordIds)
          : Promise.resolve({ data: [] as any[] }),
        landlordIds.length
          ? supabase.from('rent_requests')
              .select('landlord_id, rent_amount, amount_repaid, status')
              .in('landlord_id', landlordIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      const llMap = new Map(((llRes as any).data || []).map((l: any) => [l.id, l]));

      // Properties + outstanding owed per landlord (active plans only)
      const propsByLandlord = new Map<string, number>();
      const outstandingByLandlord = new Map<string, number>();
      for (const r of (((rrRes as any).data) || []) as any[]) {
        propsByLandlord.set(r.landlord_id, (propsByLandlord.get(r.landlord_id) || 0) + 1);
        if (['funded', 'disbursed', 'repaying'].includes(r.status)) {
          const out = Number(r.rent_amount || 0) - Number(r.amount_repaid || 0);
          outstandingByLandlord.set(r.landlord_id, (outstandingByLandlord.get(r.landlord_id) || 0) + Math.max(0, out));
        }
      }

      const byLandlord = new Map<string, { name: string; phone: string; paid: number; lastDate: string | null; }>();
      for (const p of payouts) {
        const id = p.user_id as string | null;
        if (!id) continue;
        const ll = llMap.get(id) as any;
        const row = byLandlord.get(id) || {
          name: (ll?.name) || '—',
          phone: (ll?.phone) || '—',
          paid: 0,
          lastDate: null as string | null,
        };
        row.paid += Number(p.amount || 0);
        if (p.transaction_date && (!row.lastDate || new Date(p.transaction_date) > new Date(row.lastDate))) {
          row.lastDate = p.transaction_date as string;
        }
        byLandlord.set(id, row);
      }

      const rows = Array.from(byLandlord.entries())
        .map(([id, l]) => ({
          landlord_name: l.name,
          landlord_phone: l.phone,
          properties: propsByLandlord.get(id) || 0,
          amount_paid_out: l.paid,
          outstanding_to_landlord: outstandingByLandlord.get(id) || 0,
          last_payout_date: l.lastDate,
        }))
        .sort((a, b) => b.amount_paid_out - a.amount_paid_out);

      const blob = generateLandlordOpsReportPdf(rows, { from: reportFrom, to: reportTo });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const suffix = reportFrom || reportTo
        ? `${reportFrom ? format(reportFrom, 'yyyy-MM-dd') : 'start'}-to-${reportTo ? format(reportTo, 'yyyy-MM-dd') : 'today'}`
        : format(new Date(), 'yyyy-MM-dd');
      a.download = `welile-landlord-payouts-${suffix}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      sonnerToast.success('Landlord Payouts Report downloaded');
    } catch (err: any) {
      sonnerToast.error(err?.message || 'Failed to generate report');
    } finally {
      setPrintingPdf(false);
    }
  };

  // ─── All Requests (landlord lens) data ───
  const { data: allRequestsRows, isLoading: allRequestsLoading } = useQuery({
    queryKey: ['exec-landlord-ops-all-requests'],
    queryFn: async () => {
      const { data } = await supabase.from('rent_requests')
        .select('id, status, rent_amount, amount_repaid, created_at, tenant_id, landlord_id, agent_id')
        .order('created_at', { ascending: false }).limit(200);
      const items = data || [];
      const tenantIds = [...new Set(items.map(r => r.tenant_id).filter(Boolean))];
      const landlordIds = [...new Set(items.map(r => r.landlord_id).filter(Boolean))];
      const agentIds = [...new Set(items.map(r => r.agent_id).filter(Boolean))];
      const [tenantsRes, landlordsRes, agentsRes] = await Promise.all([
        tenantIds.length ? supabase.from('profiles').select('id, full_name, phone').in('id', tenantIds.slice(0, 100)) : { data: [] },
        landlordIds.length ? supabase.from('landlords').select('id, name, phone').in('id', landlordIds.slice(0, 100)) : { data: [] },
        agentIds.length ? supabase.from('profiles').select('id, full_name').in('id', agentIds.slice(0, 100)) : { data: [] },
      ]);
      const tMap = new Map(((tenantsRes as any).data || []).map((p: any) => [p.id, p]));
      const lMap = new Map(((landlordsRes as any).data || []).map((l: any) => [l.id, l]));
      const aMap = new Map(((agentsRes as any).data || []).map((a: any) => [a.id, a]));
      return items.map(r => ({
        ...r,
        tenant_name: (tMap.get(r.tenant_id) as any)?.full_name || '—',
        tenant_phone: (tMap.get(r.tenant_id) as any)?.phone || '—',
        landlord_name: (lMap.get(r.landlord_id) as any)?.name || '—',
        landlord_phone: (lMap.get(r.landlord_id) as any)?.phone || '—',
        agent_name: r.agent_id ? ((aMap.get(r.agent_id) as any)?.full_name || '—') : 'Unassigned',
      }));
    },
    enabled: view === 'all-requests' || view === 'home',
    staleTime: 600000,
  });

  const allRequestsColumns: Column<any>[] = [
    { key: 'created_at', label: 'Date', render: (v) => v ? format(new Date(v as string), 'dd MMM yy') : '—' },
    { key: 'tenant_name', label: 'Tenant' },
    { key: 'tenant_phone', label: 'Phone' },
    { key: 'status', label: 'Status', render: (v) => {
      const colors: Record<string, string> = {
        pending: 'bg-amber-100 text-amber-700',
        tenant_ops_approved: 'bg-blue-100 text-blue-700',
        agent_verified: 'bg-purple-100 text-purple-700',
        landlord_ops_approved: 'bg-indigo-100 text-indigo-700',
        coo_approved: 'bg-emerald-100 text-emerald-700',
        funded: 'bg-green-100 text-green-700',
        disbursed: 'bg-teal-100 text-teal-700',
        repaying: 'bg-purple-100 text-purple-700',
        fully_repaid: 'bg-emerald-100 text-emerald-700',
        defaulted: 'bg-destructive/10 text-destructive',
      };
      return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[String(v)] || 'bg-muted'}`}>{String(v).replace(/_/g, ' ')}</span>;
    }},
    { key: 'rent_amount', label: 'Amount', render: (v) => Number(v || 0).toLocaleString() },
    { key: 'amount_repaid', label: 'Repaid', render: (v) => Number(v || 0).toLocaleString() },
    { key: 'agent_name', label: 'Current Agent', render: (v) => (
      <span className={`text-xs ${v === 'Unassigned' ? 'text-muted-foreground italic' : 'font-medium'}`}>{String(v ?? '—')}</span>
    )},
    { key: 'landlord_name', label: 'Landlord' },
    { key: 'landlord_phone', label: 'L. Phone' },
    { key: 'id', label: 'Action', render: (_v, row) => (
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={(e) => {
          e.stopPropagation();
          setAllReqDeleteDialog({ open: true, requestId: String(row.id), tenantName: row.tenant_name || 'Unknown' });
        }}
      >
        <Trash2 className="h-3.5 w-3.5 mr-1" />
        Delete
      </Button>
    )},
  ];

  // ─── House Listings Query ───
  const { data: listings, isLoading, refetch } = useQuery({
    queryKey: ['exec-house-listings-ops'],
    queryFn: async () => {
      const { data } = await supabase.from('house_listings')
        .select(HOUSE_LISTING_SELECT)
        // Houses still in Service Centre vetting are not yet Landlord Ops' to see.
        .in('service_center_status', ['not_required', 'passed'])
        .order('created_at', { ascending: false })
        .limit(500);
      const rows = (data ?? []) as any[];
      const maps = await fetchListingProfileMaps(rows);
      return enrichListingsWithProfiles(rows, maps) as ListingWithLandlord[];
    },
    staleTime: 60000,
  });

  // ─── Pending (unverified) listings — dedicated fetch ───
  // The primary `exec-house-listings-ops` query only pulls the 500 most-recent
  // house_listings, mixing verified + unverified together. With 20k+ unverified
  // houses in the DB, that meant the Verification Queue was silently showing
  // only a tiny slice of pending houses. This query fetches unverified listings
  // directly (status not rejected/delisted) with a much larger cap so ops sees
  // the real backlog.
  const { data: pendingListings } = useQuery({
    queryKey: ['exec-house-listings-pending'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data } = await supabase.from('house_listings')
        .select(HOUSE_LISTING_SELECT)
        .eq('verified', false)
        .not('status', 'in', '(rejected,delisted)')
        // Houses still sitting with a Service Centre manager are not yet ours to verify.
        .in('service_center_status', ['not_required', 'passed'])
        .order('created_at', { ascending: false })
        .limit(2000);
      const rows = (data ?? []) as any[];
      const maps = await fetchListingProfileMaps(rows);
      return enrichListingsWithProfiles(rows, maps) as ListingWithLandlord[];
    },
  });

  // TRUE server-side count of houses awaiting verification. The list queries
  // above are capped (client pagination), so their length must never be used
  // as the backlog figure — it silently plateaus at the cap.
  const { data: pendingHousesCount = 0 } = useQuery({
    queryKey: ['exec-house-listings-pending-count'],
    staleTime: 60_000,
    queryFn: async () => {
      const { count } = await supabase
        .from('house_listings')
        .select('id', { count: 'exact', head: true })
        .eq('verified', false)
        .not('status', 'in', '(rejected,delisted)')
        .in('service_center_status', ['not_required', 'passed']);
      return count || 0;
    },
  });

  // ─── Global Verification Search (across ALL agents/listings, not just the 500 most recent) ───
  const debouncedVerifySearch = useDebouncedValue(verifySearch.trim(), 300);
  const { data: globalSearchListings, isFetching: isGlobalSearching } = useQuery({
    queryKey: ['exec-house-listings-global-search', debouncedVerifySearch],
    enabled: debouncedVerifySearch.length >= 2,
    staleTime: 30_000,
    queryFn: async () => {
      const q = debouncedVerifySearch;
      const like = `%${q}%`;

      // 1) Find matching agents/landlords by name/phone
      const [agentProfiles, landlordMatches] = await Promise.all([
        supabase.from('profiles').select('id, full_name, phone, email')
          .or(`full_name.ilike.${like},phone.ilike.${like}`).limit(200),
        // Trigram-indexed RPC — replaces the raw OR-ILIKE that was the #1 DB CPU offender.
        supabase.rpc('search_landlords_fuzzy', { p_query: q, p_limit: 200, p_threshold: 0.15 }),
      ]);
      const agentIds = (agentProfiles.data || []).map(p => p.id);
      const landlordIds = (landlordMatches.data || []).map(l => l.id);

      // 2) Fetch listings that match by agent id, landlord id, or listing text fields
      const orParts: string[] = [
        `title.ilike.${like}`, `district.ilike.${like}`, `village.ilike.${like}`,
        `region.ilike.${like}`, `address.ilike.${like}`,
        `lc1_chairperson_name.ilike.${like}`, `lc1_chairperson_phone.ilike.${like}`,
      ];
      if (agentIds.length) orParts.push(`agent_id.in.(${agentIds.join(',')})`);
      if (landlordIds.length) orParts.push(`landlord_id.in.(${landlordIds.join(',')})`);

      const { data } = await supabase.from('house_listings')
        .select(HOUSE_LISTING_SELECT)
        .or(orParts.join(','))
        .in('service_center_status', ['not_required', 'passed'])
        .order('created_at', { ascending: false })
        .limit(500);

      const rows = (data ?? []) as any[];
      // Seed the agent map with what we already resolved so we don't refetch.
      const seed = new Map<string, any>((agentProfiles.data || []).map((p: any) => [p.id, p]));
      const maps = await fetchListingProfileMaps(rows);
      // Merge the pre-resolved agent profiles that fetchListingProfileMaps missed
      // (agents matched by the search but with no listing in the result set).
      seed.forEach((v, k) => { if (!maps.agentMap.has(k)) maps.agentMap.set(k, v); });
      return enrichListingsWithProfiles(rows, maps) as ListingWithLandlord[];
    },
  });

  // ─── Global Date-Range Fetch (across ALL listings, not just latest 500) ───
  const { data: globalDateRangeListings, isFetching: isDateRangeFetching } = useQuery({
    queryKey: ['exec-house-listings-date-range', verifyDateFrom, verifyDateTo],
    enabled: !!(verifyDateFrom || verifyDateTo),
    staleTime: 30_000,
    queryFn: async () => {
      let query = supabase.from('house_listings')
        .select(HOUSE_LISTING_SELECT)
        .in('service_center_status', ['not_required', 'passed'])
        .order('created_at', { ascending: false })
        .limit(2000);
      if (verifyDateFrom) query = query.gte('created_at', new Date(verifyDateFrom).toISOString());
      if (verifyDateTo) {
        const to = new Date(verifyDateTo).getTime() + 24 * 60 * 60 * 1000 - 1;
        query = query.lte('created_at', new Date(to).toISOString());
      }
      const { data } = await query;
      const rows = (data ?? []) as any[];
      const maps = await fetchListingProfileMaps(rows);
      return enrichListingsWithProfiles(rows, maps) as ListingWithLandlord[];
    },
  });

  // ─── Server-side paginated house search (status + term + date + sort) ───
  // Replaces the capped client-side slices: the DB resolves the scope and
  // returns both the page and the TRUE total match count, so operators see
  // every house, not the latest 500/1000.
  const verifyDateFromIso = verifyDateFrom ? new Date(verifyDateFrom).toISOString() : null;
  const verifyDateToIso = verifyDateTo
    ? new Date(new Date(verifyDateTo).getTime() + 24 * 60 * 60 * 1000 - 1).toISOString()
    : null;
  const serverSearchTerm = debouncedVerifySearch.length >= 2 ? debouncedVerifySearch : null;

  /**
   * Export a fully comprehensive PDF for exactly the filters on screen.
   * Pulls a dedicated report payload (verifier/rejector names, reasons,
   * location, GPS, payout details) from `ops_house_listing_report` instead of
   * reusing the paginated queue rows, so the export is never a partial page.
   */
  const exportHouseReportPdf = async (
    overrides?: {
      status?: HouseStatusFilter;
      quick?: VerifyFilter;
      search?: string | null;
      dateFrom?: string | null;
      dateTo?: string | null;
    },
  ) => {
    const scope = overrides?.status ?? houseStatusFilter;
    const quick = overrides?.quick ?? verifyFilter;
    const searchTerm = overrides ? (overrides.search ?? null) : serverSearchTerm;
    const fromIso = overrides ? (overrides.dateFrom ?? null) : verifyDateFromIso;
    const toIso = overrides ? (overrides.dateTo ?? null) : verifyDateToIso;
    setExportingHouseReport(true);
    try {
      const { data, error } = await (supabase.rpc as any)('ops_house_listing_report', {
        p_status: scope,
        p_search: searchTerm,
        p_date_from: fromIso,
        p_date_to: toIso,
        p_quick: quick,
        p_limit: 10000,
      });
      if (error) throw error;
      const payload = (data || []) as any[];
      const reportRows = payload.map(r => (r.row_data ?? r) as HouseReportRow);
      const trueTotal = Number(payload[0]?.total_count ?? reportRows.length);
      if (!reportRows.length) {
        sonnerToast.error('No houses match these filters — nothing to export');
        return;
      }
      const blob = generateHouseVerificationReportPdf(reportRows, {
        scope,
        quickFilter: quick,
        search: searchTerm,
        dateFrom: fromIso,
        dateTo: toIso,
        totalMatches: trueTotal,
        generatedBy: user?.email ?? null,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `welile-houses-${scope}-${format(new Date(), 'yyyy-MM-dd-HHmm')}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      sonnerToast.success(`${scope} houses report downloaded (${reportRows.length.toLocaleString()} houses)`);
    } catch (err: any) {
      sonnerToast.error(err?.message || 'Failed to generate the house report');
    } finally {
      setExportingHouseReport(false);
    }
  };

  const {
    data: houseSearchPages,
    isFetching: isHouseSearchFetching,
    fetchNextPage: fetchMoreHouses,
    isFetchingNextPage: isFetchingMoreHouses,
    hasNextPage: hasMoreHousePages,
  } = useInfiniteQuery({
    queryKey: ['ops-house-search', houseStatusFilter, verifyFilter, serverSearchTerm, verifyDateFromIso, verifyDateToIso, verifySort],
    enabled: view === 'verify',
    staleTime: 30_000,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const offset = Number(pageParam) || 0;
      const { data, error } = await (supabase.rpc as any)('ops_search_house_listings', {
        p_status: houseStatusFilter,
        p_search: serverSearchTerm,
        p_date_from: verifyDateFromIso,
        p_date_to: verifyDateToIso,
        p_sort: verifySort,
        p_limit: VERIFY_PAGE_SIZE,
        p_offset: offset,
        p_quick: verifyFilter,
      });
      if (error) throw error;
      const pageRows = (data || []) as any[];
      return {
        listings: pageRows.map(r => r.listing as ListingWithLandlord),
        total: Number(pageRows[0]?.total_count ?? 0),
        offset,
      };
    },
    getNextPageParam: (last: any) => {
      const next = last.offset + VERIFY_PAGE_SIZE;
      return next < last.total ? next : undefined;
    },
  });

  const serverHouseRows = useMemo(
    () => ((houseSearchPages?.pages || []) as any[]).flatMap(p => p.listings as ListingWithLandlord[]),
    [houseSearchPages],
  );
  const serverHouseTotal = Number(((houseSearchPages?.pages || []) as any[])[0]?.total ?? 0);

  // True per-status totals for the chips, honouring the active search/date range.
  const { data: houseStatusCounts } = useQuery({
    queryKey: ['ops-house-status-counts', serverSearchTerm, verifyDateFromIso, verifyDateToIso],
    enabled: view === 'verify',
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('ops_house_listing_status_counts', {
        p_search: serverSearchTerm,
        p_date_from: verifyDateFromIso,
        p_date_to: verifyDateToIso,
      });
      if (error) throw error;
      const r = ((data || []) as any[])[0] || {};
      return {
        pending: Number(r.pending || 0),
        verified: Number(r.verified || 0),
        hidden: Number(r.hidden || 0),
        rejected: Number(r.rejected || 0),
        all: Number(r.all_houses || 0),
      };
    },
  });

  // True quick-filter totals for the active status scope (server-side).
  const { data: houseQuickCounts } = useQuery({
    queryKey: ['ops-house-quick-counts', houseStatusFilter, serverSearchTerm, verifyDateFromIso, verifyDateToIso],
    enabled: view === 'verify',
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('ops_house_quick_filter_counts', {
        p_status: houseStatusFilter,
        p_search: serverSearchTerm,
        p_date_from: verifyDateFromIso,
        p_date_to: verifyDateToIso,
      });
      if (error) throw error;
      const r = ((data || []) as any[])[0] || {};
      return {
        all: Number(r.all_scope || 0),
        has_landlord: Number(r.has_landlord || 0),
        no_landlord: Number(r.no_landlord || 0),
        has_images: Number(r.has_images || 0),
        has_gps: Number(r.has_gps || 0),
        has_lc1: Number(r.has_lc1 || 0),
        hidden: Number(r.hidden_scope || 0),
        visible: Number(r.visible_scope || 0),
      };
    },
  });

  // ─── All Landlords Direct Query ───
  const { data: allLandlords, refetch: refetchLandlords } = useQuery({
    queryKey: ['landlord-ops-all-landlords'],
    queryFn: async () => {
      const PAGE_SIZE = 1000;
      let allData: any[] = [];
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const { data, error } = await supabase
          .from('landlords')
          .select('id, name, phone, verified, has_smartphone, mobile_money_name, mobile_money_number, number_of_houses, bank_name, account_number, monthly_rent, caretaker_name, caretaker_phone, tin, electricity_meter_number, water_meter_number, village, district, region, property_address, tenant_id, registered_by, managed_by_agent_id, house_category, number_of_rooms, created_at')
          .order('created_at', { ascending: false })
          .range(offset, offset + PAGE_SIZE - 1);
        if (error) {
          console.error('Landlords query error:', error);
          hasMore = false;
          break;
        }
        if (data && data.length > 0) {
          allData.push(...data);
          offset += PAGE_SIZE;
          hasMore = data.length === PAGE_SIZE;
        } else {
          hasMore = false;
        }
      }

      // Collect all landlord IDs to fetch tenants
      const landlordIds = allData.map(l => l.id);

      // Fetch tenant mappings from house_listings
      const landlordTenantsRaw: { landlord_id: string; tenant_id: string }[] = [];
      for (let i = 0; i < landlordIds.length; i += 50) {
        const { data: hlData } = await supabase
          .from('house_listings')
          .select('landlord_id, tenant_id')
          .in('landlord_id', landlordIds.slice(i, i + 50))
          .not('tenant_id', 'is', null);
        if (hlData) landlordTenantsRaw.push(...(hlData as any[]));
      }

      // Also fetch tenant-landlord links from rent_requests (primary linkage)
      const tenantStatusMap = new Map<string, string>();
      for (let i = 0; i < landlordIds.length; i += 50) {
        const { data: rrData } = await supabase
          .from('rent_requests')
          .select('landlord_id, tenant_id, status')
          .in('landlord_id', landlordIds.slice(i, i + 50))
          .not('tenant_id', 'is', null);
        if (rrData) {
          (rrData as any[]).forEach(r => {
            landlordTenantsRaw.push({ landlord_id: r.landlord_id, tenant_id: r.tenant_id });
            if (r.tenant_id && r.status) tenantStatusMap.set(r.tenant_id, r.status);
          });
        }
      }

      // Build landlord -> tenant_ids map
      const landlordTenantIdsMap = new Map<string, Set<string>>();
      landlordTenantsRaw.forEach(hl => {
        if (!hl.tenant_id) return;
        if (!landlordTenantIdsMap.has(hl.landlord_id)) landlordTenantIdsMap.set(hl.landlord_id, new Set());
        landlordTenantIdsMap.get(hl.landlord_id)!.add(hl.tenant_id);
      });

      // Collect all profile IDs to batch-fetch
      const profileIds = new Set<string>();
      allData.forEach(l => {
        if (l.tenant_id) profileIds.add(l.tenant_id);
        if (l.registered_by) profileIds.add(l.registered_by);
        if (l.managed_by_agent_id) profileIds.add(l.managed_by_agent_id);
      });
      // Add tenant IDs from house_listings
      landlordTenantsRaw.forEach(hl => { if (hl.tenant_id) profileIds.add(hl.tenant_id); });

      const idArr = [...profileIds];
      const profileMap = new Map<string, { full_name: string | null; phone: string | null }>();
      // Batch fetch in chunks of 50
      for (let i = 0; i < idArr.length; i += 50) {
        const { data: profiles } = await supabase.from('profiles').select('id, full_name, phone').in('id', idArr.slice(i, i + 50));
        if (profiles) profiles.forEach(p => profileMap.set(p.id, p));
      }

      return allData.map(l => {
        // Get all tenants from house_listings for this landlord
        const tenantIdSet = landlordTenantIdsMap.get(l.id);
        const tenants: { id: string; name: string; phone: string | null; status: string }[] = [];
        if (tenantIdSet) {
          tenantIdSet.forEach(tid => {
            const p = profileMap.get(tid);
            tenants.push({ id: tid, name: p?.full_name || 'Unknown', phone: p?.phone || null, status: tenantStatusMap.get(tid) || 'listed' });
          });
        }
        // Fallback: if no house_listings tenants but landlord has tenant_id
        if (tenants.length === 0 && l.tenant_id) {
          const p = profileMap.get(l.tenant_id);
          if (p) tenants.push({ id: l.tenant_id, name: p.full_name || 'Unknown', phone: p.phone || null, status: tenantStatusMap.get(l.tenant_id) || 'listed' });
        }

        return {
          ...l,
          tenants,
          tenant_name: l.tenant_id ? (profileMap.get(l.tenant_id)?.full_name || null) : null,
          tenant_phone_profile: l.tenant_id ? (profileMap.get(l.tenant_id)?.phone || null) : null,
          agent_name: (l.managed_by_agent_id ? profileMap.get(l.managed_by_agent_id)?.full_name : null) || (l.registered_by ? profileMap.get(l.registered_by)?.full_name : null) || null,
          agent_phone: (l.managed_by_agent_id ? profileMap.get(l.managed_by_agent_id)?.phone : null) || (l.registered_by ? profileMap.get(l.registered_by)?.phone : null) || null,
        };
      });
    },
    staleTime: 60000,
    // Only load the full landlord set when a view actually needs to iterate over
    // every row (occupied/empty lists, or a shared entity deep-link resolver).
    // The primary "All Landlords" list is now server-paginated via `landlord-ops`.
    enabled: view === 'occupied' || view === 'empty' || !!searchParams.get('eid'),
  });

  // ─── Rent Requests without Landlord Query ───
  const { data: noLandlordTenants } = useQuery({
    queryKey: ['landlord-ops-no-landlord'],
    queryFn: async () => {
      // Get rent requests that have NO house_listing with a landlord linked
      const { data: requests } = await supabase
        .from('rent_requests')
        .select('id, tenant_id, agent_id, rent_amount, request_city, house_category, status, created_at')
        .in('status', ['pending', 'approved', 'funded', 'repaying'])
        .order('created_at', { ascending: false })
        .limit(500);

      if (!requests?.length) return [];

      // Get all house listings with landlord for these tenants
      const tenantIds = [...new Set(requests.map(r => r.tenant_id))];
      const { data: listingsWithLandlord } = await supabase
        .from('house_listings')
        .select('tenant_id, landlord_id')
        .in('tenant_id', tenantIds)
        .not('landlord_id', 'is', null);

      const tenantsWithLandlord = new Set((listingsWithLandlord || []).map(l => l.tenant_id));

      // Filter to only those without landlord
      const withoutLandlord = requests.filter(r => !tenantsWithLandlord.has(r.tenant_id));
      if (!withoutLandlord.length) return [];

      // Fetch profiles for tenants and agents
      const allTenantIds = [...new Set(withoutLandlord.map(r => r.tenant_id))];
      const allAgentIds = [...new Set(withoutLandlord.map(r => r.agent_id).filter(Boolean))] as string[];
      const allIds = [...new Set([...allTenantIds, ...allAgentIds])];

      const { data: profiles } = allIds.length
        ? await supabase.from('profiles').select('id, full_name, phone').in('id', allIds)
        : { data: [] };

      const profileMap = new Map((profiles || []).map(p => [p.id, p]));

      return withoutLandlord.map(r => ({
        id: r.id,
        tenant_id: r.tenant_id,
        tenant_name: profileMap.get(r.tenant_id)?.full_name || 'Unknown Tenant',
        tenant_phone: profileMap.get(r.tenant_id)?.phone || null,
        agent_id: r.agent_id,
        agent_name: r.agent_id ? (profileMap.get(r.agent_id)?.full_name || null) : null,
        agent_phone: r.agent_id ? (profileMap.get(r.agent_id)?.phone || null) : null,
        rent_amount: r.rent_amount,
        request_city: r.request_city,
        house_category: r.house_category,
        status: r.status,
        created_at: r.created_at,
      })) as TenantWithoutLandlord[];
    },
    staleTime: 60000,
  });

  // Merge the dedicated pending-listings fetch into the primary rows so the
  // Verification Queue sees the full unverified backlog, not just the slice
  // that happens to fall inside the 500 most-recent house_listings.
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const merged: ListingWithLandlord[] = [];
    for (const l of [...(listings || []), ...(pendingListings || [])]) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      merged.push(l);
    }
    return merged;
  }, [listings, pendingListings]);
  const landlordsList = allLandlords || [];
  const noLandlordList = noLandlordTenants || [];
  // Server-derived counts (constant-time, no full-table pull). Used by home KPIs
  // and the "All Landlords" list category chips. Fall back to landlordsList
  // counts only for the occupied/empty views where the full set is already loaded.
  // Counts ALWAYS come from the server (same query definition as the list).
  // `undefined` means "not loaded yet" and renders a skeleton — we never swap
  // in a client-side filter over a partial page, which produced wrong numbers.
  const totalLandlordsCount = landlordOpsTotals?.total;
  const verifiedLandlordsCount = landlordOpsTotals?.verified;
  const pendingLandlordsCount = landlordOpsTotals?.pending;
  const rejectedLandlordsCount = landlordOpsTotals?.rejected;
  const verifiedHumanCount = landlordOpsTotals?.verified_human;
  const verifiedAutoCount = landlordOpsTotals?.verified_auto;
  const smartphoneLandlordsCount = landlordOpsTotals?.smartphone;
  const occupiedLandlordsCount = landlordOpsTotals?.has_tenants;
  const emptyLandlordsCount = landlordOpsTotals?.no_tenants;
  const occupiedMonthlyRevenue = landlordOpsTotals?.occupied_monthly_revenue;
  const emptyMonthlyRevenue = landlordOpsTotals?.empty_monthly_revenue;
  // Any KPI sourced from the totals RPC shows a skeleton until the exact
  // server number is available — never a stale or partial client estimate.
  const totalsLoading = isLoading || landlordOpsTotals === undefined;
  const kpi = (n: number | undefined) => (n === undefined ? '—' : n.toLocaleString());
  const unverifiedListings = rows.filter(l =>
    !l.verified
    && l.status !== 'rejected'
    && l.status !== 'delisted'
    && !optimisticallyVerifiedIds.has(l.id)
  );
  const verifiedListings = rows.filter(l => l.verified && l.status !== 'rejected' && l.status !== 'delisted');
  const hiddenListings = rows.filter(l => l.is_hidden && l.status !== 'rejected' && l.status !== 'delisted');
  const rejectedListings = rows.filter(l => l.status === 'rejected');
  const withImages = rows.filter(l => l.image_urls && l.image_urls.length > 0);
  const withGPS = rows.filter(l => l.latitude && l.longitude);
  const emptyHouses = rows.filter(l => l.status === 'available' && !l.tenant_id);
  const occupiedHouses = rows.filter(l => l.tenant_id);

  // Landlord-level occupied/empty derived from tenants array (includes rent_requests linkage)
  const occupiedLandlords = landlordsList.filter(l => l.tenants && l.tenants.length > 0);
  const emptyLandlords = landlordsList.filter(l => !l.tenants || l.tenants.length === 0);

  // House count per landlord from house_listings
  const landlordHouseCounts = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach(r => {
      if (r.landlord_id) map.set(r.landlord_id, (map.get(r.landlord_id) || 0) + 1);
    });
    return map;
  }, [rows]);

  // Location grouping
  const locationGroups = useMemo(() => {
    const map = new Map<string, { region: string; district: string | null; count: number; occupied: number; empty: number }>();
    rows.forEach(r => {
      const key = `${r.region}|${r.district || ''}`;
      const existing = map.get(key);
      const isOccupied = !!r.tenant_id;
      if (existing) {
        existing.count++;
        if (isOccupied) existing.occupied++; else existing.empty++;
      } else {
        map.set(key, { region: r.region, district: r.district, count: 1, occupied: isOccupied ? 1 : 0, empty: isOccupied ? 0 : 1 });
      }
    });
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [rows]);

  // ─── Cities grouping (from listings + rent requests) ───
  const cityGroups = useMemo(() => {
    const map = new Map<string, { city: string; listingCount: number; tenantCount: number }>();
    // From house listings
    rows.forEach(r => {
      const city = r.region?.trim();
      if (!city) return;
      const existing = map.get(city.toLowerCase());
      if (existing) {
        existing.listingCount++;
      } else {
        map.set(city.toLowerCase(), { city, listingCount: 1, tenantCount: 0 });
      }
    });
    // From rent requests (request_city)
    noLandlordList.forEach(r => {
      const city = r.request_city?.trim();
      if (!city) return;
      const key = city.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        existing.tenantCount++;
      } else {
        map.set(key, { city, listingCount: 0, tenantCount: 1 });
      }
    });
    return [...map.values()].sort((a, b) => (b.listingCount + b.tenantCount) - (a.listingCount + a.tenantCount));
  }, [rows, noLandlordList]);

  // Restore an entity detail sheet from a shared deep link (?entity=…&eid=…).
  const entityParam = searchParams.get('entity') as 'city' | 'no-landlord' | 'landlord' | 'tenant' | null;
  const eidParam = searchParams.get('eid');
  useEffect(() => {
    if (!entityParam || !eidParam) return;
    if (entityDetail) return; // already open
    if (entityParam === 'city') {
      const c = cityGroups.find(g => g.city === eidParam);
      if (c) { setView('cities'); setEntityDetail({ type: 'city', data: c }); }
    } else if (entityParam === 'no-landlord') {
      const t = noLandlordList.find(r => r.id === eidParam);
      if (t) { setView('no-landlord'); setEntityDetail({ type: 'no-landlord', data: t }); }
    } else if (entityParam === 'landlord') {
      const l = landlordsList.find(x => x.id === eidParam);
      if (l) {
        setView(l.tenants && l.tenants.length > 0 ? 'occupied' : 'empty');
        setEntityDetail({ type: 'landlord', data: l });
      }
    } else if (entityParam === 'tenant') {
      for (const l of landlordsList) {
        const tn = (l.tenants || []).find((t: any) => t.id === eidParam);
        if (tn) { setEntityDetail({ type: 'tenant', data: { ...tn, landlord_name: l.name } }); break; }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityParam, eidParam, cityGroups, noLandlordList, landlordsList]);

  // LC1 grouping from house_listings (kept for backward compat)
  const lc1GroupsFromListings = useMemo(() => {
    const map = new Map<string, { name: string; phone: string | null; village: string | null; houseCount: number; listingIds: string[] }>();
    rows.forEach(r => {
      if (!r.lc1_chairperson_name) return;
      const key = `${r.lc1_chairperson_name}|${r.lc1_chairperson_phone || ''}`;
      const existing = map.get(key);
      if (existing) {
        existing.houseCount++;
        existing.listingIds.push(r.id);
      } else {
        map.set(key, { name: r.lc1_chairperson_name, phone: r.lc1_chairperson_phone, village: r.lc1_chairperson_village, houseCount: 1, listingIds: [r.id] });
      }
    });
    return [...map.values()].sort((a, b) => b.houseCount - a.houseCount);
  }, [rows]);

  // ─── Full LC1 Chairpersons Query (from lc1_chairpersons table) ───
  const { data: fullLC1Data, refetch: refetchLC1 } = useQuery({
    queryKey: ['landlord-ops-full-lc1'],
    queryFn: async () => {
      // 1. Fetch all LC1 chairpersons
      const allLC1: { id: string; name: string; phone: string; village: string; created_at: string; verified: boolean | null; registered_by: string | null; verification_status: string | null; verification_reason: string | null }[] = [];
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const { data, error } = await supabase.from('lc1_chairpersons')
          .select('id, name, phone, village, created_at, verified, registered_by, verification_status, verification_reason')
          .order('name').range(offset, offset + 999);
        if (error) { console.error('[LC1] fetch error', error); break; }
        if (data && data.length > 0) { allLC1.push(...data as any); offset += 1000; hasMore = data.length === 1000; }
        else hasMore = false;
      }

      // Enrichment (landlord links + registering agent) is intentionally skipped here.
      // With ~15k LC1 rows the previous batches (rent_requests / landlords / profiles in .in()
      // chunks of 50) fired 300+ sequential requests and stalled the UI, leaving the list empty.
      // Landlord links are still available via `lc1GroupsFromListings` (phone match) and the
      // per-LC1 detail view. Agent contact chip on unverified rows is hidden until we add a
      // paginated server-side enrichment.
      const lc1PhoneToListings = new Map<string, string[]>();
      rows.forEach(r => {
        if (!r.lc1_chairperson_phone) return;
        const arr = lc1PhoneToListings.get(r.lc1_chairperson_phone) || [];
        arr.push(r.id);
        lc1PhoneToListings.set(r.lc1_chairperson_phone, arr);
      });
      return allLC1.map(lc1 => ({
        ...lc1,
        landlords: [] as { id: string; name: string; phone: string; property_address: string; verified: boolean | null; village: string | null }[],
        listingIds: lc1PhoneToListings.get(lc1.phone) || [],
        agentName: null as string | null,
        agentPhone: null as string | null,
      }));
    },
    staleTime: 60000,
    enabled: view === 'lc1' || view === 'lc1-duplicates' || view === 'home',
  });

  // ─── Paid Landlords Count (for nav badge) ───
  const { data: paidLandlordsCount } = useQuery({
    queryKey: ['landlord-ops-paid-landlords-count'],
    queryFn: async () => {
      const { data } = await supabase
        .from('disbursement_records')
        .select('landlord_id')
        .not('landlord_id', 'is', null);
      const set = new Set<string>();
      (data || []).forEach((r: any) => { if (r.landlord_id) set.add(r.landlord_id); });
      return set.size;
    },
    staleTime: 60_000,
  });

  // ─── Landlords actually awaiting verification (pending verification requests) ───
  // The home card must reflect ONLY landlords with an open verification request,
  // not every auto-registered unverified landlord.
  const { data: pendingVerificationCount = 0 } = useQuery({
    queryKey: ['landlord-ops-pending-verification-count'],
    queryFn: async () => {
      const { count } = await supabase
        .from('landlords')
        .select('id', { count: 'exact', head: true })
        // Still with a Service Centre manager → not yet Landlord Ops work.
        .neq('service_center_status', 'pending')
        .or('verified.is.null,verified.eq.false');
      return count || 0;
    },
    staleTime: 30_000,
  });

  const lc1Groups = fullLC1Data || [];

  /**
   * The LC1 verification export, hoisted to component scope so both the LC1
   * register and the centralized Reports & Exports → Extract card call exactly
   * the same logic (same RPC, same generator, same file name).
   */
  const exportLc1ReportPdf = async (scope: 'verified' | 'rejected' | 'pending' | 'all') => {
    setLc1Exporting(true);
    try {
      const { data, error } = await supabase.rpc('ops_lc1_verification_report' as any, {
        p_status: scope,
        p_search: search.trim().length >= 2 ? search.trim() : null,
        p_limit: 3000,
      } as any);
      if (error) throw error;
      const reportRows = (data ?? []) as Lc1ReportRow[];
      const state = (g: { verified: boolean | null; verification_status?: string | null }) =>
        (g.verification_status as string | null) || (g.verified ? 'verified' : 'pending');
      const scopedCount = scope === 'all'
        ? lc1Groups.length
        : lc1Groups.filter(g => state(g) === scope).length;
      const blob = generateLc1VerificationReportPdf(reportRows, {
        scope,
        search: search.trim().length >= 2 ? search.trim() : null,
        totalMatches: scopedCount,
        generatedBy: (user as any)?.email ?? null,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = lc1ReportFileName(scope);
      a.click();
      URL.revokeObjectURL(url);
      sonnerToast.success(`${reportRows.length.toLocaleString()} LC1 chairpersons exported`);
    } catch (e: any) {
      sonnerToast.error(e?.message || 'Could not build the LC1 report');
    } finally {
      setLc1Exporting(false);
    }
  };

  const verifiedLandlords = landlordsList.filter(l => l.verified);
  const unverifiedLandlords = landlordsList.filter(l => !l.verified);
  const smartphoneLandlords = landlordsList.filter(l => l.has_smartphone);

  const handleVerifyListing = async (listing: ListingWithLandlord, note?: string) => {
    console.log('[Verify] click', listing.id, listing.title);
    if (!user) return;
    // INSTANT UX: hide the card immediately, show a toast right now, run the
    // edge function in the background. If it fails, restore the card and
    // surface the error.
    setOptimisticallyVerifiedIds(prev => {
      const next = new Set(prev);
      next.add(listing.id);
      return next;
    });
    toast({
      title: '✅ Verified → UGX 2,000 Credited',
      description: `${listing.title} verified. UGX 2,000 credited to the agent's commission wallet.`,
    });
    try {
      const { data, error } = await supabase.functions.invoke('credit-listing-bonus', {
        body: { listing_id: listing.id },
      });
      console.log('[handleVerifyListing] Response:', { data, error });
      if (error) {
        const { extractFromErrorObject } = await import('@/lib/extractEdgeFunctionError');
        const msg = await extractFromErrorObject(error, 'Verification failed');
        console.error('[handleVerifyListing] Edge function error:', msg, error);
        throw new Error(msg);
      }
      if (data?.error) {
        console.error('[handleVerifyListing] Data error:', data.error);
        throw new Error(data.error);
      }
      // Permanently remove from the pending list by patching the cache directly,
      // then trigger a background refetch to reconcile related fields.
      queryClient.setQueryData<any[]>(['exec-house-listings-ops'], (old) => {
        if (!Array.isArray(old)) return old;
        return old.map(l => l.id === listing.id ? { ...l, verified: true, listing_bonus_paid: true } : l);
      });
      queryClient.setQueryData<any[]>(['exec-house-listings-pending'], (old) => {
        if (!Array.isArray(old)) return old;
        return old.filter(l => l.id !== listing.id);
      });
      // Drop the row from the server-side verification queue pages immediately so
      // the card disappears without a manual page refresh. The id stays in the
      // optimistic set as a belt-and-braces guard until the refetch lands.
      queryClient.setQueriesData<any>({ queryKey: ['ops-house-search'] }, (old: any) => {
        if (!old?.pages) return old;
        return {
          ...old,
          pages: old.pages.map((p: any) => ({
            ...p,
            listings: (p.listings || []).filter((l: any) => l.id !== listing.id),
            total: Math.max(0, Number(p.total || 0) - 1),
          })),
        };
      });
      queryClient.invalidateQueries({ queryKey: ['ops-house-search'] });
      queryClient.invalidateQueries({ queryKey: ['ops-house-status-counts'] });
      // Persist the operator's inline note (if any) for audit/attribution.
      if (note && note.trim()) {
        await supabase.from('audit_logs').insert({
          user_id: user.id,
          action_type: 'listing_verified',
          table_name: 'house_listings',
          record_id: listing.id,
          metadata: { reason: note.trim(), listing_title: listing.title, verified_by: 'landlord_ops' },
        });
      }
      refetch();
    } catch (err: any) {
      // Roll back optimistic removal so the operator can retry.
      setOptimisticallyVerifiedIds(prev => {
        const next = new Set(prev);
        next.delete(listing.id);
        return next;
      });
      toast({ title: 'Verification Failed', description: err.message, variant: 'destructive' });
    }
  };

  // Inline reject for a pending house listing (notes required, min 10 chars).
  const handleRejectListing = async (listing: ListingWithLandlord, note: string) => {
    if (!user) return;
    const reason = note.trim();
    if (reason.length < 10) {
      toast({ title: 'Add a note', description: 'Please give at least 10 characters explaining the rejection.', variant: 'destructive' });
      return;
    }
    // Optimistically hide the card from the pending queue.
    setOptimisticallyVerifiedIds(prev => new Set(prev).add(listing.id));
    try {
      const { data, error } = await supabase.rpc('reject_house_listing', {
        p_listing_id: listing.id,
        p_reason: reason,
      });
      if (error) throw error;
      if (data && typeof data === 'object' && 'error' in (data as any)) {
        throw new Error((data as any).error);
      }
      queryClient.setQueryData<any[]>(['exec-house-listings-ops'], (old) => {
        if (!Array.isArray(old)) return old;
        return old.map(l => l.id === listing.id ? { ...l, status: 'rejected' } : l);
      });
      queryClient.setQueryData<any[]>(['exec-house-listings-pending'], (old) => {
        if (!Array.isArray(old)) return old;
        return old.filter(l => l.id !== listing.id);
      });
      toast({ title: 'Listing rejected', description: `${listing.title} has been rejected.` });
      // Web-push only (no SMS) — the RPC already wrote the in-app notification.
      await invokeEdgeFunction('notify-listing-rejected', {
        body: { listing_id: listing.id, reason },
        silent: true,
      });
      refetch();
    } catch (err: any) {
      setOptimisticallyVerifiedIds(prev => { const next = new Set(prev); next.delete(listing.id); return next; });
      toast({ title: 'Reject failed', description: err?.message || 'Could not reject listing', variant: 'destructive' });
    }
  };

  // Update monthly rent on a house listing with audit logging and cache update.
  const handleUpdateMonthlyRent = async (listing: ListingWithLandlord, newRent: number) => {
    if (!user) return;
    if (!newRent || newRent <= 0 || isNaN(newRent)) {
      toast({ title: 'Invalid amount', description: 'Monthly rent must be a positive number.', variant: 'destructive' });
      return;
    }
    setSavingRentId(listing.id);
    try {
      const { error } = await supabase
        .from('house_listings')
        .update({ monthly_rent: newRent })
        .eq('id', listing.id);
      if (error) throw error;

      queryClient.setQueryData<any[]>(['exec-house-listings-ops'], (old) => {
        if (!Array.isArray(old)) return old;
        return old.map(l => l.id === listing.id ? { ...l, monthly_rent: newRent } : l);
      });

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'listing_rent_updated',
        table_name: 'house_listings',
        record_id: listing.id,
        metadata: { old_rent: listing.monthly_rent, new_rent: newRent, listing_title: listing.title, reason: 'Landlord ops updated monthly rent' },
      });

      toast({ title: 'Rent updated', description: `Monthly rent changed to UGX ${newRent.toLocaleString()}` });
      setEditingRentId(null);
      setEditRentValue('');
    } catch (err: any) {
      toast({ title: 'Update failed', description: err?.message || 'Could not update rent', variant: 'destructive' });
    } finally {
      setSavingRentId(null);
    }
  };

  // Hide / unhide a house from the tenant-facing dashboard & marketplace.
  // Uses the `is_hidden` flag that all tenant/public listing queries respect.
  const handleToggleHidden = async (listing: ListingWithLandlord) => {
    if (!user) return;
    const nextHidden = !listing.is_hidden;
    const action = nextHidden ? 'hide' : 'unhide';
    const reason = window.prompt(
      `Reason to ${action} "${listing.title}" (min 10 characters) — visible only to landlord ops & audit logs:`,
      nextHidden ? 'Hidden from tenant browse' : 'Restored to tenant browse'
    );
    if (reason === null) return;
    const trimmed = reason.trim();
    if (trimmed.length < 10) {
      toast({ title: 'Reason too short', description: 'Please enter at least 10 characters.', variant: 'destructive' });
      return;
    }
    setTogglingHide(s => ({ ...s, [listing.id]: true }));
    try {
      const { error } = await supabase.rpc('toggle_house_listing_visibility', {
        p_listing_id: listing.id,
        p_hidden: nextHidden,
        p_reason: trimmed,
      });
      if (error) throw error;
      queryClient.setQueryData<any[]>(['exec-house-listings-ops'], (old) => {
        if (!Array.isArray(old)) return old;
        return old.map(l => l.id === listing.id ? { ...l, is_hidden: nextHidden } : l);
      });
      toast({
        title: nextHidden ? 'House hidden' : 'House visible',
        description: nextHidden
          ? `${listing.title} is hidden from the tenant dashboard.`
          : `${listing.title} is back on the tenant dashboard.`,
      });
      // Optimistic cache patch above already reflects the new state;
      // skip full refetch — invalidate lazily so the next natural fetch is fresh.
      queryClient.invalidateQueries({ queryKey: ['exec-house-listings-ops'], refetchType: 'none' });
    } catch (err: any) {
      toast({ title: `Failed to ${action} house`, description: err?.message || 'Please try again.', variant: 'destructive' });
    } finally {
      setTogglingHide(s => ({ ...s, [listing.id]: false }));
    }
  };

  // ─── Verification Queue bulk actions ───
  const toggleVerifySelect = (id: string) => {
    setVerifySelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const clearVerifySelection = () => setVerifySelectedIds(new Set());

  // Run an async `fn` over `items` with a bounded concurrency window so bulk
  // actions on the Verification Queue don't block on a serial `await` loop.
  async function runBulk<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(Math.max(1, limit), items.length) },
      async () => {
        while (cursor < items.length) {
          const idx = cursor++;
          results[idx] = await fn(items[idx]);
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  // Hide or unhide every selected house from the tenant dashboard.
  const handleBulkHide = async (selected: ListingWithLandlord[], nextHidden: boolean) => {
    if (!user || selected.length === 0) return;
    const action = nextHidden ? 'hide' : 'unhide';
    const reason = window.prompt(
      `Reason to ${action} ${selected.length} house${selected.length === 1 ? '' : 's'} (min 10 characters) — visible only to landlord ops & audit logs:`,
      nextHidden ? 'Hidden from tenant browse' : 'Restored to tenant browse'
    );
    if (reason === null) return;
    const trimmed = reason.trim();
    if (trimmed.length < 10) {
      toast({ title: 'Reason too short', description: 'Please enter at least 10 characters.', variant: 'destructive' });
      return;
    }
    setBulkBusy(nextHidden ? 'hide' : 'unhide');
    const ids = selected.map(h => h.id);
    const titleById = new Map(selected.map(h => [h.id, h.title] as const));
    let results: Array<{ id: string; title: string; ok: boolean; error?: string }>;
    try {
      const { data, error } = await supabase.rpc('bulk_update_house_listing_visibility', {
        p_listing_ids: ids,
        p_hidden: nextHidden,
        p_reason: trimmed,
      });
      if (error) throw error;
      const updatedIds = new Set(((data ?? []) as Array<{ id: string }>).map(r => r.id));
      results = ids.map(id => updatedIds.has(id)
        ? { id, title: titleById.get(id) ?? '', ok: true }
        : { id, title: titleById.get(id) ?? '', ok: false, error: 'Not updated' });
      queryClient.setQueryData<any[]>(['exec-house-listings-ops'], (old) =>
        Array.isArray(old) ? old.map(l => updatedIds.has(l.id) ? { ...l, is_hidden: nextHidden } : l) : old);
    } catch (err: any) {
      results = ids.map(id => ({ id, title: titleById.get(id) ?? '', ok: false, error: err?.message || 'Unknown error' }));
    }
    const ok = results.filter(r => r.ok).length;
    const failed = results.length - ok;
    setBulkBusy(null);
    setBulkProgress(null);
    // Keep failed listings selected so the operator can retry just those.
    if (failed === 0) {
      clearVerifySelection();
    } else {
      const okIds = new Set(results.filter(r => r.ok).map(r => r.id));
      setVerifySelectedIds(prev => {
        const next = new Set(prev);
        for (const id of okIds) next.delete(id);
        return next;
      });
    }
    setBulkResult({ action: nextHidden ? 'Hide houses' : 'Unhide houses', results });
    toast({
      title: failed === 0 ? `${ok} house${ok === 1 ? '' : 's'} ${nextHidden ? 'hidden' : 'shown'}` : `${ok} done, ${failed} failed`,
      description: nextHidden ? 'Selected houses are off the tenant dashboard.' : 'Selected houses are back on the tenant dashboard.',
      variant: failed === 0 ? undefined : 'destructive',
    });
    queryClient.invalidateQueries({ queryKey: ['exec-house-listings-ops'], refetchType: 'none' });
  };

  // Verify (credit bonus where unpaid) every selected unverified house.
  const handleBulkVerify = async (selected: ListingWithLandlord[]) => {
    if (!user || selected.length === 0) return;
    const targets = selected.filter(h => !h.verified);
    if (targets.length === 0) {
      toast({ title: 'Nothing to verify', description: 'All selected houses are already verified.' });
      return;
    }
    if (!window.confirm(`Verify ${targets.length} house${targets.length === 1 ? '' : 's'}? Each unpaid listing credits the agent UGX 2,000.`)) return;
    setBulkBusy('verify');
    const ids = targets.map(h => h.id);
    const titleById = new Map(targets.map(h => [h.id, h.title] as const));
    let results: Array<{ id: string; title: string; ok: boolean; error?: string }>;
    let batchSummary: { verified: number; already: number; ineligible: number; failed: number; notifPending: number } = {
      verified: 0, already: 0, ineligible: 0, failed: 0, notifPending: 0,
    };
    try {
      const { data, error } = await supabase.functions.invoke('bulk-verify-house-listings', {
        body: { listing_ids: ids },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      const verifiedArr = ((data as any)?.verified ?? []) as Array<{ id: string; error?: string; message?: string }>;
      const alreadyArr = ((data as any)?.alreadyVerified ?? []) as Array<{ id: string; message?: string }>;
      const ineligibleArr = ((data as any)?.ineligible ?? []) as Array<{ id: string; error?: string }>;
      const failedArr = ((data as any)?.failed ?? []) as Array<{ id: string; error?: string }>;
      const notifPendingArr = ((data as any)?.notificationsPending ?? []) as Array<{ id: string }>;

      const verifiedIds = new Set(verifiedArr.map(r => r.id));
      const alreadyIds = new Set(alreadyArr.map(r => r.id));
      const successIds = new Set<string>([...verifiedIds, ...alreadyIds]);

      // Patch cache only for records the server actually committed. Failed /
      // ineligible rows stay unchanged so the UI keeps the selection where the
      // operator can retry them.
      queryClient.setQueryData<any[]>(['exec-house-listings-ops'], (old) =>
        Array.isArray(old)
          ? old.map(l => successIds.has(l.id)
              ? { ...l, verified: true, listing_bonus_paid: true }
              : l)
          : old);

      batchSummary = {
        verified: verifiedArr.length,
        already: alreadyArr.length,
        ineligible: ineligibleArr.length,
        failed: failedArr.length,
        notifPending: notifPendingArr.length,
      };

      results = ids.map(id => {
        const title = titleById.get(id) ?? '';
        if (verifiedIds.has(id)) return { id, title, ok: true };
        if (alreadyIds.has(id)) return { id, title, ok: true, error: 'Already verified' };
        const inelig = ineligibleArr.find(r => r.id === id);
        if (inelig) return { id, title, ok: false, error: inelig.error || 'Ineligible' };
        const fail = failedArr.find(r => r.id === id);
        return { id, title, ok: false, error: fail?.error || 'Verification failed' };
      });
    } catch (err: any) {
      results = ids.map(id => ({ id, title: titleById.get(id) ?? '', ok: false, error: err?.message || 'Unknown error' }));
      batchSummary.failed = ids.length;
    }
    const ok = results.filter(r => r.ok).length;
    const failed = results.length - ok;
    setBulkBusy(null);
    // Keep failed selections so operator can retry; clear only successes.
    setVerifySelectedIds(prev => {
      const next = new Set(prev);
      for (const r of results) if (r.ok) next.delete(r.id);
      return next;
    });
    setBulkResult({ action: 'Verify houses', results });
    const notifNote = batchSummary.notifPending > 0
      ? ` (${batchSummary.notifPending} notification${batchSummary.notifPending === 1 ? '' : 's'} pending)`
      : '';
    toast({
      title: failed === 0 ? `${ok} house${ok === 1 ? '' : 's'} verified` : `${ok} verified, ${failed} failed`,
      description: failed === 0
        ? `Agents credited for newly verified listings.${notifNote}`
        : `Some listings could not be verified.${notifNote}`,
      variant: failed === 0 ? undefined : 'destructive',
    });
    queryClient.invalidateQueries({ queryKey: ['exec-house-listings-ops'], refetchType: 'none' });
    queryClient.invalidateQueries({ queryKey: ['exec-house-listings-pending'], refetchType: 'none' });
  };

  // Reject every selected house (single shared reason, min 10 chars).
  const handleBulkReject = async (selected: ListingWithLandlord[]) => {
    if (!user || selected.length === 0) return;
    const reason = window.prompt(`Reason to reject ${selected.length} house${selected.length === 1 ? '' : 's'} (min 10 characters):`, '');
    if (reason === null) return;
    const trimmed = reason.trim();
    if (trimmed.length < 10) {
      toast({ title: 'Reason too short', description: 'Please enter at least 10 characters.', variant: 'destructive' });
      return;
    }
    setBulkBusy('reject');
    const ids = selected.map(h => h.id);
    const titleById = new Map(selected.map(h => [h.id, h.title] as const));
    let results: Array<{ id: string; title: string; ok: boolean; error?: string }>;
    try {
      // The database role runs with an 8s statement timeout and each rejection
      // writes an audit row, a notification and a UGX 4,000 ledger transaction.
      // Large chunks (20+) blew past that timeout, so the WHOLE chunk failed —
      // which is why rejecting 300+ houses appeared broken while single
      // rejections kept working. Small chunks + bounded concurrency + a
      // per-listing retry keep every rejection well inside the timeout.
      const CHUNK = 4;
      const CONCURRENCY = 4;
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));

      const rows: Array<{ id: string; ok: boolean; error: string | null }> = [];
      const runChunk = async (chunk: string[]) => {
        const res = await supabase.rpc('bulk_reject_house_listings', { p_listing_ids: chunk, p_reason: trimmed });
        if (!res.error) {
          for (const r of (res.data ?? []) as Array<{ id: string; ok: boolean; error: string | null }>) rows.push(r);
          return;
        }
        // Chunk-level failure (usually a statement timeout): retry each listing
        // on its own so one slow listing cannot take the rest down with it.
        for (const id of chunk) {
          const single = await supabase.rpc('bulk_reject_house_listings', { p_listing_ids: [id], p_reason: trimmed });
          if (single.error) {
            rows.push({ id, ok: false, error: single.error.message || 'Rejection failed' });
          } else {
            const r = ((single.data ?? []) as Array<{ id: string; ok: boolean; error: string | null }>)[0];
            rows.push(r ?? { id, ok: false, error: 'Not rejected' });
          }
        }
      };

      let cursor = 0;
      let done = 0;
      const worker = async () => {
        while (cursor < chunks.length) {
          const chunk = chunks[cursor++];
          await runChunk(chunk);
          done += chunk.length;
          setBulkProgress({ done: Math.min(done, ids.length), total: ids.length });
        }
      };
      setBulkProgress({ done: 0, total: ids.length });
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
      setBulkProgress(null);
      const byId = new Map(rows.map(r => [r.id, r] as const));
      const rejectedIds = new Set(rows.filter(r => r.ok).map(r => r.id));
      results = ids.map(id => {
        const row = byId.get(id);
        if (row?.ok) return { id, title: titleById.get(id) ?? '', ok: true };
        return {
          id,
          title: titleById.get(id) ?? '',
          ok: false,
          error: row?.error || 'Not rejected',
        };
      });
      queryClient.setQueryData<any[]>(['exec-house-listings-ops'], (old) =>
        Array.isArray(old) ? old.map(l => rejectedIds.has(l.id) ? { ...l, status: 'rejected' } : l) : old);
      queryClient.setQueryData<any[]>(['exec-house-listings-pending'], (old) =>
        Array.isArray(old) ? old.filter(l => !rejectedIds.has(l.id)) : old);
      // Web-push only (no SMS) — fire-and-forget per rejected listing.
      rejectedIds.forEach(id => {
        invokeEdgeFunction('notify-listing-rejected', {
          body: { listing_id: id, reason: trimmed },
          silent: true,
        }).catch(() => { /* best-effort */ });
      });
    } catch (err: any) {
      results = ids.map(id => ({ id, title: titleById.get(id) ?? '', ok: false, error: err?.message || 'Unknown error' }));
    }
    const ok = results.filter(r => r.ok).length;
    const failed = results.length - ok;
    setBulkBusy(null);
    clearVerifySelection();
    setBulkResult({ action: 'Reject houses', results });
    toast({
      title: failed === 0 ? `${ok} house${ok === 1 ? '' : 's'} rejected` : `${ok} rejected, ${failed} failed`,
      variant: failed === 0 ? undefined : 'destructive',
    });
    queryClient.invalidateQueries({ queryKey: ['exec-house-listings-ops'], refetchType: 'none' });
  };

  // Approve (verify) a pending landlord with an optional inline note.
  // Goes through the single authorized write path so state + derived flag +
  // audit log + transition event + notifications all happen atomically.
  const handleApproveLandlord = async (landlord: any, note?: string) => {
    if (!user) return;
    try {
      await setLandlordVerification({
        landlordId: landlord.id,
        status: 'verified',
        reason: note?.trim() || 'Approved via the Landlord Ops verification queue after review',
        source: 'ops_queue',
      });
      setExpandedLandlordId(null);
      toast({ title: '✅ Landlord verified', description: `${landlord.name} is now verified.` });
      refetchAll();
    } catch (err: any) {
      toast({ title: 'Approve failed', description: err?.message || 'Could not verify landlord', variant: 'destructive' });
    }
  };

  // Reject a pending landlord (notes required, min 10 chars). Persisted state:
  // the landlord moves to the Rejected tab and survives a refresh.
  const handleRejectLandlord = async (landlord: any, note: string) => {
    if (!user) return;
    const reason = note.trim();
    if (reason.length < 10) {
      toast({ title: 'Add a note', description: 'Please give at least 10 characters explaining the rejection.', variant: 'destructive' });
      return;
    }
    try {
      await setLandlordVerification({
        landlordId: landlord.id,
        status: 'rejected',
        reason,
        source: 'ops_queue',
      });
      setExpandedLandlordId(null);
      toast({ title: 'Landlord rejected', description: `${landlord.name} moved to Rejected. The agent was notified.` });
      refetchAll();
    } catch (err: any) {
      toast({ title: 'Reject failed', description: err?.message || 'Could not reject landlord', variant: 'destructive' });
    }
  };

  const fmt = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : n.toLocaleString();

  // Agent grouping
  const agentSummary = useMemo(() => {
    const map = new Map<string, { name: string; phone: string | null; listings: ListingWithLandlord[] }>();
    for (const l of rows) {
      const existing = map.get(l.agent_id);
      if (existing) {
        existing.listings.push(l);
      } else {
        map.set(l.agent_id, { name: l.agent_name || 'No agent profile', phone: l.agent_phone || null, listings: [l] });
      }
    }
    return [...map.entries()].sort((a, b) => b[1].listings.length - a[1].listings.length);
  }, [rows]);

  // Prefer the server-computed totals so the home dashboard doesn't need the
  // full landlord set loaded. Fall back to iterating landlordsList only when
  // it happens to already be loaded (occupied/empty views).
  // Server-computed revenue only — a partial client list would understate it.
  const totalMonthlyRevenue = occupiedMonthlyRevenue;
  const lostMonthlyRevenue  = emptyMonthlyRevenue;

  // ─── Navigate to any section (resets transient search/filter state) ───
  const goToView = (id: View) => {
    setView(id);
    setSearch('');
    setVerifySearch('');
    setVerifyFilter('all');
    setPendingFilter('all');
    setNavSheetOpen(false);
  };

  // ─── Section switcher (mobile-friendly jump menu, available in every view) ───
  const SectionSwitcher = ({ className = '' }: { className?: string }) => (
    <Sheet open={navSheetOpen} onOpenChange={setNavSheetOpen}>
      <SheetTrigger asChild>
        <button
          className={`flex items-center gap-1.5 text-sm font-semibold rounded-full border border-border bg-card px-3 min-h-[44px] touch-manipulation active:scale-[0.98] ${className}`}
        >
          <LayoutGrid className="h-4 w-4" /> Sections
        </button>
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl">
        <SheetHeader className="text-left">
          <SheetTitle>Jump to section</SheetTitle>
        </SheetHeader>
        <div className="mt-3 grid grid-cols-2 gap-2 pb-4">
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => goToView(item.id)}
              className={`flex items-center gap-2 p-3 rounded-xl border border-border bg-card text-left min-h-[56px] touch-manipulation active:scale-[0.98] transition-colors hover:bg-muted/40 ${view === item.id ? 'ring-2 ring-primary border-primary/40' : ''}`}
            >
              <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                <item.icon className="h-4 w-4 text-muted-foreground" />
              </div>
              <span className="font-medium text-xs leading-tight">{item.label}</span>
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );

  // ─── Back Button (sticky nav row: back to overview + section switcher) ───
  const BackButton = ({ title }: { title?: string } = {}) => (
    <HubHeader
      title={title ?? hubTitles[view]}
      onBack={() => goToView('home')}
      trailing={<SectionSwitcher />}
    />
  );

  const refetchAll = () => {
    refetch();
    refetchLandlords();
    refetchLC1();
    queryClient.invalidateQueries({ queryKey: ['landlord-ops-pending-verification-count'] });
  };

  // Shared dialogs renderer — must be present in every sub-view that uses
  // setActionDialog / setPreviewImages / setAssignPerson / etc. Otherwise
  // those buttons set state but no dialog is mounted and "nothing happens"
  // until the user navigates back to a view that does mount LandlordDialogs.
  const renderDialogs = () => (
    <>
      <LandlordDialogs
        editLandlord={editLandlord} setEditLandlord={setEditLandlord}
        editLC1={editLC1} setEditLC1={setEditLC1}
        assignPerson={assignPerson} setAssignPerson={setAssignPerson}
        deleteLandlord={deleteLandlord} setDeleteLandlord={setDeleteLandlord}
        deleteReason={deleteReason} setDeleteReason={setDeleteReason}
        deleting={deleting} setDeleting={setDeleting}
        previewImages={previewImages} setPreviewImages={setPreviewImages}
        adjustListing={adjustListing} setAdjustListing={setAdjustListing}
        actionDialog={actionDialog} setActionDialog={setActionDialog}
        reverseLandlord={reverseLandlord} setReverseLandlord={setReverseLandlord}
        user={user} refetchAll={refetchAll} queryClient={queryClient}
      />
      {renderEntityDetail()}
    </>
  );

  // Detail sheet opened when a drilldown table row is clicked.
  const renderEntityDetail = () => {
    if (!entityDetail) return null;
    const close = closeEntity;
    const buildShareUrl = (type: string, id: string) => {
      const url = new URL(window.location.href);
      url.searchParams.set('entity', type);
      url.searchParams.set('eid', id);
      return url.toString();
    };

    if (entityDetail.type === 'city') {
      const c = entityDetail.data;
      return (
        <EntityDetailSheet
          open
          onClose={close}
          shareUrl={buildShareUrl('city', c.city)}
          title={c.city}
          subtitle="City overview"
          icon={<Globe className="h-5 w-5 text-teal-600" />}
          fields={[
            { label: 'Houses listed', value: c.listingCount ?? 0 },
            { label: 'Tenants', value: c.tenantCount ?? 0 },
          ]}
        />
      );
    }

    if (entityDetail.type === 'no-landlord') {
      const t = entityDetail.data;
      return (
        <EntityDetailSheet
          open
          onClose={close}
          shareUrl={buildShareUrl('no-landlord', t.id)}
          title={t.tenant_name}
          subtitle="Tenant with no landlord listed"
          icon={<UserX className="h-5 w-5 text-orange-600" />}
          fields={[
            { label: 'Rent', value: `UGX ${Number(t.rent_amount || 0).toLocaleString()}` },
            { label: 'City', value: t.request_city || '—' },
            { label: 'Category', value: t.house_category || '—' },
            { label: 'Status', value: t.status || '—' },
            { label: 'Agent', value: t.agent_name || '—' },
          ]}
        >
          {t.tenant_phone && (
            <div className="rounded-lg bg-muted/50 p-2.5 space-y-1.5">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Contact Tenant</p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium truncate">{t.tenant_name}</span>
                <ListPropertyCTA phone={t.tenant_phone} name={t.tenant_name} role="tenant" />
              </div>
            </div>
          )}
          {t.agent_id && t.agent_phone && (
            <div className="rounded-lg bg-indigo-500/10 p-2.5 space-y-1.5">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Contact Agent</p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium truncate">{t.agent_name || 'Agent'}</span>
                <ListPropertyCTA phone={t.agent_phone} name={t.agent_name || undefined} role="agent" />
              </div>
            </div>
          )}
        </EntityDetailSheet>
      );
    }

    if (entityDetail.type === 'tenant') {
      const tn = entityDetail.data;
      return (
        <EntityDetailSheet
          open
          onClose={close}
          shareUrl={buildShareUrl('tenant', tn.id)}
          title={tn.name}
          subtitle={tn.landlord_name ? `Tenant of ${tn.landlord_name}` : 'Tenant'}
          icon={<Users className="h-5 w-5 text-green-600" />}
          fields={[
            { label: 'Status', value: <span className="capitalize">{(tn.status || 'listed').replace(/_/g, ' ')}</span> },
            { label: 'Phone', value: tn.phone || '—' },
          ]}
        >
          {tn.phone && (
            <div className="rounded-lg bg-green-500/10 p-2.5 space-y-1.5">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Contact Tenant</p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium truncate">{tn.name}</span>
                <PhoneLinks phone={tn.phone} name={tn.name} />
              </div>
            </div>
          )}
        </EntityDetailSheet>
      );
    }

    // landlord (empty / occupied views)
    const l = entityDetail.data;
    const houseCount = landlordHouseCounts.get(l.id) || l.number_of_houses || 0;
    const tenants = (l.tenants || []) as { id: string; name: string; phone: string | null; status: string }[];
    const statusCounts = tenants.reduce<Record<string, number>>((acc, t) => {
      const s = (t.status || 'listed').toLowerCase();
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});
    return (
      <EntityDetailSheet
        open
        onClose={close}
        shareUrl={buildShareUrl('landlord', l.id)}
        title={l.name}
        subtitle={tenants.length > 0 ? 'Occupied landlord' : 'Empty landlord'}
        icon={<Building2 className="h-5 w-5 text-sky-600" />}
        fields={[
          { label: 'Phone', value: l.phone || '—' },
          { label: 'Houses', value: houseCount },
          { label: 'Tenants', value: tenants.length },
          { label: 'Monthly rent', value: `UGX ${fmt(l.monthly_rent || 0)}` },
          { label: 'Verified', value: l.verified ? 'Yes' : 'No' },
          { label: 'Address', value: l.property_address || '—' },
          { label: 'Agent', value: l.agent_name || '—' },
          { label: 'District', value: l.district || '—' },
          { label: 'Region', value: l.region || '—' },
        ]}
      >
        {l.phone && (
          <div className="rounded-lg bg-sky-500/10 p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Contact Landlord</p>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium truncate">{l.name}</span>
              <PhoneLinks phone={l.phone} name={l.name} />
            </div>
          </div>
        )}
        {l.agent_name && (
          <div className="rounded-lg bg-indigo-500/10 p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Linked Agent</p>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium truncate">{l.agent_name}</span>
              {l.agent_phone && <PhoneLinks phone={l.agent_phone} name={l.agent_name} />}
            </div>
          </div>
        )}
        {tenants.length > 0 && (
          <TenantStatusFilter
            tenants={tenants}
            landlordName={l.name}
            onOpenTenant={openEntity}
          />
        )}
      </EntityDetailSheet>
    );
  };

  // ─── LANDLORDS VIEW ───
  if (view === 'landlords') {
    type LandlordCategory = 'all' | 'verified' | 'pending' | 'rejected' | 'resubmitted' | 'has_tenants' | 'no_tenants' | 'funded';
    const LANDLORD_CATEGORIES: { value: LandlordCategory; label: string; color: string }[] = [
      { value: 'all', label: 'All', color: 'bg-muted text-foreground' },
      { value: 'verified', label: 'Verified', color: VERIFICATION_STATUS_META.verified.chipClass },
      { value: 'pending', label: 'Pending', color: VERIFICATION_STATUS_META.pending.chipClass },
      { value: 'rejected', label: 'Rejected', color: VERIFICATION_STATUS_META.rejected.chipClass },
      { value: 'resubmitted', label: 'Resubmitted', color: VERIFICATION_STATUS_META.resubmitted.chipClass },
      { value: 'funded', label: 'Funded', color: 'bg-emerald-100 text-emerald-700' },
      { value: 'has_tenants', label: 'Has Tenants', color: 'bg-blue-100 text-blue-700' },
      { value: 'no_tenants', label: 'No Tenants', color: 'bg-orange-100 text-orange-700' },
    ];

    const perPage = 20;
    const categoryFilter = (landlordCategory || 'all') as LandlordCategory;

    // Server-driven data: rows, total count, and category counts all come from
    // the `landlord-ops` edge function (RPC-backed). No full-table client fetch.
    // No client-side post-filtering: the server list is the list.
    const paginated = landlordOpsList?.rows ?? [];
    const totalMatched = landlordOpsList?.totalMatched ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalMatched / perPage));
    const safePage = Math.min(landlordPage, totalPages);

    // Chip counts come from ops_landlord_status_counts(), which reads the same
    // v_landlord_ops_status view the list RPC filters on AND honours the active
    // search + date range — a chip and the list it opens can never disagree.
    // Falls back to the unscoped totals while the scoped query loads.
    const scoped = landlordScopedCounts;
    const categoryCounts: Record<LandlordCategory, number | undefined> = {
      all: scoped?.all ?? landlordOpsTotals?.total,
      verified: scoped?.verified ?? landlordOpsTotals?.verified,
      pending: scoped?.pending ?? landlordOpsTotals?.pending,
      rejected: scoped?.rejected ?? landlordOpsTotals?.rejected,
      resubmitted: scoped?.resubmitted ?? landlordOpsTotals?.resubmitted,
      has_tenants: scoped?.has_tenants ?? landlordOpsTotals?.has_tenants,
      no_tenants: scoped?.no_tenants ?? landlordOpsTotals?.no_tenants,
      funded: landlordFundedStats?.summary.landlords_funded,
    };

    // Funded register for the period on screen (read-only, no workflow).
    const fundedRows = landlordFundedStats?.rows ?? [];
    const fundedTotalPages = Math.max(1, Math.ceil(fundedRows.length / perPage));
    const fundedSafePage = Math.min(landlordPage, fundedTotalPages);
    const fundedPaginated = fundedRows.slice((fundedSafePage - 1) * perPage, fundedSafePage * perPage);

    // Stat tiles for the scope on screen — the landlord counterpart of the
    // Houses verification KPIs. Read-only: nothing here verifies or rejects.
    const landlordStatCards: { label: string; value: string; hint?: string }[] = [
      {
        label: 'IN SCOPE',
        value: (categoryCounts[categoryFilter] ?? totalMatched).toLocaleString(),
        hint: 'matching the filters below',
      },
      {
        label: 'PENDING',
        value: (categoryCounts.pending ?? 0).toLocaleString(),
        hint: 'awaiting review',
      },
      {
        label: 'VERIFIED',
        value: (categoryCounts.verified ?? 0).toLocaleString(),
        hint: scoped
          ? `${scoped.verified_human.toLocaleString()} reviewer · ${scoped.verified_auto.toLocaleString()} auto`
          : 'reviewer + auto',
      },
      {
        label: 'REJECTED',
        value: (categoryCounts.rejected ?? 0).toLocaleString(),
        hint: 'with a recorded reason',
      },
      {
        label: 'WITH TENANTS',
        value: (categoryCounts.has_tenants ?? 0).toLocaleString(),
        hint: `${(categoryCounts.no_tenants ?? 0).toLocaleString()} without tenants`,
      },
      {
        label: 'OCCUPIED RENT',
        value: `UGX ${fmt(scoped?.occupied_monthly_revenue ?? 0)}`,
        hint: `UGX ${fmt(scoped?.empty_monthly_revenue ?? 0)} empty`,
      },
      {
        label: 'LANDLORDS FUNDED',
        value: (landlordFundedStats?.summary.landlords_funded ?? 0).toLocaleString(),
        hint: landlordFundedStats
          ? `UGX ${fmt(landlordFundedStats.summary.total_funded)} · prev ${landlordFundedStats.previous.landlords_funded.toLocaleString()}`
          : 'money committed in this period',
      },
    ];

    const landlordFiltersDirty = !!(
      landlordCategory !== 'verified'
      || pendingFilter !== 'all'
      || search
      || landlordDateFrom
      || landlordDateTo
    );

    return (
      <>
      <div className="space-y-3">
        <BackButton />
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold flex items-center gap-2"><Building2 className="h-5 w-5 text-sky-600" /> All Landlords</h2>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-9 gap-1.5"
              disabled={exportingLandlordReport}
              onClick={() => void exportLandlordReportPdf()}
              title="Export a full PDF report for the filters currently applied"
            >
              {exportingLandlordReport
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <FileDown className="h-4 w-4" />}
              Export PDF
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-9 gap-1.5"
              disabled={exportingFundedReport}
              onClick={() => void exportFundedReportPdf()}
              title="Export the Landlords Funded pack (stats, charts, per district / agent / service centre) for the period selected below"
            >
              {exportingFundedReport
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Banknote className="h-4 w-4" />}
              Funded Report
            </Button>
            <Button size="sm" onClick={() => setBulkImportLandlordsOpen(true)} className="h-9">
              <Upload className="h-4 w-4 mr-1.5" /> Bulk Import
            </Button>
            <span className="text-xs text-muted-foreground">
              {landlordOpsListFetching ? 'Loading…' : `${totalMatched} landlords`}
            </span>
          </div>
        </div>

        {/* Verification statistics for the active scope (read-only) */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-2">
          {landlordStatCards.map(card => (
            <div key={card.label} className="rounded-xl border border-border bg-card p-2.5">
              <p className="text-[9px] font-bold text-muted-foreground uppercase tracking-wide">{card.label}</p>
              <p className="text-lg font-semibold tracking-tight leading-tight mt-0.5">
                {landlordCountsFetching && !scoped ? '…' : card.value}
              </p>
              {card.hint && <p className="text-[10px] text-muted-foreground leading-snug truncate">{card.hint}</p>}
            </div>
          ))}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search name, phone, location, tenant, or agent…" value={search} onChange={e => { setSearch(e.target.value); setLandlordPage(1); }} className="pl-9 h-9" />
          {search && <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2"><X className="h-4 w-4 text-muted-foreground" /></button>}
        </div>

        {/* Category filter chips */}
        <div className="flex gap-1.5 flex-wrap">
          {LANDLORD_CATEGORIES.map((cat) => (
            <button
              key={cat.value}
              onClick={() => { setLandlordCategory(cat.value); setLandlordPage(1); }}
              className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all border ${
                categoryFilter === cat.value
                  ? `${cat.color} border-current shadow-sm`
                  : 'bg-background text-muted-foreground border-border hover:bg-muted'
              }`}
            >
              {cat.label}
              <span className="ml-1 opacity-70">
                ({categoryCounts[cat.value] === undefined ? '…' : categoryCounts[cat.value]!.toLocaleString()})
              </span>
            </button>
          ))}
          {landlordFiltersDirty && (
            <button
              onClick={() => {
                setLandlordCategory('verified');
                setPendingFilter('all');
                setSearch('');
                setLandlordDateFrom('');
                setLandlordDateTo('');
                setLandlordPage(1);
              }}
              className="px-2.5 py-1 rounded-full text-[11px] font-semibold text-muted-foreground border border-border bg-background hover:bg-muted transition-all inline-flex items-center gap-1"
              title="Reset filters"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          )}
        </div>

        {/* Date range filter — applied to the STATE date, not blindly to registration */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground font-medium">
            {categoryFilter === 'funded' ? 'Funded between:'
              : categoryFilter === 'verified' ? 'Verified between:'
              : categoryFilter === 'rejected' ? 'Rejected between:'
              : categoryFilter === 'pending' ? 'Registered between:'
              : categoryFilter === 'resubmitted' ? 'Resubmitted between:'
              : 'Status changed between:'}
          </span>
          <Input
            type="date"
            value={landlordDateFrom}
            onChange={e => { setLandlordDateFrom(e.target.value); setLandlordPage(1); }}
            className="h-8 w-auto text-xs"
            aria-label="Landlord from date"
          />
          <span className="text-[11px] text-muted-foreground">to</span>
          <Input
            type="date"
            value={landlordDateTo}
            onChange={e => { setLandlordDateTo(e.target.value); setLandlordPage(1); }}
            className="h-8 w-auto text-xs"
            aria-label="Landlord to date"
          />
          {(landlordDateFrom || landlordDateTo) && (
            <button
              onClick={() => { setLandlordDateFrom(''); setLandlordDateTo(''); setLandlordPage(1); }}
              className="text-[11px] text-muted-foreground hover:text-foreground underline"
            >
              clear
            </button>
          )}
          {landlordCountsFetching && (
            <span className="text-[11px] text-muted-foreground">Updating counts…</span>
          )}
        </div>

        {/* Verified attribution: human decisions vs automatic pipeline flips */}
        {categoryFilter === 'verified' && (
          <p className="text-[11px] text-muted-foreground">
            {verifiedHumanCount === undefined || verifiedAutoCount === undefined
              ? 'Loading verification attribution…'
              : `${verifiedHumanCount.toLocaleString()} verified by a reviewer · ${verifiedAutoCount.toLocaleString()} auto-verified by rent pipeline approval`}
          </p>
        )}

        {/* Pending landlord quick filters */}
        {categoryFilter === 'pending' && (
          <div className="flex gap-1.5 flex-wrap">
            {([
              { value: 'all' as PendingFilter, label: 'All Pending' },
              { value: 'has_address' as PendingFilter, label: 'Has Address' },
              { value: 'has_phone' as PendingFilter, label: 'Has Phone' },
              { value: 'has_smartphone' as PendingFilter, label: 'Smartphone' },
              { value: 'has_bank' as PendingFilter, label: 'Bank' },
              { value: 'has_momo' as PendingFilter, label: 'MoMo' },
            ]).map(f => {
              const active = pendingFilter === f.value;
              return (
                <button
                  key={f.value}
                  onClick={() => setPendingFilter(f.value)}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all border ${
                    active
                      ? 'bg-amber-100 text-amber-700 border-amber-300 shadow-sm'
                      : 'bg-background text-muted-foreground border-border hover:bg-muted'
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Sort (all categories) */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground font-medium">Sort:</span>
          <div className="flex gap-1.5">
            {([
              { value: 'newest' as SortOption, label: 'Newest' },
              { value: 'oldest' as SortOption, label: 'Oldest' },
              { value: 'highest_rent' as SortOption, label: 'Highest Rent' },
            ]).map(s => (
              <button
                key={s.value}
                onClick={() => setLandlordSort(s.value)}
                className={`px-2 py-0.5 rounded-full text-[11px] font-semibold transition-all border ${
                  landlordSort === s.value
                    ? 'bg-primary/10 text-primary border-primary/30'
                    : 'bg-background text-muted-foreground border-border hover:bg-muted'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Funded register — read-only view of money committed in the period */}
        {categoryFilter === 'funded' ? (
          <div className="space-y-2">
            <div className="rounded-xl border border-border bg-card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Landlord</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs hidden md:table-cell">District</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs hidden lg:table-cell">Tenant</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs hidden lg:table-cell">Agent</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs hidden sm:table-cell">Funded</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs">Amount</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs hidden md:table-cell">Payout</th>
                  </tr>
                </thead>
                <tbody>
                  {landlordFundedFetching && fundedPaginated.length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-6 text-muted-foreground">Loading funded landlords…</td></tr>
                  ) : fundedPaginated.length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-6 text-muted-foreground">No landlords were funded in this period</td></tr>
                  ) : (
                    fundedPaginated.map((r, i) => (
                      <tr key={`${r.landlord_id}-${r.funded_at}-${i}`} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                        <td className="px-3 py-2.5">
                          <div className="space-y-0.5">
                            <p className="font-bold text-sm">{r.landlord_name}</p>
                            {r.landlord_phone && <PhoneLinks phone={r.landlord_phone} name={r.landlord_name} />}
                            <div className="flex flex-wrap gap-1">
                              {r.verified
                                ? <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-emerald-100 text-emerald-700 border-0">Verified</Badge>
                                : <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-red-100 text-red-700 border-0 font-semibold">Not Verified</Badge>}
                              {r.first_time && <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-sky-100 text-sky-700 border-0">First time</Badge>}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground hidden md:table-cell">{r.district}</td>
                        <td className="px-3 py-2.5 text-muted-foreground hidden lg:table-cell">{r.tenant_name || '—'}</td>
                        <td className="px-3 py-2.5 text-muted-foreground hidden lg:table-cell">{r.agent_name}</td>
                        <td className="px-3 py-2.5 text-muted-foreground hidden sm:table-cell text-xs">
                          {new Date(r.funded_at).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-2.5 text-right font-semibold">UGX {fmt(r.rent_amount || 0)}</td>
                        <td className="px-3 py-2.5 text-muted-foreground hidden md:table-cell text-xs">{r.payout_channel}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {fundedTotalPages > 1 && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">
                  Page {fundedSafePage} of {fundedTotalPages} · {fundedRows.length.toLocaleString()} funded records
                </span>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="outline" className="h-8" disabled={fundedSafePage <= 1}
                    onClick={() => setLandlordPage(p => Math.max(1, p - 1))}>Previous</Button>
                  <Button size="sm" variant="outline" className="h-8" disabled={fundedSafePage >= fundedTotalPages}
                    onClick={() => setLandlordPage(p => Math.min(fundedTotalPages, p + 1))}>Next</Button>
                </div>
              </div>
            )}
          </div>
        ) : (
        <div className="rounded-xl border border-border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Name</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs hidden sm:table-cell">Phone</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs hidden md:table-cell">Status</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs hidden md:table-cell">Tenants</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs hidden lg:table-cell">Agent</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs">Action</th>
              </tr>
            </thead>
            <tbody>
              {paginated.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-6 text-muted-foreground">No landlords found</td></tr>
              ) : (
                paginated.map(landlord => {
                  const tenantCount = landlord.tenant_count || 0;
                  const isExpanded = expandedLandlordId === landlord.id;
                  return (
                    <Fragment key={landlord.id}>
                    <tr className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="px-3 py-2.5">
                        <div className="space-y-0.5">
                          <button
                            type="button"
                            onClick={() => openEntity('landlord', landlord)}
                            className="font-bold text-sm text-sky-700 hover:underline text-left block"
                          >
                            {landlord.name}
                          </button>
                          <div className="flex items-center gap-1.5">
                            <PhoneLinks phone={landlord.phone} name={landlord.name} />
                          </div>
                          {/* Mobile-only extra info */}
                          <div className="sm:hidden flex flex-wrap gap-1 mt-1">
                            {landlord.verified ? (
                              <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-emerald-100 text-emerald-700 border-0">Verified</Badge>
                            ) : (
                              <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-red-100 text-red-700 border-0 font-semibold">Not Verified</Badge>
                            )}
                            {tenantCount > 0 && (
                              <Badge variant="outline" className="text-[9px] px-1.5 py-0">{tenantCount} tenants</Badge>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground hidden sm:table-cell">
                        <PhoneLinks phone={landlord.phone} name={landlord.name} />
                      </td>
                      <td className="px-3 py-2.5 hidden md:table-cell">
                        {(() => {
                          // Single source of truth: the state machine column.
                          const status = (landlord.verification_status || (landlord.verified ? 'verified' : 'pending')) as LandlordVerificationStatus;
                          const meta = VERIFICATION_STATUS_META[status] ?? VERIFICATION_STATUS_META.pending;
                          return (
                            <div className="flex flex-col gap-0.5">
                              <Badge variant="outline" className={`text-[10px] px-1.5 py-0 border-0 font-semibold ${meta.chipClass}`}>{meta.label}</Badge>
                              {status === 'verified' && landlord.verification_source && (
                                <span className="text-[9px] text-muted-foreground">{verificationSourceLabel(landlord.verification_source)}</span>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground hidden md:table-cell">{tenantCount > 0 ? tenantCount : '—'}</td>
                      <td className="px-3 py-2.5 text-muted-foreground truncate max-w-[120px] hidden lg:table-cell">{landlord.agent_name || '—'}</td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {!landlord.verified && (
                            <Button
                              variant={isExpanded ? 'secondary' : 'default'}
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => setExpandedLandlordId(isExpanded ? null : landlord.id)}
                            >
                              {isExpanded ? 'Close' : 'Review'}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setEditLandlord({ ...landlord })}
                          >
                            Edit
                          </Button>
                          {landlord.verified && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs border-destructive/40 text-destructive hover:bg-destructive/5"
                              onClick={() => setReverseLandlord({ id: landlord.id, name: landlord.name })}
                            >
                              Reverse
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isExpanded && !landlord.verified && (
                      <tr className="border-b border-border last:border-0 bg-muted/20">
                        <td colSpan={6} className="px-3 py-3 space-y-3">
                          <p className="text-xs font-bold flex items-center gap-1.5">
                            <ShieldCheck className="h-3.5 w-3.5 text-amber-600" />
                            Verify {landlord.name}
                          </p>
                          <div className="rounded-lg bg-sky-500/5 p-2.5 border border-sky-200/40">
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Landlord Contact</p>
                            <PhoneLinks phone={landlord.phone} name={landlord.name} />
                            {landlord.property_address && (
                              <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1">
                                <MapPin className="h-3 w-3" />{landlord.property_address}
                              </p>
                            )}
                          </div>
                          {/* Registering agent contact — ops can call to complete verification */}
                          {(landlord.agent_name || landlord.agent_phone) && (
                            <div className="rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-500/10 px-2.5 py-2 space-y-1">
                              <p className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 uppercase tracking-wider flex items-center gap-1">
                                <Users className="h-3 w-3" /> Registering agent
                              </p>
                              <p className="text-xs font-medium">{landlord.agent_name || 'Unknown agent'}</p>
                              {landlord.agent_phone && <PhoneLinks phone={landlord.agent_phone} name={landlord.agent_name || 'Agent'} />}
                            </div>
                          )}
                          {/* Service Centre manager's vetting note for this landlord */}
                          <ServiceCentreNoteLoader table="landlords" id={landlord.id} />
                          <InlineModerationActions
                            approveLabel="Review & Approve"
                            rejectLabel="Reject"
                            onApprove={(note) => handleApproveLandlord(landlord, note)}
                            onReject={(note) => handleRejectLandlord(landlord, note)}
                          />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        )}

        {/* Pagination controls */}
        {categoryFilter !== 'funded' && totalMatched > perPage && (
          <div className="flex items-center justify-between pt-2">
            <span className="text-xs text-muted-foreground">
              Showing {(safePage - 1) * perPage + 1}–{Math.min(safePage * perPage, totalMatched)} of {totalMatched}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLandlordPage(p => Math.max(1, p - 1))}
                disabled={safePage <= 1}
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">Page {safePage} of {totalPages}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLandlordPage(p => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
      <LandlordDialogs
        editLandlord={editLandlord} setEditLandlord={setEditLandlord}
        editLC1={editLC1} setEditLC1={setEditLC1}
        assignPerson={assignPerson} setAssignPerson={setAssignPerson}
        deleteLandlord={deleteLandlord} setDeleteLandlord={setDeleteLandlord}
        deleteReason={deleteReason} setDeleteReason={setDeleteReason}
        deleting={deleting} setDeleting={setDeleting}
        previewImages={previewImages} setPreviewImages={setPreviewImages}
        adjustListing={adjustListing} setAdjustListing={setAdjustListing}
        actionDialog={actionDialog} setActionDialog={setActionDialog}
        reverseLandlord={reverseLandlord} setReverseLandlord={setReverseLandlord}
        user={user} refetchAll={refetchAll} queryClient={queryClient}
      />
      <BulkImportLandlordsDialog
        open={bulkImportLandlordsOpen}
        onClose={() => setBulkImportLandlordsOpen(false)}
        onImported={refetchAll}
      />
      {renderEntityDetail()}
      </>
    );
  }

  // ─── LOCATIONS VIEW ───
  if (view === 'locations') {
    const filtered = search
      ? locationGroups.filter(g => g.region.toLowerCase().includes(search.toLowerCase()) || g.district?.toLowerCase().includes(search.toLowerCase()))
      : locationGroups;
    return (
      <>
      <div className="space-y-3">
        <BackButton />
        <h2 className="text-lg font-bold flex items-center gap-2"><MapPin className="h-5 w-5 text-purple-600" /> Locations ({locationGroups.length})</h2>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search region or district…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9 h-11" />
          {search && <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2"><X className="h-4 w-4 text-muted-foreground" /></button>}
        </div>
        <div className="space-y-2">
          {filtered.map((loc, i) => (
            <div key={i} className="rounded-xl border border-border bg-card p-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-10 w-10 rounded-xl bg-purple-500/10 flex items-center justify-center shrink-0">
                  <MapPin className="h-5 w-5 text-purple-600" />
                </div>
                <div className="min-w-0">
                  <p className="font-bold text-sm truncate">{loc.region}</p>
                  {loc.district && <p className="text-xs text-muted-foreground truncate">{loc.district}</p>}
                </div>
              </div>
              <div className="flex flex-col items-end gap-0.5 shrink-0">
                <Badge variant="outline" className="text-[10px] font-bold">{loc.count} houses</Badge>
                <div className="flex gap-1">
                  <Badge className="bg-green-500/20 text-green-700 border-0 text-[9px]">{loc.occupied} occupied</Badge>
                  {loc.empty > 0 && <Badge className="bg-red-500/20 text-red-700 border-0 text-[9px]">{loc.empty} empty</Badge>}
                </div>
              </div>
            </div>
          ))}
          {filtered.length === 0 && <p className="text-center text-muted-foreground py-8">No locations found</p>}
        </div>
      </div>
      {renderDialogs()}
      </>
    );
  }

  // ─── LC1 VIEW (approved / rejected register) ───
  if (view === 'lc1') {
    // Canonical state: `verification_status`. The legacy `verified` boolean is
    // only a fallback for rows written before the status column existed.
    const lc1State = (g: { verified: boolean | null; verification_status?: string | null }) =>
      (g.verification_status as string | null) || (g.verified ? 'verified' : 'pending');

    let filtered = search
      ? lc1Groups.filter(g => g.name.toLowerCase().includes(search.toLowerCase()) || g.village?.toLowerCase().includes(search.toLowerCase()) || g.phone?.includes(search))
      : [...lc1Groups];
    if (lc1VerifyFilter !== 'all') filtered = filtered.filter(g => lc1State(g) === lc1VerifyFilter);

    const verifiedCount = lc1Groups.filter(g => lc1State(g) === 'verified').length;
    const rejectedCount = lc1Groups.filter(g => lc1State(g) === 'rejected').length;
    const pendingCount = lc1Groups.filter(g => lc1State(g) === 'pending').length;

    // Single source of truth: the hoisted export, shared with the centralized
    // Reports & Exports → Extract card.
    const exportLc1Report = exportLc1ReportPdf;

    return (
      <>
      <div className="space-y-3">
        <BackButton />
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-lg font-bold flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-emerald-600" /> LC1 Chairpersons ({filtered.length}{filtered.length !== lc1Groups.length ? ` / ${lc1Groups.length}` : ''})</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="outline" className="h-9 text-[11px] font-bold" disabled={lc1Exporting} onClick={() => exportLc1Report(lc1VerifyFilter === 'all' ? 'all' : lc1VerifyFilter)}>
              {lc1Exporting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5 mr-1.5" />}
              Export report
            </Button>
            <Button size="sm" onClick={() => setBulkImportOpen(true)} className="h-9">
              <Upload className="h-4 w-4 mr-1.5" /> Bulk Import
            </Button>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Approved and rejected chairpersons live here. New requests are reviewed in
          {' '}
          <button className="font-semibold text-amber-700 underline" onClick={() => setView('lc1-requests')}>Agents requesting LC1 verification</button>.
        </p>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search by name, village, or phone…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9 h-11" />
          {search && <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2"><X className="h-4 w-4 text-muted-foreground" /></button>}
        </div>
        {/* LC1 Verification quick filter chips */}
        <div className="flex flex-wrap gap-1.5">
          {([
            { value: 'verified' as LC1VerifyFilter, label: 'Approved', count: verifiedCount },
            { value: 'rejected' as LC1VerifyFilter, label: 'Rejected', count: rejectedCount },
            { value: 'pending' as LC1VerifyFilter, label: 'Awaiting review', count: pendingCount },
            { value: 'all' as LC1VerifyFilter, label: 'All', count: lc1Groups.length },
          ]).map(f => {
            const active = lc1VerifyFilter === f.value;
            return (
              <button
                key={f.value}
                onClick={() => setLc1VerifyFilter(f.value)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all border ${
                  active
                    ? f.value === 'rejected'
                      ? 'bg-rose-100 text-rose-700 border-rose-300 shadow-sm'
                      : f.value === 'verified'
                        ? 'bg-emerald-100 text-emerald-700 border-emerald-300 shadow-sm'
                        : 'bg-amber-100 text-amber-700 border-amber-300 shadow-sm'
                    : 'bg-background text-muted-foreground border-border hover:bg-muted'
                }`}
                title={active ? 'Active filter' : `Show ${f.label.toLowerCase()} LC1 chairpersons`}
              >
                {f.label}
                <span className={`text-[9px] font-bold px-1 py-0 rounded-full ${active ? 'bg-white/40' : 'bg-black/5'}`}>
                  {f.count}
                </span>
              </button>
            );
          })}
        </div>
        <div className="space-y-2">
          {filtered.map((lc1) => (
            <div key={lc1.id} className="rounded-xl border border-border bg-card p-4 space-y-2">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-bold text-sm">{lc1.name}</p>
                  {lc1.village && <p className="text-xs text-muted-foreground flex items-center gap-1"><MapPin className="h-3 w-3" />{lc1.village}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setEditLC1({ id: lc1.id, name: lc1.name, phone: lc1.phone, village: lc1.village, listingIds: lc1.listingIds })}
                    className="inline-flex items-center justify-center h-8 w-8 rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors min-h-[32px]"
                    title="Edit LC1"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <Badge variant="outline" className="text-[10px]">{lc1.landlords.length} {lc1.landlords.length === 1 ? 'landlord' : 'landlords'}</Badge>
                </div>
              </div>
              {lc1.phone && <PhoneLinks phone={lc1.phone} name={lc1.name} />}
              {/* Registering agent contact — so ops can call them to complete verification */}
              {(lc1.agentName || lc1.agentPhone) && (
                <div className={`rounded-lg border px-2.5 py-2 space-y-1 ${!lc1.verified ? 'border-amber-300/60 bg-amber-50 dark:bg-amber-500/10' : 'border-border bg-muted/30'}`}>
                  <p className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 ${!lc1.verified ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}>
                    <Users className="h-3 w-3" /> Registering agent
                  </p>
                  <p className="text-xs font-medium">{lc1.agentName || 'Unknown agent'}</p>
                  {lc1.agentPhone && <PhoneLinks phone={lc1.agentPhone} name={lc1.agentName || 'Agent'} />}
                </div>
              )}
              {/* LC1 chairperson verification state — decisions are taken in the
                  single inbox so status, request trail, audit log, notification
                  and the agent penalty always move together. */}
              <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">LC1 verification</span>
                <div className="flex items-center gap-1.5">
                  {lc1State(lc1) === 'verified' ? (
                    <Badge className="bg-emerald-500/15 text-emerald-700 border-0 text-[10px] font-bold">Approved</Badge>
                  ) : lc1State(lc1) === 'rejected' ? (
                    <Badge className="bg-destructive/15 text-destructive border-0 text-[10px] font-bold">Rejected</Badge>
                  ) : (
                    <Badge className="bg-amber-500/15 text-amber-700 border-0 text-[10px] font-bold">Pending</Badge>
                  )}
                  <Button size="sm" variant="outline" className="h-7 text-[10px] font-bold" onClick={() => { setSearch(lc1.phone || lc1.name); setView('lc1-requests'); }}>
                    Review
                  </Button>
                </div>
              </div>
              {lc1.verification_reason && (
                <p className="text-[11px] text-muted-foreground rounded-lg bg-muted px-2 py-1.5 break-words">
                  <span className="font-semibold">Decision reason:</span> {lc1.verification_reason}
                </p>
              )}
              {/* Service Centre manager's vetting note for this LC1 chairperson */}
              <ServiceCentreNoteLoader table="lc1_chairpersons" id={lc1.id} />
              {/* Landlords under this LC1 */}
              {lc1.landlords.length > 0 && (
                <div className="mt-2 pl-3 border-l-2 border-primary/20 space-y-1.5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Landlords</p>
                  {lc1.landlords.map(ll => (
                    <div key={ll.id} className="flex items-center justify-between gap-2 py-1">
                      <div className="min-w-0">
                        <p className="text-xs font-medium truncate">{ll.name}</p>
                        {ll.property_address && <p className="text-[10px] text-muted-foreground truncate">{ll.property_address}</p>}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <VerifyLandlordButton
                          landlordId={ll.id}
                          landlordName={ll.name}
                          verified={!!ll.verified}
                          onVerified={() => { refetchLC1(); refetchAll(); }}
                        />
                        <PhoneLinks phone={ll.phone} name={ll.name} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {filtered.length === 0 && <p className="text-center text-muted-foreground py-8">No LC1 chairpersons found</p>}
          {lc1Groups.length === 0 && !search && <p className="text-center text-muted-foreground py-8">No LC1 data recorded yet</p>}
        </div>
      </div>
      <LandlordDialogs
        editLandlord={editLandlord} setEditLandlord={setEditLandlord}
        editLC1={editLC1} setEditLC1={setEditLC1}
        assignPerson={assignPerson} setAssignPerson={setAssignPerson}
        deleteLandlord={deleteLandlord} setDeleteLandlord={setDeleteLandlord}
        deleteReason={deleteReason} setDeleteReason={setDeleteReason}
        deleting={deleting} setDeleting={setDeleting}
        previewImages={previewImages} setPreviewImages={setPreviewImages}
        adjustListing={adjustListing} setAdjustListing={setAdjustListing}
        actionDialog={actionDialog} setActionDialog={setActionDialog}
        reverseLandlord={reverseLandlord} setReverseLandlord={setReverseLandlord}
        user={user} refetchAll={refetchAll} queryClient={queryClient}
      />
      <BulkImportLC1Dialog
        open={bulkImportOpen}
        onClose={() => setBulkImportOpen(false)}
        onImported={refetchAll}
      />
      </>
    );
  }

  // ─── LC1 DUPLICATES VIEW (dedicated section) ───
  if (view === 'lc1-duplicates') {
    return (
      <div className="space-y-3">
        <BackButton />
        <h2 className="text-lg font-bold flex items-center gap-2"><Layers className="h-5 w-5 text-rose-600" /> LC1 Duplicates</h2>
        <p className="text-sm text-muted-foreground">
          Review duplicate LC1 chairperson phone rows and merge them into a single canonical record.
        </p>
        <Lc1DuplicatesPanel onResolved={() => { refetchLC1(); refetchAll(); }} />
      </div>
    );
  }

  // ─── LC1 VERIFICATION INBOX VIEW (single queue for every incoming request) ───
  if (view === 'lc1-requests') {
    return (
      <div className="space-y-3">
        <BackButton />
        <h2 className="text-lg font-bold flex items-center gap-2"><ShieldQuestion className="h-5 w-5 text-amber-600" /> Agents requesting LC1 verification</h2>
        <p className="text-sm text-muted-foreground">
          Every LC1 chairperson awaiting review lands here — whether an agent raised it while posting a rent request or
          it came in through registration. Approved chairpersons move to <span className="font-semibold">LC1 Chairpersons</span>;
          rejected ones stay in the Rejected tab with the reason and the agent penalty on record.
        </p>
        <Lc1VerificationInboxPanel standalone onResolved={() => { refetchLC1(); refetchAll(); }} />
      </div>
    );
  }

  // ─── LANDLORD GPS VERIFICATION VIEW (set pending/verified/rejected with reason) ───
  if (view === 'residence-verify') {
    return (
      <>
      <div className="space-y-4">
        <BackButton />
        <h2 className="text-lg font-bold flex items-center gap-2"><MapPin className="h-5 w-5 text-sky-600" /> Landlord GPS Verification</h2>
        <p className="text-sm text-muted-foreground">
          Landlord residence &amp; GPS moderation only. LC1 chairperson decisions moved to
          {' '}
          <button className="font-semibold text-amber-700 underline" onClick={() => setView('lc1-requests')}>Agents requesting LC1 verification</button>.
        </p>
        <ResidenceVerificationPanel />
      </div>
      {renderDialogs()}
      </>
    );
  }

  // ─── CITIES VIEW ───
  if (view === 'cities') {
    const filtered = search
      ? cityGroups.filter(g => g.city.toLowerCase().includes(search.toLowerCase()))
      : cityGroups;
    return (
      <>
      <div className="space-y-3">
        <BackButton />
        <h2 className="text-lg font-bold flex items-center gap-2"><Globe className="h-5 w-5 text-teal-600" /> Cities We Operate In ({cityGroups.length})</h2>
        <div className="rounded-xl border-2 border-teal-500/30 bg-teal-500/5 p-3 flex items-center gap-3">
          <Globe className="h-5 w-5 text-teal-600 shrink-0" />
          <p className="text-sm font-semibold text-teal-800 dark:text-teal-300">
            🌍 Welile is active in <span className="font-extrabold">{cityGroups.length}</span> {cityGroups.length === 1 ? 'city' : 'cities'}
          </p>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search city…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9 h-11" />
          {search && <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2"><X className="h-4 w-4 text-muted-foreground" /></button>}
        </div>
        <DrilldownTable
          data={filtered}
          rowKey={(c, i) => `${c.city}-${i}`}
          emptyMessage="No cities found"
          onRowClick={(c) => openEntity('city', c)}
          columns={[
            { key: 'city', label: 'City', render: (c) => <span className="font-semibold">{c.city}</span> },
            { key: 'listingCount', label: 'Houses', align: 'right' },
            { key: 'tenantCount', label: 'Tenants', align: 'right' },
          ] as DrilldownColumn<typeof filtered[number]>[]}
        />
        <div className="space-y-2">
          {filtered.map((city, i) => (
            <div key={i} className="rounded-xl border border-border bg-card p-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-10 w-10 rounded-xl bg-teal-500/10 flex items-center justify-center shrink-0">
                  <MapPin className="h-5 w-5 text-teal-600" />
                </div>
                <p className="font-bold text-sm truncate">{city.city}</p>
              </div>
              <div className="flex flex-col items-end gap-0.5 shrink-0">
                {city.listingCount > 0 && (
                  <Badge className="bg-green-500/20 text-green-700 border-0 text-[10px]">
                    <Home className="h-2.5 w-2.5 mr-0.5" />{city.listingCount} {city.listingCount === 1 ? 'house' : 'houses'}
                  </Badge>
                )}
                {city.tenantCount > 0 && (
                  <Badge className="bg-blue-500/20 text-blue-700 border-0 text-[10px]">
                    <Users className="h-2.5 w-2.5 mr-0.5" />{city.tenantCount} {city.tenantCount === 1 ? 'tenant' : 'tenants'}
                  </Badge>
                )}
              </div>
            </div>
          ))}
          {filtered.length === 0 && <p className="text-center text-muted-foreground py-8">No cities found</p>}
        </div>
      </div>
      {renderDialogs()}
      </>
    );
  }

  // ─── NO LANDLORD VIEW ───
  if (view === 'no-landlord') {
    const filtered = search
      ? noLandlordList.filter(t =>
          t.tenant_name.toLowerCase().includes(search.toLowerCase()) ||
          t.tenant_phone?.includes(search) ||
          t.agent_name?.toLowerCase().includes(search.toLowerCase()) ||
          t.request_city?.toLowerCase().includes(search.toLowerCase())
        )
      : noLandlordList;
    return (
      <>
      <div className="space-y-3">
        <BackButton />
        <h2 className="text-lg font-bold flex items-center gap-2"><UserX className="h-5 w-5 text-orange-600" /> No Landlord Listed ({noLandlordList.length})</h2>
        {noLandlordList.length > 0 && (
          <div className="rounded-xl border-2 border-orange-400/40 bg-orange-50 dark:bg-orange-950/30 p-3 space-y-1">
            <p className="text-sm font-semibold text-orange-800 dark:text-orange-300">
              📢 {noLandlordList.length} tenants have no landlord property listed
            </p>
            <p className="text-[11px] text-orange-700 dark:text-orange-400">
              Contact them or their agents to list the property and earn UGX 2,000 bonus!
            </p>
          </div>
        )}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search tenant, agent, or city…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9 h-11" />
          {search && <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2"><X className="h-4 w-4 text-muted-foreground" /></button>}
        </div>
        <DrilldownTable
          data={filtered}
          rowKey={(t) => t.id}
          emptyMessage="All tenants have landlords listed"
          onRowClick={(t) => openEntity('no-landlord', t)}
          columns={[
            { key: 'tenant_name', label: 'Tenant', render: (t) => <span className="font-semibold">{t.tenant_name}</span> },
            { key: 'request_city', label: 'City', render: (t) => t.request_city || '—' },
            { key: 'rent_amount', label: 'Rent', align: 'right', render: (t) => `UGX ${t.rent_amount.toLocaleString()}` },
            { key: 'status', label: 'Status' },
            { key: 'agent_name', label: 'Agent', render: (t) => t.agent_name || '—' },
          ] as DrilldownColumn<typeof filtered[number]>[]}
        />
        <div className="space-y-2">
          {filtered.map(t => (
            <div key={t.id} className="rounded-xl border border-border bg-card p-4 space-y-3">
              {/* Tenant info */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-bold text-sm truncate">{t.tenant_name}</p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    <Badge variant="outline" className="text-[10px]">UGX {t.rent_amount.toLocaleString()}</Badge>
                    {t.request_city && (
                      <Badge className="bg-teal-500/20 text-teal-700 border-0 text-[10px]">
                        <MapPin className="h-2.5 w-2.5 mr-0.5" />{t.request_city}
                      </Badge>
                    )}
                    {t.house_category && (
                      <Badge variant="outline" className="text-[10px]">{t.house_category}</Badge>
                    )}
                    <Badge className={`border-0 text-[10px] ${
                      t.status === 'repaying' ? 'bg-green-500/20 text-green-700' :
                      t.status === 'approved' || t.status === 'funded' ? 'bg-blue-500/20 text-blue-700' :
                      'bg-amber-500/20 text-amber-700'
                    }`}>{t.status}</Badge>
                  </div>
                </div>
                <Badge className="bg-orange-500/20 text-orange-700 border-0 text-[10px] shrink-0">
                  <UserX className="h-2.5 w-2.5 mr-0.5" />No Landlord
                </Badge>
              </div>

              {/* Contact Tenant */}
              {t.tenant_phone && (
                <div className="rounded-lg bg-muted/50 p-2.5 space-y-1.5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Contact Tenant</p>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium truncate">{t.tenant_name}</span>
                    <ListPropertyCTA phone={t.tenant_phone} name={t.tenant_name} role="tenant" />
                  </div>
                </div>
              )}

              {/* Contact Agent */}
              {t.agent_id && t.agent_phone && (
                <div className="rounded-lg bg-indigo-500/10 p-2.5 space-y-1.5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Contact Agent</p>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium truncate">{t.agent_name || 'Agent'}</span>
                    <ListPropertyCTA phone={t.agent_phone} name={t.agent_name || undefined} role="agent" />
                  </div>
                </div>
              )}
              {t.agent_id && !t.agent_phone && (
                <div className="rounded-lg bg-red-500/10 p-2.5">
                  <p className="text-[10px] font-semibold text-red-700 dark:text-red-400 flex items-center gap-1">
                    <UserX className="h-3 w-3" /> Agent profile missing — no contact info
                  </p>
                </div>
              )}
              {!t.agent_id && (
                <div className="rounded-lg bg-red-500/10 p-2.5">
                  <p className="text-[10px] font-semibold text-red-700 dark:text-red-400 flex items-center gap-1">
                    <UserX className="h-3 w-3" /> No agent assigned
                  </p>
                </div>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="text-center py-12">
              <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-green-500" />
              <p className="font-semibold">All tenants have landlords listed! 🎉</p>
            </div>
          )}
        </div>
      </div>
      {renderDialogs()}
      </>
    );
  }

  // ─── EMPTY HOUSES VIEW ───
  if (view === 'empty') {
    return (
      <>
      <div className="space-y-3">
        <BackButton />
        <h2 className="text-lg font-bold flex items-center gap-2"><DoorOpen className="h-5 w-5 text-destructive" /> Empty Houses ({emptyLandlords.length})</h2>
        {emptyLandlords.length > 0 && (
          <div className="rounded-xl border-2 border-destructive/30 p-3 flex items-start gap-3">
            <DoorOpen className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <p className="text-sm font-semibold text-destructive">{emptyLandlords.length} empty — UGX {fmt(lostMonthlyRevenue ?? 0)}/mo lost revenue</p>
          </div>
        )}
        <DrilldownTable
          data={emptyLandlords}
          rowKey={(l) => l.id}
          emptyMessage="No empty houses"
          onRowClick={(l) => openEntity('landlord', l)}
          columns={[
            { key: 'name', label: 'Landlord', render: (l) => <span className="font-semibold">{l.name}</span> },
            { key: 'phone', label: 'Phone', render: (l) => l.phone || '—' },
            { key: 'houses', label: 'Houses', align: 'right', sortValue: (l) => landlordHouseCounts.get(l.id) || l.number_of_houses || 0, render: (l) => landlordHouseCounts.get(l.id) || l.number_of_houses || 0 },
            { key: 'monthly_rent', label: 'Rent', align: 'right', render: (l) => `UGX ${fmt(l.monthly_rent || 0)}` },
          ] as DrilldownColumn<typeof emptyLandlords[number]>[]}
        />
        <div className="space-y-2">
          {emptyLandlords.map(landlord => {
            const houseCount = landlordHouseCounts.get(landlord.id) || landlord.number_of_houses || 0;
            return (
              <div key={landlord.id} className="rounded-xl border border-border bg-card p-4 space-y-2">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <p className="font-bold text-sm truncate">{landlord.name}</p>
                    {landlord.phone && <p className="text-xs text-muted-foreground">{landlord.phone}</p>}
                  </div>
                  <Badge variant="outline" className="text-[10px]">{houseCount} {houseCount === 1 ? 'house' : 'houses'}</Badge>
                </div>
                <div className="rounded-lg bg-orange-500/10 px-2.5 py-1.5">
                  <p className="text-[10px] font-semibold text-orange-700 dark:text-orange-400 flex items-center gap-1">
                    <UserX className="h-3 w-3" /> No tenants linked
                  </p>
                </div>
                {landlord.property_address && <p className="text-[10px] text-muted-foreground flex items-center gap-0.5"><MapPin className="h-2.5 w-2.5" />{landlord.property_address}</p>}
              </div>
            );
          })}
          {emptyLandlords.length === 0 && (
            <div className="text-center py-12">
              <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-green-500" />
              <p className="font-semibold">No empty houses! 🎉</p>
            </div>
          )}
        </div>
      </div>
      {renderDialogs()}
      </>
    );
  }

  // ─── OCCUPIED HOUSES VIEW ───
  if (view === 'occupied') {
    return (
      <>
      <div className="space-y-3">
        <BackButton />
        <h2 className="text-lg font-bold flex items-center gap-2"><UserCheck className="h-5 w-5 text-green-600" /> Occupied Houses ({occupiedLandlords.length})</h2>
        <DrilldownTable
          data={occupiedLandlords}
          rowKey={(l) => l.id}
          emptyMessage="No occupied houses"
          onRowClick={(l) => openEntity('landlord', l)}
          columns={[
            { key: 'name', label: 'Landlord', render: (l) => <span className="font-semibold">{l.name}</span> },
            { key: 'phone', label: 'Phone', render: (l) => l.phone || '—' },
            { key: 'tenants', label: 'Tenants', align: 'right', sortValue: (l) => l.tenants?.length || 0, render: (l) => l.tenants?.length || 0 },
            { key: 'houses', label: 'Houses', align: 'right', sortValue: (l) => landlordHouseCounts.get(l.id) || l.number_of_houses || 0, render: (l) => landlordHouseCounts.get(l.id) || l.number_of_houses || 0 },
            { key: 'monthly_rent', label: 'Rent', align: 'right', render: (l) => `UGX ${fmt(l.monthly_rent || 0)}` },
          ] as DrilldownColumn<typeof occupiedLandlords[number]>[]}
        />
        <div className="space-y-2">
          {occupiedLandlords.map(landlord => {
            const houseCount = landlordHouseCounts.get(landlord.id) || landlord.number_of_houses || 0;
            return (
              <div key={landlord.id} className="rounded-xl border border-border bg-card p-4 space-y-2">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <p className="font-bold text-sm truncate">{landlord.name}</p>
                    {landlord.phone && <p className="text-xs text-muted-foreground">{landlord.phone}</p>}
                  </div>
                  <Badge variant="outline" className="text-[10px]">{houseCount} {houseCount === 1 ? 'house' : 'houses'}</Badge>
                </div>
                {landlord.tenants && landlord.tenants.length > 0 && (
                  <div className="space-y-1">
                    {landlord.tenants.map((t: { name: string; phone: string | null }, idx: number) => (
                      <div key={idx} className="flex items-center justify-between gap-2 rounded-lg bg-green-500/10 px-2.5 py-1.5">
                        <div className="min-w-0">
                          <p className="text-[10px] font-semibold text-green-700 dark:text-green-400">👤 Tenant</p>
                          <p className="text-xs font-medium truncate">{t.name}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {landlord.property_address && <p className="text-[10px] text-muted-foreground flex items-center gap-0.5"><MapPin className="h-2.5 w-2.5" />{landlord.property_address}</p>}
              </div>
            );
          })}
        </div>
      </div>
      {renderDialogs()}
      </>
    );
  }

  // ─── VERIFICATION VIEW ───
  if (view === 'verify') {
    const VERIFY_FILTERS: { value: VerifyFilter; label: string }[] = [
      { value: 'all', label: 'All Pending' },
      { value: 'has_landlord', label: 'Has Landlord' },
      { value: 'no_landlord', label: 'No Landlord' },
      { value: 'has_images', label: 'Has Photos' },
      { value: 'has_gps', label: 'Has GPS' },
      { value: 'has_lc1', label: 'Has LC1' },
      // Hidden/visible are sub-filters of the scope (hidden is no longer a
      // top-level status chip — hidden houses are verified houses).
      ...(houseStatusFilter === 'verified' || houseStatusFilter === 'all'
        ? ([
            { value: 'hidden' as VerifyFilter, label: 'Hidden from tenants' },
            { value: 'visible' as VerifyFilter, label: 'Live to tenants' },
          ])
        : []),
    ];

    // Status scope: pending | verified | hidden | rejected | all
    // Scope, search term, date range and sort are all resolved server-side by
    // ops_search_house_listings, which also returns the true total match count.
    // Nothing here is capped by a client-side row limit any more.
    const searchActive = debouncedVerifySearch.length >= 2;
    const dateRangeActive = !!(verifyDateFrom || verifyDateTo);
    const scopeListings = serverHouseRows.filter(
      l => houseStatusFilter === 'verified' || !optimisticallyVerifiedIds.has(l.id),
    );
    // Quick filters are applied server-side by ops_search_house_listings.
    const filteredHouses = scopeListings;

    // ── Server-side pagination ──
    // totalFiltered is the DB match count for the active scope/search/date.
    const totalFiltered = serverHouseTotal;
    const displayedHouses = filteredHouses;
    const hasMoreHouses = !!hasMoreHousePages;

    return (
      <>
      <div className="space-y-3">
        <BackButton />
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-lg font-bold flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-amber-600" /> Verification Queue</h2>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-9 gap-1.5"
              disabled={exportingHouseReport}
              onClick={() => void exportHouseReportPdf()}
              title="Export a full PDF report for the filters currently applied"
            >
              {exportingHouseReport
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <FileDown className="h-4 w-4" />}
              Export PDF
            </Button>
            <Badge variant="outline" className="text-sm font-bold px-3 py-1 bg-amber-100 text-amber-700 border-amber-300">{totalFiltered.toLocaleString()} {houseStatusFilter === 'all' ? 'houses' : houseStatusFilter === 'rejected' ? 'rejected' : houseStatusFilter}</Badge>
          </div>
        </div>

        {/* Thumb-friendly status filter chips */}
        <div className="flex gap-2 flex-wrap items-center">
          {([
            { value: 'pending' as HouseStatusFilter, label: 'Pending', count: houseStatusCounts?.pending ?? 0, color: 'amber' },
            { value: 'verified' as HouseStatusFilter, label: 'Verified', count: houseStatusCounts?.verified ?? 0, color: 'emerald' },
            { value: 'rejected' as HouseStatusFilter, label: 'Rejected', count: houseStatusCounts?.rejected ?? 0, color: 'rose' },
            { value: 'all' as HouseStatusFilter, label: 'All houses', count: houseStatusCounts?.all ?? 0, color: 'primary' },
          ]).map(s => {
            const active = houseStatusFilter === s.value;
            const colorMap: Record<string, string> = {
              amber: active ? 'bg-amber-500 text-white border-amber-500' : 'bg-background text-amber-700 border-amber-300 hover:bg-amber-50',
              emerald: active ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-background text-emerald-700 border-emerald-300 hover:bg-emerald-50',
              slate: active ? 'bg-slate-500 text-white border-slate-500' : 'bg-background text-muted-foreground border-border hover:bg-muted',
              rose: active ? 'bg-rose-500 text-white border-rose-500' : 'bg-background text-rose-700 border-rose-300 hover:bg-rose-50',
              primary: active ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-primary border-primary/30 hover:bg-primary/5',
            };
            return (
              <button
                key={s.value}
                onClick={() => setHouseStatusFilter(s.value)}
                className={`min-h-[44px] px-4 py-2 rounded-full text-sm font-bold transition-all border shadow-sm flex items-center gap-1.5 ${colorMap[s.color]}`}
              >
                {s.label}
                <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full ${active ? 'bg-white/25 text-white' : 'bg-muted text-muted-foreground'}`}>
                  {s.count.toLocaleString()}
                </span>
              </button>
            );
          })}
          {(houseStatusFilter !== 'pending' || verifyFilter !== 'all' || verifySearch || verifyDateFrom || verifyDateTo) && (
            <button
              onClick={() => { setHouseStatusFilter('pending'); setVerifyFilter('all'); setVerifySearch(''); setVerifyDateFrom(''); setVerifyDateTo(''); }}
              className="min-h-[44px] px-3 py-2 rounded-full text-sm font-semibold text-muted-foreground border border-border bg-background hover:bg-muted transition-all flex items-center gap-1.5"
              title="Reset filters"
            >
              <RotateCcw className="h-4 w-4" />
              Reset
            </button>
          )}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search house, landlord, agent, phone, or location…"
            value={verifySearch}
            onChange={e => setVerifySearch(e.target.value)}
            className="pl-9 pr-9 h-11"
          />
          {verifySearch && (
            <button onClick={() => setVerifySearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground" aria-label="Clear">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {debouncedVerifySearch.length >= 2 && (
          <p className="text-[11px] text-muted-foreground -mt-1 pl-1">
            {isHouseSearchFetching
              ? 'Searching all agents & listings…'
              : `${totalFiltered.toLocaleString()} match${totalFiltered === 1 ? '' : 'es'} across every listing in this scope.`}
          </p>
        )}

        {/* Hidden houses live inside Verified now — surface the subset count so
            nothing is lost by removing the old sibling "Hidden" chip. */}
        {(houseStatusFilter === 'verified' || houseStatusFilter === 'all') && (houseStatusCounts?.hidden ?? 0) > 0 && (
          <p className="text-[11px] text-muted-foreground -mt-1 pl-1">
            {(houseStatusCounts?.hidden ?? 0).toLocaleString()} of these verified houses are currently hidden from the tenant feed —
            {' '}
            <button
              onClick={() => setVerifyFilter(verifyFilter === 'hidden' ? 'all' : 'hidden')}
              className="underline font-semibold hover:text-foreground"
            >
              {verifyFilter === 'hidden' ? 'show all again' : 'show only those'}
            </button>
          </p>
        )}

        {/* Date range filter — applied to the STATE date, not registration date */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground font-medium">
            {houseStatusFilter === 'verified' ? 'Verified between:'
              : houseStatusFilter === 'rejected' ? 'Rejected between:'
              : houseStatusFilter === 'pending' ? 'Registered between:'
              : 'Status changed between:'}
          </span>
          <Input
            type="date"
            value={verifyDateFrom}
            onChange={e => setVerifyDateFrom(e.target.value)}
            className="h-8 w-auto text-xs"
            aria-label="From date"
          />
          <span className="text-[11px] text-muted-foreground">to</span>
          <Input
            type="date"
            value={verifyDateTo}
            onChange={e => setVerifyDateTo(e.target.value)}
            className="h-8 w-auto text-xs"
            aria-label="To date"
          />
          {(verifyDateFrom || verifyDateTo) && (
            <button onClick={() => { setVerifyDateFrom(''); setVerifyDateTo(''); }} className="text-[11px] text-muted-foreground hover:text-foreground underline">
              clear
            </button>
          )}
          {isDateRangeFetching && (
            <span className="text-[11px] text-muted-foreground">Loading date range…</span>
          )}
        </div>

        {/* Quick filter chips */}
        <div className="flex gap-1.5 flex-wrap">
          {VERIFY_FILTERS.map(f => {
            const count = houseQuickCounts ? (houseQuickCounts as any)[f.value] ?? 0 : 0;
            const active = verifyFilter === f.value;
            return (
              <button
                key={f.value}
                onClick={() => setVerifyFilter(f.value)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all border ${
                  active
                    ? 'bg-amber-100 text-amber-700 border-amber-300 shadow-sm'
                    : 'bg-background text-muted-foreground border-border hover:bg-muted'
                }`}
              >
                {f.label}
                <span className="ml-1 opacity-70">({count})</span>
              </button>
            );
          })}
        </div>

        {/* Sort */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground font-medium">Sort:</span>
          <div className="flex gap-1.5">
            {([
              { value: 'newest' as SortOption, label: 'Newest' },
              { value: 'oldest' as SortOption, label: 'Oldest' },
              { value: 'recently_updated' as SortOption, label: 'Recently Updated' },
              { value: 'highest_rent' as SortOption, label: 'Highest Rent' },
            ]).map(s => (
              <button
                key={s.value}
                onClick={() => setVerifySort(s.value)}
                className={`px-2 py-0.5 rounded-full text-[11px] font-semibold transition-all border ${
                  verifySort === s.value
                    ? 'bg-primary/10 text-primary border-primary/30'
                    : 'bg-background text-muted-foreground border-border hover:bg-muted'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <ListingBonusApprovalQueue filter="all" collapsible defaultOpen={false} />
        <VerificationTimelinePanel />

        {/* ── Bulk selection bar ── */}
        {filteredHouses.length > 0 && (() => {
          const selectedHouses = filteredHouses.filter(h => verifySelectedIds.has(h.id));
          const allSelected = selectedHouses.length === filteredHouses.length;
          const anySelected = selectedHouses.length > 0;
          return (
            <div className="sticky top-0 z-10 rounded-xl border border-border bg-card/95 backdrop-blur p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <button
                  onClick={() => allSelected ? clearVerifySelection() : setVerifySelectedIds(new Set(filteredHouses.map(h => h.id)))}
                  className="flex items-center gap-2 text-sm font-semibold"
                >
                  <Checkbox checked={allSelected} className="pointer-events-none" />
                  {allSelected ? 'Clear all' : 'Select all'}
                </button>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs font-bold">{selectedHouses.length} selected</Badge>
                  {hasMoreHouses && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 px-2.5 text-[11px] font-semibold gap-1.5"
                      disabled={isFetchingMoreHouses}
                      onClick={() => { fetchMoreHouses(); }}
                    >
                      {isFetchingMoreHouses
                        ? 'Loading…'
                        : `Load more (${Math.max(totalFiltered - displayedHouses.length, 0).toLocaleString()})`}
                    </Button>
                  )}
                </div>
              </div>

              {anySelected && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Button size="sm" variant="outline" className="h-10 gap-1.5 font-semibold" disabled={bulkBusy !== null} onClick={() => handleBulkHide(selectedHouses, true)}>
                    <EyeOff className="h-4 w-4" />{bulkBusy === 'hide' ? '…' : 'Hide'}
                  </Button>
                  <Button size="sm" variant="outline" className="h-10 gap-1.5 font-semibold" disabled={bulkBusy !== null} onClick={() => handleBulkHide(selectedHouses, false)}>
                    <Eye className="h-4 w-4" />{bulkBusy === 'unhide' ? '…' : 'Unhide'}
                  </Button>
                  <Button size="sm" className="h-10 gap-1.5 font-semibold" disabled={bulkBusy !== null} onClick={() => handleBulkVerify(selectedHouses)}>
                    <ShieldCheck className="h-4 w-4" />{bulkBusy === 'verify' ? '…' : 'Verify'}
                  </Button>
                  <Button size="sm" variant="outline" className="h-10 gap-1.5 font-semibold border-destructive/40 text-destructive hover:bg-destructive/10" disabled={bulkBusy !== null} onClick={() => handleBulkReject(selectedHouses)}>
                    <XCircle className="h-4 w-4" />
                    {bulkBusy === 'reject'
                      ? (bulkProgress ? `${bulkProgress.done}/${bulkProgress.total}` : '…')
                      : 'Reject'}
                  </Button>
                </div>
              )}
            </div>
          );
        })()}

        <div className="space-y-3">
          {(() => {
            const visibleAgentIds = displayedHouses
              .map((h) => h.agent_id)
              .filter((x): x is string => !!x);
            return displayedHouses.map(house => (
            <div key={house.id} className={`rounded-xl border bg-card overflow-hidden ${verifySelectedIds.has(house.id) ? 'border-primary ring-1 ring-primary/40' : 'border-border'}`}>
              {/* ── Card Header ── */}
              <div className="p-4 pb-3 space-y-3">
                <div className="flex gap-3">
                  {/* Bulk select checkbox */}
                  <div className="shrink-0 pt-1">
                    <Checkbox
                      checked={verifySelectedIds.has(house.id)}
                      onCheckedChange={() => toggleVerifySelect(house.id)}
                    />
                  </div>
                  {/* Thumbnail */}
                  <div className="shrink-0 w-20 h-20 rounded-xl overflow-hidden bg-muted border border-border relative">
                    {house.image_urls?.[0] ? (
                      <button onClick={() => setPreviewImages({ images: house.image_urls!, title: house.title })} className="w-full h-full">
                        <StorageImage src={house.image_urls[0]} alt={house.title} className="w-full h-full object-cover" />
                        {house.image_urls.length > 1 && (
                          <span className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[9px] font-bold py-0.5">
                            {house.image_urls.length} photos
                          </span>
                        )}
                      </button>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Home className="h-6 w-6 text-muted-foreground/30" />
                      </div>
                    )}
                  </div>
                  {/* House Title & Rent */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <p className="font-bold text-base leading-tight truncate">{house.title}</p>
                    <p className="text-[11px] text-muted-foreground truncate flex items-center gap-1">
                      <MapPin className="h-3 w-3 shrink-0" />
                      {house.address ? `${house.address} · ` : ''}{house.village ? `${house.village} · ` : ''}{house.region}{house.district ? `, ${house.district}` : ''}
                    </p>
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      <Badge variant="outline" className="text-[10px] h-5 px-1.5">{house.house_category}</Badge>
                      <Badge variant="outline" className="text-[10px] h-5 px-1.5">{house.number_of_rooms} rooms</Badge>
                      <Badge className="bg-primary/10 text-primary border-0 text-[10px] h-5 px-1.5 font-bold">UGX {house.monthly_rent.toLocaleString()}/mo</Badge>
                      {house.verified && (
                        <Badge className="bg-emerald-100 text-emerald-700 border-0 text-[10px] h-5 px-1.5 font-bold"><CheckCircle2 className="h-3 w-3 mr-0.5" />Verified</Badge>
                      )}
                      {house.is_hidden && (
                        <Badge className="bg-slate-200 text-muted-foreground border-0 text-[10px] h-5 px-1.5 font-bold"><EyeOff className="h-3 w-3 mr-0.5" />Hidden</Badge>
                      )}
                    </div>
                  </div>
                </div>
                {/* ── All agent-attached photos (full strip, not just the cover) ── */}
                {Array.isArray(house.image_urls) && house.image_urls.length > 1 && (
                  <div className="space-y-1">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Agent photos ({house.image_urls.length})
                    </p>
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {house.image_urls.map((url, i) => (
                        <button
                          key={`${house.id}-img-${i}`}
                          onClick={() => setPreviewImages({ images: house.image_urls!, title: house.title, startIndex: i })}
                          className="shrink-0 h-16 w-16 rounded-lg overflow-hidden border border-border bg-muted"
                          aria-label={`Open photo ${i + 1} of ${house.image_urls!.length}`}
                        >
                          <StorageImage src={url} alt={`${house.title} photo ${i + 1}`} className="w-full h-full object-cover" expandable={false} />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* ── Divider ── */}
              <div className="h-px bg-border mx-4" />

              {/* ── Prominent Landlord Section ── */}
              {house.landlords ? (
                <div className="p-4 py-3 bg-sky-500/5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <Building2 className="h-3 w-3" />
                    Registered Landlord
                  </p>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-bold text-foreground truncate">{house.landlords.name}</p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <PhoneLinks phone={house.landlords.phone} name={house.landlords.name} />
                        {house.landlords.mobile_money_name && (
                          <Badge variant="outline" className="text-[9px] h-4 px-1 border-sky-300 text-sky-700">
                            MoMo: {house.landlords.mobile_money_name}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {house.landlords.verified ? (
                        <Badge className="bg-emerald-100 text-emerald-700 border-0 text-[10px] h-5 px-2">
                          <CheckCircle2 className="h-3 w-3 mr-1" /> Verified
                        </Badge>
                      ) : (
                        <Badge className="bg-amber-100 text-amber-700 border-0 text-[10px] h-5 px-2">
                          <AlertTriangle className="h-3 w-3 mr-1" /> Unverified
                        </Badge>
                      )}
                      {house.landlords.has_smartphone != null && (
                        house.landlords.has_smartphone ? (
                          <Badge className="bg-green-100 text-green-700 border-0 text-[9px] h-4 px-1.5">Smartphone</Badge>
                        ) : (
                          <Badge className="bg-orange-100 text-orange-700 border-0 text-[9px] h-4 px-1.5">No Smartphone</Badge>
                        )
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-4 py-3 bg-orange-500/5">
                  <div className="flex items-center gap-2">
                    <UserX className="h-4 w-4 text-orange-600" />
                    <p className="text-sm font-semibold text-orange-700 dark:text-orange-300">No landlord linked to this listing</p>
                  </div>
                  <Button size="sm" variant="outline" className="mt-2 h-8 text-xs gap-1 border-orange-300 text-orange-700 hover:bg-orange-100" onClick={() => handleAssignPerson(house.id, house.title, 'landlord')}>
                    <UserPlus className="h-3 w-3" /> Link Landlord
                  </Button>
                </div>
              )}

              {/* ── Agent & LC1 Details ── */}
              <div className="px-4 py-3 space-y-2">
                {/* Agent */}
                {house.agent_name && (
                  <div className="rounded-lg bg-indigo-500/5 px-3 py-2 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Listing Agent</p>
                        <p className="text-xs font-medium truncate">{house.agent_name}</p>
                      </div>
                      {house.agent_phone && <PhoneLinks phone={house.agent_phone} name={house.agent_name} />}
                    </div>
                    {house.agent_email && (
                      <a href={`mailto:${house.agent_email}`} className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline break-all">
                        <Mail className="h-3 w-3 shrink-0" /> {house.agent_email}
                      </a>
                    )}
                    {house.agent_id && (
                      <div className="pt-1.5 mt-1 border-t border-indigo-500/10">
                        <BatchedAgentListingBlockControl
                          agentId={house.agent_id}
                          agentName={house.agent_name}
                          agentIdsInView={visibleAgentIds}
                        />
                      </div>
                    )}
                  </div>
                )}
                {/* LC1 — always shown on every card, even when none is linked */}
                {house.lc1_chairperson_name ? (
                  <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-500/5 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">LC1 Chairperson</p>
                      <p className="text-xs font-medium truncate">{house.lc1_chairperson_name}</p>
                      {house.lc1_chairperson_village && (
                        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <MapPin className="h-2.5 w-2.5" />{house.lc1_chairperson_village}
                        </p>
                      )}
                    </div>
                    {house.lc1_chairperson_phone && (
                      <PhoneLinks phone={house.lc1_chairperson_phone} name={house.lc1_chairperson_name} />
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-lg bg-amber-500/5 px-3 py-2">
                    <ShieldCheck className="h-4 w-4 text-amber-600 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">LC1 Chairperson</p>
                      <p className="text-xs font-medium text-amber-700 dark:text-amber-300">No LC1 chairperson linked to this listing</p>
                    </div>
                  </div>
                )}
                {/* GPS */}
                {house.latitude && house.longitude && (
                  <a href={`https://www.google.com/maps?q=${house.latitude},${house.longitude}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-primary hover:underline text-[11px] font-medium">
                    <MapPinned className="h-3.5 w-3.5" /> View exact location on Google Maps
                  </a>
                )}

                {/* ── Listing metadata for approval review ── */}
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 pt-2 mt-1 border-t border-border">
                  <div>
                    <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Category</p>
                    <p className="text-[11px] font-medium">{house.house_category || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Rooms</p>
                    <p className="text-[11px] font-medium">{house.number_of_rooms ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-[9px] uppercase tracking-wide text-muted-foreground flex items-center gap-1"><Banknote className="h-3 w-3" /> Monthly rent</p>
                    {editingRentId === house.id ? (
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <Input
                          type="number"
                          value={editRentValue}
                          onChange={(e) => setEditRentValue(e.target.value)}
                          className="h-7 text-[11px] px-2 py-0.5 w-28"
                          disabled={savingRentId === house.id}
                          autoFocus
                        />
                        <Button
                          size="sm"
                          className="h-7 px-2 text-[10px]"
                          disabled={savingRentId === house.id}
                          onClick={() => handleUpdateMonthlyRent(house, Number(editRentValue))}
                        >
                          {savingRentId === house.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[10px]"
                          disabled={savingRentId === house.id}
                          onClick={() => { setEditingRentId(null); setEditRentValue(''); }}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <p className="text-[11px] font-medium">UGX {Number(house.monthly_rent || 0).toLocaleString()}</p>
                        <button
                          onClick={() => { setEditingRentId(house.id); setEditRentValue(String(house.monthly_rent || '')); }}
                          className="text-muted-foreground hover:text-primary transition-colors"
                          title="Edit monthly rent"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                  <div>
                    <p className="text-[9px] uppercase tracking-wide text-muted-foreground flex items-center gap-1"><Banknote className="h-3 w-3" /> Daily rate</p>
                    <p className="text-[11px] font-medium">{house.daily_rate ? `UGX ${Number(house.daily_rate).toLocaleString()}` : '—'}</p>
                  </div>
                  <div>
                    <p className="text-[9px] uppercase tracking-wide text-muted-foreground flex items-center gap-1"><Clock className="h-3 w-3" /> Listed</p>
                    <p className="text-[11px] font-medium">{house.created_at ? new Date(house.created_at).toLocaleDateString() : '—'}</p>
                  </div>
                  <div>
                    <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Status</p>
                    <p className="text-[11px] font-medium capitalize">{house.status || '—'}</p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Listing ID</p>
                    <p className="text-[10px] font-mono text-muted-foreground break-all">{house.id}</p>
                  </div>
                </div>
              </div>

              {/* ── Moderation Actions ── */}
              <div className="p-4 pt-2 bg-muted/30 border-t border-border">
                {/* Hide / unhide from the tenant dashboard — works on ANY house */}
                <div className="mb-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full h-10 gap-2 font-semibold"
                    disabled={!!togglingHide[house.id]}
                    onClick={() => handleToggleHidden(house)}
                  >
                    {house.is_hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                    {togglingHide[house.id]
                      ? 'Saving…'
                      : house.is_hidden
                        ? 'Show on tenant dashboard'
                        : 'Hide from tenant dashboard'}
                  </Button>
                </div>
                {/* Service Centre manager's vetting note for this listing */}
                <div className="mb-2">
                  <ServiceCentreNoteLoader table="house_listings" id={house.id} />
                </div>
                <InlineModerationActions
                  approveHidden={!!house.verified}
                  approveLabel="Verify → UGX 2K"
                  rejectLabel="Reject"
                  onApprove={(note) => handleVerifyListing(house, note)}
                  onReject={(note) => handleRejectListing(house, note)}
                  checklistTitle="Confirm landlord & house details"
                  checklistSubtitle={`Landlord: ${house.landlords?.name || 'Not linked'}`}
                  approveChecklist={[
                    { label: 'This person is the genuine landlord', value: house.landlords?.name || 'No landlord linked' },
                    { label: 'Landlord name is correct', value: house.landlords?.name || '—' },
                    {
                      label: 'House location is correct',
                      value: [house.address, house.village, house.region, house.district].filter(Boolean).join(' · ') || '—',
                    },
                    { label: 'Price of the house listed is correct', value: `UGX ${Number(house.monthly_rent || 0).toLocaleString()} / month` },
                    { label: 'LC chairperson of the village is confirmed', value: house.lc1_chairperson_name || 'Not provided' },
                    { label: 'The house has water and electricity', value: undefined },
                    {
                      label: 'Meter number is in whose names',
                      value: [
                        house.landlords?.electricity_meter_number ? `Electricity: ${house.landlords.electricity_meter_number}` : null,
                        house.landlords?.water_meter_number ? `Water: ${house.landlords.water_meter_number}` : null,
                      ].filter(Boolean).join(' · ') || 'Confirm meter ownership',
                    },
                  ]}
                />
              </div>
            </div>
          ));
          })()}
          {hasMoreHouses && (
            <div className="pt-2 flex flex-col items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-10 px-4 font-semibold gap-2"
                disabled={isFetchingMoreHouses}
                onClick={() => { fetchMoreHouses(); }}
              >
                {isFetchingMoreHouses ? 'Loading…' : `Load more (${Math.max(totalFiltered - displayedHouses.length, 0).toLocaleString()} remaining)`}
              </Button>
              <p className="text-[10px] text-muted-foreground">
                Showing {displayedHouses.length.toLocaleString()} of {totalFiltered.toLocaleString()}
              </p>
            </div>
          )}
          {filteredHouses.length === 0 && scopeListings.length > 0 && (
            <div className="text-center py-10">
              <Search className="h-10 w-10 mx-auto mb-2 text-muted-foreground/40" />
              <p className="font-semibold text-muted-foreground">No matches for "{verifySearch}"</p>
              <p className="text-xs text-muted-foreground mt-1">Try a different search or clear filters</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => { setVerifySearch(''); setVerifyFilter('all'); }}>
                Clear Filters
              </Button>
            </div>
          )}
          {scopeListings.length === 0 && !isHouseSearchFetching && (
            <div className="text-center py-12">
              <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-green-500" />
              <p className="font-semibold">{houseStatusFilter === 'all' ? 'No houses found.' : 'No listings in this view.'}</p>
            </div>
          )}
        </div>
      </div>
      {renderDialogs()}
      </>
    );
  }

  // ─── ALL REQUESTS VIEW (landlord lens) ───
  if (view === 'all-requests') {
    return (
      <>
      <div className="space-y-4">
        <BackButton />
        <ExecutiveDataTable
          data={allRequestsRows || []}
          columns={allRequestsColumns}
          loading={allRequestsLoading}
          title="All Requests"
          getRowId={(r: any) => String(r.id)}
          selectedIds={allReqSelectedIds}
          onSelectionChange={setAllReqSelectedIds}
          bulkActions={(ids) => (
            <Button
              variant="destructive"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setAllReqBulkDeleteOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete {ids.length}
            </Button>
          )}
          filters={[{
            key: 'status',
            label: 'Status',
            options: [
              { value: 'pending', label: 'Pending' },
              { value: 'tenant_ops_approved', label: 'Tenant Ops Approved' },
              { value: 'agent_verified', label: 'Agent Verified' },
              { value: 'landlord_ops_approved', label: 'Landlord Ops Approved' },
              { value: 'coo_approved', label: 'COO Approved' },
              { value: 'funded', label: 'Funded' },
              { value: 'repaying', label: 'Repaying' },
              { value: 'fully_repaid', label: 'Fully Repaid' },
              { value: 'defaulted', label: 'Defaulted' },
            ],
          }]}
        />
      </div>
      {renderDialogs()}
      {/* Single-row delete dialog */}
      <AlertDialog
        open={allReqDeleteDialog.open}
        onOpenChange={(open) => !open && !allReqDeleting && setAllReqDeleteDialog({ open: false, requestId: '', tenantName: '' })}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Rent Request</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the rent request for <strong>{allReqDeleteDialog.tenantName}</strong>. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={allReqDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={allReqDeleting}
              onClick={(e) => { e.preventDefault(); handleDeleteOneRentRequest(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {allReqDeleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Bulk delete dialog */}
      <AlertDialog
        open={allReqBulkDeleteOpen}
        onOpenChange={(open) => !open && !allReqDeleting && setAllReqBulkDeleteOpen(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {allReqSelectedIds.length} request{allReqSelectedIds.length === 1 ? '' : 's'}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the selected rent requests. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={allReqDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={allReqDeleting}
              onClick={(e) => { e.preventDefault(); handleBulkDeleteRentRequests(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {allReqDeleting ? 'Deleting…' : `Delete ${allReqSelectedIds.length}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </>
    );
  }

  // ─── PIPELINE VIEW ───
  if (view === 'pipeline') {
    return (
      <>
      <div className="space-y-4">
        <BackButton />
        <RentPipelineQueue stage="tenant_ops_approved" />
        <RejectedRequestsQueue stageFilter="tenant_ops_approved" title="Rejected at Landlord Ops" collapsible />
        <DealPipeline />
      </div>
      {renderDialogs()}
      </>
    );
  }

  // ─── CHAIN VIEW ───
  if (view === 'chain') {
    return (
      <>
      <div className="space-y-4">
        <BackButton />
        <ChainHealthTab />
      </div>
      {renderDialogs()}
      </>
    );
  }

  // ─── MATCHING VIEW ───
  if (view === 'matching') {
    return (
      <>
      <div className="space-y-4">
        <BackButton />
        <TenantMatchingQueue onViewingCreated={() => refetch()} />
      </div>
      {renderDialogs()}
      </>
    );
  }

  // ─── AGENTS VIEW ───
  if (view === 'agents') {
    return (
      <>
      <div className="space-y-3">
        <BackButton />
        <h2 className="text-lg font-bold flex items-center gap-2"><Users className="h-5 w-5 text-indigo-600" /> Listing Agents ({agentSummary.length})</h2>
        <div className="space-y-2">
          {agentSummary.map(([agentId, agent], idx) => {
            const empty = agent.listings.filter(l => l.status === 'available' && !l.tenant_id);
            const occupied = agent.listings.filter(l => l.tenant_id);
            const verified = agent.listings.filter(l => l.verified);
            const occupancyRate = agent.listings.length ? Math.round((occupied.length / agent.listings.length) * 100) : 0;
            return (
              <div key={agentId} className="rounded-xl border border-border bg-card p-4 space-y-2">
                <div className="flex items-center gap-3">
                  <div className={`h-8 w-8 rounded-full flex items-center justify-center font-bold text-sm ${idx < 3 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                    {idx + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm truncate">{agent.name}</p>
                    {agent.phone && <PhoneLinks phone={agent.phone} name={agent.name} />}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-[10px]">{agent.listings.length} listed</Badge>
                  <Badge className="bg-green-500/20 text-green-700 border-0 text-[10px]">{occupied.length} occupied</Badge>
                  <Badge className="bg-red-500/20 text-red-700 border-0 text-[10px]">{empty.length} empty</Badge>
                  <Badge className="bg-blue-500/20 text-blue-700 border-0 text-[10px]">{verified.length} verified</Badge>
                  <Badge className={`border-0 text-[10px] ${occupancyRate >= 70 ? 'bg-green-500/20 text-green-700' : occupancyRate >= 40 ? 'bg-amber-500/20 text-amber-700' : 'bg-red-500/20 text-red-700'}`}>
                    {occupancyRate}% occupancy
                  </Badge>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {renderDialogs()}
      </>
    );
  }

  // ─── ANALYTICS VIEW ───
  if (view === 'analytics') {
    return (
      <>
      <div className="space-y-4">
        <BackButton />
        <h2 className="text-lg font-bold">Analytics</h2>
        <div className="grid grid-cols-2 gap-2">
          <KPICard title="With Photos" value={withImages.length} icon={Image} loading={isLoading} color="bg-blue-500/10 text-blue-600" />
          <KPICard title="GPS Captured" value={withGPS.length} icon={MapPin} loading={isLoading} color="bg-purple-500/10 text-purple-600" />
          <KPICard title="📱 Landlords" value={kpi(smartphoneLandlordsCount)} icon={Smartphone} loading={totalsLoading} color="bg-teal-500/10 text-teal-600" subtitle={`of ${kpi(totalLandlordsCount)}`} />
          <KPICard title="Bonuses Pending" value={`${fmt(pendingHousesCount * 2000)}`} icon={Banknote} loading={isLoading} color="bg-orange-500/10 text-orange-600" subtitle="UGX to agents" />
        </div>
        <VacancyAnalytics listings={rows as any} />
      </div>
      {renderDialogs()}
      </>
    );
  }

  // ─── ADVANCE REQUESTS VIEW ───
  if (view === 'advance-requests') {
    return (
      <>
      <div className="space-y-6">
        <BackButton />
        <h2 className="text-lg font-bold">Business Advances</h2>
        <BusinessAdvanceQueue stage="landlord_ops" />
        <RentHistoryVerificationQueue dept="landlord_ops" />
      </div>
      {renderDialogs()}
      </>
    );
  }

  // ─── LANDLORDS PAID VIEW ───
  if (view === 'landlords-paid') {
    return (
      <>
      <div className="space-y-4">
        <BackButton />
        <LandlordsPaidView />
      </div>
      {renderDialogs()}
      </>
    );
  }

  // ─── LANDLORDS & TENANTS VIEW ───
  if (view === 'landlords-tenants') {
    return (
      <>
      <div className="space-y-4">
        <BackButton />
        <LandlordsWithTenantsView />
      </div>
      {renderDialogs()}
      </>
    );
  }

  // ─── HOUSES BY LANDLORD (bind / swap / remove tenant; reassign agent) ───
  if (view === 'houses-by-landlord') {
    return (
      <>
        <div className="space-y-4">
          <BackButton />
          <LandlordHousesPanel />
        </div>
        {renderDialogs()}
      </>
    );
  }

  // ─── HUB: Agent-initiated landlord verification requests ───
  if (view === 'agent-verify-requests') {
    return (
      <>
        <div className="space-y-4">
          <BackButton />
          <AgentVerificationRequestsPanel onResolved={refetchAll} />
        </div>
        {renderDialogs()}
      </>
    );
  }

  // ─── HUB: LC1 chairperson verification inbox ───
  if (view === 'lc1-inbox') {
    return (
      <>
        <div className="space-y-4">
          <BackButton />
          <Lc1VerificationInboxPanel onResolved={() => { refetchLC1(); refetchAll(); }} />
        </div>
        {renderDialogs()}
      </>
    );
  }

  // ─── HUB: Rent pipeline (landlord stage) ───
  if (view === 'rent-pipeline-queue') {
    return (
      <>
        <div className="space-y-4">
          <BackButton />
          <RentPipelineQueue stage="tenant_ops_approved" />
        </div>
        {renderDialogs()}
      </>
    );
  }

  // ─── HUB: Rejected at Landlord Ops ───
  if (view === 'rejected-queue') {
    return (
      <>
        <div className="space-y-4">
          <BackButton />
          <RejectedRequestsQueue stageFilter="tenant_ops_approved" title="Rejected at Landlord Ops" />
        </div>
        {renderDialogs()}
      </>
    );
  }

  // ─── HUB: Landlord payout review ───
  if (view === 'payout-review') {
    return (
      <>
        <div className="space-y-4">
          <BackButton />
          <LandlordOpsPayoutReview reviewRole="landlord_ops" />
        </div>
        {renderDialogs()}
      </>
    );
  }

  // ─── HUB: Agent rent-request capacity (fleet-wide) ───
  if (view === 'agent-capacity') {
    return (
      <>
        <div className="space-y-4">
          <BackButton />
          <AgentRentCapacityPanel />
        </div>
        {renderDialogs()}
      </>
    );
  }

  // ─── HUB: Service Centre managers & their sub-agent networks ───
  if (view === 'service-centres') {
    return (
      <>
        <div className="space-y-4">
          <BackButton />
          <ServiceCentreManagerNetworkPanel />
        </div>
        {renderDialogs()}
      </>
    );
  }

  // ─── HUB: Reports & Exports ───
  if (view === 'reports') {
    // The From / To pickers below drive every centralized extract, exactly like
    // the Tenant Ops hub. Each entry calls the dashboard's existing export
    // handler — no report logic is duplicated here.
    const hubFromIso = reportFrom ? reportFrom.toISOString() : null;
    const hubToIso = reportTo
      ? new Date(new Date(reportTo).getTime() + 24 * 60 * 60 * 1000 - 1).toISOString()
      : null;
    const hubRangeLabel = reportFrom || reportTo
      ? `${reportFrom ? format(reportFrom, 'dd MMM yyyy') : 'any date'} — ${reportTo ? format(reportTo, 'dd MMM yyyy') : 'today'}`
      : 'no date filter — all time';

    const runLandlordExtract = async (kind: LandlordExtractKind) => {
      setExtractingKind(kind);
      try {
        if (kind === 'payouts-print') {
          await handlePrintReport();
        } else if (kind === 'landlords-funded') {
          await exportFundedReportPdf({
            dateFrom: reportFrom ? format(reportFrom, 'yyyy-MM-dd') : '',
            dateTo: reportTo ? format(reportTo, 'yyyy-MM-dd') : '',
            search: '',
          });
        } else if (kind.startsWith('landlords-')) {
          await exportLandlordReportPdf({
            scope: kind.replace('landlords-', '') as LandlordOpsCategory,
            pendingFilter: 'all' as LandlordOpsPendingFilter,
            search: '',
            dateFrom: hubFromIso,
            dateTo: hubToIso,
          });
        } else if (kind.startsWith('houses-')) {
          await exportHouseReportPdf({
            status: kind.replace('houses-', '') as HouseStatusFilter,
            quick: 'all',
            search: null,
            dateFrom: hubFromIso,
            dateTo: hubToIso,
          });
        } else if (kind.startsWith('lc1-')) {
          await exportLc1ReportPdf(kind.replace('lc1-', '') as 'verified' | 'pending' | 'rejected' | 'all');
        }
      } finally {
        setExtractingKind(null);
      }
    };

    return (
      <>
        <div className="space-y-4">
          <BackButton />
          <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
            <div>
              <p className="font-semibold text-sm leading-tight">Landlord payouts report</p>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Pick a date range (optional), then print the branded PDF.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className={cn("gap-1.5 font-normal", !reportFrom && "text-muted-foreground")}>
                    <CalendarIcon className="h-3.5 w-3.5" />
                    {reportFrom ? format(reportFrom, 'dd MMM yyyy') : 'From'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={reportFrom} onSelect={setReportFrom} initialFocus className={cn("p-3 pointer-events-auto")} />
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className={cn("gap-1.5 font-normal", !reportTo && "text-muted-foreground")}>
                    <CalendarIcon className="h-3.5 w-3.5" />
                    {reportTo ? format(reportTo, 'dd MMM yyyy') : 'To'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={reportTo} onSelect={setReportTo} initialFocus className={cn("p-3 pointer-events-auto")} />
                </PopoverContent>
              </Popover>
              {(reportFrom || reportTo) && (
                <Button variant="ghost" size="sm" onClick={() => { setReportFrom(undefined); setReportTo(undefined); }}>
                  Clear
                </Button>
              )}
              <Button variant="outline" size="sm" className="gap-1.5" onClick={handlePrintReport} disabled={printingPdf}>
                {printingPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
                Print Report
              </Button>
            </div>
          </div>
          <LandlordOpsExtractCenter
            rangeLabel={hubRangeLabel}
            extracting={extractingKind}
            onExtract={(kind) => void runLandlordExtract(kind)}
            onOpenView={(target: LandlordExtractTargetView) => goToView(target as View)}
          />
          <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-4">
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Other exports live inside the section they belong to: landlord verification export in
              <span className="font-medium text-foreground"> All Landlords</span>, house verification export in
              <span className="font-medium text-foreground"> Verify Houses</span>, funded-landlord export in
              <span className="font-medium text-foreground"> Landlords Paid</span>, and the LC1 export in
              <span className="font-medium text-foreground"> LC1 Chairpersons</span>.
            </p>
          </div>
        </div>
        {renderDialogs()}
      </>
    );
  }

  // ─── HOME: Mobile-first card navigation ───
  // When a shell owns navigation it renders its own landing page, so the
  // legacy overview below is suppressed (every other view is untouched).
  if (hideOverview) return null;

  return (

    <div className="space-y-6">
      {/* Sticky header with quick section switcher */}
      <div className="flex items-center justify-between gap-2 sticky top-0 z-30 -mx-4 px-4 py-3 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70 border-b border-border/50">
        <h2 className="text-[15px] font-semibold tracking-tight flex items-center gap-2 min-w-0">
          <Building2 className="h-[18px] w-[18px] text-muted-foreground shrink-0" />
          <span className="truncate">Landlord Ops</span>
        </h2>
        <SectionSwitcher />
      </div>
      {/* PROMINENT: Awaiting verification (houses + landlords) — always first */}
      {(pendingHousesCount > 0 || pendingVerificationCount > 0) && (
        <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-muted">
              <ShieldCheck className="h-[18px] w-[18px] text-amber-600 shrink-0" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm leading-tight">Awaiting your verification</p>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Review newly listed houses &amp; registered landlords
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setView('verify')}
              disabled={pendingHousesCount === 0}
              className="rounded-xl border border-border bg-background p-3 text-left min-h-[60px] touch-manipulation active:scale-[0.98] transition-transform disabled:opacity-50 disabled:active:scale-100"
            >
              <div className="flex items-center gap-1.5">
                <Home className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Houses</span>
              </div>
              <p className="text-2xl font-semibold tracking-tight leading-tight mt-1">{fmt(pendingHousesCount)}</p>
              <p className="text-[10px] text-muted-foreground leading-snug">pending · UGX {fmt(pendingHousesCount * 2000)} bonuses</p>
            </button>
            <button
              onClick={() => { setView('landlords'); setLandlordCategory('pending'); }}
              disabled={pendingVerificationCount === 0}
              className="rounded-xl border border-border bg-background p-3 text-left min-h-[60px] touch-manipulation active:scale-[0.98] transition-transform disabled:opacity-50 disabled:active:scale-100"
            >
              <div className="flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Landlords</span>
              </div>
              <p className="text-2xl font-semibold tracking-tight leading-tight mt-1">{pendingVerificationCount}</p>
              <p className="text-[10px] text-muted-foreground leading-snug">pending verification · awaiting review</p>
            </button>
          </div>
        </div>
      )}

      {/* Quick access — funded tenants & location browse */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* HERO: Tenants whose Landlords were Funded */}
        <button
          onClick={() => setView('landlords-paid')}
          className="w-full rounded-2xl border border-border bg-card p-4 flex items-center gap-3 text-left min-h-[64px] touch-manipulation active:scale-[0.98] transition-transform hover:bg-muted/40"
        >
          <div className="p-2 rounded-xl bg-muted">
            <Banknote className="h-[18px] w-[18px] text-emerald-600 shrink-0" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm text-foreground leading-tight">Tenants whose Landlords were Funded</p>
            <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
              {paidLandlordsCount !== undefined ? `${paidLandlordsCount} landlords paid · ` : ''}View disbursements from tenant rent
            </p>
          </div>
          <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
        </button>

        {/* Browse by Location */}
        <button
          onClick={() => setView('houses-by-landlord')}
          className="w-full rounded-2xl border border-border bg-card p-4 flex items-center gap-3 text-left min-h-[64px] touch-manipulation active:scale-[0.98] transition-transform hover:bg-muted/40"
        >
          <div className="p-2 rounded-xl bg-muted">
            <MapPin className="h-[18px] w-[18px] text-muted-foreground shrink-0" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm leading-tight">Browse Houses by Location</p>
            <p className="text-xs text-muted-foreground leading-snug">Explore properties across regions, districts &amp; wards</p>
          </div>
          <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
        </button>
      </div>

      {/* Priority work hubs — each opens a dedicated workspace */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="h-px flex-1 bg-border" />
          <span className="text-[10px] text-muted-foreground font-medium tracking-wider">WORK HUBS</span>
          <div className="h-px flex-1 bg-border" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <HubEntryCard
            title="Agent Verification Requests"
            description="Landlord verifications submitted by agents from the field"
            icon={UserCheck}
            onClick={() => goToView('agent-verify-requests')}
          />
          <HubEntryCard
            title="LC1 Verification Inbox"
            description="Verify LC1 chairpersons submitted for review"
            icon={ShieldCheck}
            onClick={() => goToView('lc1-inbox')}
          />
          <HubEntryCard
            title="Rent Pipeline"
            description="Requests awaiting the Landlord Ops stage"
            icon={GitBranch}
            onClick={() => goToView('rent-pipeline-queue')}
          />
          <HubEntryCard
            title="Rejected at Landlord Ops"
            description="Requests you returned — review and reopen"
            icon={XCircle}
            onClick={() => goToView('rejected-queue')}
          />
          <HubEntryCard
            title="Landlord Payout Review"
            description="Review landlord payouts before they are sent"
            icon={Banknote}
            onClick={() => goToView('payout-review')}
          />
          <HubEntryCard
            title="Agent Rent Capacity"
            description="Fleet-wide capacity for new rent requests"
            icon={Users}
            onClick={() => goToView('agent-capacity')}
          />
          <HubEntryCard
            title="Service Centre Managers"
            description="Managers, sub-agents, houses, landlords, rent & LC1 verifications"
            icon={Building2}
            onClick={() => goToView('service-centres')}
          />
          <HubEntryCard
            title="Reports & Exports"
            description="Print the landlord payouts report for any date range"
            icon={Printer}
            onClick={() => goToView('reports')}
          />
        </div>
      </div>

      {/* KPIs — responsive card grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KPICard title="Total Properties" value={kpi(totalLandlordsCount)} icon={Home} loading={totalsLoading} onClick={() => setView('houses-by-landlord')} />
        <KPICard title="Occupied" value={kpi(occupiedLandlordsCount)} icon={UserCheck} loading={totalsLoading} color="bg-green-500/10 text-green-600" subtitle={`UGX ${fmt(totalMonthlyRevenue ?? 0)}/mo`} onClick={() => setView('occupied')} />
        <KPICard title="Empty" value={kpi(emptyLandlordsCount)} icon={DoorOpen} loading={totalsLoading} color="bg-red-500/10 text-red-600" subtitle={`UGX ${fmt(lostMonthlyRevenue ?? 0)}/mo lost`} onClick={() => setView('empty')} />
        <KPICard title="Landlords" value={kpi(totalLandlordsCount)} icon={Building2} loading={totalsLoading} color="bg-sky-500/10 text-sky-600" subtitle={`${kpi(verifiedLandlordsCount)} verified · ${kpi(pendingLandlordsCount)} pending · ${kpi(rejectedLandlordsCount)} rejected`} onClick={() => setView('landlords')} />
        <KPICard title="Cities" value={cityGroups.length} icon={Globe} loading={isLoading} color="bg-teal-500/10 text-teal-600" subtitle="operating in" onClick={() => setView('cities')} />
        <KPICard title="No Landlord" value={noLandlordList.length} icon={UserX} loading={isLoading} color="bg-orange-500/10 text-orange-600" subtitle="need listing" onClick={() => setView('no-landlord')} />
      </div>

      {/* No landlord alert */}
      {noLandlordList.length > 0 && (
        <button
          onClick={() => setView('no-landlord')}
          className="w-full rounded-2xl border border-border bg-card p-4 flex items-center gap-3 text-left min-h-[56px] touch-manipulation active:scale-[0.98] transition-transform hover:bg-muted/40"
        >
          <div className="p-2 rounded-xl bg-muted">
            <UserX className="h-[18px] w-[18px] text-orange-600 shrink-0" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm leading-tight">{noLandlordList.length} tenants without landlord</p>
            <p className="text-[10px] text-muted-foreground leading-snug">Contact them to list property &amp; earn UGX 2,000</p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        </button>
      )}

      {/* Navigation Cards */}
      <div className="space-y-4">
        {/* Priority items first */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {navItems.filter(n => n.priority).map(item => (
            <NavCard key={item.id} item={item} onClick={() => setView(item.id)} badge={
              item.id === 'landlords' ? (totalLandlordsCount !== undefined ? kpi(totalLandlordsCount) : undefined) :
              item.id === 'landlords-paid' ? (paidLandlordsCount !== undefined ? `${paidLandlordsCount}` : undefined) :
              item.id === 'locations' ? `${locationGroups.length}` :
              item.id === 'lc1' ? `${lc1Groups.length}` :
              item.id === 'cities' ? `${cityGroups.length}` :
              item.id === 'no-landlord' ? `${noLandlordList.length}` : undefined
            } />
          ))}
        </div>

        {/* Divider */}
        <div className="flex items-center gap-2 pt-1">
          <div className="h-px flex-1 bg-border" />
          <span className="text-[10px] text-muted-foreground font-medium tracking-wider">MANAGEMENT</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {navItems.filter(n => !n.priority).map(item => (
            <NavCard key={item.id} item={item} onClick={() => setView(item.id)}
              badge={
                item.id === 'empty' ? (emptyLandlordsCount !== undefined ? kpi(emptyLandlordsCount) : undefined) :
                item.id === 'occupied' ? (occupiedLandlordsCount !== undefined ? kpi(occupiedLandlordsCount) : undefined) :
                item.id === 'verify' ? (pendingHousesCount > 0 ? `${fmt(pendingHousesCount)}` : undefined) :
                item.id === 'agents' ? `${agentSummary.length}` : undefined
              } />
          ))}
        </div>
      </div>

      <LandlordDialogs
        editLandlord={editLandlord} setEditLandlord={setEditLandlord}
        editLC1={editLC1} setEditLC1={setEditLC1}
        assignPerson={assignPerson} setAssignPerson={setAssignPerson}
        deleteLandlord={deleteLandlord} setDeleteLandlord={setDeleteLandlord}
        deleteReason={deleteReason} setDeleteReason={setDeleteReason}
        deleting={deleting} setDeleting={setDeleting}
        previewImages={previewImages} setPreviewImages={setPreviewImages}
        adjustListing={adjustListing} setAdjustListing={setAdjustListing}
        actionDialog={actionDialog} setActionDialog={setActionDialog}
        reverseLandlord={reverseLandlord} setReverseLandlord={setReverseLandlord}
        user={user} refetchAll={refetchAll} queryClient={queryClient}
      />

      {/* ─── Bulk action result summary ─── */}
      <Dialog open={!!bulkResult} onOpenChange={(o: boolean) => { if (!o) setBulkResult(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{bulkResult?.action} — results</DialogTitle>
          </DialogHeader>
          {bulkResult && (() => {
            const ok = bulkResult.results.filter(r => r.ok).length;
            const failed = bulkResult.results.length - ok;
            return (
              <div className="space-y-3">
                <div className="flex gap-2 text-sm font-semibold">
                  <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 text-emerald-700 px-2 py-1">
                    <CheckCircle2 className="h-4 w-4" />{ok} succeeded
                  </span>
                  {failed > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-destructive/10 text-destructive px-2 py-1">
                      <XCircle className="h-4 w-4" />{failed} failed
                    </span>
                  )}
                </div>
                <div className="max-h-[50vh] overflow-y-auto divide-y divide-border rounded-lg border border-border">
                  {bulkResult.results.map((r) => (
                    <div key={r.id} className="flex items-start gap-2 p-2.5 text-sm">
                      {r.ok
                        ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-emerald-600" />
                        : <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />}
                      <div className="min-w-0">
                        <p className="font-medium truncate">{r.title || 'Untitled house'}</p>
                        {!r.ok && <p className="text-xs text-destructive break-words">{r.error}</p>}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex justify-end">
                  <Button size="sm" onClick={() => setBulkResult(null)}>Close</Button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Shared Dialogs Component ───
function LandlordDialogs({ editLandlord, setEditLandlord, editLC1, setEditLC1, assignPerson, setAssignPerson, deleteLandlord, setDeleteLandlord, deleteReason, setDeleteReason, deleting, setDeleting, previewImages, setPreviewImages, adjustListing, setAdjustListing, actionDialog, setActionDialog, reverseLandlord, setReverseLandlord, user, refetchAll, queryClient }: any) {
  const { toast } = useToast();
  return (
    <>
      {previewImages && (
        <ImagePreviewDialog images={previewImages.images} title={previewImages.title} startIndex={previewImages.startIndex} open={!!previewImages} onClose={() => setPreviewImages(null)} />
      )}
      {adjustListing && (
        <RentAdjustmentDialog open={!!adjustListing} onOpenChange={(open: boolean) => !open && setAdjustListing(null)} listing={adjustListing} onSuccess={refetchAll} />
      )}
      {actionDialog && (
        <EmptyHouseActionDialog
          open={!!actionDialog}
          onOpenChange={(open: boolean) => !open && setActionDialog(null)}
          listingId={actionDialog.listing.id}
          listingTitle={actionDialog.listing.title}
          actionType={actionDialog.type}
          userId={user?.id || ''}
          onComplete={() => {
            // Instantly remove the listing from the pending list by patching the
            // React Query cache. The full refetch below reconciles related fields.
            const targetId = actionDialog.listing.id;
            const action = actionDialog.type;
            queryClient?.setQueryData?.(['exec-house-listings-ops'], (old: any) => {
              if (!Array.isArray(old)) return old;
              if (action === 'delete') return old.filter((l: any) => l.id !== targetId);
              const newStatus = action === 'reject' ? 'rejected' : 'delisted';
              return old.map((l: any) => l.id === targetId ? { ...l, status: newStatus } : l);
            });
            refetchAll();
          }}
        />
      )}
      <EditLandlordDialog
        landlord={editLandlord}
        open={!!editLandlord}
        onClose={() => setEditLandlord(null)}
        onSaved={refetchAll}
      />
      {reverseLandlord && (
        <ReverseVerificationDialog
          open
          onOpenChange={(v) => { if (!v) setReverseLandlord(null); }}
          entityType="landlord"
          entityId={reverseLandlord.id}
          entityName={reverseLandlord.name}
          onReversed={() => { setReverseLandlord(null); refetchAll(); }}
        />
      )}
      <EditLC1Dialog
        lc1={editLC1}
        open={!!editLC1}
        onClose={() => setEditLC1(null)}
        onSaved={refetchAll}
      />
      <AssignPersonDialog
        open={!!assignPerson}
        onClose={() => setAssignPerson(null)}
        listingId={assignPerson?.listingId || ''}
        listingTitle={assignPerson?.title || ''}
        personType={assignPerson?.type || 'landlord'}
        onSaved={refetchAll}
      />
      {/* Delete Landlord Confirmation */}
      <Dialog open={!!deleteLandlord} onOpenChange={(o: boolean) => { if (!o) { setDeleteLandlord(null); setDeleteReason(''); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base text-destructive">Delete Landlord</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete <strong>{deleteLandlord?.name}</strong>? This will unlink all associated house listings. This action cannot be undone.
          </p>
          <div className="space-y-1">
            <label className="text-xs font-medium">Reason (min 10 chars) *</label>
            <Input
              value={deleteReason}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDeleteReason(e.target.value)}
              placeholder="Why is this landlord being deleted?"
              className="h-10"
            />
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => { setDeleteLandlord(null); setDeleteReason(''); }}>Cancel</Button>
            <Button
              variant="destructive"
              className="flex-1"
              disabled={deleting || (deleteReason?.trim().length || 0) < 10}
              onClick={async () => {
                if (!deleteLandlord || !user) return;
                setDeleting(true);
                try {
                  await supabase.from('house_listings').update({ landlord_id: null }).eq('landlord_id', deleteLandlord.id);
                  const { error } = await supabase.from('landlords').delete().eq('id', deleteLandlord.id);
                  if (error) throw error;
                  await supabase.from('audit_logs').insert({
                    user_id: user.id,
                    action_type: 'landlord_deleted',
                    table_name: 'landlords',
                    record_id: deleteLandlord.id,
                    metadata: { landlord_name: deleteLandlord.name, reason: deleteReason.trim(), deleted_by: 'landlord_ops' },
                  });
                  toast({ title: '✅ Deleted', description: `${deleteLandlord.name} has been deleted successfully` });
                  setDeleteLandlord(null);
                  setDeleteReason('');
                  refetchAll();
                } catch (err: any) {
                  toast({ title: 'Delete failed', description: err.message || 'Failed to delete landlord', variant: 'destructive' });
                  console.error('Delete failed:', err);
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Reusable Nav Card ───
// ─── Reusable inline approve / reject control (shared by houses & landlords) ───
function InlineModerationActions({
  onApprove,
  onReject,
  approveLabel = 'Review & Approve',
  rejectLabel = 'Reject',
  approveHidden = false,
  approveChecklist,
  checklistTitle,
  checklistSubtitle,
}: {
  onApprove: (note: string) => Promise<void> | void;
  onReject: (note: string) => Promise<void> | void;
  approveLabel?: string;
  rejectLabel?: string;
  approveHidden?: boolean;
  approveChecklist?: { label: string; value?: string | null }[] | null;
  checklistTitle?: string;
  checklistSubtitle?: string;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const rejectValid = note.trim().length >= 10;

  const checklistItems = approveChecklist ?? [];
  const allChecked = checklistItems.length > 0 && checklistItems.every((_, i) => checked[i]);

  const run = async (kind: 'approve' | 'reject') => {
    if (busy) return;
    setBusy(kind);
    try {
      await (kind === 'approve' ? onApprove(note) : onReject(note));
      if (kind === 'approve') {
        setChecklistOpen(false);
        setChecked({});
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Add a note (required to reject, optional to approve)…"
        className="min-h-[64px] text-sm"
      />
      {note.length > 0 && note.trim().length < 10 && (
        <p className="text-[10px] text-muted-foreground">{10 - note.trim().length} more characters needed to reject</p>
      )}
      <div className={approveHidden ? 'grid grid-cols-1 gap-2' : 'grid grid-cols-2 gap-2'}>
        <Button
          size="sm"
          variant="outline"
          className="h-11 gap-2 font-bold border-destructive/40 text-destructive hover:bg-destructive/10"
          disabled={!rejectValid || busy !== null}
          onClick={() => run('reject')}
        >
          <XCircle className="h-4 w-4" />
          {busy === 'reject' ? 'Rejecting…' : rejectLabel}
        </Button>
        {!approveHidden && (
        <Button
          size="sm"
          className="h-11 gap-2 font-bold"
          disabled={busy !== null}
          onClick={() => {
            if (checklistItems.length > 0) {
              setChecked({});
              setChecklistOpen(true);
            } else {
              run('approve');
            }
          }}
        >
          <ShieldCheck className="h-4 w-4" />
          {busy === 'approve' ? 'Approving…' : approveLabel}
        </Button>
        )}
      </div>

      {checklistItems.length > 0 && (
        <Dialog open={checklistOpen} onOpenChange={(o) => { if (!busy) setChecklistOpen(o); }}>
          <DialogContent className="max-w-md w-[calc(100vw-2rem)] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-5 w-5 text-primary" />
                {checklistTitle || 'Confirm approval details'}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {checklistSubtitle || 'Tick every item you have confirmed. The Approve button unlocks only when all are checked.'}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2.5 py-1">
              {checklistItems.map((item, i) => (
                <label
                  key={i}
                  className={cn(
                    'flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition-colors',
                    checked[i] ? 'border-primary/50 bg-primary/5' : 'border-border bg-card hover:bg-muted/40',
                  )}
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={!!checked[i]}
                    onCheckedChange={(v) => setChecked((prev) => ({ ...prev, [i]: !!v }))}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium leading-snug">{item.label}</span>
                    {item.value != null && item.value !== '' && (
                      <span className="block text-xs text-muted-foreground break-words mt-0.5">{item.value}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>

            <DialogFooter className="flex-col-reverse sm:flex-row gap-2">
              <Button
                variant="outline"
                className="w-full sm:w-auto"
                disabled={busy !== null}
                onClick={() => setChecklistOpen(false)}
              >
                Cancel
              </Button>
              {allChecked && (
                <Button
                  className="w-full sm:w-auto gap-2 font-bold"
                  disabled={busy !== null}
                  onClick={() => run('approve')}
                >
                  <ShieldCheck className="h-4 w-4" />
                  {busy === 'approve' ? 'Approving…' : approveLabel}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ─── Reusable Nav Card ───
function NavCard({ item, onClick, badge, badgeAlert }: { item: typeof navItems[number]; onClick: () => void; badge?: string; badgeAlert?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 p-4 rounded-2xl border border-border bg-card hover:bg-muted/40 transition-colors text-left min-h-[64px] touch-manipulation active:scale-[0.98]"
    >
      <div className="h-10 w-10 rounded-xl bg-muted flex items-center justify-center shrink-0">
        <item.icon className="h-[18px] w-[18px] text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm leading-tight">{item.label}</p>
        <p className="text-[10px] text-muted-foreground truncate">{item.description}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {badge && (
          <Badge
            variant={badgeAlert ? 'default' : 'secondary'}
            className={badgeAlert ? 'text-[10px] font-bold bg-rose-600 text-white hover:bg-rose-600' : 'text-[10px] font-medium'}
          >
            {badge}
          </Badge>
        )}
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </div>
    </button>
  );
}

// ─── House Card (mobile-friendly) ───
function HouseCard({ house, onImages, onAdjust, onAction, showTenant, showLandlord, onAssign }: {
  house: ListingWithLandlord;
  onImages: (v: { images: string[]; title: string }) => void;
  onAdjust?: (v: ListingWithLandlord) => void;
  onAction?: (v: { listing: ListingWithLandlord; type: 'delete' | 'delist' | 'reject' }) => void;
  showTenant?: boolean;
  showLandlord?: boolean;
  onAssign?: (listingId: string, title: string, type: 'landlord' | 'agent') => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3 space-y-2">
      <HouseCardInner house={house} onImages={onImages} onAssign={onAssign} />
      {/* Tenant info */}
      {showTenant && house.tenant_id && (
        <div className="rounded-lg bg-green-500/10 p-2 space-y-0.5">
          <p className="text-[10px] font-semibold text-green-700">Tenant</p>
          <p className="text-xs font-medium">{house.tenant_name || 'Unknown'}</p>
          {house.tenant_phone && <PhoneLinks phone={house.tenant_phone} name={house.tenant_name || undefined} />}
        </div>
      )}
      {/* Landlord info */}
      {showLandlord && house.landlords && (
        <div className="rounded-lg bg-sky-500/10 p-2 space-y-0.5">
          <p className="text-[10px] font-semibold text-sky-700">Landlord</p>
          <p className="text-xs font-medium">{house.landlords.name}</p>
          <PhoneLinks phone={house.landlords.phone} name={house.landlords.name} />
          <div className="flex flex-wrap gap-1 mt-1">
            {house.landlords.verified ? (
              <Badge className="bg-green-500/20 text-green-700 border-0 text-[9px]">✅ Verified</Badge>
            ) : (
              <Badge className="bg-amber-500/20 text-amber-700 border-0 text-[9px]">⏳ Pending</Badge>
            )}
            {house.landlords.mobile_money_name && (
              <Badge variant="outline" className="text-[9px]">MoMo: {house.landlords.mobile_money_name}</Badge>
            )}
          </div>
        </div>
      )}
      {showLandlord && !house.landlords && (
        <div className="rounded-lg bg-orange-500/10 p-2">
          <p className="text-[10px] font-semibold text-orange-700 flex items-center gap-1">
            <UserX className="h-3 w-3" /> No landlord linked
          </p>
        </div>
      )}
      {/* Empty house actions */}
      {onAdjust && onAction && (
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="outline" className="flex-1 h-10 text-xs gap-1" onClick={() => onAdjust(house)}>
            <TrendingDown className="h-3 w-3" /> Reduce
          </Button>
          <Button size="sm" variant="outline" className="h-10 text-xs gap-1 text-orange-600" onClick={() => onAction({ listing: house, type: 'reject' })}>
            <XCircle className="h-3 w-3" /> Reject
          </Button>
          <Button size="sm" variant="outline" className="h-10 text-xs gap-1 text-amber-600" onClick={() => onAction({ listing: house, type: 'delist' })}>
            <XCircle className="h-3 w-3" /> Delist
          </Button>
          <Button size="sm" variant="outline" className="h-10 text-xs gap-1 text-destructive" onClick={() => onAction({ listing: house, type: 'delete' })}>
            <Trash2 className="h-3 w-3" /> Delete
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── House card inner content (shared) ───
function HouseCardInner({ house, onImages, onAssign }: { house: ListingWithLandlord; onImages: (v: { images: string[]; title: string }) => void; onAssign?: (listingId: string, title: string, type: 'landlord' | 'agent') => void }) {
  return (
    <div className="space-y-2">
      <div className="flex gap-3">
        {/* Thumbnail */}
        <div className="shrink-0 w-16 h-16 rounded-lg overflow-hidden bg-muted">
          {house.image_urls?.[0] ? (
            <button onClick={() => onImages({ images: house.image_urls!, title: house.title })} className="w-full h-full">
              <StorageImage src={house.image_urls[0]} alt={house.title} className="w-full h-full object-cover" />
            </button>
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Home className="h-5 w-5 text-muted-foreground/40" />
            </div>
          )}
        </div>
        {/* Details */}
        <div className="flex-1 min-w-0 space-y-0.5">
          <p className="font-bold text-sm truncate">{house.title}</p>
          <p className="text-[10px] text-muted-foreground truncate flex items-center gap-1">
            <MapPin className="h-2.5 w-2.5 shrink-0" />{house.address ? `${house.address} · ` : ''}{house.village ? `${house.village} · ` : ''}{house.region}{house.district ? `, ${house.district}` : ''}
          </p>
          <div className="flex flex-wrap gap-1 mt-0.5">
            <Badge variant="outline" className="text-[9px] h-4 px-1">{house.house_category}</Badge>
            <Badge variant="outline" className="text-[9px] h-4 px-1">{house.number_of_rooms} rooms</Badge>
            <Badge variant="outline" className="text-[9px] h-4 px-1 font-bold">UGX {house.daily_rate.toLocaleString()}/day</Badge>
            {house.verified ? (
              <Badge className="bg-green-500/20 text-green-700 border-0 text-[9px] h-4 px-1">✅</Badge>
            ) : (
              <Badge className="bg-amber-500/20 text-amber-700 border-0 text-[9px] h-4 px-1">⏳</Badge>
            )}
          </div>
          {/* GPS link */}
          {house.latitude && house.longitude && (
            <a href={`https://www.google.com/maps?q=${house.latitude},${house.longitude}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline text-[10px] mt-0.5">
              <MapPinned className="h-3 w-3" /> View on Map
            </a>
          )}
        </div>
      </div>
      {/* People: Landlord, Tenant, Agent — always visible */}
      <div className="grid grid-cols-1 gap-1.5">
        {house.landlords && (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-sky-500/10 px-2.5 py-1.5">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold text-sky-700 dark:text-sky-400 flex items-center gap-1">
                🏠 Landlord
                {house.landlords.has_smartphone != null && (
                  house.landlords.has_smartphone
                    ? <span title="Has smartphone"><Smartphone className="h-3 w-3 text-green-600" /></span>
                    : <span className="text-[9px] text-orange-500" title="No smartphone">📵</span>
                )}
              </p>
              <p className="text-xs font-medium truncate">{house.landlords.name}</p>
            </div>
            <PhoneLinks phone={house.landlords.phone} name={house.landlords.name} />
          </div>
        )}
        {!house.landlords && (
          <div className="flex items-center justify-between gap-1.5 rounded-lg bg-orange-500/10 px-2.5 py-1.5">
            <div className="flex items-center gap-1.5">
              <UserX className="h-3 w-3 text-orange-600 shrink-0" />
              <p className="text-[10px] font-semibold text-orange-700 dark:text-orange-400">No landlord linked</p>
            </div>
            {onAssign && (
              <Button size="sm" variant="outline" className="h-6 text-[10px] px-2 gap-1 border-orange-300 text-orange-700 hover:bg-orange-100" onClick={() => onAssign(house.id, house.title, 'landlord')}>
                <UserPlus className="h-3 w-3" />Add
              </Button>
            )}
          </div>
        )}
        {house.tenant_name && (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-green-500/10 px-2.5 py-1.5">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold text-green-700 dark:text-green-400">👤 Tenant</p>
              <p className="text-xs font-medium truncate">{house.tenant_name}</p>
            </div>
            {house.tenant_phone && <PhoneLinks phone={house.tenant_phone} name={house.tenant_name} />}
          </div>
        )}
        {house.agent_name && (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-indigo-500/10 px-2.5 py-1.5">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold text-indigo-700 dark:text-indigo-400">🕵️ Agent</p>
              <p className="text-xs font-medium truncate">{house.agent_name}</p>
            </div>
            {house.agent_phone && <PhoneLinks phone={house.agent_phone} name={house.agent_name} />}
          </div>
        )}
        {!house.agent_name && (
          <div className="flex items-center justify-between gap-1.5 rounded-lg bg-red-500/10 px-2.5 py-1.5">
            <div className="flex items-center gap-1.5">
              <UserX className="h-3 w-3 text-red-600 shrink-0" />
              <p className="text-[10px] font-semibold text-red-700 dark:text-red-400">No agent linked</p>
            </div>
            {onAssign && (
              <Button size="sm" variant="outline" className="h-6 text-[10px] px-2 gap-1 border-red-300 text-red-700 hover:bg-red-100" onClick={() => onAssign(house.id, house.title, 'agent')}>
                <UserPlus className="h-3 w-3" />Assign
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
