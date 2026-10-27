import { useState } from 'react';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Banknote,
  Building2,
  CheckCircle2,
  Clock,
  Copy,
  Edit3,
  ExternalLink,
  History,
  Home,
  Loader2,
  MapPin,
  MessageCircle,
  Phone,
  PhoneCall,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  UserCheck,
  Users,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { toWhatsAppUrl } from '@/components/ops/ContactActions';
import { useAuth } from '@/hooks/useAuth';
import { useConfirmLandlordPayoutNumber } from '@/hooks/useLandlordPayoutNumberReview';
import {
  awarenessLabel,
  consentLabel,
  explainedLabel,
  telHref,
} from '@/lib/awarenessCallLabels';
import {
  HUB_CATEGORY_LABELS,
  HUB_FEEDBACK_CATEGORIES,
  HUB_NOTE_MIN_LENGTH,
  HUB_PLAN_STAGE_LABELS,
  HUB_RESULT_LABELS,
  HUB_SEVERITY_OPTIONS,
  HUB_VERIFICATION_STATUS_LABELS,
  formatCheckFlagLabel,
  formatHubError,
  useLandlordHubAmendCall,
  useLandlordHubDetail,
  useLandlordHubStartDial,
  type LandlordHubCallHistoryItem,
  type LandlordHubFeedbackCategory,
  type LandlordHubRow,
  type LandlordHubSeverity,
  type LandlordHubStartedDial,
  type LandlordHubTenantPlan,
} from '@/hooks/useLandlordCallingHub';

export interface LandlordCallingHubCardProps {
  open: boolean;
  onClose: () => void;
  row: LandlordHubRow | null;
  onDialStarted: (dial: LandlordHubStartedDial) => void;
  onOpenRecordDialog: (opts: {
    landlordKey: string;
    landlordId?: string | null;
    landlordName: string;
    phone: string;
    dialId?: string | null;
    dialStartedAt?: string | null;
    manualMode?: boolean;
    tenantPlans?: LandlordHubTenantPlan[];
  }) => void;
}

function formatSourceLabel(src: LandlordHubCallHistoryItem['source']): string {
  switch (src) {
    case 'calling_hub':
      return 'Landlord Calling Hub';
    case 'awareness':
      return 'Rent Plan Awareness';
    case 'verification':
      return 'Phone Verification';
  }
}

function verificationStatusBadgeVariant(
  vStatus: string | null | undefined,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch ((vStatus || 'pending').toLowerCase()) {
    case 'verified':
      return 'default';
    case 'rejected':
      return 'destructive';
    case 'pending':
    default:
      return 'secondary';
  }
}

