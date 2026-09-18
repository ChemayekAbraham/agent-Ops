import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  FileText,
  Check,
  Share2,
  Loader2,
  BookUser,
  ChevronLeft,
  User,
  Phone,
  Banknote,
  ListChecks,
  CircleCheck,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { PromissoryPlanMatcher } from '@/components/agent/PromissoryPlanMatcher';
import { normalizeWa } from '@/lib/whatsapp';
import { useQueryClient } from '@tanstack/react-query';
import { reconcilePromissoryPendingCount } from '@/components/executive/partner-ops/promissoryPendingCount';
import type { HouseOpportunity } from '@/components/agent/EmptyHouseDetailSheet';


interface PromissoryNoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 'self' = agent hand-picks tenants for the partner; 'auto' = the desk places them. */
  supportMode?: 'self' | 'auto';
  /** Optional starting promised amount (e.g. the house rent the agent tapped from). */
  initialAmount?: number;
  /** A house the agent came from (Create & Share) — pre-selected in the matcher. */
  initialHouse?: HouseOpportunity | null;
}

const phoneDigits = (v: string) => v.replace(/\D/g, '');
/** Keep what the person typed/pasted, just drop junk characters. */
const cleanPhoneInput = (v: string) => v.replace(/[^\d+\s()\-.]/g, '').slice(0, 24);
/** Accepts any international number: 7–15 digits (E.164 range). */
const isValidPhone = (v: string) => {
  const d = phoneDigits(v);
  return d.length >= 7 && d.length <= 15;
};
const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());


type StepKey = 'who' | 'contact' | 'promise' | 'tenants' | 'review';

