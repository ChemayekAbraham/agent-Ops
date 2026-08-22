import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { addDays, format } from 'date-fns';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, splitPersonName, type PersonNameParts } from '@/lib/authValidation';
import { computeUndoSelection } from '@/lib/undoHouseSelection';
import { motion, AnimatePresence } from '@/lib/motion-lite';
import { supabase } from '@/integrations/supabase/client';
import { optimizeImage } from '@/lib/imageOptimizer';
import { archiveToDrive } from '@/lib/archiveToDrive';
import { GuarantorConsentCheckbox } from '@/components/agent/GuarantorConsentCheckbox';
import { LandlordSearchSelect, type LandlordOption } from '@/components/agent/LandlordSearchSelect';
import RegisterLandlordDialog from '@/components/agent/RegisterLandlordDialog';
import { ListEmptyHouseDialog } from '@/components/agent/ListEmptyHouseDialog';
import { listingHasRealPhoto } from '@/hooks/useHouseListings';
import { ExistingTenantPhoneNotice } from '@/components/agent/ExistingTenantPhoneNotice';
import { TenantDuplicateNotice } from '@/components/agent/TenantDuplicateNotice';
import { useTenantDuplicateCheck, type TenantDuplicateMatch } from '@/hooks/useTenantDuplicateCheck';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import { Lc1VillagePicker } from '@/components/location/Lc1VillagePicker';
import { UgDistrictSelect, type UgDistrictValue } from '@/components/location/UgDistrictSelect';
import type { UgLocationSelection } from '@/hooks/useUgLocations';
import { useLc1ForVillage } from '@/hooks/useLc1ForVillage';

import { useAuth } from '@/hooks/useAuth';
import { useAgentCapacityMap, DAILY_ELIGIBILITY_THRESHOLD, NEW_AGENT_TENANT_THRESHOLD, NEW_AGENT_RENT_CAP_UGX } from '@/hooks/useAgentCapacityMap';
import { useListingDaytimeGuard } from '@/hooks/useListingDaytimeGuard';
import { DailyRatingThresholdPopover } from '@/components/shared/DailyRatingThresholdPopover';
import { EntityDetailSheet } from '@/components/executive/EntityDetailSheet';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { 
  User, 
  MapPin,
  Navigation,
  Building2,
  Loader2,
  CheckCircle2,
  ShieldCheck,
  FileText,
  Calculator,
  Calendar,
  Banknote,
  Users,
  Upload,
  Share2,
  Copy,
  MessageCircle,
  Home,
  AlertTriangle,
  ChevronDown,
  AlertCircle,
  Phone,
  Search,
  UserPlus,
  X,
  RefreshCw,
  ExternalLink,
  Undo2
} from 'lucide-react';
import { toast } from 'sonner';
import { notifyVerificationCreated } from '@/lib/landlordVerificationNotify';
import { formatUGX, calculateRentRepayment } from '@/lib/rentCalculations';
import { hapticSuccess } from '@/lib/haptics';
import { normalizeDistrict, districtWarning } from '@/lib/ugandaDistricts';
import { validateUgandaPhone } from '@/lib/ugandaPhone';
import { generateRentRequestFormPdf } from '@/lib/rentRequestFormPdf';
import { useIsMobile } from '@/hooks/use-mobile';
import { AgentEditRentRequestDialog } from '@/components/agent/AgentEditRentRequestDialog';
import { STAGE_LABEL, type AgentRejectedRequest } from '@/hooks/useAgentRejectedRequests';
import { collectAgentSignupTelemetry } from '@/lib/agentSignupTelemetry';

interface AgentRentRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  prefillTenantName?: string;
  prefillTenantPhone?: string;
  prefillRentAmount?: string;
  /** Full snapshot saved from a previous draft. When provided, the dialog
   *  repopulates form fields on open so the agent can push it through once
   *  their per-tenant tier limit allows it. */
  prefillDraft?: Record<string, any> | null;
  /** Optional id of a saved draft this submission should resolve. On success
   *  the draft is marked `submitted` and linked to the new rent_request. */
  draftId?: string | null;
  /** When provided, the dialog opens with this house already selected (used by
   *  the "Swap tenant" flow after the previous tenant is moved out) so the
   *  agent goes straight to linking the new tenant — no re-search needed. */
  preselectHouse?: {
    id: string;
    title: string;
    address: string | null;
    region: string | null;
    district: string | null;
    house_category: string | null;
    monthly_rent: number | null;
    short_code: string | null;
    latitude: number | null;
    longitude: number | null;
    landlord_id: string | null;
    landlord_name: string | null;
    landlord_phone: string | null;
    tenant_id?: string | null;
    image_urls?: string[] | null;
  } | null;
}

type IncomeType = 'daily' | 'weekly-monthly' | 'outstanding';
type RepaymentPeriod = string;

// Property categories — residential AND business premises (shops, stalls,
// kiosks, salons, offices, stores). No emojis: agents read plain labels.
const HOUSE_CATEGORIES = [
  { value: 'single-room', label: 'Single Room' },
  { value: 'double-room', label: 'Double Room' },
  { value: '1-bed', label: '1 Bed House' },
  { value: '2-bed', label: '2 Bedroom House' },
  { value: '2-bed-full', label: '2 Bed + Sitting Room, Kitchen & 2 Toilets' },
  { value: '3-bed', label: '3 Bedroom Apartment' },
  { value: '3-bed-luxury', label: '3 Bed Luxury + Boys Quarter' },
  { value: '4-bed', label: '4+ Bedroom Villa' },
  { value: 'shop', label: 'Shop / Lock-up Shop' },
  { value: 'market-stall', label: 'Market Stall' },
  { value: 'kiosk', label: 'Kiosk / Container' },
  { value: 'salon-workshop', label: 'Salon / Workshop' },
  { value: 'office', label: 'Office Space' },
  { value: 'warehouse', label: 'Warehouse / Store' },
  { value: 'commercial', label: 'Other Commercial Premises' },
];

const PREFERRED_LANGUAGES = [
  { value: 'English', label: 'English' },
  { value: 'Luganda', label: 'Luganda' },
  { value: 'Runyankole', label: 'Runyankole' },
  { value: 'Lusoga', label: 'Lusoga' },
  { value: 'Acholi', label: 'Acholi' },
  { value: 'Lugbara', label: 'Lugbara' },
  { value: 'Other', label: 'Other' },
];

// ===== FIX #1: Ugandan phone validation =====
const UG_PHONE_REGEX = /^0[3-9][0-9]{8}$/;

const ACTIVE_RENT_STATUSES = [
  'pending','agent_verified','tenant_ops_approved',
  'agent_ops_approved','landlord_ops_approved',
  'coo_approved','funded','repaying',
];
const AGENT_RENT_CAP_UGX = 100_000_000;

// Photo upload constraints
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

function validateImageFile(file: File): string | null {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type.toLowerCase())) {
    return `Invalid file type. Allowed: JPG, PNG, WebP, HEIC.`;
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max: ${MAX_FILE_SIZE_MB} MB.`;
  }
  return null;
}

// Guided wizard steps for the standard (non-outstanding) rent request flow.
const DETAIL_STEPS = ['Rent', 'Tenant', 'Property', 'Officials', 'Review'] as const;

const DETAIL_STEP_META = [
  { label: 'Rent', emoji: '💰', icon: Calculator },
  { label: 'Tenant', emoji: '👤', icon: User },
  { label: 'Property', emoji: '🏠', icon: Home },
  { label: 'Officials', emoji: '🛡️', icon: ShieldCheck },
  { label: 'Review', emoji: '✅', icon: CheckCircle2 },
] as const;

function AgentCapacityBanner({ agentId }: { agentId?: string }) {
  const [exposure, setExposure] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const ids = useMemo(() => (agentId ? [agentId] : []), [agentId]);
  const { data: capMap } = useAgentCapacityMap(ids);
  const cap = agentId ? capMap?.get(agentId) : undefined;

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('rent_requests')
        .select('total_repayment, amount_repaid')
        .eq('agent_id', agentId)
        .in('status', ACTIVE_RENT_STATUSES);
      if (cancelled) return;
      if (error || !data) {
        setExposure(0);
      } else {
        const total = data.reduce((acc, r: any) => {
          const owed = Math.max(
            (Number(r.total_repayment) || 0) - (Number(r.amount_repaid) || 0),
            0,
          );
          return acc + owed;
        }, 0);
        setExposure(Math.round(total));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [agentId]);

  const used = exposure ?? 0;
  const headroom = Math.max(AGENT_RENT_CAP_UGX - used, 0);
  const pct = Math.min(100, Math.round((used / AGENT_RENT_CAP_UGX) * 100));
  const tone =
    pct >= 95 ? 'bg-destructive/10 border-destructive/40 text-destructive'
    : pct >= 75 ? 'bg-warning/10 border-warning/40 text-warning'
    : 'bg-success/10 border-success/30 text-success';

  const threshold = Math.round(DAILY_ELIGIBILITY_THRESHOLD * 100);

  const dailyBanner = (() => {
    if (!cap || cap.daily_status === 'starter') return null;
    // New agents (under the tenant threshold) are NOT regulated by daily
    // performance yet — they post freely up to UGX 2,000,000 per tenant.
    // Show them an onboarding banner instead of the daily-performance rating.
    if (cap.is_new_agent) {
      const remaining = Math.max(NEW_AGENT_TENANT_THRESHOLD - cap.active_tenant_count, 0);
      return (
        <div className="rounded-xl border border-sky-500/40 bg-sky-500/10 p-3 text-sky-700">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-extrabold uppercase tracking-wide">New Agent — Building Your Book</span>
            <DailyRatingThresholdPopover />
          </div>
          <p className="text-[11px] leading-snug opacity-95">
            You can post rent requests up to <strong className="font-mono">{formatUGX(NEW_AGENT_RENT_CAP_UGX)}</strong> per tenant.
            You currently have <strong>{cap.active_tenant_count}</strong> active {cap.active_tenant_count === 1 ? 'tenant' : 'tenants'}.
            {remaining > 0
              ? ` Once you reach ${NEW_AGENT_TENANT_THRESHOLD} active tenants (${remaining} more to go), your posting limit becomes regulated by your daily collection performance.`
              : ''}
          </p>
        </div>
      );
    }
    const rating = cap.daily_rating;
    const ypct = Math.round(cap.yesterday_response_pct * 100);
    const tpct = Math.round(cap.today_response_pct * 100);
    if (rating === 'Very Good') {
      return (
        <div className="rounded-xl border border-emerald-600/50 bg-emerald-600/10 p-3 text-emerald-700">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-extrabold uppercase tracking-wide">Very Good — Allowed Today</span>
            <DailyRatingThresholdPopover />
          </div>
          <p className="text-[11px] leading-snug opacity-95">
            Today you have collected <strong className="font-mono">{formatUGX(cap.paid_today)}</strong> ({tpct}%) of <strong className="font-mono">{formatUGX(cap.expected_daily)}</strong> today&apos;s target. You are well above the {threshold}% law and may post new rent requests. (Yesterday: {ypct}%.)
          </p>
        </div>
      );
    }
    if (rating === 'Good') {
      return (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-emerald-700">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-extrabold uppercase tracking-wide">Good — Allowed Today</span>
            <DailyRatingThresholdPopover />
          </div>
          <p className="text-[11px] leading-snug opacity-95">
            Today you have collected <strong className="font-mono">{formatUGX(cap.paid_today)}</strong> ({tpct}%) of <strong className="font-mono">{formatUGX(cap.expected_daily)}</strong> today&apos;s target. You met the {threshold}% law and may post new rent requests. Keep going to reach Very Good (≥ 50%). (Yesterday: {ypct}%.)
          </p>
        </div>
      );
    }
    if (rating === 'Fair') {
      return (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-amber-700">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-extrabold uppercase tracking-wide">Fair — Blocked from posting today</span>
            <DailyRatingThresholdPopover />
          </div>
          <p className="text-[11px] leading-snug opacity-95">
            Today you have collected <strong className="font-mono">{formatUGX(cap.paid_today)}</strong> ({tpct}%) of <strong className="font-mono">{formatUGX(cap.expected_daily)}</strong> today&apos;s target. You are between 15% and 19%, just below the {threshold}% law. Hit {threshold}% today to be unblocked and rated Good immediately. (Yesterday: {ypct}%.)
          </p>
        </div>
      );
    }
    if (rating === 'Bad') {
      return (
        <div className="rounded-xl border border-orange-500/40 bg-orange-500/10 p-3 text-orange-700">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-extrabold uppercase tracking-wide">Bad — Blocked from posting today</span>
            <DailyRatingThresholdPopover />
          </div>
          <p className="text-[11px] leading-snug opacity-95">
            Today you have collected <strong className="font-mono">{formatUGX(cap.paid_today)}</strong> ({tpct}%) of <strong className="font-mono">{formatUGX(cap.expected_daily)}</strong> today&apos;s target. You are between 5% and 14%, below the {threshold}% law. Hit {threshold}% today to be unblocked and rated Good immediately. (Yesterday: {ypct}%.)
          </p>
        </div>
      );
    }
    // Very Bad
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-destructive">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-extrabold uppercase tracking-wide">Very Bad — Blocked from posting today</span>
          <DailyRatingThresholdPopover />
        </div>
        <p className="text-[11px] leading-snug opacity-95">
          Today you have collected <strong className="font-mono">{formatUGX(cap.paid_today)}</strong> ({tpct}%) of <strong className="font-mono">{formatUGX(cap.expected_daily)}</strong> today&apos;s target. You are below 5%, far below the {threshold}% law. Hit {threshold}% today to be unblocked and rated Good immediately. (Yesterday: {ypct}%.)
        </p>
      </div>
    );
  })();

  return (
    <>
      {dailyBanner}
      {/* "Your Active Rent Exposure" card removed — it confused agents. The
          daily rating banner above is the only capacity signal shown here. */}
    </>
  );
}

function humanizeCapacityError(message: string): string | null {
  const m = (message || '').toLowerCase();
  if (m.includes('100,000,000') || m.includes('exposure cap')) {
    return 'You have reached your UGX 100,000,000 active rent exposure cap. Collect on existing rent requests to free up headroom.';
  }
  if (m.includes('behind on rent') || m.includes('arrears')) {
    return message; // already friendly
  }
  if (m.includes('exceeds your available capacity')) {
    return message;
  }
  return null;
}

function isValidUgPhone(phone: string): boolean {
  return UG_PHONE_REGEX.test(phone.replace(/\s/g, ''));
}

function formatPhoneInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 10);
  if (digits.length <= 4) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 4)} ${digits.slice(4)}`;
  return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
}

/* Inline Call + WhatsApp actions for a landlord phone number. Lets an agent
 * reach the landlord before confirming the selection.
 *
 * The actions are only ENABLED when the number passes the shared Ugandan phone
 * validation (client-side guard). Invalid/missing numbers render a disabled
 * hint instead of a broken tel:/wa.me link. */
