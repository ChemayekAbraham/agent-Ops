import { useEffect, useMemo, useState } from 'react';
import { addDays, addHours, format, setHours, setMinutes, setSeconds } from 'date-fns';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Loader2,
  PhoneCall,
  PhoneMissed,
  PhoneOff,
  UserX,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import {
  AWARENESS_OPTIONS,
  CONSENT_OPTIONS,
  EXPLAINED_OPTIONS,
  LANDLORD_READ_ALOUD,
  QUESTION_30M_ACCESS,
  QUESTION_EXPLAINED,
  QUESTION_LANDLORD_CONSENT,
  QUESTION_PAYOUT_OTP,
  type AwarenessChoice,
  type ExplainedChoice,
  type LandlordConsent,
} from '@/lib/awarenessCallLabels';
import {
  HUB_FEEDBACK_CATEGORIES,
  HUB_NOTE_MIN_LENGTH,
  HUB_RESULT_OPTIONS,
  HUB_SEVERITY_OPTIONS,
  formatHubError,
  useLandlordHubRecordCall,
  type AwarenessAnswer,
  type ExplainedAnswer,
  type LandlordHubFeedbackCategory,
  type LandlordHubResult,
  type LandlordHubSeverity,
  type LandlordHubTenantPlan,
} from '@/hooks/useLandlordCallingHub';

export interface LandlordCallingHubRecordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  landlordKey: string;
  landlordId?: string | null;
  landlordName: string;
  phone: string;
  dialId?: string | null;
  dialStartedAt?: string | null;
  manualMode?: boolean;
  tenantPlans?: LandlordHubTenantPlan[];
  initialResult?: LandlordHubResult | null;
  onSuccess?: () => void;
}

