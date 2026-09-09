import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Lc1VillagePicker } from '@/components/location/Lc1VillagePicker';
import { roleToSlug } from '@/lib/roleRoutes';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { GuarantorConsentCheckbox } from '@/components/agent/GuarantorConsentCheckbox';
import { calculateRentRepayment, formatUGX } from '@/lib/rentCalculations';
import { addDays, format } from 'date-fns';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { toast } from 'sonner';
import {
  UserPlus, CheckCircle2, AlertCircle, Phone, User, Home, Banknote,
  Loader2, Navigation, Camera, X, MapPin, Calendar, Calculator, Building2, Users
} from 'lucide-react';

type IncomeType = 'daily' | 'weekly-monthly';
type RepaymentPeriod = '7' | '14' | '21' | '30' | '120';

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

function AgentFooter({ agentInfo }: { agentInfo: { name: string; phone: string } | null }) {
  if (!agentInfo) return null;
  return (
    <div className="mt-6 pt-4 border-t border-border/40 text-center space-y-1">
      <p className="text-xs text-muted-foreground">This form was shared by:</p>
      <p className="text-sm font-semibold">{agentInfo.name}</p>
      {agentInfo.phone && <p className="text-xs text-muted-foreground">{agentInfo.phone}</p>}
    </div>
  );
}

function Branding() {
  return (
    <div className="text-center pt-4">
      <p className="text-xs text-muted-foreground">Powered by <span className="font-semibold text-primary">Welile</span></p>
    </div>
  );
}

