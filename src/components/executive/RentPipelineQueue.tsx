import { useState, useCallback, useEffect, useRef } from 'react';
import { TenantOpsReportToolbar } from './TenantOpsReportToolbar';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RentPipelineTracker } from './RentPipelineTracker';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { getRentCycleLabel, RENT_CYCLE_BADGE_CLASSES } from '@/lib/rentCycleLabel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { CheckCircle2, XCircle, Clock, MapPin, User, UserCheck, Home, Banknote, ArrowRight, ArrowRightLeft, Loader2, Search, MessageCircle, Phone, Pencil, Check, X, PhoneCall, ShieldCheck, AlertCircle, Image as ImageIcon, Camera, Cloud, HardDrive, RotateCcw, ArrowUpDown, ChevronDown, Filter, Eye, CalendarClock, Repeat, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { calculateRentRepayment } from '@/lib/rentCalculations';
import { formatTenantSync } from '@/lib/tenantFilterSyncFormat';
import { formatLocation, locationHaystack } from '@/lib/locationText';
import { toast as sonnerToast } from 'sonner';
import { format } from 'date-fns';
import { AgentProximitySelector } from './AgentProximitySelector';
import { UserDrilldownDrawer } from '@/components/ops/UserDrilldownDrawer';
import { LandlordAgreementHistory } from '@/components/landlord/agreement';
import { PipelineAgentTransferDialog } from './PipelineAgentTransferDialog';
import { TenantPaymentHistoryCard } from './TenantPaymentHistoryCard';
import { RentApprovalConfirmDialog, type FunderVisibilityDecision } from './RentApprovalConfirmDialog';
import { TenantPhotoChecksPanel } from './TenantPhotoChecksPanel';
import { AwarenessCallPanel } from '@/components/pipeline/AwarenessCallPanel';
import { defaultAwarenessSubjectForStage, isAwarenessReadOnlyStage } from '@/lib/awarenessCallLabels';
import { AwarenessCallBadge } from '@/components/pipeline/AwarenessCallBadge';
import { MyAwarenessCallsCard } from '@/components/pipeline/MyAwarenessCallsCard';
import { useAwarenessCallStatus } from '@/hooks/useAwarenessCallStatus';
import { hasNoCallAtStage } from '@/lib/awarenessCallStatus';



// Per-user preference key for the CFO's selected tenant filter (cross-device).
const TENANT_FILTER_PREF_KEY = 'rentPipeline.selectedTenantId';

// Per-user preference key for the Landlord Ops verification checklist ticks so
// they auto-save and survive a refresh or a switch to another phone.
const LANDLORD_CHECKLIST_PREF_KEY = 'rentPipeline.landlordChecklist';
const LANDLORD_CHECKLIST_LS_KEY = 'rentPipeline_landlordChecklist';

export type PipelineStage =
  | 'pending'
  | 'agent_ops_approved'
  | 'tenant_ops_approved'
  | 'landlord_ops_approved'
  | 'partner_ops_approved'
  | 'coo_approved';

interface PipelineConfig {
  stage: PipelineStage;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  approveLabel: string;
  nextStatus: string;
  reviewerColumn: string;
  reviewerAtColumn: string;
  commentColumn?: string;
  /** Columns from previous stages whose comments we surface (read-only) for context. */
  previousCommentColumns?: { column: string; label: string }[];
  showAgentSelector?: boolean;
  showPayoutFields?: boolean;
  showLandlordChecklist?: boolean;
}

const STAGE_CONFIG: Record<PipelineStage, PipelineConfig> = {
  pending: {
    stage: 'pending',
    title: 'Agent Ops Review',
    icon: Search,
    approveLabel: 'Approve & Forward to Tenant Ops',
    nextStatus: 'agent_ops_approved',
    reviewerColumn: 'agent_ops_reviewed_by',
    reviewerAtColumn: 'agent_ops_reviewed_at',
    commentColumn: 'agent_ops_comment',
  },
  agent_ops_approved: {
    stage: 'agent_ops_approved',
    title: 'Tenant Ops Review',
    icon: UserCheck,
    approveLabel: 'Approve & Forward to Landlord Ops',
    nextStatus: 'tenant_ops_approved',
    reviewerColumn: 'tenant_ops_reviewed_by',
    reviewerAtColumn: 'tenant_ops_reviewed_at',
    commentColumn: 'tenant_ops_comment',
    showAgentSelector: true,
    previousCommentColumns: [
      { column: 'agent_ops_comment', label: 'Agent Ops note' },
    ],
  },
  tenant_ops_approved: {
    stage: 'tenant_ops_approved',
    title: 'Landlord Ops Review',
    icon: Home,
    approveLabel: 'Approve & Forward to Partner Ops',
    nextStatus: 'landlord_ops_approved',
    reviewerColumn: 'landlord_ops_reviewed_by',
    reviewerAtColumn: 'landlord_ops_reviewed_at',
    commentColumn: 'landlord_ops_comment',
    showLandlordChecklist: true,
    previousCommentColumns: [
      { column: 'agent_ops_comment', label: 'Agent Ops note' },
      { column: 'tenant_ops_comment', label: 'Tenant Ops note' },
    ],
  },
  landlord_ops_approved: {
    stage: 'landlord_ops_approved',
    title: 'Partner Ops Proxy Attachment',
    icon: ArrowRightLeft,
    approveLabel: 'Attach Proxy Agent & Forward to COO',
    nextStatus: 'partner_ops_approved',
    reviewerColumn: 'partner_ops_reviewed_by',
    reviewerAtColumn: 'partner_ops_reviewed_at',
    commentColumn: 'partner_ops_comment',
    previousCommentColumns: [
      { column: 'agent_ops_comment', label: 'Agent Ops note' },
      { column: 'tenant_ops_comment', label: 'Tenant Ops note' },
      { column: 'landlord_ops_comment', label: 'Landlord Ops note' },
    ],
  },
  partner_ops_approved: {
    stage: 'partner_ops_approved',
    title: 'COO Approval',
    icon: ShieldCheck,
    approveLabel: 'Approve & Forward to CFO',
    nextStatus: 'coo_approved',
    reviewerColumn: 'coo_reviewed_by',
    reviewerAtColumn: 'coo_reviewed_at',
    commentColumn: 'approval_comment',
    previousCommentColumns: [
      { column: 'agent_ops_comment', label: 'Agent Ops note' },
      { column: 'tenant_ops_comment', label: 'Tenant Ops note' },
      { column: 'landlord_ops_comment', label: 'Landlord Ops note' },
      { column: 'partner_ops_comment', label: 'Partner Ops note' },
    ],
  },
  coo_approved: {
    stage: 'coo_approved',
    title: 'CFO Payout Authorization',
    icon: Banknote,
    approveLabel: 'Authorize & Fund Agent Float',
    nextStatus: 'funded',
    reviewerColumn: 'cfo_reviewed_by',
    reviewerAtColumn: 'cfo_reviewed_at',
    commentColumn: 'approval_comment',
    showPayoutFields: true,
    previousCommentColumns: [
      { column: 'agent_ops_comment', label: 'Agent Ops note' },
      { column: 'tenant_ops_comment', label: 'Tenant Ops note' },
      { column: 'landlord_ops_comment', label: 'Landlord Ops note' },
      { column: 'approval_comment', label: 'COO note' },
    ],
  },
};

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  agent_ops_approved: 'bg-cyan-100 text-cyan-700',
  tenant_ops_approved: 'bg-blue-100 text-blue-700',
  landlord_ops_approved: 'bg-indigo-100 text-indigo-700',
  partner_ops_approved: 'bg-violet-100 text-violet-700',
  coo_approved: 'bg-emerald-100 text-emerald-700',
  funded: 'bg-green-100 text-green-700',
  disbursed: 'bg-teal-100 text-teal-700',
  rejected: 'bg-destructive/10 text-destructive',
};

// Which dashboard is doing the rejecting at each stage. Used in the
// auto-WhatsApp message sent to the originating Agent on rejection.
const STAGE_REJECTOR_LABEL: Record<PipelineStage, string> = {
  pending: 'Agent Ops',
  agent_ops_approved: 'Tenant Ops',
  tenant_ops_approved: 'Landlord Ops',
  landlord_ops_approved: 'Partner Ops',
  partner_ops_approved: 'COO',
  coo_approved: 'CFO / Financial Ops',
};

const formatWhatsApp = (phone: string): string => {
  if (!phone) return '';
  let clean = phone.replace(/\D/g, '');
  if (clean.startsWith('0')) clean = '256' + clean.slice(1);
  if (!clean.startsWith('256')) clean = '256' + clean;
  return clean;
};

