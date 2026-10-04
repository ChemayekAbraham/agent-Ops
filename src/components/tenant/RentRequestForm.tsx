import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Lc1VillagePicker } from '@/components/location/Lc1VillagePicker';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Progress } from '@/components/ui/progress';
import {
  FileText, CalendarClock, Banknote, Navigation, Loader2,
  ArrowLeft, ArrowRight, User, IdCard, Gauge, Building2, MapPin,
  Camera, Users, CheckCircle2, Percent, CalendarDays, ListChecks,
} from 'lucide-react';
import { format, addDays } from 'date-fns';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { calculateRentRepayment, formatUGX, ACCESS_FEE_RATES } from '@/lib/rentCalculations';
import { generateRepaymentSchedule, insertRepaymentSchedule } from '@/lib/scheduleUtils';
import { useToast } from '@/hooks/use-toast';
import { optimizeImage } from '@/lib/imageOptimizer';
import { useSmartLocation, captureSmartLocation } from '@/hooks/useSmartLocation';
import FormStepHeader from '@/components/shared/FormStepHeader';
import { useUnsavedChangesGuard, confirmDiscardIfDirty } from '@/hooks/useUnsavedChangesGuard';

interface RentRequestFormProps {
  userId: string;
  onSuccess: () => void;
  onCancel: () => void;
}

const MIN_DAYS = 7;
const MAX_DAYS = 120;

// ── Autosave draft (localStorage) ────────────────────────────────
// Lets a tenant leave the wizard and continue later without losing
// answers. Photos (File objects) can't be serialized, so only text /
// numeric / step state is persisted. Cleared on successful submit.
const DRAFT_VERSION = 1;
const draftKey = (uid: string) => `welile_rent_request_draft_v${DRAFT_VERSION}:${uid}`;

type RentDraft = {
  rentAmount: string;
  duration: number;
  numberOfPayments: number;
  accessFeeRate: number;
  tenantNationalId: string;
  tenantFullName: string;
  tenantWaterMeter: string;
  tenantElectricityMeter: string;
  landlordName: string;
  landlordPhone: string;
  landlordNationalId: string;
  landlordTin: string;
  propertyAddress: string;
  waterMeterNumber: string;
  electricityMeterNumber: string;
  lc1Name: string;
  lc1Phone: string;
  lc1Village: string;
  stepIndex: number;
};

function loadRentDraft(uid: string): Partial<RentDraft> | null {
  try {
    const raw = localStorage.getItem(draftKey(uid));
    return raw ? (JSON.parse(raw) as Partial<RentDraft>) : null;
  } catch {
    return null;
  }
}

// Quick select options
const quickOptions = [
  { days: 7, label: '1 Week' },
  { days: 14, label: '2 Weeks' },
  { days: 30, label: '30 Days' },
  { days: 60, label: '60 Days' },
  { days: 90, label: '90 Days' },
  { days: 120, label: '4 Months' },
];