export default function RegisterTenantPublic() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const agentId = searchParams.get('agent');
  const token = searchParams.get('token');

  const [agentInfo, setAgentInfo] = useState<{ name: string; phone: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step: 'income' | 'form'
  const [step, setStep] = useState<'income' | 'form'>('income');
  const [incomeType, setIncomeType] = useState<IncomeType | null>(null);

  // Form fields
  const [rentAmount, setRentAmount] = useState('');
  const [duration, setDuration] = useState<'30' | '60' | '90'>('30');
  const [repaymentPeriod, setRepaymentPeriod] = useState<RepaymentPeriod>('7');
  const [tenantNameParts, setTenantNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const fullName = joinPersonName(tenantNameParts);
  const [phone, setPhone] = useState('');
  const [noSmartphone, setNoSmartphone] = useState(false);
  const [smartphoneAnswer, setSmartphoneAnswer] = useState<'YES' | 'NO' | 'UNKNOWN' | null>(null);
  const [houseCategory, setHouseCategory] = useState('');
  const [landlordNameParts, setLandlordNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const landlordName = joinPersonName(landlordNameParts);
  const [landlordPhone, setLandlordPhone] = useState('');
  const [propertyAddress, setPropertyAddress] = useState('');
  const [gpsLocation, setGpsLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [housePhotos, setHousePhotos] = useState<{ file: File; preview: string }[]>([]);
  const [lc1NameParts, setLc1NameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const lc1Name = joinPersonName(lc1NameParts);
  const [shownInsight, setShownInsight] = useState(false);
  const [insightVisible, setInsightVisible] = useState(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showRentInsight = useCallback((amount: string) => {
    const num = parseFloat(amount);
    if (!shownInsight && num > 0) {
      setInsightVisible(true);
      setShownInsight(true);
    }
  }, [shownInsight]);

  const handleRentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setRentAmount(val);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => showRentInsight(val), 1000);
  };

  const handleRentBlur = () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    showRentInsight(rentAmount);
  };
  const [lc1Phone, setLc1Phone] = useState('');
  const [lc1Village, setLc1Village] = useState('');
  const [guarantorConsent, setGuarantorConsent] = useState(false);

  useEffect(() => {
    async function fetchAgent() {
      if (!agentId || !token) { setError('Invalid link — missing agent or token.'); setLoading(false); return; }
      try {
        const { data: profile } = await supabase
          .from('profiles').select('full_name, phone').eq('id', agentId).maybeSingle();
        if (profile) setAgentInfo({ name: profile.full_name || 'Welile Agent', phone: profile.phone || '' });
      } catch {}
      setLoading(false);
    }
    fetchAgent();
  }, [agentId, token]);

  const captureGPS = useCallback(() => {
    if (!navigator.geolocation) return;
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setGpsLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setGpsLoading(false); },
      () => { setGpsLoading(false); },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  }, []);

  const handlePhotoAdd = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const remaining = 3 - housePhotos.length;
    if (remaining <= 0) return;
    const toAdd = files.slice(0, remaining);
    setHousePhotos(prev => [...prev, ...toAdd.map(f => ({ file: f, preview: URL.createObjectURL(f) }))]);
    if (e.target) e.target.value = '';
  }, [housePhotos.length]);

  const removePhoto = useCallback((index: number) => {
    setHousePhotos(prev => { URL.revokeObjectURL(prev[index].preview); return prev.filter((_, i) => i !== index); });
  }, []);

  const amount = parseInt(rentAmount.replace(/,/g, '')) || 0;

  const fees = useMemo(() => {
    if (!amount || !incomeType) return null;
    if (incomeType === 'daily') {
      return calculateRentRepayment(amount, parseInt(duration) as 30 | 60 | 90);
    } else {
      const DAILY_ACCESS_FEE_RATE = 0.011;
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
  }, [amount, incomeType, duration, repaymentPeriod]);

  const canSubmit = !!(
    validatePersonNameParts(tenantNameParts).valid && phone.trim() && amount > 0 && houseCategory &&
    landlordPhone.trim() && propertyAddress.trim() &&
    validatePersonNameParts(landlordNameParts).valid && lc1Phone.trim() &&
    validatePersonNameParts(lc1NameParts).valid && lc1Village.trim() && guarantorConsent
  );

  const fileToBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentId || !token || !canSubmit || !fees) return;
    const tenantNameCheck = validatePersonNameParts(tenantNameParts);
    const landlordNameCheck = validatePersonNameParts(landlordNameParts);
    const lc1NameCheck = validatePersonNameParts(lc1NameParts);
    if (!tenantNameCheck.valid) { toast.error(`Tenant name: ${tenantNameCheck.error}`); return; }
    if (!landlordNameCheck.valid) { toast.error(`Landlord name: ${landlordNameCheck.error}`); return; }
    if (!lc1NameCheck.valid) { toast.error(`LC1 chairperson name: ${lc1NameCheck.error}`); return; }
    setSubmitting(true);
    setError(null);

    try {
      const photosBase64 = await Promise.all(housePhotos.map(p => fileToBase64(p.file)));

      const { data, error: fnError } = await supabase.functions.invoke('submit-tenant-form', {
        body: {
          token,
          agent_id: agentId,
          full_name: tenantNameCheck.fullName,
          phone,
          income_type: incomeType,
          rent_amount: fees.rentAmount,
          duration_days: fees.durationDays,
          access_fee: fees.accessFee,
          request_fee: fees.requestFee,
          total_repayment: fees.totalRepayment,
          daily_repayment: fees.dailyRepayment,
          no_smartphone: noSmartphone,
          smartphone_answer: smartphoneAnswer || undefined,
          house_category: houseCategory,
          landlord_name: landlordNameCheck.fullName,
          landlord_phone: landlordPhone,
          property_address: propertyAddress,
          gps_lat: gpsLocation?.lat ?? null,
          gps_lng: gpsLocation?.lng ?? null,
          lc1_name: lc1NameCheck.fullName,
          lc1_phone: lc1Phone,
          lc1_village: lc1Village,
          house_photos: photosBase64,
        },
      });

      if (fnError) throw new Error(fnError.message);
      if (data?.error) throw new Error(data.error);
      // Auto sign-in: backend returns temp credentials for newly-created tenants.
      // Existing users skip sign-in (we don't have their password) — they just see the success screen.
      if (data?.auth_email && data?.auth_password) {
        try {
          // Sign out any pre-existing session so the new tenant lands cleanly.
          await supabase.auth.signOut();
          const { error: signInErr } = await supabase.auth.signInWithPassword({
            email: data.auth_email,
            password: data.auth_password,
          });
          if (signInErr) {
            console.warn('[RegisterTenantPublic] Auto sign-in failed:', signInErr.message);
            setSubmitted(true);
            return;
          }
          // Persistent session is configured at the client level (localStorage + autoRefresh),
          // so the user stays signed in across browser restarts until they explicitly sign out.
          navigate('/dashboard/tenant', { replace: true });
          return;
        } catch (signInErr) {
          console.warn('[RegisterTenantPublic] Auto sign-in threw:', signInErr);
        }
      }
      setSubmitted(true);
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!agentId || !token) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background px-4">
        <div className="text-center space-y-3">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto" />
          <h1 className="text-xl font-bold">Invalid Link</h1>
          <p className="text-muted-foreground text-sm">This registration link is invalid or has expired.</p>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background px-4">
        <div className="text-center space-y-4 max-w-sm">
          <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
            <CheckCircle2 className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold">Request Submitted!</h1>
          <p className="text-muted-foreground text-sm">
            Your rent request has been received. {agentInfo?.name ? `${agentInfo.name} will` : 'Your agent will'} follow up with you shortly.
          </p>
          <Branding />
        </div>
      </div>
    );
  }

  // Step 1: Income Type Selection
  if (step === 'income') {
    return (
      <div className="min-h-[100dvh] bg-background">
        <div className="bg-primary text-primary-foreground px-4 py-6 text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <UserPlus className="h-6 w-6" />
            <h1 className="text-xl font-bold">Tenant Registration</h1>
          </div>
          <p className="text-sm opacity-90">Select your income type to get started</p>
        </div>

        <div className="max-w-md mx-auto px-4 py-8 space-y-4">
          <p className="text-sm text-muted-foreground text-center">How do you earn?</p>

          <button
            onClick={() => { setIncomeType('daily'); setStep('form'); }}
            className="w-full p-4 rounded-xl border-2 border-border hover:border-primary/60 text-left transition-all"
          >
            <div className="flex items-center gap-3">
              <span className="text-2xl">☀️</span>
              <div>
                <p className="font-semibold">Daily Income Earner</p>
                <p className="text-xs text-muted-foreground">Market vendors, boda riders, casual workers</p>
              </div>
            </div>
          </button>

          <button
            onClick={() => { setIncomeType('weekly-monthly'); setStep('form'); }}
            className="w-full p-4 rounded-xl border-2 border-border hover:border-primary/60 text-left transition-all"
          >
            <div className="flex items-center gap-3">
              <span className="text-2xl">📅</span>
              <div>
                <p className="font-semibold">Weekly / Monthly Earner</p>
                <p className="text-xs text-muted-foreground">Salaried, weekly wage, small business</p>
              </div>
            </div>
          </button>

          <AgentFooter agentInfo={agentInfo} />
          <Branding />
        </div>
      </div>
    );
  }

  // Step 2: Full form
  const getPeriodLabel = (p: RepaymentPeriod) => {
    switch (p) {
      case '7': return '7 Days (1 Week)';
      case '14': return '14 Days (2 Weeks)';
      case '21': return '21 Days (3 Weeks)';
      case '30': return '30 Days (1 Month)';
      case '120': return '120 Days (4 Months)';
    }
  };

  return (
    <div className="min-h-[100dvh] bg-background">
      {/* Sticky header + section tabs */}
      <div className="sticky top-0 z-30 bg-primary text-primary-foreground shadow-md">
        <div className="px-4 py-3 text-center">
          <h1 className="text-base font-bold">Tenant Registration</h1>
          <p className="text-[11px] opacity-90">{incomeType === 'daily' ? '☀️ Daily Income' : '📅 Weekly/Monthly Income'}</p>
        </div>
        <nav className="flex gap-1 overflow-x-auto no-scrollbar px-3 pb-2">
          {[
            { id: 'sec-rent', label: '💰 Rent' },
            { id: 'sec-tenant', label: '👤 Tenant' },
            { id: 'sec-house', label: '🏠 House' },
            { id: 'sec-landlord', label: '🧑‍💼 Landlord' },
            { id: 'sec-property', label: '📍 Property' },
            { id: 'sec-lc1', label: '🛡️ LC1' },
            { id: 'sec-submit', label: '✅ Submit' },
          ].map(s => (
            <a
              key={s.id}
              href={`#${s.id}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              className="shrink-0 text-[11px] font-medium px-3 py-1.5 rounded-full bg-primary-foreground/10 hover:bg-primary-foreground/20 active:bg-primary-foreground/30 transition-colors whitespace-nowrap"
            >
              {s.label}
            </a>
          ))}
        </nav>
      </div>

      <form onSubmit={handleSubmit} className="max-w-md mx-auto px-4 py-5 space-y-6 pb-[calc(env(safe-area-inset-bottom,0px)+120px)]">
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
            <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* A. Rent Details */}
        <section id="sec-rent" className="space-y-3 scroll-mt-32">
          <h2 className="text-sm font-semibold flex items-center gap-1.5"><Banknote className="h-4 w-4" /> Rent Details</h2>
          <div className="space-y-2">
            <Label>How much is your rent amount? <span className="text-destructive">*</span></Label>
            <Input type="number" value={rentAmount} onChange={handleRentChange} onBlur={handleRentBlur} placeholder="e.g. 350000" min="0" required />
            {insightVisible && parseFloat(rentAmount) > 0 && (
              <div className="relative mt-2 rounded-lg border border-primary/30 bg-primary/5 p-3 animate-in slide-in-from-top-2 fade-in duration-300">
                <button
                  type="button"
                  onClick={() => setInsightVisible(false)}
                  className="absolute top-2 right-2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
                <p className="text-sm font-semibold text-primary mb-1">💡 Did You Know?</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  If your monthly rent is <span className="font-bold text-foreground">UGX {parseFloat(rentAmount).toLocaleString()}</span>,
                  you are committing up to:
                </p>
                <p className="text-base font-bold text-foreground mt-1">
                  👉 UGX {(parseFloat(rentAmount) * 12).toLocaleString()} per year
                </p>
                <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                  That's over <span className="font-semibold text-foreground">{(parseFloat(rentAmount) * 12 / 1000000).toFixed(1)} Million UGX</span> yearly.
                  We help you spread this into manageable payments based on your income.
                </p>
              </div>
            )}
          </div>
          {incomeType === 'daily' ? (
            <div className="space-y-2">
              <Label>Duration</Label>
              <Select value={duration} onValueChange={(v) => setDuration(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">30 Days</SelectItem>
                  <SelectItem value="60">60 Days</SelectItem>
                  <SelectItem value="90">90 Days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="space-y-2">
              <Label>Repayment Period</Label>
              <Select value={repaymentPeriod} onValueChange={(v) => setRepaymentPeriod(v as RepaymentPeriod)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(['7','14','21','30','120'] as RepaymentPeriod[]).map(p => (
                    <SelectItem key={p} value={p}>{getPeriodLabel(p)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {fees && (
            <div className="p-3 rounded-xl bg-primary/5 border border-primary/20 space-y-1 text-xs">
              <div className="flex justify-between"><span className="text-muted-foreground">Rent Amount</span><span className="font-medium">{formatUGX(fees.rentAmount)}</span></div>
              <div className="flex justify-between text-primary font-semibold"><span>Daily Amount</span><span>{formatUGX(fees.dailyRepayment)}/day</span></div>
              <p className="text-muted-foreground pt-1">Starts: {format(addDays(new Date(), 1), 'MMM d, yyyy')}</p>
            </div>
          )}
        </section>

        {/* B. Tenant Details */}
        <section id="sec-tenant" className="space-y-3 scroll-mt-32">
          <h2 className="text-sm font-semibold flex items-center gap-1.5"><User className="h-4 w-4" /> Tenant Details</h2>
          <div className="space-y-2 p-3 rounded-xl bg-muted/40 border border-border/50">
            <Label className="text-xs font-semibold text-foreground">
              Does this tenant have access to a smartphone?
            </Label>
            <div className="space-y-1.5 pt-1">
              {[
                { value: 'YES' as const, label: 'Yes' },
                { value: 'NO' as const, label: 'No' },
                { value: 'UNKNOWN' as const, label: 'Unknown / Not sure' },
              ].map((opt) => (
                <label
                  key={opt.value}
                  className={cn(
                    'flex items-center gap-2.5 p-2 rounded-lg cursor-pointer transition-colors border text-xs',
                    smartphoneAnswer === opt.value
                      ? 'border-primary bg-primary/10 text-foreground font-medium'
                      : 'border-border/40 hover:bg-muted/60 text-muted-foreground',
                  )}
                >
                  <input
                    type="radio"
                    name="smartphone_access"
                    value={opt.value}
                    checked={smartphoneAnswer === opt.value}
                    onChange={() => {
                      setSmartphoneAnswer(opt.value);
                      setNoSmartphone(opt.value === 'NO');
                    }}
                    className="h-3.5 w-3.5 text-primary accent-primary"
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>
          <PersonNameFields idPrefix="tenant-public" value={tenantNameParts} onChange={setTenantNameParts} />
          <div className="space-y-2">
            <Label>Phone Number <span className="text-destructive">*</span></Label>
            <Input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="e.g. 0770 123 456" required />
          </div>
        </section>

        {/* C. House Category */}
        <section id="sec-house" className="space-y-3 scroll-mt-32">
          <h2 className="text-sm font-semibold flex items-center gap-1.5"><Building2 className="h-4 w-4" /> House Category</h2>
          <Select value={houseCategory} onValueChange={setHouseCategory}>
            <SelectTrigger><SelectValue placeholder="Select house type" /></SelectTrigger>
            <SelectContent>
              {HOUSE_CATEGORIES.map(cat => (
                <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>

        {/* D. Landlord Details */}
        <section id="sec-landlord" className="space-y-3 scroll-mt-32">
          <h2 className="text-sm font-semibold flex items-center gap-1.5"><Home className="h-4 w-4" /> Landlord Details</h2>
          <PersonNameFields idPrefix="tenant-public-landlord" value={landlordNameParts} onChange={setLandlordNameParts} />
          <div className="space-y-2">
            <Label>Landlord Phone <span className="text-destructive">*</span></Label>
            <Input type="tel" value={landlordPhone} onChange={e => setLandlordPhone(e.target.value)} placeholder="e.g. 0700 000 000" required />
          </div>
        </section>

        {/* E. Property Details */}
        <section id="sec-property" className="space-y-3 scroll-mt-32">
          <h2 className="text-sm font-semibold flex items-center gap-1.5"><MapPin className="h-4 w-4" /> Property Details</h2>
          <div className="space-y-2">
            <Label>Property Address <span className="text-destructive">*</span></Label>
            <Input value={propertyAddress} onChange={e => setPropertyAddress(e.target.value)} placeholder="e.g. Plot 12, Bukoto Street" required />
          </div>
          <Button type="button" variant="outline" size="sm" onClick={captureGPS} disabled={gpsLoading} className="gap-1.5">
            {gpsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Navigation className="h-3.5 w-3.5" />}
            {gpsLocation ? '📍 GPS Captured' : 'Capture GPS Location'}
          </Button>
          {gpsLocation && <p className="text-xs text-muted-foreground">Lat: {gpsLocation.lat.toFixed(5)}, Lng: {gpsLocation.lng.toFixed(5)}</p>}

          {/* House Photos */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5"><Camera className="h-3.5 w-3.5" /> House Photos (max 3)</Label>
            <div className="flex gap-2 flex-wrap">
              {housePhotos.map((p, i) => (
                <div key={i} className="relative w-20 h-20 rounded-lg overflow-hidden border">
                  <img src={p.preview} alt="" className="w-full h-full object-cover" />
                  <button type="button" onClick={() => removePhoto(i)} className="absolute top-0.5 right-0.5 bg-black/60 rounded-full p-0.5">
                    <X className="h-3 w-3 text-white" />
                  </button>
                </div>
              ))}
              {housePhotos.length < 3 && (
                <label className="w-20 h-20 rounded-lg border-2 border-dashed border-border flex items-center justify-center cursor-pointer hover:border-primary/40 transition-colors">
                  <Camera className="h-5 w-5 text-muted-foreground" />
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhotoAdd} />
                </label>
              )}
            </div>
          </div>
        </section>

        {/* F. LC1 Chairperson */}
        <section id="sec-lc1" className="space-y-3 scroll-mt-32">
          <h2 className="text-sm font-semibold flex items-center gap-1.5"><Users className="h-4 w-4" /> LC1 Chairperson</h2>
          <PersonNameFields idPrefix="tenant-public-lc1" value={lc1NameParts} onChange={setLc1NameParts} />
          <div className="space-y-2">
            <Label>Phone <span className="text-destructive">*</span></Label>
            <Input type="tel" value={lc1Phone} onChange={e => setLc1Phone(e.target.value)} placeholder="e.g. 0700 000 000" required />
          </div>
          <Lc1VillagePicker
            className="space-y-2"
            label="Village"
            required
            value={lc1Village}
            onChange={(name) => setLc1Village(name)}
          />
        </section>

        {/* G. Guarantor Consent */}
        <section id="sec-submit" className="scroll-mt-32">
          <GuarantorConsentCheckbox checked={guarantorConsent} onCheckedChange={setGuarantorConsent} />
        </section>

        <button type="button" onClick={() => setStep('income')} className="w-full text-xs text-muted-foreground underline">
          ← Change income type
        </button>

        <AgentFooter agentInfo={agentInfo} />
        <Branding />
      </form>

      {/* Sticky submit footer */}
      <div className="fixed bottom-0 inset-x-0 z-30 border-t bg-background/95 backdrop-blur px-4 py-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
        <div className="max-w-md mx-auto">
          {!canSubmit && !submitting && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400 text-center mb-2">
              Fill all required fields and accept guarantor consent to submit
            </p>
          )}
          <Button
            type="button"
            onClick={() => {
              const form = document.querySelector('form');
              if (form) form.requestSubmit();
            }}
            className="w-full h-12 text-base font-semibold shadow-lg"
            size="lg"
            disabled={submitting || !canSubmit}
          >
            {submitting ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Submitting...</>
            ) : (
              <><UserPlus className="h-4 w-4 mr-2" /> Submit Rent Request</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