const WhatsAppButton = ({ phone, name, label }: { phone: string; name: string; label: string }) => {
  if (!phone) return null;
  const waNumber = formatWhatsApp(phone);
  return (
    <a
      href={`https://wa.me/${waNumber}?text=${encodeURIComponent(`Hi ${name}, regarding a rent request on Welile.`)}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 transition-colors"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.625.846 5.059 2.284 7.034L.789 23.492a.5.5 0 00.611.611l4.458-1.495A11.945 11.945 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-2.352 0-4.55-.764-6.326-2.057a.5.5 0 00-.395-.088l-3.088 1.035 1.035-3.088a.5.5 0 00-.088-.395A9.953 9.953 0 012 12C2 6.486 6.486 2 12 2s10 4.486 10 10-4.486 10-10 10z"/></svg>
      <span className="hidden sm:inline">{label}</span>
    </a>
  );
};

interface RentPipelineQueueProps {
  stage: PipelineStage;
  /**
   * Extra rent_request.status values that share the same review stage and should
   * appear in this queue alongside the canonical `stage`. Used to surface legacy
   * statuses (e.g. `agent_verified`) that pre-date the unified pipeline naming.
   */
  additionalStatuses?: string[];
}

export function RentPipelineQueue({ stage, additionalStatuses = [] }: RentPipelineQueueProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const invalidateAllPipelineQueries = () => {
    queryClient.invalidateQueries({ queryKey: ['rent-pipeline'] });
    queryClient.invalidateQueries({ queryKey: ['pipeline-counts'] });
    queryClient.invalidateQueries({ queryKey: ['agent-ops-approved-requests'] });
    queryClient.invalidateQueries({ queryKey: ['agent-ops-counts'] });
  };
  const config = STAGE_CONFIG[stage];

  const [selectedRequest, setSelectedRequest] = useState<any | null>(null);
  const [comment, setComment] = useState('');
  const [assignedAgentId, setAssignedAgentId] = useState<string | null>(null);
  const [payoutRef, setPayoutRef] = useState('');
  const [payoutMethod, setPayoutMethod] = useState('wallet');
  const [processing, setProcessing] = useState(false);
  // Tenant Ops approval confirmation (details recheck + funder visibility)
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [quickProcessingId, setQuickProcessingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [agentSearch, setAgentSearch] = useState('');
  const [landlordSearch, setLandlordSearch] = useState('');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [noCallOnly, setNoCallOnly] = useState(false);
  const [hideExpired, setHideExpired] = useState(true);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  // Ops-only mid-pipeline agent transfer dialog
  const [transferOpen, setTransferOpen] = useState(false);
  // Landlord verification checklist state
  const [landlordCalled, setLandlordCalled] = useState(false);
  const [landlordAcknowledged, setLandlordAcknowledged] = useState(false);
  const [landlordVerificationMethod, setLandlordVerificationMethod] = useState('');
  const [landlordCallNotes, setLandlordCallNotes] = useState('');
  // Per-card (per request) Landlord Ops verification checklist progress, shown
  // inline on the review queue so the operator can see status/progress and the
  // Approve button only enables once both checks are confirmed.
  const [cardChecklist, setCardChecklist] = useState<Record<string, { called: boolean; acknowledged: boolean }>>(() => {
    try {
      const raw = localStorage.getItem(LANDLORD_CHECKLIST_LS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  // Guards the cloud-write effect so the initial localStorage value doesn't
  // overwrite a fresher cloud value before hydration completes.
  const hasChecklistHydratedRef = useRef(false);
  // Timestamp of the last checklist save so the operator knows their ticks are stored.
  const [checklistSavedAt, setChecklistSavedAt] = useState<Date | null>(null);
  // Server sync status for the checklist ticks so operators know whether their
  // ticks actually reached the server: 'idle' | 'saving' | 'saved' | 'failed'.
  const [checklistSyncStatus, setChecklistSyncStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const getCardChecklist = (id: string) => cardChecklist[id] || { called: false, acknowledged: false };
  const toggleCardCheck = (id: string, key: 'called' | 'acknowledged', value: boolean) => {
    setCardChecklist(prev => ({
      ...prev,
      [id]: { ...{ called: false, acknowledged: false }, ...prev[id], [key]: value },
    }));
  };
  const [expandedCardIds, setExpandedCardIds] = useState<Set<string>>(new Set());
  const toggleCardExpanded = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setExpandedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Open the detail sheet AND seed the sheet's landlord checklist from the ticks
  // the operator already made on the card (otherwise the sheet's checkboxes start
  // empty and the Approve button silently refuses with "Complete the checklist").
  const openRequestDetail = (req: any) => {
    const cl = getCardChecklist(req.id);
    setLandlordCalled(cl.called || !!req.landlord_called);
    setLandlordAcknowledged(cl.acknowledged || !!req.landlord_acknowledged);
    setSelectedRequest(req);
  };
  // Bulk review selection state for Agent Ops and COO queues.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [bulkRejectReason, setBulkRejectReason] = useState('');
  // Agent profile drilldown
  const [drilldownAgentId, setDrilldownAgentId] = useState<string | null>(null);
  // Landlord profile drilldown — full location, contacts, houses
  const [drilldownLandlordId, setDrilldownLandlordId] = useState<string | null>(null);
  // Tenant selector — CFO picks which tenant's landlord to fund before approving.
  // localStorage acts as an offline mirror; the durable cross-device source of
  // truth is the per-user `user_ui_preferences` row keyed by TENANT_FILTER_PREF_KEY.
  const [selectedTenantId, setSelectedTenantId] = useState<string>(() => {
    try { return localStorage.getItem('rentPipeline_selectedTenantId') || 'all'; } catch { return 'all'; }
  });
  // Guards the cloud-write effect so the initial localStorage value doesn't
  // overwrite a fresher cloud value before hydration completes.
  const hasTenantPrefHydratedRef = useRef(false);
  // 'synced' | 'local' — tracks whether the current filter value is confirmed
  // on the server (synced) or only in localStorage (local).
  const [tenantSyncStatus, setTenantSyncStatus] = useState<'synced' | 'local'>('local');
  // Timestamp of the last save (local or cloud) so the CFO knows how fresh the
  // persisted filter value is.
  const [tenantSyncAt, setTenantSyncAt] = useState<Date | null>(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  // Hydrate the selected tenant from the server so the filter follows the
  // CFO across devices/browsers, then mirror back into localStorage.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('user_ui_preferences')
          .select('value')
          .eq('user_id', user.id)
          .eq('key', TENANT_FILTER_PREF_KEY)
          .maybeSingle();
        if (cancelled || error) { hasTenantPrefHydratedRef.current = true; return; }
        const cloudValue = typeof data?.value === 'string' ? data.value : null;
        if (cloudValue) {
          setSelectedTenantId(cloudValue);
          setTenantSyncStatus('synced');
          setTenantSyncAt(new Date());
          try {
            if (cloudValue === 'all') localStorage.removeItem('rentPipeline_selectedTenantId');
            else localStorage.setItem('rentPipeline_selectedTenantId', cloudValue);
          } catch { /* noop */ }
        }
      } catch (err) {
        console.warn('[RentPipelineQueue] tenant pref hydrate failed', err);
      } finally {
        hasTenantPrefHydratedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  // Persist every selection. localStorage is ALWAYS written first so the filter
  // survives even when the server settings are unreachable (offline, signed out,
  // RLS/permission error). The cloud write is best-effort on top of that.
  useEffect(() => {
    if (!hasTenantPrefHydratedRef.current) return;
    // 1) Local fallback — guaranteed to run regardless of server availability.
    try {
      if (selectedTenantId === 'all') localStorage.removeItem('rentPipeline_selectedTenantId');
      else localStorage.setItem('rentPipeline_selectedTenantId', selectedTenantId);
    } catch { /* noop */ }
    setTenantSyncAt(new Date());
    // 2) Cloud sync — only when we have an authenticated user.
    if (!user?.id) return;
    (async () => {
      try {
        const { error } = selectedTenantId === 'all'
          ? await supabase
              .from('user_ui_preferences')
              .delete()
              .eq('user_id', user.id)
              .eq('key', TENANT_FILTER_PREF_KEY)
          : await supabase
              .from('user_ui_preferences')
              .upsert(
                { user_id: user.id, key: TENANT_FILTER_PREF_KEY, value: selectedTenantId },
                { onConflict: 'user_id,key' },
              );
        if (error) {
          setTenantSyncStatus('local');
          console.warn('[RentPipelineQueue] tenant pref cloud write failed, using localStorage', error);
        } else {
          setTenantSyncStatus('synced');
        }
      } catch (err) {
        setTenantSyncStatus('local');
        console.warn('[RentPipelineQueue] tenant pref write failed, using localStorage', err);
      }
    })();
  }, [selectedTenantId, user?.id]);

  // Hydrate the landlord checklist ticks from the server so an operator's
  // in-progress checks follow them across devices/browsers (e.g. they start on
  // one phone and finish on another), then mirror back into localStorage.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('user_ui_preferences')
          .select('value')
          .eq('user_id', user.id)
          .eq('key', LANDLORD_CHECKLIST_PREF_KEY)
          .maybeSingle();
        if (cancelled || error) { hasChecklistHydratedRef.current = true; return; }
        const cloudValue = data?.value && typeof data.value === 'object' && !Array.isArray(data.value)
          ? data.value as Record<string, { called: boolean; acknowledged: boolean }>
          : null;
        if (cloudValue) {
          setCardChecklist(cloudValue);
          try { localStorage.setItem(LANDLORD_CHECKLIST_LS_KEY, JSON.stringify(cloudValue)); } catch { /* noop */ }
        }
      } catch (err) {
        console.warn('[RentPipelineQueue] checklist hydrate failed', err);
      } finally {
        hasChecklistHydratedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  // Auto-save every checklist change. localStorage is ALWAYS written first so the
  // ticks survive a refresh even when the server is unreachable; the cloud write
  // is best-effort on top so they also follow the operator to another device.
  useEffect(() => {
    if (!hasChecklistHydratedRef.current) return;
    try { localStorage.setItem(LANDLORD_CHECKLIST_LS_KEY, JSON.stringify(cardChecklist)); } catch { /* noop */ }
    setChecklistSavedAt(new Date());
    if (!user?.id) return;
    setChecklistSyncStatus('saving');
    (async () => {
      try {
        const { error } = await supabase
          .from('user_ui_preferences')
          .upsert(
            { user_id: user.id, key: LANDLORD_CHECKLIST_PREF_KEY, value: cardChecklist },
            { onConflict: 'user_id,key' },
          );
        if (error) {
          setChecklistSyncStatus('failed');
          console.warn('[RentPipelineQueue] checklist cloud write failed, using localStorage', error);
        } else {
          setChecklistSyncStatus('saved');
        }
      } catch (err) {
        setChecklistSyncStatus('failed');
        console.warn('[RentPipelineQueue] checklist write failed, using localStorage', err);
      }
    })();
  }, [cardChecklist, user?.id]);

  const startEditing = useCallback((field: string, currentValue: any) => {
    setEditingField(field);
    setEditValue(String(currentValue ?? ''));
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingField(null);
    setEditValue('');
  }, []);

  const handleFieldSave = useCallback(async (field: string) => {
    if (!selectedRequest || !user) return;
    setSavingEdit(true);

    try {
      let updates: Record<string, any> = {};
      const isNumber = field !== 'house_category';
      const newVal = isNumber ? Number(editValue) : editValue;

      if (isNumber && (isNaN(newVal as number) || (newVal as number) <= 0)) {
        sonnerToast.error('Please enter a valid positive number');
        setSavingEdit(false);
        return;
      }

      if (field === 'rent_amount' || field === 'duration_days') {
        const rentAmt = field === 'rent_amount' ? (newVal as number) : selectedRequest.rent_amount;
        const durDays = field === 'duration_days' ? (newVal as number) : selectedRequest.duration_days;
        const calc = calculateRentRepayment(rentAmt, durDays);
        updates = {
          rent_amount: calc.rentAmount,
          duration_days: calc.durationDays,
          access_fee: calc.accessFee,
          request_fee: calc.requestFee,
          total_repayment: calc.totalRepayment,
          daily_repayment: calc.dailyRepayment,
        };
      } else {
        updates[field] = newVal;
      }

      const { error } = await supabase
        .from('rent_requests')
        .update(updates)
        .eq('id', selectedRequest.id);

      if (error) throw error;

      // Update local state
      setSelectedRequest((prev: any) => prev ? { ...prev, ...updates } : prev);
      invalidateAllPipelineQueries();

      // Audit log
      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'inline_edit_rent_request',
        table_name: 'rent_requests',
        record_id: selectedRequest.id,
        metadata: { field, old_value: selectedRequest[field], new_value: newVal, updates },
      });

      sonnerToast.success(`${field.replace(/_/g, ' ')} updated`);
      cancelEditing();
    } catch (err: any) {
      sonnerToast.error('Update failed: ' + (err.message || 'Unknown error'));
    } finally {
      setSavingEdit(false);
    }
  }, [selectedRequest, user, editValue, queryClient, cancelEditing]);

  const InlineEditableField = ({ field, label, value, prefix, suffix, className }: {
    field: string; label: string; value: any; prefix?: string; suffix?: string; className?: string;
  }) => {
    const isEditing = editingField === field;
    const isText = field === 'house_category';

    if (isEditing) {
      return (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{label}</p>
          <div className="flex items-center gap-1">
            <Input
              type={isText ? 'text' : 'number'}
              inputMode={isText ? 'text' : 'numeric'}
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              className="h-7 text-sm px-2 flex-1"
              autoFocus
              onKeyDown={e => {
                if (e.key === 'Enter') handleFieldSave(field);
                if (e.key === 'Escape') cancelEditing();
              }}
            />
            <Button
              size="icon-sm"
              variant="ghost"
              className="h-6 w-6 min-h-0 min-w-0 text-primary"
              onClick={() => handleFieldSave(field)}
              disabled={savingEdit}
            >
              {savingEdit ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              className="h-6 w-6 min-h-0 min-w-0 text-muted-foreground"
              onClick={cancelEditing}
              disabled={savingEdit}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-0.5 group cursor-pointer" onClick={() => startEditing(field, value)}>
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="flex items-center gap-1">
          <p className={className || 'font-semibold'}>
            {prefix}{typeof value === 'number' ? fmt(value) : value}{suffix}
          </p>
          <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </div>
    );
  };

  // Record an approval audit entry for the Landlord Ops status change. Captures
  // the operator, the exact time the status changed, the status transition, and
  // whether the agent bonus credit was successfully queued. Best-effort: failures
  // never block the approval flow.
  const recordLandlordApprovalAudit = async (
    req: any,
    statusChangedAt: string,
    bonusQueued: boolean,
    bonusNote: string | null,
  ) => {
    if (!user) return;
    try {
      await supabase.from('landlord_approval_audit').insert({
        rent_request_id: req.id,
        tenant_id: req.tenant_id ?? null,
        landlord_id: req.landlord_id ?? null,
        operator_id: user.id,
        previous_status: req.status ?? null,
        new_status: config.nextStatus,
        status_changed_at: statusChangedAt,
        bonus_credit_queued: bonusQueued,
        bonus_credit_note: bonusNote,
      });
    } catch (auditErr) {
      console.warn('[RentPipelineQueue] landlord approval audit failed:', auditErr);
    }
  };

  // Quick approve directly from list — no dialog needed
  const handleQuickApprove = async (req: any, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user || quickProcessingId) return;
    const isOutstanding = req.registration_type === 'outstanding_balance';
    // CFO stage needs payout ref, Tenant Ops may need agent — use dialog.
    // Outstanding-balance requests skip the agent-assignment requirement
    // (the original requesting agent is the verifier).
    if (config.showPayoutFields || (config.showAgentSelector && !isOutstanding)) {
      setSelectedRequest(req);
      return;
    }
    // For Landlord Ops stage — the inline verification checklist (rendered on the
    // card) must be completed first. The Approve button is disabled until both
    // checks are confirmed, but we guard here too as a safety net.
    if (config.showLandlordChecklist && !isOutstanding) {
      const cl = getCardChecklist(req.id);
      if (!cl.called || !cl.acknowledged) {
        toast({ title: 'Complete the landlord verification checklist first', variant: 'destructive' });
        return;
      }
    }
    setQuickProcessingId(req.id);
    try {
      const statusChangedAt = new Date().toISOString();
      const updateData: any = {
        status: config.nextStatus,
        [config.reviewerColumn]: user.id,
        [config.reviewerAtColumn]: statusChangedAt,
        updated_at: statusChangedAt,
      };

      // Requests Tenant Ops kept off the Funder dashboard skip Partner Ops.
      if (stage === 'tenant_ops_approved' && !isOutstanding && req.funder_visible === false) {
        updateData.status = 'partner_ops_approved';
        updateData.partner_ops_reviewed_at = statusChangedAt;
        updateData.partner_ops_comment =
          `No proxy attached — not published to the Funder dashboard. Tenant Ops reason: ${req.funder_visibility_reason || 'not provided'}`;
      }

      if (config.showLandlordChecklist && !isOutstanding) {
        updateData.landlord_called = true;
        updateData.landlord_acknowledged = true;
        updateData.landlord_verification_method = landlordVerificationMethod || 'phone_call';
        updateData.landlord_call_notes = landlordCallNotes || null;
      }


      const { error } = await supabase
        .from('rent_requests')
        .update(updateData)
        .eq('id', req.id);
      if (error) throw error;

      const finalStatus = isOutstanding && stage === 'tenant_ops_approved'
        ? 'completed (outstanding balance recorded)'
        : config.nextStatus.replace(/_/g, ' ');
      toast({ title: '✅ Approved', description: `${req.tenant_name} → ${finalStatus}` });
      invalidateAllPipelineQueries();

      // No bonus is paid from the rent pipeline. The landlord bonus is paid
      // once per NEW landlord, by pay_landlord_registration_verified_bonus on
      // the landlords.verified transition — not once per rent request naming
      // that landlord. Paying here credited the same landlord again for every
      // request that mentioned them. See docs/rent-plan-new-flow-full-report.md.
      // The approval audit trail is still recorded.
      if (config.showLandlordChecklist) {
        recordLandlordApprovalAudit(req, statusChangedAt, false, 'No bonus payable from the pipeline');
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setQuickProcessingId(null);
    }
  };

  const { data: requests, isLoading } = useQuery({
    queryKey: ['rent-pipeline', stage, additionalStatuses.join(',')],
    queryFn: async () => {
      const statuses = [stage, ...additionalStatuses];
      let query = supabase
        .from('rent_requests')
        .select('id, tenant_id, agent_id, landlord_id, lc1_id, rent_amount, duration_days, repayment_frequency, access_fee, request_fee, total_repayment, daily_repayment, status, created_at, pending_window_reset_at, updated_at, resubmitted_at, agent_ops_reviewed_at, tenant_ops_reviewed_at, landlord_ops_reviewed_at, coo_reviewed_at, house_category, request_city, request_latitude, request_longitude, assigned_agent_id, payout_method, payout_transaction_reference, approval_comment, agent_ops_comment, tenant_ops_comment, landlord_ops_comment, partner_ops_comment, partner_ops_reviewed_at, proxy_agent_id, registration_type, initial_outstanding_balance, tenant_photo_url, house_image_urls, latest_rent_receipt_url, latest_rent_receipt_uploaded_at, funder_visible, funder_visibility_reason, agent_verified')
        .in('status', statuses);

      // Outstanding-balance rent requests bypass COO + CFO (DB trigger short-circuits
      // them straight to `repaying` after Landlord Ops approval). Hide them from
      // those queues so reviewers can't accidentally try to approve them.
      if (stage === 'partner_ops_approved' || stage === 'coo_approved') {
        query = query.or('registration_type.is.null,registration_type.neq.outstanding_balance');
      }

      const { data, error: queueError } = await query
        .order('created_at', { ascending: false })
        .limit(1000);
      if (queueError) throw queueError;

      if (!data || data.length === 0) return [];

      // Resolve names
      const ids = new Set<string>();
      data.forEach(r => {
        if (r.tenant_id) ids.add(r.tenant_id);
        if (r.agent_id) ids.add(r.agent_id);
        if (r.assigned_agent_id) ids.add(r.assigned_agent_id);
      });
      const landlordIds = [...new Set(data.map(r => r.landlord_id).filter(Boolean))];
      const lc1Ids = [...new Set(data.map(r => r.lc1_id).filter(Boolean))];

      const [profilesRes, landlordsRes, lc1Res] = await Promise.all([
        ids.size > 0
          ? supabase
              .from('profiles')
              .select('id, full_name, phone, email, region, district, sub_county, parish, village, city, town, landmark')
              .in('id', [...ids])
          : { data: [] },
        landlordIds.length > 0
          ? supabase
              .from('landlords')
              .select('id, name, phone, mobile_money_number, property_address, region, district, sub_county, village, verified, verification_status, registered_by')
              .in('id', landlordIds)
          : { data: [] },
        lc1Ids.length > 0
          ? supabase.from('lc1_chairpersons').select('id, name, phone, village, parish, district, region, verified, registered_by').in('id', lc1Ids)
          : { data: [] },
      ]);

      const profileMap = new Map((profilesRes.data || []).map(p => [p.id, p]));
      const landlordMap = new Map((landlordsRes.data || []).map(l => [l.id, l]));
      const lc1Map = new Map((lc1Res.data || []).map(l => [l.id, l]));

      // Flag rent plans that came back here via a CFO-approved allocation return
      // (agent "Resubmit to CFO" → CFO approved → reverted to this stage).
      const requestIds = data.map(r => r.id);
      const { data: returnReqs } = requestIds.length > 0
        ? await supabase
            .from('agent_allocation_return_requests' as any)
            .select('rent_request_id')
            .eq('status', 'approved')
            .in('rent_request_id', requestIds)
        : { data: [] as any[] };
      const resubmittedSet = new Set(
        ((returnReqs as any[]) || []).map(r => r.rent_request_id).filter(Boolean),
      );

      return data.map(r => {
        const agentProfile = r.assigned_agent_id
          ? profileMap.get(r.assigned_agent_id)
          : r.agent_id
            ? profileMap.get(r.agent_id)
            : null;
        const tenantProfile = profileMap.get(r.tenant_id) as any;
        const landlord = landlordMap.get(r.landlord_id) as any;
        const lc1 = r.lc1_id ? (lc1Map.get(r.lc1_id) as any) : null;
        // Full tenant residence as captured at registration.
        const tenantAddress = formatLocation([
          tenantProfile?.landmark,
          tenantProfile?.village,
          tenantProfile?.parish,
          tenantProfile?.sub_county,
          tenantProfile?.city || tenantProfile?.town,
          tenantProfile?.district,
          tenantProfile?.region,
        ]);
        const landlordAddress = formatLocation([
          landlord?.property_address,
          landlord?.village,
          landlord?.sub_county,
          landlord?.district,
          landlord?.region,
        ]);
        const lc1Address = formatLocation([lc1?.village, lc1?.parish, lc1?.district, lc1?.region]);
        return {
          ...r,
          is_resubmitted: resubmittedSet.has(r.id),
          tenant_name: tenantProfile?.full_name || 'Unknown',
          tenant_phone: tenantProfile?.phone || '',
          tenant_district: tenantProfile?.district || '',
          tenant_address: tenantAddress,
          agent_name: r.agent_id ? (profileMap.get(r.agent_id)?.full_name || 'Unassigned') : 'Unassigned',
          agent_phone: agentProfile?.phone || '',
          agent_email: agentProfile?.email || '',
          assigned_agent_name: r.assigned_agent_id ? (profileMap.get(r.assigned_agent_id)?.full_name || '') : '',
          landlord_name: landlord?.name || 'Unknown',
          // "New" means an agent registered this landlord and nobody has
          // verified them yet — which is exactly when Landlord Ops has real
          // work to do, and when the agent's UGX 5,000 registration bonus is
          // still owed. A landlord already on file needs neither.
          landlord_is_new: !!landlord?.registered_by && landlord?.verification_status !== 'verified',
          lc1_is_new: !!lc1?.registered_by && !lc1?.verified,
          landlord_phone: landlord?.phone || '',
          landlord_momo: landlord?.mobile_money_number || landlord?.phone || '',
          landlord_district: landlord?.district || '',
          landlord_address: landlordAddress,
          lc1_name: lc1?.name || '',
          lc1_phone: lc1?.phone || '',
          lc1_village: lc1?.village || '',
          lc1_district: lc1?.district || '',
          lc1_address: lc1Address,
          // Single lowercased haystack so the search box matches any district,
          // village, parish, sub-county or free-text address on the record.
          location_search: locationHaystack([
            r.request_city,
            tenantAddress,
            landlordAddress,
            lc1Address,
          ]),
        };
      });
    },
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  const rows = requests || [];

  // Read-only: one batched read tells every card whether it has an awareness call at its stage. It never blocks or confirms anything;
  // if it fails the badges are simply not shown.
  const callStatus = useAwarenessCallStatus(rows.map((r: any) => r.id));
  const noCallCount = rows.filter((r: any) => hasNoCallAtStage(callStatus.byId.get(r.id))).length;

  // How many rent plans each tenant in this queue has already had approved.
  // Presentation only — drives the "Cycle N" and New/Renewal badges.
  const queueTenantIds = Array.from(new Set(rows.map(r => r.tenant_id).filter(Boolean))) as string[];
  const { data: approvedCycleMap } = useQuery({
    queryKey: ['rent-pipeline-approved-cycles', queueTenantIds.join(',')],
    enabled: queueTenantIds.length > 0,
    staleTime: 300_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const counts = new Map<string, number>();
      const chunkSize = 300;
      for (let i = 0; i < queueTenantIds.length; i += chunkSize) {
        const chunk = queueTenantIds.slice(i, i + chunkSize);
        const { data, error: cycleError } = await supabase
          .from('rent_requests')
          .select('tenant_id')
          .in('tenant_id', chunk)
          .in('status', ['coo_approved', 'funded', 'repaying', 'completed'])
          .limit(5000);
        if (cycleError) throw cycleError;
        (data || []).forEach(row => {
          if (!row.tenant_id) return;
          counts.set(row.tenant_id, (counts.get(row.tenant_id) || 0) + 1);
        });
      }
      return counts;
    },
  });

  // Unique tenants in the queue, for the "choose a tenant" selector.
  const tenantOptions = Array.from(
    new Map(
      rows.map(r => [r.tenant_id, { id: r.tenant_id, name: r.tenant_name, landlord_name: r.landlord_name }]),
    ).values(),
  ).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const isRequestExpired = (createdAt: string, requestStatus: string, agentVerified?: boolean | null, windowResetAt?: string | null) => {
    if (stage !== 'pending') return false;
    if (requestStatus !== 'pending') return false;
    if (agentVerified) return false;
    // A renewal stamps pending_window_reset_at and restarts the 30-day window.
    const windowStart = windowResetAt || createdAt;
    return Date.now() - new Date(windowStart).getTime() > THIRTY_DAYS_MS;
  };
  const expiredCount = rows.filter(r => isRequestExpired(r.created_at, r.status, r.agent_verified, r.pending_window_reset_at)).length;

/**
 * Multi-token search matcher:
 * - Splits search query into words so order does not matter (e.g., "Ruth Nanteze" matches "Nanteze Ruth").
 * - Trims whitespace and ignores extra spaces.
 * - Handles phone numbers with or without leading zero or country code (+256).
 */
function matchesSearch(query: string, ...haystacks: (string | null | undefined)[]): boolean {
  if (!query || !query.trim()) return true;
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const validHaystacks = haystacks.filter((h): h is string => Boolean(h && h.trim()));
  if (validHaystacks.length === 0) return false;

  const combined = validHaystacks.join(' ').toLowerCase();
  const digitsCombined = combined.replace(/\D+/g, '');

  return tokens.every(token => {
    if (combined.includes(token)) return true;

    const tokenDigits = token.replace(/\D+/g, '');
    if (tokenDigits.length >= 3) {
      const normalizedTokenDigits = tokenDigits.startsWith('256')
        ? tokenDigits.slice(3)
        : tokenDigits.startsWith('0')
          ? tokenDigits.slice(1)
          : tokenDigits;

      if (normalizedTokenDigits.length >= 3 && digitsCombined.includes(normalizedTokenDigits)) {
        return true;
      }
      if (digitsCombined.includes(tokenDigits)) {
        return true;
      }
    }

    return false;
  });
}

  const filtered = rows
    .filter(r => {
      if (selectedTenantId !== 'all' && r.tenant_id !== selectedTenantId) return false;
      if (noCallOnly && callStatus.loaded && !hasNoCallAtStage(callStatus.byId.get(r.id))) return false;
      if (stage === 'pending' && hideExpired && isRequestExpired(r.created_at, r.status, r.agent_verified, r.pending_window_reset_at)) {
        return false;
      }
      if (search.trim()) {
        const matchesMain = matchesSearch(
          search,
          r.tenant_name,
          r.tenant_phone,
          r.tenant_district,
          r.tenant_address,
          r.landlord_name,
          r.landlord_phone,
          r.landlord_district,
          r.landlord_address,
          r.agent_name,
          r.assigned_agent_name,
          r.agent_phone,
          r.agent_email,
          r.lc1_name,
          r.lc1_phone,
          r.location_search,
          r.request_city,
          r.house_category
        );
        if (!matchesMain) return false;
      }
      if (agentSearch.trim()) {
        const matchesAgent = matchesSearch(
          agentSearch,
          r.agent_name,
          r.assigned_agent_name,
          r.agent_phone,
          r.agent_email
        );
        if (!matchesAgent) return false;
      }
      if (landlordSearch.trim()) {
        const matchesLandlord = matchesSearch(
          landlordSearch,
          r.landlord_name,
          r.landlord_phone,
          r.landlord_district,
          r.landlord_address
        );
        if (!matchesLandlord) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const tsA = new Date(a.created_at).getTime();
      const tsB = new Date(b.created_at).getTime();
      return sortOrder === 'desc' ? tsB - tsA : tsA - tsB;
    });

  const handleApprove = async (decision?: FunderVisibilityDecision) => {
    if (!selectedRequest || !user) return;
    if (stage === 'pending' && isRequestExpired(selectedRequest.created_at, selectedRequest.status, selectedRequest.agent_verified, (selectedRequest as any).pending_window_reset_at)) {
      toast({ title: 'Request expired', description: 'Cannot approve a request that has exceeded 30 days without verification.', variant: 'destructive' });
      return;
    }
    const isOutstanding = selectedRequest.registration_type === 'outstanding_balance';
    if (config.showAgentSelector && !isOutstanding && !assignedAgentId && !selectedRequest.agent_id) {
      toast({ title: 'Please assign an agent', variant: 'destructive' });
      return;
    }

    // Tenant Ops confirms the request details and decides funder visibility first.
    if (stage === 'agent_ops_approved' && !isOutstanding && !decision) {
      setConfirmOpen(true);
      return;
    }

    // Landlord Ops must complete checklist (skipped for outstanding-balance
    // tenants — they short-circuit to completed via DB trigger).
    if (config.showLandlordChecklist && !isOutstanding && (!landlordCalled || !landlordAcknowledged)) {
      toast({ title: 'Complete the landlord verification checklist first', variant: 'destructive' });
      return;
    }


    // TID is mandatory for CFO approval (audit compliance)
    if (stage === 'coo_approved' && !payoutRef.trim()) {
      toast({ title: 'Transaction ID is required for audit compliance', variant: 'destructive' });
      return;
    }

    setProcessing(true);
    try {
      const statusChangedAt = new Date().toISOString();
      // For CFO stage: let the edge function handle status + float atomically
      if (stage === 'coo_approved') {
        const { data: floatRes, error: floatErr } = await supabase.functions.invoke('fund-agent-landlord-float', {
          body: {
            rent_request_id: selectedRequest.id,
            notes: comment || null,
            transaction_reference: payoutRef.trim(),
            payout_method: payoutMethod || 'mobile_money',
          },
        });
        if (floatErr) throw new Error(floatErr.message || 'Failed to fund agent float');
        if (floatRes?.error) throw new Error(floatRes.error);
      } else {
        const updateData: any = {
          status: config.nextStatus,
          [config.reviewerColumn]: user.id,
          [config.reviewerAtColumn]: statusChangedAt,
          updated_at: statusChangedAt,
        };

        // Persist this stage's comment in its dedicated column (visible to next stage)
        if (config.commentColumn) {
          updateData[config.commentColumn] = comment.trim() || null;
        }

        if (config.showAgentSelector && !isOutstanding && assignedAgentId) {
          updateData.assigned_agent_id = assignedAgentId;
        }

        // Save landlord verification checklist (skipped for outstanding-balance)
        if (config.showLandlordChecklist && !isOutstanding) {
          updateData.landlord_called = landlordCalled;
          updateData.landlord_acknowledged = landlordAcknowledged;
          updateData.landlord_verification_method = landlordVerificationMethod || 'phone_call';
          updateData.landlord_call_notes = landlordCallNotes || null;
        }

        // Tenant Ops funder-dashboard decision
        if (decision) {
          updateData.funder_visible = decision.funderVisible;
          updateData.funder_visibility_reason = decision.funderVisible ? null : decision.reason;
          updateData.funder_visibility_decided_by = user.id;
          updateData.funder_visibility_decided_at = statusChangedAt;
        }

        // Requests kept off the Funder dashboard have no proxy partner to attach,
        // so Landlord Ops forwards them straight to the COO.
        if (stage === 'tenant_ops_approved' && !isOutstanding && selectedRequest.funder_visible === false) {
          updateData.status = 'partner_ops_approved';
          updateData.partner_ops_reviewed_at = statusChangedAt;
          updateData.partner_ops_comment =
            `No proxy attached — not published to the Funder dashboard. Tenant Ops reason: ${selectedRequest.funder_visibility_reason || 'not provided'}`;
        }

        const { error } = await supabase
          .from('rent_requests')
          .update(updateData)
          .eq('id', selectedRequest.id);

        if (error) throw error;
      }

      toast({
        title: isOutstanding && stage === 'agent_ops_approved'
          ? 'Outstanding balance recorded'
          : 'Request approved and forwarded',
      });
      setConfirmOpen(false);
      setSelectedRequest(null);
      setComment('');
      setAssignedAgentId(null);
      setPayoutRef('');
      invalidateAllPipelineQueries();

      // No bonus is paid from the rent pipeline — see the note on the quick
      // approval path above. Audit only.
      if (config.showLandlordChecklist) {
        recordLandlordApprovalAudit(selectedRequest, statusChangedAt, false, 'No bonus payable from the pipeline');
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setProcessing(false);
    }
  };

  const handleReject = async () => {
    if (!selectedRequest || !user || !comment.trim()) {
      toast({ title: 'Rejection reason is required', variant: 'destructive' });
      return;
    }
    if (comment.trim().length < 10) {
      toast({ title: 'Reason must be at least 10 characters', variant: 'destructive' });
      return;
    }

    setProcessing(true);
    try {
      const { error } = await supabase.rpc('return_rent_request_for_correction', {
        p_request_id: selectedRequest.id,
        p_stage: stage,
        p_reason: comment.trim(),
      });
      if (error) throw error;

      // Stamp reviewer + stage-specific comment column for audit trail
      const reviewerPatch: any = {
        [config.reviewerColumn]: user.id,
        [config.reviewerAtColumn]: new Date().toISOString(),
      };
      if (config.commentColumn) reviewerPatch[config.commentColumn] = comment.trim();
      await supabase.from('rent_requests').update(reviewerPatch).eq('id', selectedRequest.id);

      // ── Auto-WhatsApp the originating Agent with the rejection details ──
      // The agent's own WhatsApp number is used (their account phone). We
      // prefill tenant name + tenant contact + amount + which dashboard
      // rejected + the comment. The agent then taps Send in WhatsApp.
      const agentPhone = formatWhatsApp(selectedRequest.agent_phone || '');
      const rejector = STAGE_REJECTOR_LABEL[stage] || 'Operations';
      const amountStr = `UGX ${Number(selectedRequest.rent_amount || 0).toLocaleString()}`;
      const tenantContact = selectedRequest.tenant_phone || 'N/A';
      const tenantName = selectedRequest.tenant_name || 'Unknown';
      const waText =
        `🔁 *Welile Rent Request Returned for Correction*\n\n` +
        `*Tenant:* ${tenantName}\n` +
        `*Tenant contact:* ${tenantContact}\n` +
        `*Amount requested:* ${amountStr}\n` +
        `*Rejected by:* ${rejector}\n\n` +
        `*Comment:*\n${comment.trim()}\n\n` +
        `Please review the comment, correct the request and resubmit from your Agent dashboard.`;

      if (agentPhone) {
        window.open(
          `https://wa.me/${agentPhone}?text=${encodeURIComponent(waText)}`,
          '_blank',
          'noopener,noreferrer',
        );
        sonnerToast.success(`Sent to ${selectedRequest.agent_name || 'Agent'} on WhatsApp`, {
          description: `${tenantName} • ${amountStr} • ${rejector} rejection`,
          duration: 6000,
        });
      } else {
        sonnerToast.warning('Returned for correction — agent has no phone on file for WhatsApp', {
          duration: 6000,
        });
      }

      toast({ title: 'Returned for correction — sent to Agent Ops & originating Agent' });
      setSelectedRequest(null);
      setComment('');
      invalidateAllPipelineQueries();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setProcessing(false);
    }
  };

  const fmt = (n: number) => Number(n || 0).toLocaleString();

  const handleBulkApprove = async () => {
    if (!user || selectedIds.size === 0) return;
    setProcessing(true);
    try {
      const ids = [...selectedIds];
      const failures: string[] = [];
      let approved = 0;
      for (const id of ids) {
        const stampedAt = new Date().toISOString();
        const { error } = await supabase
          .from('rent_requests')
          .update({
            status: config.nextStatus,
            [config.reviewerColumn]: user.id,
            [config.reviewerAtColumn]: stampedAt,
            updated_at: stampedAt,
          })
          .eq('id', id);
        // One bad row must never abandon the rest of the batch — the operator
        // would otherwise have no idea which of 200 requests actually moved.
        if (error) failures.push(error.message);
        else approved += 1;
      }
      if (approved > 0) {
        toast({ title: `✅ ${approved} request${approved === 1 ? '' : 's'} approved` });
      }
      if (failures.length > 0) {
        toast({
          title: `${failures.length} could not be approved`,
          description: failures[0],
          variant: 'destructive',
        });
      }
      setSelectedIds(new Set());
      invalidateAllPipelineQueries();
    } catch (err: any) {
      toast({ title: 'Bulk approval error', description: err.message, variant: 'destructive' });
    } finally {
      setProcessing(false);
    }
  };

  /**
   * Bulk return-for-correction. Uses the same
   * `return_rent_request_for_correction` RPC as the single-request reject so the
   * pipeline state machine, agent notification and audit trail stay identical —
   * only the loop is new. One shared reason is stamped on every request.
   */
  const handleBulkReject = async () => {
    if (!user || selectedIds.size === 0) return;
    const reason = bulkRejectReason.trim();
    if (reason.length < 10) {
      toast({ title: 'Reason must be at least 10 characters', variant: 'destructive' });
      return;
    }
    setProcessing(true);
    try {
      const ids = [...selectedIds];
      const failures: string[] = [];
      let rejected = 0;
      for (const id of ids) {
        const { error } = await supabase.rpc('return_rent_request_for_correction', {
          p_request_id: id,
          p_stage: stage,
          p_reason: reason,
        });
        if (error) {
          failures.push(error.message);
          continue;
        }
        const reviewerPatch: any = {
          [config.reviewerColumn]: user.id,
          [config.reviewerAtColumn]: new Date().toISOString(),
        };
        if (config.commentColumn) reviewerPatch[config.commentColumn] = reason;
        await supabase.from('rent_requests').update(reviewerPatch).eq('id', id);
        rejected += 1;
      }
      if (rejected > 0) {
        toast({
          title: `🔁 ${rejected} request${rejected === 1 ? '' : 's'} returned for correction`,
          description: 'The originating agents can now fix and resubmit them.',
        });
      }
      if (failures.length > 0) {
        toast({
          title: `${failures.length} could not be returned`,
          description: failures[0],
          variant: 'destructive',
        });
      }
      setSelectedIds(new Set());
      setBulkRejectReason('');
      setBulkRejectOpen(false);
      invalidateAllPipelineQueries();
    } catch (err: any) {
      toast({ title: 'Bulk return error', description: err.message, variant: 'destructive' });
    } finally {
      setProcessing(false);
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map(r => r.id)));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const isCooStage = stage === 'partner_ops_approved';
  // Agent Ops reviews the `pending` stage and clears the largest backlog, so it
  // gets the same bulk controls as the COO — plus bulk return-for-correction.
  const isAgentOpsStage = stage === 'pending';
  const allowBulkActions = isCooStage || isAgentOpsStage;

  return (
    <Card className="border border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base font-bold flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
              <config.icon className="h-4 w-4" />
            </span>
            <span>{config.title}</span>
          </CardTitle>
          <Badge variant="secondary" className="text-xs font-bold">
            {rows.length} pending
          </Badge>
        </div>
        {/* Bulk review controls for Agent Ops and COO */}
        {allowBulkActions && filtered.length > 0 && (
          selectedIds.size > 0 ? (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mt-1.5 p-2 rounded-lg bg-primary/5 border border-primary/20">
              <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold select-none">
                <Checkbox
                  checked={selectedIds.size === filtered.length && filtered.length > 0}
                  onCheckedChange={toggleSelectAll}
                />
                <span>Selected ({selectedIds.size} of {filtered.length})</span>
              </label>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1"
                  disabled={processing}
                  onClick={() => setBulkRejectOpen(true)}
                >
                  <XCircle className="h-3 w-3" />
                  Return selected ({selectedIds.size})
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs gap-1"
                  disabled={processing}
                  onClick={handleBulkApprove}
                >
                  {processing ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                  Approve selected ({selectedIds.size})
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center mt-1">
              <label className="inline-flex items-center gap-1.5 cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground py-0.5 select-none">
                <Checkbox
                  checked={false}
                  onCheckedChange={toggleSelectAll}
                />
                <span>Select all ({filtered.length})</span>
              </label>
            </div>
          )
        )}
        {bulkRejectOpen && (
          <div className="mt-2 space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-sm font-semibold">Return {selectedIds.size} selected request{selectedIds.size === 1 ? '' : 's'} for correction</p>
            <Textarea
              value={bulkRejectReason}
              onChange={e => setBulkRejectReason(e.target.value)}
              placeholder="Explain what the agent must correct (at least 10 characters)"
              rows={3}
              disabled={processing}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={processing}
                onClick={() => { setBulkRejectOpen(false); setBulkRejectReason(''); }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={processing || bulkRejectReason.trim().length < 10}
                onClick={handleBulkReject}
              >
                {processing ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
                Return selected
              </Button>
            </div>
          </div>
        )}
        {/* Desktop Filter Toolbar */}
        <div className="hidden sm:flex sm:flex-row gap-2 mt-2 items-start">
          <div className="flex items-center gap-2 w-auto">
            <Select value={selectedTenantId} onValueChange={setSelectedTenantId}>
              <SelectTrigger className="h-9 text-sm w-[260px]">
                <User className="h-3.5 w-3.5 mr-1 text-muted-foreground shrink-0" />
                <SelectValue placeholder="Choose a tenant to fund" />
              </SelectTrigger>
              <SelectContent className="max-h-[320px]">
                <SelectItem value="all">All tenants ({tenantOptions.length})</SelectItem>
                {tenantOptions.map(t => (
                  <SelectItem key={t.id} value={t.id}>
                    <span className="truncate">{t.name} → {t.landlord_name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Tooltip>
              <TooltipTrigger asChild>
                {tenantSyncStatus === 'synced' ? (
                  <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground cursor-help">
                    <Cloud className="h-3 w-3" />
                    Synced to account
                    {tenantSyncAt && (
                      <span className="text-[9px] opacity-70">· {formatTenantSync(tenantSyncAt)}</span>
                    )}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground cursor-help">
                    <HardDrive className="h-3 w-3" />
                    Saved locally
                    {tenantSyncAt && (
                      <span className="text-[9px] opacity-70">· {formatTenantSync(tenantSyncAt)}</span>
                    )}
                  </span>
                )}
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[240px] text-xs">
                {tenantSyncStatus === 'synced'
                  ? `This tenant filter was saved to your account settings${tenantSyncAt ? ` at ${formatTenantSync(tenantSyncAt)}` : ''}. It will follow you across devices and browsers.`
                  : `This tenant filter is stored only in this browser's localStorage${tenantSyncAt ? ` at ${formatTenantSync(tenantSyncAt)}` : ''}. It will not sync to other devices until you sign in.`}
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search tenant, landlord, agent, district or address..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 h-9 text-sm"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc')}
            className="h-9 gap-1.5 text-xs shrink-0 border-border"
            title={sortOrder === 'desc' ? 'Sorted by Date (Newest first)' : 'Sorted by Date (Oldest first)'}
          >
            <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{sortOrder === 'desc' ? 'Newest first' : 'Oldest first'}</span>
          </Button>
          {stage === 'pending' && expiredCount > 0 && (
            <Button
              type="button"
              variant={hideExpired ? 'outline' : 'secondary'}
              size="sm"
              onClick={() => setHideExpired(prev => !prev)}
              className="h-9 gap-1.5 text-xs shrink-0 border-border"
              title={hideExpired ? 'Click to show expired requests (> 30 days without verification)' : 'Click to hide expired requests'}
            >
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{hideExpired ? `Hide Expired (${expiredCount})` : `Show Expired (${expiredCount})`}</span>
            </Button>
          )}
        </div>

        {/* Agent / Landlord quick filters */}
        <div className="hidden sm:flex sm:flex-row gap-2 mt-2 items-start">
          <div className="relative flex-1 min-w-0">
            <UserCheck className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Filter by agent name"
              value={agentSearch}
              onChange={e => setAgentSearch(e.target.value)}
              className="pl-9 h-9 text-sm"
            />
          </div>
          <div className="relative flex-1 min-w-0">
            <Home className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Filter by landlord name"
              value={landlordSearch}
              onChange={e => setLandlordSearch(e.target.value)}
              className="pl-9 h-9 text-sm"
            />
          </div>
        </div>

        {/* Mobile Collapsed Filter Bar */}
        <div className="sm:hidden mt-2">
          {(() => {
            const activeFiltersCount = (selectedTenantId !== 'all' ? 1 : 0) + (search.trim() ? 1 : 0) + (agentSearch.trim() ? 1 : 0) + (landlordSearch.trim() ? 1 : 0) + (hideExpired ? 1 : 0) + (sortOrder === 'asc' ? 1 : 0);
            return (
              <Collapsible open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full flex items-center justify-between h-9 px-3 text-xs bg-muted/20 border-border hover:bg-muted/40 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <Filter className="h-3.5 w-3.5 text-primary" />
                      <span className="font-medium">Filter & Search</span>
                      {activeFiltersCount > 0 && (
                        <Badge variant="secondary" className="h-4 px-1.5 text-[10px] bg-primary/15 text-primary font-semibold">
                          {activeFiltersCount} active
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <span className="text-[11px]">{mobileFiltersOpen ? 'Hide' : 'Show'}</span>
                      <ChevronDown className={cn("h-4 w-4 transition-transform duration-200", mobileFiltersOpen && "rotate-180")} />
                    </div>
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2 space-y-2">
                  <div className="p-2.5 rounded-lg border border-border/70 bg-card/60 space-y-2.5 shadow-xs">
                    {/* Search */}
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder="Search tenant, landlord, agent..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="pl-9 h-9 text-sm bg-background"
                      />
                    </div>

                    {/* Agent / Landlord quick filters */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="relative">
                        <UserCheck className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          placeholder="Agent name"
                          value={agentSearch}
                          onChange={e => setAgentSearch(e.target.value)}
                          className="pl-9 h-9 text-sm bg-background"
                        />
                      </div>
                      <div className="relative">
                        <Home className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          placeholder="Landlord name"
                          value={landlordSearch}
                          onChange={e => setLandlordSearch(e.target.value)}
                          className="pl-9 h-9 text-sm bg-background"
                        />
                      </div>
                    </div>

                    {/* Tenant Select */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between px-0.5">
                        <span className="text-[11px] text-muted-foreground font-medium">Tenant</span>
                        {tenantSyncStatus === 'synced' ? (
                          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                            <Cloud className="h-3 w-3" /> Synced
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                            <HardDrive className="h-3 w-3" /> Saved locally
                          </span>
                        )}
                      </div>
                      <Select value={selectedTenantId} onValueChange={setSelectedTenantId}>
                        <SelectTrigger className="h-9 text-sm w-full bg-background">
                          <User className="h-3.5 w-3.5 mr-1 text-muted-foreground shrink-0" />
                          <SelectValue placeholder="Choose a tenant to fund" />
                        </SelectTrigger>
                        <SelectContent className="max-h-[320px]">
                          <SelectItem value="all">All tenants ({tenantOptions.length})</SelectItem>
                          {tenantOptions.map(t => (
                            <SelectItem key={t.id} value={t.id}>
                              <span className="truncate">{t.name} → {t.landlord_name}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Action buttons: Sort & Expired */}
                    <div className="flex items-center gap-2 pt-0.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc')}
                        className="flex-1 h-8 gap-1.5 text-xs bg-background"
                      >
                        <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
                        <span>{sortOrder === 'desc' ? 'Newest' : 'Oldest'}</span>
                      </Button>

                      {callStatus.loaded && (
                        <Button
                          type="button"
                          variant={noCallOnly ? 'secondary' : 'outline'}
                          size="sm"
                          aria-pressed={noCallOnly}
                          onClick={() => setNoCallOnly(prev => !prev)}
                          className="flex-1 h-8 gap-1.5 text-xs bg-background"
                        >
                          <span>No call yet ({noCallCount})</span>
                        </Button>
                      )}

                      {stage === 'pending' && expiredCount > 0 && (
                        <Button
                          type="button"
                          variant={hideExpired ? 'outline' : 'secondary'}
                          size="sm"
                          onClick={() => setHideExpired(prev => !prev)}
                          className="flex-1 h-8 gap-1.5 text-xs bg-background"
                        >
                          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>{hideExpired ? `Hide Exp (${expiredCount})` : `Show Exp (${expiredCount})`}</span>
                        </Button>
                      )}
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })()}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {(stage === 'pending' || stage === 'agent_ops_approved' || stage === 'tenant_ops_approved') && (
          <div className="px-3 pb-3">
            <MyAwarenessCallsCard />
          </div>
        )}
        <div className="px-3 pb-3">
          <TenantOpsReportToolbar
            tool="review_requests"
            status="all"
            search={search}
            visibleCount={filtered.length}
            fileSlug="tenant-requests-review-queue"
          />
        </div>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            No requests at this stage
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map(req => {
              const isLandlordStage = config.showLandlordChecklist && req.registration_type !== 'outstanding_balance';
              const cl = getCardChecklist(req.id);
              const checklistDone = (cl.called ? 1 : 0) + (cl.acknowledged ? 1 : 0);
              const checklistComplete = checklistDone === 2;
              const isExpanded = expandedCardIds.has(req.id);

              return (
              <div
                key={req.id}
                className="w-full text-left px-3.5 py-3 hover:bg-muted/30 transition-colors"
              >
                {/* Header row: Checkbox + Tenant info + Amount + Fold Toggle */}
                <div
                  onClick={() => openRequestDetail(req)}
                  className="flex items-start justify-between gap-2 cursor-pointer group/header select-none"
                  title="Click to view full rent request details"
                >
                  <div className="flex items-start gap-2 min-w-0 flex-1">
                    {/* Bulk review selection checkbox */}
                    {allowBulkActions && (
                      <div onClick={(e) => e.stopPropagation()} className="shrink-0 mt-0.5">
                        <Checkbox
                          checked={selectedIds.has(req.id)}
                          onCheckedChange={() => toggleSelect(req.id)}
                        />
                      </div>
                    )}
                    <div className="text-left min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                        <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="font-semibold text-sm break-words leading-tight group-hover/header:text-primary group-hover/header:underline transition-colors">
                          {req.tenant_name}
                        </span>
                        {(() => {
                          const cyc = getRentCycleLabel(req.repayment_frequency, req.duration_days);
                          return (
                            <span
                              className={cn(
                                'inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full border shrink-0',
                                RENT_CYCLE_BADGE_CLASSES[cyc.tone],
                              )}
                              title={`Repayment cycle: ${cyc.full}`}
                            >
                              <CalendarClock className="h-2.5 w-2.5" />
                              {cyc.full}
                            </span>
                          );
                        })()}
                        {(() => {
                          const approved = approvedCycleMap?.get(req.tenant_id) ?? 0;
                          const isRenewal = approved > 0;
                          return (
                            <>
                              <span
                                className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-slate-500/15 text-slate-700 dark:text-slate-300 border border-slate-500/30 shrink-0"
                                title={`Approved rent plans for this tenant: ${approved}`}
                              >
                                <Repeat className="h-2.5 w-2.5" />
                                Cycle {approved}
                              </span>
                              <span
                                className={cn(
                                  'inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full border shrink-0',
                                  isRenewal
                                    ? 'bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-500/30'
                                    : 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
                                )}
                                title={
                                  isRenewal
                                    ? 'Renewal — this tenant has had a rent plan approved before'
                                    : 'New — no approved rent plan for this tenant yet'
                                }
                              >
                                <Sparkles className="h-2.5 w-2.5" />
                                {isRenewal ? 'Renewal' : 'New'}
                              </span>
                            </>
                          );
                        })()}
                        {req.registration_type === 'outstanding_balance' && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700 border border-amber-500/30 shrink-0">
                            <AlertCircle className="h-2.5 w-2.5" />
                            Outstanding
                          </span>
                        )}
                        {isRequestExpired(req.created_at, req.status, req.agent_verified, req.pending_window_reset_at) && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-destructive/15 text-destructive border border-destructive/30 shrink-0">
                            <Clock className="h-2.5 w-2.5" />
                            Expired (&gt;30d)
                          </span>
                        )}
                        {req.is_resubmitted && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-700 border border-violet-500/30 shrink-0">
                            <RotateCcw className="h-2.5 w-2.5" />
                            Resubmitted
                          </span>
                        )}
                        <AwarenessCallBadge status={callStatus.byId.get(req.id)} />
                        {req.funder_visible === false && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-destructive/15 text-destructive border border-destructive/30 shrink-0">
                                <AlertCircle className="h-2.5 w-2.5" />
                                No proxy attached
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs text-xs">
                              Not published to the Funder dashboard. Tenant Ops reason:{' '}
                              {req.funder_visibility_reason || 'not provided'}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                      <div className="flex items-center gap-3 flex-wrap mt-1.5 text-[11px] text-muted-foreground">
                        {(req.assigned_agent_id || req.agent_id) && (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); setDrilldownAgentId(req.assigned_agent_id || req.agent_id); }}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setDrilldownAgentId(req.assigned_agent_id || req.agent_id); } }}
                            className="inline-flex items-center gap-1 hover:text-primary hover:underline cursor-pointer"
                            title="Open agent profile"
                          >
                            <UserCheck className="h-3 w-3 shrink-0" />
                            <span className="truncate max-w-[140px] sm:max-w-[180px]">{req.assigned_agent_name || req.agent_name || 'No Agent'}</span>
                          </span>
                        )}
                        {req.landlord_id && (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); setDrilldownLandlordId(req.landlord_id); }}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setDrilldownLandlordId(req.landlord_id); } }}
                            className="inline-flex items-center gap-1 hover:text-primary hover:underline cursor-pointer"
                            title="Open landlord profile"
                          >
                            <Home className="h-3 w-3 shrink-0" />
                            <span className="truncate max-w-[140px] sm:max-w-[180px]">{req.landlord_name || 'Unknown'}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right side: Amount and Fold/Unfold Chevron */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="font-bold text-sm text-foreground tabular-nums group-hover/header:text-primary transition-colors">
                      UGX {fmt(req.rent_amount)}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={(e) => toggleCardExpanded(req.id, e)}
                      className="h-7 w-7 p-0 rounded-full hover:bg-muted text-muted-foreground"
                      title={isExpanded ? "Fold details" : "Unfold details"}
                    >
                      <ChevronDown className={cn("h-4 w-4 transition-transform duration-200", isExpanded && "rotate-180")} />
                    </Button>
                  </div>
                </div>

                {/* Foldable details section (unfolds on toggle) */}
                {isExpanded && (
                  <div className="mt-2.5 pt-2 border-t border-dashed border-border/60 space-y-2 text-xs animate-in fade-in-50 duration-150">
                    <div className="flex items-center gap-2 sm:gap-3 text-muted-foreground flex-wrap min-w-0">
                      {req.landlord_id ? (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); setDrilldownLandlordId(req.landlord_id); }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setDrilldownLandlordId(req.landlord_id); } }}
                          className="flex items-center gap-1 text-primary hover:underline cursor-pointer"
                          title="Open landlord profile"
                        >
                          <Home className="h-3 w-3" />
                          {req.landlord_name}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <Home className="h-3 w-3" />
                          {req.landlord_name}
                        </span>
                      )}
                      {req.landlord_is_new && (
                        <Badge variant="outline" className="border-amber-500/50 px-1 py-0 text-[9px] text-amber-600 dark:text-amber-400">
                          new landlord
                        </Badge>
                      )}
                      {req.lc1_is_new && (
                        <Badge variant="outline" className="border-amber-500/50 px-1 py-0 text-[9px] text-amber-600 dark:text-amber-400">
                          new LC1
                        </Badge>
                      )}
                      {(req.assigned_agent_id || req.agent_id) ? (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); setDrilldownAgentId(req.assigned_agent_id || req.agent_id); }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setDrilldownAgentId(req.assigned_agent_id || req.agent_id); } }}
                          className="flex items-center gap-1 text-primary hover:underline cursor-pointer"
                          title="Open agent profile"
                        >
                          <UserCheck className="h-3 w-3" />
                          {req.assigned_agent_name || req.agent_name || 'No Agent'}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-primary">
                          <UserCheck className="h-3 w-3" />
                          No Agent
                        </span>
                      )}
                      {(req.request_city || req.landlord_district || req.tenant_district) && (
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {req.request_city || req.landlord_district || req.tenant_district}
                        </span>
                      )}
                    </div>

                    {/* WhatsApp quick contacts */}
                    <div className="flex items-center gap-1 sm:gap-2 flex-wrap min-w-0">
                      <WhatsAppButton phone={req.tenant_phone} name={req.tenant_name} label="Tenant" />
                      <WhatsAppButton phone={req.landlord_phone} name={req.landlord_name} label="Landlord" />
                      <WhatsAppButton phone={req.agent_phone} name={req.assigned_agent_name || req.agent_name} label="Agent" />
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono pt-1">
                      <span>Submitted: {format(new Date(req.created_at), 'dd MMM yyyy, HH:mm')}</span>
                      {stage === 'pending' && (() => {
                        const expiryDate = new Date(new Date(req.created_at).getTime() + 30 * 24 * 60 * 60 * 1000);
                        const isPastExpiry = Date.now() > expiryDate.getTime();
                        return (
                          <span className={`font-mono flex items-center gap-1 ${isPastExpiry ? 'text-destructive font-semibold' : 'text-amber-600 dark:text-amber-400'}`}>
                            <Clock className="h-2.5 w-2.5 shrink-0" />
                            Expires: {format(expiryDate, 'dd MMM yyyy')}
                          </span>
                        );
                      })()}
                    </div>

                    {/* View full sheet button from unfolded card */}
                    <div className="pt-1 flex justify-end">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); openRequestDetail(req); }}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                      >
                        <span>Open Full Review Drawer</span>
                        <ArrowRight className="h-3 w-3" />
                      </button>
                    </div>

                    {/* Inline landlord verification checklist */}
                    {isLandlordStage && (
                      <div className="mt-2 space-y-2 pt-2 border-t border-border/40">
                        {checklistSyncStatus !== 'idle' && (
                          <div className="flex items-center gap-1.5">
                            {checklistSyncStatus === 'saving' && (
                              <>
                                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                                <span className="text-[10px] font-medium text-muted-foreground">Saving…</span>
                              </>
                            )}
                            {checklistSyncStatus === 'saved' && (
                              <>
                                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                                <span className="text-[10px] font-medium text-emerald-600">
                                  {checklistSavedAt && Date.now() - checklistSavedAt.getTime() < 5000
                                    ? 'Saved'
                                    : `Saved${checklistSavedAt ? ` · ${format(checklistSavedAt, 'h:mm a')}` : ''}`}
                                </span>
                              </>
                            )}
                            {checklistSyncStatus === 'failed' && (
                              <>
                                <AlertCircle className="h-3 w-3 text-destructive" />
                                <span className="text-[10px] font-medium text-destructive">
                                  Not saved to server — saved on this phone only
                                </span>
                              </>
                            )}
                          </div>
                        )}

                        <div className={`flex items-center gap-2 rounded-lg px-3 py-2 border ${checklistComplete ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-amber-500/10 border-amber-500/30'}`}>
                          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${checklistComplete ? 'bg-emerald-500 text-white' : 'bg-amber-500 text-white'}`}>
                            {checklistComplete ? '✓' : `${checklistDone}`}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className={`text-xs font-bold ${checklistComplete ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-800 dark:text-amber-300'}`}>
                              {checklistComplete
                                ? 'All done — tap Approve now'
                                : `${checklistDone} of 2 done — finish the steps below`}
                            </p>
                            <div className="mt-1 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-300 ${checklistComplete ? 'bg-emerald-500 w-full' : checklistDone === 1 ? 'bg-amber-500 w-1/2' : 'bg-amber-500 w-0'}`}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="rounded-xl border border-purple-500/30 bg-purple-500/5 p-3 space-y-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold flex items-center gap-1.5 text-purple-700 dark:text-purple-300">
                              <ShieldCheck className="h-4 w-4" />
                              Do these 2 steps first
                            </span>
                          </div>

                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); toggleCardCheck(req.id, 'called', !cl.called); }}
                            className={`w-full flex items-center gap-3 rounded-xl border-2 p-2.5 text-left transition-colors ${cl.called ? 'border-emerald-500 bg-emerald-500/10' : 'border-border bg-background active:bg-muted'}`}
                          >
                            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${cl.called ? 'bg-emerald-500 text-white' : 'bg-muted text-foreground'}`}>
                              {cl.called ? '✓' : '1'}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-xs font-semibold">I called the landlord</span>
                              <span className="block text-[11px] text-muted-foreground">
                                {req.landlord_phone ? `Call ${req.landlord_phone}, then tap here` : 'Call the landlord, then tap here'}
                              </span>
                            </span>
                          </button>

                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); toggleCardCheck(req.id, 'acknowledged', !cl.acknowledged); }}
                            className={`w-full flex items-center gap-3 rounded-xl border-2 p-2.5 text-left transition-colors ${cl.acknowledged ? 'border-emerald-500 bg-emerald-500/10' : 'border-border bg-background active:bg-muted'}`}
                          >
                            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${cl.acknowledged ? 'bg-emerald-500 text-white' : 'bg-muted text-foreground'}`}>
                              {cl.acknowledged ? '✓' : '2'}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-xs font-semibold">Landlord said Welile will pay</span>
                              <span className="block text-[11px] text-muted-foreground">They understand Welile sends the rent, not the tenant</span>
                            </span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Bottom Action Row: Reject on far left, Details in center, Approve on far right */}
                <div className="flex items-center justify-between gap-2 w-full pt-2.5 mt-2 border-t border-border/40">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={(e) => { e.stopPropagation(); openRequestDetail(req); }}
                    disabled={quickProcessingId === req.id}
                    className="h-8 px-3 text-xs font-semibold text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive active:scale-95 transition-all gap-1.5"
                    title="Reject request"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    <span>Reject</span>
                  </Button>

                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={(e) => { e.stopPropagation(); openRequestDetail(req); }}
                    className="h-8 px-2.5 text-xs text-primary hover:bg-primary/10 gap-1.5 font-semibold"
                    title="Open full rent request review details"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    <span>Details</span>
                  </Button>

                  <Button
                    type="button"
                    size="sm"
                    onClick={(e) => handleQuickApprove(req, e)}
                    disabled={quickProcessingId === req.id || (isLandlordStage && !checklistComplete) || isRequestExpired(req.created_at, req.status, req.agent_verified, req.pending_window_reset_at)}
                    title={
                      isRequestExpired(req.created_at, req.status, req.agent_verified, req.pending_window_reset_at)
                        ? "This rent request expired after 30 days without verification"
                        : isLandlordStage && !checklistComplete
                        ? `Complete the landlord verification checklist (${checklistDone}/2)`
                        : undefined
                    }
                    className="h-8 px-4 text-xs font-bold gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 shadow-xs active:scale-95 transition-all"
                  >
                    {quickProcessingId === req.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    )}
                    <span>Approve</span>
                  </Button>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </CardContent>

      {/* Tenant Detail Sheet */}
      <Sheet open={!!selectedRequest} onOpenChange={(open) => { if (!open) { setSelectedRequest(null); setComment(''); setAssignedAgentId(null); setPayoutRef(''); setLandlordCalled(false); setLandlordAcknowledged(false); setLandlordVerificationMethod(''); setLandlordCallNotes(''); } }}>
        <SheetContent side="bottom" className="h-[85vh] rounded-t-2xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 text-base">
              <User className="h-4 w-4 text-primary" />
              Review Rent Request
            </SheetTitle>
          </SheetHeader>
          {selectedRequest && (
            <div className="space-y-4 mt-4 overflow-y-auto max-h-[calc(85vh-80px)] pb-6">
              {/* Tenant status first: renewal vs new tenant, with existing payment history */}
              <TenantPaymentHistoryCard
                tenantId={selectedRequest.tenant_id}
                currentRequestId={selectedRequest.id}
              />
              {selectedRequest.registration_type === 'outstanding_balance' && (

                <div className="rounded-xl border-2 border-amber-500/30 bg-amber-500/5 p-3 flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                  <div className="text-xs">
                    <p className="font-bold text-amber-800">Outstanding balance — short approval</p>
                    <p className="text-muted-foreground mt-0.5">
                      Existing tenant. Two-stage approval (Tenant Ops → Agent verify).
                      No landlord verification, no disbursement, no agent bonus.
                    </p>
                  </div>
                </div>
              )}
              {/* Request Details */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="space-y-0.5">
                  <p className="text-xs text-muted-foreground">Tenant</p>
                  <p className="font-semibold">{selectedRequest.tenant_name}</p>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-xs text-muted-foreground">{selectedRequest.tenant_phone}</span>
                    <WhatsAppButton phone={selectedRequest.tenant_phone} name={selectedRequest.tenant_name} label="WhatsApp" />
                  </div>
                </div>
                <div className="space-y-0.5">
                  <p className="text-xs text-muted-foreground">Landlord</p>
                  {selectedRequest.landlord_id ? (
                    <button
                      type="button"
                      onClick={() => setDrilldownLandlordId(selectedRequest.landlord_id)}
                      className="font-semibold text-primary hover:underline text-left"
                      title="Open full landlord profile"
                    >
                      {selectedRequest.landlord_name}
                    </button>
                  ) : (
                    <p className="font-semibold">{selectedRequest.landlord_name}</p>
                  )}
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-xs text-muted-foreground">{selectedRequest.landlord_phone}</span>
                    <WhatsAppButton phone={selectedRequest.landlord_phone} name={selectedRequest.landlord_name} label="WhatsApp" />
                  </div>
                </div>
                <div className="space-y-0.5 col-span-2">
                  <p className="text-xs text-muted-foreground">Assigned Agent</p>
                  <p className="font-semibold">{selectedRequest.assigned_agent_name || selectedRequest.agent_name || 'No Agent'}</p>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="text-xs text-muted-foreground">{selectedRequest.agent_phone}</span>
                    <WhatsAppButton phone={selectedRequest.agent_phone} name={selectedRequest.assigned_agent_name || selectedRequest.agent_name} label="WhatsApp" />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs gap-1"
                      onClick={() => setTransferOpen(true)}
                    >
                      <ArrowRightLeft className="h-3 w-3" />
                      Transfer Agent
                    </Button>
                  </div>
                  {selectedRequest.agent_email && (
                    <p className="text-xs text-muted-foreground mt-0.5">✉️ {selectedRequest.agent_email}</p>
                  )}
                </div>
                {/* Awareness call: phone the tenant / landlord / agent and record what they heard. Storage only; approve and reject below are unchanged.
                    The COO and CFO stages see it read-only. The agent id is passed only when the phone shown is that agent's (no transfer to another agent). */}
                <div className="col-span-2">
                  <AwarenessCallPanel
                    key={selectedRequest.id}
                    request={{
                      ...selectedRequest,
                      agent_id: selectedRequest.assigned_agent_id && selectedRequest.assigned_agent_id !== selectedRequest.agent_id ? null : selectedRequest.agent_id,
                    }}
                    defaultSubject={defaultAwarenessSubjectForStage(stage)}
                    readOnly={isAwarenessReadOnlyStage(stage)}
                    landlordChecklistNote={stage === 'tenant_ops_approved'}
                  />
                </div>
                <InlineEditableField field="rent_amount" label="Rent Amount" value={selectedRequest.rent_amount} prefix="UGX " className="font-bold text-base" />
                <InlineEditableField field="duration_days" label="Duration" value={selectedRequest.duration_days} suffix=" days" />
                <div className="flex items-center justify-between gap-2 py-1">
                  <span className="text-xs text-muted-foreground">Repayment cycle</span>
                  <span className="text-xs font-semibold">
                    {getRentCycleLabel(selectedRequest.repayment_frequency, selectedRequest.duration_days).full}
                  </span>
                </div>
                <InlineEditableField field="access_fee" label="Access Fee" value={selectedRequest.access_fee} prefix="UGX " />
                <InlineEditableField field="daily_repayment" label="Daily Repayment" value={selectedRequest.daily_repayment} prefix="UGX " className="font-bold text-base text-primary" />
                <InlineEditableField field="total_repayment" label="Total Repayment" value={selectedRequest.total_repayment} prefix="UGX " />
                <div className="space-y-0.5">
                  <p className="text-xs text-muted-foreground">Submitted Date</p>
                  <p className="font-semibold text-xs font-mono">{format(new Date(selectedRequest.created_at), 'dd MMM yyyy, HH:mm')}</p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-xs text-muted-foreground">Expiry Date</p>
                  <p className="font-semibold text-xs font-mono text-amber-600 dark:text-amber-400 flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {format(new Date(new Date(selectedRequest.created_at).getTime() + 30 * 24 * 60 * 60 * 1000), 'dd MMM yyyy, HH:mm')}
                  </p>
                </div>
                {selectedRequest.house_category && (
                  <InlineEditableField field="house_category" label="House Category" value={selectedRequest.house_category} />
                )}
                {selectedRequest.request_city && (
                  <div className="space-y-0.5">
                    <p className="text-xs text-muted-foreground">Location</p>
                    <p className="font-semibold">{selectedRequest.request_city}</p>
                  </div>
                )}
                {selectedRequest.tenant_address && (
                  <div className="space-y-0.5 col-span-2">
                    <p className="text-xs text-muted-foreground">Tenant Residence (as captured)</p>
                    <p className="font-semibold">{selectedRequest.tenant_address}</p>
                  </div>
                )}
                {selectedRequest.landlord_address && (
                  <div className="space-y-0.5 col-span-2">
                    <p className="text-xs text-muted-foreground">Landlord / Property Address</p>
                    <p className="font-semibold">{selectedRequest.landlord_address}</p>
                  </div>
                )}
              </div>

              {selectedRequest.landlord_id && (
                <LandlordAgreementHistory
                  landlordId={selectedRequest.landlord_id}
                  landlordName={selectedRequest.landlord_name || 'Landlord'}
                  landlordPhone={selectedRequest.landlord_phone || ''}
                  propertyAddress={selectedRequest.landlord_address}
                  canAdd={false}
                />
              )}





              {/* Latest rent receipt from landlord — highlighted for operator review */}
              {selectedRequest.latest_rent_receipt_url && (
                <div className="rounded-xl border-2 border-amber-400/60 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold flex items-center gap-1.5 text-amber-900 dark:text-amber-200">
                      <Camera className="h-4 w-4" />
                      Tenant's Latest Rent Receipt (from Landlord)
                    </h4>
                    {selectedRequest.latest_rent_receipt_uploaded_at && (
                      <span className="text-[10px] text-amber-800/70 dark:text-amber-300/70">
                        {new Date(selectedRequest.latest_rent_receipt_uploaded_at).toLocaleString()}
                      </span>
                    )}
                  </div>
                  <a
                    href={selectedRequest.latest_rent_receipt_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block"
                  >
                    <img
                      src={selectedRequest.latest_rent_receipt_url}
                      alt="Tenant's latest rent receipt"
                      className="w-full max-h-96 rounded-lg object-contain border-2 border-amber-300 bg-card hover:ring-2 hover:ring-amber-500 transition-all cursor-zoom-in"
                      loading="lazy"
                    />
                  </a>
                  <p className="text-[10px] text-amber-800/80 dark:text-amber-300/80">
                    Most recent receipt the landlord issued to this tenant. Click to enlarge.
                  </p>
                </div>
              )}

              {/* Tenant passport + house photos — visible verification evidence */}
              {(selectedRequest.tenant_photo_url || (selectedRequest.house_image_urls && selectedRequest.house_image_urls.length > 0)) && (
                <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-3">
                  <h4 className="text-sm font-semibold flex items-center gap-1.5">
                    <Camera className="h-4 w-4 text-primary" />
                    Verification Photos
                  </h4>
                  <div className="flex flex-wrap gap-3">
                    {selectedRequest.tenant_photo_url && (
                      <div className="space-y-1">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Tenant Passport</p>
                        <a href={selectedRequest.tenant_photo_url} target="_blank" rel="noopener noreferrer" className="block">
                          <img
                            src={selectedRequest.tenant_photo_url}
                            alt={`Tenant ${selectedRequest.tenant_name}`}
                            className="h-32 w-24 rounded-lg object-cover border-2 border-primary/30 hover:ring-2 hover:ring-primary transition-all bg-background"
                            loading="lazy"
                          />
                        </a>
                      </div>
                    )}
                    {selectedRequest.house_image_urls && selectedRequest.house_image_urls.length > 0 && (
                      <div className="space-y-1 flex-1 min-w-0">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold flex items-center gap-1">
                          <ImageIcon className="h-3 w-3" />
                          House Photos ({selectedRequest.house_image_urls.length})
                        </p>
                        <div className="flex gap-2 overflow-x-auto pb-1">
                          {selectedRequest.house_image_urls.map((url: string, i: number) => (
                            <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="shrink-0">
                              <img
                                src={url}
                                alt={`House ${i + 1}`}
                                className="h-32 w-32 rounded-lg object-cover border border-border hover:ring-2 hover:ring-primary/50 transition-all"
                                loading="lazy"
                              />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Captured by the agent at registration. Click any photo to enlarge.
                  </p>

                  {/* Face recognition + image fingerprint behind the passport photo. */}
                  {selectedRequest.tenant_photo_url && (
                    <TenantPhotoChecksPanel rentRequestId={selectedRequest.id} />
                  )}
                </div>
              )}

              {/* LC1 & GPS Details — hidden for outstanding-balance (no fresh property to verify) */}
              {selectedRequest.registration_type !== 'outstanding_balance' && (
              <div className="rounded-xl border border-border p-3 bg-muted/30 space-y-2">
                <h4 className="text-sm font-semibold">📍 Property Location & LC1</h4>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {selectedRequest.lc1_name && (
                    <div className="space-y-0.5">
                      <p className="text-xs text-muted-foreground">LC1 Chairperson</p>
                      <p className="font-semibold">{selectedRequest.lc1_name}</p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="text-xs text-muted-foreground">{selectedRequest.lc1_phone}</span>
                        <WhatsAppButton phone={selectedRequest.lc1_phone} name={selectedRequest.lc1_name} label="WhatsApp" />
                      </div>
                    </div>
                  )}
                  {selectedRequest.lc1_village && (
                    <div className="space-y-0.5">
                      <p className="text-xs text-muted-foreground">Village</p>
                      <p className="font-semibold">{selectedRequest.lc1_village}</p>
                    </div>
                  )}
                  {selectedRequest.lc1_address && (
                    <div className="space-y-0.5">
                      <p className="text-xs text-muted-foreground">LC1 Area</p>
                      <p className="font-semibold">{selectedRequest.lc1_address}</p>
                    </div>
                  )}
                  {(selectedRequest.request_latitude && selectedRequest.request_longitude) && (
                    <div className="space-y-0.5 col-span-2">
                      <p className="text-xs text-muted-foreground">GPS Coordinates</p>
                      <div className="flex items-center gap-2">
                        <p className="font-mono text-xs">{Number(selectedRequest.request_latitude).toFixed(6)}, {Number(selectedRequest.request_longitude).toFixed(6)}</p>
                        <a
                          href={`https://www.google.com/maps?q=${selectedRequest.request_latitude},${selectedRequest.request_longitude}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                        >
                          <MapPin className="h-3 w-3" />
                          Open Map
                        </a>
                      </div>
                    </div>
                  )}
                  {!selectedRequest.lc1_name && !selectedRequest.request_latitude && (
                    <p className="text-xs text-muted-foreground col-span-2">No LC1 or GPS data captured for this request</p>
                  )}
                </div>
              </div>
              )}

              {/* Pipeline Status + Agent Benefits */}
              <RentPipelineTracker
                currentStatus={selectedRequest.status}
                rentAmount={selectedRequest.rent_amount}
                showAgentBenefits={true}
                registrationType={selectedRequest.registration_type}
              />

              {/* Agent Proximity Selector - only for Tenant Ops on normal requests */}
              {config.showAgentSelector && selectedRequest.registration_type !== 'outstanding_balance' && (
                <AgentProximitySelector
                  latitude={selectedRequest.request_latitude}
                  longitude={selectedRequest.request_longitude}
                  currentAgentId={selectedRequest.agent_id}
                  onSelect={setAssignedAgentId}
                  selectedAgentId={assignedAgentId}
                />
              )}

              {/* Previous-stage comments (read-only context) */}
              {config.previousCommentColumns && config.previousCommentColumns.some(c => selectedRequest[c.column]) && (
                <div className="rounded-xl border border-border bg-muted/40 p-3 space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                    <MessageCircle className="h-3 w-3" />
                    Notes from previous stages
                  </h4>
                  <div className="space-y-1.5">
                    {config.previousCommentColumns.map(c => selectedRequest[c.column] ? (
                      <div key={c.column} className="text-xs">
                        <span className="font-semibold text-foreground">{c.label}:</span>{' '}
                        <span className="text-muted-foreground">{selectedRequest[c.column]}</span>
                      </div>
                    ) : null)}
                  </div>
                </div>
              )}

              {/* Landlord Verification Checklist - only for Landlord Ops on normal requests
                  (outstanding-balance requests never reach this stage) */}
              {config.showLandlordChecklist && selectedRequest.registration_type !== 'outstanding_balance' && (
                <div className="space-y-3 rounded-xl border-2 border-purple-500/30 p-3 bg-purple-500/5">
                  <h4 className="text-sm font-bold flex items-center gap-2">
                    <PhoneCall className="h-4 w-4 text-purple-600" />
                    Landlord Verification Checklist
                  </h4>
                  <p className="text-[10px] text-muted-foreground">
                    Call the landlord at <span className="font-mono font-bold">{selectedRequest.landlord_phone || selectedRequest.landlord_momo}</span> and complete this checklist before approving.
                  </p>

                  <div className="space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={landlordCalled}
                        onCheckedChange={(v) => {
                          setLandlordCalled(!!v);
                          if (selectedRequest) toggleCardCheck(selectedRequest.id, 'called', !!v);
                        }}
                      />
                      <span className="text-sm">I have called the landlord</span>
                    </label>

                    <label className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={landlordAcknowledged}
                        onCheckedChange={(v) => {
                          setLandlordAcknowledged(!!v);
                          if (selectedRequest) toggleCardCheck(selectedRequest.id, 'acknowledged', !!v);
                        }}
                      />
                      <span className="text-sm">Landlord acknowledges Welile as the payer</span>
                    </label>
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Verification Method</label>
                    <select
                      value={landlordVerificationMethod}
                      onChange={(e) => setLandlordVerificationMethod(e.target.value)}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="" disabled>How was the landlord verified?</option>
                      <option value="phone_call">Phone Call</option>
                      <option value="physical_visit">Physical Visit</option>
                      <option value="lc1_confirmation">LC1 Confirmation</option>
                      <option value="video_call">Video Call</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Call Notes</label>
                    <Textarea
                      placeholder="Notes from the landlord call..."
                      value={landlordCallNotes}
                      onChange={e => setLandlordCallNotes(e.target.value)}
                      rows={2}
                    />
                  </div>

                  {(!landlordCalled || !landlordAcknowledged) && (
                    <p className="text-[10px] text-destructive flex items-center gap-1">
                      <ShieldCheck className="h-3 w-3" />
                      Both checkboxes must be checked to approve
                    </p>
                  )}
                </div>
              )}

              {/* Payout Fields - only for CFO */}
              {config.showPayoutFields && (
                <div className="space-y-3 rounded-xl border-2 border-primary/30 p-3 bg-primary/5">
                  <h4 className="text-sm font-bold flex items-center gap-2">💳 Payout Details</h4>
                  
                  {/* Landlord MoMo Info - Prominent */}
                  <div className="rounded-lg border border-border bg-background p-3 space-y-1">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Landlord Payment Info</p>
                    <p className="font-bold text-sm">{selectedRequest.landlord_name}</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      {selectedRequest.landlord_momo && (
                        <span className="inline-flex items-center gap-1 text-xs font-mono bg-primary/10 text-primary px-2 py-1 rounded-md">
                          📱 MoMo: {selectedRequest.landlord_momo}
                        </span>
                      )}
                      {selectedRequest.landlord_phone && selectedRequest.landlord_phone !== selectedRequest.landlord_momo && (
                        <span className="inline-flex items-center gap-1 text-xs font-mono bg-muted px-2 py-1 rounded-md">
                          📞 {selectedRequest.landlord_phone}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Call or send MoMo directly to the landlord's number above, then enter the TID below.
                    </p>
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Payout Method</label>
                    <Select value={payoutMethod} onValueChange={setPayoutMethod}>
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="wallet">Wallet (Landlord has Rent Money)</SelectItem>
                        <SelectItem value="cash">Cash Payout (No Wallet)</SelectItem>
                        <SelectItem value="mobile_money">Mobile Money (Direct to Landlord)</SelectItem>
                        <SelectItem value="bank">Bank Transfer</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs font-semibold mb-1 block">
                      {payoutMethod === 'mobile_money' ? 'MoMo Transaction ID (TID) *' :
                       payoutMethod === 'bank' ? 'Bank Reference *' :
                       payoutMethod === 'cash' ? 'Payment Voucher Number *' :
                       'Transaction Reference *'}
                    </label>
                    <Input
                      placeholder={
                        payoutMethod === 'mobile_money' ? 'Enter MoMo TID after sending' :
                        payoutMethod === 'bank' ? 'Enter bank transfer reference' :
                        payoutMethod === 'cash' ? 'Enter payment voucher number' :
                        'Enter transaction ID or reference'
                      }
                      value={payoutRef}
                      onChange={e => setPayoutRef(e.target.value)}
                      className="h-9 font-mono"
                    />
                  </div>
                </div>
              )}

              {/* Comment */}
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground mb-1 block">
                  {stage === 'coo_approved' ? 'Notes' : 'Review Comment'}
                </label>
                <Textarea
                  placeholder="Add your review notes..."
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  rows={2}
                />
                {/* Fills the SAME review comment used by the existing
                    return-for-correction action — no new workflow. */}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-[11px]"
                  onClick={() => setComment('Signed landlord agreement is not attached. Please attach the landlord\'s signed agreement to this landlord record, then resubmit this request.')}
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Use "signed agreement missing" reason
                </Button>
              </div>

              <div className="flex gap-2 pt-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleReject}
                  disabled={processing || !comment.trim()}
                >
                  <XCircle className="h-4 w-4 mr-1" />
                  Reject
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handleApprove()}
                  disabled={processing}
                  className="gap-1"
                >
                  {processing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}
                  {selectedRequest?.registration_type === 'outstanding_balance'
                    ? (stage === 'pending'
                        ? 'Approve & Send to Agent'
                        : stage === 'tenant_ops_approved'
                          ? 'Confirm & Record Outstanding'
                          : config.approveLabel)
                    : config.approveLabel}
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
      <RentApprovalConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        request={selectedRequest}
        approveLabel={config.approveLabel}
        processing={processing}
        onConfirm={(decision: FunderVisibilityDecision) => void handleApprove(decision)}
      />
      <UserDrilldownDrawer
        open={!!drilldownAgentId}
        onOpenChange={(v) => { if (!v) setDrilldownAgentId(null); }}
        agentId={drilldownAgentId}
        defaultTab="agent"
      />
      {selectedRequest && (
        <PipelineAgentTransferDialog
          open={transferOpen}
          onOpenChange={setTransferOpen}
          requestId={selectedRequest.id}
          tenantName={selectedRequest.tenant_name}
          currentAgentId={selectedRequest.assigned_agent_id || selectedRequest.agent_id}
          currentAgentName={selectedRequest.assigned_agent_name || selectedRequest.agent_name}
          onTransferred={() => {
            invalidateAllPipelineQueries();
            setSelectedRequest(null);
          }}
        />
      )}
      <UserDrilldownDrawer
        open={!!drilldownLandlordId}
        onOpenChange={(v) => { if (!v) setDrilldownLandlordId(null); }}
        landlordId={drilldownLandlordId}
        defaultTab="landlord"
      />
    </Card>
  );
}
