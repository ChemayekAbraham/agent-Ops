/**
 * Tenant self-onboarding (`/tenants-onboarding`).
 *
 * A tenant posts their own rent request — no agent, no service centre, and no
 * eligibility gate (the tenant is new). Everything captured here is real:
 *  - National ID and phone are checked against stored records (existence only,
 *    never whose they are)
 *  - the address comes from the official Uganda village dataset
 *  - the landlord and LC1 chairperson are matched against real records first
 *  - the repayment figures come from the shared canonical rent formula, and the
 *    database recomputes them again on insert
 *
 * Submission goes through the `tenant-self-onboarding` edge function, which
 * posts ONE `rent_requests` row at `pending` into the normal pipeline.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Camera, Check, CircleDollarSign, Home, Loader2, MapPin,
  ShieldCheck, User, Wallet, CalendarDays, Info, Building2, CheckCircle2, AlertTriangle,
  ChevronDown, HelpCircle, Mail, Phone, Clock, X, UserPlus, ShieldQuestion,
} from 'lucide-react';
import { toast } from 'sonner';

import welileLogo from '@/assets/welile-logo.png';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useCaptureLocation } from '@/hooks/useCaptureLocation';
import { optimizeImage } from '@/lib/imageOptimizer';
import { calculateRentRepayment, formatUGX } from '@/lib/rentCalculations';
import { validateUgandaPhone } from '@/lib/ugandaPhone';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PhoneInput } from '@/components/ui/phone-input';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import type { UgLocationSelection } from '@/hooks/useUgLocations';
import { LandlordSearchSelect, type LandlordOption } from '@/components/agent/LandlordSearchSelect';
import { Lc1ChairpersonPicker, type Lc1Selection } from '@/components/agent/Lc1ChairpersonPicker';

type EarnerType = 'daily' | 'weekly';

const STEPS = [
  { n: 1, name: 'Income type', sub: 'Earning schedule', icon: Wallet },
  { n: 2, name: 'Your rent', sub: 'Amount & period', icon: CircleDollarSign },
  { n: 3, name: 'About you', sub: 'Identity & photo', icon: User },
  { n: 4, name: 'Your home', sub: 'Address & photos', icon: Home },
  { n: 5, name: 'Verification', sub: 'Landlord & LC1', icon: ShieldCheck },
  { n: 6, name: 'Review', sub: 'Confirm & submit', icon: Check },
] as const;

/** Shared by the step 1 chooser and the step 2 context banner, so the label the
 *  tenant picked is the label they keep seeing. */
const EARNERS = [
  {
    key: 'daily' as EarnerType,
    title: 'Daily income earner',
    sub: 'Boda, market, salon, shop — pay a small amount every day',
    banner: 'Pays back daily over 30-120 days',
    icon: Wallet,
  },
  {
    key: 'weekly' as EarnerType,
    title: 'Weekly earner',
    sub: 'Paid weekly — pay once a week',
    banner: 'Pays back once a week',
    icon: CalendarDays,
  },
] as const;

/** Welile support, shown behind the header Help button. */
const SUPPORT_EMAIL = 'info@welile.com';
const SUPPORT_PHONE_DISPLAY = '+256 777 607640';
const SUPPORT_PHONE_DIAL = '+256777607640';

const HOUSE_TYPES = [
  { value: 'single-room', label: 'Single room' },
  { value: 'double-room', label: 'Double room' },
  { value: 'self-contained', label: 'Self-contained' },
  { value: '1-bedroom', label: '1-bed flat' },
  { value: '2-bedroom', label: '2-bed flat' },
  { value: 'other', label: 'Other' },
];

const LANGUAGES = ['English', 'Luganda', 'Runyankole', 'Lusoga', 'Acholi', 'Lugbara', 'Other'];

const DAILY_PERIODS = [30, 60, 90, 120];
const WEEKLY_PERIODS = [28, 56, 84, 112];

const MIN_RENT = 50000;
const MAX_RENT = 10000000;

const cleanNin = (v: string) => v.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

interface PhotoSlot { file: File; preview: string }

async function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read the photo'));
    r.readAsDataURL(file);
  });
}

