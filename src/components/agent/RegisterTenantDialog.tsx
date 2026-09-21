import { useState } from 'react';
import PersonNameFields from '@/components/shared/PersonNameFields';
import {
  joinPersonName,
  splitPersonName,
  validatePersonNameParts,
  type PersonNameParts,
} from '@/lib/authValidation';
import { Lc1VillagePicker } from '@/components/location/Lc1VillagePicker';
import type { UgLocationSelection } from '@/hooks/useUgLocations';
import { motion, AnimatePresence } from 'framer-motion';
import { GuarantorConsentCheckbox } from '@/components/agent/GuarantorConsentCheckbox';
import { NationalIdConsentDialog } from '@/components/shared/NationalIdConsentDialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  User,
  Phone,
  MapPin,
  Banknote,
  Building2,
  Loader2,
  CheckCircle2,
  Shield,
  Navigation,
  TrendingUp,
  Link2,
  Check,
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import RentRequestStatusTracker from '@/components/agent/RentRequestStatusTracker';
import { useSmartLocation } from '@/hooks/useSmartLocation';
import { ExistingTenantPhoneNotice } from '@/components/agent/ExistingTenantPhoneNotice';
import { useExistingTenantByPhone, type ExistingTenantMatch } from '@/hooks/useExistingTenantByPhone';