function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function LandlordCallingHubRecordDialog({
  open,
  onOpenChange,
  landlordKey,
  landlordId,
  landlordName,
  phone,
  dialId,
  dialStartedAt,
  manualMode = false,
  tenantPlans = [],
  initialResult = null,
  onSuccess,
}: LandlordCallingHubRecordDialogProps) {
  const recordMutation = useLandlordHubRecordCall();

  const [result, setResult] = useState<LandlordHubResult | null>(initialResult);
  const [phoneInput, setPhoneInput] = useState(phone || '');
  const [aware30m, setAware30m] = useState<AwarenessAnswer | null>(null);
  const [landlordConsent, setLandlordConsent] = useState<LandlordConsent | null>(null);
  const [awarePayoutOtp, setAwarePayoutOtp] = useState<AwarenessAnswer | null>(null);
  const [explained, setExplained] = useState<ExplainedAnswer | null>(null);
  const [feedbackCategory, setFeedbackCategory] = useState<LandlordHubFeedbackCategory | null>(null);
  const [severity, setSeverity] = useState<LandlordHubSeverity>('normal');
  const [note, setNote] = useState('');
  const [tenantsDiscussed, setTenantsDiscussed] = useState<string[]>([]);
  const [callBackLocal, setCallBackLocal] = useState<string>('');
  const [serverError, setServerError] = useState<string | null>(null);
  const [effectiveDialStart, setEffectiveDialStart] = useState<string>(
    () => dialStartedAt || new Date().toISOString(),
  );

  // Reset form when dialog opens for a new landlord/dial
  useEffect(() => {
    if (open) {
      setResult(initialResult ?? null);
      setPhoneInput(phone && phone !== '—' ? phone : '');
      setAware30m(null);
      setLandlordConsent(null);
      setAwarePayoutOtp(null);
      setExplained(null);
      setFeedbackCategory(null);
      setSeverity('normal');
      setNote('');
      setTenantsDiscussed([]);
      setCallBackLocal(toDatetimeLocalValue(addHours(new Date(), 1)));
      setServerError(null);
      setEffectiveDialStart(dialStartedAt || new Date().toISOString());
    }
  }, [open, landlordKey, dialId, dialStartedAt, phone, initialResult]);

  const trimmedNote = note.trim();
  const noteCharsRemaining = Math.max(0, HUB_NOTE_MIN_LENGTH - trimmedNote.length);

  const callBackIso = useMemo(() => {
    if (!callBackLocal) return null;
    const parsed = new Date(callBackLocal);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  }, [callBackLocal]);

  const isCallBackFuture = useMemo(() => {
    if (!callBackIso) return false;
    return new Date(callBackIso).getTime() > Date.now();
  }, [callBackIso]);

  const hasValidPhone = useMemo(() => {
    const digits = (phoneInput || '').replace(/\D/g, '');
    return digits.length >= 7 || (phone && phone !== '—' && phone.length >= 7);
  }, [phoneInput, phone]);

  const isValid = useMemo(() => {
    if (!result || !hasValidPhone) return false;
    if (result === 'answered') {
      return Boolean(
        aware30m &&
          landlordConsent &&
          awarePayoutOtp &&
          explained &&
          feedbackCategory &&
          severity &&
          trimmedNote.length >= HUB_NOTE_MIN_LENGTH,
      );
    }
    if (result === 'call_back') {
      return isCallBackFuture;
    }
    return true;
  }, [
    result,
    hasValidPhone,
    aware30m,
    landlordConsent,
    awarePayoutOtp,
    explained,
    feedbackCategory,
    severity,
    trimmedNote.length,
    isCallBackFuture,
  ]);

  const applyQuickCallBack = (preset: '1h' | 'tomorrow_9' | '3d') => {
    const now = new Date();
    let target: Date;
    if (preset === '1h') {
      target = addHours(now, 1);
    } else if (preset === 'tomorrow_9') {
      target = setSeconds(setMinutes(setHours(addDays(now, 1), 9), 0), 0);
    } else {
      target = setSeconds(setMinutes(setHours(addDays(now, 3), 9), 0), 0);
    }
    setCallBackLocal(toDatetimeLocalValue(target));
  };

  const toggleTenantPlan = (rentRequestId: string) => {
    setTenantsDiscussed((prev) =>
      prev.includes(rentRequestId)
        ? prev.filter((id) => id !== rentRequestId)
        : [...prev, rentRequestId],
    );
  };

  const handleSave = async () => {
    if (!isValid || !result || recordMutation.isPending) return;
    setServerError(null);
    const dialPhone = (phoneInput || phone || '').trim();

    try {
      await recordMutation.mutateAsync({
        landlordKey,
        landlordId: landlordId ?? null,
        landlordName,
        phoneDialed: dialPhone,
        dialStartedAt: effectiveDialStart,
        dialId: dialId ?? null,
        result,
        callBackAt: result === 'call_back' ? callBackIso : null,
        aware30m: result === 'answered' ? aware30m : null,
        landlordConsent: result === 'answered' ? landlordConsent : null,
        awarePayoutOtp: result === 'answered' ? awarePayoutOtp : null,
        explained: result === 'answered' ? explained : null,
        feedbackCategory: result === 'answered' ? feedbackCategory : null,
        severity: result === 'answered' ? severity : null,
        note: trimmedNote || null,
        tenantsDiscussed: tenantsDiscussed.length > 0 ? tenantsDiscussed : null,
      });
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      setServerError(formatHubError(err));
    }
  };

  const resultIcon = (val: LandlordHubResult) => {
    switch (val) {
      case 'answered':
        return CheckCircle2;
      case 'no_answer':
        return PhoneMissed;
      case 'phone_off':
        return PhoneOff;
      case 'wrong_number':
        return UserX;
      case 'call_back':
        return CalendarClock;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="hub-record-dialog"
        className="w-[96vw] max-w-xl max-h-[92vh] overflow-y-auto p-4 sm:p-6 gap-4"
      >
        <DialogHeader className="text-left space-y-1">
          <DialogTitle className="flex items-center gap-2 text-base font-bold text-foreground">
            <PhoneCall className="h-4 w-4 text-primary shrink-0" />
            <span className="truncate">Record call · {landlordName}</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {manualMode
              ? 'Record a call made outside the one-tap dialer. Every answer is saved permanently.'
              : `Dialled ${phone || 'landlord'} · Select how the call went to save your report.`}
          </DialogDescription>
        </DialogHeader>

        {serverError && (
          <div
            role="alert"
            data-testid="hub-record-error"
            className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{serverError}</span>
          </div>
        )}

        {/* Phone field when recording a manual call or when phone was blank */}
        {(manualMode || !phone || phone === '—') && (
          <div className="space-y-1.5">
            <Label htmlFor="hub-record-phone" className="text-xs font-semibold">
              Phone number dialled
            </Label>
            <Input
              id="hub-record-phone"
              data-testid="hub-record-phone-input"
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              placeholder="e.g. 0772123456"
              className="min-h-[44px] font-mono text-sm"
            />
          </div>
        )}

        {/* Step 1: How did it go? */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Step 1 · How did it go?
            </Label>
            {result && (
              <Badge variant="outline" className="text-xs">
                {HUB_RESULT_OPTIONS.find((o) => o.value === result)?.label}
              </Badge>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {HUB_RESULT_OPTIONS.map((opt) => {
              const Icon = resultIcon(opt.value);
              const selected = result === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`hub-result-${opt.value}`}
                  onClick={() => setResult(opt.value)}
                  className={cn(
                    'flex items-start gap-2.5 rounded-xl border p-3 text-left transition-colors min-h-[48px]',
                    selected
                      ? 'border-primary bg-primary/10 text-foreground ring-1 ring-primary'
                      : 'border-border bg-card hover:bg-muted/50 text-foreground',
                  )}
                >
                  <Icon
                    className={cn(
                      'h-4 w-4 shrink-0 mt-0.5',
                      selected ? 'text-primary' : 'text-muted-foreground',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold">{opt.label}</div>
                    <div className="text-xs text-muted-foreground leading-snug">
                      {opt.description}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Step 2 (if Answered): 4 Awareness Questions + Feedback + Note */}
        {result === 'answered' && (
          <div className="space-y-4 rounded-xl border border-border bg-muted/15 p-3.5">
            <div className="space-y-1.5">
              <div className="text-xs font-bold uppercase tracking-wider text-primary">
                Step 2 · Landlord Awareness & Feedback
              </div>
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-2.5 text-xs text-foreground leading-relaxed">
                <span className="font-semibold">Read aloud: </span>
                {LANDLORD_READ_ALOUD}
              </div>
            </div>

            {/* Question 1: 30M Access */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-foreground leading-snug block">
                1. {QUESTION_30M_ACCESS}
              </Label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                {AWARENESS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    data-testid={`hub-q-aware30m-${opt.value}`}
                    onClick={() => setAware30m(opt.value)}
                    className={cn(
                      'min-h-[44px] rounded-lg border px-2.5 py-2 text-xs font-medium text-left transition-colors',
                      aware30m === opt.value
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background hover:bg-muted text-foreground',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Question 2: Landlord Consent */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-foreground leading-snug block">
                2. {QUESTION_LANDLORD_CONSENT}
              </Label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                {CONSENT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    data-testid={`hub-q-consent-${opt.value}`}
                    onClick={() => setLandlordConsent(opt.value)}
                    className={cn(
                      'min-h-[44px] rounded-lg border px-2.5 py-2 text-xs font-medium text-left transition-colors',
                      landlordConsent === opt.value
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background hover:bg-muted text-foreground',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Question 3: Payout OTP */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-foreground leading-snug block">
                3. {QUESTION_PAYOUT_OTP}
              </Label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                {AWARENESS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    data-testid={`hub-q-otp-${opt.value}`}
                    onClick={() => setAwarePayoutOtp(opt.value)}
                    className={cn(
                      'min-h-[44px] rounded-lg border px-2.5 py-2 text-xs font-medium text-left transition-colors',
                      awarePayoutOtp === opt.value
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background hover:bg-muted text-foreground',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Question 4: Explained */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-foreground leading-snug block">
                4. {QUESTION_EXPLAINED}
              </Label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                {EXPLAINED_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    data-testid={`hub-q-explained-${opt.value}`}
                    onClick={() => setExplained(opt.value)}
                    className={cn(
                      'min-h-[44px] rounded-lg border px-2.5 py-2 text-xs font-medium text-left transition-colors',
                      explained === opt.value
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background hover:bg-muted text-foreground',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Feedback Category */}
            <div className="space-y-1.5 pt-2 border-t border-border/60">
              <Label className="text-xs font-semibold text-foreground block">
                Feedback type
              </Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {HUB_FEEDBACK_CATEGORIES.map((cat) => (
                  <button
                    key={cat.value}
                    type="button"
                    data-testid={`hub-category-${cat.value}`}
                    onClick={() => setFeedbackCategory(cat.value)}
                    className={cn(
                      'min-h-[44px] rounded-lg border px-3 py-2 text-xs font-medium text-left transition-colors',
                      feedbackCategory === cat.value
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background hover:bg-muted text-foreground',
                    )}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Seriousness / Severity */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-foreground block">
                Seriousness
              </Label>
              <div className="grid grid-cols-3 gap-1.5">
                {HUB_SEVERITY_OPTIONS.map((sev) => (
                  <button
                    key={sev.value}
                    type="button"
                    data-testid={`hub-severity-${sev.value}`}
                    onClick={() => setSeverity(sev.value)}
                    className={cn(
                      'min-h-[44px] rounded-lg border px-2.5 py-2 text-xs font-semibold text-center transition-colors',
                      severity === sev.value
                        ? sev.value === 'critical'
                          ? 'border-destructive bg-destructive text-destructive-foreground'
                          : 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background hover:bg-muted text-foreground',
                    )}
                  >
                    {sev.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Written Note (minimum 20 characters with live counter) */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="hub-call-note" className="text-xs font-semibold text-foreground">
                  Call note (required, at least {HUB_NOTE_MIN_LENGTH} characters)
                </Label>
                <span
                  data-testid="hub-note-counter"
                  className={cn(
                    'text-xs font-mono',
                    trimmedNote.length >= HUB_NOTE_MIN_LENGTH
                      ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                      : 'text-muted-foreground',
                  )}
                >
                  {trimmedNote.length} / {HUB_NOTE_MIN_LENGTH} min
                  {noteCharsRemaining > 0 ? ` (${noteCharsRemaining} more needed)` : ''}
                </span>
              </div>
              <Textarea
                id="hub-call-note"
                data-testid="hub-note-input"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Write what the landlord confirmed, any payout or tenant discussion, and next steps..."
                className="text-xs leading-relaxed"
              />
            </div>

            {/* Optional Tenants Discussed */}
            {tenantPlans.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-foreground block">
                  Tenants discussed (optional)
                </Label>
                <div className="grid grid-cols-1 gap-1.5 max-h-40 overflow-y-auto pr-1">
                  {tenantPlans.map((tp) => {
                    const checked = tenantsDiscussed.includes(tp.rent_request_id);
                    return (
                      <button
                        key={tp.rent_request_id}
                        type="button"
                        data-testid={`hub-tenant-check-${tp.rent_request_id}`}
                        onClick={() => toggleTenantPlan(tp.rent_request_id)}
                        className={cn(
                          'min-h-[44px] flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs text-left transition-colors',
                          checked
                            ? 'border-primary bg-primary/10 text-foreground font-semibold'
                            : 'border-border bg-background hover:bg-muted text-foreground',
                        )}
                      >
                        <span className="truncate">
                          {tp.tenant_name} · {formatUGX(tp.rent_amount)}
                        </span>
                        <Badge variant={checked ? 'default' : 'outline'} className="text-xs shrink-0">
                          {checked ? 'Selected' : tp.status}
                        </Badge>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 3 (if Call back): Future date & time + Quick choices */}
        {result === 'call_back' && (
          <div className="space-y-3 rounded-xl border border-border bg-muted/15 p-3.5">
            <div className="text-xs font-bold uppercase tracking-wider text-primary">
              Step 2 · When should we call back?
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="hub-callback-preset-1h"
                className="min-h-[44px] text-xs"
                onClick={() => applyQuickCallBack('1h')}
              >
                In 1 hour
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="hub-callback-preset-tomorrow"
                className="min-h-[44px] text-xs"
                onClick={() => applyQuickCallBack('tomorrow_9')}
              >
                Tomorrow 9:00
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="hub-callback-preset-3d"
                className="min-h-[44px] text-xs"
                onClick={() => applyQuickCallBack('3d')}
              >
                In 3 days
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hub-callback-datetime" className="text-xs font-semibold">
                Call-back date and time (must be in the future)
              </Label>
              <Input
                id="hub-callback-datetime"
                data-testid="hub-callback-input"
                type="datetime-local"
                value={callBackLocal}
                onChange={(e) => setCallBackLocal(e.target.value)}
                className="min-h-[44px] text-xs font-mono"
              />
              {callBackIso && !isCallBackFuture && (
                <p
                  data-testid="hub-callback-future-warning"
                  className="text-xs text-destructive font-medium"
                >
                  Choose a future date and time for the call back.
                </p>
              )}
              {callBackIso && isCallBackFuture && (
                <p className="text-xs text-muted-foreground">
                  Scheduled for {format(new Date(callBackIso), 'EEE dd MMM yyyy · HH:mm')}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hub-callback-note" className="text-xs font-semibold">
                Optional note for the call back
              </Label>
              <Textarea
                id="hub-callback-note"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Reason or preferred time details..."
                className="text-xs"
              />
            </div>
          </div>
        )}

        {/* Optional short note for unanswered results */}
        {result && result !== 'answered' && result !== 'call_back' && (
          <div className="space-y-1.5">
            <Label htmlFor="hub-unanswered-note" className="text-xs font-semibold">
              Optional note
            </Label>
            <Textarea
              id="hub-unanswered-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note about this attempt..."
              className="text-xs"
            />
          </div>
        )}

        <DialogFooter className="flex flex-col-reverse sm:flex-row gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-[44px] text-xs"
            disabled={recordMutation.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="hub-record-save"
            className="min-h-[44px] text-xs font-semibold"
            disabled={!isValid || recordMutation.isPending}
            onClick={handleSave}
          >
            {recordMutation.isPending && (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            )}
            Save call record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