export default function TenantsOnboarding() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const routeLocation = useLocation();
  // Where the visitor should land again once they have an account. Keeps any
  // query/hash they arrived with (e.g. a shared link carrying a village).
  const returnTo = `${routeLocation.pathname}${routeLocation.search}${routeLocation.hash}`;
  const authHref = (signup: boolean) =>
    `/auth?redirect=${encodeURIComponent(returnTo)}${signup ? '&signup=1' : ''}`;

  // Social sign-in loses the ?redirect during the provider round-trip; Auth
  // recovers the intended path from this key.
  useEffect(() => {
    if (authLoading || user) return;
    try { sessionStorage.setItem('welile_post_auth_redirect', returnTo); } catch { /* ignore */ }
  }, [authLoading, user, returnTo]);

  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ id: string } | null>(null);

  /* Step 1 */
  const [earner, setEarner] = useState<EarnerType>('daily');

  /* Step 2 */
  const [rentInput, setRentInput] = useState('');
  const [durationDays, setDurationDays] = useState(30);
  const [feeOpen, setFeeOpen] = useState(false);

  /* Step 3 */
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [nin, setNin] = useState('');
  const [occupation, setOccupation] = useState('');
  const [language, setLanguage] = useState('English');
  const [noSmartphone, setNoSmartphone] = useState(false);
  const [tenantPhoto, setTenantPhoto] = useState<PhotoSlot | null>(null);
  const [idPhoto, setIdPhoto] = useState<PhotoSlot | null>(null);
  const [lcLetter, setLcLetter] = useState<PhotoSlot | null>(null);
  const [idCheck, setIdCheck] = useState<{
    checking: boolean;
    phone_known?: boolean; phone_is_you?: boolean;
    nin_known?: boolean; nin_is_you?: boolean;
  }>({ checking: false });

  /* Step 4 */
  const [houseType, setHouseType] = useState('single-room');
  const [address, setAddress] = useState('');
  const [location, setLocation] = useState<UgLocationSelection | null>(null);
  const [housePhotos, setHousePhotos] = useState<PhotoSlot[]>([]);
  const { location: gps, loading: gpsLoading, error: gpsError, captureLocation } = useCaptureLocation();

  /* Draft autosave — see the DRAFT_* helpers below. Photos are deliberately
     excluded: they are large blobs and localStorage would blow its quota. */
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [helpOpen, setHelpOpen] = useState(false);
  const [addLandlordOpen, setAddLandlordOpen] = useState(false);

  /* Step 5 */
  const [landlord, setLandlord] = useState<LandlordOption | null>(null);
  const [newLandlordName, setNewLandlordName] = useState('');
  const [newLandlordPhone, setNewLandlordPhone] = useState('');
  const [lc1, setLc1] = useState<Lc1Selection | null>(null);
  const [note, setNote] = useState('');

  /* ---------------------------------------------------------- draft save ---
     The form is six steps long and is filled on a phone, often on a bad
     connection. Persist the typed answers so a dropped tab does not cost the
     tenant everything. Photos and GPS are not persisted — they are re-captured.
     The header pill reports this honestly: it only says "Saved" once a write
     has actually succeeded. */
  const draftKey = user ? `welile_tenant_onboarding_draft_${user.id}` : null;

  useEffect(() => {
    if (!draftKey) return;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const d = JSON.parse(raw) as Record<string, unknown>;
      if (typeof d.earner === 'string') setEarner(d.earner as EarnerType);
      if (typeof d.rentInput === 'string') setRentInput(d.rentInput);
      if (typeof d.durationDays === 'number') setDurationDays(d.durationDays);
      if (typeof d.firstName === 'string') setFirstName(d.firstName);
      if (typeof d.lastName === 'string') setLastName(d.lastName);
      if (typeof d.phone === 'string') setPhone(d.phone);
      if (typeof d.nin === 'string') setNin(d.nin);
      if (typeof d.occupation === 'string') setOccupation(d.occupation);
      if (typeof d.language === 'string') setLanguage(d.language);
      if (typeof d.noSmartphone === 'boolean') setNoSmartphone(d.noSmartphone);
      if (typeof d.houseType === 'string') setHouseType(d.houseType);
      if (typeof d.address === 'string') setAddress(d.address);
      if (typeof d.newLandlordName === 'string') setNewLandlordName(d.newLandlordName);
      if (typeof d.newLandlordPhone === 'string') setNewLandlordPhone(d.newLandlordPhone);
      if (typeof d.note === 'string') setNote(d.note);
      setSaveState('saved');
    } catch { /* a corrupt or unavailable draft is not worth failing over */ }
    // Restore once per user, on mount.
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey || submitted) return;
    setSaveState('saving');
    const t = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({
          earner, rentInput, durationDays, firstName, lastName, phone, nin,
          occupation, language, noSmartphone, houseType, address,
          newLandlordName, newLandlordPhone, note,
        }));
        setSaveState('saved');
      } catch {
        /* Quota or private mode: say nothing rather than claim a save. */
        setSaveState('idle');
      }
    }, 600);
    return () => clearTimeout(t);
  }, [draftKey, submitted, earner, rentInput, durationDays, firstName, lastName,
      phone, nin, occupation, language, noSmartphone, houseType, address,
      newLandlordName, newLandlordPhone, note]);

  const rentAmount = Number(rentInput.replace(/\D/g, '')) || 0;
  const calc = useMemo(
    () => (rentAmount >= MIN_RENT ? calculateRentRepayment(rentAmount, durationDays) : null),
    [rentAmount, durationDays],
  );
  /* A landlord the tenant typed in themselves. Held locally and created by the
     submit RPC — inserting on "Save" would leave orphan landlord rows behind
     every abandoned form. Either way they reach the landlord vetting pipeline. */
  const newLandlordReady =
    newLandlordName.trim().length >= 2 && validateUgandaPhone(newLandlordPhone).valid;
  const chosenLandlord = landlord
    ? { name: landlord.name, phone: landlord.phone, address: landlord.property_address, verified: !!landlord.verified, isNew: false }
    : newLandlordReady
      ? { name: newLandlordName.trim(), phone: newLandlordPhone, address: null, verified: false, isNew: true }
      : null;

  const activeEarner = EARNERS.find((e) => e.key === earner) ?? EARNERS[0];
  /* Only complain once they have typed something — an empty field is not an error yet. */
  const rentInvalid = rentAmount > 0 && (rentAmount < MIN_RENT || rentAmount > MAX_RENT);
  const periodLabel = earner === 'weekly' ? 'Weekly' : 'Daily';
  const perCycle = useMemo(() => {
    if (!calc) return 0;
    return earner === 'weekly' ? Math.ceil(calc.totalRepayment / (durationDays / 7)) : calc.dailyRepayment;
  }, [calc, earner, durationDays]);

  useEffect(() => {
    setDurationDays(earner === 'weekly' ? 28 : 30);
  }, [earner]);

  /* Prefill from the signed-in profile. */
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('full_name, phone, national_id, occupation, preferred_language')
        .eq('id', user.id).maybeSingle();
      if (cancelled || !data) return;
      const parts = String(data.full_name || '').trim().split(/\s+/);
      if (parts.length) {
        setFirstName((v) => v || parts[0] || '');
        setLastName((v) => v || parts.slice(1).join(' '));
      }
      setPhone((v) => v || String(data.phone || ''));
      setNin((v) => v || String(data.national_id || ''));
      setOccupation((v) => v || String(data.occupation || ''));
      if (data.preferred_language) setLanguage(String(data.preferred_language));
    })();
    return () => { cancelled = true; };
  }, [user]);

  /* Real identity check — existence only, never whose. */
  const checkTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!user) return;
    const digits = phone.replace(/\D/g, '');
    const ninClean = cleanNin(nin);
    if (digits.length < 9 && ninClean.length < 10) { setIdCheck({ checking: false }); return; }
    if (checkTimer.current) window.clearTimeout(checkTimer.current);
    checkTimer.current = window.setTimeout(async () => {
      setIdCheck((s) => ({ ...s, checking: true }));
      const { data, error } = await supabase.functions.invoke('tenant-self-onboarding', {
        body: { action: 'identity_check', phone, national_id: nin },
      });
      if (error) { setIdCheck({ checking: false }); return; }
      setIdCheck({ checking: false, ...(data as Record<string, boolean>) });
    }, 600);
    return () => { if (checkTimer.current) window.clearTimeout(checkTimer.current); };
  }, [phone, nin, user]);

  const ninTakenByOther = idCheck.nin_known === true && idCheck.nin_is_you === false;
  const phoneTakenByOther = idCheck.phone_known === true && idCheck.phone_is_you === false;

  const addPhoto = async (file: File, target: 'tenant' | 'id' | 'house' | 'lc_letter') => {
    try {
      const opt = await optimizeImage(file, { maxWidth: 1200, quality: 0.82 });
      const slot: PhotoSlot = { file: opt.file, preview: opt.previewUrl };
      if (target === 'tenant') setTenantPhoto(slot);
      else if (target === 'id') setIdPhoto(slot);
      else if (target === 'lc_letter') setLcLetter(slot);
      else setHousePhotos((p) => [...p, slot].slice(0, 4));
    } catch {
      toast.error('That photo could not be used. Try another one.');
    }
  };

  /* ------------------------------------------------------- validation ---- */
  const stepError = (s: number): string | null => {
    if (s === 2) {
      if (rentAmount < MIN_RENT || rentAmount > MAX_RENT) return `Enter a rent between ${formatUGX(MIN_RENT)} and ${formatUGX(MAX_RENT)}`;
      return null;
    }
    if (s === 3) {
      if (firstName.trim().length < 2 || lastName.trim().length < 2) return 'Enter your first and last name';
      if (!validateUgandaPhone(phone).valid) return 'Enter a valid Uganda phone number';
      if (phoneTakenByOther) return 'This phone number is already registered to another account';
      const c = cleanNin(nin);
      if (c.length < 10 || c.length > 14) return 'National ID must be 10 to 14 characters';
      if (ninTakenByOther) return 'This National ID is already registered to another account';
      if (!tenantPhoto) return 'Take your passport photo';
      if (!idPhoto) return 'Take a photo of your National ID';
      return null;
    }
    if (s === 4) {
      if (!address.trim()) return 'Describe your house address';
      if (!location) return 'Pick your official village';
      if (!gps) return 'Capture your GPS location at the house';
      if (housePhotos.length < 2) return 'Add at least 2 photos of the house';
      return null;
    }
    if (s === 5) {
      if (!landlord && (!newLandlordName.trim() || !validateUgandaPhone(newLandlordPhone).valid)) {
        return 'Pick your landlord, or enter their name and phone';
      }
      if (!lc1 || !lc1.name.trim() || !validateUgandaPhone(lc1.phone).valid) return 'Add your LC1 chairperson';
      return null;
    }
    return null;
  };

  const goNext = () => {
    const e = stepError(step);
    if (e) { toast.error(e); return; }
    setStep((s) => Math.min(6, s + 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const goTo = (n: number) => {
    if (n > step) { const e = stepError(step); if (e) { toast.error(e); return; } }
    setStep(n);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /* ----------------------------------------------------------- submit ---- */
  const submit = async () => {
    for (let s = 2; s <= 5; s++) {
      const e = stepError(s);
      if (e) { setStep(s); toast.error(e); return; }
    }
    setSubmitting(true);
    try {
      const [tenantB64, housesB64] = await Promise.all([
        tenantPhoto ? toDataUrl(tenantPhoto.file) : Promise.resolve(null),
        Promise.all(housePhotos.map((p) => toDataUrl(p.file))),
      ]);
      const idB64 = idPhoto ? await toDataUrl(idPhoto.file) : null;
      const lcLetterB64 = lcLetter ? await toDataUrl(lcLetter.file) : null;

      const { data, error } = await supabase.functions.invoke('tenant-self-onboarding', {
        body: {
          action: 'submit',
          full_name: `${firstName.trim()} ${lastName.trim()}`,
          phone,
          national_id: cleanNin(nin),
          occupation,
          preferred_language: language,
          no_smartphone: noSmartphone,
          rent_amount: rentAmount,
          duration_days: durationDays,
          repayment_frequency: earner === 'weekly' ? 'weekly' : 'daily',
          house_category: houseType,
          property_address: address.trim(),
          village: location?.village ?? '',
          district: location?.district ?? '',
          ug_village_id: location?.villageId ?? null,
          gps_lat: gps?.latitude ?? null,
          gps_lng: gps?.longitude ?? null,
          gps_accuracy: gps?.accuracy ?? null,
          landlord_id: landlord?.id ?? null,
          landlord_name: landlord?.name ?? newLandlordName.trim(),
          landlord_phone: landlord?.phone ?? newLandlordPhone,
          lc1_id: lc1?.mode === 'existing' ? lc1.id : null,
          lc1_name: lc1?.name ?? '',
          lc1_phone: lc1?.phone ?? '',
          tenant_note: note.trim() || null,
          tenant_photo: tenantB64,
          id_photo: idB64,
          lc_letter: lcLetterB64,
          house_photos: housesB64,
        },
      });

      if (error) {
        const msg = (error as any)?.context?.body
          ? String((error as any).context.body)
          : error.message;
        throw new Error(msg);
      }
      if ((data as any)?.error) throw new Error(String((data as any).error));

      setSubmitted({ id: String((data as any).rent_request_id) });
      /* The draft has served its purpose — drop it so a returning tenant does
         not reopen a stale copy of a request they already sent. */
      if (draftKey) { try { localStorage.removeItem(draftKey); } catch { /* ignore */ } }
      toast.success('Your rent request has been submitted for verification');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e: any) {
      let msg = e?.message || 'Something went wrong. Please try again.';
      try { const parsed = JSON.parse(msg); if (parsed?.error) msg = parsed.error; } catch { /* plain text */ }
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  /* --------------------------------------------------------- gate/auth --- */
  if (authLoading) {
    return (
      <div className="min-h-screen grid place-items-center bg-muted/30">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen grid place-items-center bg-muted/30 px-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-6 text-center space-y-4">
            <img src={welileLogo} alt="Welile" className="h-9 mx-auto" />
            <h1 className="text-xl font-bold">Request rent support yourself</h1>
            <p className="text-sm text-muted-foreground">
              Create your account or sign in first — we save your request to your own profile so you can follow it.
            </p>
            <Button asChild className="w-full">
              <Link to={authHref(true)}>Create my account</Link>
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link to={authHref(false)}>I already have an account</Link>
            </Button>
            <p className="text-xs text-muted-foreground">
              We bring you straight back to this form afterwards.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-muted/30 px-4 py-10">
        <div className="mx-auto max-w-xl space-y-5">
          <img src={welileLogo} alt="Welile" className="h-8" />
          <Card>
            <CardContent className="p-6 space-y-4">
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 place-items-center rounded-full bg-primary/10">
                  <CheckCircle2 className="h-6 w-6 text-primary" />
                </span>
                <div>
                  <h1 className="text-lg font-bold">Request submitted</h1>
                  <p className="text-sm text-muted-foreground">Reference {submitted.id.slice(0, 8).toUpperCase()}</p>
                </div>
              </div>
              <div className="rounded-lg border bg-background p-4 text-sm space-y-2">
                <Row label="Rent requested" value={formatUGX(rentAmount)} />
                <Row label="Repayment period" value={`${durationDays} days`} />
                <Row label={`${periodLabel} payment`} value={formatUGX(perCycle)} />
                <Row label="Total to repay" value={calc ? formatUGX(calc.totalRepayment) : '—'} />
              </div>
              <p className="text-sm text-muted-foreground">
                Our team will now verify your details, your landlord and your LC1 chairperson. You will be contacted on
                the phone number you gave. You can follow the progress from your dashboard.
              </p>
              <Button className="w-full" onClick={() => navigate('/dashboard/tenant')}>Go to my dashboard</Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const current = STEPS[step - 1];

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Top bar — full-bleed, 56px on mobile / 64px from sm up, matching the
          onboarding shell rather than the app's centred container. */}
      <header className="sticky top-0 z-30 flex h-14 items-center border-b bg-background px-3 sm:h-16 sm:px-8">
        <div className="flex w-full min-w-0 items-center justify-between">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3.5">
            <img src={welileLogo} alt="Welile" className="h-7 w-auto max-w-[100px] object-contain sm:h-[34px] sm:max-w-[130px]" />
            <span className="hidden shrink-0 rounded-full bg-primary/10 px-2.5 py-[3px] text-[11.5px] font-bold uppercase tracking-wider text-primary md:inline-flex">
              Rent Onboarding
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3.5">
            {saveState !== 'idle' && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11.5px] font-semibold text-muted-foreground sm:px-3">
                <span className={cn(
                  'h-[7px] w-[7px] shrink-0 rounded-full',
                  saveState === 'saving' ? 'animate-pulse bg-amber-500' : 'bg-emerald-600',
                )} />
                {saveState === 'saving' ? 'Saving' : 'Saved'}
              </span>
            )}

            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-primary hover:bg-primary/5 hover:text-primary sm:px-3 sm:text-[12.5px]"
            >
              <HelpCircle className="h-3.5 w-3.5" />
              Help
            </button>
          </div>
        </div>
      </header>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Need a hand?</DialogTitle>
            <DialogDescription>
              Talk to the Welile team. We can walk you through any step of this form.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <a
              href={`tel:${SUPPORT_PHONE_DIAL}`}
              className="flex items-center gap-3 rounded-xl border p-3 transition-colors hover:border-primary hover:bg-primary/5"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10">
                <Phone className="h-[18px] w-[18px] text-primary" />
              </span>
              <span className="min-w-0">
                <span className="block text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  Call us
                </span>
                <span className="block truncate text-sm font-bold tabular-nums text-foreground">
                  {SUPPORT_PHONE_DISPLAY}
                </span>
              </span>
            </a>

            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="flex items-center gap-3 rounded-xl border p-3 transition-colors hover:border-primary hover:bg-primary/5"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10">
                <Mail className="h-[18px] w-[18px] text-primary" />
              </span>
              <span className="min-w-0">
                <span className="block text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  Email us
                </span>
                <span className="block truncate text-sm font-bold text-foreground">{SUPPORT_EMAIL}</span>
              </span>
            </a>
          </div>
          <p className="text-xs text-muted-foreground">
            Your answers are saved on this device as you type, so you can close this and come back.
          </p>
        </DialogContent>
      </Dialog>

      <Dialog open={addLandlordOpen} onOpenChange={setAddLandlordOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add your landlord</DialogTitle>
            <DialogDescription>
              Give us their name and number. Welile vets them separately — you do not have to wait
              for that before you submit.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-[13.5px] font-semibold">
                Landlord full name <span className="text-destructive">*</span>
              </Label>
              <Input
                value={newLandlordName}
                onChange={(e) => setNewLandlordName(e.target.value)}
                placeholder="e.g. Adam Ssembatya"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label className="text-[13.5px] font-semibold">
                Landlord phone <span className="text-destructive">*</span>
              </Label>
              <PhoneInput
                value={newLandlordPhone}
                onChange={(v) => setNewLandlordPhone(v)}
                placeholder="0771234567"
              />
              {newLandlordPhone.trim().length > 0 && !validateUgandaPhone(newLandlordPhone).valid && (
                <p className="flex items-center gap-1.5 text-[12.5px] font-bold text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  Enter a valid Uganda phone number.
                </p>
              )}
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="secondary"
              onClick={() => { setNewLandlordName(''); setNewLandlordPhone(''); setAddLandlordOpen(false); }}>
              Cancel
            </Button>
            <Button type="button" disabled={!newLandlordReady} onClick={() => setAddLandlordOpen(false)}>
              Save landlord
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mobile step progress, sticky directly under the bar. */}
      <div className="sticky top-14 z-20 border-b bg-background px-4 py-2.5 lg:hidden">
        <div className="mb-1.5 flex items-center justify-between text-[11.5px] font-bold">
          <span className="uppercase tracking-wider text-primary">Step {step} of 6</span>
          <span className="text-foreground">{current.name}</span>
        </div>
        <Progress value={(step / 6) * 100} className="h-1" />
      </div>

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[260px_1fr]">
        {/* Step rail */}
        <aside className="hidden lg:block">
          <ol className="space-y-1">
            {STEPS.map((s) => {
              const Icon = s.icon;
              const state = s.n === step ? 'current' : s.n < step ? 'done' : 'todo';
              return (
                <li key={s.n}>
                  <button
                    type="button"
                    onClick={() => goTo(s.n)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                      state === 'current' && 'bg-primary/10 ring-1 ring-primary/30',
                      state !== 'current' && 'hover:bg-muted',
                    )}
                  >
                    <span className={cn(
                      'grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold',
                      state === 'current' && 'bg-primary text-primary-foreground',
                      state === 'done' && 'bg-primary/15 text-primary',
                      state === 'todo' && 'bg-muted text-muted-foreground',
                    )}>
                      {state === 'done' ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                    </span>
                    <span className="min-w-0">
                      <span className={cn('block truncate text-sm font-semibold',
                        state === 'current' ? 'text-primary' : 'text-foreground')}>{s.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{s.sub}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>

        {/* Step card */}
        <Card className="overflow-hidden">
          <CardContent className="space-y-6 p-5 sm:p-7">
            <div className="space-y-1.5">
              <Badge className="bg-primary/10 text-primary hover:bg-primary/10">Step {step} of 6</Badge>
              <h1 className="text-xl font-bold sm:text-2xl">{stepTitle(step)}</h1>
              <p className="text-sm text-muted-foreground">{stepDesc(step)}</p>
            </div>

            {/* ---------------------------------------------------- step 1 */}
            {step === 1 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {EARNERS.map((o) => {
                  const Icon = o.icon;
                  const active = earner === o.key;
                  return (
                    <button key={o.key} type="button" onClick={() => setEarner(o.key)}
                      className={cn('rounded-xl border p-4 text-left transition-all',
                        active ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'hover:border-primary/40')}>
                      <span className="mb-2 grid h-10 w-10 place-items-center rounded-lg bg-primary/10">
                        <Icon className="h-5 w-5 text-primary" />
                      </span>
                      <span className="block font-semibold">{o.title}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">{o.sub}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* ---------------------------------------------------- step 2 */}
            {step === 2 && (
              <div className="space-y-5">
                {/* Which schedule they picked in step 1, with a way back. */}
                <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10">
                      <activeEarner.icon className="h-[18px] w-[18px] text-primary" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-bold text-foreground">{activeEarner.title}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">{activeEarner.banner}</span>
                    </span>
                  </div>
                  <Button type="button" variant="outline" size="sm"
                    className="h-8 shrink-0 border-primary/30 px-3 text-xs font-bold text-primary hover:bg-primary hover:text-primary-foreground"
                    onClick={() => goTo(1)}>
                    Change
                  </Button>
                </div>

                {/* Rent and period sit side by side on desktop, stacked on mobile. */}
                <div className="grid gap-4 sm:grid-cols-2 sm:gap-5">
                  <div className="space-y-2">
                    <Label className="text-[13.5px] font-semibold">
                      Monthly rent <span className="text-destructive">*</span>
                    </Label>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm font-extrabold text-muted-foreground">
                        UGX
                      </span>
                      <Input
                        inputMode="numeric"
                        aria-invalid={rentInvalid}
                        className={cn(
                          'h-12 pl-[58px] text-base font-extrabold tabular-nums',
                          rentInvalid && 'border-destructive focus-visible:ring-destructive',
                        )}
                        placeholder="500,000"
                        value={rentAmount ? rentAmount.toLocaleString() : ''}
                        onChange={(e) => setRentInput(e.target.value)}
                      />
                    </div>
                    {rentInvalid ? (
                      <p className="flex items-center gap-1.5 text-[12.5px] font-bold text-destructive">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        Enter a rent between {formatUGX(MIN_RENT)} and {formatUGX(MAX_RENT)}.
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Allowed range: {formatUGX(MIN_RENT)} to {formatUGX(MAX_RENT)}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label className="text-[13.5px] font-semibold">
                      Choose your repayment period <span className="text-destructive">*</span>
                    </Label>
                    <Select value={String(durationDays)} onValueChange={(v) => setDurationDays(Number(v))}>
                      <SelectTrigger className="h-12 font-semibold"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(earner === 'weekly' ? WEEKLY_PERIODS : DAILY_PERIODS).map((d) => (
                          <SelectItem key={d} value={String(d)}>
                            {d} days{earner === 'weekly' ? ' (' + d / 7 + ' weeks)' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {earner === 'weekly'
                        ? 'Weekly instalments over the selected period'
                        : 'Daily micro-instalments over the selected period'}
                    </p>
                  </div>
                </div>

                {/* Estimated Repayment Plan */}
                {calc && (
                  <div className="rounded-2xl border bg-background p-5">
                    <div className="mb-4 flex items-center gap-3 border-b pb-3.5">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10">
                        <CalendarDays className="h-[18px] w-[18px] text-primary" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-extrabold text-foreground">Estimated Repayment Plan</span>
                        <span className="block text-[11.5px] text-muted-foreground">
                          Repayment breakdown for your selected schedule
                        </span>
                      </span>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <KeyCell
                        label="Repayment amount"
                        value={formatUGX(perCycle)}
                        sub={'Per ' + periodLabel.toLowerCase() + ' cycle'}
                        highlight
                      />
                      <KeyCell
                        label="Repayment period"
                        value={durationDays + ' days'}
                        sub="Total repayment duration"
                      />
                      <KeyCell
                        label="Cycle/period"
                        value={periodLabel}
                        sub={earner === 'weekly' ? 'weekly instalments' : 'micro-instalments'}
                      />
                    </div>

                    <div className="mt-4 border-t border-dashed pt-3">
                      <button
                        type="button"
                        onClick={() => setFeeOpen((v) => !v)}
                        aria-expanded={feeOpen}
                        className="inline-flex items-center gap-2 py-1 text-[12.5px] font-bold text-primary transition-colors hover:text-primary/80"
                      >
                        <Info className="h-3.5 w-3.5" />
                        View fee breakdown
                        <ChevronDown className={cn('h-3 w-3 transition-transform', feeOpen && 'rotate-180')} />
                      </button>

                      {feeOpen && (
                        <div className="mt-3 space-y-2 rounded-xl border bg-muted/40 px-4 py-3.5 text-[12.5px]">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">Base monthly rent (paid to your landlord)</span>
                            <span className="shrink-0 font-bold tabular-nums">{formatUGX(calc.rentAmount)}</span>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">
                              Platform access fee ({calc.accessFeeRate.toFixed(1)}%)
                            </span>
                            <span className="shrink-0 font-bold tabular-nums">{formatUGX(calc.accessFee)}</span>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">Registration &amp; one-time processing</span>
                            <span className="shrink-0 font-bold tabular-nums">{formatUGX(calc.requestFee)}</span>
                          </div>
                          <div className="flex items-center justify-between gap-3 border-t border-dashed pt-2">
                            <span className="font-extrabold text-foreground">Total amount payable</span>
                            <span className="shrink-0 text-sm font-extrabold tabular-nums text-primary">
                              {formatUGX(calc.totalRepayment)}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ---------------------------------------------------- step 3 */}
            {step === 3 && (
              <div className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="First name" required>
                    <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="e.g. Robert" />
                  </Field>
                  <Field label="Last name" required>
                    <Input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="e.g. Mugisha" />
                  </Field>
                </div>

                <Field label="Phone number" required
                  hint="Uganda mobile number (MTN or Airtel). We use it for all updates.">
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0771 234 567" inputMode="tel" />
                  {idCheck.checking && <Hint icon={Loader2} spin>Checking…</Hint>}
                  {!idCheck.checking && idCheck.phone_is_you && <Hint icon={CheckCircle2} tone="ok">This is the number on your account.</Hint>}
                  {!idCheck.checking && phoneTakenByOther && <Hint icon={AlertTriangle} tone="bad">This number is already registered on Welile. Sign in with it instead.</Hint>}
                </Field>

                <Field label="National ID (NIN)" required hint="10 to 14 letters and numbers, exactly as on your card.">
                  <Input value={nin} onChange={(e) => setNin(e.target.value.toUpperCase())} placeholder="CM9001234567AB" className="font-mono" />
                  {!idCheck.checking && idCheck.nin_is_you && <Hint icon={CheckCircle2} tone="ok">This National ID matches your account.</Hint>}
                  {!idCheck.checking && ninTakenByOther && <Hint icon={AlertTriangle} tone="bad">This National ID is already registered to another account. Please check the number.</Hint>}
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="What work do you do?">
                    <Input value={occupation} onChange={(e) => setOccupation(e.target.value)} placeholder="e.g. Boda rider" />
                  </Field>
                  <Field label="Preferred language">
                    <Select value={language} onValueChange={setLanguage}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{LANGUAGES.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                </div>

                <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary"
                    checked={noSmartphone} onChange={(e) => setNoSmartphone(e.target.checked)} />
                  <span>I do not use a smartphone — please reach me by SMS and calls.</span>
                </label>

                <div className="grid gap-4 sm:grid-cols-2">
                  <PhotoBox label="Passport photo" required hint="Clear face photo, no hat"
                    slot={tenantPhoto} onPick={(f) => addPhoto(f, 'tenant')} onClear={() => setTenantPhoto(null)} />
                  <PhotoBox label="National ID photo" required hint="Front of the card, all text readable"
                    slot={idPhoto} onPick={(f) => addPhoto(f, 'id')} onClear={() => setIdPhoto(null)} />
                </div>
              </div>
            )}

            {/* ---------------------------------------------------- step 4 */}
            {step === 4 && (
              <div className="space-y-5">
                <Field label="House type" required>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {HOUSE_TYPES.map((h) => (
                      <button key={h.value} type="button" onClick={() => setHouseType(h.value)}
                        className={cn('rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
                          houseType === h.value ? 'border-primary bg-primary/5 text-primary' : 'hover:border-primary/40')}>
                        {h.label}
                      </button>
                    ))}
                  </div>
                </Field>

                <UgLocationPicker
                  label="Where do you stay?"
                  required
                  value={location}
                  onChange={setLocation}
                />

                <Field label="House address / landmark" required
                  hint="Plot, road or nearest landmark so the team can find the house.">
                  <Textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)}
                    placeholder="e.g. Plot 14, behind Kabalagala market" />
                </Field>

                <div className="rounded-xl border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">GPS location of the house <span className="text-destructive">*</span></p>
                      <p className="text-xs text-muted-foreground">
                        {gps ? `Captured: ${gps.latitude.toFixed(5)}, ${gps.longitude.toFixed(5)}` : 'Stand at the house and capture it.'}
                      </p>
                      {gpsError && <p className="text-xs text-destructive">{gpsError}</p>}
                    </div>
                    <Button type="button" variant={gps ? 'secondary' : 'default'} onClick={() => captureLocation()} disabled={gpsLoading}>
                      {gpsLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MapPin className="mr-2 h-4 w-4" />}
                      {gps ? 'Recapture' : 'Capture GPS'}
                    </Button>
                  </div>
                </div>

                <Field label="House photos" required hint="At least 2 photos — the outside, the door and the room.">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {housePhotos.map((p, i) => (
                      <div key={i} className="relative overflow-hidden rounded-lg border">
                        <img src={p.preview} alt={`House ${i + 1}`} className="h-24 w-full object-cover" />
                        <button type="button" onClick={() => setHousePhotos((v) => v.filter((_, j) => j !== i))}
                          className="absolute right-1 top-1 rounded bg-background/90 px-1.5 text-xs font-semibold">Remove</button>
                      </div>
                    ))}
                    {housePhotos.length < 4 && (
                      <PhotoPicker onPick={(f) => addPhoto(f, 'house')} />
                    )}
                  </div>
                </Field>
              </div>
            )}

            {/* ---------------------------------------------------- step 5 */}
            {step === 5 && (
              <div className="space-y-6">
                <div className="space-y-3">
                  <Label className="flex items-center gap-1.5 text-sm font-semibold">
                    <Building2 className="h-4 w-4 text-primary" /> Your landlord <span className="text-destructive">*</span>
                  </Label>
                  {/* The search steps aside once someone is chosen — the panel
                      below becomes the answer, and Change brings it back. */}
                  {!chosenLandlord && (
                    <LandlordSearchSelect
                      inline
                      value={landlord}
                      onChange={setLandlord}
                      placeholder="Search your landlord by name or phone"
                    />
                  )}
                  {/* What was picked. Without this the only sign of a
                      successful choice was the form below disappearing. */}
                  {chosenLandlord && (
                    <div className="overflow-hidden rounded-xl border bg-card">
                      <div className="flex items-start gap-3 p-4">
                        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary/10">
                          <Building2 className="h-5 w-5 text-primary" />
                        </span>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-3">
                            <p className="min-w-0 truncate text-[15px] font-bold leading-tight text-foreground">
                              {chosenLandlord.name}
                            </p>
                            <span className={cn(
                              'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-[3px] text-[10px] font-bold uppercase tracking-wide',
                              chosenLandlord.verified
                                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
                                : 'bg-primary/10 text-primary',
                            )}>
                              {chosenLandlord.verified
                                ? <><Check className="h-3 w-3" /> Verified</>
                                : <><ShieldQuestion className="h-3 w-3" /> {chosenLandlord.isNew ? 'New' : 'To be vetted'}</>}
                            </span>
                          </div>

                          <p className="mt-1 flex items-center gap-1.5 text-[13px] tabular-nums text-muted-foreground">
                            <Phone className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{chosenLandlord.phone}</span>
                          </p>
                          {chosenLandlord.address && (
                            <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
                              <MapPin className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">{chosenLandlord.address}</span>
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-4 py-2.5">
                        <p className="min-w-0 text-xs text-muted-foreground">
                          {chosenLandlord.verified
                            ? 'Verified by Welile — nothing more needed from you.'
                            : 'Welile will check them. You can submit now.'}
                        </p>
                        <Button type="button" variant="ghost" size="sm"
                          className="h-7 shrink-0 gap-1 px-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            setLandlord(null);
                            setNewLandlordName('');
                            setNewLandlordPhone('');
                          }}>
                          <X className="h-3.5 w-3.5" />
                          Change
                        </Button>
                      </div>
                    </div>
                  )}

                  {!chosenLandlord && (
                    <Button type="button" variant="outline" className="h-11 w-full gap-2 border-dashed"
                      onClick={() => setAddLandlordOpen(true)}>
                      <UserPlus className="h-4 w-4" />
                      Landlord not listed? Add them
                    </Button>
                  )}
                </div>

                <Lc1ChairpersonPicker
                  value={lc1}
                  onChange={setLc1}
                  defaultDistrict={location?.district}
                  defaultRegion={location?.region ?? undefined}
                  defaultVillage={location?.village}
                  scopeDistrictName={location?.district ?? null}
                  context="tenant"
                />

                <div className="grid gap-4 sm:grid-cols-2">
                  <PhotoBox
                    label="LC1 introduction letter"
                    hint="Optional now — a photo of the letter stamped by your LC1 speeds up verification."
                    slot={lcLetter}
                    onPick={(f) => addPhoto(f, 'lc_letter')}
                    onClear={() => setLcLetter(null)}
                  />
                </div>

                <Field label="Anything else we should know?">
                  <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="Optional — tell us anything that helps the verification team." />
                </Field>
              </div>
            )}

            {/* ---------------------------------------------------- step 6 */}
            {step === 6 && (
              <div className="space-y-4">
                <Section title="Rent plan">
                  <Row label="Monthly rent" value={formatUGX(rentAmount)} />
                  <Row label="Period" value={`${durationDays} days`} />
                  <Row label={`${periodLabel} payment`} value={formatUGX(perCycle)} strong />
                  <Row label="Total to repay" value={calc ? formatUGX(calc.totalRepayment) : '—'} />
                </Section>
                <Section title="You">
                  <Row label="Name" value={`${firstName} ${lastName}`.trim()} />
                  <Row label="Phone" value={phone} />
                  <Row label="National ID" value={cleanNin(nin)} />
                  <Row label="Work" value={occupation || '—'} />
                  <Row label="Language" value={language} />
                </Section>
                <Section title="Home">
                  <Row label="House type" value={HOUSE_TYPES.find((h) => h.value === houseType)?.label ?? houseType} />
                  <Row label="Village" value={location?.fullPath ?? '—'} />
                  <Row label="Address" value={address || '—'} />
                  <Row label="GPS" value={gps ? `${gps.latitude.toFixed(5)}, ${gps.longitude.toFixed(5)}` : '—'} />
                  <Row label="Photos" value={`${housePhotos.length} attached`} />
                </Section>
                <Section title="Verification contacts">
                  <Row label="Landlord" value={landlord ? `${landlord.name} · ${landlord.phone}` : `${newLandlordName} · ${newLandlordPhone}`} />
                  <Row label="LC1 chairperson" value={lc1 ? `${lc1.name} · ${lc1.phone}` : '—'} />
                  <Row label="LC1 letter" value={lcLetter ? 'Attached' : 'Not attached'} />
                </Section>
                <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span>
                    By submitting you confirm these details are true. Welile will verify you, your landlord and your LC1
                    chairperson before any rent is paid. Nothing is paid out at this step.
                  </span>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between gap-3 border-t pt-4">
              <Button type="button" variant="secondary" disabled={step === 1 || submitting}
                onClick={() => goTo(step - 1)}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              {step < 6 ? (
                <Button type="button" onClick={goNext}>
                  Continue <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              ) : (
                <Button type="button" onClick={submit} disabled={submitting}>
                  {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                  Submit rent request
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------- helpers ---- */

function stepTitle(step: number) {
  switch (step) {
    case 1: return 'How do you earn income?';
    case 2: return "Let's start with your rent";
    case 3: return 'Tell us about yourself';
    case 4: return 'Tell us about your home';
    case 5: return 'Who can confirm you live there?';
    default: return 'Check and submit';
  }
}
function stepDesc(step: number) {
  switch (step) {
    case 1: return 'This decides how often you pay back.';
    case 2: return 'Tell us the rent you need supported and choose your repayment period.';
    case 3: return 'Use your details exactly as they appear on your National ID.';
    case 4: return 'Your official village, the address, GPS and photos of the house.';
    case 5: return 'Your landlord and your LC1 chairperson. We check them against our records first.';
    default: return 'Confirm everything is correct, then submit for verification.';
  }
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={cn('text-sm tabular-nums', strong ? 'font-bold text-primary' : 'font-semibold')}>{value}</span>
    </div>
  );
}

/** One cell of the Estimated Repayment Plan grid: label, big value, caption.
 *  Money uses the body font with tabular figures — never a mono face — so the
 *  amounts sit in the same typeface as the rest of the page. */
function KeyCell({ label, value, sub, highlight }: {
  label: string; value: string; sub: string; highlight?: boolean;
}) {
  return (
    <div className="flex min-h-[98px] flex-col justify-between rounded-xl border bg-muted/40 p-3.5 transition-colors hover:border-primary/30 hover:bg-background">
      <span className="block truncate text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className={cn(
        'my-1 block truncate text-lg font-extrabold leading-tight tabular-nums',
        highlight ? 'text-primary' : 'text-foreground',
      )}>
        {value}
      </span>
      <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-background p-4">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Field({ label, required, hint, children }: {
  label: string; required?: boolean; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-semibold">
        {label} {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Hint({ icon: Icon, children, tone, spin }: {
  icon: any; children: React.ReactNode; tone?: 'ok' | 'bad'; spin?: boolean;
}) {
  return (
    <p className={cn('flex items-center gap-1.5 text-xs',
      tone === 'ok' && 'text-primary', tone === 'bad' && 'text-destructive',
      !tone && 'text-muted-foreground')}>
      <Icon className={cn('h-3.5 w-3.5', spin && 'animate-spin')} /> {children}
    </p>
  );
}

function PhotoPicker({ onPick }: { onPick: (f: File) => void }) {
  return (
    <label className="grid h-24 cursor-pointer place-items-center rounded-lg border border-dashed text-xs font-medium text-muted-foreground hover:border-primary hover:text-primary">
      <span className="flex flex-col items-center gap-1">
        <Camera className="h-5 w-5" /> Add photo
      </span>
      <input type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.currentTarget.value = ''; }} />
    </label>
  );
}

function PhotoBox({ label, required, hint, slot, onPick, onClear }: {
  label: string; required?: boolean; hint?: string;
  slot: PhotoSlot | null; onPick: (f: File) => void; onClear: () => void;
}) {
  return (
    <div className="rounded-xl border p-3">
      <p className="text-sm font-semibold">{label} {required && <span className="text-destructive">*</span>}</p>
      {hint && <p className="mb-2 text-xs text-muted-foreground">{hint}</p>}
      {slot ? (
        <div className="relative overflow-hidden rounded-lg border">
          <img src={slot.preview} alt={label} className="h-36 w-full object-cover" />
          <button type="button" onClick={onClear}
            className="absolute right-1 top-1 rounded bg-background/90 px-2 py-0.5 text-xs font-semibold">Retake</button>
        </div>
      ) : (
        <label className="grid h-36 cursor-pointer place-items-center rounded-lg border border-dashed text-sm font-medium text-muted-foreground hover:border-primary hover:text-primary">
          <span className="flex flex-col items-center gap-1.5">
            <Camera className="h-6 w-6" /> Take photo
          </span>
          <input type="file" accept="image/*" capture="environment" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.currentTarget.value = ''; }} />
        </label>
      )}
    </div>
  );
}