interface RegisterTenantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export default function RegisterTenantDialog({ open, onOpenChange, onSuccess }: RegisterTenantDialogProps) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [createdRentRequestId, setCreatedRentRequestId] = useState<string | null>(null);
  const { capture: captureSmart, loading: capturingLocation } = useSmartLocation();
  const [nationalIdError, setNationalIdError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const totalSteps = 4;
  const stepLabels = ['Tenant', 'Landlord', 'Location', 'Confirm'];
  const stepHeadings: Record<number, { title: string; subtitle: string; Icon: typeof User }> = {
    1: { title: "Who's the tenant?", subtitle: 'Enter their details exactly as on their National ID.', Icon: User },
    2: { title: 'Where do they rent?', subtitle: 'Add the landlord and property this tenant pays for.', Icon: Building2 },
    3: { title: 'Pin the property', subtitle: 'Capture the location so visits and verification are accurate.', Icon: Navigation },
    4: { title: 'Review & confirm', subtitle: 'Add LC1 details and accept guarantor responsibility.', Icon: Shield },
  };
  const [direction, setDirection] = useState<1 | -1>(1);
  const gotoStep = (n: 1 | 2 | 3 | 4) => {
    setDirection(n > step ? 1 : -1);
    setStep(n);
  };
  const stepVariants = {
    enter: (dir: number) => ({ opacity: 0, x: dir > 0 ? 24 : -24 }),
    center: { opacity: 1, x: 0 },
    exit: (dir: number) => ({ opacity: 0, x: dir > 0 ? -24 : 24 }),
  };
  
  // Tenant info
  const [tenantEmail, setTenantEmail] = useState('');
  const [tenantPhone, setTenantPhone] = useState('');
  const [tenantNationalId, setTenantNationalId] = useState('');
  const [tenantNationalIdName, setTenantNationalIdName] = useState('');
  // Consent flow state for borrowed National ID
  const [consentModalOpen, setConsentModalOpen] = useState(false);
  const [consentStage, setConsentStage] = useState<'awaiting_owner_phone' | 'awaiting_code'>('awaiting_owner_phone');
  const [consentDeclarationId, setConsentDeclarationId] = useState<string | null>(null);
  const [consentErrorMessage, setConsentErrorMessage] = useState<string | null>(null);
  const [consentOwnerPhone, setConsentOwnerPhone] = useState('');
  const [consentSubmitting, setConsentSubmitting] = useState(false);
  // Names are captured in parts (first / other / last) but submitted as the
  // same single strings the edge function already expects.
  const [tenantNameParts, setTenantNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const tenantFullName = joinPersonName(tenantNameParts);
  const setTenantFullName = (next: string) => setTenantNameParts(splitPersonName(next));

  // Live fraud guard: reveal if this tenant phone is already registered.
  const { match: existingTenantByPhone, checking: checkingTenantPhone } =
    useExistingTenantByPhone(tenantPhone);
  const useExistingTenantMatch = (m: ExistingTenantMatch) => {
    if (m.full_name) setTenantFullName(m.full_name);
    if (m.national_id) { setTenantNationalId(m.national_id.toUpperCase()); setNationalIdError(''); }
    toast.success(`Using ${m.full_name || 'existing tenant'}'s record`);
  };
  
  // Landlord info
  const [landlordNameParts, setLandlordNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const landlordName = joinPersonName(landlordNameParts);
  const setLandlordName = (next: string) => setLandlordNameParts(splitPersonName(next));
  const [landlordPhone, setLandlordPhone] = useState('');
  const [propertyAddress, setPropertyAddress] = useState('');
  const [monthlyRent, setMonthlyRent] = useState('');
  const [mobileMoneyNumber, setMobileMoneyNumber] = useState('');

  // Location
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);

  // LC1 Chairperson
  const [lc1NameParts, setLc1NameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const lc1Name = joinPersonName(lc1NameParts);
  const setLc1Name = (next: string) => setLc1NameParts(splitPersonName(next));
  const [lc1Phone, setLc1Phone] = useState('');
  const [lc1Village, setLc1Village] = useState('');
  /** Official dataset pick behind the LC1 village — sent so the row is linked. */
  const [lc1VillageSel, setLc1VillageSel] = useState<UgLocationSelection | null>(null);
  const [guarantorConsent, setGuarantorConsent] = useState(false);
  const [registrationRestriction, setRegistrationRestriction] = useState<{
    message: string;
    activeTenants: number;
    minActiveTenants: number;
    performancePct: number | null;
    requiredPct: number;
    periodStart: string | null;
    periodEnd: string | null;
  } | null>(null);


  const agentCommission = monthlyRent ? Math.round(parseInt(monthlyRent) * 0.02) : 0;

  const resetForm = () => {
    setTenantEmail('');
    setTenantPhone('');
    setTenantNationalId('');
    setTenantFullName('');
    setLandlordName('');
    setLandlordPhone('');
    setPropertyAddress('');
    setMonthlyRent('');
    setMobileMoneyNumber('');
    setLatitude(null);
    setLongitude(null);
    setLc1Name('');
    setLc1Phone('');
    setLc1Village('');
    setLc1VillageSel(null);
    setGuarantorConsent(false);
    setSuccess(false);
    setCreatedRentRequestId(null);
    setNationalIdError('');
    setFieldErrors({});
    setTenantNationalIdName('');
    setConsentModalOpen(false);
    setConsentDeclarationId(null);
    setConsentErrorMessage(null);
    setConsentOwnerPhone('');
    setStep(1);
  };
  // Friendly labels for the validation summary so the agent knows which field to fix.
  const fieldLabels: Record<string, string> = {
    tenantFullName: 'Full Name (as on ID)',
    tenantNationalId: 'National ID Number',
    tenantEmail: 'Email',
    tenantPhone: 'Phone',
    landlordName: "Landlord's Name",
    landlordPhone: "Landlord's Phone",
    propertyAddress: 'Property Address',
    monthlyRent: 'Monthly Rent',
  };

  // Jump the agent straight to a field that needs attention.
  const focusField = (field: string) => {
    // Split name fields render with their own ids; point the shortcuts at them.
    const nameFieldIds: Record<string, string> = {
      tenantFullName: 'tenant-reg-first-name',
      landlordName: 'tenant-reg-landlord-first-name',
      lc1Name: 'tenant-reg-lc1-first-name',
    };
    const el = document.getElementById(nameFieldIds[field] || field) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus({ preventScroll: true });
    }
  };

  // Per-field validation so the agent sees clear inline errors before continuing.
  const getStepErrors = (s: number): Record<string, string> => {
    const e: Record<string, string> = {};
    if (s === 1) {
      const tenantNameCheck = validatePersonNameParts(tenantNameParts);
      if (!tenantNameCheck.valid) e.tenantFullName = tenantNameCheck.error || "Enter the tenant's full name";
      if (!tenantNationalId.trim()) e.tenantNationalId = "Enter the tenant's National ID";
      else if (nationalIdError) e.tenantNationalId = nationalIdError;
      if (!tenantEmail.trim() && !tenantPhone.trim()) {
        e.tenantEmail = 'Add an email or phone number';
        e.tenantPhone = 'Add an email or phone number';
      } else if (tenantEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tenantEmail.trim())) {
        e.tenantEmail = 'Enter a valid email address';
      }
    }
    if (s === 2) {
      const landlordNameCheck = validatePersonNameParts(landlordNameParts);
      if (!landlordNameCheck.valid) e.landlordName = landlordNameCheck.error || "Enter the landlord's name";
      if (!landlordPhone.trim()) {
        e.landlordPhone = "Enter the landlord's phone";
      } else {
        const tp = tenantPhone.replace(/\s/g, '');
        const lp = landlordPhone.replace(/\s/g, '');
        if (tp && lp && tp === lp) e.landlordPhone = 'Cannot match the tenant phone';
      }
      if (!propertyAddress.trim()) e.propertyAddress = 'Enter the property address';
      if (!monthlyRent.trim() || parseInt(monthlyRent) <= 0) e.monthlyRent = 'Enter a valid monthly rent';
    }
    return e;
  };

  const validateStep = (s: number): string | null => {
    const e = getStepErrors(s);
    const keys = Object.keys(e);
    return keys.length ? e[keys[0]] : null;
  };

  const clearFieldError = (field: string) =>
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });

  const validateFieldOnBlur = (field: string) => {
    const errs = getStepErrors(step);
    setFieldErrors((prev) => {
      const next = { ...prev };
      if (errs[field]) next[field] = errs[field];
      else delete next[field];
      return next;
    });
  };

  const goNext = () => {
    const errs = getStepErrors(step);
    setFieldErrors(errs);
    const errorFields = Object.keys(errs);
    if (errorFields.length) {
      toast.error('Please fix the highlighted fields');
      // Scroll to and focus the first invalid field so the agent can fix it fast.
      setTimeout(() => focusField(errorFields[0]), 50);
      return;
    }
    if (step < totalSteps) gotoStep((step + 1) as 1 | 2 | 3 | 4);
  };
  const goBack = () => {
    if (step > 1) gotoStep((step - 1) as 1 | 2 | 3 | 4);
  };


  const checkDuplicateNationalId = async (value: string) => {
    setNationalIdError('');
    const cleaned = value.trim().toUpperCase();
    if (cleaned.length < 10) return;
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name')
      .eq('national_id', cleaned)
      .maybeSingle();
    if (data) {
      setNationalIdError(`This National ID is already registered to ${data.full_name}`);
    }
  };

  const captureLocation = async () => {
    const result = await captureSmart();
    if (result.ok === true) {
      setLatitude(result.latitude);
      setLongitude(result.longitude);
      toast.success(
        result.source === 'high'
          ? 'Location captured successfully'
          : 'Approximate location captured (low accuracy)',
      );
      return;
    }
    toast.error(result.message);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    if (!guarantorConsent) {
      toast.error('Please accept guarantor responsibility before registering');
      return;
    }

    if (!tenantEmail.trim() && !tenantPhone.trim()) {
      toast.error('Please provide tenant email or phone');
      return;
    }

    if (!tenantNationalId.trim()) {
      toast.error('Please provide tenant National ID number');
      return;
    }

    if (nationalIdError) {
      toast.error('This National ID is already registered. Please check.');
      return;
    }

    if (!landlordName.trim() || !landlordPhone.trim() || !propertyAddress.trim()) {
      toast.error('Please fill in all landlord details');
      return;
    }

    const cleanTenantPhone = tenantPhone.replace(/\s/g, '');
    const cleanLandlordPhone = landlordPhone.replace(/\s/g, '');
    if (cleanTenantPhone && cleanLandlordPhone && cleanTenantPhone === cleanLandlordPhone) {
      toast.error('Tenant and Landlord phone numbers cannot be the same');
      return;
    }

    if (!monthlyRent.trim()) {
      toast.error('Please provide the monthly rent amount');
      return;
    }

    await submitRegistration();
  };

  const submitRegistration = async (consentParams?: {
    id_owner_phone?: string;
    consent_declaration_id?: string;
    consent_code?: string;
  }) => {
    if (consentParams) {
      setConsentSubmitting(true);
      setConsentErrorMessage(null);
    } else {
      setLoading(true);
    }

    try {
      const payload: Record<string, unknown> = {
        full_name: tenantFullName.trim(),
        phone: tenantPhone.trim() || `0${Date.now().toString().slice(-9)}`,
        email: tenantEmail.trim() || undefined,
        national_id: tenantNationalId.trim().toUpperCase(),
        national_id_name: tenantNationalIdName.trim() || undefined,
        landlord: {
          name: landlordName.trim(),
          phone: landlordPhone.trim(),
          property_address: propertyAddress.trim(),
          monthly_rent: parseInt(monthlyRent),
          mobile_money_number: mobileMoneyNumber.trim() || null,
          latitude,
          longitude,
        },
        lc1: lc1Name.trim() && lc1Phone.trim() && lc1Village.trim()
          ? {
              name: lc1Name.trim(),
              phone: lc1Phone.trim(),
              village: lc1Village.trim(),
              village_id: lc1VillageSel?.villageId ?? null,
              region: lc1VillageSel?.region ?? null,
              district: lc1VillageSel?.district ?? null,
              county: lc1VillageSel?.county ?? null,
              sub_county: lc1VillageSel?.subcounty ?? null,
              parish: lc1VillageSel?.parish ?? null,
            }
          : null,
        rent_request: {
          rent_amount: parseInt(monthlyRent),
          duration_days: 30,
          house_category: 'single-room',
          request_latitude: latitude,
          request_longitude: longitude,
        },
        ...(consentParams?.id_owner_phone ? { id_owner_phone: consentParams.id_owner_phone } : {}),
        ...(consentParams?.consent_declaration_id ? { consent_declaration_id: consentParams.consent_declaration_id } : {}),
        ...(consentParams?.consent_code ? { consent_code: consentParams.consent_code } : {}),
      };

      const res = await supabase.functions.invoke('register-tenant', { body: payload });

      let parsedBody: Record<string, unknown> | null = null;
      if (res.error?.context) {
        try {
          parsedBody = (await res.error.context.clone().json()) as Record<string, unknown>;
        } catch (_cloneErr) {
          try {
            parsedBody = (await res.error.context.json()) as Record<string, unknown>;
          } catch (_readErr) {
            // Context stream unreadable as JSON; fall back to res.error.message
          }
        }
      }
      if (!parsedBody && res.data) {
        parsedBody = res.data as Record<string, unknown>;
      }

      if (parsedBody?.code === 'id_owner_consent_required') {
        const stageVal = parsedBody.stage;
        const nextStage =
          stageVal === 'awaiting_code' || stageVal === 'awaiting_owner_phone'
            ? stageVal
            : parsedBody.declaration_id
              ? 'awaiting_code'
              : 'awaiting_owner_phone';
        setConsentStage(nextStage);
        if (typeof parsedBody.declaration_id === 'string') {
          setConsentDeclarationId(parsedBody.declaration_id);
        }
        if (consentParams?.id_owner_phone) {
          setConsentOwnerPhone(consentParams.id_owner_phone);
        }
        setConsentErrorMessage(typeof parsedBody.error === 'string' ? parsedBody.error : null);
        setConsentModalOpen(true);
        return;
      }

      if (parsedBody?.code === 'registration_restricted') {
        const r = (parsedBody.restriction ?? {}) as Record<string, unknown>;
        setRegistrationRestriction({
          message: typeof parsedBody.error === 'string' ? parsedBody.error : 'Registration is restricted.',
          activeTenants: Number(r.active_tenants ?? 0),
          minActiveTenants: Number(r.min_active_tenants ?? 0),
          performancePct: r.previous_month_performance_pct == null ? null : Number(r.previous_month_performance_pct),
          requiredPct: Number(r.required_performance_pct ?? 0),
          periodStart: typeof r.period_start === 'string' ? r.period_start : null,
          periodEnd: typeof r.period_end === 'string' ? r.period_end : null,
        });
        setConsentModalOpen(false);
        toast.error('Registration restricted', {
          description: typeof parsedBody.error === 'string' ? parsedBody.error : undefined,
          duration: 15000,
        });
        return;
      }

      if (res.error || (parsedBody && parsedBody.error)) {
        const message =
          (typeof parsedBody?.error === 'string' ? parsedBody.error : null) ||
          res.error?.message ||
          'Failed to register tenant';
        if (consentParams) {
          setConsentErrorMessage(message);
        } else {
          toast.error('Could not register tenant', { description: message });
        }
        return;
      }


      const regData = res.data as { user_id?: string; rent_request_id?: string; existing?: boolean } | null;
      if (!regData?.user_id) {
        toast.error('Could not register tenant', { description: 'Missing user ID from server.' });
        return;
      }

      setConsentModalOpen(false);
      setCreatedRentRequestId(regData.rent_request_id ?? null);
      setSuccess(true);
      if (regData.existing) {
        toast.info('✅ Rent request submitted using existing tenant!', {
          description: 'This tenant was already registered. Commission is still tracked on every rent payment.',
          duration: 5000,
        });
      } else {
        toast.success('✅ Rent request submitted successfully!', {
          description: 'Tenant linked to landlord. You earn 2% on every rent payment.',
          duration: 5000,
        });
      }
      onSuccess?.();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'An unexpected error occurred';
      toast.error('An unexpected error occurred', { description: errMsg });
      console.error('Error:', err);
    } finally {
      setLoading(false);
      setConsentSubmitting(false);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) resetForm();
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[92vh] p-0 overflow-hidden flex flex-col overscroll-contain rounded-3xl border-border/60">
        <div className="px-6 pt-6">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10">
              <User className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-lg font-medium tracking-tight">
                Add a new tenant
              </DialogTitle>
              <DialogDescription className="mt-0.5">
                Link a tenant to their landlord and earn 2% on every rent payment.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pt-4 pb-4">
        {registrationRestriction && (
          <div className="mb-4 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <div className="flex items-center gap-2 font-medium text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              You cannot add a new tenant right now
            </div>
            <p className="mt-2 text-muted-foreground">{registrationRestriction.message}</p>
            <ul className="mt-3 space-y-1 text-muted-foreground">
              <li>
                Active tenants you are carrying:{' '}
                <span className="font-medium text-foreground">{registrationRestriction.activeTenants}</span>
                {' '}(restriction starts at {registrationRestriction.minActiveTenants})
              </li>
              <li>
                Last month you collected:{' '}
                <span className="font-medium text-foreground">
                  {registrationRestriction.performancePct == null ? '—' : `${registrationRestriction.performancePct}%`}
                </span>
                {' '}of what was due
              </li>
              <li>
                Required to keep registering:{' '}
                <span className="font-medium text-foreground">{registrationRestriction.requiredPct}%</span>
              </li>
            </ul>
            <p className="mt-3 text-muted-foreground">
              Collect more from the tenants you already have, or ask your manager to allow this registration.
            </p>
          </div>
        )}
        <AnimatePresence mode="wait">

          {success ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="py-8 text-center"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20, delay: 0.1 }}
                className="w-16 h-16 mx-auto mb-4 rounded-full bg-emerald-500/20 flex items-center justify-center"
              >
                <CheckCircle2 className="h-8 w-8 text-emerald-500" />
              </motion.div>
              <h3 className="text-lg font-semibold mb-2">Rent Request Submitted ✅</h3>
              <p className="text-muted-foreground text-sm mb-2">
                Your rent request has been posted successfully and is now pending review.
              </p>
              {createdRentRequestId && (
                <p className="text-xs text-muted-foreground mb-3">
                  Reference ID: <span className="font-mono font-semibold text-foreground">{createdRentRequestId.slice(0, 8).toUpperCase()}</span>
                </p>
              )}
              {createdRentRequestId && (
                <div className="mb-4">
                  <RentRequestStatusTracker
                    rentRequestId={createdRentRequestId}
                    initialStatus="pending"
                  />
                </div>
              )}
              <div className="text-xs text-muted-foreground space-y-1 mb-4">
                <p>✅ You earn <span className="font-semibold text-primary">2% commission</span> on every rent payment</p>
                <p>✅ Commission is automatically sent to your wallet</p>
                <p>✅ Tenant appears on the landlord's dashboard with your name</p>
              </div>
              <div className="flex flex-col gap-2">
                {createdRentRequestId && (() => {
                  const recordLink = `${window.location.origin}/dashboard/agent?submission=${createdRentRequestId}&type=tenant`;
                  return (
                    <div className="rounded-lg border bg-muted/40 p-2.5 text-left space-y-2">
                      <p className="text-[11px] font-semibold text-muted-foreground">Direct link to this submission</p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 truncate text-[11px] text-foreground/80">{recordLink}</code>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1.5 shrink-0"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(recordLink);
                              toast.success('Link copied');
                            } catch {
                              toast.error('Could not copy link');
                            }
                          }}
                        >
                          <Link2 className="h-3.5 w-3.5" /> Copy
                        </Button>
                      </div>
                    </div>
                  );
                })()}
                <Button
                  variant="secondary"
                  className="gap-2"
                  onClick={() => {
                    handleOpenChange(false);
                    window.dispatchEvent(new CustomEvent('open-submissions', { detail: { tab: 'submitted', recordId: createdRentRequestId } }));
                  }}
                >
                  <CheckCircle2 className="h-4 w-4" /> View my submission
                </Button>
                <Button variant="outline" onClick={() => handleOpenChange(false)}>Done</Button>
              </div>
            </motion.div>
          ) : (
            <motion.form
              key="form"
              id="register-tenant-form"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              onSubmit={handleSubmit}
              className="space-y-5"
            >
              {/* Material-style circular stepper */}
              <div className="flex items-center">
                {stepLabels.map((lbl, i) => {
                  const n = (i + 1) as 1 | 2 | 3 | 4;
                  const active = step === n;
                  const done = step > n;
                  return (
                    <div key={lbl} className="flex flex-1 items-center last:flex-none">
                      <button
                        type="button"
                        onClick={() => {
                          if (n < step) gotoStep(n);
                          else if (n > step) {
                            for (let k = step; k < n; k++) {
                              const err = validateStep(k);
                              if (err) { toast.error(err); return; }
                            }
                            gotoStep(n);
                          }
                        }}
                        className="flex flex-col items-center gap-1.5 outline-none"
                        aria-current={active ? 'step' : undefined}
                      >
                        <motion.span
                          animate={{ scale: active ? 1.1 : 1 }}
                          transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                          className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                            done
                              ? 'bg-primary text-primary-foreground'
                              : active
                                ? 'bg-primary text-primary-foreground ring-4 ring-primary/15'
                                : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {done ? <Check className="h-4 w-4" /> : n}
                        </motion.span>
                        <span className={`text-[10px] font-medium transition-colors ${
                          active ? 'text-primary' : done ? 'text-foreground' : 'text-muted-foreground'
                        }`}>
                          {lbl}
                        </span>
                      </button>
                      {n < totalSteps && (
                        <div className="mx-1.5 mb-5 h-0.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <motion.div
                            className="h-full rounded-full bg-primary"
                            initial={false}
                            animate={{ width: done ? '100%' : '0%' }}
                            transition={{ duration: 0.35, ease: 'easeOut' }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* One-question-at-a-time heading */}
              <div>
                <h3 className="text-base font-medium tracking-tight text-foreground">
                  {stepHeadings[step].title}
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {stepHeadings[step].subtitle}
                </p>
              </div>

              {/* Validation summary: lists every field with an error + jump-to links */}
              <AnimatePresence>
                {Object.keys(fieldErrors).length > 0 && (
                  <motion.div
                    key="validation-summary"
                    initial={{ opacity: 0, y: -6, height: 0 }}
                    animate={{ opacity: 1, y: 0, height: 'auto' }}
                    exit={{ opacity: 0, y: -6, height: 0 }}
                    transition={{ duration: 0.2 }}
                    role="alert"
                    className="overflow-hidden rounded-xl border border-destructive/40 bg-destructive/10 p-3"
                  >
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      Please fix {Object.keys(fieldErrors).length} field
                      {Object.keys(fieldErrors).length > 1 ? 's' : ''} before continuing
                    </p>
                    <ul className="mt-2 space-y-1">
                      {Object.entries(fieldErrors).map(([field, message]) => (
                        <li key={field}>
                          <button
                            type="button"
                            onClick={() => focusField(field)}
                            className="group flex w-full items-start gap-1.5 rounded-md text-left text-[11px] text-destructive outline-none hover:underline focus-visible:underline"
                          >
                            <span className="font-semibold">{fieldLabels[field] ?? field}:</span>
                            <span className="text-destructive/90">{message}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </motion.div>
                )}
              </AnimatePresence>



              <AnimatePresence mode="wait" custom={direction}>
              <motion.div
                key={step}
                custom={direction}
                variants={stepVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
                className="space-y-5"
              >
              {/* Agent Commission Banner (step 1 only) */}
              {step === 1 && (
              <div className="p-3 rounded-xl bg-gradient-to-r from-primary/10 via-emerald-500/10 to-primary/5 border border-primary/20">
                <div className="flex items-start gap-2.5">
                  <div className="p-1.5 rounded-lg bg-emerald-500/15 shrink-0 mt-0.5">
                    <TrendingUp className="h-4 w-4 text-emerald-500" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">Earn 2% on Every Rent Payment</p>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                      Register tenants under their landlord. Every time this tenant pays rent, you automatically earn 2% commission directly to your wallet.
                    </p>
                  </div>
                </div>
              </div>
              )}

              {/* Tenant Section */}
              {step === 1 && (
              <div id="sec-tenant" className="space-y-3 scroll-mt-16">
                <h4 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                  <User className="h-4 w-4 text-primary" />
                  Tenant Details
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2 space-y-1">
                    <Label className="text-xs">Names (as on ID) *</Label>
                    <PersonNameFields
                      idPrefix="tenant-reg"
                      value={tenantNameParts}
                      onChange={(next) => { setTenantNameParts(next); clearFieldError('tenantFullName'); }}
                      errors={{ firstName: fieldErrors.tenantFullName || null }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="tenantNationalId" className="text-xs">National ID Number *</Label>
                    <Input
                      id="tenantNationalId"
                      value={tenantNationalId}
                      onChange={(e) => { setTenantNationalId(e.target.value.toUpperCase()); setNationalIdError(''); clearFieldError('tenantNationalId'); }}
                      onBlur={() => { checkDuplicateNationalId(tenantNationalId); validateFieldOnBlur('tenantNationalId'); }}
                      placeholder="CM12345678ABCD"
                      className={`h-11 text-base uppercase ${nationalIdError || fieldErrors.tenantNationalId ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                      aria-invalid={!!(nationalIdError || fieldErrors.tenantNationalId)}
                      autoCapitalize="characters"
                      autoCorrect="off"
                      spellCheck={false}
                      required
                    />
                    {(nationalIdError || fieldErrors.tenantNationalId) && (
                      <p className="text-[11px] text-destructive font-medium">{nationalIdError || fieldErrors.tenantNationalId}</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="tenantNationalIdName" className="text-xs">Name on National ID</Label>
                      <span className="text-[10px] text-muted-foreground">Optional</span>
                    </div>
                    <Input
                      id="tenantNationalIdName"
                      value={tenantNationalIdName}
                      onChange={(e) => setTenantNationalIdName(e.target.value)}
                      placeholder="Name exactly as printed on ID"
                      className="h-11 text-base"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Only needed if using someone else's ID
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="tenantEmail" className="text-xs">Email</Label>
                    <Input
                      id="tenantEmail"
                      type="email"
                      value={tenantEmail}
                      onChange={(e) => { setTenantEmail(e.target.value); clearFieldError('tenantEmail'); clearFieldError('tenantPhone'); }}
                      onBlur={() => validateFieldOnBlur('tenantEmail')}
                      placeholder="tenant@email.com"
                      className={`h-11 text-base ${fieldErrors.tenantEmail ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                      aria-invalid={!!fieldErrors.tenantEmail}
                      autoComplete="email"
                      inputMode="email"
                      autoCapitalize="none"
                    />
                    {fieldErrors.tenantEmail && (
                      <p className="text-[11px] text-destructive font-medium">{fieldErrors.tenantEmail}</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="tenantPhone" className="text-xs">Phone</Label>
                    <Input
                      id="tenantPhone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      value={tenantPhone}
                      onChange={(e) => { setTenantPhone(e.target.value); clearFieldError('tenantPhone'); clearFieldError('tenantEmail'); }}
                      onBlur={() => validateFieldOnBlur('tenantPhone')}
                      placeholder="0783..."
                      className={`h-11 text-base ${fieldErrors.tenantPhone ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                      aria-invalid={!!fieldErrors.tenantPhone}
                    />
                    {fieldErrors.tenantPhone && (
                      <p className="text-[11px] text-destructive font-medium">{fieldErrors.tenantPhone}</p>
                    )}
                  </div>
                </div>
                <ExistingTenantPhoneNotice
                  match={existingTenantByPhone}
                  checking={checkingTenantPhone}
                  onUse={useExistingTenantMatch}
                />
              </div>
              )}

              {/* Landlord Section */}
              {step === 2 && (
              <div id="sec-landlord" className="space-y-3 scroll-mt-16">
                <h4 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                  <Building2 className="h-4 w-4 text-primary" />
                  Landlord Details
                </h4>
                
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2 space-y-1">
                    <Label className="text-xs">Landlord Name *</Label>
                    <PersonNameFields
                      idPrefix="tenant-reg-landlord"
                      value={landlordNameParts}
                      onChange={(next) => { setLandlordNameParts(next); clearFieldError('landlordName'); }}
                      errors={{ firstName: fieldErrors.landlordName || null }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="landlordPhone" className="text-xs">Phone *</Label>
                    <Input
                      id="landlordPhone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      value={landlordPhone}
                      onChange={(e) => { setLandlordPhone(e.target.value); clearFieldError('landlordPhone'); }}
                      onBlur={() => validateFieldOnBlur('landlordPhone')}
                      placeholder="Phone number"
                      className={`h-11 text-base ${fieldErrors.landlordPhone ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                      aria-invalid={!!fieldErrors.landlordPhone}
                      required
                    />
                    {fieldErrors.landlordPhone ? (
                      <p className="text-[11px] text-destructive font-medium">{fieldErrors.landlordPhone}</p>
                    ) : landlordPhone.replace(/\s/g, '').length >= 9 &&
                      tenantPhone.replace(/\s/g, '').length >= 9 &&
                      landlordPhone.replace(/\s/g, '') === tenantPhone.replace(/\s/g, '') ? (
                        <p className="text-[11px] text-destructive font-medium">Cannot be the same as Tenant phone</p>
                      ) : null}
                  </div>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="propertyAddress" className="text-xs flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> Property Address *
                  </Label>
                  <Input
                    id="propertyAddress"
                    value={propertyAddress}
                    onChange={(e) => { setPropertyAddress(e.target.value); clearFieldError('propertyAddress'); }}
                    onBlur={() => validateFieldOnBlur('propertyAddress')}
                    placeholder="Full property address"
                    className={`h-11 text-base ${fieldErrors.propertyAddress ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                    aria-invalid={!!fieldErrors.propertyAddress}
                    autoCapitalize="words"
                    required
                  />
                  {fieldErrors.propertyAddress && (
                    <p className="text-[11px] text-destructive font-medium">{fieldErrors.propertyAddress}</p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="monthlyRent" className="text-xs flex items-center gap-1">
                      <Banknote className="h-3 w-3" /> Monthly Rent (UGX) *
                    </Label>
                    <Input
                      id="monthlyRent"
                      type="number"
                      inputMode="numeric"
                      value={monthlyRent}
                      onChange={(e) => { setMonthlyRent(e.target.value); clearFieldError('monthlyRent'); }}
                      onBlur={() => validateFieldOnBlur('monthlyRent')}
                      placeholder="500000"
                      className={`h-11 text-base ${fieldErrors.monthlyRent ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                      aria-invalid={!!fieldErrors.monthlyRent}
                      required
                    />
                    {fieldErrors.monthlyRent && (
                      <p className="text-[11px] text-destructive font-medium">{fieldErrors.monthlyRent}</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="mobileMoneyNumber" className="text-xs flex items-center gap-1">
                      <Phone className="h-3 w-3" /> Mobile Money
                    </Label>
                    <Input
                      id="mobileMoneyNumber"
                      type="tel"
                      inputMode="tel"
                      value={mobileMoneyNumber}
                      onChange={(e) => setMobileMoneyNumber(e.target.value)}
                      placeholder="MoMo number"
                      className="h-11 text-base"
                    />
                  </div>
                </div>

                {/* Commission Preview */}
                {monthlyRent && parseInt(monthlyRent) > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20"
                  >
                    <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                      <TrendingUp className="h-3.5 w-3.5" />
                      Your 2% Commission Per Rent Payment
                    </p>
                    <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400 mt-1">
                      {formatUGX(agentCommission)}/month
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Automatically sent to your wallet every time this tenant pays
                    </p>
                  </motion.div>
                )}
              </div>
              )}

              {/* Location Capture */}
              {step === 3 && (
              <div id="sec-location" className="space-y-3 scroll-mt-16">
                <h4 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                  <Navigation className="h-4 w-4 text-primary" />
                  Property Location
                </h4>
                <div className="p-3 rounded-lg bg-muted/50 border border-border/50">
                  {latitude && longitude ? (
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs text-emerald-500 font-medium">📍 Location captured</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {latitude.toFixed(5)}, {longitude.toFixed(5)}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={captureLocation}
                        disabled={capturingLocation}
                      >
                        Re-capture
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full gap-2"
                      onClick={captureLocation}
                      disabled={capturingLocation}
                    >
                      {capturingLocation ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Capturing...
                        </>
                      ) : (
                        <>
                          <Navigation className="h-4 w-4" />
                          Capture Current Location
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
              )}

              {/* LC1 Chairperson + Consent (final step) */}
              {step === 4 && (
              <>
              <div id="sec-lc1" className="space-y-3 scroll-mt-16">
                <h4 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                  <Shield className="h-4 w-4 text-primary" />
                  LC1 Chairperson Details
                </h4>
                <div className="p-3 rounded-lg bg-muted/50 border border-border/50 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2 space-y-1">
                      <Label className="text-xs">LC1 Name</Label>
                      <PersonNameFields
                        idPrefix="tenant-reg-lc1"
                        value={lc1NameParts}
                        onChange={setLc1NameParts}
                        required={false}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="lc1Phone" className="text-xs">LC1 Phone</Label>
                      <Input
                        id="lc1Phone"
                        value={lc1Phone}
                        onChange={(e) => setLc1Phone(e.target.value)}
                        placeholder="0783..."
                        className="h-9"
                      />
                    </div>
                  </div>
                  <Lc1VillagePicker
                    className="space-y-1"
                    value={lc1Village}
                    onChange={(name, sel) => {
                      setLc1Village(name);
                      setLc1VillageSel(sel);
                    }}
                  />
                </div>
              </div>

              <GuarantorConsentCheckbox checked={guarantorConsent} onCheckedChange={setGuarantorConsent} />
              </>
              )}
              </motion.div>
              </AnimatePresence>
            </motion.form>
          )}
        </AnimatePresence>
        </div>

        {!success && (
          <div className="border-t bg-background/95 backdrop-blur px-4 py-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
            {step === 4 && !guarantorConsent && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400 mb-2 text-center">
                Tick the guarantor consent above to submit
              </p>
            )}
            <div className="flex gap-2">
              {step > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  className="h-12 gap-1.5 rounded-full px-5 text-base"
                  onClick={goBack}
                  disabled={loading}
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back
                </Button>
              )}
              {step < totalSteps ? (
                <Button
                  type="button"
                  size="lg"
                  className="flex-1 h-12 gap-1.5 rounded-full text-base font-medium shadow-sm"
                  onClick={goNext}
                >
                  Continue
                  <ArrowRight className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  type="button"
                  size="lg"
                  className="flex-1 h-12 gap-1.5 rounded-full text-base font-medium shadow-sm"
                  disabled={loading}
                  onClick={() => handleSubmit({ preventDefault: () => {} } as React.FormEvent)}
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    'Submit Rent Request'
                  )}
                </Button>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground text-center mt-2">
              Step {step} of {totalSteps}
            </p>
          </div>
        )}
      </DialogContent>

      <NationalIdConsentDialog
        open={consentModalOpen}
        onOpenChange={setConsentModalOpen}
        stage={consentStage}
        declarationId={consentDeclarationId}
        errorMessage={consentErrorMessage}
        idOwnerName={tenantNationalIdName}
        registrantName={tenantFullName}
        initialOwnerPhone={consentOwnerPhone}
        submitting={consentSubmitting}
        onSubmitPhone={async (phone) => {
          setConsentOwnerPhone(phone);
          await submitRegistration({ id_owner_phone: phone });
        }}
        onSubmitCode={async (code) => {
          await submitRegistration({
            id_owner_phone: consentOwnerPhone,
            consent_declaration_id: consentDeclarationId || undefined,
            consent_code: code,
          });
        }}
        onResendCode={async () => {
          await submitRegistration({ id_owner_phone: consentOwnerPhone });
        }}
      />
    </Dialog>
  );
}