export function PromissoryNoteDialog({ open, onOpenChange, supportMode = 'self', initialAmount, initialHouse }: PromissoryNoteDialogProps) {
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [createdNote, setCreatedNote] = useState<Record<string, unknown> | null>(null);

  // Flat validation fee for a promissory note, read from the database.
  // null = unavailable (never fall back to a hardcoded figure).
  const [noteRate, setNoteRate] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('partner_note_rate', {
          p_role: 'agent',
          p_at: new Date().toISOString(),
        });
        if (cancelled) return;
        const value = typeof data === 'number' ? data : Number(data);
        setNoteRate(!error && Number.isFinite(value) ? value : null);
      } catch {
        if (!cancelled) setNoteRate(null);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const earningsLine =
    noteRate === null ? 'Rate unavailable' : `You earn ${formatUGX(noteRate)} when this note is validated`;

  // Captured in parts; `partner_name` stays one concatenated string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const partnerName = joinPersonName(nameParts);
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [email, setEmail] = useState('');
  const [amount, setAmount] = useState('');
  // Prefill the promised amount when the dialog is opened from a context that
  // already knows a figure (e.g. a house card's monthly rent).
  useEffect(() => {
    if (open && initialAmount && initialAmount > 0) {
      setAmount(String(Math.round(initialAmount)));
      setAmountTouched(false);
    }
  }, [open, initialAmount]);
  const todayIso = new Date().toISOString().split('T')[0];
  // When the note was written down, and when the partner promises to fulfil it.
  const [recordedOn, setRecordedOn] = useState(todayIso);
  const [fulfilmentDueOn, setFulfilmentDueOn] = useState('');
  // True once the agent edits the amount by hand — after that, plan selections
  // never overwrite what they typed.
  const [amountTouched, setAmountTouched] = useState(false);
  const [contributionType, setContributionType] = useState<'monthly' | 'compounding'>('compounding');
  const [deductionDay, setDeductionDay] = useState('1');
  // Optional earmarking: either ready-to-fund rent plans OR verified empty
  // houses (the server keeps the two kinds separate, one kind per note).
  const [selectedPlanIds, setSelectedPlanIds] = useState<string[]>([]);
  const [selectedHouseIds, setSelectedHouseIds] = useState<string[]>([]);
  const [attached, setAttached] = useState<{ count: number; amount: number; kind: 'plans' | 'houses' }>({ count: 0, amount: 0, kind: 'plans' });

  // Opened from a house's "Create & Share": pre-select that house so the agent
  // does not have to search for it again.
  useEffect(() => {
    if (open && initialHouse?.house_id) {
      setSelectedHouseIds((prev) =>
        prev.includes(initialHouse.house_id) ? prev : [...prev, initialHouse.house_id],
      );
      setSelectedPlanIds([]);
    }
  }, [open, initialHouse]);

  // Stepper state
  const steps: { key: StepKey; label: string }[] = useMemo(
    () =>
      supportMode === 'self'
        ? [
            { key: 'who', label: 'Who' },
            { key: 'contact', label: 'Contact' },
            { key: 'promise', label: 'Promise' },
            { key: 'tenants', label: 'Tenants' },
            { key: 'review', label: 'Review' },
          ]
        : [
            { key: 'who', label: 'Who' },
            { key: 'contact', label: 'Contact' },
            { key: 'promise', label: 'Promise' },
            { key: 'review', label: 'Review' },
          ],
    [supportMode],
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [attemptedStep, setAttemptedStep] = useState<number | null>(null);

  const currentStep = steps[stepIndex];
  const isLastStep = stepIndex === steps.length - 1;



  const nameValidation = validatePersonNameParts(nameParts);

  const stepErrors = useMemo(() => {
    const errs: Record<StepKey, string[]> = {
      who: [],
      contact: [],
      promise: [],
      tenants: [],
      review: [],
    };

    if (!nameValidation.valid) errs.who.push(nameValidation.error || 'Partner name');

    if (!isValidPhone(whatsappNumber)) errs.contact.push('WhatsApp number');
    if (phoneNumber.trim() && !isValidPhone(phoneNumber)) errs.contact.push('Phone number');
    if (email.trim() && !isValidEmail(email)) errs.contact.push('Email');

    if (!(Number(amount) > 0)) errs.promise.push('Promised amount');
    if (!recordedOn) errs.promise.push('Date recorded');
    if (fulfilmentDueOn && recordedOn && fulfilmentDueOn < recordedOn) {
      errs.promise.push('Fulfilment date must be on or after the recording date');
    }

    if (supportMode === 'self' && selectedPlanIds.length === 0 && selectedHouseIds.length === 0) errs.tenants.push('At least one house or tenant rent plan');

    return errs;
  }, [nameValidation, whatsappNumber, phoneNumber, email, amount, recordedOn, fulfilmentDueOn, supportMode, selectedPlanIds, selectedHouseIds]);

  const currentStepHasErrors = stepErrors[currentStep.key].length > 0;
  const showStepErrors = attemptedStep === stepIndex && currentStepHasErrors;

  /** Pull a name / phone / email straight from the phone's contact book. */
  const handlePickContact = async () => {
    try {
      const { pickContact } = await import('@/lib/contactPicker');
      const picked = await pickContact();
      if (!picked) return;
      if (picked.phone) {
        const num = cleanPhoneInput(picked.phone);
        if (!whatsappNumber) setWhatsappNumber(num);
        else if (!phoneNumber) setPhoneNumber(num);
      }
      if (picked.email && !email.trim()) setEmail(picked.email);
      if (picked.name) {
        setNameParts((prev) => {
          if (prev.firstName.trim() || prev.lastName.trim()) return prev;
          const parts = picked.name.split(/\s+/).filter(Boolean);
          return {
            firstName: parts[0] || '',
            otherNames: parts.slice(1, -1).join(' '),
            lastName: parts.length > 1 ? parts[parts.length - 1] : '',
          };
        });
      }
      toast.success('Contact details filled in');
    } catch (err) {
      toast.error(String((err as { message?: string }).message || 'Contact book is not available on this device'));
    }
  };

  const resetForm = () => {
    setNameParts({ firstName: '', otherNames: '', lastName: '' });
    setWhatsappNumber('');
    setPhoneNumber('');
    setEmail('');
    setAmount('');
    setRecordedOn(todayIso);
    setFulfilmentDueOn('');
    setAmountTouched(false);
    setContributionType('compounding');
    setDeductionDay('1');

    setCreatedNote(null);
    setErrorMsg(null);

    setSelectedPlanIds([]);
    setSelectedHouseIds([]);
    setAttached({ count: 0, amount: 0, kind: 'plans' });
    setStepIndex(0);
    setAttemptedStep(null);
  };

  const handleClose = (v: boolean) => {
    if (!v) resetForm();
    onOpenChange(v);
  };

  const goNext = () => {
    setAttemptedStep(stepIndex);
    if (currentStepHasErrors) {
      const msg = `Please complete: ${stepErrors[currentStep.key].join(', ')}`;
      toast.error(msg);
      return;
    }
    if (!isLastStep) {
      setStepIndex((i) => i + 1);
      setAttemptedStep(null);
    }
  };

  const goBack = () => {
    if (stepIndex > 0) {
      setStepIndex((i) => i - 1);
      setAttemptedStep(null);
    }
  };

  const handleSubmit = async () => {
    if (submitting) return;
    setErrorMsg(null);
    setAttemptedStep(stepIndex);
    if (currentStepHasErrors) {
      const msg = `Please complete: ${stepErrors[currentStep.key].join(', ')}`;
      setErrorMsg(msg);
      toast.error(msg);
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, string | number | null> = {
        partner_name: partnerName.trim(),
        whatsapp_number: normalizeWa(whatsappNumber),
        phone_number: phoneNumber.trim() ? normalizeWa(phoneNumber) : null,
        email: email.trim() || null,
        amount: Number(amount),
        recorded_on: recordedOn || todayIso,
        fulfilment_due_on: fulfilmentDueOn || null,

        // DB validation trigger only accepts 'monthly' | 'once_off'.
        // "Compounding" is the UI label for the once-off (lump-sum) note.
        contribution_type: contributionType === 'monthly' ? 'monthly' : 'once_off',
        support_mode: supportMode === 'self' ? 'self_support' : 'existing_support',
      };

      if (contributionType === 'monthly') {
        payload.deduction_day = String(Number(deductionDay));
        const now = new Date();
        const nextDate = new Date(now.getFullYear(), now.getMonth(), Number(deductionDay));
        if (nextDate <= now) nextDate.setMonth(nextDate.getMonth() + 1);
        payload.next_deduction_date = nextDate.toISOString().split('T')[0];
      }

      // One atomic server call: note + optional earmarks, validated server-side.
      // Houses and rent plans live in different earmark tables — a note carries
      // one kind, chosen by what the agent selected.
      const useHouses = selectedHouseIds.length > 0;
      const { data, error } = useHouses
        ? await supabase.rpc('agent_create_promissory_note_for_houses', {
            p_payload: { ...payload, promised_funding_date: fulfilmentDueOn || null },
            p_house_ids: selectedHouseIds,
          })
        : await supabase.rpc('agent_create_promissory_note', {
            p_payload: payload,
            p_rent_request_ids: selectedPlanIds,
          });
      if (error) throw error;

      const result = (data ?? {}) as {
        note?: Record<string, unknown>;
        attached_count?: number;
        attached_amount?: number;
        house_count?: number;
        houses_monthly_rent?: number;
      };
      if (!result.note) throw new Error('Note was not created');
      setCreatedNote(result.note);
      // Refresh the Partner Ops pending badge right away (realtime also covers it).
      reconcilePromissoryPendingCount(queryClient);
      // Fire-and-forget: partner gets the pledge SMS + email (tenants + 12-month
      // earnings). A 10-minute cron sweep retries anything that fails here.
      const noteId = (result.note as { id?: string }).id;
      void supabase.functions
        .invoke('notify-promissory-note-pledge', { body: { note_id: noteId } })
        .catch(() => {});
      const attachedCount = useHouses ? Number(result.house_count || 0) : Number(result.attached_count || 0);
      const attachedAmount = useHouses ? Number(result.houses_monthly_rent || 0) : Number(result.attached_amount || 0);
      setAttached({ count: attachedCount, amount: attachedAmount, kind: useHouses ? 'houses' : 'plans' });
      toast.success(
        attachedCount > 0
          ? useHouses
            ? `Note created with ${attachedCount} house${attachedCount === 1 ? '' : 's'} booked for 7 days`
            : `Note created with ${attachedCount} tenant plan${attachedCount === 1 ? '' : 's'} attached`
          : 'Promissory note created',
      );
    } catch (err) {
      const raw = String(
        (err as { message?: string; error_description?: string; details?: string }).message ||
        (err as { error_description?: string }).error_description ||
        (err as { details?: string }).details ||
        'Failed to create note',
      );
      console.error('[PromissoryNoteDialog] create failed:', err);
      if (raw.includes('PLANS_UNAVAILABLE')) {
        setSelectedPlanIds([]);
        const msg = 'Some selected plans are no longer available. Selection cleared — try again or create the note without plans.';
        setErrorMsg(msg);
        toast.error(msg);
      } else if (raw.includes('PLANS_EXCEED_AMOUNT')) {
        const msg = 'Attached plans total more than the promised amount.';
        setErrorMsg(msg);
        toast.error(msg);
      } else if (raw.includes('SELF_SUPPORT_PLANS_REQUIRED')) {
        const msg = 'Select at least one house or tenant rent plan for self support.';
        setErrorMsg(msg);
        toast.error(msg);
      } else if (raw.includes('HOUSES_UNAVAILABLE')) {
        setSelectedHouseIds([]);
        const msg = 'Some selected houses are no longer empty. Selection cleared — refresh and try again.';
        setErrorMsg(msg);
        toast.error(msg);
      } else if (raw.includes('HOUSES_REQUIRED')) {
        const msg = 'Select at least one empty house for this partner.';
        setErrorMsg(msg);
        toast.error(msg);
      } else if (/failed to fetch|network|timeout/i.test(raw)) {
        const msg = 'Network problem — the note was not created. Check your connection and press Create again.';
        setErrorMsg(msg);
        toast.error(msg);
      } else {
        setErrorMsg(raw);
        toast.error(raw);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleShareLink = async () => {
    if (!createdNote) return;
    const token = (createdNote as { activation_token?: string }).activation_token;
    let activationLink = `${getPublicOrigin()}/activate?token=${token}`;
    try {
      const { createShortLink } = await import('@/lib/createShortLink');
      const { data: { user: u } } = await (await import('@/integrations/supabase/client')).supabase.auth.getUser();
      if (u && token) {
        activationLink = await createShortLink(u.id, '/activate', { token });
      }
    } catch {
      void 0;
    }
    const shareText = `Hi ${partnerName}, activate your Welile funding account and start earning 15% Returns! ${activationLink}`;
    if (navigator.share) {
      navigator.share({ title: 'Welile Funding', text: shareText, url: activationLink }).catch(() => {});
    } else {
      await navigator.clipboard.writeText(activationLink);
      toast.success('Activation link copied');
    }
  };

  const parsedAmount = Number(amount) || 0;

  const renderStepIndicator = () => (
    <div className="flex items-center justify-center gap-1.5 py-1">
      {steps.map((s, idx) => (
        <button
          key={s.key}
          type="button"
          onClick={() => {
            // Allow jumping back, but only forward if previous steps are valid.
            if (idx <= stepIndex) {
              setStepIndex(idx);
              setAttemptedStep(null);
            }
          }}
          className={cn(
            'flex h-7 min-w-[3.25rem] items-center justify-center rounded-full text-[10px] font-semibold transition-colors',
            idx === stepIndex
              ? 'bg-primary text-primary-foreground'
              : idx < stepIndex
                ? 'bg-primary/15 text-primary'
                : 'bg-muted text-muted-foreground',
          )}
          aria-current={idx === stepIndex ? 'step' : undefined}
        >
          {idx < stepIndex ? <Check className="h-3 w-3" /> : s.label}
        </button>
      ))}
    </div>
  );

  const sectionTitle = (icon: React.ReactNode, title: string, subtitle?: string) => (
    <div className="flex items-start gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-base font-semibold leading-tight text-foreground">{title}</h3>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{subtitle}</p>}
      </div>
    </div>
  );

  const renderWhoStep = () => (
    <Card className="border-border/60">
      <CardContent className="space-y-4 pt-4">
        {sectionTitle(<User className="h-5 w-5" />, 'Who is the partner?', 'First name and last name are required.')}
        <PersonNameFields
          idPrefix="promissory-partner"
          value={nameParts}
          onChange={setNameParts}
          errors={
            showStepErrors
              ? {
                  firstName: nameValidation.error,
                  otherNames: null,
                  lastName: nameValidation.error,
                }
              : undefined
          }
        />
      </CardContent>
    </Card>
  );

  const renderContactStep = () => (
    <Card className="border-border/60">
      <CardContent className="space-y-4 pt-4">
        {sectionTitle(<Phone className="h-5 w-5" />, 'How do we reach them?', 'WhatsApp is required. Phone and email are optional.')}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handlePickContact}
          className="w-full gap-2 text-xs"
        >
          <BookUser className="h-4 w-4" />
          Fill from phone book
        </Button>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="promissory-whatsapp" className="text-xs">
              WhatsApp number <span className="text-muted-foreground">(any country)</span>
            </Label>
            <Input
              id="promissory-whatsapp"
              value={whatsappNumber}
              onChange={(e) => setWhatsappNumber(cleanPhoneInput(e.target.value))}
              onPaste={(e) => {
                e.preventDefault();
                setWhatsappNumber(cleanPhoneInput(e.clipboardData.getData('text')));
              }}
              placeholder="0780000000 or +44 7700 900123"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              autoCorrect="off"
              spellCheck={false}
              className="h-11"
              maxLength={24}
            />
            {showStepErrors && !isValidPhone(whatsappNumber) && (
              <p className="text-[11px] text-destructive">Enter a valid phone number (with country code if outside Uganda)</p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="promissory-phone" className="text-xs">
              Phone number <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="promissory-phone"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(cleanPhoneInput(e.target.value))}
              onPaste={(e) => {
                e.preventDefault();
                setPhoneNumber(cleanPhoneInput(e.clipboardData.getData('text')));
              }}
              placeholder="0780000000 or +254 712 345678"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              autoCorrect="off"
              spellCheck={false}
              className="h-11"
              maxLength={24}
            />
            {showStepErrors && phoneNumber.trim() && !isValidPhone(phoneNumber) && (
              <p className="text-[11px] text-destructive">Enter a valid phone number (with country code if outside Uganda)</p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="promissory-email" className="text-xs">
              Email <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="promissory-email"
              value={email}
              onChange={(e) => setEmail(e.target.value.trim())}
              onPaste={(e) => {
                e.preventDefault();
                setEmail(e.clipboardData.getData('text').trim());
              }}
              placeholder="email@example.com"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="h-11"
              maxLength={255}
            />
            {showStepErrors && email.trim() && !isValidEmail(email) && (
              <p className="text-[11px] text-destructive">Enter a valid email</p>
            )}
          </div>

        </div>
      </CardContent>
    </Card>
  );

  const renderPromiseStep = () => (
    <Card className="border-border/60">
      <CardContent className="space-y-4 pt-4">
        {sectionTitle(<Banknote className="h-5 w-5" />, 'What are they promising?', 'Amount and dates.')}

        <div className="space-y-1">
          <Label htmlFor="promissory-amount" className="text-xs">
            Promised amount (UGX)
          </Label>
          <Input
            id="promissory-amount"
            value={amount}
            onChange={(e) => {
              setAmountTouched(true);
              setAmount(e.target.value.replace(/[^0-9]/g, ''));
            }}
            placeholder="e.g. 500000"
            inputMode="numeric"
            className="h-12 text-base font-semibold tracking-tight"
          />
          {parsedAmount > 0 && (
            <p className="text-sm font-semibold text-primary">{formatUGX(parsedAmount)}</p>
          )}
          {showStepErrors && !(parsedAmount > 0) && (
            <p className="text-[11px] text-destructive">Enter an amount</p>
          )}
        </div>

        <div className="space-y-2">
          <Label className="text-xs">Payment type</Label>
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-border p-1 bg-muted/40">
            {[
              { key: 'compounding', label: 'compounding' },
              { key: 'monthly', label: 'Monthly' },
            ].map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setContributionType(opt.key as 'monthly' | 'compounding')}
                className={cn(
                  'rounded-lg py-2 text-xs font-semibold transition-colors',
                  contributionType === opt.key
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {contributionType === 'monthly' && (
          <div className="space-y-1">
            <Label htmlFor="promissory-day" className="text-xs">
              Day of month
            </Label>
            <Select value={deductionDay} onValueChange={setDeductionDay}>
              <SelectTrigger id="promissory-day" className="h-11 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 28 }, (_, i) => (
                  <SelectItem key={i + 1} value={String(i + 1)}>
                    Day {i + 1}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="promissory-recorded" className="text-xs">
              Date recorded
            </Label>
            <Input
              id="promissory-recorded"
              value={recordedOn}
              onChange={(e) => setRecordedOn(e.target.value)}
              type="date"
              max={todayIso}
              className="h-11 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="promissory-fulfilment" className="text-xs">
              Fulfil by
            </Label>
            <Input
              id="promissory-fulfilment"
              value={fulfilmentDueOn}
              onChange={(e) => setFulfilmentDueOn(e.target.value)}
              type="date"
              min={recordedOn || todayIso}
              className="h-11 text-xs"
            />
          </div>
        </div>
        {showStepErrors && fulfilmentDueOn && recordedOn && fulfilmentDueOn < recordedOn && (
          <p className="text-[11px] text-destructive">Fulfilment date must be on or after the recording date</p>
        )}

        {parsedAmount > 0 && (
          <div className="rounded-xl bg-primary/5 border border-primary/10 p-3 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-primary">
              <CircleCheck className="h-4 w-4" />
              Earnings preview
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Partner earns 15% per month</span>
              <span className="font-medium">{formatUGX(parsedAmount * 0.15)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Your validation fee</span>
              <span className="font-bold text-primary">{earningsLine}</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );

  const renderTenantsStep = () => (
    <Card className="border-border/60">
      <CardContent className="space-y-3 pt-4">
        {sectionTitle(<ListChecks className="h-5 w-5" />, 'Link houses or rent plans', 'Pick what this partner will fund — empty houses are listed first.')}
        <PromissoryPlanMatcher
          targetAmount={parsedAmount}
          selectedIds={selectedPlanIds}
          onChange={setSelectedPlanIds}
          selectedHouseIds={selectedHouseIds}
          onHousesChange={setSelectedHouseIds}
          preselectedHouse={initialHouse}
          disabled={submitting}
          onSelectedTotalChange={(total) => {
            if (amountTouched) return;
            setAmount(total > 0 ? String(total) : '');
          }}
        />
        {showStepErrors && supportMode === 'self' && selectedPlanIds.length === 0 && selectedHouseIds.length === 0 && (
          <p className="text-[11px] text-destructive">Select at least one house or tenant rent plan</p>
        )}
      </CardContent>
    </Card>
  );

  const renderReviewStep = () => {
    const rows = [
      { label: 'Partner', value: partnerName },
      { label: 'WhatsApp', value: whatsappNumber },
      ...(phoneNumber ? [{ label: 'Phone', value: phoneNumber }] : []),
      ...(email ? [{ label: 'Email', value: email }] : []),
      { label: 'Amount', value: formatUGX(parsedAmount) },
      { label: 'Type', value: contributionType === 'monthly' ? `Monthly on day ${deductionDay}` : 'Once-off' },
      { label: 'Recorded', value: recordedOn },
      ...(fulfilmentDueOn ? [{ label: 'Fulfil by', value: fulfilmentDueOn }] : []),
      ...(supportMode === 'self'
        ? [
            selectedHouseIds.length > 0
              ? { label: 'Linked houses', value: `${selectedHouseIds.length}` }
              : { label: 'Linked plans', value: `${selectedPlanIds.length}` },
          ]
        : []),
    ];
    return (
      <Card className="border-border/60">
        <CardContent className="space-y-4 pt-4">
          {sectionTitle(<FileText className="h-5 w-5" />, 'Review the note', 'Check the details before creating.')}
          <dl className="space-y-2">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between text-xs">
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className="font-medium text-foreground truncate max-w-[55%] text-right">{r.value}</dd>
              </div>
            ))}
          </dl>
          <div className="rounded-xl bg-primary/5 border border-primary/10 p-3 space-y-1">
            <p className="text-xs font-semibold text-primary">{earningsLine}</p>
            {supportMode === 'self' && (
              <p className="text-[11px] text-muted-foreground">
                {selectedHouseIds.length > 0
                  ? `${selectedHouseIds.length} house${selectedHouseIds.length === 1 ? '' : 's'} selected`
                  : `${selectedPlanIds.length} tenant plan${selectedPlanIds.length === 1 ? '' : 's'} selected`}
              </p>
            )}
          </div>
          {errorMsg && (
            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              {errorMsg}
            </div>
          )}
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full gap-2 h-11"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {submitting ? 'Creating…' : 'Create note'}
          </Button>
        </CardContent>
      </Card>
    );
  };

  const renderStepContent = () => {
    switch (currentStep.key) {
      case 'who':
        return renderWhoStep();
      case 'contact':
        return renderContactStep();
      case 'promise':
        return renderPromiseStep();
      case 'tenants':
        return renderTenantsStep();
      case 'review':
        return renderReviewStep();
      default:
        return null;
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent stable className="max-w-md p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-2">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileText className="h-5 w-5 text-primary" />
            {createdNote ? 'Note created' : 'Quick Promissory Note'}
          </DialogTitle>
        </DialogHeader>

        {createdNote ? (
          <div className="px-5 pb-6 space-y-4">
            <div className="bg-primary/5 border border-primary/20 rounded-2xl p-5 text-center space-y-3">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                <CircleCheck className="h-7 w-7" />
              </div>
              <p className="text-sm font-medium">
                Note for <span className="text-primary">{partnerName}</span> created
              </p>
              <p className="text-2xl font-bold text-primary">{formatUGX(parsedAmount)}</p>
              <div className="text-xs text-muted-foreground space-y-0.5">
                <p>
                  {contributionType === 'monthly' ? `Monthly on day ${deductionDay}` : 'Once-off'} ·{' '}
                  <span className="text-foreground font-semibold">{earningsLine}</span>
                </p>
                <p>
                  Recorded {recordedOn}
                  {fulfilmentDueOn ? ` · fulfil by ${fulfilmentDueOn}` : ''}
                </p>
                {attached.count > 0 && (
                  <p>
                    {attached.kind === 'houses'
                      ? `${attached.count} house${attached.count === 1 ? '' : 's'} booked for 7 days`
                      : `${attached.count} tenant plan${attached.count === 1 ? '' : 's'} earmarked`}{' '}
                    · <span className="font-semibold text-foreground">{formatUGX(attached.amount)}</span>
                  </p>
                )}
              </div>
            </div>
            <div className="grid gap-2">
              <Button variant="outline" onClick={handleShareLink} className="gap-2 h-11">
                <Share2 className="h-4 w-4" />
                Share activation link
              </Button>
              <Button variant="ghost" onClick={() => handleClose(false)} className="text-xs h-10">
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col h-[calc(85vh-4rem)]">
            <div className="px-5 pb-2">{renderStepIndicator()}</div>

            <div className="flex-1 overflow-y-auto px-5 pb-2 space-y-4">
              {renderStepContent()}
            </div>

            {!isLastStep && (
              <div className="border-t border-border bg-background px-5 py-3 flex items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={goBack}
                  disabled={stepIndex === 0}
                  className="gap-1 px-2 text-xs disabled:opacity-0"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Back
                </Button>
                <Button type="button" onClick={goNext} className="gap-2 text-xs h-10 px-5">
                  Next
                  <Check className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