export default function RentRequestForm({ userId, onSuccess, onCancel }: RentRequestFormProps) {
  // Saved draft (if any) for this tenant — NOT auto-applied. We prompt first.
  const restored = useMemo(() => loadRentDraft(userId), [userId]);
  const draftHasContent = (d: Partial<RentDraft> | null): boolean =>
    !!d && !!(
      d.rentAmount?.trim() || d.tenantNationalId?.trim() || d.tenantFullName?.trim() ||
      d.tenantWaterMeter?.trim() || d.tenantElectricityMeter?.trim() ||
      d.landlordName?.trim() || d.landlordPhone?.trim() || d.landlordNationalId?.trim() ||
      d.landlordTin?.trim() || d.propertyAddress?.trim() || d.waterMeterNumber?.trim() ||
      d.electricityMeterNumber?.trim() || d.lc1Name?.trim() || d.lc1Phone?.trim() ||
      d.lc1Village?.trim() || (typeof d.stepIndex === 'number' && d.stepIndex > 0)
    );

  // Show the restore prompt on open when a meaningful draft exists.
  const [showRestorePrompt, setShowRestorePrompt] = useState(() => draftHasContent(restored));
  const [draftRestored, setDraftRestored] = useState(false);

  const [rentAmount, setRentAmount] = useState('');
  const [duration, setDuration] = useState(30);
  const [numberOfPayments, setNumberOfPayments] = useState(4);
  const [accessFeeRate, setAccessFeeRate] = useState(0.33);
  // Tenant details
  const [tenantNationalId, setTenantNationalId] = useState('');
  const [tenantFullName, setTenantFullName] = useState('');
  const [nationalIdError, setNationalIdError] = useState('');
  
  // Tenant utility meters
  const [tenantWaterMeter, setTenantWaterMeter] = useState('');
  const [tenantElectricityMeter, setTenantElectricityMeter] = useState('');
  
  // Landlord details
  const [landlordName, setLandlordName] = useState('');
  const [landlordPhone, setLandlordPhone] = useState('');
  const [landlordNationalId, setLandlordNationalId] = useState('');
  const [landlordTin, setLandlordTin] = useState('');
  const [propertyAddress, setPropertyAddress] = useState('');
  const [waterMeterNumber, setWaterMeterNumber] = useState('');
  const [electricityMeterNumber, setElectricityMeterNumber] = useState('');
  
  // LC1 details
  const [lc1Name, setLc1Name] = useState('');
  const [lc1Phone, setLc1Phone] = useState('');
  const [lc1Village, setLc1Village] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  // Wizard step index — one question at a time
  const [stepIndex, setStepIndex] = useState(0);
  const [draftSaved, setDraftSaved] = useState(false);

  // ── Persist the draft (debounced) whenever an answer changes ──
  const submittedRef = useRef(false);
  useEffect(() => {
    if (submittedRef.current) return;
    // While the restore prompt is open, don't overwrite the saved draft
    // with the current (empty) form — the user hasn't decided yet.
    if (showRestorePrompt) return;
    const draft: RentDraft = {
      rentAmount, duration, numberOfPayments, accessFeeRate,
      tenantNationalId, tenantFullName, tenantWaterMeter, tenantElectricityMeter,
      landlordName, landlordPhone, landlordNationalId, landlordTin,
      propertyAddress, waterMeterNumber, electricityMeterNumber,
      lc1Name, lc1Phone, lc1Village, stepIndex,
    };
    const id = setTimeout(() => {
      try {
        localStorage.setItem(draftKey(userId), JSON.stringify(draft));
        setDraftSaved(true);
      } catch {
        /* quota / private mode — ignore */
      }
    }, 600);
    return () => clearTimeout(id);
  }, [
    userId, showRestorePrompt, rentAmount, duration, numberOfPayments, accessFeeRate,
    tenantNationalId, tenantFullName, tenantWaterMeter, tenantElectricityMeter,
    landlordName, landlordPhone, landlordNationalId, landlordTin,
    propertyAddress, waterMeterNumber, electricityMeterNumber,
    lc1Name, lc1Phone, lc1Village, stepIndex,
  ]);

  const clearDraft = useCallback(() => {
    try { localStorage.removeItem(draftKey(userId)); } catch { /* ignore */ }
  }, [userId]);

  const resetFields = useCallback(() => {
    setRentAmount(''); setDuration(30); setNumberOfPayments(4); setAccessFeeRate(0.33);
    setTenantNationalId(''); setTenantFullName(''); setNationalIdError('');
    setTenantWaterMeter(''); setTenantElectricityMeter('');
    setLandlordName(''); setLandlordPhone(''); setLandlordNationalId(''); setLandlordTin('');
    setPropertyAddress(''); setWaterMeterNumber(''); setElectricityMeterNumber('');
    setLc1Name(''); setLc1Phone(''); setLc1Village('');
    setStepIndex(0);
  }, []);

  // User chose to restore: load saved answers into the form.
  const applyDraft = useCallback(() => {
    if (restored) {
      setRentAmount(restored.rentAmount ?? '');
      setDuration(restored.duration ?? 30);
      setNumberOfPayments(restored.numberOfPayments ?? 4);
      setAccessFeeRate(restored.accessFeeRate ?? 0.33);
      setTenantNationalId(restored.tenantNationalId ?? '');
      setTenantFullName(restored.tenantFullName ?? '');
      setTenantWaterMeter(restored.tenantWaterMeter ?? '');
      setTenantElectricityMeter(restored.tenantElectricityMeter ?? '');
      setLandlordName(restored.landlordName ?? '');
      setLandlordPhone(restored.landlordPhone ?? '');
      setLandlordNationalId(restored.landlordNationalId ?? '');
      setLandlordTin(restored.landlordTin ?? '');
      setPropertyAddress(restored.propertyAddress ?? '');
      setWaterMeterNumber(restored.waterMeterNumber ?? '');
      setElectricityMeterNumber(restored.electricityMeterNumber ?? '');
      setLc1Name(restored.lc1Name ?? '');
      setLc1Phone(restored.lc1Phone ?? '');
      setLc1Village(restored.lc1Village ?? '');
      setStepIndex(restored.stepIndex ?? 0);
    }
    setDraftRestored(true);
    setShowRestorePrompt(false);
  }, [restored]);

  // User chose to start fresh: discard the saved draft.
  const startFresh = useCallback(() => {
    clearDraft();
    resetFields();
    setDraftRestored(false);
    setDraftSaved(false);
    setShowRestorePrompt(false);
  }, [clearDraft, resetFields]);

  const discardDraft = useCallback(() => {
    submittedRef.current = true;
    clearDraft();
    resetFields();
    setDraftRestored(false);
    setDraftSaved(false);
    submittedRef.current = false;
  }, [clearDraft, resetFields]);


  // GPS & Photos
  const [propertyGps, setPropertyGps] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const { capture: captureGps, loading: gpsLoading } = useSmartLocation();
  const [housePhotos, setHousePhotos] = useState<{ file: File; preview: string }[]>([]);

  const capturePropertyGPS = useCallback(async () => {
    const result = await captureGps();
    if (result.ok === true) {
      setPropertyGps({ lat: result.latitude, lng: result.longitude, accuracy: result.accuracy });
      toast({
        title: result.source === 'high'
          ? '📍 Property GPS captured!'
          : '📍 Approximate GPS captured (low accuracy)',
      });
    } else {
      toast({ title: result.message, variant: 'destructive' });
    }
  }, [captureGps, toast]);

  const handlePhotoAdd = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const remaining = 3 - housePhotos.length;
    if (remaining <= 0) return;
    const toAdd = files.slice(0, remaining);
    const newPhotos = toAdd.map(f => ({ file: f, preview: URL.createObjectURL(f) }));
    setHousePhotos(prev => [...prev, ...newPhotos]);
    if (e.target) e.target.value = '';
  }, [housePhotos.length]);

  const removePhoto = useCallback((index: number) => {
    setHousePhotos(prev => {
      URL.revokeObjectURL(prev[index].preview);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const checkDuplicateNationalId = useCallback(async (value: string) => {
    setNationalIdError('');
    const cleaned = value.trim().toUpperCase();
    if (cleaned.length < 10) return;
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name')
      .eq('national_id', cleaned)
      .neq('id', userId)
      .maybeSingle();
    if (data) {
      setNationalIdError(`This National ID is already registered to ${data.full_name}`);
    }
  }, [userId]);

  const uploadHousePhotos = async (requestId: string): Promise<string[]> => {
    if (housePhotos.length === 0) return [];
    const urls: string[] = [];
    for (let i = 0; i < housePhotos.length; i++) {
      try {
        const optimized = await optimizeImage(housePhotos[i].file, { maxWidth: 1200, quality: 0.8 });
        const ext = optimized.file.name.split('.').pop() || 'webp';
        const path = `${userId}/${requestId}/photo_${i}.${ext}`;
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

  // Max payments based on duration
  const maxPayments = Math.min(duration, 30);

  const calc = useMemo(() => {
    const amount = parseInt(rentAmount.replace(/,/g, '')) || 0;
    if (amount <= 0) return null;
    return calculateRentRepayment(amount, duration, accessFeeRate);
  }, [rentAmount, duration, accessFeeRate]);

  // Adjust numberOfPayments if duration changes
  const handleDurationChange = (days: number) => {
    setDuration(days);
    const newMax = Math.min(days, 30);
    if (numberOfPayments > newMax) {
      setNumberOfPayments(Math.max(1, newMax));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!calc) return;
    if (nationalIdError) {
      toast({ title: 'Duplicate National ID', description: nationalIdError, variant: 'destructive' });
      return;
    }
    
    setLoading(true);

    // Update tenant profile with national ID and verified name
    if (tenantNationalId.trim() || tenantFullName.trim()) {
      await supabase
        .from('profiles')
        .update({ 
          national_id: tenantNationalId.trim() || undefined,
          full_name: tenantFullName.trim() || undefined
        })
        .eq('id', userId);
    }

    // Create landlord with utility meter numbers and TIN
    const { data: landlord, error: landlordError } = await supabase
      .from('landlords')
      .insert({ 
        name: landlordName, 
        phone: landlordPhone, 
        property_address: propertyAddress,
        water_meter_number: waterMeterNumber.trim() || null,
        electricity_meter_number: electricityMeterNumber.trim() || null,
        tin: landlordTin.trim() || null,
      } as any)
      .select('id')
      .single();

    if (landlordError) {
      toast({ title: 'Error', description: landlordError.message, variant: 'destructive' });
      setLoading(false);
      return;
    }

    // Reuse-or-create LC1 (a phone uniquely identifies one chairperson)
    let lc1: { id: string } | null = null;
    const { data: existingLc1 } = await supabase
      .from('lc1_chairpersons')
      .select('id')
      .eq('phone', lc1Phone)
      .order('verified', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (existingLc1) {
      lc1 = existingLc1;
    } else {
      const { data: newLc1, error: lc1Error } = await supabase
        .from('lc1_chairpersons')
        .insert({ name: lc1Name, phone: lc1Phone, village: lc1Village })
        .select('id')
        .single();
      if (lc1Error) {
        toast({
          title: lc1Error.code === '23505' ? 'LC1 chairperson already exists' : 'Error',
          description: lc1Error.code === '23505'
            ? 'An LC1 chairperson with this phone number is already registered.'
            : lc1Error.message,
          variant: 'destructive',
        });
        setLoading(false);
        return;
      }
      lc1 = newLc1;
    }

    // Get referral agent ID from localStorage
    const agentId = localStorage.getItem('referral_agent_id');

    // Use manually captured GPS if available, otherwise try auto-capture
    let requestLat: number | null = propertyGps?.lat ?? null;
    let requestLon: number | null = propertyGps?.lng ?? null;
    let requestCity: string | null = null;
    let requestCountry: string | null = null;
    
    if (!requestLat) {
      const auto = await captureSmartLocation();
      if (auto.ok === true) {
        requestLat = auto.latitude;
        requestLon = auto.longitude;
      } else {
        console.warn('Could not capture location for rent request:', auto.reason, auto.message);
      }
    }
    
    if (requestLat && requestLon && requestLat >= -1.5 && requestLat <= 4.2 && requestLon >= 29.5 && requestLon <= 35.0) {
      requestCountry = 'Uganda';
    }

    // Create rent request with number_of_payments and tenant meters
    const { data: rentRequest, error: requestError } = await supabase
      .from('rent_requests')
      .insert({
        tenant_id: userId,
        agent_id: agentId || null,
        landlord_id: landlord.id,
        lc1_id: lc1.id,
        rent_amount: calc.rentAmount,
        duration_days: calc.durationDays,
        access_fee: calc.accessFee,
        request_fee: calc.requestFee,
        total_repayment: calc.totalRepayment,
        daily_repayment: calc.dailyRepayment,
        number_of_payments: numberOfPayments,
        schedule_status: 'pending_acceptance',
        tenant_water_meter: tenantWaterMeter.trim() || null,
        tenant_electricity_meter: tenantElectricityMeter.trim() || null,
        request_latitude: requestLat,
        request_longitude: requestLon,
        request_city: requestCity,
        request_country: requestCountry,
      } as any)
      .select('id')
      .single();

    if (requestError) {
      toast({ title: 'Error', description: requestError.message, variant: 'destructive' });
      setLoading(false);
      return;
    }

    // Upload house photos if any
    if (housePhotos.length > 0 && rentRequest?.id) {
      const photoUrls = await uploadHousePhotos(rentRequest.id);
      if (photoUrls.length > 0) {
        await supabase
          .from('rent_requests')
          .update({ house_image_urls: photoUrls } as any)
          .eq('id', rentRequest.id);
      }
    }

    // Generate and insert repayment schedule
    const schedule = generateRepaymentSchedule(
      calc.totalRepayment,
      numberOfPayments,
      calc.durationDays
    );

    const scheduleResult = await insertRepaymentSchedule(
      supabase,
      rentRequest.id,
      userId,
      schedule
    );

    if (!scheduleResult.success) {
      toast({ title: 'Warning', description: 'Request created but schedule generation failed.', variant: 'destructive' });
    }

    // Request posted — clear the saved draft so it won't be restored later.
    submittedRef.current = true;
    clearDraft();
    onSuccess();
    setLoading(false);
  };

  // ─────────────────────────────────────────────────────────────
  // One-question-at-a-time wizard definition
  // ─────────────────────────────────────────────────────────────
  const repaymentStartLabel = format(addDays(new Date(), 1), 'EEEE, MMMM d, yyyy');

  const steps: {
    key: string;
    icon: typeof Banknote;
    stepLabel: string;
    title: string;
    subtitle?: string;
    valid: boolean;
    node: JSX.Element;
  }[] = [
    // 0 — Rent amount
    {
      key: 'amount',
      icon: Banknote,
      stepLabel: 'Rent details',
      title: 'How much is the rent?',
      subtitle: 'Enter the amount you want Welile to pay today.',
      valid: !!calc,
      node: (
        <div className="space-y-2">
          <Label className="font-bold text-sm">Rent Amount (UGX)</Label>
          <Input
            value={rentAmount}
            onChange={(e) => setRentAmount(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="e.g., 500000"
            inputMode="numeric"
            autoFocus
            className="h-14 text-2xl font-bold border-primary/30 focus:border-primary"
          />
          {calc && (
            <p className="text-sm text-muted-foreground">
              That's <span className="font-semibold text-primary">{formatUGX(calc.rentAmount)}</span>.
            </p>
          )}
        </div>
      ),
    },
    // 1 — Access fee rate
    {
      key: 'rate',
      icon: Percent,
      stepLabel: 'Rent details',
      title: 'Pick your access fee rate',
      subtitle: 'This is the monthly rate applied to your rent assistance.',
      valid: true,
      node: (
        <div className="flex flex-col gap-2">
          {ACCESS_FEE_RATES.map((opt) => (
            <Button
              key={opt.rate}
              type="button"
              variant={accessFeeRate === opt.rate ? 'default' : 'outline'}
              onClick={() => setAccessFeeRate(opt.rate)}
              className="h-12 justify-between text-sm"
            >
              <span>{opt.label} / month</span>
              {accessFeeRate === opt.rate && <CheckCircle2 className="h-4 w-4" />}
            </Button>
          ))}
        </div>
      ),
    },
    // 2 — Payback period + number of payments
    {
      key: 'duration',
      icon: CalendarDays,
      stepLabel: 'Rent details',
      title: 'When will you pay it back?',
      subtitle: 'Choose how long you need and how many payments to split it into.',
      valid: true,
      node: (
        <div className="space-y-5">
          <div className="space-y-2">
            <Label className="font-bold text-sm">Payback period</Label>
            <div className="grid grid-cols-3 gap-2">
              {quickOptions.map((option) => (
                <Button
                  key={option.days}
                  type="button"
                  variant={duration === option.days ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handleDurationChange(option.days)}
                  className="text-xs"
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <Label className="font-bold text-sm">Custom days</Label>
              <span className="text-sm font-bold text-primary">{duration} days</span>
            </div>
            <Slider
              value={[duration]}
              onValueChange={(value) => handleDurationChange(value[0])}
              min={MIN_DAYS}
              max={MAX_DAYS}
              step={1}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{MIN_DAYS} days</span>
              <span>{MAX_DAYS} days</span>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <Label className="font-bold text-sm">Number of payments</Label>
              <span className="text-sm font-bold text-primary">
                {numberOfPayments} payment{numberOfPayments > 1 ? 's' : ''}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {[1, 2, 3, 4, 5, 6].filter((n) => n <= maxPayments).map((num) => (
                <Button
                  key={num}
                  type="button"
                  variant={numberOfPayments === num ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setNumberOfPayments(num)}
                  className="text-xs min-w-[44px]"
                >
                  {num}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Max {maxPayments} payments for {duration} days</p>
          </div>
        </div>
      ),
    },
    // 3 — Repayment plan review
    {
      key: 'plan',
      icon: ListChecks,
      stepLabel: 'Rent details',
      title: 'Here is your repayment plan',
      subtitle: 'Confirm the numbers look right before continuing.',
      valid: !!calc,
      node: calc ? (
        <div className="space-y-3">
          <div className="p-4 rounded-2xl bg-primary/15 border-2 border-primary/40 text-center">
            <p className="text-xs font-semibold text-primary/80 mb-1 uppercase tracking-wide">And you pay</p>
            <p className="text-3xl font-black text-primary font-mono">{formatUGX(calc.dailyRepayment)}</p>
            <p className="text-xs text-primary/70 mt-1">per day for {calc.durationDays} days</p>
          </div>

          <div className="p-3 rounded-xl bg-primary/10 border border-primary/30 flex items-center gap-3">
            <CalendarClock className="h-5 w-5 text-primary shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Repayment starts</p>
              <p className="font-bold text-sm text-primary">{repaymentStartLabel}</p>
              <p className="text-[10px] text-muted-foreground">Tomorrow — the day after posting</p>
            </div>
          </div>

          <div className="space-y-2 p-3 rounded-xl bg-background/80 border">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Rent Amount:</span>
              <span className="font-mono font-medium">{formatUGX(calc.rentAmount)}</span>
            </div>
            <div className="p-2 rounded-lg bg-accent/20 border border-accent/30 text-center">
              <p className="text-xs text-muted-foreground">
                {numberOfPayments} payment{numberOfPayments > 1 ? 's' : ''} of
              </p>
              <p className="text-lg font-bold font-mono">
                {formatUGX(Math.ceil(calc.totalRepayment / numberOfPayments))}
              </p>
              <p className="text-xs text-muted-foreground">
                every {Math.floor(calc.durationDays / numberOfPayments)} days
              </p>
            </div>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Go back and enter a rent amount first.</p>
      ),
    },
    // 4 — Tenant full name
    {
      key: 'tenantName',
      icon: User,
      stepLabel: 'Your identity',
      title: 'What is your full name?',
      subtitle: 'Type your names exactly as they appear on your National ID.',
      valid: !!tenantFullName.trim(),
      node: (
        <Input
          placeholder="Names as on National ID"
          value={tenantFullName}
          onChange={(e) => setTenantFullName(e.target.value)}
          autoFocus
          className="h-12"
        />
      ),
    },
    // 5 — Tenant National ID
    {
      key: 'tenantId',
      icon: IdCard,
      stepLabel: 'Your identity',
      title: 'What is your National ID number?',
      subtitle: 'We use this to verify your identity securely.',
      valid: !!tenantNationalId.trim() && !nationalIdError,
      node: (
        <div className="space-y-2">
          <Input
            placeholder="e.g., CM12345678ABCD"
            value={tenantNationalId}
            onChange={(e) => { setTenantNationalId(e.target.value.toUpperCase()); setNationalIdError(''); }}
            onBlur={() => checkDuplicateNationalId(tenantNationalId)}
            autoFocus
            className={`h-12 ${nationalIdError ? 'border-destructive' : ''}`}
          />
          {nationalIdError && <p className="text-[11px] text-destructive font-medium">{nationalIdError}</p>}
        </div>
      ),
    },
    // 6 — Tenant utility meters (optional)
    {
      key: 'tenantMeters',
      icon: Gauge,
      stepLabel: 'Your identity',
      title: 'Your utility meter numbers',
      subtitle: 'Optional — you can skip this and continue.',
      valid: true,
      node: (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Your NWSC Water Meter</Label>
            <Input placeholder="Your water meter number" value={tenantWaterMeter} onChange={(e) => setTenantWaterMeter(e.target.value)} className="h-12" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Your UEDCL/UMEME Electricity Meter</Label>
            <Input placeholder="Your electricity meter number" value={tenantElectricityMeter} onChange={(e) => setTenantElectricityMeter(e.target.value)} className="h-12" />
          </div>
        </div>
      ),
    },
    // 7 — Landlord name
    {
      key: 'landlordName',
      icon: Building2,
      stepLabel: 'Landlord details',
      title: "What is your landlord's name?",
      subtitle: 'As it appears on their National ID.',
      valid: !!landlordName.trim(),
      node: (
        <Input placeholder="Landlord name" value={landlordName} onChange={(e) => setLandlordName(e.target.value)} autoFocus className="h-12" />
      ),
    },
    // 8 — Landlord phone
    {
      key: 'landlordPhone',
      icon: Building2,
      stepLabel: 'Landlord details',
      title: "What is your landlord's phone number?",
      valid: !!landlordPhone.trim(),
      node: (
        <Input placeholder="Landlord phone" inputMode="tel" value={landlordPhone} onChange={(e) => setLandlordPhone(e.target.value)} autoFocus className="h-12" />
      ),
    },
    // 9 — Property address
    {
      key: 'propertyAddress',
      icon: MapPin,
      stepLabel: 'Landlord details',
      title: 'Where is the property?',
      subtitle: 'Enter the full property address.',
      valid: !!propertyAddress.trim(),
      node: (
        <Input placeholder="Property address" value={propertyAddress} onChange={(e) => setPropertyAddress(e.target.value)} autoFocus className="h-12" />
      ),
    },
    // 10 — Landlord extras (optional)
    {
      key: 'landlordExtra',
      icon: Gauge,
      stepLabel: 'Landlord details',
      title: 'Landlord TIN & property meters',
      subtitle: 'Optional — add what you know and continue.',
      valid: true,
      node: (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Landlord TIN (Tax Identification Number)</Label>
            <Input placeholder="Landlord's TIN" value={landlordTin} onChange={(e) => setLandlordTin(e.target.value)} className="h-12" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">NWSC Water Meter Number</Label>
            <Input placeholder="National Water & Sewerage Corp" value={waterMeterNumber} onChange={(e) => setWaterMeterNumber(e.target.value)} className="h-12" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">UEDCL/UMEME Electricity Meter</Label>
            <Input placeholder="Uganda Electricity Distribution" value={electricityMeterNumber} onChange={(e) => setElectricityMeterNumber(e.target.value)} className="h-12" />
          </div>
        </div>
      ),
    },
    // 11 — Property GPS (optional)
    {
      key: 'gps',
      icon: Navigation,
      stepLabel: 'Property location',
      title: 'Capture the property GPS',
      subtitle: 'Optional but helps verify the home faster.',
      valid: true,
      node: propertyGps ? (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-success/10 border border-success/30">
          <Navigation className="h-4 w-4 text-success flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-success">📍 GPS Captured</p>
            <p className="text-[10px] text-muted-foreground truncate">
              {propertyGps.lat.toFixed(5)}, {propertyGps.lng.toFixed(5)} (±{Math.round(propertyGps.accuracy)}m)
            </p>
          </div>
          <Button type="button" size="sm" variant="ghost" className="text-xs h-8 px-2" onClick={capturePropertyGPS}>Retake</Button>
        </div>
      ) : (
        <Button type="button" variant="outline" className="w-full h-12 gap-2 border-dashed" onClick={capturePropertyGPS} disabled={gpsLoading}>
          {gpsLoading ? (<><Loader2 className="h-4 w-4 animate-spin" /> Getting GPS...</>) : (<><Navigation className="h-4 w-4" /> Capture Property GPS</>)}
        </Button>
      ),
    },
    // 12 — House photos (optional)
    {
      key: 'photos',
      icon: Camera,
      stepLabel: 'Property photos',
      title: 'Add photos of the house',
      subtitle: 'Optional — up to 3 photos.',
      valid: true,
      node: (
        <div className="grid grid-cols-3 gap-2">
          {housePhotos.map((photo, idx) => (
            <div key={idx} className="relative aspect-square rounded-lg overflow-hidden border border-border">
              <img src={photo.preview} alt={`House ${idx + 1}`} className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => removePhoto(idx)}
                className="absolute top-1 right-1 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-xs font-bold"
              >✕</button>
            </div>
          ))}
          {housePhotos.length < 3 && (
            <label className="aspect-square rounded-lg border-2 border-dashed border-muted-foreground/30 flex flex-col items-center justify-center cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-colors">
              <span className="text-xl text-muted-foreground/50">📷</span>
              <span className="text-[10px] text-muted-foreground/50 mt-1">Add Photo</span>
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhotoAdd} />
            </label>
          )}
        </div>
      ),
    },
    // 13 — LC1 chairperson
    {
      key: 'lc1',
      icon: Users,
      stepLabel: 'LC1 chairperson',
      title: 'Who is your LC1 chairperson?',
      subtitle: 'Provide their name, phone and village.',
      valid: !!lc1Name.trim() && !!lc1Phone.trim() && !!lc1Village.trim(),
      node: (
        <div className="space-y-3">
          <Input placeholder="LC1 name" value={lc1Name} onChange={(e) => setLc1Name(e.target.value)} autoFocus className="h-12" />
          <Input placeholder="LC1 phone" inputMode="tel" value={lc1Phone} onChange={(e) => setLc1Phone(e.target.value)} className="h-12" />
          <Lc1VillagePicker label="Village" value={lc1Village} onChange={(name) => setLc1Village(name)} />
        </div>
      ),
    },
    // 14 — Review & submit
    {
      key: 'review',
      icon: CheckCircle2,
      stepLabel: 'Review',
      title: 'Review and submit',
      subtitle: 'Check the details below, then post your request.',
      valid: !!calc,
      node: (
        <div className="space-y-2 text-sm">
          {calc && (
            <div className="p-3 rounded-xl bg-primary/10 border border-primary/30 space-y-1.5">
              <div className="flex justify-between"><span className="text-muted-foreground">Rent</span><span className="font-mono font-semibold">{formatUGX(calc.rentAmount)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Pay per day</span><span className="font-mono font-semibold">{formatUGX(calc.dailyRepayment)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">For</span><span className="font-semibold">{calc.durationDays} days · {numberOfPayments} payment{numberOfPayments > 1 ? 's' : ''}</span></div>
            </div>
          )}
          <div className="p-3 rounded-xl bg-muted/40 border space-y-1.5">
            <div className="flex justify-between"><span className="text-muted-foreground">You</span><span className="font-medium text-right">{tenantFullName || '—'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Landlord</span><span className="font-medium text-right">{landlordName || '—'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Property</span><span className="font-medium text-right truncate max-w-[60%]">{propertyAddress || '—'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">LC1</span><span className="font-medium text-right">{lc1Name || '—'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">GPS</span><span className="font-medium">{propertyGps ? '✓ captured' : 'not set'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Photos</span><span className="font-medium">{housePhotos.length}/3</span></div>
          </div>
        </div>
      ),
    },
  ];

  const totalSteps = steps.length;
  const current = steps[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === totalSteps - 1;
  const progress = ((stepIndex + 1) / totalSteps) * 100;

  // "Unfinished draft" = the tenant has entered something but hasn't posted.
  const hasUnfinishedDraft = useMemo(() => {
    if (submittedRef.current) return false;
    return !!(
      rentAmount.trim() || tenantNationalId.trim() || tenantFullName.trim() ||
      tenantWaterMeter.trim() || tenantElectricityMeter.trim() ||
      landlordName.trim() || landlordPhone.trim() || landlordNationalId.trim() ||
      landlordTin.trim() || propertyAddress.trim() || waterMeterNumber.trim() ||
      electricityMeterNumber.trim() || lc1Name.trim() || lc1Phone.trim() ||
      lc1Village.trim() || propertyGps || housePhotos.length > 0 || stepIndex > 0
    );
  }, [
    rentAmount, tenantNationalId, tenantFullName, tenantWaterMeter, tenantElectricityMeter,
    landlordName, landlordPhone, landlordNationalId, landlordTin, propertyAddress,
    waterMeterNumber, electricityMeterNumber, lc1Name, lc1Phone, lc1Village,
    propertyGps, housePhotos.length, stepIndex,
  ]);

  // Prompt on hardware/browser back when there's an unfinished draft.
  useUnsavedChangesGuard(hasUnfinishedDraft);

  const LEAVE_MESSAGE =
    'You have an unfinished rent request. Leave the wizard? Your answers are saved and you can continue later.';

  const goNext = () => {
    if (!current.valid) {
      toast({ title: 'Please complete this step', description: nationalIdError || 'Fill in the required field to continue.', variant: 'destructive' });
      return;
    }
    setStepIndex((i) => Math.min(i + 1, totalSteps - 1));
  };

  const goBack = () => {
    if (isFirst) {
      if (hasUnfinishedDraft && !window.confirm(LEAVE_MESSAGE)) return;
      onCancel();
      return;
    }
    setStepIndex((i) => Math.max(i - 1, 0));
  };

  return (
    <Card className="glass-card">
      <AlertDialog open={showRestorePrompt}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Continue your rent request?</AlertDialogTitle>
            <AlertDialogDescription>
              We found an unfinished rent request you saved earlier. Restore your
              answers and pick up where you left off, or start fresh.
              {restored?.stepIndex ? ` You were on question ${(restored.stepIndex ?? 0) + 1}.` : ''}
              {' '}Photos aren't saved and will need re-adding.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={startFresh}>Start fresh</AlertDialogCancel>
            <AlertDialogAction onClick={applyDraft}>Restore draft</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CardHeader className="bg-primary/10 border-b-2 border-primary/30 space-y-3">
        <CardTitle className="flex items-center gap-2 text-primary">
          <FileText className="h-5 w-5" />
          Rent Request
        </CardTitle>
        <div className="space-y-1.5">
          <Progress value={progress} className="h-1.5" />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-medium text-muted-foreground">
              Question {stepIndex + 1} of {totalSteps}
            </p>
            {draftSaved && (
              <span className="text-[11px] font-medium text-success flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Draft saved
              </span>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-5">
        {draftRestored && (
          <div className="mb-4 rounded-xl border border-primary/30 bg-primary/10 p-3 flex items-start justify-between gap-3">
            <div className="text-xs">
              <p className="font-semibold text-primary">We saved your progress</p>
              <p className="text-muted-foreground">
                Continue where you left off, or start a fresh request. Photos aren't saved and need re-adding.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={discardDraft}
              disabled={loading}
              className="shrink-0"
            >
              Start over
            </Button>
          </div>
        )}
        <form
          onSubmit={handleSubmit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isLast) {
              e.preventDefault();
              goNext();
            }
          }}
          className="space-y-6"
        >
          <div key={current.key} className="animate-fade-in space-y-5">
            <FormStepHeader
              icon={current.icon}
              title={current.title}
              subtitle={current.subtitle}
              stepLabel={current.stepLabel}
            />
            {current.node}
          </div>

          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" onClick={goBack} disabled={loading} className="gap-1">
              <ArrowLeft className="h-4 w-4" />
              {isFirst ? 'Cancel' : 'Back'}
            </Button>
            {isLast ? (
              <Button type="submit" disabled={loading || !calc} className="flex-1 gap-1">
                {loading ? (<><Loader2 className="h-4 w-4 animate-spin" /> Submitting...</>) : 'Submit Request'}
              </Button>
            ) : (
              <Button type="button" onClick={goNext} disabled={loading} className="flex-1 gap-1">
                Continue
                <ArrowRight className="h-4 w-4" />
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