export function LandlordCallingHubCard({
  open,
  onClose,
  row,
  onDialStarted,
  onOpenRecordDialog,
}: LandlordCallingHubCardProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const landlordKey = row?.landlord_key ?? null;

  const detailQuery = useLandlordHubDetail(landlordKey, open && Boolean(landlordKey));
  const startDialMutation = useLandlordHubStartDial();
  const amendMutation = useLandlordHubAmendCall();
  const confirmPayoutMutation = useConfirmLandlordPayoutNumber();

  const [dialRefusalError, setDialRefusalError] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<LandlordHubTenantPlan | null>(null);

  // Payout number review dialog state (matches LandlordContextPanel flow)
  const [payoutDialogOpen, setPayoutDialogOpen] = useState(false);
  const [proposedPayoutNumber, setProposedPayoutNumber] = useState('');
  const [payoutReviewReason, setPayoutReviewReason] = useState('');

  // 24-hour same-caller amendment dialog state
  const [amendingCall, setAmendingCall] = useState<LandlordHubCallHistoryItem | null>(null);
  const [amendCategory, setAmendCategory] = useState<LandlordHubFeedbackCategory>('reached_ok');
  const [amendSeverity, setAmendSeverity] = useState<LandlordHubSeverity>('normal');
  const [amendNote, setAmendNote] = useState('');
  const [amendReason, setAmendReason] = useState('');
  const [amendError, setAmendError] = useState<string | null>(null);

  const detail = detailQuery.data;
  const displayName = detail?.landlord_name || row?.landlord_name || 'Landlord';
  const primaryPhone =
    (detail?.phones && detail.phones.length > 0 ? detail.phones[0] : row?.phone) || '';
  const hasCallablePhone =
    Boolean(primaryPhone) &&
    primaryPhone !== '—' &&
    !primaryPhone.includes('*') &&
    primaryPhone.replace(/\D/g, '').length >= 7;

  const checkFlags = detail?.check_flags ?? row?.check_flags ?? [];
  const isCheckFirst = Boolean(
    detail?.needs_check || row?.needs_check || checkFlags.length > 0,
  );
  const plansTotalCount =
    detail?.plans_total ?? row?.plans_total ?? detail?.tenants_and_plans?.length ?? 0;

  const vStatusKey = (
    detail?.verification_status ||
    row?.verification_status ||
    ((detail?.verified ?? row?.verified) ? 'verified' : 'pending')
  ).toLowerCase();
  const vStatusLabel = HUB_VERIFICATION_STATUS_LABELS[vStatusKey] || 'Pending';

  const planStage = detail?.plan_stage ?? row?.plan_stage ?? 'registered_only';
  const planStageLabel = HUB_PLAN_STAGE_LABELS[planStage] || 'Registered only';

  const activeDial = detail?.active_dial;
  const activeColleagueDial =
    activeDial && activeDial.caller_id !== user?.id ? activeDial : null;

  const handleStartCall = async (phoneToCall: string) => {
    if (!landlordKey || isCheckFirst) return;
    setDialRefusalError(null);
    try {
      const resp = await startDialMutation.mutateAsync({
        landlordKey,
        phone: phoneToCall,
        landlordName: displayName,
        landlordId: detail?.landlord_id ?? row?.landlord_id ?? null,
      });

      const started: LandlordHubStartedDial = {
        dial_id: resp.dial_id,
        landlord_key: resp.landlord_key || landlordKey,
        landlord_id: detail?.landlord_id ?? row?.landlord_id ?? null,
        landlord_name: displayName,
        phone: resp.phone || phoneToCall,
        started_at: resp.started_at || new Date().toISOString(),
        expires_at: resp.expires_at,
      };
      onDialStarted(started);

      const href = telHref(phoneToCall);
      if (
        href &&
        typeof window !== 'undefined' &&
        !/jsdom/i.test(window.navigator?.userAgent || '')
      ) {
        try {
          window.location.href = href;
        } catch {
          // ignore navigation error in test environments
        }
      }
    } catch (err) {
      const msg = formatHubError(err);
      setDialRefusalError(msg);
      toast.error(msg);
    }
  };

  const handleCopyNumber = async (phoneToCopy: string) => {
    if (!phoneToCopy || phoneToCopy === '—') return;
    try {
      await navigator.clipboard.writeText(phoneToCopy);
      toast.success(`Copied ${phoneToCopy}`);
    } catch {
      toast.error('Could not copy phone number');
    }
  };

  const openPayoutReviewDialog = () => {
    const curr =
      detail?.payout_details.primary_payout_number ||
      detail?.payout_details.verified_mobile_money_number ||
      detail?.payout_details.mobile_money_number ||
      primaryPhone ||
      '';
    setProposedPayoutNumber(curr);
    setPayoutReviewReason('');
    setPayoutDialogOpen(true);
  };

  const handleConfirmPayoutNumber = async () => {
    const llId = detail?.landlord_id ?? row?.landlord_id;
    if (!llId) {
      toast.error('No landlord record linked for payout review.');
      return;
    }
    if (!proposedPayoutNumber.trim()) {
      toast.error('Enter the payout phone number to submit for review.');
      return;
    }
    try {
      await confirmPayoutMutation.mutateAsync({
        landlordId: llId,
        number: proposedPayoutNumber.trim(),
        reason:
          payoutReviewReason.trim() ||
          'Confirmed during Landlord Calling Hub call',
      });
      toast.success('Payout number submitted through the Payout Review flow.');
      setPayoutDialogOpen(false);
      detailQuery.refetch();
    } catch (err) {
      toast.error(formatHubError(err));
    }
  };

  const openAmendDialog = (item: LandlordHubCallHistoryItem) => {
    setAmendingCall(item);
    setAmendCategory(item.feedback_category ?? 'reached_ok');
    setAmendSeverity(item.severity ?? 'normal');
    setAmendNote(item.note ?? '');
    setAmendReason('');
    setAmendError(null);
  };

  const handleSaveAmendment = async () => {
    if (!amendingCall || !landlordKey) return;
    setAmendError(null);
    const changes: Record<string, unknown> = {
      note: amendNote.trim(),
    };
    if (amendingCall.result === 'answered') {
      changes.feedback_category = amendCategory;
      changes.severity = amendSeverity;
    }
    try {
      await amendMutation.mutateAsync({
        callId: amendingCall.call_id,
        landlordKey,
        changes,
        reason: amendReason.trim(),
      });
      toast.success('Call correction saved.');
      setAmendingCall(null);
    } catch (err) {
      setAmendError(formatHubError(err));
    }
  };

  const canAmendCall = (item: LandlordHubCallHistoryItem): boolean => {
    if (item.source !== 'calling_hub') return false;
    if (!user?.id || item.caller_id !== user.id) return false;
    if (!item.called_at) return false;
    const ageMs = Date.now() - new Date(item.called_at).getTime();
    return ageMs <= 24 * 60 * 60 * 1000;
  };

  const payoutConfirmed = Boolean(
    detail?.payout_details.payout_number_confirmed ||
      detail?.payout_details.verified_mobile_money_number,
  );
  const displayedPayoutNumber =
    detail?.payout_details.primary_payout_number ||
    detail?.payout_details.verified_mobile_money_number ||
    detail?.payout_details.mobile_money_number ||
    null;

  const registrarNotActive =
    detail?.registering_agent?.is_agent_now === false ||
    detail?.registrar_is_agent_now === false ||
    row?.registrar_is_agent_now === false;

  const shownPlansCount = detail?.tenants_and_plans.length ?? 0;
  const totalPlansCount = Math.max(
    shownPlansCount,
    detail?.plans_total ?? row?.plans_total ?? shownPlansCount,
  );

  return (
    <>
      <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
        <SheetContent
          side="right"
          data-testid="landlord-hub-card"
          className="flex w-full sm:max-w-xl flex-col gap-0 overflow-y-auto p-4 sm:p-5"
        >
          <SheetHeader className="text-left space-y-1 pb-3 border-b border-border">
            <div className="flex items-center gap-2 flex-wrap">
              <SheetTitle className="text-base font-bold text-foreground">
                {displayName}
              </SheetTitle>
              <Badge
                variant={verificationStatusBadgeVariant(vStatusKey)}
                data-testid="hub-card-vstatus-badge"
                className="text-xs"
              >
                <ShieldCheck className="h-3 w-3 mr-1" />
                {vStatusLabel}
              </Badge>
              <Badge variant="outline" data-testid="hub-card-stage-badge" className="text-xs">
                {planStageLabel}
              </Badge>
              {(detail?.needs_review ?? row?.needs_review) && (
                <Badge variant="destructive" className="text-xs">
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Needs review
                </Badge>
              )}
            </div>
            <SheetDescription className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
              {(detail?.district || row?.district || detail?.region || row?.region) && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  {[
                    detail?.village,
                    detail?.district ?? row?.district,
                    detail?.region ?? row?.region,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )}
              {(detail?.registering_agent?.full_name || row?.agent_name) && (
                <span className="inline-flex items-center gap-1">
                  <UserCheck className="h-3 w-3" />
                  Registered by: {detail?.registering_agent?.full_name || row?.agent_name}
                </span>
              )}
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-4 pt-4">
            {/* "Check first" Flag Banner (disables direct calling) */}
            {isCheckFirst && (
              <div
                role="alert"
                data-testid="hub-card-check-first-banner"
                className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-3.5 text-xs text-foreground space-y-2"
              >
                <div className="font-bold flex items-center gap-1.5 text-amber-800 dark:text-amber-200">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  Check first before calling
                </div>
                {checkFlags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {checkFlags.map((flag) => (
                      <Badge
                        key={flag}
                        variant="outline"
                        className="text-xs border-amber-500/60 bg-background/80 text-amber-900 dark:text-amber-100"
                      >
                        {formatCheckFlagLabel(flag, plansTotalCount)}
                      </Badge>
                    ))}
                  </div>
                )}
                <p
                  data-testid="hub-card-call-disabled-note"
                  className="text-xs text-muted-foreground"
                >
                  Calling is disabled until a Landlord Ops lead reviews the flagged issue above.
                </p>
              </div>
            )}

            {/* Active Colleague Dial Warning or Refusal */}
            {(activeColleagueDial || row?.being_called_by || dialRefusalError) && (
              <div
                role="alert"
                data-testid="hub-colleague-dial-banner"
                className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-foreground space-y-1"
              >
                <div className="font-semibold flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
                  <PhoneCall className="h-3.5 w-3.5 shrink-0" />
                  {dialRefusalError
                    ? dialRefusalError
                    : `Being called by ${activeColleagueDial?.caller_name || row?.being_called_by}${
                        activeColleagueDial?.started_at || row?.being_called_since
                          ? ` since ${format(
                              new Date(
                                (activeColleagueDial?.started_at || row?.being_called_since)!,
                              ),
                              'HH:mm',
                            )}`
                          : ''
                      }`}
                </div>
                <p className="text-xs text-muted-foreground">
                  Wait until your colleague records their call or the 20-minute dial lock expires.
                </p>
              </div>
            )}

            {/* Primary Call Bar + Fallbacks */}
            <div className="rounded-xl border border-border bg-muted/20 p-3.5 space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <div className="text-xs text-muted-foreground">Primary phone</div>
                  <div
                    data-testid="hub-card-phone"
                    className="text-sm font-mono font-bold text-foreground mt-0.5"
                  >
                    {primaryPhone || 'No phone on file'}
                  </div>
                </div>
                {detail?.phones && detail.phones.length > 1 && (
                  <div className="text-xs text-muted-foreground font-mono">
                    Other: {detail.phones.slice(1).join(', ')}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <Button
                  type="button"
                  data-testid="hub-card-call-btn"
                  disabled={
                    isCheckFirst || !hasCallablePhone || startDialMutation.isPending
                  }
                  onClick={() => handleStartCall(primaryPhone)}
                  className="min-h-[44px] text-xs font-semibold gap-1.5"
                >
                  {startDialMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Phone className="h-4 w-4" />
                  )}
                  {isCheckFirst
                    ? 'Calling disabled (Check first)'
                    : `Call ${primaryPhone || 'landlord'}`}
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  data-testid="hub-card-copy-btn"
                  disabled={!primaryPhone || primaryPhone === '—'}
                  onClick={() => handleCopyNumber(primaryPhone)}
                  className="min-h-[44px] text-xs gap-1.5"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy number
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  asChild={hasCallablePhone && !isCheckFirst}
                  disabled={!hasCallablePhone || isCheckFirst}
                  data-testid="hub-card-whatsapp-btn"
                  className="min-h-[44px] text-xs gap-1.5"
                >
                  {hasCallablePhone && !isCheckFirst ? (
                    <a
                      href={toWhatsAppUrl(
                        primaryPhone,
                        `Hello ${displayName}, this is Welile Landlord Operations.`,
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <MessageCircle className="h-3.5 w-3.5 text-emerald-600" />
                      WhatsApp
                    </a>
                  ) : (
                    <span>
                      <MessageCircle className="h-3.5 w-3.5" />
                      WhatsApp
                    </span>
                  )}
                </Button>
              </div>

              {!isCheckFirst && (
                <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/60 flex-wrap">
                  <span className="text-xs text-muted-foreground">
                    Called from another handset or returned from a call?
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    data-testid="hub-card-manual-record-btn"
                    className="min-h-[44px] text-xs font-medium"
                    onClick={() => {
                      if (!landlordKey) return;
                      onOpenRecordDialog({
                        landlordKey,
                        landlordId: detail?.landlord_id ?? row?.landlord_id ?? null,
                        landlordName: displayName,
                        phone: primaryPhone,
                        manualMode: true,
                        tenantPlans: detail?.tenants_and_plans ?? [],
                      });
                    }}
                  >
                    Record a call I made another way
                  </Button>
                </div>
              )}
            </div>

            {detailQuery.isLoading ? (
              <div className="space-y-3" data-testid="hub-card-loading">
                <Skeleton className="h-24 w-full rounded-xl" />
                <Skeleton className="h-28 w-full rounded-xl" />
                <Skeleton className="h-36 w-full rounded-xl" />
              </div>
            ) : detailQuery.isError ? (
              <div
                role="alert"
                data-testid="hub-card-error"
                className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 space-y-2 text-xs"
              >
                <p className="font-semibold text-destructive">
                  {formatHubError(detailQuery.error)}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-[44px] text-xs"
                  onClick={() => detailQuery.refetch()}
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  Retry loading card
                </Button>
              </div>
            ) : detail ? (
              <>
                {/* Summary KPI Strip */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="rounded-xl border border-border bg-card p-2.5">
                    <div className="text-xs text-muted-foreground">Live Rent Plans</div>
                    <div className="text-base font-bold tabular-nums mt-0.5">
                      {detail.live_rent_plans}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {formatUGX(detail.rent_plan_value)}
                    </div>
                  </div>

                  <div className="rounded-xl border border-border bg-card p-2.5">
                    <div className="text-xs text-muted-foreground">Houses</div>
                    <div className="text-base font-bold tabular-nums mt-0.5">
                      {detail.houses_count}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {detail.property_address || 'Listed properties'}
                    </div>
                  </div>

                  <div className="rounded-xl border border-border bg-card p-2.5">
                    <div className="text-xs text-muted-foreground">Total Paid Out</div>
                    <div className="text-base font-bold tabular-nums text-emerald-700 dark:text-emerald-400 mt-0.5">
                      {formatUGX(detail.payout_details.total_paid_out_ugx)}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      Cumulative payouts
                    </div>
                  </div>

                  <div className="rounded-xl border border-border bg-card p-2.5">
                    <div className="text-xs text-muted-foreground">Last Payout</div>
                    <div className="text-xs font-semibold mt-1">
                      {detail.payout_details.last_payout_at
                        ? format(new Date(detail.payout_details.last_payout_at), 'dd MMM yyyy')
                        : 'None yet'}
                    </div>
                    <div className="text-xs text-muted-foreground truncate mt-0.5">
                      {detail.registered_at
                        ? `Reg ${format(new Date(detail.registered_at), 'dd MMM yyyy')}`
                        : 'Registry'}
                    </div>
                  </div>
                </div>

                {/* Payout Numbers & Verification (uses confirm_landlord_payout_number) */}
                <div className="rounded-xl border border-border bg-card p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <Smartphone className="h-4 w-4 text-primary shrink-0" />
                      <span className="text-xs font-bold text-foreground">
                        Payout Numbers & Bank Details
                      </span>
                    </div>
                    {detail.landlord_id && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid="hub-confirm-payout-btn"
                        className="min-h-[44px] text-xs gap-1.5"
                        onClick={openPayoutReviewDialog}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                        Confirm payout number
                      </Button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg bg-muted/40 p-2.5 space-y-1">
                      <div className="flex items-center justify-between gap-1.5 flex-wrap">
                        <span className="text-xs text-muted-foreground">
                          Payout Mobile Money Number
                        </span>
                        {payoutConfirmed && (
                          <Badge
                            variant="default"
                            data-testid="hub-payout-confirmed-badge"
                            className="text-xs bg-emerald-600 text-white"
                          >
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                            Confirmed
                          </Badge>
                        )}
                      </div>
                      <div className="font-mono font-semibold text-foreground">
                        {displayedPayoutNumber || 'Not recorded'}
                      </div>
                      {detail.payout_details.mobile_money_name && (
                        <div className="text-xs text-muted-foreground">
                          Name: {detail.payout_details.mobile_money_name}
                        </div>
                      )}
                      {detail.payout_details.verified_mobile_money_number && (
                        <div className="text-xs text-emerald-700 dark:text-emerald-400 font-mono">
                          Confirmed payout number:{' '}
                          {detail.payout_details.verified_mobile_money_number}
                        </div>
                      )}
                    </div>

                    <div className="rounded-lg bg-muted/40 p-2.5 space-y-0.5">
                      <div className="text-xs text-muted-foreground">Bank Account</div>
                      <div className="font-medium text-foreground">
                        {detail.payout_details.bank_name
                          ? `${detail.payout_details.bank_name}${
                              detail.payout_details.bank_branch
                                ? ` (${detail.payout_details.bank_branch})`
                                : ''
                            }`
                          : 'Mobile Money primary'}
                      </div>
                      {detail.payout_details.account_number && (
                        <div className="font-mono text-xs text-muted-foreground">
                          Acct: {detail.payout_details.account_number}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Caretaker & Registered by */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  <div className="rounded-xl border border-border bg-card p-3 space-y-1">
                    <div className="flex items-center gap-1.5 font-bold text-foreground">
                      <Building2 className="h-3.5 w-3.5 text-primary" />
                      Caretaker
                    </div>
                    {detail.caretaker?.name || detail.caretaker?.phone ? (
                      <div className="text-xs text-foreground space-y-0.5">
                        <div>{detail.caretaker.name || 'Caretaker'}</div>
                        {detail.caretaker.phone && (
                          <div className="font-mono text-muted-foreground">
                            {detail.caretaker.phone}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        No caretaker recorded.
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-border bg-card p-3 space-y-1">
                    <div className="flex items-center justify-between gap-1.5 flex-wrap">
                      <div className="flex items-center gap-1.5 font-bold text-foreground">
                        <UserCheck className="h-3.5 w-3.5 text-primary" />
                        Registered by
                      </div>
                      {registrarNotActive && detail.registering_agent && (
                        <Badge
                          variant="outline"
                          data-testid="hub-agent-not-active-note"
                          className="text-xs border-amber-500/60 text-amber-800 dark:text-amber-200"
                        >
                          No longer an agent
                        </Badge>
                      )}
                    </div>
                    {detail.registering_agent?.full_name ? (
                      <div className="text-xs text-foreground space-y-0.5">
                        <div className="font-medium">{detail.registering_agent.full_name}</div>
                        {detail.registering_agent.phone && (
                          <div className="font-mono text-muted-foreground">
                            {detail.registering_agent.phone}
                          </div>
                        )}
                        {detail.registered_at && (
                          <div className="text-xs text-muted-foreground">
                            Registered {format(new Date(detail.registered_at), 'dd MMM yyyy')}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        No registering agent recorded.
                        {detail.registered_at && (
                          <span className="block mt-0.5">
                            Registered {format(new Date(detail.registered_at), 'dd MMM yyyy')}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Tenants & Rent Plans (capped at 50, showing "Showing N of TOTAL") */}
                <div className="rounded-xl border border-border bg-card p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                      <Users className="h-4 w-4 text-primary" />
                      Tenants & Rent Plans
                    </div>
                    <span
                      data-testid="hub-tenants-showing-count"
                      className="text-xs text-muted-foreground"
                    >
                      Showing {shownPlansCount.toLocaleString()} of{' '}
                      {totalPlansCount.toLocaleString()}
                    </span>
                  </div>

                  {detail.tenants_and_plans.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-1">
                      No Rent Plans linked to this landlord yet.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {detail.tenants_and_plans.map((tp) => (
                        <button
                          key={tp.rent_request_id}
                          type="button"
                          data-testid={`hub-tenant-plan-${tp.rent_request_id}`}
                          onClick={() => setSelectedPlan(tp)}
                          className="w-full min-h-[48px] rounded-xl border border-border/80 bg-muted/20 hover:bg-muted/50 p-3 text-left transition-colors space-y-1.5"
                        >
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-bold text-foreground">
                                {tp.tenant_name}
                              </span>
                              {tp.tenant_phone && (
                                <span className="text-xs font-mono text-muted-foreground">
                                  {tp.tenant_phone}
                                </span>
                              )}
                            </div>
                            <Badge variant="outline" className="text-xs">
                              {tp.status}
                            </Badge>
                          </div>
                          <div className="grid grid-cols-3 gap-2 text-xs">
                            <div>
                              <span className="text-muted-foreground block">Rent</span>
                              <span className="font-semibold text-foreground">
                                {formatUGX(tp.rent_amount)}
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block">Repaid</span>
                              <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                                {formatUGX(tp.amount_repaid)}
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block">Outstanding</span>
                              <span className="font-semibold text-foreground">
                                {formatUGX(tp.outstanding)}
                              </span>
                            </div>
                          </div>
                          {tp.agent_name && (
                            <div className="text-xs text-muted-foreground">
                              Tenant&apos;s agent: <span className="text-foreground font-medium">{tp.agent_name}</span>
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Houses */}
                <div className="rounded-xl border border-border bg-card p-3.5 space-y-2.5">
                  <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                    <Home className="h-4 w-4 text-primary" />
                    Houses ({detail.houses.length})
                  </div>

                  {detail.houses.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-1">
                      No individual house listings recorded for this landlord.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {detail.houses.map((h) => (
                        <div
                          key={h.id}
                          className="rounded-lg border border-border/70 bg-muted/20 p-2.5 text-xs space-y-1"
                        >
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="font-semibold text-foreground truncate">
                              {h.title}
                            </span>
                            <Badge variant="outline" className="text-xs">
                              {h.status}
                            </Badge>
                          </div>
                          <div className="text-xs text-muted-foreground flex items-center justify-between">
                            <span className="truncate">
                              {[
                                h.district || h.region,
                                h.number_of_rooms ? `${h.number_of_rooms} rooms` : null,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                            <span className="font-semibold text-foreground">
                              {formatUGX(h.monthly_rent)}/mo
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Payouts History */}
                <div className="rounded-xl border border-border bg-card p-3.5 space-y-2.5">
                  <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                    <Banknote className="h-4 w-4 text-primary" />
                    Payouts ({detail.payouts.length})
                  </div>

                  {detail.payouts.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-1">
                      No payouts recorded for this landlord yet.
                    </p>
                  ) : (
                    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                      {detail.payouts.map((p) => (
                        <div
                          key={`${p.source}-${p.id}`}
                          className="flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/15 px-3 py-2 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="font-semibold text-foreground">
                              {formatUGX(p.amount)}
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                              {p.paid_at
                                ? format(new Date(p.paid_at), 'dd MMM yyyy')
                                : 'Recorded'}{' '}
                              {p.reference ? `· Ref ${p.reference}` : ''}
                            </div>
                          </div>
                          <Badge variant="outline" className="text-xs shrink-0">
                            {p.status || 'paid'}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Call History with Feedback */}
                <div className="rounded-xl border border-border bg-card p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                      <History className="h-4 w-4 text-primary" />
                      Call History ({detail.call_history.length})
                    </div>
                  </div>

                  {detail.call_history.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-1">
                      No calls have been recorded for this landlord yet.
                    </p>
                  ) : (
                    <div className="space-y-2.5">
                      {detail.call_history.map((item) => (
                        <div
                          key={`${item.source}-${item.call_id}`}
                          data-testid={`hub-history-item-${item.call_id}`}
                          className="rounded-xl border border-border/80 bg-muted/15 p-3 text-xs space-y-1.5"
                        >
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <Badge variant="default" className="text-xs">
                                {HUB_RESULT_LABELS[item.result] || item.result}
                              </Badge>
                              <Badge variant="outline" className="text-xs">
                                {formatSourceLabel(item.source)}
                              </Badge>
                              {item.feedback_category && (
                                <Badge variant="secondary" className="text-xs">
                                  {HUB_CATEGORY_LABELS[item.feedback_category] ||
                                    item.feedback_category}
                                </Badge>
                              )}
                              {item.severity && item.severity !== 'normal' && (
                                <Badge
                                  variant={
                                    item.severity === 'critical' ? 'destructive' : 'outline'
                                  }
                                  className="text-xs uppercase"
                                >
                                  {item.severity}
                                </Badge>
                              )}
                              {item.is_amended && (
                                <Badge variant="outline" className="text-xs">
                                  Amended
                                </Badge>
                              )}
                            </div>

                            {canAmendCall(item) && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                data-testid={`hub-amend-btn-${item.call_id}`}
                                className="min-h-[44px] text-xs gap-1"
                                onClick={() => openAmendDialog(item)}
                              >
                                <Edit3 className="h-3.5 w-3.5" />
                                Edit (24h)
                              </Button>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              By <strong className="text-foreground">{item.caller_name || 'Officer'}</strong>
                            </span>
                            {item.called_at && (
                              <span className="inline-flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {format(new Date(item.called_at), 'dd MMM yyyy · HH:mm')}
                              </span>
                            )}
                            {item.phone_dialed && (
                              <span className="font-mono">{item.phone_dialed}</span>
                            )}
                          </div>

                          {item.call_back_at && (
                            <div className="text-xs font-medium text-amber-700 dark:text-amber-300">
                              Call back scheduled for{' '}
                              {format(new Date(item.call_back_at), 'dd MMM yyyy · HH:mm')}
                            </div>
                          )}

                          {/* Awareness answers summary if present */}
                          {(item.aware_30m ||
                            item.landlord_consent ||
                            item.aware_payout_otp ||
                            item.explained) && (
                            <div className="rounded-lg bg-background/80 border border-border/60 p-2 text-xs space-y-0.5">
                              {item.aware_30m && (
                                <div>
                                  <span className="text-muted-foreground">UGX 30M Rent Plan access: </span>
                                  <span className="font-medium">
                                    {awarenessLabel(item.aware_30m)}
                                  </span>
                                </div>
                              )}
                              {item.landlord_consent && (
                                <div>
                                  <span className="text-muted-foreground">Consent: </span>
                                  <span className="font-medium">
                                    {consentLabel(item.landlord_consent)}
                                  </span>
                                </div>
                              )}
                              {item.aware_payout_otp && (
                                <div>
                                  <span className="text-muted-foreground">Payout verification code: </span>
                                  <span className="font-medium">
                                    {awarenessLabel(item.aware_payout_otp)}
                                  </span>
                                </div>
                              )}
                              {item.explained && (
                                <div>
                                  <span className="text-muted-foreground">Explained clearly: </span>
                                  <span className="font-medium">
                                    {explainedLabel(item.explained)}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}

                          {item.note && (
                            <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap">
                              {item.note}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      {/* Tenant Rent Plan Detail Dialog (tap to open) */}
      <Dialog
        open={Boolean(selectedPlan)}
        onOpenChange={(next) => !next && setSelectedPlan(null)}
      >
        <DialogContent
          data-testid="hub-tenant-plan-dialog"
          className="w-[95vw] max-w-md p-4 sm:p-5"
        >
          {selectedPlan && (
            <>
              <DialogHeader className="text-left">
                <DialogTitle className="text-base font-bold">
                  Rent Plan · {selectedPlan.tenant_name}
                </DialogTitle>
                <DialogDescription className="text-xs">
                  Status: {selectedPlan.status}
                  {selectedPlan.tenant_phone ? ` · ${selectedPlan.tenant_phone}` : ''}
                </DialogDescription>
              </DialogHeader>

              <div className="grid grid-cols-2 gap-2.5 py-2 text-xs">
                <div className="rounded-lg border border-border bg-muted/20 p-2.5">
                  <div className="text-muted-foreground">Rent Amount</div>
                  <div className="text-sm font-bold mt-0.5">
                    {formatUGX(selectedPlan.rent_amount)}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 p-2.5">
                  <div className="text-muted-foreground">Daily Repayment</div>
                  <div className="text-sm font-bold mt-0.5">
                    {formatUGX(selectedPlan.daily_repayment)}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 p-2.5">
                  <div className="text-muted-foreground">Amount Repaid</div>
                  <div className="text-sm font-bold text-emerald-700 dark:text-emerald-400 mt-0.5">
                    {formatUGX(selectedPlan.amount_repaid)}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 p-2.5">
                  <div className="text-muted-foreground">Outstanding</div>
                  <div className="text-sm font-bold mt-0.5">
                    {formatUGX(selectedPlan.outstanding)}
                  </div>
                </div>
              </div>

              {selectedPlan.agent_name && (
                <div className="text-xs text-muted-foreground">
                  Assigned Agent: <strong className="text-foreground">{selectedPlan.agent_name}</strong>
                </div>
              )}

              <DialogFooter className="flex flex-col-reverse sm:flex-row gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-[44px] text-xs"
                  onClick={() => setSelectedPlan(null)}
                >
                  Close
                </Button>
                <Button
                  type="button"
                  className="min-h-[44px] text-xs gap-1.5"
                  onClick={() => {
                    const id = selectedPlan.rent_request_id;
                    setSelectedPlan(null);
                    navigate(`/landlord-ops/pipeline/rent-requests?request=${id}`);
                  }}
                >
                  Open in Rent Plans Pipeline
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Confirm Payout Number Dialog */}
      <Dialog open={payoutDialogOpen} onOpenChange={setPayoutDialogOpen}>
        <DialogContent className="w-[95vw] max-w-md p-4 sm:p-5">
          <DialogHeader className="text-left">
            <DialogTitle className="text-base font-bold">
              Confirm Landlord Payout Number
            </DialogTitle>
            <DialogDescription className="text-xs">
              Submits through the audited Landlord Payout Number Review workflow for{' '}
              <strong className="text-foreground">{displayName}</strong>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="hub-payout-number-input" className="text-xs font-semibold">
                Confirmed Mobile Money Number
              </Label>
              <Input
                id="hub-payout-number-input"
                value={proposedPayoutNumber}
                onChange={(e) => setProposedPayoutNumber(e.target.value)}
                placeholder="e.g. 0772123456"
                className="min-h-[44px] font-mono text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hub-payout-reason-input" className="text-xs font-semibold">
                Verification note
              </Label>
              <Textarea
                id="hub-payout-reason-input"
                rows={3}
                value={payoutReviewReason}
                onChange={(e) => setPayoutReviewReason(e.target.value)}
                placeholder="Record how the landlord confirmed this payout number during the call..."
                className="text-xs"
              />
            </div>
          </div>

          <DialogFooter className="flex flex-col-reverse sm:flex-row gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px] text-xs"
              onClick={() => setPayoutDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="min-h-[44px] text-xs"
              disabled={confirmPayoutMutation.isPending}
              onClick={handleConfirmPayoutNumber}
            >
              {confirmPayoutMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              )}
              Submit to Payout Review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 24-Hour Same-Caller Amendment Dialog */}
      <Dialog
        open={Boolean(amendingCall)}
        onOpenChange={(next) => !next && setAmendingCall(null)}
      >
        <DialogContent className="w-[95vw] max-w-md p-4 sm:p-5">
          {amendingCall && (
            <>
              <DialogHeader className="text-left">
                <DialogTitle className="text-base font-bold">
                  Amend Call Record (within 24 hours)
                </DialogTitle>
                <DialogDescription className="text-xs">
                  Saves an audited correction without overwriting the original call entry.
                </DialogDescription>
              </DialogHeader>

              {amendError && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                  {amendError}
                </div>
              )}

              <div className="space-y-3 py-1">
                {amendingCall.result === 'answered' && (
                  <>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold">Feedback type</Label>
                      <div className="grid grid-cols-1 gap-1.5">
                        {HUB_FEEDBACK_CATEGORIES.map((cat) => (
                          <button
                            key={cat.value}
                            type="button"
                            onClick={() => setAmendCategory(cat.value)}
                            className={cn(
                              'min-h-[44px] rounded-lg border px-3 py-1.5 text-xs text-left',
                              amendCategory === cat.value
                                ? 'border-primary bg-primary text-primary-foreground font-semibold'
                                : 'border-border bg-background',
                            )}
                          >
                            {cat.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold">Seriousness</Label>
                      <div className="grid grid-cols-3 gap-1.5">
                        {HUB_SEVERITY_OPTIONS.map((sev) => (
                          <button
                            key={sev.value}
                            type="button"
                            onClick={() => setAmendSeverity(sev.value)}
                            className={cn(
                              'min-h-[44px] rounded-lg border px-2 py-1.5 text-xs font-semibold',
                              amendSeverity === sev.value
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border bg-background',
                            )}
                          >
                            {sev.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="hub-amend-note" className="text-xs font-semibold">
                    Updated note
                    {amendingCall.result === 'answered'
                      ? ` (at least ${HUB_NOTE_MIN_LENGTH} characters)`
                      : ''}
                  </Label>
                  <Textarea
                    id="hub-amend-note"
                    rows={3}
                    value={amendNote}
                    onChange={(e) => setAmendNote(e.target.value)}
                    className="text-xs"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="hub-amend-reason" className="text-xs font-semibold">
                    Reason for correction (at least 5 characters)
                  </Label>
                  <Input
                    id="hub-amend-reason"
                    value={amendReason}
                    onChange={(e) => setAmendReason(e.target.value)}
                    placeholder="Why is this call record being amended?"
                    className="min-h-[44px] text-xs"
                  />
                </div>
              </div>

              <DialogFooter className="flex flex-col-reverse sm:flex-row gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-[44px] text-xs"
                  onClick={() => setAmendingCall(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  className="min-h-[44px] text-xs"
                  disabled={
                    amendMutation.isPending ||
                    amendReason.trim().length < 5 ||
                    (amendingCall.result === 'answered' &&
                      amendNote.trim().length < HUB_NOTE_MIN_LENGTH)
                  }
                  onClick={handleSaveAmendment}
                >
                  {amendMutation.isPending && (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  )}
                  Save correction
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