export function PhoneContactActions({
  phone,
  className,
}: {
  phone: string | null | undefined;
  className?: string;
}) {
  const { valid, e164, error } = validateUgandaPhone(phone);
  if (!valid || !e164) {
    return (
      <div className={`flex items-center gap-1.5 ${className ?? ''}`}>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5" />
          {error || 'No valid number to call'}
        </span>
      </div>
    );
  }
  return (
    <div className={`flex items-center gap-2 ${className ?? ''}`}>
      <a
        href={`tel:+${e164}`}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors"
        aria-label={`Call ${formatPhoneInput(phone || '')}`}
      >
        <Phone className="h-3.5 w-3.5" />
        Call
      </a>
      <a
        href={`https://wa.me/${e164}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-green-600/40 bg-green-600/10 px-2 py-1.5 text-[11px] font-semibold text-green-700 dark:text-green-400 hover:bg-green-600/20 transition-colors"
        aria-label={`WhatsApp ${formatPhoneInput(phone || '')}`}
      >
        <MessageCircle className="h-3.5 w-3.5" />
        WhatsApp
      </a>
    </div>
  );
}

// ===== FIX #7: Currency display formatting =====
function formatCurrencyInput(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  // Group with thousands separators. Build manually so the result is
  // identical across environments/locales (en-UG can fall back inconsistently).
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* ===== Automatic input formatting =====
 * Helpers that clean and space values AS the agent types so valid formats
 * come out faster on a basic phone keypad. */

/** Keep the National ID state clean (A–Z/0–9, max 14) — no spaces stored. */
function cleanNationalIdInput(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 14);
}
/** Display the National ID in easy-to-read blocks of 4, e.g. CM12 3456 7890 12. */
function formatNationalIdDisplay(clean: string): string {
  return (clean.match(/.{1,4}/g) || []).join(' ');
}
/** Tidy a person's name while typing: no leading space, single spaces,
 *  and each word capitalised (e.g. "  john  mukasa" → "John Mukasa"). */
function formatNameInput(raw: string): string {
  return raw
    .replace(/^\s+/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/* ===== Real-time field validation =====
 * Each validator returns a short, plain-language error string when the value
 * is present but the FORMAT is wrong, or null when it's empty or valid.
 * Empty values return null so we never nag the agent while a field is blank —
 * the "still needed" summary handles required checks at submit time. */
function vName(value: string): string | null {
  const t = value.trim();
  if (!t) return null;
  if (t.length < 2) return 'Too short — write the full name, e.g. John Mukasa';
  if (!/^[A-Za-z][A-Za-z .,'\-]*$/.test(t)) return 'Use letters only, e.g. John Mukasa';
  return null;
}
function vPhone(value: string): string | null {
  const clean = value.replace(/\s/g, '');
  if (!clean) return null;
  if (!/^\d+$/.test(clean)) return 'Use numbers only, e.g. 0783 123 456';
  if (!isValidUgPhone(clean)) return 'Use a Ugandan number like 0783 123 456 (10 digits)';
  return null;
}
function vNationalId(value: string): string | null {
  const t = value.replace(/\s/g, '');
  if (!t) return null;
  if (!/^[A-Za-z0-9]{10,14}$/.test(t)) return 'ID should be 10–14 letters/numbers, e.g. CM12345678901';
  return null;
}
function vAmount(value: string): string | null {
  const digits = value.replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (Number(digits) <= 0) return 'Enter an amount above 0, e.g. 300,000';
  return null;
}
/**
 * Validator for the landlord's ONE-MONTH rent amount (weekly earner flow).
 * Unlike vAmount it is strict: it errors when empty or non-numeric so the
 * weekly repayment can always be computed from a valid UGX figure.
 */
function vRentNeed(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return "Enter the landlord's monthly rent amount";
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (!digits) return 'Use numbers only, e.g. 500,000';
  if (Number(digits) <= 0) return 'Enter an amount above 0, e.g. 500,000';
  return null;
}
function vDays(value: string): string | null {
  const digits = value.replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (Number(digits) <= 0) return 'Enter the number of days, e.g. 30';
  if (Number(digits) > 365) return 'That looks too high — use 365 days or less';
  return null;
}
function vPlace(value: string, example: string): string | null {
  const t = value.trim();
  if (!t) return null;
  if (t.length < 2) return `Write a bit more, e.g. ${example}`;
  return null;
}

/** Small inline error shown under a field while the agent types. */
function FieldError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-start gap-1 text-[11px] font-semibold text-destructive leading-snug">
      <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

/** Prominent banner that always shows the current request state so the agent
 *  never wonders whether their tap did anything on a touch device. */
function RequestStateBanner({ state }: { state: 'idle' | 'submitting' | 'success' | 'error' }) {
  if (state === 'idle') return null;

  const configs = {
    submitting: {
      icon: <Loader2 className="h-5 w-5 animate-spin" />,
      label: 'In-flight',
      body: 'Submitting your request — please wait…',
      classes: 'bg-primary/10 border-primary/30 text-primary',
      iconBg: 'bg-primary/20',
    },
    success: {
      icon: <CheckCircle2 className="h-5 w-5" />,
      label: 'Success',
      body: 'Request posted successfully.',
      classes: 'bg-success/10 border-success/30 text-success',
      iconBg: 'bg-success/20',
    },
    error: {
      icon: <AlertTriangle className="h-5 w-5" />,
      label: 'Failed',
      body: 'Submission failed — see details below.',
      classes: 'bg-destructive/10 border-destructive/30 text-destructive',
      iconBg: 'bg-destructive/20',
    },
  };

  const cfg = configs[state];
  return (
    <div className={`rounded-xl border p-3 flex items-center gap-3 ${cfg.classes}`} role="status" aria-live="polite">
      <div className={`h-10 w-10 rounded-full flex items-center justify-center shrink-0 ${cfg.iconBg}`}>
        {cfg.icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-bold">{cfg.label}</p>
        <p className="text-xs opacity-90 leading-snug">{cfg.body}</p>
      </div>
    </div>
  );
}

function QueuedSubmitBanner({ status }: { status: 'idle' | 'queued' | 'cancelling' | 'ready' }) {
  if (status === 'idle') return null;

  const configs = {
    queued: {
      icon: <Loader2 className="h-5 w-5 animate-spin" />,
      label: 'Submit Queued',
      body: 'Finishing auto-save before firing. Tap the button again to cancel.',
      classes: 'bg-amber-500/10 border-amber-500/30 text-amber-700',
      iconBg: 'bg-amber-500/20',
    },
    cancelling: {
      icon: <X className="h-5 w-5" />,
      label: 'Cancelling',
      body: 'Aborting queued submit…',
      classes: 'bg-muted border-border text-muted-foreground',
      iconBg: 'bg-muted-foreground/20',
    },
    ready: {
      icon: <Loader2 className="h-5 w-5 animate-spin" />,
      label: 'Firing Submit',
      body: 'All clear — submitting your request now.',
      classes: 'bg-primary/10 border-primary/30 text-primary',
      iconBg: 'bg-primary/20',
    },
  };

  const cfg = configs[status];
  return (
    <div className={`rounded-xl border p-3 flex items-center gap-3 ${cfg.classes}`} role="status" aria-live="polite">
      <div className={`h-10 w-10 rounded-full flex items-center justify-center shrink-0 ${cfg.iconBg}`}>
        {cfg.icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-bold">{cfg.label}</p>
        <p className="text-xs opacity-90 leading-snug">{cfg.body}</p>
      </div>
    </div>
  );
}

export default function AgentRentRequestDialog({ open, onOpenChange, onSuccess, prefillTenantName, prefillTenantPhone, prefillRentAmount, prefillDraft, draftId, preselectHouse }: AgentRentRequestDialogProps) {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const capIds = useMemo(() => (user?.id ? [user.id] : []), [user?.id]);
  const { data: capMap, isLoading: capLoading } = useAgentCapacityMap(capIds);
  const myCap = user?.id ? capMap?.get(user.id) : undefined;
  // Weekly Good-Standing unlock: an agent rated "Good" (green) on 2+ days last
  // week may post any new rent request, for any amount — no cap, no daily block.
  const unlimitedPosting = !!myCap?.unlimited_posting;
  const goodDaysLastWeek = myCap?.good_days_last_week ?? 0;
  const perTenantMax = unlimitedPosting
    ? Number.MAX_SAFE_INTEGER
    : (myCap?.per_tenant_max ?? 500_000);
  /**
   * Posting gate at the door: an agent blocked by the Daily Eligibility Law
   * (graduated agent who missed yesterday's collection target) must never see
   * this form at all. We close immediately and explain why with a toast
   * instead of letting them fill in five steps only to be rejected on submit.
   */
  const postingBlockedToday =
    !!myCap && !myCap.is_new_agent && !unlimitedPosting && !myCap.can_post_rent_today;
  useEffect(() => {
    if (!open || capLoading || !postingBlockedToday || !myCap) return;
    const threshold = Math.round(DAILY_ELIGIBILITY_THRESHOLD * 100);
    const ypct = Math.round((myCap.yesterday_response_pct ?? 0) * 100);
    onOpenChange(false);
    toast.error('You cannot post a rent request today', {
      description:
        `Yesterday you collected ${ypct}% of your expected daily rent ` +
        `(UGX ${formatUGX(myCap.paid_yesterday)} of UGX ${formatUGX(myCap.expected_daily)}). ` +
        `Collect at least ${threshold}% today to be unblocked tomorrow.`,
      duration: 9000,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, capLoading, postingBlockedToday]);
  const [savingDraft, setSavingDraft] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  // Synchronous submit lock — blocks duplicate rapid taps on touch devices
  // before React has a chance to re-render and disable the button.
  const submitLockRef = useRef(false);
  // Visible request-state indicator so the agent always knows what's happening
  // after they tap Submit or Try again (idle / submitting / success / error).
  const [requestState, setRequestState] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  // Queued submit: when the agent taps Submit while capacity is still loading
  // or a draft auto-save is mid-flight, we don't block them — we remember the
  // intent and fire the real submit the instant everything settles.
  const [submitQueued, setSubmitQueued] = useState(false);
  const [queueStatus, setQueueStatus] = useState<'idle' | 'queued' | 'cancelling' | 'ready'>('idle');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  // In-dialog preview of the blank field-form PDF before download/share.
  const [fieldFormPreviewOpen, setFieldFormPreviewOpen] = useState(false);
  const [fieldFormPreviewUrl, setFieldFormPreviewUrl] = useState<string | null>(null);
  const [fieldFormBlob, setFieldFormBlob] = useState<Blob | null>(null);
  const [fieldFormGenerating, setFieldFormGenerating] = useState(false);
  // Whether the landlord linked to this request was already verified at submit
  // time. Drives the "Landlord verification pending" status on the success screen.
  const [landlordVerifiedAtSubmit, setLandlordVerifiedAtSubmit] = useState(false);
  // Auto-capture: the moment tenant name + rent amount exist, the request is
  // persisted as a server draft so the agent gets instant confirmation it was
  // captured and can keep filling the rest without fear of losing it.
  const [autoDraftId, setAutoDraftId] = useState<string | null>(null);
  const [autoDraftStatus, setAutoDraftStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // Live network status — used to keep the draft safe and warn the agent
  // before they try to submit on a dropped connection.
  const [isOnline, setIsOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [activationLink, setActivationLink] = useState<string | null>(null);
  const [step, setStep] = useState<'type' | 'details' | 'confirm'>('type');
  // Current sub-step inside the standard flow's guided wizard (0-based).
  const [detailStep, setDetailStep] = useState(0);

  // Persisted open/closed state for the "posting cap" details section so it
  // stays collapsed (or expanded) across page refreshes.
  const POSTING_CAP_DETAILS_KEY = 'welile-posting-cap-details-open';
  const [postingCapOpen, setPostingCapOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(POSTING_CAP_DETAILS_KEY) === '1';
  });
  const handlePostingCapToggle = useCallback((e: React.SyntheticEvent<HTMLDetailsElement>) => {
    const isOpen = e.currentTarget.open;
    setPostingCapOpen(isOpen);
    try {
      window.localStorage.setItem(POSTING_CAP_DETAILS_KEY, isOpen ? '1' : '0');
    } catch {
      /* ignore storage errors */
    }
  }, []);

  // Income type
  const [incomeType, setIncomeType] = useState<IncomeType | null>(null);
  
  // Tenant info (for non-account holders)
  // Captured in parts; every downstream read/write still uses the single
  // concatenated `tenantName` string.
  const [tenantNameParts, setTenantNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const tenantName = joinPersonName(tenantNameParts);
  const setTenantName = (next: string) => setTenantNameParts(splitPersonName(next));
  const [tenantPhone, setTenantPhone] = useState('');
  const [tenantNationalId, setTenantNationalId] = useState('');
  const [preferredLanguage, setPreferredLanguage] = useState<string>('');
  
  // Live fraud guard: detect whether the tenant name, phone or national ID the
  // agent is typing is already registered on the platform, and reveal the owner
  // so the agent cannot create a duplicate.
  const {
    nameMatch: existingTenantByName,
    phoneMatch: existingTenantByPhone,
    nationalIdMatch: existingTenantByNationalId,
    checkingName: checkingTenantName,
    checkingPhone: checkingTenantPhone,
    checkingNationalId: checkingTenantNationalId,
  } = useTenantDuplicateCheck(tenantName, tenantPhone, tenantNationalId);


  // Rent details
  const [rentAmount, setRentAmount] = useState('');
  const [outstandingBalance, setOutstandingBalance] = useState('');
  const [duration, setDuration] = useState<'30' | '60' | '90'>('30');
  const [repaymentPeriod, setRepaymentPeriod] = useState<RepaymentPeriod>('7');
  // Sub-cycle for the weekly-monthly income type so agents can pick "Weekly"
  // or "Monthly" as separate options on the type-selection page.
  const [earnerCycle, setEarnerCycle] = useState<'weekly' | 'monthly'>('weekly');
  
  // Landlord info
  const [landlordName, setLandlordName] = useState('');
  const [landlordPhone, setLandlordPhone] = useState('');
  const [propertyAddress, setPropertyAddress] = useState('');
  const [ugLocation, setUgLocation] = useState<UgLocationSelection | null>(null);
  const applyUgLocation = (location: UgLocationSelection | null) => {
    setUgLocation(location);
    if (!location) {
      setPropertyAddress('');
      return;
    }
    setPropertyAddress(location.village);
    setPropertyCity(location.subcounty || location.county);
    setPropertyDistrict(normalizeDistrict(location.district) || location.district);
    setLc1Village((current) => current || location.village);
  };
  
  // LC1 info
  const [lc1NameParts, setLc1NameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const lc1Name = joinPersonName(lc1NameParts);
  const setLc1Name = (next: string) => setLc1NameParts(splitPersonName(next));
  const [lc1Phone, setLc1Phone] = useState('');
  const [lc1Village, setLc1Village] = useState('');
  // LC letter — one image (JPG/PNG/JPEG, max 10 MB) stored in the private
  // `lc-letters` bucket and referenced on the rent request.
  const [lcLetter, setLcLetter] = useState<{ file: File; preview: string } | null>(null);
  // Town/City + District for the property location. City is required so the
  // tenant rolls up under a real location in ops dashboards instead of
  // landing in the "needs verification" bucket.
  const [propertyCity, setPropertyCity] = useState('');
  const [propertyDistrict, setPropertyDistrict] = useState('');
  /** Official ug_districts unit behind propertyDistrict (dataset-backed capture). */
  const [propertyDistrictUnit, setPropertyDistrictUnit] = useState<UgDistrictValue | null>(null);
  const [houseCategory, setHouseCategory] = useState('');
  const [landlordPayoutDay, setLandlordPayoutDay] = useState<string>('1');
  const [noSmartphone, setNoSmartphone] = useState(false);
  const [gpsLocation, setGpsLocation] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [housePhotos, setHousePhotos] = useState<{ file: File; preview: string }[]>([]);
  const [tenantPhoto, setTenantPhoto] = useState<{ file: File; preview: string } | null>(null);
  // Renewal document custody: what the tenant already has on file (null until
  // a renewal is started or the lookup finishes).
  const [renewDocs, setRenewDocs] = useState<{ passport: boolean; lcLetter: boolean; houseImages: number } | null>(null);
  const [renewDocsLoading, setRenewDocsLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState<string>('');

  // ===== House-search-first (standard flow) =====
  // The agent first searches for an available empty house (by landlord name,
  // region, or any house description) and selects it. Picking a house auto-fills
  // the landlord + property details so they never re-key them. If nothing
  // matches they can list a new house inline — it becomes available instantly
  // (no verification needed) and they can then link the tenant to it.
  type AvailableHouse = {
    id: string;
    title: string;
    address: string | null;
    region: string | null;
    district: string | null;
    house_category: string | null;
    monthly_rent: number | null;
    short_code: string | null;
    latitude: number | null;
    longitude: number | null;
    landlord_id: string | null;
    landlord_name: string | null;
    landlord_phone: string | null;
    tenant_id?: string | null;
    image_urls?: string[] | null;
  };
  const [houseQuery, setHouseQuery] = useState('');
  const [houseResults, setHouseResults] = useState<AvailableHouse[]>([]);
  const [houseSearching, setHouseSearching] = useState(false);
  const [houseSearchedOnce, setHouseSearchedOnce] = useState(false);
  const [selectedHouse, setSelectedHouse] = useState<AvailableHouse | null>(null);
  // Landlord profile peek from a picker result (does not select the house).
  const [landlordProfile, setLandlordProfile] = useState<AvailableHouse | null>(null);
  const [showListHouse, setShowListHouse] = useState(false);
  const guardListingHours = useListingDaytimeGuard();
  // Live conflict check: true when the selected house has been reserved /
  // occupied / hidden by another agent since it was picked.
  const [houseConflict, setHouseConflict] = useState(false);
  const [houseConflictChecking, setHouseConflictChecking] = useState(false);

  // Map a house_listings category (underscored) to this form's category values.
  const mapHouseCategory = (cat: string | null): string => {
    switch ((cat || '').toLowerCase()) {
      case 'single_room':
      case 'studio':
      case 'bedsitter':
        return 'single-room';
      case 'double_room':
        return 'double-room';
      case 'one_bedroom':
        return '1-bed';
      case 'two_bedroom':
        return '2-bed';
      case 'three_bedroom':
        return '3-bed';
      case 'shop':
      case 'commercial':
        return 'commercial';
      default:
        return '';
    }
  };

  const HOUSE_SELECT =
    'id, title, address, region, district, house_category, monthly_rent, short_code, latitude, longitude, landlord_id, tenant_id, image_urls';

  const searchAvailableHouses = useCallback(async () => {
    const q = houseQuery.trim();
    setHouseSearching(true);
    setHouseSearchedOnce(true);
    try {
      let base = supabase
        .from('house_listings')
        .select(HOUSE_SELECT)
        .eq('status', 'available')
        .is('tenant_id', null)
        .is('reserved_at', null)
        .eq('is_hidden', false)
        .order('created_at', { ascending: false })
        .limit(50);
      if (q.length >= 2) {
        base = base.or(
          `title.ilike.%${q}%,address.ilike.%${q}%,region.ilike.%${q}%,description.ilike.%${q}%,short_code.ilike.%${q}%`,
        );
      }
      const { data, error } = await base;
      if (error) throw error;
      let rows = (data || []) as any[];

      // Also match by landlord name / phone (separate lookup, merged + de-duped).
      if (q.length >= 2) {
        const { data: lls } = await supabase.rpc('search_landlords_fuzzy', {
          p_query: q,
          p_limit: 30,
          p_threshold: 0.15,
        });
        const llIds = (lls || []).map((l: any) => l.id);
        if (llIds.length) {
          const { data: byLl } = await supabase
            .from('house_listings')
            .select(HOUSE_SELECT)
            .eq('status', 'available')
            .is('tenant_id', null)
            .is('reserved_at', null)
            .eq('is_hidden', false)
            .in('landlord_id', llIds)
            .limit(50);
          rows = [...rows, ...((byLl || []) as any[])];
        }
      }

      const seen = new Set<string>();
      const unique: any[] = [];
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        // A house with no photos can never be used for a rent request — the
        // landlord's property must be visually verifiable. Drop them from the
        // picker so agents can't select a photoless listing.
        if (!listingHasRealPhoto(r)) continue;
        unique.push(r);
      }

      // Resolve landlord names/phones in one batch (no FK relationship to embed).
      const landlordIds = Array.from(
        new Set(unique.map((r) => r.landlord_id).filter(Boolean)),
      );
      const llMap: Record<string, { name: string | null; phone: string | null }> = {};
      if (landlordIds.length) {
        const { data: llRows } = await supabase
          .from('landlords')
          .select('id, name, phone')
          .in('id', landlordIds);
        for (const l of llRows || []) {
          llMap[(l as any).id] = { name: (l as any).name ?? null, phone: (l as any).phone ?? null };
        }
      }

      const mapped: AvailableHouse[] = unique.map((r) => ({
        id: r.id,
        title: r.title,
        address: r.address,
        region: r.region,
        district: r.district,
        house_category: r.house_category,
        monthly_rent: r.monthly_rent,
        short_code: r.short_code,
        latitude: r.latitude,
        longitude: r.longitude,
        landlord_id: r.landlord_id,
        landlord_name: r.landlord_id ? llMap[r.landlord_id]?.name ?? null : null,
        landlord_phone: r.landlord_id ? llMap[r.landlord_id]?.phone ?? null : null,
        tenant_id: r.tenant_id ?? null,
        image_urls: Array.isArray(r.image_urls) ? r.image_urls : [],
      }));
      setHouseResults(mapped);
    } catch (e) {
      console.error('[AgentRentRequestDialog] house search failed', e);
      toast.error('Could not search houses');
    } finally {
      setHouseSearching(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [houseQuery]);

  const selectHouse = useCallback(
    (h: AvailableHouse) => {
      setSelectedHouse(h);
      setHouseConflict(false);
      if (h.monthly_rent) setRentAmount(String(h.monthly_rent));
      if (h.landlord_name) setLandlordName(h.landlord_name);
      if (h.landlord_phone) setLandlordPhone(formatPhoneInput(h.landlord_phone));
      if (h.address) setPropertyAddress(h.address);
      if (h.district) setPropertyDistrict(normalizeDistrict(h.district));
      if (h.region) setPropertyCity((c) => c || h.region || '');
      const mappedCat = mapHouseCategory(h.house_category);
      if (mappedCat) setHouseCategory(mappedCat);
      if (h.latitude != null && h.longitude != null) {
        setGpsLocation({ lat: Number(h.latitude), lng: Number(h.longitude), accuracy: 0 });
      }
      const locParts = [h.address, h.region, h.district].filter(Boolean).join(', ');
      toast.success(`Selected: ${h.title || 'House'}`, {
        description: [
          locParts ? `📍 ${locParts}` : null,
          h.landlord_name ? `👤 ${h.landlord_name}${h.landlord_phone ? ` · ${formatPhoneInput(h.landlord_phone)}` : ''}` : null,
          h.monthly_rent ? `💰 ${formatUGX(h.monthly_rent)}/mo` : null,
        ].filter(Boolean).join('\n'),
        action: {
          label: 'Undo',
          onClick: () => undoSelectHouse(),
        },
      });
    },
    [],
  );

  const clearSelectedHouse = useCallback(() => {
    setSelectedHouse(null);
    setHouseConflict(false);
  }, []);

  // Quick revert: fully clear the current selection (house + every field that
  // selectHouse auto-filled) and re-open the picker, re-running the previous
  // search so the agent can immediately pick a different house. This keeps all
  // related inline details in sync — no stale landlord/rent/location lingers.
  const undoSelectHouse = useCallback(() => {
    const { snapshot, rerunSearch } = computeUndoSelection({ houseQuery });
    setSelectedHouse(snapshot.selectedHouse as AvailableHouse | null);
    setHouseConflict(snapshot.houseConflict);
    // Reset every field populated by selectHouse so nothing carries over.
    setSelectedLandlord(snapshot.selectedLandlord as LandlordOption | null);
    setRentAmount(snapshot.fields.rentAmount);
    setLandlordName(snapshot.fields.landlordName);
    setLandlordPhone(snapshot.fields.landlordPhone);
    setPropertyAddress(snapshot.fields.propertyAddress);
    setPropertyDistrict(snapshot.fields.propertyDistrict);
    setPropertyCity(snapshot.fields.propertyCity);
    setHouseCategory(snapshot.fields.houseCategory);
    setGpsLocation(snapshot.fields.gpsLocation);
    toast.info('Selection undone — pick another house');
    // Preserve and re-run the previous picker search query.
    if (rerunSearch) {
      searchAvailableHouses();
    }
  }, [houseQuery, searchAvailableHouses]);

  // "Swap tenant" entry point: when the dialog is opened with a preselected
  // house (the one just vacated), select it automatically so the agent skips
  // the search and goes straight to entering the new tenant's details.
  const preselectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      preselectedRef.current = null;
      return;
    }
    if (!preselectHouse) return;
    if (preselectedRef.current === preselectHouse.id) return;
    preselectedRef.current = preselectHouse.id;
    selectHouse(preselectHouse);
    setHouseSearchedOnce(true);
  }, [open, preselectHouse, selectHouse]);

  // Auto-load available houses the first time the agent reaches the details
  // step in the standard flow, so the picker is ready immediately.
  useEffect(() => {
    if (open && step === 'details' && incomeType !== 'outstanding' && !houseSearchedOnce) {
      searchAvailableHouses();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, incomeType, houseSearchedOnce]);

  // ── Live conflict check ──────────────────────────────────────────────
  // While a house is selected, re-verify in the background that it's still
  // available (single-row lookup, cheap). If another agent reserved/occupied/
  // hid it in the meantime, flip on an inline warning so the agent can pick a
  // different one before submitting. Polls every 15s + re-checks on tab focus.
  useEffect(() => {
    const houseId = selectedHouse?.id;
    if (!open || !houseId || incomeType === 'outstanding') return;

    let cancelled = false;
    const check = async () => {
      setHouseConflictChecking(true);
      try {
        const { data, error } = await supabase
          .from('house_listings')
          .select('id, status, tenant_id, reserved_at, is_hidden')
          .eq('id', houseId)
          .maybeSingle();
        if (cancelled || error) return;
        const taken =
          !data ||
          (data as any).tenant_id !== null ||
          (data as any).reserved_at !== null ||
          (data as any).is_hidden === true ||
          (data as any).status !== 'available';
        setHouseConflict(taken);
      } catch {
        /* best-effort — never block the form */
      } finally {
        if (!cancelled) setHouseConflictChecking(false);
      }
    };

    check();
    const intervalId = window.setInterval(check, 15000);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedHouse?.id, incomeType]);
  
  // Existing tenants this agent has already registered — used for the
  // one-tap auto-fill so agents don't re-key phone/National ID/photo.
  const [existingTenants, setExistingTenants] = useState<{ id: string; full_name: string | null; phone: string | null; national_id: string | null; avatar_url: string | null }[]>([]);
  const [loadingTenants, setLoadingTenants] = useState(false);
  const [autofillingTenant, setAutofillingTenant] = useState(false);
  const [guarantorConsent, setGuarantorConsent] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  // When the DB guard blocks a duplicate because the tenant already has an open
  // rejection, we route the agent straight into the resubmit dialog for that row.
  const [resubmitTarget, setResubmitTarget] = useState<AgentRejectedRequest | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  // Ref to the "things still needed" banner so we can scroll the agent
  // straight to it — ordinary agents on small phones often miss a toast.
  const errorSummaryRef = useRef<HTMLDivElement>(null);

  // Touch-device feedback: whenever a submission error appears (including ones
  // raised asynchronously inside handleSubmit's catch block), pull the agent's
  // view straight to the message. On small phones the button sits at the very
  // bottom, so an error rendered above it can land off-screen and feel like
  // "nothing happened". This guarantees the agent always sees the reason.
  useEffect(() => {
    if (!submissionError) return;
    requestAnimationFrame(() => {
      errorSummaryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [submissionError]);

  // FIX #9: house category for outstanding flow
  const [outstandingHouseCategory, setOutstandingHouseCategory] = useState('');

  // ===== Outstanding flow (refactor): selected landlord + extra rent fields =====
  const [selectedLandlord, setSelectedLandlord] = useState<LandlordOption | null>(null);
  const [outstandingRentAmount, setOutstandingRentAmount] = useState('');
  const [outstandingDaysRemaining, setOutstandingDaysRemaining] = useState('');
  const [showRegisterLandlord, setShowRegisterLandlord] = useState(false);
  const [landlordPickerKey, setLandlordPickerKey] = useState(0);
  const [landlordSearchOpenSignal, setLandlordSearchOpenSignal] = useState(0);
  const [showLinkedBanner, setShowLinkedBanner] = useState(false);
  const linkedBannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmClearLandlord, setConfirmClearLandlord] = useState(false);
  const [confirmCloseDialog, setConfirmCloseDialog] = useState(false);
  // Live landlord registration check. Re-runs every time the landlord
  // selection changes (search pick, house pick, or Register flow) so the agent
  // gets immediate feedback — and is blocked from submitting — if the chosen
  // landlord is not (or no longer) registered in the system. A transient
  // lookup failure falls back to 'idle' so the stricter submit-time check still
  // runs rather than blocking the agent on a flaky connection.
  const [landlordCheck, setLandlordCheck] = useState<'idle' | 'checking' | 'registered' | 'unverified' | 'missing'>('idle');
  // Agent-initiated request asking Landlord Ops to verify an unverified landlord.
  const [verifyReqState, setVerifyReqState] = useState<'idle' | 'sending' | 'sent' | 'exists'>('idle');
  // Live LC1 chairperson verification — keyed on the typed LC1 phone. A rent
  // request can only be posted when the LC1 is both registered AND verified.
  const [lc1Check, setLc1Check] = useState<'idle' | 'checking' | 'verified' | 'unverified' | 'missing'>('idle');
  // Resolved LC1 chairperson id (from the live phone lookup) + the agent's
  // request asking Landlord Ops to verify an unverified LC1 chairperson.
  const [lc1Id, setLc1Id] = useState<string | null>(null);
  const [lc1VerifyReqState, setLc1VerifyReqState] = useState<'idle' | 'sending' | 'sent' | 'exists'>('idle');
  // ===== LC1 chairperson search-first picker =====
  // The agent searches for an LC1 already in the system (by name or phone). If
  // none matches they switch to "register" mode and type the details manually.
  type Lc1Hit = { id: string; name: string; phone: string; village: string | null; district: string | null; region: string | null; verified: boolean };
  const [lc1Mode, setLc1Mode] = useState<'search' | 'register'>('search');
  const [lc1Selected, setLc1Selected] = useState(false);
  const [lc1Query, setLc1Query] = useState('');
  const [lc1Results, setLc1Results] = useState<Lc1Hit[]>([]);
  const [lc1Searching, setLc1Searching] = useState(false);
  const [lc1SearchedOnce, setLc1SearchedOnce] = useState(false);
  // Official village unit behind the LC1's village (dataset-backed capture),
  // used to stamp the full administrative chain when registering a new LC1.
  const [lc1LocationUnit, setLc1LocationUnit] = useState<UgLocationSelection | null>(null);
  // Village-driven auto-match: the LC1 already registered for the tenant's
  // village is preselected so the agent never searches. Set to true only when
  // the preselection came from the automatic lookup (not a manual pick).
  const [lc1AutoMatched, setLc1AutoMatched] = useState(false);
  // Village the agent explicitly opted out of auto-matching for (they tapped
  // "Change" or chose to register a new LC1) — never re-apply for that village.
  const lc1AutoOptOutRef = useRef<string | null>(null);
  const searchLc1 = useCallback(async () => {
    const q = lc1Query.trim();
    if (q.length < 2) {
      toast.error('Type at least 2 letters of the LC1 name or a phone number');
      return;
    }
    setLc1Searching(true);
    setLc1SearchedOnce(true);
    try {
      const isPhone = /^[0-9+]/.test(q);
      let builder = supabase
        .from('lc1_chairpersons')
        .select('id, name, phone, village, district, region, verified')
        .order('verified', { ascending: false })
        .limit(10);
      builder = isPhone ? builder.ilike('phone', `%${q}%`) : builder.ilike('name', `%${q}%`);
      const { data, error } = await builder;
      if (error) throw error;
      setLc1Results((data || []) as Lc1Hit[]);
    } catch (err) {
      console.error('[AgentRentRequestDialog] LC1 search failed:', err);
      toast.error('Could not search LC1 chairpersons');
    } finally {
      setLc1Searching(false);
    }
  }, [lc1Query]);
  const selectLc1Hit = useCallback((hit: Lc1Hit) => {
    setLc1Name(hit.name);
    setLc1Phone(hit.phone);
    if (hit.village) setLc1Village(hit.village);
    setLc1Selected(true);
    setLc1Results([]);
    setLc1AutoMatched(false);
  }, []);
  const clearLc1Selection = useCallback(() => {
    setLc1Selected(false);
    setLc1Name('');
    setLc1Phone('');
    setLc1Village('');
    setLc1Mode('search');
    setLc1SearchedOnce(false);
    setLc1Results([]);
    setLc1AutoMatched(false);
    setLc1LocationUnit(null);
    // The agent is choosing the LC1 themselves for this village — stop the
    // village lookup from re-applying its match on top of their choice.
    lc1AutoOptOutRef.current = autoLc1VillageKeyRef.current;
  }, []);
  const startRegisterLc1 = useCallback(() => {
    // Carry a typed name (not a phone) into the manual form for convenience.
    const q = lc1Query.trim();
    if (q && !/^[0-9+]/.test(q)) setLc1Name(formatNameInput(q));
    setLc1Mode('register');
    setLc1Selected(false);
    setLc1AutoMatched(false);
    lc1AutoOptOutRef.current = autoLc1VillageKeyRef.current;
  }, [lc1Query]);

  // ===== Village → LC1 chairperson auto-identification =====
  // As soon as the agent has captured the tenant's official village (and GPS)
  // in the property step, look up the LC1 chairperson already registered for
  // that village and preselect them when the LC1 step is reached. When no LC1
  // exists for the village the flow drops straight into "register a new LC1"
  // with the village + administrative chain inherited from what was entered.
  const autoLc1VillageKey = ugLocation ? `${ugLocation.villageId}:${ugLocation.village}` : null;
  const autoLc1VillageKeyRef = useRef<string | null>(null);
  autoLc1VillageKeyRef.current = autoLc1VillageKey;
  const lc1Auto = useLc1ForVillage({
    villageId: ugLocation?.villageId ?? null,
    villageName: ugLocation?.village ?? null,
    districtName: ugLocation?.district ?? null,
    enabled: Boolean(ugLocation),
  });
  const lc1AutoBestId = lc1Auto.best?.id ?? null;
  useEffect(() => {
    if (!ugLocation || !autoLc1VillageKey) return;
    if (lc1AutoOptOutRef.current === autoLc1VillageKey) return;
    if (lc1Auto.isLoading) return;
    const best = lc1Auto.best;
    if (best) {
      // Never overwrite an LC1 the agent picked or typed themselves.
      if (lc1Selected && !lc1AutoMatched) return;
      if (!lc1Selected && (lc1Name.trim() || lc1Phone.trim())) return;
      setLc1NameParts(splitPersonName(best.name));
      setLc1Phone(formatPhoneInput(best.phone || ''));
      setLc1Village(best.village || ugLocation.village);
      setLc1LocationUnit(ugLocation);
      setLc1Mode('search');
      setLc1Results([]);
      setLc1Selected(true);
      setLc1AutoMatched(true);
      return;
    }
    if (!lc1Auto.isEmpty) return;
    // No LC1 on file for this village — open the register form with the
    // location already inherited from the rent request.
    if (lc1Selected || lc1Name.trim() || lc1Phone.trim()) return;
    setLc1Mode('register');
    setLc1Village((current) => current || ugLocation.village);
    setLc1LocationUnit((current) => current || ugLocation);
    setLc1AutoMatched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLc1VillageKey, lc1AutoBestId, lc1Auto.isLoading, lc1Auto.isEmpty]);
  const LL_MODE_KEY = `welile:rentReq:landlordMode:${user?.id || 'anon'}`;
  const [landlordMode, setLandlordModeState] = useState<'search' | 'register'>(() => {
    try { return (sessionStorage.getItem(LL_MODE_KEY) as 'search' | 'register') || 'search'; }
    catch { return 'search'; }
  });
  const landlordNameInputRef = useRef<HTMLInputElement>(null);
  const registerBtnRef = useRef<HTMLButtonElement>(null);
  const landlordSectionRef = useRef<HTMLDivElement>(null);
  const lc1SectionRef = useRef<HTMLDivElement>(null);
  const setLandlordMode = useCallback((mode: 'search' | 'register') => {
    setLandlordModeState(mode);
    try { sessionStorage.setItem(LL_MODE_KEY, mode); } catch { /* ignore */ }
    if (mode === 'search') setLandlordSearchOpenSignal((n) => n + 1);
    // Focus the first input/button so the agent can start typing immediately.
    requestAnimationFrame(() => {
      if (mode === 'search') {
        landlordNameInputRef.current?.focus();
      } else {
        registerBtnRef.current?.focus();
      }
    });
  }, [LL_MODE_KEY]);

  const clearLandlordSearch = useCallback(() => {
    setLandlordName('');
    setLandlordPhone('');
    setSelectedLandlord(null);
    setShowLinkedBanner(false);
    requestAnimationFrame(() => {
      landlordNameInputRef.current?.focus();
    });
  }, []);

  // One-tap auto-fill: when the agent picks a matched landlord from the
  // autocomplete dropdown, pull every saved detail we have on file into the
  // rent request form so they never re-key the address, location, or house
  // type — and we re-use the existing landlord record instead of duplicating.
  const applySelectedLandlord = useCallback((l: LandlordOption) => {
    setLandlordName(l.name || '');
    setLandlordPhone(formatPhoneInput(l.phone || ''));
    if (l.property_address) setPropertyAddress(l.property_address);
    if (l.district) setPropertyDistrict(normalizeDistrict(l.district));
    // Prefer the most specific saved locality for the town/city field.
    const savedCity = l.town_council || l.county || l.village || '';
    if (savedCity) setPropertyCity(savedCity);
    if (l.village) setLc1Village(l.village);
    if (l.house_category) {
      const normalized = l.house_category.replace(/_/g, '-');
      if (HOUSE_CATEGORIES.some((c) => c.value === normalized)) {
        setHouseCategory(normalized);
      }
    }
    if (l.latitude != null && l.longitude != null) {
      setGpsLocation({ lat: Number(l.latitude), lng: Number(l.longitude), accuracy: 0 });
    }
    setSelectedLandlord(l);
    setShowLinkedBanner(true);
    if (linkedBannerTimer.current) clearTimeout(linkedBannerTimer.current);
    linkedBannerTimer.current = setTimeout(() => setShowLinkedBanner(false), 6000);
    toast.success(`Linked landlord ${l.name}`, {
      description: 'Saved address and details filled in automatically.',
    });
  }, []);

  // ===== Live landlord registration verification =====
  // Whenever the resolved landlord (search selection or the landlord attached
  // to a picked house) changes, confirm it really exists in the `landlords`
  // table before the agent is allowed to submit.
  useEffect(() => {
    const landlordId = selectedLandlord?.id ?? selectedHouse?.landlord_id ?? null;
    if (!landlordId) {
      setLandlordCheck('idle');
      return;
    }
    let cancelled = false;
    setLandlordCheck('checking');
    (async () => {
      try {
        // Use a SECURITY DEFINER RPC so we don't get blocked by the
        // `landlords` RLS "agent must already be linked" rule — a brand-new
        // link (this very rent request) is exactly what we're about to create.
        const { data, error } = await (supabase.rpc as any)(
          'get_landlord_verification_status',
          { p_id: landlordId },
        );
        if (cancelled) return;
        if (error) {
          setLandlordCheck('idle');
          return;
        }
        const row = Array.isArray(data) ? data[0] : data;
        if (!row || row.exists_flag === false) {
          setLandlordCheck('missing');
        } else {
          setLandlordCheck(row.verified ? 'registered' : 'unverified');
        }
      } catch {
        if (!cancelled) setLandlordCheck('idle');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedLandlord?.id, selectedHouse?.landlord_id]);

  // Reset the "request verification" state whenever the resolved landlord changes.
  useEffect(() => {
    setVerifyReqState('idle');
  }, [selectedLandlord?.id, selectedHouse?.landlord_id]);

  // ===== Agent requests Landlord Ops to verify an unverified landlord =====
  // Sends a very-visible request to the Landlord Operations dashboard with the
  // landlord's name and the requesting agent, so Ops can verify or reject it.
  const requestLandlordVerification = useCallback(async () => {
    const landlordId = selectedLandlord?.id ?? selectedHouse?.landlord_id ?? null;
    if (!landlordId || !user) return;
    setVerifyReqState('sending');
    const llName = selectedLandlord?.name ?? landlordName ?? null;
    const llPhone = (landlordPhone || selectedLandlord?.phone || selectedHouse?.landlord_phone || '').toString().trim() || null;
    const agentName =
      (user?.user_metadata as any)?.full_name ||
      (user?.user_metadata as any)?.name ||
      'Agent';
    const agentPhone = (user?.user_metadata as any)?.phone || user?.phone || null;
    try {
      const { data: inserted, error } = await supabase
        .from('landlord_verification_requests')
        .insert({
          landlord_id: landlordId,
          landlord_name: llName,
          landlord_phone: llPhone,
          requested_by: user.id,
          agent_name: agentName,
          agent_phone: agentPhone,
          status: 'pending',
        })
        .select('id')
        .single();
      if (error) {
        // A pending request already exists for this landlord (unique index).
        if ((error as any).code === '23505') {
          setVerifyReqState('exists');
          toast.info('Verification already requested', {
            description: 'Landlord Operations already has a pending request for this landlord.',
          });
          return;
        }
        throw error;
      }
      setVerifyReqState('sent');
      toast.success('Verification request sent', {
        description: `Landlord Operations will review ${llName || 'this landlord'} shortly.`,
      });
      // Fire-and-forget in-app notifications to the agent (and landlord if they
      // have an account). Never block the main flow on this.
      void notifyVerificationCreated({
        agentId: user.id,
        agentName,
        landlordId,
        landlordName: llName,
        landlordPhone: llPhone,
        requestId: inserted?.id ?? null,
      });
    } catch (err: any) {
      setVerifyReqState('idle');
      toast.error('Could not send request', {
        description: err?.message || 'Please try again.',
      });
    }
  }, [selectedLandlord?.id, selectedLandlord?.name, selectedLandlord?.phone, selectedHouse?.landlord_id, selectedHouse?.landlord_phone, landlordName, landlordPhone, user]);


  // ===== Live LC1 chairperson verification =====
  // The typed LC1 phone is looked up in `lc1_chairpersons`. This is informational
  // only — posting is NOT blocked by LC1 status. A registered/free-typed LC1 can
  // be posted; it must be VERIFIED before the request is approved.
  useEffect(() => {
    const cleanLc1Phone = lc1Phone.replace(/\s/g, '');
    if (!cleanLc1Phone || !isValidUgPhone(cleanLc1Phone)) {
      setLc1Check('idle');
      setLc1Id(null);
      return;
    }
    let cancelled = false;
    setLc1Check('checking');
    (async () => {
      try {
        // A phone can have duplicate LC1 rows. Fetch all matches and prefer a
        // verified record so duplicates never falsely block a verified LC1.
        const { data, error } = await supabase
          .from('lc1_chairpersons')
          .select('id, verified')
          .eq('phone', cleanLc1Phone)
          .order('verified', { ascending: false, nullsFirst: false });
        if (cancelled) return;
        if (error) {
          // Transient lookup failure — don't hard-block; submit-time re-checks.
          setLc1Check('idle');
          return;
        }
        const match = (data ?? [])[0] ?? null;
        setLc1Check(!match ? 'missing' : match.verified ? 'verified' : 'unverified');
        setLc1Id(match?.id ?? null);
      } catch {
        if (!cancelled) setLc1Check('idle');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lc1Phone]);

  // Reset the LC1 "request verification" state whenever the typed LC1 changes.
  useEffect(() => {
    setLc1VerifyReqState('idle');
  }, [lc1Id]);

  // ===== Agent requests Landlord Ops to verify an unverified LC1 chairperson =====
  const requestLc1Verification = useCallback(async () => {
    if (!lc1Id || !user) return;
    setLc1VerifyReqState('sending');
    const agentName =
      (user?.user_metadata as any)?.full_name ||
      (user?.user_metadata as any)?.name ||
      'Agent';
    const agentPhone = (user?.user_metadata as any)?.phone || user?.phone || null;
    try {
      const { error } = await supabase
        .from('lc1_verification_requests')
        .insert({
          lc1_id: lc1Id,
          lc1_name: lc1Name || null,
          lc1_phone: lc1Phone.replace(/\s/g, '') || null,
          lc1_village: lc1Village || null,
          requested_by: user.id,
          agent_name: agentName,
          agent_phone: agentPhone,
          status: 'pending',
        });
      if (error) {
        // A pending request already exists for this LC1 (unique index).
        if ((error as any).code === '23505') {
          setLc1VerifyReqState('exists');
          toast.info('Verification already requested', {
            description: 'Landlord Operations already has a pending request for this LC1 chairperson.',
          });
          return;
        }
        throw error;
      }
      setLc1VerifyReqState('sent');
      toast.success('Verification request sent', {
        description: `Landlord Operations will review ${lc1Name || 'this LC1 chairperson'} shortly.`,
      });
    } catch (err: any) {
      setLc1VerifyReqState('idle');
      toast.error('Could not send request', {
        description: err?.message || 'Please try again.',
      });
    }
  }, [lc1Id, lc1Name, lc1Phone, lc1Village, user]);

  // Pre-fill fields when dialog opens with prefill props
  useEffect(() => {
    if (open) {
      if (prefillTenantName) setTenantName(prefillTenantName);
      if (prefillTenantPhone) setTenantPhone(prefillTenantPhone);
      if (prefillRentAmount) setRentAmount(prefillRentAmount);
    }
  }, [open, prefillTenantName, prefillTenantPhone, prefillRentAmount]);

  // Load the agent's existing tenants once the dialog opens so they can be
  // auto-filled with a single tap (phone, National ID and passport photo).
  useEffect(() => {
    if (!open || !user?.id) return;
    let cancelled = false;
    (async () => {
      setLoadingTenants(true);
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone, national_id, avatar_url')
        .or(`referrer_id.eq.${user.id},managing_agent_id.eq.${user.id}`)
        .order('full_name', { ascending: true })
        .limit(500);
      if (cancelled) return;
      if (!error && data) {
        // De-dupe by id and keep only tenants with at least a name.
        const seen = new Set<string>();
        const list = data.filter((t) => {
          if (!t.full_name || seen.has(t.id)) return false;
          seen.add(t.id);
          return true;
        });
        setExistingTenants(list);
      }
      setLoadingTenants(false);
    })();
    return () => { cancelled = true; };
  }, [open, user?.id]);

  // Hydrate from a previously-saved draft snapshot (full form state).
  useEffect(() => {
    if (!open || !prefillDraft) return;
    const p = prefillDraft;
    if (p.incomeType) setIncomeType(p.incomeType);
    if (p.tenantName) setTenantName(p.tenantName);
    if (p.tenantPhone) setTenantPhone(p.tenantPhone);
    if (p.tenantNationalId) setTenantNationalId(p.tenantNationalId);
    if (p.preferredLanguage) setPreferredLanguage(p.preferredLanguage);
    if (p.rentAmount) setRentAmount(p.rentAmount);
    if (p.outstandingBalance) setOutstandingBalance(p.outstandingBalance);
    if (p.duration) setDuration(p.duration);
    if (p.repaymentPeriod) setRepaymentPeriod(p.repaymentPeriod);
    if (p.earnerCycle) setEarnerCycle(p.earnerCycle);
    else if (p.repaymentPeriod) setEarnerCycle(p.repaymentPeriod === '30' || p.repaymentPeriod === '120' ? 'monthly' : 'weekly');
    if (p.landlordName) setLandlordName(p.landlordName);
    if (p.landlordPhone) setLandlordPhone(p.landlordPhone);
    if (p.propertyAddress) setPropertyAddress(p.propertyAddress);
    if (p.lc1Name) setLc1Name(p.lc1Name);
    if (p.lc1Phone) setLc1Phone(p.lc1Phone);
    if (p.lc1Village) setLc1Village(p.lc1Village);
    if (p.propertyCity) setPropertyCity(p.propertyCity);
    if (p.lc1Phone || p.lc1Name) { setLc1Mode('register'); setLc1Selected(false); }
    if (p.propertyDistrict) setPropertyDistrict(p.propertyDistrict);
    if (p.houseCategory) setHouseCategory(p.houseCategory);
    if (p.landlordPayoutDay) setLandlordPayoutDay(p.landlordPayoutDay);
    if (p.outstandingHouseCategory) setOutstandingHouseCategory(p.outstandingHouseCategory);
    if (p.outstandingRentAmount) setOutstandingRentAmount(p.outstandingRentAmount);
    if (p.outstandingDaysRemaining) setOutstandingDaysRemaining(p.outstandingDaysRemaining);
    if (p.incomeType && p.incomeType !== 'type') setStep('details');
  }, [open, prefillDraft]);

  const buildDraftPayload = () => ({
    incomeType, tenantName, tenantPhone, tenantNationalId, preferredLanguage,
    rentAmount, outstandingBalance, duration, repaymentPeriod, earnerCycle,
    landlordName, landlordPhone, propertyAddress,
    lc1Name, lc1Phone, lc1Village, propertyCity, propertyDistrict,
    houseCategory, landlordPayoutDay, outstandingHouseCategory,
    outstandingRentAmount, outstandingDaysRemaining,
  });

  const handleSaveForLater = async () => {
    if (!user) { toast.error('You must be signed in'); return; }
    if (!tenantName.trim() || !tenantPhone.trim() || !amount) {
      toast.error('Tenant name, phone and rent amount are required to save a draft');
      return;
    }
    setSavingDraft(true);
    try {
      const { error } = await supabase.from('rent_request_drafts' as any).insert({
        agent_id: user.id,
        tenant_name: tenantName.trim(),
        tenant_phone: tenantPhone.replace(/\s/g, ''),
        rent_amount: amount,
        required_per_tenant_max: amount,
        payload: buildDraftPayload(),
        status: 'pending',
      });
      if (error) throw error;
      toast.success('Saved! We\'ll mark it ready when your tier unlocks this size.');
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to save draft');
    } finally {
      setSavingDraft(false);
    }
  };

  // ===== Autosave: keep the agent's progress safe as they fill the form =====
  // Photos/GPS can't be serialized, but every typed field + the current wizard
  // step are persisted to localStorage so an ordinary agent never loses their
  // work if the app reloads or they close the dialog by mistake.
  const draftStorageKey = `welile:rentReqDraft:${user?.id || 'anon'}`;
  const restoredRef = useRef(false);

  useEffect(() => {
    if (!open) { restoredRef.current = false; return; }
    // Explicit prefill (resuming a saved server draft / prefilled props) wins.
    if (prefillDraft || prefillTenantName || prefillRentAmount) { restoredRef.current = true; return; }
    if (restoredRef.current) return;
    restoredRef.current = true;
    try {
      const raw = localStorage.getItem(draftStorageKey);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (!p || typeof p !== 'object') return;
      if (p.incomeType) setIncomeType(p.incomeType);
      if (p.tenantName) setTenantName(p.tenantName);
      if (p.tenantPhone) setTenantPhone(p.tenantPhone);
      if (p.tenantNationalId) setTenantNationalId(p.tenantNationalId);
      if (p.preferredLanguage) setPreferredLanguage(p.preferredLanguage);
      if (p.rentAmount) setRentAmount(p.rentAmount);
      if (p.duration) setDuration(p.duration);
      if (p.repaymentPeriod) setRepaymentPeriod(p.repaymentPeriod);
      if (p.earnerCycle) setEarnerCycle(p.earnerCycle);
      else if (p.repaymentPeriod) setEarnerCycle(p.repaymentPeriod === '30' || p.repaymentPeriod === '120' ? 'monthly' : 'weekly');
      if (p.landlordName) setLandlordName(p.landlordName);
      if (p.landlordPhone) setLandlordPhone(p.landlordPhone);
      if (p.propertyAddress) setPropertyAddress(p.propertyAddress);
      if (p.lc1Name) setLc1Name(p.lc1Name);
      if (p.lc1Phone) setLc1Phone(p.lc1Phone);
      if (p.lc1Village) setLc1Village(p.lc1Village);
      if (p.propertyCity) setPropertyCity(p.propertyCity);
      if (p.lc1Phone || p.lc1Name) { setLc1Mode('register'); setLc1Selected(false); }
      if (p.propertyDistrict) setPropertyDistrict(p.propertyDistrict);
      if (p.houseCategory) setHouseCategory(p.houseCategory);
      if (p.landlordPayoutDay) setLandlordPayoutDay(p.landlordPayoutDay);
      const hasSaved = Object.keys(p).some((k) => k !== 'incomeType' && p[k]);
      if (p.incomeType && p.incomeType !== 'outstanding') {
        setStep('details');
        if (typeof p.detailStep === 'number') {
          setDetailStep(Math.min(Math.max(0, p.detailStep), DETAIL_STEPS.length - 1));
        }
      }
      if (hasSaved) toast.info('We brought back your saved progress.');
    } catch { /* ignore corrupt storage */ }
  }, [open, prefillDraft, prefillTenantName, prefillRentAmount, draftStorageKey]);

  // Persist on every change (only while the dialog is open and not yet submitted).
  useEffect(() => {
    if (!open || success) return;
    if (!restoredRef.current) return;
    try {
      localStorage.setItem(draftStorageKey, JSON.stringify({ ...buildDraftPayload(), detailStep }));
    } catch { /* storage full / unavailable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open, success, draftStorageKey, detailStep,
    incomeType, tenantName, tenantPhone, tenantNationalId, preferredLanguage,
    rentAmount, outstandingBalance, duration, repaymentPeriod, landlordName, landlordPhone,
    propertyAddress, lc1Name, lc1Phone, lc1Village, propertyCity,
    propertyDistrict, houseCategory, landlordPayoutDay,
  ]);

  // Track connectivity so the form can reassure the agent their draft is safe
  // when the network drops, and warn them before a doomed submit attempt.
  useEffect(() => {
    const goOnline = () => {
      setIsOnline(true);
      if (open) toast.success("You're back online — your draft is safe. You can submit now.");
    };
    const goOffline = () => {
      setIsOnline(false);
      if (open) toast.warning("No internet — keep filling in. Your progress is saved automatically.");
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [open]);

  // Per-step validation for the standard flow's guided wizard.
  const getStepErrors = (idx: number): string[] => {
    const errors: string[] = [];
    const cleanTenantPhone = tenantPhone.replace(/\s/g, '');
    const cleanLandlordPhone = landlordPhone.replace(/\s/g, '');
    const cleanLc1Phone = lc1Phone.replace(/\s/g, '');
    const cleanNationalId = tenantNationalId.trim().toUpperCase();
    if (idx === 0) {
      if (!amount) errors.push('Type the rent amount');
      else if (amount < 50000) errors.push('Rent amount must be at least UGX 50,000');
    } else if (idx === 1) {
      if (!tenantName.trim()) errors.push("Type the tenant's full name");
      if (!tenantPhone.trim()) errors.push("Type the tenant's phone number");
      else if (!isValidUgPhone(cleanTenantPhone)) errors.push('Tenant phone looks wrong — use a number like 0783 123 456');
      if (!cleanNationalId || cleanNationalId.length < 10 || cleanNationalId.length > 14 || !/^[A-Z0-9]+$/.test(cleanNationalId)) {
        errors.push("Enter the tenant's National ID (the long number/letters on their ID card)");
      }
      if (!preferredLanguage) errors.push('Choose the language the tenant speaks');
    } else if (idx === 2) {
      if (!houseCategory) errors.push('Choose the house type');
      // Landlord MUST already be registered in the system. The agent either
      // picks an existing landlord from search or registers a new one first —
      // free-typed names are never auto-created any more.
      const landlordRegistered = !!selectedLandlord || !!selectedHouse?.landlord_id;
      if (!landlordRegistered) {
        errors.push('Step 2 — Landlord verified: Register the landlord first. Search to pick an existing landlord, or tap "Add new" to register them.');
      } else if (landlordCheck === 'missing') {
        errors.push('Step 2 — Landlord verified: The selected landlord is no longer registered in the system. Pick a registered landlord or register them again.');
      } else if (landlordCheck === 'checking') {
        errors.push('Step 2 — Landlord verified: Confirming the landlord is registered — please wait a moment before posting.');
      } else if (landlordCheck !== 'registered' && landlordCheck !== 'unverified') {
        errors.push('Step 2 — Landlord verified: The landlord must be registered and verified before you can post a rent request.');
      }
      // The landlord's listed house MUST show photos. Block rent requests on
      // any selected listing that has no photos on record.
      if (selectedHouse && !listingHasRealPhoto(selectedHouse)) {
        errors.push("This landlord's house has no photos — pick a house that shows photos before posting the rent request");
      }
      if (!propertyAddress.trim()) errors.push('Type the property address');
      const missingHousePhotos = HOUSE_PHOTO_SLOTS.some((_, i) => !housePhotos[i]);
      if (missingHousePhotos) errors.push('Take all 4 house photos (front, back, left and right)');
      if (!tenantPhoto) errors.push("Take the tenant's passport photo");
      if (!gpsLocation) errors.push('Capture the property GPS at the house');
    } else if (idx === 3) {
      if (!lc1Name.trim()) errors.push("Type the LC1 chairperson's name");
      if (!lc1Phone.trim()) errors.push('Type the LC1 phone number');
      else if (!isValidUgPhone(cleanLc1Phone)) errors.push('LC1 phone looks wrong — use a valid Ugandan number');
      // LC1 verification no longer blocks posting — the request can be posted
      // with a registered or free-typed LC1 chairperson. The LC1 must be
      // verified before the request is APPROVED, not before it is posted.
      if (!lc1Village.trim()) errors.push('Type the LC1 village');
      if (!propertyCity.trim()) errors.push('Type the town / city');
      const tOk = !!cleanTenantPhone && isValidUgPhone(cleanTenantPhone);
      const lOk = !!cleanLandlordPhone && isValidUgPhone(cleanLandlordPhone);
      const cOk = !!cleanLc1Phone && isValidUgPhone(cleanLc1Phone);
      if (tOk && lOk && cleanTenantPhone === cleanLandlordPhone) errors.push('Tenant and Landlord phones must be different numbers');
      if (tOk && cOk && cleanTenantPhone === cleanLc1Phone) errors.push('Tenant and LC1 phones must be different numbers');
      if (lOk && cOk && cleanLandlordPhone === cleanLc1Phone) errors.push('Landlord and LC1 phones must be different numbers');
    } else if (idx === 4) {
      if (!guarantorConsent) errors.push('Tick the box to accept guarantor responsibility');
    }
    return errors;
  };

  /**
   * Parallel to getStepErrors — returns a Record that maps field identifiers
   * to their specific error messages so the UI can highlight individual fields.
   */
  const getStepFieldErrors = (idx: number): Record<string, string> => {
    const map: Record<string, string> = {};
    const cleanTenantPhone = tenantPhone.replace(/\s/g, '');
    const cleanLandlordPhone = landlordPhone.replace(/\s/g, '');
    const cleanLc1Phone = lc1Phone.replace(/\s/g, '');
    const cleanNationalId = tenantNationalId.trim().toUpperCase();
    if (idx === 0) {
      if (!amount) map['rentAmount'] = 'Type the rent amount';
      else if (amount < 50000) map['rentAmount'] = 'Rent amount must be at least UGX 50,000';
    } else if (idx === 1) {
      if (!tenantName.trim()) map['tenantName'] = "Type the tenant's full name";
      if (!tenantPhone.trim()) map['tenantPhone'] = "Type the tenant's phone number";
      else if (!isValidUgPhone(cleanTenantPhone)) map['tenantPhone'] = 'Tenant phone looks wrong — use a number like 0783 123 456';
      if (!cleanNationalId || cleanNationalId.length < 10 || cleanNationalId.length > 14 || !/^[A-Z0-9]+$/.test(cleanNationalId)) {
        map['tenantNationalId'] = "Enter the tenant's National ID (the long number/letters on their ID card)";
      }
      if (!preferredLanguage) map['preferredLanguage'] = 'Choose the language the tenant speaks';
    } else if (idx === 2) {
      if (!houseCategory) map['houseCategory'] = 'Choose the house type';
      const landlordRegistered = !!selectedLandlord || !!selectedHouse?.landlord_id;
      if (!landlordRegistered) {
        map['landlord'] = 'Step 2 — Landlord verified: Register the landlord first. Search to pick an existing landlord, or tap "Add new" to register them.';
      } else if (landlordCheck === 'missing') {
        map['landlord'] = 'Step 2 — Landlord verified: The selected landlord is no longer registered in the system. Pick a registered landlord or register them again.';
      } else if (landlordCheck === 'checking') {
        map['landlord'] = 'Step 2 — Landlord verified: Confirming the landlord is registered — please wait a moment before posting.';
      } else if (landlordCheck !== 'registered' && landlordCheck !== 'unverified') {
        map['landlord'] = 'Step 2 — Landlord verified: The landlord must be registered and verified before you can post a rent request.';
      }
      if (selectedHouse && !listingHasRealPhoto(selectedHouse)) {
        map['housePhotos'] = "This landlord's house has no photos — pick a house that shows photos before posting the rent request";
      }
      if (!propertyAddress.trim()) map['propertyAddress'] = 'Type the property address';
      const missingHousePhotos = HOUSE_PHOTO_SLOTS.some((_, i) => !housePhotos[i]);
      if (missingHousePhotos) map['housePhotos'] = 'Take all 4 house photos (front, back, left and right)';
      if (!tenantPhoto) map['tenantPhoto'] = "Take the tenant's passport photo";
      if (!gpsLocation) map['gpsLocation'] = 'Capture the property GPS at the house';
    } else if (idx === 3) {
      if (!lc1Name.trim()) map['lc1Name'] = "Type the LC1 chairperson's name";
      if (!lc1Phone.trim()) map['lc1Phone'] = 'Type the LC1 phone number';
      else if (!isValidUgPhone(cleanLc1Phone)) map['lc1Phone'] = 'LC1 phone looks wrong — use a valid Ugandan number';
      if (!lc1Village.trim()) map['lc1Village'] = 'Type the LC1 village';
      if (!propertyCity.trim()) map['propertyCity'] = 'Type the town / city';
      const tOk = !!cleanTenantPhone && isValidUgPhone(cleanTenantPhone);
      const lOk = !!cleanLandlordPhone && isValidUgPhone(cleanLandlordPhone);
      const cOk = !!cleanLc1Phone && isValidUgPhone(cleanLc1Phone);
      if (tOk && lOk && cleanTenantPhone === cleanLandlordPhone) map['tenantPhone'] = 'Tenant and Landlord phones must be different numbers';
      if (tOk && cOk && cleanTenantPhone === cleanLc1Phone) map['tenantPhone'] = 'Tenant and LC1 phones must be different numbers';
      if (lOk && cOk && cleanLandlordPhone === cleanLc1Phone) map['landlordPhone'] = 'Landlord and LC1 phones must be different numbers';
    } else if (idx === 4) {
      if (!guarantorConsent) map['guarantorConsent'] = 'Tick the box to accept guarantor responsibility';
    }
    return map;
  };

  /**
   * Full-form field error map for final submit (non-outstanding flow).
   */
  const collectFieldErrors = (isOutstanding: boolean): Record<string, string> => {
    const map: Record<string, string> = {};
    const cleanTenantPhone = tenantPhone.replace(/\s/g, '');
    const cleanLandlordPhone = landlordPhone.replace(/\s/g, '');
    const cleanLc1Phone = lc1Phone.replace(/\s/g, '');

    if (!tenantName.trim()) map['tenantName'] = "Type the tenant's full name";
    if (!tenantPhone.trim()) map['tenantPhone'] = "Type the tenant's phone number";
    else if (!isValidUgPhone(cleanTenantPhone)) map['tenantPhone'] = 'Tenant phone looks wrong — use a number like 0783 123 456';

    const cleanNationalId = tenantNationalId.trim().toUpperCase();
    if (!cleanNationalId || cleanNationalId.length < 10 || cleanNationalId.length > 14 || !/^[A-Z0-9]+$/.test(cleanNationalId)) {
      map['tenantNationalId'] = "Enter the tenant's National ID (the long number/letters on their ID card)";
    }

    if (!preferredLanguage) map['preferredLanguage'] = 'Choose the language the tenant speaks';

    if (isOutstanding) {
      if (!amount) map['outstandingRentAmount'] = 'Type the rent amount';
      else if (amount < 50000) map['outstandingRentAmount'] = 'Rent amount must be at least UGX 50,000';
      if (!outstandingBalance.trim()) map['outstandingBalance'] = 'Type the outstanding balance';
      else if (parseInt(outstandingBalance) <= 0) map['outstandingBalance'] = 'Outstanding balance must be above 0';
      if (!outstandingDaysRemaining.trim()) map['outstandingDaysRemaining'] = 'Type the days remaining';
      else if (parseInt(outstandingDaysRemaining) <= 0) map['outstandingDaysRemaining'] = 'Days remaining must be above 0';
      if (!outstandingHouseCategory) map['outstandingHouseCategory'] = 'Choose the house type';
      const landlordRegistered = !!selectedLandlord || !!selectedHouse?.landlord_id;
      if (!landlordRegistered) {
        map['landlord'] = 'Step 2 — Landlord verified: Register the landlord first. Search to pick an existing landlord, or tap "Add new" to register them.';
      } else if (landlordCheck === 'missing') {
        map['landlord'] = 'Step 2 — Landlord verified: The selected landlord is no longer registered in the system. Pick a registered landlord or register them again.';
      } else if (landlordCheck === 'checking') {
        map['landlord'] = 'Step 2 — Landlord verified: Confirming the landlord is registered — please wait a moment before posting.';
      } else if (landlordCheck !== 'registered' && landlordCheck !== 'unverified') {
        map['landlord'] = 'Step 2 — Landlord verified: The landlord must be registered and verified before you can post a rent request.';
      }
      if (!propertyAddress.trim()) map['propertyAddress'] = 'Type the property address';
      if (!lc1Name.trim()) map['lc1Name'] = "Type the LC1 chairperson's name";
      if (!lc1Phone.trim()) map['lc1Phone'] = 'Type the LC1 phone number';
      else {
        if (!isValidUgPhone(cleanLc1Phone)) map['lc1Phone'] = 'LC1 phone looks wrong — use a valid Ugandan number';
      }
      if (!lc1Village.trim()) map['lc1Village'] = 'Type the LC1 village';
      if (!propertyCity.trim()) map['propertyCity'] = 'Type the town / city';
    } else {
      if (!amount) map['rentAmount'] = 'Type the rent amount';
      else if (amount < 50000) map['rentAmount'] = 'Rent amount must be at least UGX 50,000';
      if (!houseCategory) map['houseCategory'] = 'Choose the house type';
      const landlordRegistered = !!selectedLandlord || !!selectedHouse?.landlord_id;
      if (!landlordRegistered) {
        map['landlord'] = 'Step 2 — Landlord verified: Register the landlord first. Search to pick an existing landlord, or tap "Add new" to register them.';
      } else if (landlordCheck === 'missing') {
        map['landlord'] = 'Step 2 — Landlord verified: The selected landlord is no longer registered in the system. Pick a registered landlord or register them again.';
      } else if (landlordCheck === 'checking') {
        map['landlord'] = 'Step 2 — Landlord verified: Confirming the landlord is registered — please wait a moment before posting.';
      } else if (landlordCheck !== 'registered' && landlordCheck !== 'unverified') {
        map['landlord'] = 'Step 2 — Landlord verified: The landlord must be registered and verified before you can post a rent request.';
      }
      if (selectedHouse && !listingHasRealPhoto(selectedHouse)) {
        map['housePhotos'] = "This landlord's house has no photos — pick a house that shows photos before posting the rent request";
      }
      if (!propertyAddress.trim()) map['propertyAddress'] = 'Type the property address';
      const missingHousePhotos = HOUSE_PHOTO_SLOTS.some((_, i) => !housePhotos[i]);
      if (missingHousePhotos) map['housePhotos'] = 'Take all 4 house photos (front, back, left and right)';
      if (!tenantPhoto) map['tenantPhoto'] = "Take the tenant's passport photo";
      if (!gpsLocation) map['gpsLocation'] = 'Capture the property GPS at the house';
      if (!lc1Name.trim()) map['lc1Name'] = "Type the LC1 chairperson's name";
      if (!lc1Phone.trim()) map['lc1Phone'] = 'Type the LC1 phone number';
      else if (!isValidUgPhone(cleanLc1Phone)) map['lc1Phone'] = 'LC1 phone looks wrong — use a valid Ugandan number';
      if (!lc1Village.trim()) map['lc1Village'] = 'Type the LC1 village';
    if (!propertyCity.trim()) map['propertyCity'] = 'Type the town / city';
    }

    const tenantPhoneValid = !!cleanTenantPhone && isValidUgPhone(cleanTenantPhone);
    const landlordPhoneValid = !!cleanLandlordPhone && isValidUgPhone(cleanLandlordPhone);
    const lc1PhoneValid = !!cleanLc1Phone && isValidUgPhone(cleanLc1Phone);

    if (tenantPhoneValid && landlordPhoneValid && cleanTenantPhone === cleanLandlordPhone) {
      map['tenantPhone'] = 'Tenant and Landlord phones must be different numbers';
    }
    if (tenantPhoneValid && lc1PhoneValid && cleanTenantPhone === cleanLc1Phone) {
      map['tenantPhone'] = 'Tenant and LC1 phones must be different numbers';
    }
    if (landlordPhoneValid && lc1PhoneValid && cleanLandlordPhone === cleanLc1Phone) {
      map['landlordPhone'] = 'Landlord and LC1 phones must be different numbers';
    }

    const missingHousePhotos = HOUSE_PHOTO_SLOTS.some((_, i) => !housePhotos[i]);
    if (missingHousePhotos) map['housePhotos'] = 'Take all 4 house photos (front, back, left and right)';
    if (!tenantPhoto) map['tenantPhoto'] = "Take the tenant's passport photo";

    return map;
  };

  const scrollDialogTop = () => {
    requestAnimationFrame(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) dialog.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };

  const goNextStep = () => {
    const errs = getStepErrors(detailStep);
    const fieldMap = getStepFieldErrors(detailStep);
    if (errs.length > 0) {
      setValidationErrors(errs);
      setFieldErrors(fieldMap);
      setSubmissionError(null);
      setErrorDetails(null);
      toast.error(errs.length === 1 ? errs[0] : `${errs.length} things still needed`);
      requestAnimationFrame(() => {
        errorSummaryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return;
    }
    setValidationErrors([]);
    setFieldErrors({});
    setDetailStep((s) => Math.min(s + 1, DETAIL_STEPS.length - 1));
    scrollDialogTop();
  };

  const goBackStep = () => {
    setValidationErrors([]);
    setFieldErrors({});
    setSubmissionError(null);
    setErrorDetails(null);
    if (detailStep === 0) { setStep('type'); return; }
    setDetailStep((s) => Math.max(s - 1, 0));
    scrollDialogTop();
  };

  const captureGPS = useCallback(() => {
    if (!navigator.geolocation) {
      toast.error('GPS not supported on this device');
      return;
    }
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
        setGpsLoading(false);
        toast.success('Property GPS captured!');
      },
      (err) => {
        setGpsLoading(false);
        toast.error(err.code === 1 ? 'Location permission denied' : 'Could not get GPS. Try again.');
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  }, []);

  // Four required outside views of the house
  const HOUSE_PHOTO_SLOTS = [
    { key: 'front', label: 'Front of house', hint: 'Main entrance / front facade' },
    { key: 'back', label: 'Back of house', hint: 'Rear side of the building' },
    { key: 'left', label: 'Left side', hint: 'Left exterior wall' },
    { key: 'right', label: 'Right side', hint: 'Right exterior wall' },
  ] as const;

  const handlePhotoAddAt = useCallback(async (index: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    const error = validateImageFile(file);
    if (error) {
      toast.error(error);
      return;
    }
    // Downscale + compress the captured photo immediately (Canvas → 1200px WebP).
    // Holding full-resolution camera files in memory across all 4 house photos
    // makes mobile WebViews reclaim memory and reload the page after capture —
    // optimizing first keeps memory low so the page never refreshes.
    let stored = file;
    let previewUrl: string;
    try {
      const optimized = await optimizeImage(file);
      stored = optimized.file;
      previewUrl = optimized.previewUrl;
    } catch {
      previewUrl = URL.createObjectURL(file);
    }
    setHousePhotos(prev => {
      const next = [...prev];
      if (next[index]) URL.revokeObjectURL(next[index].preview);
      next[index] = { file: stored, preview: previewUrl };
      return next;
    });
  }, []);

  const removePhoto = useCallback((index: number) => {
    setHousePhotos(prev => {
      const next = [...prev];
      if (next[index]) URL.revokeObjectURL(next[index].preview);
      next.splice(index, 1);
      return next;
    });
  }, []);

  const handleTenantPhoto = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    const error = validateImageFile(file);
    if (error) {
      toast.error(error);
      return;
    }
    // Optimize on capture (Canvas → 1200px WebP) to keep memory low and prevent
    // mobile WebViews from reloading the page after the native camera closes.
    let stored = file;
    let previewUrl: string;
    try {
      const optimized = await optimizeImage(file);
      stored = optimized.file;
      previewUrl = optimized.previewUrl;
    } catch {
      previewUrl = URL.createObjectURL(file);
    }
    setTenantPhoto(prev => {
      if (prev) URL.revokeObjectURL(prev.preview);
      return { file: stored, preview: previewUrl };
    });
  }, []);

  const removeTenantPhoto = useCallback(() => {
    setTenantPhoto(prev => {
      if (prev) URL.revokeObjectURL(prev.preview);
      return null;
    });
  }, []);

  // Auto-fill the tenant fields from a previously-registered tenant. Pulls
  // their name, phone and National ID instantly, and best-effort downloads
  // their saved passport photo so the agent doesn't have to re-capture it.
  const applyExistingTenant = useCallback(async (tenantId: string) => {
    const t = existingTenants.find((x) => x.id === tenantId);
    if (!t) return;
    setAutofillingTenant(true);
    try {
      if (t.full_name) setTenantName(t.full_name);
      if (t.phone) setTenantPhone(formatPhoneInput(t.phone));
      if (t.national_id) setTenantNationalId(cleanNationalIdInput(t.national_id));

      if (t.avatar_url) {
        try {
          const res = await fetch(t.avatar_url);
          if (res.ok) {
            const blob = await res.blob();
            const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
            const file = new File([blob], `tenant_passport.${ext}`, { type: blob.type || 'image/jpeg' });
            setTenantPhoto((prev) => {
              if (prev) URL.revokeObjectURL(prev.preview);
              return { file, preview: URL.createObjectURL(file) };
            });
          }
        } catch {
          // Photo fetch is best-effort — agent can still capture a fresh one.
        }
      }
      toast.success(`Filled in ${t.full_name}'s details`);
    } finally {
      setAutofillingTenant(false);
    }
  }, [existingTenants]);

  // When the live phone check reveals an existing user, let the agent re-use
  // that record instead of creating a duplicate (fraud guard).
  const useExistingTenantMatch = useCallback((m: TenantDuplicateMatch) => {
    if (m.full_name) setTenantName(formatNameInput(m.full_name));
    if (m.phone) setTenantPhone(formatPhoneInput(m.phone));
    if (m.national_id) setTenantNationalId(cleanNationalIdInput(m.national_id));
    toast.success(`Using ${m.full_name || 'existing tenant'}'s record`);
  }, []);


  // Renew an already-registered tenant: pull their details, switch to the
  // outstanding-balance flow and prefill the balance they still owe so the
  // agent continues the existing tenancy instead of creating a duplicate.
  const renewExistingTenant = useCallback(async (m: TenantDuplicateMatch) => {

    if (m.full_name) setTenantName(formatNameInput(m.full_name));
    if (m.phone) setTenantPhone(formatPhoneInput(m.phone));
    if (m.national_id) setTenantNationalId(cleanNationalIdInput(m.national_id));
    setIncomeType('outstanding');
    setStep('details');
    // Renewal document custody: look up what the tenant already has on file so
    // the agent is told plainly whether documents carry forward or must be
    // uploaded fresh.
    setRenewDocs(null);
    setRenewDocsLoading(true);
    try {
      const { data: docs, error: docsErr } = await supabase.rpc('get_tenant_documents' as any, {
        p_tenant_id: m.id,
      });
      if (docsErr) throw docsErr;
      const rows: { doc_type?: string | null }[] = Array.isArray(docs) ? docs : [];
      const summary = {
        passport: rows.some((d) => d.doc_type === 'tenant_passport'),
        lcLetter: rows.some((d) => d.doc_type === 'lc_letter'),
        houseImages: rows.filter((d) => d.doc_type === 'house_image').length,
      };
      setRenewDocs(summary);
      if (!summary.passport || summary.houseImages < 4) {
        toast.warning('No documents on file for this tenant — capture the passport photo, house photos and LC letter again');
      }
    } catch {
      // Unknown document state — treat as missing so the agent still uploads.
      setRenewDocs({ passport: false, lcLetter: false, houseImages: 0 });
    } finally {
      setRenewDocsLoading(false);
    }
    try {
      const { data, error } = await supabase.rpc('get_tenant_rent_summary' as any, {
        p_tenant_id: m.id,
      });
      if (!error) {
        const row: any = Array.isArray(data) ? data[0] : data;
        const owed = Number(row?.outstanding_balance) || 0;
        if (owed > 0) setOutstandingBalance(String(Math.round(owed)));
      }
    } catch {
      // Non-fatal — agent can type the balance manually.
    }
    toast.success(`Renewing ${m.full_name || 'this tenant'} — continue their plan`);
  }, []);


  const uploadTenantPhoto = async (requestId: string, tenantUserId?: string | null): Promise<string | null> => {
    if (!user || !tenantPhoto) return null;
    try {
      const optimized = await optimizeImage(tenantPhoto.file, { maxWidth: 1200, quality: 0.85 });
      const ext = optimized.file.name.split('.').pop() || 'webp';
      const path = `${user.id}/${requestId}/tenant_passport.${ext}`;
      const { error } = await supabase.storage
        .from('house-images')
        .upload(path, optimized.file, { cacheControl: '86400', upsert: true });
      if (error) throw error;
      const { data } = supabase.storage.from('house-images').getPublicUrl(path);
      // Offsite backup: mirror the tenant ID photo into the Google Drive vault.
      archiveToDrive('house-images', path, 'tenant_id');
      // Best-effort: also set on tenant profile avatar if missing
      if (tenantUserId) {
        try {
          await supabase.from('profiles').update({ avatar_url: data.publicUrl }).eq('id', tenantUserId).is('avatar_url', null);
        } catch { /* non-fatal */ }
      }
      return data.publicUrl;
    } catch (err) {
      console.warn('Tenant photo upload failed:', err);
      return null;
    }
  };

  const uploadHousePhotos = async (requestId: string): Promise<string[]> => {
    if (!user || housePhotos.length === 0) return [];
    const urls: string[] = [];
    for (let i = 0; i < housePhotos.length; i++) {
      try {
        const optimized = await optimizeImage(housePhotos[i].file, { maxWidth: 1200, quality: 0.8 });
        const ext = optimized.file.name.split('.').pop() || 'webp';
        const path = `${user.id}/${requestId}/photo_${i}.${ext}`;
        const { error } = await supabase.storage
          .from('house-images')
          .upload(path, optimized.file, { cacheControl: '86400', upsert: false });
        if (error) throw error;
        const { data } = supabase.storage.from('house-images').getPublicUrl(path);
        urls.push(data.publicUrl);
      } catch (err) {
        console.warn(`Photo ${i} upload failed:`, err);
      }
    }
    return urls;
  };

  /** Pick the LC letter — one image only, JPG/PNG/JPEG, max 10 MB. */
  const handleLcLetter = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const okType = ['image/jpeg', 'image/jpg', 'image/png'].includes(file.type.toLowerCase());
    if (!okType) {
      toast.error('Only JPG, JPEG or PNG images are allowed for the LC letter');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('The LC letter must be 10 MB or smaller');
      return;
    }
    setLcLetter({ file, preview: URL.createObjectURL(file) });
  };

  /** Store the LC letter in the private `lc-letters` bucket for this request. */
  const uploadLcLetter = async (requestId: string): Promise<{ path: string; bucket: string } | null> => {
    if (!user || !lcLetter) return null;
    try {
      const ext = (lcLetter.file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `${user.id}/${requestId}/lc_letter.${ext}`;
      const { error } = await supabase.storage
        .from('lc-letters')
        .upload(path, lcLetter.file, { cacheControl: '86400', upsert: true, contentType: lcLetter.file.type });
      if (error) throw error;
      return { path, bucket: 'lc-letters' };
    } catch (err) {
      console.warn('LC letter upload failed:', err);
      return null;
    }
  };

  const resetForm = () => {
    // (LC letter cleared above with the rest of the tenant fields.)
    setIncomeType(null);
    setTenantName('');
    setLcLetter(null);
    setTenantPhone('');
    setTenantNationalId('');
    setRentAmount('');
    setOutstandingBalance('');
    setDuration('30');
    setRepaymentPeriod('7');
    setEarnerCycle('weekly');
    setLandlordName('');
    setLandlordPhone('');
    setPropertyAddress('');
    setUgLocation(null);
    setLc1Name('');
    setLc1Phone('');
    setLc1Village('');
    setPropertyCity('');
    setPropertyDistrict('');
    
    setLc1Mode('search');
    setLc1Selected(false);
    setLc1Query('');
    setLc1Results([]);
    setLc1SearchedOnce(false);
    setHouseCategory('');
    setOutstandingHouseCategory('');
    setSelectedLandlord(null);
    setOutstandingRentAmount('');
    setOutstandingDaysRemaining('');
    setNoSmartphone(false);
    setGpsLocation(null);
    setGpsLoading(false);
    housePhotos.forEach(p => URL.revokeObjectURL(p.preview));
    setHousePhotos([]);
    setRenewDocs(null);
    setRenewDocsLoading(false);
    if (tenantPhoto) URL.revokeObjectURL(tenantPhoto.preview);
    setTenantPhoto(null);
    setGuarantorConsent(false);
    setValidationErrors([]);
    setFieldErrors({});
    setSubmissionError(null);
    setErrorDetails(null);
    setSuccess(false);
    setRequestState('idle');
    setActivationLink(null);
    setStep('type');
    setDetailStep(0);
    setAutoDraftId(null);
    setAutoDraftStatus('idle');
    setSelectedHouse(null);
    setHouseResults([]);
    setHouseQuery('');
    setHouseSearchedOnce(false);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Guard against accidentally losing landlord inputs the agent has typed.
      if (landlordName.trim() || landlordPhone.trim()) {
        setConfirmCloseDialog(true);
        return;
      }
      resetForm();
    }
    onOpenChange(newOpen);
  };

  const confirmCloseAndReset = () => {
    setConfirmCloseDialog(false);
    resetForm();
    onOpenChange(false);
  };

  const amount = incomeType === 'outstanding' 
    ? (parseInt(outstandingBalance.replace(/,/g, '')) || 0)
    : (parseInt(rentAmount.replace(/,/g, '')) || 0);
  
  // ===== Auto-capture the request as soon as tenant name + amount exist =====
  // The agent no longer has to hunt for an unresponsive submit button to know
  // their work is safe: a debounced server draft is written automatically and a
  // visible "Captured ✓" badge confirms it. They keep filling the other parts
  // meanwhile, and every change keeps the same draft up to date.
  useEffect(() => {
    if (!open || success) return;
    if (!user?.id) return;
    if (!isOnline) return;
    if (!tenantName.trim() || amount <= 0) return;
    const handle = setTimeout(async () => {
      setAutoDraftStatus('saving');
      try {
        const base = {
          agent_id: user.id,
          tenant_name: tenantName.trim(),
          tenant_phone: tenantPhone.replace(/\s/g, '') || '',
          rent_amount: amount,
          required_per_tenant_max: amount,
          payload: buildDraftPayload(),
          status: 'pending' as const,
        };
        if (autoDraftId) {
          const { error } = await supabase
            .from('rent_request_drafts' as any)
            .update(base)
            .eq('id', autoDraftId);
          if (error) throw error;
        } else {
          const { data, error } = await supabase
            .from('rent_request_drafts' as any)
            .insert(base)
            .select('id')
            .single();
          if (error) throw error;
          if ((data as any)?.id) setAutoDraftId((data as any).id as string);
        }
        setAutoDraftStatus('saved');
      } catch {
        setAutoDraftStatus('error');
      }
    }, 1200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open, success, user?.id, isOnline, autoDraftId,
    tenantName, tenantPhone, amount, rentAmount, outstandingBalance,
    duration, repaymentPeriod, landlordName, landlordPhone, propertyAddress,
    lc1Name, lc1Phone, lc1Village, propertyCity, propertyDistrict,
    houseCategory, landlordPayoutDay,
  ]);

  // Calculate fees based on income type
  const calculateFees = () => {
    if (!incomeType) return null;
    // Outstanding flow accepts a zero balance (tenant already cleared) — only
    // non-outstanding flows require a positive amount to compute fees.
    if (incomeType !== 'outstanding' && !amount) return null;

    if (incomeType === 'outstanding') {
      const days = parseInt(duration);
      // Outstanding flow: rent_amount is the monthly rent the tenant owes
      // (separate field), while `amount` (= outstandingBalance) is the arrears.
      const rentMonthly = parseInt(outstandingRentAmount.replace(/,/g, '')) || amount;
      return {
        rentAmount: rentMonthly,
        durationDays: days,
        accessFee: 0,
        requestFee: 0,
        totalRepayment: amount,
        dailyRepayment: amount > 0 ? Math.ceil(amount / days) : 0,
      };
    }
    
    if (incomeType === 'daily') {
      return calculateRentRepayment(amount, parseInt(duration) as 30 | 60 | 90);
    } else {
      // Weekly/Monthly calculation
      const DAILY_ACCESS_FEE_RATE = 0.011; // 1.1%
      const PLATFORM_FEE = 10000;
      const days = parseInt(repaymentPeriod);
      const accessFee = Math.round(amount * DAILY_ACCESS_FEE_RATE * days);
      const totalRepayment = amount + accessFee + PLATFORM_FEE;
      
      return {
        rentAmount: amount,
        durationDays: days,
        accessFee,
        requestFee: PLATFORM_FEE,
        totalRepayment,
        dailyRepayment: Math.round(totalRepayment / days),
      };
    }
  };

  const fees = calculateFees();

  // ===== Weekly earner submit gate =====
  // The form must stay un-submittable until the 1 month rent is a
  // valid UGX number AND the weekly repayment ((1 month + 33%) ÷ 4) is computed.
  const isWeeklyEarner = incomeType === 'weekly-monthly' && earnerCycle === 'weekly';
  const weeklyRepayment = isWeeklyEarner && amount > 0 ? Math.ceil((amount * 1.33) / 4) : 0;
  const weeklyEarnerBlocksSubmit =
    isWeeklyEarner && (vRentNeed(rentAmount) !== null || weeklyRepayment <= 0);

  // ===== FIX #1: Phone validation helper =====
  const collectValidationErrors = (isOutstanding: boolean): string[] => {
    const errors: string[] = [];
    const cleanTenantPhone = tenantPhone.replace(/\s/g, '');
    const cleanLandlordPhone = landlordPhone.replace(/\s/g, '');

    if (!guarantorConsent) errors.push('Tick the box to accept guarantor responsibility');
    if (!tenantName.trim()) errors.push('Type the tenant\'s full name');
    if (!tenantPhone.trim()) errors.push('Type the tenant\'s phone number');
    else if (!isValidUgPhone(cleanTenantPhone)) errors.push('Tenant phone looks wrong — use a number like 0783 123 456');

    const cleanNationalId = tenantNationalId.trim().toUpperCase();
    if (!isOutstanding) {
      if (!cleanNationalId || cleanNationalId.length < 10 || cleanNationalId.length > 14 || !/^[A-Z0-9]+$/.test(cleanNationalId)) {
        errors.push('Enter the tenant\'s National ID (the long number/letters on their ID card)');
      }
    }

    if (!preferredLanguage) errors.push('Choose the language the tenant speaks');

    // Outstanding flow uses a searchable landlord picker (LC already linked).
    // Other flows still collect landlord + LC1 inline.
    if (isOutstanding) {
      if (!selectedLandlord) errors.push('Pick the landlord from the list');
      else if (landlordCheck === 'missing') errors.push('Step 2 — Landlord verified: The selected landlord is no longer registered in the system. Pick a registered landlord.');
      else if (landlordCheck === 'checking') errors.push('Step 2 — Landlord verified: Confirming the landlord is registered — please wait a moment before posting.');
      if (!outstandingRentAmount || parseInt(outstandingRentAmount.replace(/,/g, '')) <= 0) {
        errors.push('Type the rent amount');
      }
      // Outstanding balance and days remaining can both be 0
      // (tenant already cleared / no current period left).
      if (outstandingDaysRemaining === '' || isNaN(parseInt(outstandingDaysRemaining))) {
        errors.push('Type the days remaining');
      }
      if (outstandingBalance === '' || isNaN(parseInt(outstandingBalance.replace(/,/g, '')))) {
        errors.push('Type the outstanding balance');
      }
    } else {
      // A registered landlord is mandatory before a rent request can be posted.
      const landlordRegistered = !!selectedLandlord || !!selectedHouse?.landlord_id;
      if (!landlordRegistered) {
        errors.push('Step 2 — Landlord verified: Register the landlord first. Search to pick an existing landlord, or tap "Add new" to register them.');
      } else if (landlordCheck === 'missing') {
        errors.push('Step 2 — Landlord verified: The selected landlord is no longer registered in the system. Pick a registered landlord or register them again.');
      } else if (landlordCheck === 'checking') {
        errors.push('Step 2 — Landlord verified: Confirming the landlord is registered — please wait a moment before posting.');
      } else if (landlordCheck !== 'registered' && landlordCheck !== 'unverified') {
        errors.push('Step 2 — Landlord verified: The landlord must be registered and verified before you can post a rent request.');
      }
      if (!propertyAddress.trim()) errors.push('Type the property address');
      if (!lc1Name.trim()) errors.push('Type the LC1 chairperson\'s name');
      if (!lc1Phone.trim()) errors.push('Type the LC1 phone number');
      else {
        const cleanLc1 = lc1Phone.replace(/\s/g, '');
        if (!isValidUgPhone(cleanLc1)) errors.push('LC1 phone looks wrong — use a valid Ugandan number');
        // LC1 verification no longer blocks posting — verification is required
        // before the request is APPROVED, not before it is posted.
      }
      if (!lc1Village.trim()) errors.push('Type the LC1 village');
      if (!propertyCity.trim()) errors.push('Type the town / city');
      if (!houseCategory) errors.push('Choose the house type');
      if (!gpsLocation) errors.push('Capture the property GPS at the house');
    }

    // ===== Block duplicate phone numbers across roles =====
    const cleanLc1Phone = lc1Phone.replace(/\s/g, '');
    const tenantPhoneValid = cleanTenantPhone && isValidUgPhone(cleanTenantPhone);
    const landlordPhoneValid = cleanLandlordPhone && isValidUgPhone(cleanLandlordPhone);
    const lc1PhoneValid = cleanLc1Phone && isValidUgPhone(cleanLc1Phone);

    if (tenantPhoneValid && landlordPhoneValid && cleanTenantPhone === cleanLandlordPhone) {
      errors.push('Tenant and Landlord phones must be different numbers');
    }
    if (tenantPhoneValid && lc1PhoneValid && cleanTenantPhone === cleanLc1Phone) {
      errors.push('Tenant and LC1 phones must be different numbers');
    }
    if (landlordPhoneValid && lc1PhoneValid && cleanLandlordPhone === cleanLc1Phone) {
      errors.push('Landlord and LC1 phones must be different numbers');
    }

    // House photos and tenant passport photo are mandatory.
    const missingHousePhotos = HOUSE_PHOTO_SLOTS.some((_, i) => !housePhotos[i]);
    if (missingHousePhotos) errors.push('Take all 4 house photos (front, back, left and right)');
    if (!tenantPhoto) errors.push("Take the tenant's passport photo");

    return errors;
  };

  // Helper to check if a specific field has an error
  const hasFieldError = (fieldName: string): boolean => {
    return !!fieldErrors[fieldName];
  };
  const getFieldError = (fieldName: string): string | null => {
    return fieldErrors[fieldName] || null;
  };

  const handleSubmit = async () => {
    setSubmissionError(null);
    setErrorDetails(null);

    if (!user) {
      toast.error('You must be signed in to submit a request');
      return;
    }
    // Offline guard: never lose the draft to a doomed network call. The form
    // state is already auto-saved, so we just stop and reassure the agent.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const offlineMsg = 'No internet right now. Your draft is saved — it will still be here when you reconnect. Try submitting again once you have a signal.';
      setSubmissionError(offlineMsg);
      toast.warning('No internet', { description: 'Your draft is saved. Submit again when you reconnect.' });
      return;
    }
    // Daily Eligibility Law: only applies once an agent has graduated
    // (reached the tenant threshold). New agents are exempt and gated only
    // by the per-tenant cap. `can_post_rent_today` already encodes this.
    if (myCap && !myCap.is_new_agent && !myCap.can_post_rent_today) {
      const threshold = Math.round(DAILY_ELIGIBILITY_THRESHOLD * 100);
      const ypct = Math.round(myCap.yesterday_response_pct * 100);
      const msg =
        `Blocked from posting new rent requests today. ` +
        `Yesterday you collected ${ypct}% of your expected daily rent ` +
        `(UGX ${formatUGX(myCap.paid_yesterday)} of UGX ${formatUGX(myCap.expected_daily)}). ` +
        `Collect at least ${threshold}% today to be unblocked and rated Good tomorrow.`;
      setSubmissionError(msg);
      toast.error('Blocked today', { description: msg });
      return;
    }
    if (!fees) {
      toast.error('Please enter a valid rent amount before submitting');
      return;
    }

    const isOutstanding = incomeType === 'outstanding';
    const errors = collectValidationErrors(isOutstanding);
    const fieldMap = collectFieldErrors(isOutstanding);

    if (errors.length > 0) {
      setValidationErrors(errors);
      setFieldErrors(fieldMap);
      setSubmissionError(errors[0]);
      toast.error(
        errors.length === 1
          ? errors[0]
          : `${errors.length} things still needed before you can post`,
      );
      // Scroll the agent straight to the checklist of what is missing —
      // a single toast is easy to miss on a small phone.
      requestAnimationFrame(() => {
        if (errorSummaryRef.current) {
          errorSummaryRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          const dialog = document.querySelector('[role="dialog"]');
          if (dialog) dialog.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
      return;
    }

    setValidationErrors([]);
    setFieldErrors({});

    // Synchronous duplicate-tap guard — refs update instantly, unlike React state.
    if (submitLockRef.current) return;
    submitLockRef.current = true;

    setLoading(true);
    setRequestState('submitting');

    try {
      // Verify session is still valid before submitting
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !session) {
        const { error: refreshError } = await supabase.auth.refreshSession();
        if (refreshError) {
          toast.error('Session expired. Please log in again to submit.');
          setLoading(false);
          return;
        }
      }
      // ===== Resolve landlord =====
      // The landlord must already exist in the system. We use the selected
      // landlord's id (from search or the Register Landlord flow) or the
      // landlord attached to the selected house — never auto-create one.
      let landlordId: string;

      // ===== Final live conflict check (fresh DB read) =====
      // High-stakes: re-verify the selected house is still available at submit
      // time so two agents can't link the same house. Never trust the cached
      // selection or the background poll alone.
      if (!isOutstanding && selectedHouse?.id) {
        const { data: freshHouse } = await supabase
          .from('house_listings')
          .select('id, status, tenant_id, reserved_at, is_hidden')
          .eq('id', selectedHouse.id)
          .maybeSingle();
        const taken =
          !freshHouse ||
          (freshHouse as any).tenant_id !== null ||
          (freshHouse as any).reserved_at !== null ||
          (freshHouse as any).is_hidden === true ||
          (freshHouse as any).status !== 'available';
        if (taken) {
          setHouseConflict(true);
          toast.error('This house was just reserved by another agent', {
            description: 'Please pick a different available house before submitting.',
          });
          setLoading(false);
          return;
        }
      }

      if (!isOutstanding && selectedHouse?.landlord_id) {
        // The agent selected an available house from the search. Its landlord is
        // already on file and the house is usable immediately — no verification
        // gate required (houses are available the moment they're listed).
        landlordId = selectedHouse.landlord_id;
      } else {
        // PRIORITY RULE: the landlord MUST already be registered in the system.
        // We never silently create a landlord from free-typed text — the agent
        // either picked an existing landlord from search or registered a new one
        // through the Register Landlord flow (which inserts the record first).
        if (selectedLandlord) {
          landlordId = selectedLandlord.id;
        } else {
          const msg = 'This landlord is not registered yet. Search to select a registered landlord, or tap "Add new" to register them before posting.';
          setSubmissionError(msg);
          toast.error('Landlord not registered', { description: msg });
          setLoading(false);
          setRequestState('idle');
          submitLockRef.current = false;
          return;
        }
      }

      // Hard guard: a rent request must always have a landlord attached.
      // Validation + the NOT NULL DB constraint already protect this, but if
      // landlord resolution somehow yields nothing we stop here with a clear
      // message instead of letting the insert fail with a cryptic DB error.
      if (!landlordId) {
        const msg = 'Select a landlord before posting this rent request.';
        setSubmissionError(msg);
        toast.error('Landlord required', { description: msg });
        setLoading(false);
        setRequestState('idle');
        submitLockRef.current = false;
        return;
      }

      // ===== Client-side landlord existence/registration check (fresh DB read) =====
      // Before posting, confirm the resolved landlord actually exists in the
      // system. The selection could be stale (e.g. the landlord was removed, or
      // the cached id is no longer valid), so we re-verify against the DB rather
      // than trusting the in-memory selection. This mirrors the server-side
      // trigger and gives the agent a clear, immediate error.
      try {
        const { data: verRows, error: landlordLookupError } = await (supabase.rpc as any)(
          'get_landlord_verification_status',
          { p_id: landlordId },
        );
        if (landlordLookupError) throw landlordLookupError;
        const landlordRow = Array.isArray(verRows) ? verRows[0] : verRows;
        if (!landlordRow || landlordRow.exists_flag === false) {
          const msg = 'This landlord is not registered in the system. Go back to the Property step and pick a registered landlord (search existing or tap "Add new" to register them) before posting.';
          setSubmissionError(msg);
          toast.error('Landlord not registered', { description: msg });
          setLoading(false);
          setRequestState('idle');
          submitLockRef.current = false;
          setDetailStep(2);
          return;
        }
        // Posting is allowed even if the landlord is not yet verified. The
        // rent request stays pending until Landlord Ops verify the landlord,
        // at which point the request is processed. We still fire a
        // verification request (below/UI) so ops know to review this landlord.
        setLandlordVerifiedAtSubmit(!!landlordRow.verified);
      } catch (lookupErr) {
        // A failed lookup (e.g. transient network) shouldn't silently pass the
        // registration gate. Stop and let the agent retry.
        const msg = "Couldn't confirm the landlord is registered. Check your connection and try again.";
        setSubmissionError(msg);
        toast.error('Landlord check failed', { description: msg });
        setLoading(false);
        setRequestState('idle');
        submitLockRef.current = false;
        return;
      }

      // ===== LC1 upsert (skipped entirely for outstanding — already linked to landlord) =====
      let lc1Id: string | null = null;
      const cleanLc1Phone = lc1Phone.replace(/\s/g, '');
      if (!isOutstanding) {
        // Posting is allowed regardless of LC1 verification status. We reuse an
        // existing LC1 record by phone (preferring a verified one) so duplicates
        // are never created; if none exists we register a new unverified LC1
        // from the free-typed details. The LC1 must be VERIFIED before the
        // request is APPROVED — that gate lives in the approval flow, not here.
        let existingLc1: { id: string; verified: boolean | null } | null = null;
        try {
          // Match on the NORMALISED phone, exactly like the duplicate-phone
          // guard in the database. An exact string match would miss a record
          // saved as +256700… when the agent types 0700…, and the insert would
          // then be rejected by that guard.
          const { data, error: lc1LookupError } = await supabase
            .rpc('find_lc1_by_phone', { p_phone: cleanLc1Phone });
          if (lc1LookupError) throw lc1LookupError;
          existingLc1 = ((data ?? [])[0] as any) ?? null;
        } catch (lc1Err) {
          const msg = "Couldn't look up the LC1 chairperson. Check your connection and try again.";
          setSubmissionError(msg);
          toast.error('LC1 lookup failed', { description: msg });
          setLoading(false);
          setRequestState('idle');
          submitLockRef.current = false;
          return;
        }
        if (existingLc1) {
          lc1Id = existingLc1.id;
        } else {
          // Register a new unverified LC1 chairperson from the typed details.
          const { data: createdLc1, error: lc1InsertError } = await supabase
            .from('lc1_chairpersons')
            .insert({
              name: lc1Name.trim(),
              phone: cleanLc1Phone,
              village: lc1Village.trim(),
              registered_by: user?.id ?? null,
              // Inherit the location already captured on this rent request so
              // the new LC1 is registered against the same official village.
              ...(() => {
                const unit = lc1LocationUnit ?? ugLocation;
                if (!unit || unit.village.trim().toLowerCase() !== lc1Village.trim().toLowerCase()) return {};
                return {
                  ug_village_id: unit.villageId,
                  parish: unit.parish,
                  sub_county: unit.subcounty,
                  county: unit.county,
                  district: normalizeDistrict(unit.district) || unit.district,
                  region: unit.region,
                  country: 'Uganda',
                };
              })(),
            })
            .select('id')
            .maybeSingle();
          if (lc1InsertError) {
            // A concurrent insert / duplicate-phone guard (23505) means the LC1
            // now exists — re-fetch and reuse it instead of failing.
            if ((lc1InsertError as any)?.code === '23505') {
              const { data: reLookup } = await supabase
                .rpc('find_lc1_by_phone', { p_phone: cleanLc1Phone });
              lc1Id = ((reLookup ?? [])[0] as any)?.id ?? null;
            }
            if (!lc1Id) {
              // Show what the database actually refused, never a blank wall.
              const raw = String((lc1InsertError as any)?.message || '').replace(/^LC1_DUPLICATE:\s*/, '');
              const isRls =
                (lc1InsertError as any)?.code === '42501' ||
                /row-level security|permission denied/i.test(raw);
              const msg = isRls
                ? 'Your session has expired. Sign in again, then post the request.'
                : raw
                  ? `Couldn't register the LC1 chairperson: ${raw}`
                  : "Couldn't register the LC1 chairperson. Check the details and try again.";
              setSubmissionError(msg);
              toast.error('LC1 registration failed', { description: msg });
              setLoading(false);
              setRequestState('idle');
              submitLockRef.current = false;
              setDetailStep(3);
              return;
            }
          } else {
            lc1Id = createdLc1?.id ?? null;
          }
        }
      }

      // Register tenant via edge function (handles both existing and new users)
      const cleanTenantPhone = tenantPhone.replace(/\s/g, '');
      const cleanNationalId = tenantNationalId.trim().toUpperCase();
      const { data: tenantResult, error: tenantRegError } = await supabase.functions.invoke('register-tenant', {
        body: {
          full_name: tenantName.trim(),
          phone: cleanTenantPhone,
          // National ID is optional in the outstanding flow.
          national_id: cleanNationalId || null,
          telemetry: await collectAgentSignupTelemetry('/agent/rent-request#outstanding-tenant', 'tenant'),
        },
      });

      if (tenantRegError) {
        console.error('Tenant registration error:', tenantRegError);
        let errorMsg = 'Failed to register tenant';
        try {
          if (tenantRegError.context?.body) {
            const text = await new Response(tenantRegError.context.body).text();
            const parsed = JSON.parse(text);
            errorMsg = parsed.error || errorMsg;
          }
        } catch {}
        setSubmissionError(errorMsg);
        toast.error(errorMsg);
        setLoading(false);
        return;
      }

      if (!tenantResult?.user_id) {
        console.error('Tenant registration returned no user_id:', tenantResult);
        const errorMsg = tenantResult?.error || 'Failed to register tenant - no user ID returned';
        setSubmissionError(errorMsg);
        toast.error(errorMsg);
        setLoading(false);
        return;
      }

      const tenantId = tenantResult.user_id;

      if (tenantResult.existing) {
        toast.info('Tenant already registered', {
          description: 'Using the existing record to continue the rent request.',
        });
      }

      // Persist the property's town/city/district/village on the tenant's
      // profile so they roll up under a real location in the Tenant Ops
      // drill-down. Best-effort — never block submission on this.
      if (!isOutstanding) {
        const profileLocation: Record<string, string> = {};
        if (propertyCity.trim()) profileLocation.city = propertyCity.trim();
        if (propertyDistrict.trim()) {
          profileLocation.district = normalizeDistrict(propertyDistrict);
        }
        if (lc1Village.trim()) profileLocation.village = lc1Village.trim();
        if (Object.keys(profileLocation).length > 0) {
          profileLocation.country = 'Uganda';
          try {
            await supabase
              .from('profiles')
              .update(profileLocation)
              .eq('id', tenantId);
          } catch (e) {
            console.warn('Failed to update tenant profile location', e);
          }
        }
      }

      // FIX #9: Use selected house category or null for outstanding
      const resolvedHouseCategory = isOutstanding
        ? (outstandingHouseCategory || null)
        : houseCategory;

      // ===== Final authoritative server-side landlord check (right before insert) =====
      // Even after the client-side existence read above, re-verify against the
      // server using a SECURITY DEFINER RPC that bypasses RLS. This is the last
      // gate before we post the rent request, so the landlord cannot slip
      // through due to a stale selection or a read masked by row-level security.
      try {
        const { data: isRegistered, error: verifyError } = await supabase
          .rpc('verify_landlord_registered', { p_landlord_id: landlordId });
        if (verifyError) throw verifyError;
        if (!isRegistered) {
          const msg = 'This landlord is not registered in the system. Go back to the Property step and pick a registered landlord (search existing or tap "Add new" to register them) before posting.';
          setSubmissionError(msg);
          toast.error('Landlord not registered', { description: msg });
          setLoading(false);
          setRequestState('idle');
          submitLockRef.current = false;
          setDetailStep(2);
          return;
        }
      } catch (verifyErr) {
        const msg = "Couldn't confirm the landlord is registered. Check your connection and try again.";
        setSubmissionError(msg);
        toast.error('Landlord check failed', { description: msg });
        setLoading(false);
        setRequestState('idle');
        submitLockRef.current = false;
        return;
      }

      // Upload the tenant passport photo BEFORE inserting the rent request.
      // The DB trigger `enforce_rent_request_tenant_photo` blocks inserts where
      // `tenant_photo_url` is null/empty, so we can't defer the upload to after
      // the insert as we used to.
      let preInsertTenantPhotoUrl: string | null = null;
      if (tenantPhoto) {
        const tempId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
          ? crypto.randomUUID()
          : `pre_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        preInsertTenantPhotoUrl = await uploadTenantPhoto(tempId, tenantId);
        if (!preInsertTenantPhotoUrl) {
          const msg = "Couldn't upload the tenant's passport photo. Check your connection and try again.";
          setSubmissionError(msg);
          toast.error('Photo upload failed', { description: msg });
          setLoading(false);
          setRequestState('idle');
          submitLockRef.current = false;
          return;
        }
      }

      const { data: rentReq, error: requestError } = await supabase
        .from('rent_requests')
        .insert({
          tenant_id: tenantId,
          agent_id: user.id,
          landlord_id: landlordId,
          lc1_id: lc1Id,
          rent_amount: fees.rentAmount,
          duration_days: fees.durationDays,
          access_fee: fees.accessFee,
          request_fee: fees.requestFee,
          total_repayment: fees.totalRepayment,
          daily_repayment: fees.dailyRepayment,
          status: 'pending',
          house_category: resolvedHouseCategory,
          preferred_language: preferredLanguage || null,
          tenant_no_smartphone: isOutstanding ? false : noSmartphone,
          request_latitude: isOutstanding ? null : (gpsLocation?.lat ?? null),
          request_longitude: isOutstanding ? null : (gpsLocation?.lng ?? null),
          agent_guarantor_consent: true,
          agent_guarantor_consent_at: new Date().toISOString(),
          agent_guarantor_consent_version: 'v1',
          tenant_photo_url: preInsertTenantPhotoUrl,
          ...(isOutstanding ? {
            registration_type: 'outstanding_balance',
            initial_outstanding_balance: amount,
            // Days remaining on the tenant's current rent period — auto-charge
            // engine defers the first arrears charge by this many days so the
            // tenant isn't double-billed (current period + arrears).
            outstanding_grace_days: outstandingDaysRemaining
              ? Math.max(0, parseInt(outstandingDaysRemaining, 10))
              : null,
          } : {}),
          // Welile auto-pays the landlord wallet on this day of the month
          landlord_payout_day: Math.min(28, Math.max(1, parseInt(landlordPayoutDay, 10) || 1)),
          landlord_payout_next_run_at: (() => {
            const day = Math.min(28, Math.max(1, parseInt(landlordPayoutDay, 10) || 1));
            const d = new Date();
            d.setUTCDate(1);
            if (new Date().getUTCDate() >= day) d.setUTCMonth(d.getUTCMonth() + 1);
            d.setUTCDate(day);
            d.setUTCHours(7, 0, 0, 0);
            return d.toISOString();
          })(),
          landlord_payout_enabled: true,
        } as any)
        .select('id')
        .single();

      if (requestError) throw requestError;

      // ===== Link the selected available house to this tenant + request =====
      // Marks the house taken (so two agents can't grab the same one) and stores
      // the house on the rent request for traceability. The `is('tenant_id', null)`
      // guard makes this a no-op if another agent claimed it first. Best-effort —
      // never blocks the rent request.
      if (!isOutstanding && selectedHouse?.id && rentReq?.id) {
        try {
          await supabase
            .from('house_listings')
            .update({ tenant_id: tenantId, status: 'occupied' } as any)
            .eq('id', selectedHouse.id)
            .is('tenant_id', null);
          await supabase
            .from('rent_requests')
            .update({ house_listing_id: selectedHouse.id } as any)
            .eq('id', rentReq.id);
        } catch (e) {
          console.warn('Failed to link selected house to rent request', e);
        }
      }

      // If this submission resolved a saved draft, mark it submitted.
      if (draftId && rentReq?.id) {
        try {
          await supabase
            .from('rent_request_drafts' as any)
            .update({ status: 'submitted', submitted_rent_request_id: rentReq.id })
            .eq('id', draftId);
        } catch (e) {
          console.warn('Failed to mark draft submitted', e);
        }
      }

      // Resolve the auto-captured draft (if any) so it doesn't linger as pending.
      if (autoDraftId && rentReq?.id) {
        try {
          await supabase
            .from('rent_request_drafts' as any)
            .update({ status: 'submitted', submitted_rent_request_id: rentReq.id })
            .eq('id', autoDraftId);
        } catch (e) {
          console.warn('Failed to mark auto-draft submitted', e);
        }
      }

      // Upload house photos if any
      if (housePhotos.length > 0 && rentReq?.id) {
        const photoUrls = await uploadHousePhotos(rentReq.id);
        if (photoUrls.length > 0) {
          await supabase
            .from('rent_requests')
            .update({ house_image_urls: photoUrls })
            .eq('id', rentReq.id);
        }
      }

      // LC letter (optional) — private bucket, path stamped on the request.
      if (lcLetter && rentReq?.id) {
        const letter = await uploadLcLetter(rentReq.id);
        if (letter) {
          await supabase
            .from('rent_requests')
            .update({ lc_letter_path: letter.path, lc_letter_bucket: letter.bucket } as any)
            .eq('id', rentReq.id);
        }
      }

      // Tenant passport photo already uploaded + stamped on the row above,
      // before the insert, to satisfy the DB tenant-photo enforcement trigger.

      // Build activation link if tenant is new
      if (!tenantResult.existing && tenantResult.activation_token) {
        const link = `${getPublicOrigin()}/join?t=${tenantResult.activation_token}`;
        setActivationLink(link);
      }

      // Auto-invite anyone who isn't a Welile user yet. As the agent saves, we
      // text the new tenant (and the landlord, if they're not registered) a
      // one-tap link to claim their own free account. Fire-and-forget — this
      // must never block or fail the rent request submission.
      try {
        const inviteRecipients: Array<{ role: 'tenant' | 'landlord'; full_name: string; phone: string; activation_token?: string }> = [];

        // Tenant: only when register-tenant created a brand-new account.
        if (!tenantResult.existing && tenantResult.activation_token && cleanTenantPhone) {
          inviteRecipients.push({
            role: 'tenant',
            full_name: tenantName.trim(),
            phone: cleanTenantPhone,
            activation_token: tenantResult.activation_token,
          });
        }

        // Landlord: the edge function checks if they're already a user and only
        // texts those who aren't. Use the picked landlord for the outstanding
        // flow, otherwise the typed-in landlord details.
        const inviteLandlordName = (isOutstanding && selectedLandlord ? selectedLandlord.name : landlordName).trim();
        const inviteLandlordPhone = ((isOutstanding && selectedLandlord ? selectedLandlord.phone : landlordPhone) || '').replace(/\s/g, '');
        if (inviteLandlordName && inviteLandlordPhone) {
          inviteRecipients.push({ role: 'landlord', full_name: inviteLandlordName, phone: inviteLandlordPhone });
        }

        if (inviteRecipients.length > 0) {
          void supabase.functions.invoke('send-signup-invite-sms', {
            body: { origin: getPublicOrigin(), recipients: inviteRecipients },
          }).catch((e) => console.warn('Signup invite SMS failed (non-critical):', e));
        }
      } catch (e) {
        console.warn('Could not queue signup invite SMS (non-critical):', e);
      }

      hapticSuccess();
      setSuccess(true);
      setRequestState('success');
      // Submitted successfully — clear the saved draft progress and landlord mode preference.
      try { localStorage.removeItem(draftStorageKey); } catch { /* ignore */ }
      try { sessionStorage.removeItem(LL_MODE_KEY); } catch { /* ignore */ }
      toast.success(incomeType === 'outstanding' ? 'Tenant registered with outstanding balance!' : 'Rent request posted successfully!');
      onSuccess?.();
    } catch (error: any) {
      setRequestState('error');
      console.error('Submission error:', error);
      const msg = error.message || 'Failed to submit request';
      setErrorDetails(
        error?.stack
          ? `${msg}\n\nStack:\n${error.stack}`
          : error?.response?.data
            ? `${msg}\n\nServer response:\n${JSON.stringify(error.response.data, null, 2)}`
            : msg
      );
      const capacityMsg = humanizeCapacityError(msg);
      // Server-side guard (DB trigger) rejected the request because the
      // landlord isn't registered. Surface a clear, actionable inline error
      // and send the agent back to the landlord step.
      const isUnregisteredLandlord =
        /registered landlord|landlord is not registered|not registered in the system|requires a registered landlord/i.test(msg);
      const isNetworkError =
        !navigator.onLine ||
        /failed to fetch|network ?error|networkrequestfailed|load failed|err_internet|err_network|fetch failed/i.test(msg);
      // The tenant already has a rejected request that is still fixable. Never
      // let the agent create a second row — send them into the resubmit path so
      // the rejection reason and history stay attached.
      const isDuplicateAfterRejection = /DUPLICATE_AFTER_REJECTION/i.test(`${msg} ${error?.hint ?? ''} ${error?.details ?? ''}`);
      const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const existingId = isDuplicateAfterRejection
        ? (uuidRe.exec(error?.hint || '')?.[0] ?? uuidRe.exec(msg)?.[0] ?? null)
        : null;
      if (isDuplicateAfterRejection) {
        const friendly = 'This tenant already has a rejected rent request. Fix the flagged detail on that request and resubmit it — creating a new one would duplicate the tenant.';
        setSubmissionError(friendly);
        toast.error('Duplicate blocked — resubmit instead', { description: friendly });
        try {
          if (!existingId) throw new Error('no request id in error');
          const { data: existing } = await supabase
            .from('rent_requests')
            .select('*')
            .eq('id', existingId)
            .maybeSingle();
          if (existing) {
            const [{ data: tenantProfile }, { data: landlordRow }] = await Promise.all([
              supabase.from('profiles').select('full_name, phone').eq('id', (existing as any).tenant_id).maybeSingle(),
              (existing as any).landlord_id
                ? supabase.from('landlords').select('name, address').eq('id', (existing as any).landlord_id).maybeSingle()
                : Promise.resolve({ data: null } as any),
            ]);
            setResubmitTarget({
              ...(existing as any),
              reopen_count: Number((existing as any).reopen_count || 0),
              tenant_name: tenantProfile?.full_name ?? 'Tenant',
              tenant_phone: tenantProfile?.phone ?? undefined,
              landlord_name: (landlordRow as any)?.name ?? '—',
              landlord_address: (landlordRow as any)?.address ?? undefined,
              reviewer_name: 'Reviewer',
              stage_label: STAGE_LABEL[(existing as any).rejected_at_stage ?? 'pending'] ?? 'Reviewer',
            } as AgentRejectedRequest);
          }
        } catch (loadErr) {
          console.error('[rent-request] could not load rejected row for resubmit', loadErr);
        }
      } else if (isNetworkError) {
        const friendly = 'Connection dropped before we could send it. Don\'t worry — your draft is saved. Reconnect and tap Submit again.';
        setSubmissionError(friendly);
        toast.warning('Connection lost', { description: 'Your draft is saved. Try again when you\'re back online.' });
      } else if (isUnregisteredLandlord) {
        const friendly = 'This landlord is not registered in the system. Go back to the Property step and pick a registered landlord (search existing or tap "Add new" to register them) before posting.';
        setSubmissionError(friendly);
        toast.error('Landlord not registered', { description: friendly });
        // Jump the wizard back to the Property/landlord step so the fix is obvious.
        if (incomeType !== 'outstanding') setDetailStep(2);
      } else if (capacityMsg) {
        setSubmissionError(capacityMsg);
        toast.error('Rent capacity reached', { description: capacityMsg });
      } else if (msg.includes('row-level security') || msg.includes('RLS')) {
        const friendly = 'Permission denied — your session may have expired. Please log out and log in again.';
        setSubmissionError(friendly);
        toast.error(friendly);
      } else {
        setSubmissionError(msg);
        toast.error(msg);
      }
    } finally {
      setLoading(false);
      submitLockRef.current = false;
    }
  };

  // Keep a live reference to the latest handleSubmit so the queued-submit
  // effect always fires the current closure (never a stale snapshot of form
  // state) when capacity / auto-save finish.
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  // True while the submit must wait: capacity still loading on first open, or a
  // draft auto-save is in flight. These are the two transient states that made
  // the button briefly feel "unpressable".
  const submitWaiting = capLoading || autoDraftStatus === 'saving';

  /**
   * Submit entry point used by every Submit button. If the form isn't ready
   * yet (capacity loading / auto-saving) we QUEUE the submit instead of
   * dropping it, then flush automatically once ready (see effect below).
   */
  const requestSubmit = useCallback(() => {
    if (loading) return; // a real submission is already running
    if (submitWaiting) {
      setSubmitQueued(true);
      setQueueStatus('queued');
      toast.info('Finishing save…', {
        description: 'Your request will submit automatically in a moment. Tap again to cancel.',
      });
      return;
    }
    handleSubmitRef.current();
  }, [loading, submitWaiting]);

  /** Cancels a queued submit so the agent can stop an unintended submission
   *  while auto-save or capacity is still finishing. */
  const cancelQueuedSubmit = useCallback(() => {
    setSubmitQueued(false);
    setQueueStatus('cancelling');
    toast('Submit cancelled', {
      description: 'Your draft is still saved. Tap Submit when you are ready.',
    });
    window.setTimeout(() => setQueueStatus('idle'), 900);
  }, []);

  /** Opens the confirmation dialog before actually cancelling a queued submit. */
  const promptCancelQueued = useCallback(() => {
    setShowCancelConfirm(true);
  }, []);

  // Flush a queued submit the moment capacity + auto-save settle. A safety
  // timeout fires the submit anyway after 8s so a stuck refetch never strands
  // the agent (handleSubmit tolerates a missing capacity snapshot).
  useEffect(() => {
    if (!submitQueued || loading) return;
    if (!submitWaiting) {
      setSubmitQueued(false);
      setQueueStatus('ready');
      handleSubmitRef.current();
      return;
    }
    const t = setTimeout(() => {
      setSubmitQueued(false);
      setQueueStatus('ready');
      handleSubmitRef.current();
    }, 8000);
    return () => clearTimeout(t);
  }, [submitQueued, submitWaiting, loading]);

  const getPeriodLabel = (period: RepaymentPeriod) => {
    switch (period) {
      case '30': return '30 Days (1 Month)';
      case '120': return '120 Days (4 Months)';
    }
    const days = parseInt(period, 10);
    if (!Number.isFinite(days) || days <= 0) return period;
    const weeks = Math.round(days / 7);
    if (days % 7 === 0 && weeks > 0) {
      if (weeks === 52) return `${days} Days (52 Weeks · 1 Year)`;
      return `${days} Days (${weeks} Week${weeks > 1 ? 's' : ''})`;
    }
    return `${days} Days`;
  };

  // FIX #5: Outstanding min = 50,000 (matches regular flow)
  const outstandingMinAmount = 50000;

  // ---- Blank field-form PDF: preview, then download / share ----
  const fieldFormFileName = `rent-request-field-form-${format(new Date(), 'yyyy-MM-dd')}.pdf`;

  const buildFieldFormBlob = useCallback(async () => {
    return generateRentRequestFormPdf({
      agentName:
        (user?.user_metadata as any)?.full_name ||
        (user?.user_metadata as any)?.name ||
        null,
      agentPhone: (user?.user_metadata as any)?.phone || user?.phone || null,
    });
  }, [user]);

  const openFieldFormPreview = useCallback(async () => {
    setFieldFormGenerating(true);
    try {
      const blob = await buildFieldFormBlob();
      const url = URL.createObjectURL(blob);
      setFieldFormBlob(blob);
      setFieldFormPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      setFieldFormPreviewOpen(true);
    } catch {
      toast.error('Could not generate the form. Please try again.');
    } finally {
      setFieldFormGenerating(false);
    }
  }, [buildFieldFormBlob]);

  const closeFieldFormPreview = useCallback(() => {
    setFieldFormPreviewOpen(false);
    setFieldFormPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setFieldFormBlob(null);
  }, []);

  const downloadFieldForm = useCallback(() => {
    if (!fieldFormBlob) return;
    const url = URL.createObjectURL(fieldFormBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fieldFormFileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [fieldFormBlob, fieldFormFileName]);

  const shareFieldForm = useCallback(async () => {
    if (!fieldFormBlob) return;
    try {
      const file = new File([fieldFormBlob], fieldFormFileName, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'Rent Request Field Form',
          text: `Field form for ${(user?.user_metadata as any)?.full_name || 'agent'} — print, fill in the field, then post in the app.`,
        });
      } else {
        downloadFieldForm();
        toast.info('PDF downloaded. Open your file manager and share it to WhatsApp.');
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      toast.error('Could not share the form. Please try again.');
    }
  }, [fieldFormBlob, fieldFormFileName, user, downloadFieldForm]);

  // On phones the embedded PDF iframe is cramped / often blank (iOS Safari).
  // Let the agent pop it open full-screen in a new tab instead.
  const openFieldFormFullScreen = useCallback(() => {
    if (!fieldFormPreviewUrl) return;
    const win = window.open(fieldFormPreviewUrl, '_blank');
    if (!win) {
      downloadFieldForm();
      toast.info('PDF downloaded. Open it from your downloads to view full screen.');
    }
  }, [fieldFormPreviewUrl, downloadFieldForm]);

  return (
    <>
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] sm:w-full sm:max-w-md max-h-[88vh] overflow-x-hidden overflow-y-auto pb-[calc(env(safe-area-inset-bottom,0px)+96px)] sm:pb-6 overscroll-contain">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <FileText className="h-5 w-5" />
            </span>
            <span className="text-lg font-bold tracking-tight">Post Rent Request</span>
          </DialogTitle>
          <DialogDescription className="text-sm">
            Submit a rent request on behalf of a tenant who doesn't have the app
          </DialogDescription>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 w-full gap-2"
            disabled={fieldFormGenerating}
            onClick={openFieldFormPreview}
          >
            {fieldFormGenerating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileText className="h-4 w-4" />
            )}
            Preview blank field form
          </Button>
        </DialogHeader>

        <RequestStateBanner state={requestState} />

        <QueuedSubmitBanner status={queueStatus} />

        {!isOnline && !success && (
          <div className="flex items-start gap-2 rounded-xl border-2 border-warning/50 bg-warning/10 p-3 text-warning-foreground">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-warning" />
            <p className="text-xs leading-relaxed">
              <span className="font-semibold">No internet right now.</span> Keep filling in the form —
              your progress is saved automatically and nothing will be lost. You can submit once you reconnect.
            </p>
          </div>
        )}

        <AnimatePresence mode="wait">
          {success ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="py-6 text-center space-y-4"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20, delay: 0.1 }}
                className="w-16 h-16 mx-auto rounded-full bg-success/20 flex items-center justify-center"
              >
                <CheckCircle2 className="h-8 w-8 text-success" />
              </motion.div>
              <h3 className="text-lg font-semibold">
                {incomeType === 'outstanding' ? 'Tenant Registered!' : 'Request Posted!'}
              </h3>
              <p className="text-muted-foreground text-sm">
                {incomeType === 'outstanding'
                  ? `Outstanding balance of ${formatUGX(amount)} recorded for ${tenantName}. Now active in your Owing tab — no approval needed.`
                  : 'The rent request is now visible to supporters'}
              </p>

              {/* Landlord verification status — only for the standard rent flow */}
              {incomeType !== 'outstanding' && (
                landlordVerifiedAtSubmit ? (
                  <div className="mx-auto max-w-xs flex items-center gap-2 rounded-xl border border-success/30 bg-success/10 px-3 py-2.5 text-left text-xs text-success">
                    <ShieldCheck className="h-4 w-4 shrink-0" />
                    <span className="font-medium">Landlord verified</span>
                  </div>
                ) : (
                  <div className="mx-auto max-w-xs flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-left text-xs text-warning">
                    <Loader2 className="h-4 w-4 shrink-0 mt-0.5 animate-spin" />
                    <span>
                      <span className="font-semibold">Landlord verification pending.</span>{' '}
                      Landlord Ops will verify the landlord &amp; property. The request continues through review in the meantime.
                    </span>
                  </div>
                )
              )}
              {incomeType === 'outstanding' && (
                <div className="mx-auto mt-2 p-3 rounded-xl bg-warning/10 border border-warning/20 text-left space-y-1 max-w-xs">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Tenant</span>
                    <span className="font-semibold">{tenantName}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Balance</span>
                    <span className="font-bold text-warning">{formatUGX(amount)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Duration</span>
                    <span className="font-semibold">{duration} days</span>
                  </div>
                </div>
              )}

              {/* Activation Link Section */}
              {activationLink && (
                <div className="space-y-3 pt-2">
                  <Separator />
                  <div className="p-3 rounded-xl bg-primary/5 border border-primary/20 text-left space-y-2">
                    <p className="text-xs font-medium text-primary flex items-center gap-1.5">
                      <Share2 className="h-3.5 w-3.5" />
                      Tenant Activation Link
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Share this link with <strong>{tenantName}</strong> so they can activate their account when they get a smartphone.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 gap-1.5 text-xs"
                        onClick={() => {
                          navigator.clipboard.writeText(activationLink);
                          toast.success('Link copied!');
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        Copy Link
                      </Button>
                      <Button
                        size="sm"
                        className="flex-1 gap-1.5 text-xs bg-[#25D366] hover:bg-[#20BD5A] text-white"
                        onClick={() => {
                          const message = `Hi ${tenantName}! 👋\n\nYour rent request has been submitted on Welile. When you get a smartphone, tap this link to activate your account:\n\n${activationLink}\n\nYou'll be able to track your rent status and make payments.`;
                          const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
                          window.open(whatsappUrl, '_blank');
                        }}
                      >
                        <MessageCircle className="h-3.5 w-3.5" />
                        Share on WhatsApp
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              <Button onClick={() => handleOpenChange(false)} className="w-full mt-2">
                Done
              </Button>
            </motion.div>
          ) : step === 'type' ? (
            <motion.div
              key="type"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-4 py-2"
            >
              <p className="text-sm text-muted-foreground text-center">
                How does this tenant earn income?
              </p>
              
              <div className="grid gap-3">
                <button
                  onClick={() => {
                    setIncomeType('daily');
                    setDetailStep(0);
                    setValidationErrors([]);
                    setFieldErrors({});
                    setStep('details');
                  }}
                  className="p-4 rounded-xl border-2 border-muted hover:border-primary hover:bg-primary/5 transition-all text-left group active:scale-[0.98]"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-3 rounded-lg bg-primary/10 group-hover:bg-primary/20">
                      <Calendar className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <p className="font-semibold">Daily Income Earner</p>
                      <p className="text-xs text-muted-foreground">Pays back daily over 30-90 days</p>
                    </div>
                  </div>
                </button>
                
                <button
                  onClick={() => {
                    setIncomeType('weekly-monthly');
                    setEarnerCycle('weekly');
                    setRepaymentPeriod('7');
                    setDetailStep(0);
                    setValidationErrors([]);
                    setFieldErrors({});
                    setStep('details');
                  }}
                  className="p-4 rounded-xl border-2 border-muted hover:border-success hover:bg-success/5 transition-all text-left group active:scale-[0.98]"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-3 rounded-lg bg-success/10 group-hover:bg-success/20">
                      <Banknote className="h-5 w-5 text-success" />
                    </div>
                    <div>
                      <p className="font-semibold">Weekly Earner</p>
                      <p className="text-xs text-muted-foreground">Pays back in 1-3 weeks</p>
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => {
                    setIncomeType('weekly-monthly');
                    setEarnerCycle('monthly');
                    setRepaymentPeriod('30');
                    setDetailStep(0);
                    setValidationErrors([]);
                    setFieldErrors({});
                    setStep('details');
                  }}
                  className="p-4 rounded-xl border-2 border-muted hover:border-success hover:bg-success/5 transition-all text-left group active:scale-[0.98]"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-3 rounded-lg bg-success/10 group-hover:bg-success/20">
                      <Calendar className="h-5 w-5 text-success" />
                    </div>
                    <div>
                      <p className="font-semibold">Monthly Earner</p>
                      <p className="text-xs text-muted-foreground">Pays back after 1 month or 4 months</p>
                    </div>
                  </div>
                </button>

              </div>
            </motion.div>
          ) : step === 'details' ? (
            <motion.div
              key="details"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="min-w-0 break-words space-y-4 [&_label]:text-[15px] [&_label]:font-bold [&_input]:h-12 [&_input]:text-base [&_[role=combobox]]:h-12 [&_[role=combobox]]:text-base"
            >
              {/* Guided wizard progress (standard flow only) */}
              {incomeType !== 'outstanding' && (
                <div className="space-y-4 select-none">
                  {/* Clean step rail — one refined icon per step, joined by a thin track */}
                  <div className="flex items-start">
                    {DETAIL_STEP_META.map((meta, idx) => {
                      const Icon = meta.icon;
                      const isDone = idx < detailStep;
                      const isActive = idx === detailStep;
                      const reachable = idx <= detailStep;
                      return (
                        <div key={meta.label} className="flex flex-col items-center flex-1 min-w-0">
                          <div className="flex w-full items-center">
                            {/* left connector */}
                            <span
                              aria-hidden="true"
                              className={`h-0.5 flex-1 rounded-full ${idx === 0 ? 'opacity-0' : isDone || isActive ? 'bg-primary' : 'bg-border'}`}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                if (reachable) {
                                  setDetailStep(idx);
                                  scrollDialogTop();
                                }
                              }}
                              className={`
                                relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full
                                transition-all active:scale-[0.94]
                                ${isActive
                                  ? 'bg-primary text-primary-foreground ring-4 ring-primary/15 shadow-sm'
                                  : isDone
                                  ? 'bg-primary/10 text-primary'
                                  : 'bg-muted text-muted-foreground/70'}
                                ${reachable ? 'cursor-pointer' : 'cursor-default'}
                              `}
                              aria-current={isActive ? 'step' : undefined}
                              aria-label={`${meta.label}${isActive ? ' — current step' : isDone ? ' — completed' : ''}`}
                            >
                              {isDone
                                ? <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                                : <Icon className="h-5 w-5" aria-hidden="true" />}
                            </button>
                            {/* right connector */}
                            <span
                              aria-hidden="true"
                              className={`h-0.5 flex-1 rounded-full ${idx === DETAIL_STEP_META.length - 1 ? 'opacity-0' : isDone ? 'bg-primary' : 'bg-border'}`}
                            />
                          </div>
                          <span className={`mt-1.5 text-[10px] font-semibold uppercase tracking-wide truncate w-full text-center ${isActive ? 'text-primary' : isDone ? 'text-foreground' : 'text-muted-foreground/70'}`}>
                            {meta.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Step heading + percent */}
                  <div className="flex items-end justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Step {detailStep + 1} of {DETAIL_STEPS.length}
                      </p>
                      <h3 className="text-xl font-bold tracking-tight text-foreground truncate">
                        {DETAIL_STEPS[detailStep]}
                      </h3>
                    </div>
                    <span className="text-sm font-bold text-primary whitespace-nowrap">
                      {Math.round(((detailStep + 1) / DETAIL_STEPS.length) * 100)}%
                    </span>
                  </div>

                  {/* Slim progress bar */}
                  <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-500 rounded-full"
                      style={{ width: `${((detailStep + 1) / DETAIL_STEPS.length) * 100}%` }}
                    />
                  </div>

                </div>
              )}

              {/* Agent rent exposure capacity (100M UGX cap) */}
              {(incomeType === 'outstanding' || detailStep === 0) && (
                <AgentCapacityBanner agentId={user?.id} />
              )}

              {/* Auto-capture status — confirms the request is saved the moment
                  tenant name + amount exist, so the agent never has to wonder
                  whether their submit went through. */}
              {tenantName.trim() && amount > 0 && (
                <div
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ${
                    autoDraftStatus === 'error'
                      ? 'border-destructive/40 bg-destructive/10 text-destructive'
                      : autoDraftStatus === 'saved'
                      ? 'border-success/40 bg-success/10 text-success'
                      : 'border-primary/30 bg-primary/10 text-primary'
                  }`}
                >
                  {autoDraftStatus === 'saving' || autoDraftStatus === 'idle' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
                      <span>Capturing this request…</span>
                    </>
                  ) : autoDraftStatus === 'saved' ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                      <span>Captured ✓ — your request is saved. Keep adding the other details below.</span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                      <span>Couldn&apos;t auto-save yet — check your connection. Your typed progress is still kept.</span>
                    </>
                  )}
                </div>
              )}


              {/* ===== 1. RENT DETAILS — PRIMARY SECTION ===== */}
              {incomeType === 'outstanding' ? (
                <>
                  {/* Warning banner */}
                  <div className="p-3 rounded-xl border border-primary/20 bg-primary/5">
                    <p className="text-xs font-medium text-primary">
                      ⚠️ Outstanding balance is stored exactly as typed — no access fee, no platform fee, no recalculation. Tenant goes live in your Owing tab immediately (no approval).
                    </p>
                  </div>

                  {/* 🏠 Select Landlord (debounced search) */}
                  <div className="space-y-3 p-4 rounded-2xl border border-border/60 bg-muted/30">
                    <h4 className="text-sm font-semibold flex items-center gap-2 text-foreground">
                      <Building2 className="h-4 w-4 text-primary" />
                      🏠 Select Landlord
                    </h4>
                    <p className="text-[11px] text-muted-foreground -mt-1">
                      LC1 is already linked to the landlord — no need to add it again.
                    </p>
                    <LandlordSearchSelect
                      key={landlordPickerKey}
                      value={selectedLandlord}
                      onChange={setSelectedLandlord}
                    />
                    {selectedLandlord?.property_address && (
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                        <MapPin className="h-3 w-3" /> {selectedLandlord.property_address}
                      </p>
                    )}
                    {!selectedLandlord && hasFieldError('landlord') && (
                      <FieldError message="Select a landlord before posting this rent request." />
                    )}
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <p className="text-[11px] text-muted-foreground">
                        No landlord to select?
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        onClick={() => {
                          if (!guardListingHours()) return;
                          setShowListHouse(true);
                        }}
                      >
                        <Home className="h-3.5 w-3.5 mr-1" />
                        List a house
                      </Button>
                    </div>
                  </div>

                  {/* 👤 Tenant Personal Information */}
                  <div className="space-y-3 p-4 rounded-2xl border border-border/60 bg-muted/30">
                    <h4 className="text-sm font-semibold flex items-center gap-2 text-foreground">
                      <User className="h-4 w-4 text-primary" />
                      👤 Personal Information
                    </h4>
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <Label >Tenant Name *</Label>
                        <p className="text-xs text-muted-foreground leading-snug">The tenant's name as on their ID.</p>
                        <p className="text-[11px] text-muted-foreground">e.g. John Mukasa</p>
                        <PersonNameFields
                          idPrefix="rent-req-tenant-a"
                          value={tenantNameParts}
                          onChange={setTenantNameParts}
                        />
                        <FieldError message={vName(tenantName) || getFieldError('tenantName')} />
                        <TenantDuplicateNotice
                          match={existingTenantByName}
                          checking={checkingTenantName}
                          field="name"
                          onUse={useExistingTenantMatch}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label >Tenant Phone *</Label>

                        <p className="text-xs text-muted-foreground leading-snug">The number they answer calls on.</p>
                        <p className="text-[11px] text-muted-foreground">e.g. 0783 123 456</p>
                        <Input
                          value={tenantPhone}
                          onChange={(e) => setTenantPhone(formatPhoneInput(e.target.value))}
                          placeholder="0783 123 456"
                          className={`h-10 ${hasFieldError('tenantPhone') ? 'border-destructive border-2' : ''}`}
                          maxLength={12}
                          required
                        />
                        <FieldError message={vPhone(tenantPhone) || getFieldError('tenantPhone')} />
                        <ExistingTenantPhoneNotice
                          match={existingTenantByPhone}
                          checking={checkingTenantPhone}
                          onUse={useExistingTenantMatch}
                          onRenew={renewExistingTenant}
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <Label >Preferred Language *</Label>
                      <p className="text-xs text-muted-foreground leading-snug">The language the tenant understands best.</p>
                      <p className="text-[11px] text-muted-foreground">e.g. Luganda</p>
                      <Select value={preferredLanguage} onValueChange={setPreferredLanguage}>
                        <SelectTrigger className={`${hasFieldError('preferredLanguage') ? 'border-destructive border-2' : ''}`}>
                          <SelectValue placeholder="Select tenant language" />
                        </SelectTrigger>
                        <SelectContent>
                          {PREFERRED_LANGUAGES.map((l) => (
                            <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FieldError message={getFieldError('preferredLanguage')} />
                    </div>
                  </div>

                  {/* 💰 Rent Information */}
                  <div className="space-y-3 p-4 rounded-2xl border border-border/60 bg-muted/30">
                    <h4 className="text-sm font-semibold flex items-center gap-2 text-foreground">
                      <Banknote className="h-4 w-4 text-primary" />
                      💰 Rent Information
                    </h4>

                    <div className="space-y-3">
                      <div className="space-y-1">
                        <Label className="font-semibold">Rent Amount (UGX) *</Label>
                        <p className="text-xs text-muted-foreground leading-snug">The full monthly rent for this house.</p>
                        <p className="text-[11px] text-muted-foreground">e.g. 300,000 UGX per month</p>
                        <Input
                          value={formatCurrencyInput(outstandingRentAmount)}
                          onChange={(e) => setOutstandingRentAmount(e.target.value.replace(/[^0-9]/g, ''))}
                          placeholder="e.g. 300,000"
                          className={`${hasFieldError('outstandingRentAmount') ? 'border-destructive border-2' : ''}`}
                          required
                        />
                        <FieldError message={vAmount(outstandingRentAmount) || getFieldError('outstandingRentAmount')} />
                      </div>
                      <div className="space-y-1">
                        <Label className="font-semibold">Repayment Duration *</Label>
                        <p className="text-xs text-muted-foreground leading-snug">How many days the tenant has to pay it back.</p>
                        <p className="text-[11px] text-muted-foreground">e.g. 30 days</p>
                        <Select value={duration} onValueChange={(v) => setDuration(v as '30' | '60' | '90')}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="30">30 Days</SelectItem>
                            <SelectItem value="60">60 Days</SelectItem>
                            <SelectItem value="90">90 Days</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <Label className="font-semibold">Outstanding Balance (UGX) *</Label>
                      <p className="text-xs text-muted-foreground leading-snug">How much rent the tenant still owes right now.</p>
                        <p className="text-[11px] text-muted-foreground">e.g. 150,000 UGX</p>
                      <Input
                        value={formatCurrencyInput(outstandingBalance)}
                        onChange={(e) => setOutstandingBalance(e.target.value.replace(/[^0-9]/g, ''))}
                        placeholder="Enter amount"
                        className={`h-12 text-lg font-bold rounded-xl border-input focus-visible:border-primary ${hasFieldError('outstandingBalance') ? 'border-destructive border-2' : ''}`}
                        required
                      />
                      <FieldError message={vAmount(outstandingBalance) || getFieldError('outstandingBalance')} />
                      {amount > 0 && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Daily repayment: <span className="font-semibold">{formatUGX(Math.ceil(amount / parseInt(duration)))}/day</span> for {duration} days
                        </p>
                      )}
                    </div>

                    <div className="space-y-1">
                      <Label className="font-semibold">Days Remaining *</Label>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        value={outstandingDaysRemaining}
                        onChange={(e) => setOutstandingDaysRemaining(e.target.value.replace(/[^0-9]/g, ''))}
                        placeholder="Days left on current rent period"
                        className={`${hasFieldError('outstandingDaysRemaining') ? 'border-destructive border-2' : ''}`}
                        required
                      />
                      <FieldError message={vDays(outstandingDaysRemaining) || getFieldError('outstandingDaysRemaining')} />
                    </div>

                    <div className="space-y-1">
                      <Label className="font-semibold">House Type *</Label>
                      <Select value={outstandingHouseCategory} onValueChange={setOutstandingHouseCategory}>
                        <SelectTrigger className={`${hasFieldError('outstandingHouseCategory') ? 'border-destructive border-2' : ''}`}>
                          <SelectValue placeholder="Select house type" />
                        </SelectTrigger>
                        <SelectContent>
                          {HOUSE_CATEGORIES.map(cat => (
                            <SelectItem key={cat.value} value={cat.value}>
                              {cat.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FieldError message={getFieldError('outstandingHouseCategory')} />
                    </div>
                  </div>

                  {/* FIX #2: Add GuarantorConsentCheckbox to outstanding flow */}
                  <GuarantorConsentCheckbox checked={guarantorConsent} onCheckedChange={setGuarantorConsent} />

                  {/* Validation Error Summary */}
                  {validationErrors.length > 0 && (
                    <div ref={errorSummaryRef} className="p-4 rounded-2xl bg-destructive/10 border-2 border-destructive/40 space-y-3 scroll-mt-4">
                      <p className="text-base font-extrabold text-destructive flex items-center gap-2">
                        <AlertTriangle className="h-5 w-5 flex-shrink-0" />
                        {validationErrors.length} thing{validationErrors.length > 1 ? 's' : ''} still needed
                      </p>
                      <ul className="space-y-2">
                        {validationErrors.map((err, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm font-semibold text-destructive">
                            <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[11px] font-bold">{i + 1}</span>
                            <span>{err}</span>
                          </li>
                        ))}
                      </ul>
                      {landlordCheck === 'unverified' && (
                        <div className="pt-1">
                          {verifyReqState === 'sent' || verifyReqState === 'exists' ? (
                            <p className="text-xs font-medium text-success flex items-center gap-1">
                              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                              Verification request sent to Landlord Operations — you&apos;ll be able to post once they verify this landlord.
                            </p>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-9 w-full gap-1.5 rounded-xl border-amber-500/40 text-amber-700 hover:bg-amber-50"
                              disabled={verifyReqState === 'sending'}
                              onClick={requestLandlordVerification}
                            >
                              {verifyReqState === 'sending' ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <ShieldCheck className="h-3.5 w-3.5" />
                              )}
                              Request verification from Landlord Ops
                            </Button>
                          )}
                        </div>
                      )}
                      <p className="text-xs text-destructive/80">Fix these, then press the button again.</p>
                    </div>
                  )}

                  {submissionError && validationErrors.length === 0 && (
                    <div ref={errorSummaryRef} className="p-4 rounded-2xl bg-destructive/10 border-2 border-destructive/40 space-y-3 scroll-mt-4">
                      <div className="flex items-start gap-2 text-sm font-semibold text-destructive">
                        <AlertTriangle className="h-5 w-5 mt-0.5 flex-shrink-0" />
                        <span>{submissionError}</span>
                      </div>
                      <p className="text-xs text-destructive/80">
                        Everything you typed is still here — just tap to try again.
                      </p>
                      <Button
                        type="button"
                        onClick={submitQueued ? promptCancelQueued : requestSubmit}
                        disabled={loading}
                        variant={submitQueued ? 'secondary' : 'destructive'}
                        className="w-full"
                      >
                        {loading ? (
                          <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Trying again…</>
                        ) : submitQueued ? (
                          <><X className="h-4 w-4 mr-2" />Cancel submit</>
                        ) : (
                          <><RefreshCw className="h-4 w-4 mr-2" />Try again</>
                        )}
                      </Button>
                      {errorDetails && (
                        <Accordion type="single" collapsible className="w-full">
                          <AccordionItem value="error-details" className="border-0">
                            <AccordionTrigger className="text-xs text-destructive/80 hover:no-underline py-2">
                              View technical details
                            </AccordionTrigger>
                            <AccordionContent>
                              <pre className="text-[11px] leading-relaxed whitespace-pre-wrap bg-destructive/5 rounded-lg p-3 text-destructive/90 font-mono">
                                {errorDetails}
                              </pre>
                            </AccordionContent>
                          </AccordionItem>
                        </Accordion>
                      )}
                    </div>
                  )}

                  {/* Submit button for outstanding mode */}
                  <div className="flex gap-3 pt-2">
                    <Button 
                      type="button" 
                      variant="outline" 
                      onClick={() => { setStep('type'); setValidationErrors([]); setFieldErrors({}); }}
                      className="flex-1"
                    >
                      Back
                    </Button>
                    <Button 
                      onClick={submitQueued ? promptCancelQueued : requestSubmit}
                      className="flex-1"
                      variant={submitQueued ? 'secondary' : 'default'}
                      disabled={loading || (incomeType !== 'outstanding' && amount <= 0)}
                    >
                      {loading ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Submitting...
                        </>
                      ) : submitQueued ? (
                        <>
                          <X className="h-4 w-4 mr-2" />
                          Cancel submit
                        </>
                      ) : (
                        'Register Tenant'
                      )}
                    </Button>
                  </div>
                  {loading && (
                    <p
                      role="status"
                      aria-live="polite"
                      className="flex items-center justify-center gap-2 pt-2 text-sm font-semibold text-primary"
                    >
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Sending your request… please wait.
                    </p>
                  )}
                </>
              ) : detailStep === 0 ? (
              <>
              <div className="space-y-3 p-4 rounded-2xl bg-primary/10 border-2 border-primary/40">
                <h4 className="text-base font-extrabold text-primary flex items-center gap-2">
                  <div className="p-2 rounded-xl bg-primary/20">
                    <Calculator className="h-5 w-5 text-primary" />
                  </div>
                  💰 Rent Details
                </h4>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label className="font-semibold text-primary/80">
                      {incomeType === 'weekly-monthly' && earnerCycle === 'weekly'
                        ? '1 Month Rent (UGX) *'
                        : 'Rent Amount (UGX) *'}
                    </Label>
                    <p className="text-[10px] font-bold text-primary/60 italic">
                      {incomeType === 'weekly-monthly' && earnerCycle === 'weekly'
                        ? 'Enter the 1 month rent only \u2014 Welile pays the landlord this every month; the tenant repays weekly at the 1 month rate'
                        : 'Let Welile pay this today'}
                    </p>
                    {/* FIX #7: Currency formatting */}
                    <div className="relative">
                      <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm font-extrabold text-primary/60">
                        UGX
                      </span>
                      <Input
                        inputMode="numeric"
                        value={formatCurrencyInput(rentAmount)}
                        onChange={(e) => setRentAmount(e.target.value.replace(/[^0-9]/g, ''))}
                        placeholder="500,000"
                        className={`h-12 pl-14 text-lg font-bold border-2 border-primary/30 focus:border-primary rounded-xl ${hasFieldError('rentAmount') ? 'border-destructive' : ''}`}
                        required
                      />
                    </div>
                    <FieldError
                      message={
                        incomeType === 'weekly-monthly' && earnerCycle === 'weekly'
                          ? vRentNeed(rentAmount) || getFieldError('rentAmount')
                          : vAmount(rentAmount) || getFieldError('rentAmount')
                      }
                    />
                    {amount > 0 && (
                      <p className="text-xs font-semibold">
                        {unlimitedPosting ? (
                          <span className="text-success">
                            ✅ Unlimited posting unlocked — you can post <span className="font-extrabold">any amount</span> this week.
                          </span>
                        ) : amount > perTenantMax ? (
                          <span className="text-amber-600 dark:text-amber-400">
                            You are <span className="font-extrabold">{formatUGX(amount - perTenantMax)}</span> over your <span className="font-extrabold">{formatUGX(perTenantMax)}</span> posting cap.
                          </span>
                        ) : amount === perTenantMax ? (
                          <span className="text-success">
                            You are exactly at your <span className="font-extrabold">{formatUGX(perTenantMax)}</span> posting cap.
                          </span>
                        ) : (
                          <span className="text-success">
                            You are <span className="font-extrabold">{formatUGX(perTenantMax - amount)}</span> under your <span className="font-extrabold">{formatUGX(perTenantMax)}</span> posting cap.
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                  {/* Weekly repayment auto-calc: (rent + 33%) ÷ 4 */}
                  {incomeType === 'weekly-monthly' && earnerCycle === 'weekly' && amount > 0 && (
                    <div className="p-4 rounded-2xl bg-success/10 border-2 border-success/40 text-center space-y-1">
                      <p className="text-xs text-success/80 font-medium">Weekly repayment</p>
                      <p className="text-3xl font-black text-success font-mono">
                        {formatUGX(Math.ceil((amount * 1.33) / 4))}<span className="text-base font-bold">/week</span>
                      </p>
                      <p className="text-[11px] text-success/70 font-medium">
                        {formatUGX(amount)} (1 month) + 33% = {formatUGX(Math.round(amount * 1.33))}, divided by 4 weeks
                      </p>
                      <p className="text-[10px] text-success/60 font-medium pt-1">
                        Welile pays the landlord {formatUGX(amount)} every month. Extra weeks just extend how long Welile keeps paying — the weekly rate stays the same.
                      </p>
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label className="font-semibold text-primary/80">
                      {incomeType === 'daily' ? 'Duration' : earnerCycle === 'monthly' ? 'Monthly Repayment Period' : 'Weekly Repayment Period'} *
                    </Label>
                    <p className="text-[10px] text-muted-foreground">
                      {incomeType === 'daily'
                        ? 'tenant will take to repay.'
                        : 'Select the repayment cycle length for this tenant.'}
                    </p>
                    {incomeType === 'daily' ? (
                      <Select value={duration} onValueChange={(v) => setDuration(v as '30' | '60' | '90')}>
                        <SelectTrigger className="h-12 text-base font-semibold border-2 border-primary/30 rounded-xl"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="30">30 Days</SelectItem>
                          <SelectItem value="60">60 Days</SelectItem>
                          <SelectItem value="90">90 Days</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select value={repaymentPeriod} onValueChange={(v) => setRepaymentPeriod(v as RepaymentPeriod)}>
                        <SelectTrigger className="h-12 text-base font-semibold border-2 border-primary/30 rounded-xl"><SelectValue /></SelectTrigger>
                        <SelectContent className="max-h-72">
                          {earnerCycle === 'weekly' ? (
                            Array.from({ length: 52 }, (_, i) => i + 1).map((w) => (
                              <SelectItem key={w} value={String(w * 7)}>
                                {w} Week{w > 1 ? 's' : ''} ({w * 7} Days){w === 52 ? ' · 1 Year' : ''}
                              </SelectItem>
                            ))
                          ) : (
                            <>
                              <SelectItem value="30">30 Days (1 Month)</SelectItem>
                              <SelectItem value="120">120 Days (4 Months)</SelectItem>
                            </>
                          )}
                        </SelectContent>
                      </Select>
                    )}
                    {earnerCycle === 'weekly' && incomeType !== 'daily' && (
                      <Button
                        type="button"
                        variant={repaymentPeriod === '364' ? 'default' : 'outline'}
                        onClick={() => setRepaymentPeriod('364')}
                        className="w-full mt-2 h-11 rounded-xl font-bold border-2 border-primary/40"
                      >
                        <Calendar className="h-4 w-4 mr-2" />
                        All weeks (1 year · 52 weeks)
                      </Button>
                    )}
                  </div>
                </div>
                
                {/* Daily Repayment Hero Card */}
                {fees && (
                  <div className="space-y-2">
                    <div className="p-4 rounded-2xl bg-primary/20 border-2 border-primary/40 text-center">
                      <p className="text-xs text-primary/70 font-medium mb-1">And You Pay</p>
                      <p className="text-3xl font-black text-primary font-mono">{formatUGX(fees.dailyRepayment)}</p>
                      <p className="text-xs text-primary/70 mt-1">per day for {fees.durationDays} days</p>
                    </div>

                    {/* Repayment Start Date */}
                    <div className="p-3 rounded-xl bg-primary/10 border border-primary/30 flex items-center gap-3">
                      <Calendar className="h-4 w-4 text-primary flex-shrink-0" />
                      <div>
                        <p className="text-[10px] text-primary/60 font-medium">Repayment starts</p>
                        <p className="font-bold text-sm text-primary">
                          {format(addDays(new Date(), 1), 'EEEE, MMMM d, yyyy')}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              </>
              ) : null}

              {incomeType !== 'outstanding' && (
              <>
              {detailStep === 1 && (
              <>
              {/* ===== 2. TENANT DETAILS ===== */}
              <div className="space-y-3">
                <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                  <User className="h-3 w-3" />
                  Tenant Details
                </h4>

                {/* One-tap auto-fill from an existing tenant */}
                {existingTenants.length > 0 && (
                  <div className="space-y-1 rounded-xl border-2 border-primary/30 bg-primary/5 p-3">
                    <Label className="flex items-center gap-1 text-primary">
                      ⚡ Quick fill from a tenant you already registered
                    </Label>
                    <Select
                      value=""
                      onValueChange={applyExistingTenant}
                      disabled={autofillingTenant || loadingTenants}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={autofillingTenant ? 'Filling in…' : 'Tap to pick an existing tenant'} />
                      </SelectTrigger>
                      <SelectContent>
                        {existingTenants.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.full_name}{t.phone ? ` · ${t.phone}` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-[10px] text-muted-foreground">
                      Pulls their phone, National ID and photo automatically. You can still edit anything below.
                    </p>
                  </div>
                )}

                {/* No Smartphone Toggle */}
                <button
                  type="button"
                  onClick={() => setNoSmartphone(!noSmartphone)}
                  className={`w-full p-3 rounded-xl border-2 transition-all text-left flex items-center gap-3 ${
                    noSmartphone 
                      ? 'border-warning/50 bg-warning/10' 
                      : 'border-muted hover:border-muted-foreground/30'
                  }`}
                >
                  <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${
                    noSmartphone ? 'bg-warning border-warning' : 'border-muted-foreground/40'
                  }`}>
                    {noSmartphone && <CheckCircle2 className="h-3.5 w-3.5 text-warning-foreground" />}
                  </div>
                  <div>
                    <p className="text-sm font-medium">Tenant has no smartphone</p>
                    <p className="text-xs text-muted-foreground">
                      {noSmartphone 
                        ? '⚠️ Your wallet will be charged for all repayments' 
                        : 'Check if tenant cannot manage their own wallet'}
                    </p>
                  </div>
                </button>

                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="tenantName" >Full Name *</Label>
                    <p className="text-xs text-muted-foreground leading-snug">Write the tenant's name as it is on their ID.</p>
                    <p className="text-[11px] text-muted-foreground">e.g. Sarah Nalwoga</p>
                    <PersonNameFields
                      idPrefix="rent-req-tenant"
                      value={tenantNameParts}
                      onChange={setTenantNameParts}
                    />
                    <FieldError message={vName(tenantName) || getFieldError('tenantName')} />
                    <TenantDuplicateNotice
                      match={existingTenantByName}
                      checking={checkingTenantName}
                      field="name"
                      onUse={useExistingTenantMatch}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="tenantPhone" >Phone *</Label>

                    <p className="text-xs text-muted-foreground leading-snug">The number they answer calls on.</p>
                        <p className="text-[11px] text-muted-foreground">e.g. 0783 123 456</p>
                    <Input
                      id="tenantPhone"
                      value={tenantPhone}
                      onChange={(e) => setTenantPhone(formatPhoneInput(e.target.value))}
                      placeholder="0783 123 456"
                      className={`h-10 ${hasFieldError('tenantPhone') ? 'border-destructive border-2' : ''}`}
                      maxLength={12}
                      required
                    />
                    <FieldError message={vPhone(tenantPhone) || getFieldError('tenantPhone')} />
                    <ExistingTenantPhoneNotice
                      match={existingTenantByPhone}
                      checking={checkingTenantPhone}
                      onUse={useExistingTenantMatch}
                      onRenew={renewExistingTenant}
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="tenantNationalId" >National ID *</Label>
                  <p className="text-xs text-muted-foreground leading-snug">Copy the long number from their national ID card.</p>
                  <p className="text-[11px] text-muted-foreground">e.g. CM12345678901</p>
                  <Input
                    id="tenantNationalId"
                    value={formatNationalIdDisplay(tenantNationalId)}
                    onChange={(e) => setTenantNationalId(cleanNationalIdInput(e.target.value))}
                    placeholder="e.g. CM12 3456 7890 12"
                    className={`font-mono uppercase tracking-wider ${hasFieldError('tenantNationalId') ? 'border-destructive border-2' : ''}`}
                    inputMode="text"
                    autoCapitalize="characters"
                    maxLength={17}
                    required
                  />
                  <FieldError message={vNationalId(tenantNationalId) || getFieldError('tenantNationalId')} />
                  <TenantDuplicateNotice
                    match={existingTenantByNationalId}
                    checking={checkingTenantNationalId}
                    field="national ID"
                    onUse={useExistingTenantMatch}
                  />
                </div>

                <div className="space-y-1">

                  <Label >Preferred Language *</Label>
                  <p className="text-xs text-muted-foreground leading-snug">The language the tenant understands best.</p>
                      <p className="text-[11px] text-muted-foreground">e.g. Luganda</p>
                  <Select value={preferredLanguage} onValueChange={setPreferredLanguage}>
                    <SelectTrigger className={`${hasFieldError('preferredLanguage') ? 'border-destructive border-2' : ''}`}>
                      <SelectValue placeholder="Select tenant language" />
                    </SelectTrigger>
                    <SelectContent>
                      {PREFERRED_LANGUAGES.map((l) => (
                        <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldError message={getFieldError('preferredLanguage')} />
                </div>
              </div>
              </>
              )}

              {detailStep === 2 && (
              <>
              {/* ===== 3. HOUSE CATEGORY ===== */}
              <div className="space-y-3">
                <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                  <Home className="h-3 w-3" />
                  House Category *
                </h4>
                <p className="text-xs text-muted-foreground leading-snug">Pick what kind of house this is (single room, two rooms, etc.).</p>
                <p className="text-[11px] text-muted-foreground">e.g. Single Room</p>
                <Select value={houseCategory} onValueChange={setHouseCategory}>
                  <SelectTrigger className={`${hasFieldError('houseCategory') ? 'border-destructive border-2' : ''}`}>
                    <SelectValue placeholder="Select house type" />
                  </SelectTrigger>
                  <SelectContent>
                    {HOUSE_CATEGORIES.map(cat => (
                      <SelectItem key={cat.value} value={cat.value}>
                        {cat.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError message={getFieldError('houseCategory')} />
              </div>

              <Separator />

              {/* ===== 4. LANDLORD — search-first, big & clear ===== */}
              <div ref={landlordSectionRef} className="space-y-4">
                {/* Friendly section title — large, no jargon */}
                <div className="flex items-center gap-2">
                  <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <Building2 className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h4 className="text-base font-bold text-foreground leading-tight">Who owns the house?</h4>
                    <p className="text-xs text-muted-foreground leading-tight">Find the landlord, or add a new one</p>
                  </div>
                </div>

                {/* Bonus promo removed — keeps the agent focused on the listing. */}
                {/* ── Sticky quick-switch bar ── */}
                <div className="sticky top-0 z-20 -mx-1 px-1 py-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                  {!selectedLandlord ? (
                    <div className="rounded-2xl border-2 border-muted bg-muted/30 p-1.5 flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => setLandlordMode('search')}
                        className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold transition-all active:scale-[0.98] ${
                          landlordMode === 'search'
                            ? 'bg-background shadow-sm text-foreground border border-border'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <Search className="h-4 w-4" />
                        Search existing
                      </button>
                      <button
                        type="button"
                        onClick={() => setLandlordMode('register')}
                        className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold transition-all active:scale-[0.98] ${
                          landlordMode === 'register'
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <UserPlus className="h-4 w-4" />
                        Add new
                      </button>
                    </div>
                  ) : (
                    /* ── Landlord linked: sticky confirmation card ── */
                    <div className="rounded-2xl border-2 border-success/40 bg-success/5 p-3">
                      <div className="flex items-start gap-3">
                        <CheckCircle2 className="h-6 w-6 text-success shrink-0 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <p className="text-base font-bold text-foreground truncate">{selectedLandlord.name}</p>
                          <p className="text-sm text-muted-foreground flex items-center gap-1 truncate">
                            <Phone className="h-3.5 w-3.5 shrink-0" /> {landlordPhone || selectedLandlord.phone}
                          </p>
                          {landlordCheck === 'checking' ? (
                            <p className="text-xs text-muted-foreground font-medium mt-1">Confirming registration…</p>
                          ) : landlordCheck === 'missing' ? (
                            <FieldError message="This landlord is not registered in the system — pick another or register them again" />
                          ) : landlordCheck === 'unverified' ? (
                            <div className="mt-1 space-y-2">
                              <div className="rounded-lg border border-amber-300/60 bg-amber-50 p-2.5">
                                <p className="text-xs font-semibold text-amber-800 leading-snug">
                                  Landlord {selectedLandlord.name} is not yet verified — once approved, your rent request will be processed.
                                </p>
                              </div>
                              {verifyReqState === 'sent' || verifyReqState === 'exists' ? (
                                <p className="text-xs font-medium text-success flex items-center gap-1">
                                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                  Verification request sent to Landlord Operations.
                                </p>
                              ) : (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="h-9 w-full gap-1.5 rounded-xl border-amber-500/40 text-amber-700 hover:bg-amber-50"
                                  disabled={verifyReqState === 'sending'}
                                  onClick={requestLandlordVerification}
                                >
                                  {verifyReqState === 'sending' ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <ShieldCheck className="h-3.5 w-3.5" />
                                  )}
                                  Request verification from Landlord Ops
                                </Button>
                              )}
                            </div>
                          ) : (
                            /* Verified landlord — nothing to notify Landlord Ops about. */
                            <div className="mt-2 flex items-center gap-2 rounded-xl border border-success/40 bg-success/10 px-2.5 py-2">
                              <ShieldCheck className="h-4 w-4 text-success shrink-0" />
                              <div className="min-w-0">
                                <p className="text-xs font-bold text-success leading-tight">Verified landlord</p>
                                <p className="text-[11px] text-muted-foreground leading-snug">
                                  Their saved details were filled in for you — continue with this rent request.
                                </p>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full h-11 mt-3 gap-2 rounded-xl"
                        onClick={() => {
                          setSelectedLandlord(null);
                          setShowLinkedBanner(false);
                          setLandlordName('');
                          setLandlordPhone('');
                          // Keep the agent's preferred search/add mode instead of forcing search.
                        }}
                      >
                        Change landlord
                      </Button>
                    </div>
                  )}
                </div>


                {selectedLandlord ? null : landlordMode === 'search' ? (
                  /* ── Search existing landlord ── */
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label className="text-sm font-semibold">Select a registered landlord</Label>
                      <p className="text-xs text-muted-foreground leading-snug">
                        Only landlords already registered in the system can be chosen. Search by name or phone.
                      </p>
                      <LandlordSearchSelect
                        key={landlordPickerKey}
                        value={selectedLandlord}
                        autoOpenSignal={landlordSearchOpenSignal}
                        inline
                        onChange={(l) => {
                          if (l) applySelectedLandlord(l);
                        }}
                        onAddNew={() => setLandlordMode('register')}
                      />
                    </div>

                    {/* One-tap clear with inline confirmation so agents don't lose inputs by accident */}
                    {selectedLandlord && (
                      confirmClearLandlord ? (
                        <div className="w-full rounded-xl border border-destructive/30 bg-destructive/5 p-3 space-y-2">
                          <p className="text-sm font-semibold text-destructive text-center">Clear landlord selection?</p>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                clearLandlordSearch();
                                setConfirmClearLandlord(false);
                              }}
                              className="flex-1 py-2.5 rounded-lg bg-destructive text-destructive-foreground text-sm font-bold active:scale-[0.98] transition-transform"
                            >
                              Yes, clear
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmClearLandlord(false)}
                              className="flex-1 py-2.5 rounded-lg border border-muted-foreground/30 bg-background text-foreground text-sm font-bold active:scale-[0.98] transition-transform"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmClearLandlord(true)}
                          className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl border border-destructive/30 bg-destructive/5 text-destructive text-sm font-bold active:scale-[0.98] transition-transform"
                        >
                          <X className="h-4 w-4" />
                          Clear selection
                        </button>
                      )
                    )}

                    {/* Gentle nudge so the agent knows tapping a match fills everything */}
                    <p className="text-xs text-muted-foreground leading-snug px-0.5">
                      💡 Picking a landlord from the list fills their address and details automatically.
                    </p>
                  </div>
                ) : (
                  /* ── Add new landlord ── */
                  <button
                    ref={registerBtnRef}
                    type="button"
                    onClick={() => setShowRegisterLandlord(true)}
                    className="w-full flex items-center gap-3 rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 p-4 text-left active:scale-[0.99] transition-transform outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
                  >
                    <div className="h-12 w-12 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
                      <UserPlus className="h-6 w-6 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-base font-bold text-primary leading-tight">Register a new landlord</p>
                      <p className="text-xs text-muted-foreground leading-snug">
                        Not in the system yet? Tap here to register them and earn UGX 5,000 when a tenant moves in.
                      </p>
                    </div>
                  </button>
                )}

                {/* Inline landlord verification errors */}
                {!selectedLandlord && !selectedHouse?.landlord_id && (
                  <FieldError message="Select a registered landlord before posting — search existing or tap 'Add new'" />
                )}
                {selectedLandlord && landlordCheck === 'missing' && (
                  <FieldError message="This landlord is not registered in the system — pick another or register them again" />
                )}
                {selectedLandlord && landlordCheck === 'unverified' && (
                  <div className="rounded-lg border border-amber-300/60 bg-amber-50 p-2.5">
                    <p className="text-xs font-semibold text-amber-800 leading-snug">
                      Landlord {selectedLandlord.name} is not yet verified — once approved, your rent request will be processed.
                    </p>
                  </div>
                )}
                {selectedLandlord && landlordCheck === 'checking' && (
                  <FieldError message="Confirming the landlord is registered — please wait a moment before submitting" />
                )}

                <div className="space-y-1.5">
                  <UgLocationPicker
                    value={ugLocation}
                    onChange={applyUgLocation}
                    label="Where is the house? Search village"
                    required
                    error={getFieldError('propertyAddress')}
                  />
                  <FieldError message={vPlace(propertyAddress, 'Kira Town, near Total') || getFieldError('propertyAddress')} />
                </div>

                {/* GPS Capture */}
                <div className="space-y-1">
                  <Label className="flex items-center gap-1">
                    <Navigation className="h-3 w-3" /> Property GPS *
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    Required — stand at the property and capture its exact location.
                  </p>
                  {gpsLocation ? (
                    <div className="flex items-center gap-2 p-2.5 rounded-xl bg-success/10 border border-success/30">
                      <Navigation className="h-4 w-4 text-success flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-success">📍 GPS Captured</p>
                        <p className="text-[10px] text-muted-foreground truncate">
                          {gpsLocation.lat.toFixed(5)}, {gpsLocation.lng.toFixed(5)} (±{Math.round(gpsLocation.accuracy)}m)
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-xs h-7 px-2"
                        onClick={captureGPS}
                      >
                        Retake
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full h-10 gap-2 border-dashed"
                      onClick={captureGPS}
                      disabled={gpsLoading}
                    >
                      {gpsLoading ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Getting GPS...
                        </>
                      ) : (
                        <>
                          <Navigation className="h-4 w-4" />
                          Capture Property GPS
                        </>
                      )}
                    </Button>
                  )}
                  {!gpsLocation && <FieldError message={getFieldError('gpsLocation')} />}
                </div>

                {/* House Photos — 4 outside views */}
                <div className="space-y-2">
                  {/* Renewal document prompt — states plainly whether this
                      tenant already has documents on file, or whether the agent
                      must capture them fresh for this renewal. */}
                  {renewDocsLoading && (
                    <div className="rounded-lg border border-border bg-muted/40 p-2.5 text-[11px] text-muted-foreground inline-flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking this tenant's documents on file…
                    </div>
                  )}
                  {!renewDocsLoading && renewDocs && (
                    renewDocs.passport && renewDocs.houseImages >= 4 ? (
                      <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-[11px]">
                        <p className="font-semibold text-emerald-800 dark:text-emerald-300">Documents already on file</p>
                        <p className="text-muted-foreground mt-0.5">
                          Passport photo, {renewDocs.houseImages} house photos{renewDocs.lcLetter ? ' and the LC letter' : ''} carry forward to this renewal. Re-capture only if they have changed.
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-lg border-2 border-amber-500/60 bg-amber-500/10 p-2.5 text-[11px]">
                        <p className="font-semibold text-amber-800 dark:text-amber-300 inline-flex items-center gap-1">
                          <AlertTriangle className="h-3.5 w-3.5" /> No documents on file — upload them now
                        </p>
                        <ul className="mt-1 space-y-0.5 text-muted-foreground list-disc pl-4">
                          {!renewDocs.passport && <li>Tenant passport photo</li>}
                          {renewDocs.houseImages < 4 && <li>All 4 house photos ({renewDocs.houseImages} of 4 on file)</li>}
                          {!renewDocs.lcLetter && <li>LC letter</li>}
                        </ul>
                      </div>
                    )
                  )}
                  <Label className="flex items-center gap-1">
                    📸 House Photos * — capture all 4 outside views
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    Required — take one photo of each outside part of the house: front, back, left side and right side. Max {MAX_FILE_SIZE_MB} MB each (JPG, PNG, WebP).
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {HOUSE_PHOTO_SLOTS.map((slot, idx) => {
                      const photo = housePhotos[idx];
                      return (
                        <div key={slot.key} className="space-y-1">
                          {photo ? (
                            <div className="relative aspect-square rounded-lg overflow-hidden border border-border group">
                              <img
                                src={photo.preview}
                                alt={slot.label}
                                className="w-full h-full object-cover cursor-pointer"
                                onClick={() => { setPreviewUrl(photo.preview); setPreviewLabel(slot.label); }}
                              />
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); removePhoto(idx); }}
                                className="absolute top-1 right-1 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-xs font-bold"
                              >
                                ✕
                              </button>
                              <label className="absolute bottom-1 left-1 w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center cursor-pointer shadow-sm">
                                <RefreshCw className="w-3 h-3" />
                                <input
                                  type="file"
                                  accept="image/*"
                                  capture="environment"
                                  className="hidden"
                                  onChange={(e) => handlePhotoAddAt(idx, e)}
                                />
                              </label>
                            </div>
                          ) : (
                            <label className="aspect-square rounded-lg border-2 border-dashed border-muted-foreground/30 flex flex-col items-center justify-center cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-colors text-center px-1">
                              <span className="text-xl text-muted-foreground/60">📷</span>
                              <span className="text-[10px] font-medium text-foreground/80 mt-1 leading-tight">{slot.label}</span>
                              <span className="text-[9px] text-muted-foreground/60 mt-0.5 leading-tight">{slot.hint}</span>
                              <input
                                type="file"
                                accept="image/*"
                                capture="environment"
                                className="hidden"
                                onChange={(e) => handlePhotoAddAt(idx, e)}
                              />
                            </label>
                          )}
                          <p className="text-[10px] text-center text-muted-foreground truncate">{slot.label}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Tenant passport photo (optional — submitted last with the other photos) */}
                <div className="space-y-1">
                  <Label className="flex items-center gap-1">
                    🪪 Tenant Passport Photo *
                  </Label>
                  <div className="flex items-start gap-3">
                    {tenantPhoto ? (
                      <div className="relative h-24 w-20 rounded-lg overflow-hidden border border-border shrink-0 group">
                        <img
                          src={tenantPhoto.preview}
                          alt="Tenant"
                          className="w-full h-full object-cover cursor-pointer"
                          onClick={() => { setPreviewUrl(tenantPhoto.preview); setPreviewLabel("Tenant Passport Photo"); }}
                        />
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); removeTenantPhoto(); }}
                          className="absolute top-1 right-1 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-xs font-bold"
                        >
                          ✕
                        </button>
                        <label className="absolute bottom-1 left-1 w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center cursor-pointer shadow-sm">
                          <RefreshCw className="w-3 h-3" />
                          <input
                            type="file"
                            accept="image/*"
                            capture="user"
                            className="hidden"
                            onChange={handleTenantPhoto}
                          />
                        </label>
                      </div>
                    ) : (
                      <label className="h-24 w-20 rounded-lg border-2 border-dashed border-muted-foreground/30 flex flex-col items-center justify-center cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-colors shrink-0">
                        <span className="text-xl text-muted-foreground/60">📷</span>
                        <span className="text-[10px] text-muted-foreground/60 mt-0.5">Capture</span>
                        <input
                          type="file"
                          accept="image/*"
                          capture="user"
                          className="hidden"
                          onChange={handleTenantPhoto}
                        />
                      </label>
                    )}
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Required — take a clear, well-lit photo of the tenant's face (passport-style). Landlord Ops uses this to verify the tenant during review. Max {MAX_FILE_SIZE_MB} MB (JPG, PNG, WebP).
                    </p>
                  </div>
                </div>
              </div>
              </>
              )}

              {detailStep === 3 && (
              <>
              {/* ===== LC LETTER UPLOAD ===== */}
              <div className="space-y-2">
                <h4 className="text-base font-bold text-foreground flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4" />
                  LC Letter
                </h4>
                {lcLetter ? (
                  <div className="flex items-center gap-3 rounded-xl border border-border p-2.5">
                    <img src={lcLetter.preview} alt="LC letter" className="h-16 w-16 rounded-lg object-cover" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{lcLetter.file.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {(lcLetter.file.size / (1024 * 1024)).toFixed(1)} MB
                      </p>
                    </div>
                    <Button type="button" size="sm" variant="outline" onClick={() => setLcLetter(null)}>
                      Remove
                    </Button>
                  </div>
                ) : (
                  <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border p-4 text-sm text-muted-foreground hover:border-primary/50">
                    <Upload className="h-4 w-4" />
                    Upload the LC letter
                    <input
                      type="file"
                      accept="image/jpeg,image/jpg,image/png,.jpg,.jpeg,.png"
                      className="hidden"
                      onChange={handleLcLetter}
                    />
                  </label>
                )}
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  One image only — JPG, JPEG or PNG, up to 10 MB. Kept private and visible to Welile operations.
                </p>
              </div>

              {/* ===== 5. LC1 DETAILS ===== */}
              <div ref={lc1SectionRef} className="space-y-3">
                <h4 className="text-base font-bold text-foreground flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  LC1 Chairperson Details
                </h4>
                <div className="space-y-3">
                  {/* ===== Search-first: find an LC1 already in the system ===== */}
                  {ugLocation && !lc1Selected && lc1Auto.isLoading && (
                    <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Finding the LC1 chairperson registered for {ugLocation.village}…
                    </p>
                  )}
                  {!lc1Selected && lc1Mode === 'search' && (
                    <div className="space-y-2 p-3 rounded-xl bg-primary/5 border border-primary/20">
                      <p className="text-xs text-muted-foreground leading-snug">
                        Search for the LC1 chairperson already in the system. If they're not there yet, register them.
                      </p>
                      <div className="flex gap-2">
                        <Input
                          placeholder="LC1 name or phone"
                          value={lc1Query}
                          onChange={(e) => setLc1Query(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); searchLc1(); } }}
                        />
                        <Button type="button" variant="secondary" onClick={searchLc1} disabled={lc1Searching}>
                          {lc1Searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                        </Button>
                      </div>
                      {lc1Results.length > 0 && (
                        <div className="space-y-1.5 max-h-56 overflow-y-auto">
                          {lc1Results.map((hit) => (
                            <button
                              type="button"
                              key={hit.id}
                              onClick={() => selectLc1Hit(hit)}
                              className="w-full text-left p-2.5 rounded-lg border border-border bg-background hover:bg-accent/40 transition-colors"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium text-sm truncate">{hit.name}</span>
                                {hit.verified ? (
                                  <span className="flex items-center gap-1 text-[10px] font-semibold text-success shrink-0">
                                    <ShieldCheck className="h-3.5 w-3.5" /> Verified
                                  </span>
                                ) : (
                                  <span className="text-[10px] text-muted-foreground shrink-0">Pending</span>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground">{hit.phone}</p>
                              <p className="text-[11px] text-muted-foreground mt-0.5">
                                {[hit.village, hit.district, hit.region].filter(Boolean).join(' · ') || 'No location on file'}
                              </p>
                            </button>
                          ))}
                        </div>
                      )}
                      {lc1SearchedOnce && !lc1Searching && lc1Results.length === 0 && (
                        <p className="text-xs text-muted-foreground">No LC1 chairperson found for that search — register them below.</p>
                      )}
                      <Button type="button" variant="outline" className="h-9 text-xs w-full" onClick={startRegisterLc1}>
                        <UserPlus className="h-4 w-4 mr-1.5" />
                        Register a new LC1 chairperson
                      </Button>
                    </div>
                  )}

                  {/* ===== Selected existing LC1 ===== */}
                  {lc1Selected && (
                    <div className="p-3 rounded-xl border border-success/40 bg-success/5">
                      {lc1AutoMatched && (
                        <p className="mb-1.5 text-[11px] font-semibold text-success inline-flex items-center gap-1">
                          <ShieldCheck className="h-3.5 w-3.5" />
                          Matched automatically from {ugLocation?.village || lc1Village}
                        </p>
                      )}
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{lc1Name}</p>
                          <p className="text-xs text-muted-foreground">{lc1Phone}</p>
                          {lc1Village && <p className="text-[11px] text-muted-foreground">{lc1Village}</p>}
                        </div>
                        <Button type="button" variant="ghost" size="sm" className="h-8 text-xs shrink-0" onClick={clearLc1Selection}>
                          <X className="h-3.5 w-3.5 mr-1" /> Change
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* ===== Register new LC1 (manual entry) ===== */}
                  {lc1Mode === 'register' && !lc1Selected && (
                  <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-primary">New LC1 chairperson</p>
                    <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={clearLc1Selection}>
                      ← Back to search
                    </Button>
                  </div>
                  {ugLocation && lc1Auto.isEmpty && (
                    <div className="rounded-lg border border-amber-300/60 bg-amber-50 p-2.5">
                      <p className="text-[11px] font-semibold text-amber-800 leading-snug">
                        No LC1 chairperson is registered for {ugLocation.village} yet — add them here.
                        Their village and district are inherited from the location you captured for this house.
                      </p>
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label >Name *</Label>
                    <p className="text-xs text-muted-foreground leading-snug">The local council (LC1) chairperson for that area.</p>
                    <p className="text-[11px] text-muted-foreground">e.g. Mr. Ssemwanga</p>
                    <PersonNameFields
                      idPrefix="rent-req-lc1"
                      value={lc1NameParts}
                      onChange={setLc1NameParts}
                    />
                    <FieldError message={vName(lc1Name) || getFieldError('lc1Name')} />
                  </div>
                  <div className="space-y-1">
                    <Label >Phone *</Label>
                    <p className="text-xs text-muted-foreground leading-snug">A number that can confirm the tenant lives there.</p>
                    <p className="text-[11px] text-muted-foreground">e.g. 0701 987 654</p>
                    <Input
                      value={lc1Phone}
                      onChange={(e) => setLc1Phone(formatPhoneInput(e.target.value))}
                      placeholder="0700 123 456"
                      className={`h-10 ${hasFieldError('lc1Phone') ? 'border-destructive border-2' : ''}`}
                      maxLength={12}
                      required
                    />
                    <FieldError message={vPhone(lc1Phone) || getFieldError('lc1Phone')} />
                  </div>
                  <div className="space-y-1">
                    <Label >Village *</Label>
                    <p className="text-xs text-muted-foreground leading-snug">The village or zone the LC1 looks after.</p>
                    <p className="text-[11px] text-muted-foreground">e.g. Kira Zone A</p>
                    <Lc1VillagePicker
                      label="Village"
                      required
                      value={lc1Village}
                      error={hasFieldError('lc1Village') ? getFieldError('lc1Village') : null}
                      districtName={propertyDistrict || null}
                      onChange={(name, selection) => {
                        setLc1Village(name);
                        setLc1LocationUnit(selection);
                      }}
                    />
                    <FieldError message={vPlace(lc1Village, 'Kira Zone A') || getFieldError('lc1Village')} />
                  </div>
                  </div>
                  )}

                  {/* ===== Shared LC1 verification status (selected OR manual) ===== */}
                  {(lc1Selected || lc1Mode === 'register') && (
                  <div className="space-y-1">
                    {isValidUgPhone(lc1Phone.replace(/\s/g, '')) && (
                      lc1Check === 'checking' ? (
                        <p className="text-[11px] text-muted-foreground font-medium">Confirming LC1 verification…</p>
                      ) : lc1Check === 'verified' ? (
                        <p className="text-[11px] text-success font-medium">✓ Verified LC1 chairperson</p>
                      ) : lc1Check === 'missing' ? (
                        <p className="text-[11px] text-amber-700 font-medium">
                          LC1 chairperson not registered yet — you can still post now. They’ll be registered from these details and must be verified before the request is approved.
                        </p>
                      ) : lc1Check === 'unverified' ? (
                        <div className="mt-1 space-y-2">
                          <p className="text-[11px] text-amber-700 font-medium">
                            LC1 chairperson is registered but not yet verified — you can post now, but the request won’t be approved until the LC1 is verified.
                          </p>
                          {lc1VerifyReqState === 'sent' || lc1VerifyReqState === 'exists' ? (
                            <p className="text-xs font-medium text-success flex items-center gap-1">
                              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                              Verification request sent to Landlord Operations — the request will be approved once they verify this LC1 chairperson.
                            </p>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-9 w-full gap-1.5 rounded-xl border-amber-500/40 text-amber-700 hover:bg-amber-50"
                              disabled={lc1VerifyReqState === 'sending' || !lc1Id}
                              onClick={requestLc1Verification}
                            >
                              {lc1VerifyReqState === 'sending' ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <ShieldCheck className="h-3.5 w-3.5" />
                              )}
                              Request verification from Landlord Ops
                            </Button>
                          )}
                        </div>
                      ) : null
                    )}
                    {lc1Phone.replace(/\s/g, '').length >= 10 &&
                      tenantPhone.replace(/\s/g, '').length >= 10 &&
                      lc1Phone.replace(/\s/g, '') === tenantPhone.replace(/\s/g, '') && (
                        <p className="text-[10px] text-destructive">Cannot be the same as Tenant phone</p>
                      )}
                    {lc1Phone.replace(/\s/g, '').length >= 10 &&
                      landlordPhone.replace(/\s/g, '').length >= 10 &&
                      lc1Phone.replace(/\s/g, '') === landlordPhone.replace(/\s/g, '') && (
                        <p className="text-[10px] text-destructive">Cannot be the same as Landlord phone</p>
                      )}
                  </div>
                  )}
                </div>

                {/* Town/City + District — keeps tenant rolled up under a real
                    location in Tenant Ops drill-down instead of the
                    "Entebbe (please verify)" placeholder. */}
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label className="flex items-center gap-1">
                      <MapPin className="h-3 w-3" /> Town / City *
                    </Label>
                    <p className="text-xs text-muted-foreground leading-snug">The town or city where the house is.</p>
                    <p className="text-[11px] text-muted-foreground">e.g. Entebbe, Kampala, Jinja</p>
                    <Input
                      value={propertyCity}
                      onChange={(e) => setPropertyCity(formatNameInput(e.target.value))}
                      placeholder="e.g. Entebbe, Kampala, Jinja"
                      className={`h-10 ${hasFieldError('propertyCity') ? 'border-destructive border-2' : ''}`}
                      required
                    />
                    <FieldError message={vPlace(propertyCity, 'Entebbe') || getFieldError('propertyCity')} />
                  </div>
                  <div className="space-y-1">
                    <Label >District</Label>
                    <p className="text-xs text-muted-foreground leading-snug">The district the house is in, like Wakiso.</p>
                    <p className="text-[11px] text-muted-foreground">e.g. Wakiso</p>
                    <UgDistrictSelect
                      label="District"
                      legacyText={propertyDistrict}
                      value={propertyDistrictUnit}
                      onChange={(unit) => {
                        setPropertyDistrictUnit(unit);
                        setPropertyDistrict(unit?.name ?? '');
                      }}
                    />
                    <FieldError message={vPlace(propertyDistrict, 'Wakiso') || getFieldError('propertyDistrict')} />
                    {districtWarning(propertyDistrict) && (
                      <p className="text-[10px] text-warning leading-tight">
                        {districtWarning(propertyDistrict)}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Landlord auto-payout day */}
              <div className="space-y-1 rounded-xl border border-primary/30 bg-primary/5 p-3">
                <Label className="flex items-center gap-1 font-semibold">
                  <Calendar className="h-3 w-3" /> Landlord payout day (1–28) *
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={28}
                  value={landlordPayoutDay}
                  onChange={(e) => setLandlordPayoutDay(e.target.value)}
                  placeholder="e.g. 5"
                 
                  required
                />
                <p className="text-[11px] text-muted-foreground leading-snug">
                  Welile will automatically credit the landlord wallet with UGX{' '}
                  {(parseInt(rentAmount.replace(/,/g, '')) || 0).toLocaleString()} on day{' '}
                  <span className="font-semibold text-foreground">{landlordPayoutDay || '–'}</span>{' '}
                  of every month, regardless of when the tenant pays.
                </p>
              </div>
              </>
              )}

              {detailStep === 4 && (
              <>
              {/* ===== 6. REVIEW & CONFIRM ===== */}
              <div className="space-y-2 p-4 rounded-2xl bg-muted/40 border border-border">
                <h4 className="text-sm font-bold flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-primary" /> Review &amp; confirm
                </h4>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground shrink-0">Tenant</span>
                    <span className="font-semibold text-right min-w-0 break-words">{tenantName || '—'}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground shrink-0">{incomeType === 'weekly-monthly' && earnerCycle === 'weekly' ? '1 month rent' : 'Rent amount'}</span>
                    <span className="font-semibold text-right min-w-0 break-words">{amount ? formatUGX(amount) : '—'}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground shrink-0">{incomeType === 'daily' ? 'Duration' : 'Repayment'}</span>
                    <span className="font-semibold text-right min-w-0 break-words">{incomeType === 'daily' ? `${duration} days` : getPeriodLabel(repaymentPeriod)}</span>
                  </div>
                  {fees && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground shrink-0">You pay</span>
                      <span className="font-semibold text-right min-w-0 break-words">{formatUGX(fees.dailyRepayment)}/day</span>
                    </div>
                  )}
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground shrink-0">Landlord</span>
                    <span className="font-semibold text-right min-w-0 break-words">{landlordName || '—'}</span>
                  </div>
                </div>
              </div>

              <GuarantorConsentCheckbox checked={guarantorConsent} onCheckedChange={setGuarantorConsent} />
              </>
              )}

              {/* Validation Error Summary */}
              {validationErrors.length > 0 && (
                <div ref={errorSummaryRef} className="p-4 rounded-2xl bg-destructive/10 border-2 border-destructive/40 space-y-3 scroll-mt-4">
                  <p className="text-base font-extrabold text-destructive flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 flex-shrink-0" />
                    {validationErrors.length} thing{validationErrors.length > 1 ? 's' : ''} still needed
                  </p>
                  <ul className="space-y-2">
                    {validationErrors.map((err, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm font-semibold text-destructive">
                        <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[11px] font-bold">{i + 1}</span>
                        <span>{err}</span>
                      </li>
                    ))}
                  </ul>
                  {landlordCheck === 'unverified' && (
                    <div className="pt-1">
                      {verifyReqState === 'sent' || verifyReqState === 'exists' ? (
                        <p className="text-xs font-medium text-success flex items-center gap-1">
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                          Verification request sent to Landlord Operations — you&apos;ll be able to post once they verify this landlord.
                        </p>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-9 w-full gap-1.5 rounded-xl border-amber-500/40 text-amber-700 hover:bg-amber-50"
                          disabled={verifyReqState === 'sending'}
                          onClick={requestLandlordVerification}
                        >
                          {verifyReqState === 'sending' ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ShieldCheck className="h-3.5 w-3.5" />
                          )}
                          Request verification from Landlord Ops
                        </Button>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-destructive/80">Fix these, then press the button again.</p>
                </div>
              )}

              {submissionError && validationErrors.length === 0 && (
                <div ref={errorSummaryRef} className="p-4 rounded-2xl bg-destructive/10 border-2 border-destructive/40 space-y-3 scroll-mt-4">
                  <div className="flex items-start gap-2 text-sm font-semibold text-destructive">
                    <AlertTriangle className="h-5 w-5 mt-0.5 flex-shrink-0" />
                    <span>{submissionError}</span>
                  </div>
                  <p className="text-xs text-destructive/80">
                    Everything you typed is still here — just tap to try again.
                  </p>
                  <Button
                    type="button"
                    onClick={submitQueued ? promptCancelQueued : requestSubmit}
                    disabled={loading}
                    variant={submitQueued ? 'secondary' : 'destructive'}
                    className="w-full"
                  >
                    {loading ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Trying again…</>
                    ) : submitQueued ? (
                      <><X className="h-4 w-4 mr-2" />Cancel submit</>
                    ) : (
                      <><RefreshCw className="h-4 w-4 mr-2" />Try again</>
                    )}
                  </Button>
                  {errorDetails && (
                    <Accordion type="single" collapsible className="w-full">
                      <AccordionItem value="error-details" className="border-0">
                        <AccordionTrigger className="text-xs text-destructive/80 hover:no-underline py-2">
                          View technical details
                        </AccordionTrigger>
                        <AccordionContent>
                          <pre className="text-[11px] leading-relaxed whitespace-pre-wrap bg-destructive/5 rounded-lg p-3 text-destructive/90 font-mono">
                            {errorDetails}
                          </pre>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  )}
                </div>
              )}

              {/* Real-time cap breakdown — always visible once an amount is
                  entered. Shows the agent's tier, per-tenant posting cap and
                  whether the typed amount passes the threshold, live. */}
              {amount > 0 && (() => {
                // Weekly Good-Standing unlock takes over the whole panel: no
                // cap, no meter — just a clear "you can post anything" message.
                if (unlimitedPosting) {
                  return (
                    <div className="p-4 rounded-2xl border-2 bg-success/10 border-success/40 space-y-3 scroll-mt-4">
                      <p className="text-base font-extrabold flex items-center gap-2 text-success">
                        <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
                        Unlimited posting unlocked this week
                      </p>
                      <div className="text-sm font-semibold text-foreground space-y-1.5">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-muted-foreground">Last week's rating</span>
                          <span className="font-extrabold text-success">
                            Good on {goodDaysLastWeek} day{goodDaysLastWeek === 1 ? '' : 's'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-muted-foreground">Cap per tenant</span>
                          <span className="font-extrabold text-success">No limit</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-muted-foreground">You entered</span>
                          <span className="font-extrabold text-success">{formatUGX(amount)}</span>
                        </div>
                      </div>
                      <div className="text-xs leading-relaxed text-success/90 space-y-2">
                        <p>
                          Because you were rated <span className="font-bold">Good</span> (green) on{' '}
                          <span className="font-bold">{goodDaysLastWeek} days last week</span>,
                          you've earned <span className="font-bold">unlimited posting</span> for this week.
                        </p>
                        <p>
                          You can post <span className="font-bold">any new rent request</span> for{' '}
                          <span className="font-bold">any amount</span> — there is no cap and no daily block.
                          Keep collecting daily to keep this unlocked next week.
                        </p>
                      </div>
                    </div>
                  );
                }
                const overCap = amount > perTenantMax;
                const pct = perTenantMax > 0
                  ? Math.min(100, Math.round((amount / perTenantMax) * 100))
                  : 100;
                return (
                  <div
                    className={`p-4 rounded-2xl border-2 space-y-3 scroll-mt-4 ${
                      overCap
                        ? 'bg-amber-500/10 border-amber-500/40'
                        : 'bg-success/10 border-success/40'
                    }`}
                  >
                    <p
                      className={`text-base font-extrabold flex items-center gap-2 ${
                        overCap ? 'text-amber-700 dark:text-amber-400' : 'text-success'
                      }`}
                    >
                      {overCap ? (
                        <AlertTriangle className="h-5 w-5 flex-shrink-0" />
                      ) : (
                        <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
                      )}
                      {overCap ? 'Over your current posting cap' : 'Within your posting cap'}
                    </p>

                    <details className="group" open={postingCapOpen} onToggle={handlePostingCapToggle}>
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-1 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                        <span>{overCap ? 'See why & how to unlock' : 'See cap details'}</span>
                        <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
                      </summary>
                      <div className="pt-3 space-y-3">
                    <div className="text-sm font-semibold text-foreground space-y-1.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">Your tier</span>
                        <span className="font-extrabold">
                          {myCap?.tier ?? 'Starter'}
                          {typeof myCap?.response_rate === 'number' && (
                            <span className="font-normal text-muted-foreground">
                              {' '}· {Math.round((myCap.response_rate ?? 0) * 100)}% 7-day
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">Cap per tenant</span>
                        <span className="font-extrabold">{formatUGX(perTenantMax)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">You entered</span>
                        <span className={`font-extrabold ${overCap ? 'text-amber-700 dark:text-amber-400' : 'text-success'}`}>
                          {formatUGX(amount)}
                        </span>
                      </div>
                    </div>

                    {/* Live usage meter against the cap */}
                    <div className="space-y-1">
                      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            overCap ? 'bg-amber-500' : 'bg-success'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="text-[11px] font-medium text-muted-foreground text-right">
                        {perTenantMax > 0 ? `${pct}% of cap used` : 'No posting allowance at this tier'}
                      </p>
                    </div>

                    {/* Plain-language explanation anyone can understand */}
                    <div
                      className={`text-xs leading-relaxed space-y-2 ${
                        overCap
                          ? 'text-amber-700/90 dark:text-amber-400/90'
                          : 'text-success/90'
                      }`}
                    >
                      {overCap ? (
                        perTenantMax <= 0 ? (
                          <>
                            <p className="font-bold">Right now you can't post any new rent request.</p>
                            <p>
                              This is because very few of your tenants have been paying
                              over the last 7 days. The system watches how often your
                              tenants pay — not how much — and yours is currently too low.
                            </p>
                            <p>
                              <span className="font-bold">What to do:</span> visit your
                              tenants and get at least a few of them to pay something
                              (even a small amount) each day. As more of them start
                              paying, your posting will open up again.
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="font-bold">
                              The amount you typed is bigger than what you are allowed to post per tenant.
                            </p>
                            <p>
                              You are on the <span className="font-bold">{myCap?.tier}</span> level.
                              At this level, the most you can post for one tenant is{' '}
                              <span className="font-bold">{formatUGX(perTenantMax)}</span>.
                              You typed <span className="font-bold">{formatUGX(amount)}</span>,
                              which is <span className="font-bold">{formatUGX(amount - perTenantMax)}</span>{' '}
                              over the limit, so the system cannot accept it yet.
                            </p>
                            <p>
                              <span className="font-bold">Why this happens:</span> your level
                              depends on how many of your tenants pay something during the
                              last 7 days. The more of them pay regularly, the higher your
                              level and the bigger the amount you are allowed to post.
                            </p>
                            <p>
                              <span className="font-bold">Your two options now:</span>
                            </p>
                            <ul className="list-disc pl-4 space-y-1">
                              <li>
                                Lower this request to <span className="font-bold">{formatUGX(perTenantMax)}</span>{' '}
                                or less and post it today, or
                              </li>
                              <li>
                                Save it for later and keep collecting from your tenants so
                                your level goes up.
                              </li>
                            </ul>
                            <p>
                              <span className="font-bold">How to unlock bigger amounts:</span>{' '}
                              get tenants paying on 4 out of every 10 days to reach{' '}
                              <span className="font-bold">UGX 3,000,000</span> per tenant, or
                              7 out of 10 days to reach <span className="font-bold">UGX 6,000,000</span> per tenant.
                            </p>
                          </>
                        )
                      ) : (
                        <>
                          <p className="font-bold">Good — this amount is fine to post.</p>
                          <p>
                            You are on the <span className="font-bold">{myCap?.tier}</span> level,
                            which lets you post up to{' '}
                            <span className="font-bold">{formatUGX(perTenantMax)}</span> for one tenant.
                            The <span className="font-bold">{formatUGX(amount)}</span> you typed is
                            within that limit, so you can go ahead and submit this request.
                          </p>
                        </>
                      )}

                      {/* Super-simple step-by-step with a concrete example */}
                      <div className="mt-3 pt-3 border-t border-dashed border-current/20 space-y-2">
                        <p className="font-bold text-[11px] uppercase tracking-wide opacity-70">
                          Quick example
                        </p>
                        <ol className="list-decimal pl-4 space-y-1.5 text-xs">
                          <li>
                            Your current limit is <span className="font-bold">{formatUGX(perTenantMax)}</span> per tenant.
                          </li>
                          <li>
                            If a tenant's rent is <span className="font-bold">{formatUGX(Math.min(amount || 500000, perTenantMax))}</span>, that is okay — it fits inside your limit.
                          </li>
                          <li>
                            If the rent is <span className="font-bold">{formatUGX(perTenantMax + 200000)}</span>, it is <span className="font-bold">{formatUGX(200000)}</span> too much — the system will stop you.
                          </li>
                          <li>
                            To post bigger amounts, collect from more tenants more often so your level goes up.
                          </li>
                        </ol>
                      </div>

                      {/* How to unlock — step-by-step checklist */}
                      <div className="mt-3 pt-3 border-t border-dashed border-current/20 space-y-2">
                        <p className="font-bold text-[11px] uppercase tracking-wide opacity-70">
                          How to unlock a bigger posting cap
                        </p>
                        <ol className="list-decimal pl-4 space-y-1.5 text-xs">
                          <li>
                            <span className="font-bold">Visit your tenants and collect rent</span> — even small amounts count.
                            You should see your <strong>Today&apos;s collection %</strong> go up on the agent home screen.
                          </li>
                          <li>
                            <span className="font-bold">Keep collecting for a few days</span>. Your daily rating improves when tenants pay on more days.
                            You will see your tier label change from <strong>{myCap?.tier ?? 'Starter'}</strong> upward.
                          </li>
                          <li>
                            <span className="font-bold">Reach Fair (4 out of 10 days)</span> and your cap will jump to{' '}
                            <span className="font-bold">{formatUGX(3_000_000)}</span> per tenant.
                            The breakdown panel will show <strong>Fair</strong> and the new limit.
                          </li>
                          <li>
                            <span className="font-bold">Reach Positive (7 out of 10 days)</span> and your cap will jump to{' '}
                            <span className="font-bold">{formatUGX(6_000_000)}</span> per tenant.
                            The breakdown panel will show <strong>Positive</strong> and the new limit.
                          </li>
                        </ol>
                        <p className="text-[11px] opacity-70">
                          Each time your tier goes up, come back to this screen and the cap shown above will update automatically.
                        </p>
                      </div>
                    </div>
                      </div>
                    </details>
                  </div>
                );
              })()}

              {/* Inline roadmap-step blocker — shows on the Review step so the
                  agent knows exactly which step is preventing post. Only the
                  landlord blocks posting; LC1 verification is required before
                  approval and is surfaced as an informational note instead. */}
              {detailStep === DETAIL_STEPS.length - 1 && (
                (landlordCheck !== 'registered' && landlordCheck !== 'unverified') ||
                landlordCheck === 'unverified' ||
                lc1Check !== 'verified'
              ) && (
                <div className="rounded-xl border-2 border-amber-500/40 bg-amber-500/10 p-4 space-y-2.5">
                  <p className="text-sm font-extrabold text-amber-700 flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 flex-shrink-0" />
                    {(landlordCheck !== 'registered' && landlordCheck !== 'unverified')
                      ? "Can't post yet — landlord not verified"
                      : 'You can post — landlord/LC1 will be verified before approval'}
                  </p>
                  <ul className="space-y-1.5">
                    {landlordCheck !== 'registered' && (
                      <li>
                        <button
                          type="button"
                          onClick={() => {
                            setDetailStep(2);
                            requestAnimationFrame(() => {
                              landlordSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            });
                          }}
                          className="flex w-full items-start gap-2 rounded-lg p-1.5 text-left text-sm font-semibold text-amber-800 transition-colors hover:bg-amber-500/20 active:scale-[0.98]"
                        >
                          <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-amber-500 text-white text-[10px] font-bold">2</span>
                          <span className="flex-1">Landlord verified — {landlordCheck === 'missing' ? 'Landlord is not registered. List the house or register them first.' : landlordCheck === 'unverified' ? 'Landlord is registered but awaiting verification — you can still post; Landlord Ops will verify before tenant activation.' : landlordCheck === 'checking' ? 'Checking landlord status… please wait.' : 'Landlord must be registered before you can post.'}</span>
                          <span className="text-[11px] font-bold text-amber-600 underline decoration-amber-500/50 underline-offset-2 flex-shrink-0">Go to step</span>
                        </button>
                      </li>
                    )}
                    {lc1Check !== 'verified' && (
                      <li>
                        <button
                          type="button"
                          onClick={() => {
                            setDetailStep(3);
                            requestAnimationFrame(() => {
                              lc1SectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            });
                          }}
                          className="flex w-full items-start gap-2 rounded-lg p-1.5 text-left text-sm font-semibold text-amber-800 transition-colors hover:bg-amber-500/20 active:scale-[0.98]"
                        >
                          <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-amber-500 text-white text-[10px] font-bold">3</span>
                          <span className="flex-1">LC1 verified before approval — {lc1Check === 'missing' ? 'LC1 will be registered from your details; verify before approval.' : lc1Check === 'unverified' ? 'LC1 is registered but awaiting verification — request it now.' : lc1Check === 'checking' ? 'Checking LC1 status… please wait.' : 'LC1 must be verified before this request is approved.'} You can still post now.</span>
                          <span className="text-[11px] font-bold text-amber-600 underline decoration-amber-500/50 underline-offset-2 flex-shrink-0">Go to step</span>
                        </button>
                      </li>
                    )}
                  </ul>
                  <p className="text-[11px] text-amber-700/80 leading-snug">
                    Tap a step above to jump straight to it. The landlord must be registered to post — Landlord Ops verifies them before the tenant is activated. The LC1 chairperson must be verified before the request is approved.
                  </p>
                </div>
              )}

              {/* Wizard navigation */}
              <div className="flex gap-3 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={goBackStep}
                  className="flex-1"
                >
                  {detailStep === 0 ? 'Back' : 'Previous'}
                </Button>
                {detailStep < DETAIL_STEPS.length - 1 ? (
                  <Button type="button" onClick={goNextStep} className="flex-1">
                    Next
                  </Button>
                ) : amount > perTenantMax ? (
                  <Button
                    type="button"
                    onClick={handleSaveForLater}
                    className="flex-1"
                    disabled={savingDraft || !amount}
                    variant="secondary"
                  >
                    {savingDraft ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving…</>
                    ) : (
                      `Save for later (over ${formatUGX(perTenantMax)} cap)`
                    )}
                  </Button>
                ) : (
                  <Button
                    onClick={submitQueued ? promptCancelQueued : requestSubmit}
                    className="flex-1"
                    variant={submitQueued ? 'secondary' : 'default'}
                    disabled={loading || !amount || amount < 50000 || (landlordCheck !== 'registered' && landlordCheck !== 'unverified') || weeklyEarnerBlocksSubmit}
                  >
                    {loading ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Submitting...
                      </>
                    ) : submitQueued ? (
                      <>
                        <X className="h-4 w-4 mr-2" />
                        Cancel submit
                      </>
                    ) : (
                      'Submit Request'
                    )}
                  </Button>
                )}
              </div>
              {detailStep === DETAIL_STEPS.length - 1 && amount > 0 && amount < 50000 && (
                <p className="text-xs font-semibold text-warning text-center -mt-1">
                  Rent amount must be at least UGX 50,000 to post.
                </p>
              )}
              {detailStep === DETAIL_STEPS.length - 1 && weeklyEarnerBlocksSubmit && (
                <p className="text-xs font-semibold text-warning text-center -mt-1">
                  Enter a valid 1 month rent so the weekly repayment can be computed before submitting.
                </p>
              )}
              {loading && (
                <p
                  role="status"
                  aria-live="polite"
                  className="flex items-center justify-center gap-2 pt-2 text-sm font-semibold text-primary"
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Sending your request… please wait.
                </p>
              )}
              </>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </DialogContent>
      {/* Photo preview lightbox */}
      {previewUrl && (
        <div
          className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4"
          onClick={() => setPreviewUrl(null)}
        >
          <div className="relative max-w-2xl w-full">
            <button
              type="button"
              onClick={() => setPreviewUrl(null)}
              className="absolute -top-10 right-0 w-8 h-8 rounded-full bg-white/20 text-white flex items-center justify-center hover:bg-white/30 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
            <img
              src={previewUrl}
              alt={previewLabel}
              className="w-full h-auto max-h-[80vh] object-contain rounded-lg"
            />
            {previewLabel && (
              <p className="text-white text-sm text-center mt-3 font-medium">{previewLabel}</p>
            )}
          </div>
        </div>
      )}
      <RegisterLandlordDialog
        open={showRegisterLandlord}
        onOpenChange={setShowRegisterLandlord}
        minimal={incomeType === 'outstanding'}
        onSuccess={(landlord) => {
          setShowRegisterLandlord(false);
          setLandlordMode('search');
          // Force the search popover to re-fetch fresh results.
          setLandlordPickerKey((k) => k + 1);
          if (landlord) {
            // Auto-select the just-registered landlord so the agent can proceed
            // immediately — registration is the priority, selection follows.
            applySelectedLandlord(landlord as LandlordOption);
          } else {
            toast.success('Landlord registered. Search to select them now.');
          }
        }}
      />
      <ListEmptyHouseDialog
        open={showListHouse}
        onOpenChange={setShowListHouse}
        initialLandlordName={landlordName || undefined}
        initialLandlordPhone={landlordPhone || undefined}
        initialLc1Name={lc1Name || undefined}
        initialLc1Phone={lc1Phone || undefined}
        initialLc1Village={lc1Village || undefined}
        onSuccess={() => {
          setShowListHouse(false);
          // The new house is available instantly — refresh the picker so the
          // agent can select it and link the tenant they're registering.
          setHouseSearchedOnce(false);
          searchAvailableHouses();
          // Listing a house also registers its landlord — refresh the
          // outstanding-flow landlord picker so it's immediately selectable.
          setLandlordPickerKey((k) => k + 1);
          toast.success('House listed — landlord & LC1 registered. They must be verified before you can post.');
        }}
      />
      <AlertDialog open={confirmCloseDialog} onOpenChange={setConfirmCloseDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard landlord details?</AlertDialogTitle>
            <AlertDialogDescription>
              You've entered landlord information. Closing now will clear it. Are you sure you want to discard your current inputs?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmCloseAndReset}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Discard &amp; close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showCancelConfirm} onOpenChange={setShowCancelConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel queued submit?</AlertDialogTitle>
            <AlertDialogDescription>
              Your request is waiting to submit. If you cancel, you'll need to tap Submit again when you're ready.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowCancelConfirm(false)}>Keep queued</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowCancelConfirm(false);
                cancelQueuedSubmit();
              }}
            >
              Yes, cancel
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>

    <Dialog
      open={fieldFormPreviewOpen}
      onOpenChange={(o) => {
        if (!o) closeFieldFormPreview();
      }}
    >
      <DialogContent className="w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] sm:max-w-2xl max-h-[92dvh] flex flex-col overflow-hidden p-0">
        <DialogHeader className="px-4 pt-4 sm:px-5 sm:pt-5 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileText className="h-5 w-5 text-primary" />
            Field form preview
          </DialogTitle>
          <DialogDescription className="text-sm">
            Review the blank form, then download or share it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 px-4 sm:px-5">
          {fieldFormPreviewUrl ? (
            isMobile ? (
              <button
                type="button"
                onClick={openFieldFormFullScreen}
                className="flex w-full h-full min-h-[12rem] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/50 px-4 text-center"
              >
                <FileText className="h-10 w-10 text-primary" />
                <span className="text-sm font-medium">Tap to open the form full screen</span>
                <span className="text-xs text-muted-foreground">
                  PDFs preview better in your browser. You can also download or share it below.
                </span>
              </button>
            ) : (
              <iframe
                src={fieldFormPreviewUrl}
                title="Rent request field form preview"
                className="w-full h-full min-h-[12rem] rounded-lg border border-border bg-muted"
              />
            )
          ) : (
            <div className="flex h-full min-h-[12rem] items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
        <div className="flex flex-col sm:flex-row gap-2 px-4 py-3 sm:px-5 sm:py-4 border-t border-border shrink-0">
          {isMobile && (
            <Button
              type="button"
              variant="outline"
              className="flex-1 gap-2"
              onClick={openFieldFormFullScreen}
              disabled={!fieldFormPreviewUrl}
            >
              <ExternalLink className="h-4 w-4" />
              Open full screen
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            className="flex-1 gap-2"
            onClick={downloadFieldForm}
            disabled={!fieldFormBlob}
          >
            <FileText className="h-4 w-4" />
            Download PDF
          </Button>
          <Button
            type="button"
            className="flex-1 gap-2"
            onClick={shareFieldForm}
            disabled={!fieldFormBlob}
          >
            <Share2 className="h-4 w-4" />
            Share PDF (WhatsApp)
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    <EntityDetailSheet
      open={!!landlordProfile}
      onClose={() => setLandlordProfile(null)}
      fullScreenOnMobile
      title={landlordProfile?.landlord_name || 'Landlord'}
      subtitle={landlordProfile?.landlord_phone ? formatPhoneInput(landlordProfile.landlord_phone) : 'No phone on file'}
      icon={<User className="h-4 w-4 text-primary" />}
      fields={[
        { label: 'Name', value: landlordProfile?.landlord_name || '—' },
        { label: 'Phone', value: landlordProfile?.landlord_phone ? formatPhoneInput(landlordProfile.landlord_phone) : '—' },
        { label: 'Property', value: landlordProfile?.title || '—' },
        { label: 'Address', value: [landlordProfile?.address, landlordProfile?.region].filter(Boolean).join(', ') || '—' },
        { label: 'District', value: landlordProfile?.district || '—' },
        { label: 'Monthly rent', value: landlordProfile?.monthly_rent ? `${formatUGX(landlordProfile.monthly_rent)}/mo` : '—' },
      ]}
    >
      {landlordProfile?.landlord_phone && (
        <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-xs font-medium text-muted-foreground mb-2">
            Contact the landlord before confirming
          </p>
          <PhoneContactActions phone={landlordProfile.landlord_phone} />
        </div>
      )}
      <Button
        type="button"
        className="mt-4 w-full gap-2"
        onClick={() => {
          if (landlordProfile) selectHouse(landlordProfile);
          setLandlordProfile(null);
        }}
      >
        <CheckCircle2 className="h-4 w-4" />
        Confirm and select landlord
      </Button>
    </EntityDetailSheet>

    {/* Duplicate blocked → resubmit the existing rejected request instead */}
    <AgentEditRentRequestDialog
      request={resubmitTarget}
      open={!!resubmitTarget}
      onOpenChange={(o) => { if (!o) setResubmitTarget(null); }}
      onResubmitted={() => {
        setResubmitTarget(null);
        onSuccess?.();
        onOpenChange(false);
      }}
    />
    </>
  );
}
