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
import { Helmet } from 'react-helmet-async';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Camera, Check, CircleDollarSign, Home, Loader2, MapPin,
  ShieldCheck, User, Wallet, CalendarDays, Info, Building2, CheckCircle2, AlertTriangle,
  ChevronDown, HelpCircle, Mail, Phone, Clock, X, UserPlus, ShieldQuestion, Pencil,
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
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { NationalIdConsentDialog } from '@/components/shared/NationalIdConsentDialog';


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
import { Checkbox } from '@/components/ui/checkbox';
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

/** What the submit button says while it works, in order. */
const SUBMIT_PHASES = ['Submitting…', 'Sending your request…', 'Uploading your photos…', 'Almost done…'] as const;

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

// Photos: JPG/JPEG/PNG only, 5 MB max. Mirrored server-side in tenant-self-onboarding.
const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/jpg', 'image/png'];
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

interface PhotoSlot { file: File; preview: string }

interface PassportCheck {
  checking: boolean;
  verdict?: 'pass' | 'review' | 'fail';
  is_face?: boolean;
  score?: number | null;
  sha256?: string | null;
  failures?: { id: string; label: string; severity: string; advice: string }[];
  error?: string;
}


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

  /* Existing-application gate. A tenant who already has a request in progress
     (or a live plan) must not fill this form again — it would put them through
     vetting twice and could raise support twice on one plan. Matched on the
     signed-in account plus any account sharing their phone number or email. */
  const [gate, setGate] = useState<{
    checking: boolean;
    blocked: boolean;
    stage?: 'under_review' | 'repaying' | 'none';
    status?: string;
    created_at?: string;
    other_account?: boolean;
  }>({ checking: true, blocked: false });

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
  const [nationalIdName, setNationalIdName] = useState('');
  // Consent flow state for borrowed National ID
  const [consentModalOpen, setConsentModalOpen] = useState(false);
  const [consentStage, setConsentStage] = useState<'awaiting_owner_phone' | 'awaiting_code'>('awaiting_owner_phone');
  const [consentDeclarationId, setConsentDeclarationId] = useState<string | null>(null);
  const [consentErrorMessage, setConsentErrorMessage] = useState<string | null>(null);
  const [consentOwnerPhone, setConsentOwnerPhone] = useState('');
  const [consentSubmitting, setConsentSubmitting] = useState(false);
  const [occupation, setOccupation] = useState('');
  const [language, setLanguage] = useState('English');
  const [noSmartphone, setNoSmartphone] = useState(false);
  const [tenantPhoto, setTenantPhoto] = useState<PhotoSlot | null>(null);
  /* Passport-photo quality verdict from the `verify-passport-photo` function.
     Advisory only: a "review" verdict still lets the tenant continue, a human
     looks at it later. Nothing here writes to the database. */
  const [photoCheck, setPhotoCheck] = useState<PassportCheck | null>(null);

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
  const [declared, setDeclared] = useState(false);
  /* Which reassurance line the submit button is showing. */
  const [submitPhase, setSubmitPhase] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);

  /* Step 5 */
  const [landlord, setLandlord] = useState<LandlordOption | null>(null);
  const [newLandlordName, setNewLandlordName] = useState('');
  const [newLandlordPhone, setNewLandlordPhone] = useState('');
  const [lc1, setLc1] = useState<Lc1Selection | null>(null);
  const [note, setNote] = useState('');

  /* ------------------------------------------------------ referral claim ---
     The short link arrives as /tenants-onboarding?ref=<agent id>. That id is
     only ever written to the tenant's profile during SIGN-UP, so a tenant who
     already had an account signs IN, the referrer is never recorded, and
     tenant-self-onboarding — which reads attribution only from the profile —
     leaves the request with no agent.

     Claim it here instead. The browser only asks; claim_tenant_referrer
     decides, against the caller's own identity: it writes only when the
     profile has no referrer yet, refuses self-referral, and requires the
     referrer to be a live, unfrozen, enabled agent. A refusal is silent —
     attribution must never block someone from onboarding. */
  useEffect(() => {
    if (!user) return;
    const ref = new URLSearchParams(routeLocation.search).get('ref');
    if (!ref || ref === user.id) return;
    void (async () => {
      try {
        await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<unknown>)(
          'claim_tenant_referrer', { p_referrer_id: ref },
        );
      } catch { /* attribution is never worth blocking onboarding for */ }
    })();
  }, [user, routeLocation.search]);

  /* Walk the submit button through its reassurance lines. Submission uploads
     several photos over a Ugandan mobile connection and can genuinely take a
     while; a frozen spinner reads as a hang. */
  useEffect(() => {
    if (!submitting) { setSubmitPhase(0); return; }
    const t = setInterval(() => setSubmitPhase((n) => Math.min(n + 1, SUBMIT_PHASES.length - 1)), 2600);
    return () => clearInterval(t);
  }, [submitting]);

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
      if (typeof d.nationalIdName === 'string') setNationalIdName(d.nationalIdName);
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
          earner, rentInput, durationDays, firstName, lastName, phone, nin, nationalIdName,
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
      phone, nin, nationalIdName, occupation, language, noSmartphone, houseType, address,
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

  /* Ask the server whether this person already has a request in progress. */
  useEffect(() => {
    if (!user) { setGate({ checking: false, blocked: false }); return; }
    let cancelled = false;
    setGate({ checking: true, blocked: false });
    (async () => {
      const { data, error } = await supabase.functions.invoke('tenant-self-onboarding', {
        body: { action: 'application_status' },
      });
      if (cancelled) return;
      if (error) { setGate({ checking: false, blocked: false }); return; }
      const d = (data ?? {}) as Record<string, unknown>;
      setGate({
        checking: false,
        blocked: d.blocked === true,
        stage: d.stage as 'under_review' | 'repaying' | 'none' | undefined,
        status: typeof d.status === 'string' ? d.status : undefined,
        created_at: typeof d.created_at === 'string' ? d.created_at : undefined,
        other_account: d.other_account === true,
      });
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
    const type = (file.type || '').toLowerCase();
    const name = file.name.toLowerCase();
    const typeOk = ALLOWED_PHOTO_TYPES.includes(type) || (!type && /\.(jpe?g|png)$/.test(name));
    if (!typeOk) {
      toast.error('Only JPG, JPEG or PNG photos are allowed.');
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      toast.error('That photo is larger than 5 MB. Please use a smaller one.');
      return;
    }
    try {
      const opt = await optimizeImage(file, {
        maxWidth: 1200,
        quality: 0.82,
        format: type === 'image/png' ? 'image/png' : 'image/jpeg',
      });
      const slot: PhotoSlot = { file: opt.file, preview: opt.previewUrl };
      if (target === 'tenant') { setTenantPhoto(slot); void runPassportCheck(slot.file); }
      else if (target === 'id') setIdPhoto(slot);
      else if (target === 'lc_letter') setLcLetter(slot);
      else setHousePhotos((p) => [...p, slot].slice(0, 4));
    } catch {
      toast.error('That photo could not be used. Try another one.');
    }
  };

  /* Grade the passport photo. Read-only: the checker keeps nothing, and a poor
     verdict never blocks the tenant — it only tells them what to fix. */
  const runPassportCheck = async (file: File) => {
    setPhotoCheck({ checking: true });
    try {
      const image_base64 = await toDataUrl(file);
      const { data, error } = await invokeEdgeFunction<{
        verdict?: 'pass' | 'review' | 'fail';
        is_face?: boolean;
        score?: number | null;
        sha256?: string | null;
        failures?: { id: string; label: string; severity: string; advice: string }[];
      }>('verify-passport-photo', { body: { image_base64 }, silent: true });

      if (error || !data) { setPhotoCheck({ checking: false, error: 'not_checked' }); return; }
      setPhotoCheck({
        checking: false,
        verdict: data.verdict,
        is_face: data.is_face,
        score: data.score ?? null,
        sha256: data.sha256 ?? null,
        failures: data.failures ?? [],
      });
    } catch {
      setPhotoCheck({ checking: false, error: 'not_checked' });
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
      // Only a definite "no face found" blocks; a `review` verdict is advisory.
      if (photoCheck && !photoCheck.checking && !photoCheck.error && photoCheck.is_face === false) {
        return 'No face was found in your passport photo. Please retake it.';
      }

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
  const submit = async (consentParams?: {
    id_owner_phone?: string;
    consent_declaration_id?: string;
    consent_code?: string;
  }) => {
    if (!consentParams) {
      for (let s = 2; s <= 5; s++) {
        const e = stepError(s);
        if (e) { setStep(s); toast.error(e); return; }
      }
      setSubmitError(null);
      setSubmitting(true);
    } else {
      setConsentSubmitting(true);
      setConsentErrorMessage(null);
    }
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
          national_id_name: nationalIdName.trim() || undefined,
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
          // Links the stored photo to its recorded fingerprint + verdict.
          tenant_photo_sha256: photoCheck?.sha256 ?? null,

          id_photo: idB64,
          lc_letter: lcLetterB64,
          house_photos: housesB64,
          ...(consentParams?.id_owner_phone ? { id_owner_phone: consentParams.id_owner_phone } : {}),
          ...(consentParams?.consent_declaration_id ? { consent_declaration_id: consentParams.consent_declaration_id } : {}),
          ...(consentParams?.consent_code ? { consent_code: consentParams.consent_code } : {}),
        },
      });

      let parsedBody: Record<string, unknown> | null = null;
      if (error?.context) {
        try {
          parsedBody = (await error.context.clone().json()) as Record<string, unknown>;
        } catch (_cloneErr) {
          try {
            parsedBody = (await error.context.json()) as Record<string, unknown>;
          } catch (_readErr) {
            // Context stream unreadable as JSON; fall back to error
          }
        }
      }
      if (!parsedBody && data) parsedBody = data as Record<string, unknown>;

      if (parsedBody?.code === 'id_owner_consent_required') {
        const stageVal = parsedBody.stage;
        const nextStage =
          stageVal === 'awaiting_code' || stageVal === 'awaiting_owner_phone'
            ? stageVal
            : parsedBody.declaration_id
              ? 'awaiting_code'
              : 'awaiting_owner_phone';
        setConsentStage(nextStage);
        if (typeof parsedBody.declaration_id === 'string') setConsentDeclarationId(parsedBody.declaration_id);
        if (consentParams?.id_owner_phone) setConsentOwnerPhone(consentParams.id_owner_phone);
        setConsentErrorMessage(typeof parsedBody.error === 'string' ? parsedBody.error : null);
        setConsentModalOpen(true);
        return;
      }

      if (error) {
        const errText =
          (typeof parsedBody?.error === 'string' ? parsedBody.error : null) ||
          (await readFunctionError(error));
        if (consentParams) {
          setConsentErrorMessage(errText);
          return;
        }
        throw new Error(errText);
      }
      const dataObj = data as Record<string, unknown> | null;
      if (dataObj?.error) {
        const errText = String(dataObj.error);
        if (consentParams) {
          setConsentErrorMessage(errText);
          return;
        }
        throw new Error(errText);
      }

      setConsentModalOpen(false);
      setSubmitted({ id: String(dataObj?.rent_request_id || '') });
      /* The draft has served its purpose — drop it so a returning tenant does
         not reopen a stale copy of a request they already sent. */
      if (draftKey) { try { localStorage.removeItem(draftKey); } catch { /* ignore */ } }
      toast.success('Your rent request has been submitted for verification');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : 'An unexpected error occurred';
      const msg = humaniseSubmitError(errMsg);
      toast.error('Could not submit your request', { description: msg, duration: 8000 });
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
      setConsentSubmitting(false);
    }
  };

  /* ------------------------------------------------- per-route head ------ */
  const onboardingHead = (
    <Helmet>
      <title>Get Rent Support — Welile Tenant Onboarding</title>
      <meta
        name="description"
        content="365 days, zero rent headaches. Request your Rent Plan on Welile — we pay your landlord upfront, you repay over time."
      />
      <meta property="og:title" content="Welile — 365 Days, Zero Rent Headaches" />
      <meta
        property="og:description"
        content="Get 12 full months of guaranteed rent paid upfront. No late excuses, no endless follow-ups."
      />
      <meta property="og:type" content="website" />
      <meta property="og:url" content="https://welileapp.com/tenants-onboarding" />
      <meta
        property="og:image"
        content="https://welileapp.com/__l5e/assets-v1/ae57546a-af3d-4bef-9627-e4c1a20836ec/tenants-onboarding-og.jpg"
      />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content="Welile — 365 Days, Zero Rent Headaches" />
      <meta
        name="twitter:description"
        content="Get 12 full months of guaranteed rent paid upfront. No late excuses, no endless follow-ups."
      />
      <meta
        name="twitter:image"
        content="https://welileapp.com/__l5e/assets-v1/ae57546a-af3d-4bef-9627-e4c1a20836ec/tenants-onboarding-og.jpg"
      />
    </Helmet>
  );

  /* --------------------------------------------------------- gate/auth --- */
  if (authLoading) {
    return (
      <div className="min-h-screen grid place-items-center bg-muted/30">
        {onboardingHead}
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen grid place-items-center bg-muted/30 px-4">
        {onboardingHead}
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

  if (gate.checking && !submitted) {
    return (
      <div className="min-h-screen grid place-items-center bg-muted/30">
        {onboardingHead}
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (gate.blocked && !submitted) {
    const repaying = gate.stage === 'repaying';
    const when = gate.created_at
      ? new Date(gate.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      : null;
    return (
      <div className="min-h-screen bg-muted/30 px-4 py-10">
        {onboardingHead}
        <div className="mx-auto max-w-md space-y-5">
          <img src={welileLogo} alt="Welile" className="h-8" />
          <Card>
            <CardContent className="space-y-5 p-6 text-center">
              <span className={cn(
                'mx-auto grid h-16 w-16 place-items-center rounded-full',
                repaying ? 'bg-emerald-100 dark:bg-emerald-900/40' : 'bg-amber-100 dark:bg-amber-900/40',
              )}>
                {repaying
                  ? <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
                  : <Clock className="h-8 w-8 text-amber-600 dark:text-amber-400" />}
              </span>
              <div>
                <h1 className="text-2xl font-extrabold tracking-tight">
                  {repaying ? 'You already have a Rent Plan' : 'Your request is under review'}
                </h1>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {repaying
                    ? 'Your rent has already been paid to your landlord and you are repaying that plan now. You can only ask for rent support again once this plan is fully paid off.'
                    : `We already have your request${when ? ` from ${when}` : ''} and our team is checking your details. Please wait for us to come back to you — sending it again does not make it faster.`}
                </p>
                {gate.other_account && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    This request is held on an account using the same phone number or email as yours.
                  </p>
                )}
              </div>
              <Button className="w-full" onClick={() => navigate('/dashboard/tenant')}>
                {repaying ? 'See my Rent Plan' : 'Track my request'}
              </Button>
              <p className="text-xs text-muted-foreground">
                Questions? Call {SUPPORT_PHONE_DISPLAY} or email {SUPPORT_EMAIL}.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (submitted) {
    const ref = submitted.id.slice(0, 8).toUpperCase();
    return (
      <div className="min-h-screen bg-muted/30 px-4 py-10">
        {onboardingHead}
        <div className="mx-auto max-w-xl space-y-5">
          <img src={welileLogo} alt="Welile" className="h-8" />

          <Card>
            <CardContent className="space-y-5 p-6">
              <div className="text-center">
                <span className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full bg-emerald-100 dark:bg-emerald-900/40">
                  <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
                </span>
                <span className="mb-2 inline-block rounded-full border bg-muted px-3 py-1 text-xs font-bold tabular-nums text-muted-foreground">
                  Reference {ref}
                </span>
                <h1 className="text-2xl font-extrabold tracking-tight">Request sent</h1>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  We have everything we need from you for now, {firstName || 'there'}. Nothing is paid out yet —
                  Welile will check your details and come back to you on {phone || 'your phone'}.
                </p>
              </div>

              <div className="rounded-xl border bg-background p-4">
                <p className="mb-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  Your Rent Plan
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <ReviewItem label="Rent requested" value={formatUGX(rentAmount)} money />
                  <ReviewItem label="Repayment period" value={`${durationDays} days`} />
                  <ReviewItem label={`${periodLabel} payment`}
                    value={`${formatUGX(perCycle)}/${earner === 'weekly' ? 'week' : 'day'}`} money />
                  <ReviewItem label="Total to repay" value={calc ? formatUGX(calc.totalRepayment) : '—'} money />
                </div>
              </div>

              <div className="rounded-xl border bg-background p-4">
                <p className="mb-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  What happens next
                </p>
                <ol className="space-y-3">
                  {[
                    { t: 'Request received', d: 'Saved against your profile.', done: true },
                    { t: 'Welile checks your details', d: 'Your ID, your home, your landlord and your LC1.', done: false },
                    { t: 'Your landlord is paid', d: 'Once checks pass, rent goes straight to your landlord.', done: false },
                    { t: 'You start repaying', d: `The day after your landlord is paid — ${formatUGX(perCycle)} per ${earner === 'weekly' ? 'week' : 'day'}.`, done: false },
                  ].map((row, i) => (
                    <li key={row.t} className="flex gap-3">
                      <span className={cn(
                        'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold',
                        row.done
                          ? 'bg-emerald-600 text-white'
                          : 'border-2 border-border bg-muted text-muted-foreground',
                      )}>
                        {row.done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13.5px] font-bold text-foreground">{row.t}</span>
                        <span className="block text-xs text-muted-foreground">{row.d}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>

              <Button className="w-full" onClick={() => navigate('/dashboard/tenant')}>
                Go to my dashboard
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Questions? Call {SUPPORT_PHONE_DISPLAY} or email {SUPPORT_EMAIL}.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const current = STEPS[step - 1];

  return (
    <div className="min-h-screen bg-muted/30">
      {onboardingHead}
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

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="National ID (NIN)" required hint="10 to 14 letters and numbers, exactly as on your card.">
                    <Input value={nin} onChange={(e) => setNin(e.target.value.toUpperCase())} placeholder="CM9001234567AB" className="font-mono" />
                    {!idCheck.checking && idCheck.nin_is_you && <Hint icon={CheckCircle2} tone="ok">This National ID matches your account.</Hint>}
                    {!idCheck.checking && ninTakenByOther && <Hint icon={AlertTriangle} tone="bad">This National ID is already registered to another account. Please check the number.</Hint>}
                  </Field>

                  <Field label="Name exactly as printed on the National ID" hint="Optional — only if using someone else's ID">
                    <Input
                      value={nationalIdName}
                      onChange={(e) => setNationalIdName(e.target.value)}
                      placeholder="e.g. Mugisha Robert"
                    />
                  </Field>
                </div>

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
                  <div className="space-y-2">
                    <PhotoBox label="Passport photo" required hint="Clear face photo, no hat"
                      slot={tenantPhoto} onPick={(f) => addPhoto(f, 'tenant')}
                      onClear={() => { setTenantPhoto(null); setPhotoCheck(null); }} />
                    {photoCheck?.checking && (
                      <Hint icon={Loader2} spin>Checking your photo…</Hint>
                    )}
                    {!photoCheck?.checking && photoCheck?.error && (
                      <Hint icon={Info}>We could not check this photo now. You can still continue.</Hint>
                    )}
                    {!photoCheck?.checking && !photoCheck?.error && photoCheck?.is_face === false && (
                      <Hint icon={AlertTriangle} tone="bad">No face was found in this photo. Please retake it.</Hint>
                    )}
                    {!photoCheck?.checking && !photoCheck?.error && photoCheck?.is_face && (
                      <>
                        {photoCheck.verdict === 'pass'
                          ? <Hint icon={CheckCircle2} tone="ok">Good passport photo.</Hint>
                          : <Hint icon={AlertTriangle} tone={photoCheck.verdict === 'fail' ? 'bad' : undefined}>
                              {photoCheck.verdict === 'fail'
                                ? 'This photo is not good enough. Please retake it.'
                                : 'This photo may need a second look. You can retake it or continue.'}
                            </Hint>}
                        {(photoCheck.failures ?? []).slice(0, 3).map((f) => (
                          <Hint key={f.id} icon={Info}>{f.advice || f.label}</Hint>
                        ))}
                      </>
                    )}
                  </div>
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
              <div className="space-y-3.5">
                <ReviewCard icon={CircleDollarSign} title="Income schedule & rent" onEdit={() => goTo(2)}>
                  <ReviewItem label="Earner category" value={activeEarner.title} />
                  <ReviewItem label="Monthly rent" value={formatUGX(rentAmount)} money />
                  <ReviewItem label="Repayment period" value={`${durationDays} days`} />
                  <ReviewItem label="Instalment amount"
                    value={`${formatUGX(perCycle)}/${earner === 'weekly' ? 'week' : 'day'}`} money />
                  <ReviewItem label="Total to repay" value={calc ? formatUGX(calc.totalRepayment) : '—'} money />
                </ReviewCard>

                <ReviewCard icon={User} title="About you" onEdit={() => goTo(3)}>
                  <ReviewItem label="Full name" value={`${firstName} ${lastName}`.trim() || '—'} />
                  <ReviewItem label="Phone number" value={phone || '—'} numeric />
                  <ReviewItem label="National ID (NIN)" value={cleanNin(nin) || '—'} numeric />
                  <ReviewItem label="Language" value={language} />
                  <ReviewItem label="Passport photo" value={tenantPhoto ? 'Captured' : 'Missing'} ok={!!tenantPhoto} />
                  <ReviewItem label="National ID photo" value={idPhoto ? 'Captured' : 'Missing'} ok={!!idPhoto} />
                </ReviewCard>

                <ReviewCard icon={Home} title="Your home" onEdit={() => goTo(4)}>
                  <ReviewItem label="House type"
                    value={HOUSE_TYPES.find((h) => h.value === houseType)?.label ?? houseType} />
                  <ReviewItem label="Address" value={address || '—'} />
                  <ReviewItem label="Village" value={location?.fullPath ?? '—'} />
                  <ReviewItem
                    label="Verification evidence"
                    value={gps
                      ? `GPS confirmed (${housePhotos.length} photo${housePhotos.length === 1 ? '' : 's'})`
                      : `${housePhotos.length} photo${housePhotos.length === 1 ? '' : 's'}, no GPS`}
                    ok={!!gps && housePhotos.length > 0}
                  />
                </ReviewCard>

                <ReviewCard icon={ShieldCheck} title="Landlord & local verification" onEdit={() => goTo(5)}>
                  <ReviewItem label="Landlord" value={chosenLandlord?.name ?? '—'} />
                  <ReviewItem
                    label="Landlord status"
                    value={chosenLandlord
                      ? (chosenLandlord.verified ? 'Verified' : chosenLandlord.isNew ? 'New — to be vetted' : 'To be vetted')
                      : '—'}
                    ok={!!chosenLandlord?.verified}
                  />
                  <ReviewItem label="LC1 chairperson" value={lc1?.name || '—'} />
                  <ReviewItem label="LC1 phone" value={lc1?.phone || '—'} numeric />
                  <ReviewItem label="LC1 letter" value={lcLetter ? 'Attached' : 'Not attached'} ok={!!lcLetter} />
                </ReviewCard>

                <label className="flex cursor-pointer items-start gap-3 rounded-xl border bg-muted/40 p-4">
                  <Checkbox
                    checked={declared}
                    onCheckedChange={(v) => setDeclared(v === true)}
                    className="mt-0.5 shrink-0"
                  />
                  <span className="text-[13px] leading-relaxed text-muted-foreground">
                    I confirm the information above is correct, and I understand my rent support application will be
                    reviewed by Welile and an assigned agent. Nothing is paid out at this step.
                  </span>
                </label>

                {!declared && (
                  <p className="flex items-center gap-1.5 text-[12.5px] font-bold text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    Tick the box above to submit your application.
                  </p>
                )}

                {/* A failure has to survive the toast — tenants miss those. */}
                {submitError && (
                  <div className="flex items-start gap-2.5 rounded-xl border border-destructive/40 bg-destructive/5 p-3.5">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <div className="min-w-0">
                      <p className="text-[13px] font-bold text-destructive">Your request was not sent</p>
                      <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{submitError}</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between gap-3 border-t pt-4">
              <Button type="button" variant="secondary" disabled={step === 1 || submitting}
                onClick={() => goTo(step - 1)}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              {step < 6 ? (
                <Button type="button" onClick={goNext} disabled={!!stepError(step)}>
                  Continue <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              ) : (
                <Button type="button" onClick={() => submit()} disabled={submitting || !declared}
                  className="min-w-[215px]">
                  {submitting
                    ? <Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin" />
                    : <Check className="mr-2 h-4 w-4 shrink-0" />}
                  {/* Each stage rises into place, so a slow upload reads as
                      progress rather than a hang. Clipping happens on the
                      inline-block wrapper, which is sized by its own content —
                      it can never collapse the label to zero height. */}
                  <span className="inline-block overflow-hidden align-middle">
                    <span key={submitting ? submitPhase : -1} className="inline-block animate-submit-rise">
                      {submitting ? SUBMIT_PHASES[submitPhase] : 'Submit rent request'}
                    </span>
                  </span>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </main>

      <NationalIdConsentDialog
        open={consentModalOpen}
        onOpenChange={setConsentModalOpen}
        stage={consentStage}
        declarationId={consentDeclarationId}
        errorMessage={consentErrorMessage}
        idOwnerName={nationalIdName}
        registrantName={`${firstName.trim()} ${lastName.trim()}`.trim()}
        initialOwnerPhone={consentOwnerPhone}
        submitting={consentSubmitting}
        onSubmitPhone={async (ownerPhone) => {
          setConsentOwnerPhone(ownerPhone);
          await submit({ id_owner_phone: ownerPhone });
        }}
        onSubmitCode={async (consentCode) => {
          await submit({
            id_owner_phone: consentOwnerPhone,
            consent_declaration_id: consentDeclarationId || undefined,
            consent_code: consentCode,
          });
        }}
        onResendCode={async () => {
          await submit({ id_owner_phone: consentOwnerPhone });
        }}
      />
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

/**
 * Pull the real message out of a Supabase Functions error.
 *
 * `FunctionsHttpError.context` is a Response, so `context.body` is a
 * ReadableStream — stringifying it produced the literal "[object ReadableStream]"
 * that tenants were being shown instead of the reason their request failed.
 */
async function readFunctionError(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown })?.context;
  if (ctx instanceof Response) {
    try {
      const text = await ctx.clone().text();
      if (text) {
        try {
          const parsed = JSON.parse(text);
          const inner = parsed?.error ?? parsed?.message;
          if (typeof inner === 'string' && inner.trim()) return inner;
        } catch { /* not JSON — the raw text is still better than nothing */ }
        return text;
      }
    } catch { /* body already consumed or unreadable */ }
  }
  return (error as { message?: string })?.message || 'The request could not be sent.';
}

/** Turn a raw backend message into something a tenant can act on. */
function humaniseSubmitError(raw?: string | null): string {
  const msg = (raw || '').trim();
  if (!msg) return 'Something went wrong. Please check your connection and try again.';

  // Unwrap "Could not post your rent request: <reason>" style prefixes.
  const reason = msg.includes(':') ? msg.slice(msg.indexOf(':') + 1).trim() || msg : msg;
  const hay = `${msg} ${reason}`.toLowerCase();

  if (hay.includes('passport photo')) {
    return 'Your passport photo did not reach us. Go back to "About you", retake it, then submit again.';
  }
  if (hay.includes('national id is already registered')) {
    return 'That National ID is already registered to another account. Check the number in "About you".';
  }
  if (hay.includes('phone number is already registered')) {
    return 'That phone number is already registered to another account. Sign in with it instead.';
  }
  if (hay.includes('already have a rent request')) {
    return 'You already have a rent request in progress. You can follow it from your dashboard.';
  }
  if (hay.includes('landlord')) return `Landlord details could not be saved. ${reason}`;
  if (hay.includes('lc1')) return `LC1 chairperson details could not be saved. ${reason}`;
  if (hay.includes('failed to fetch') || hay.includes('networkerror')) {
    return 'We could not reach Welile. Check your internet connection and try again — your answers are saved.';
  }
  return reason;
}

/** One reviewable section: icon, title, an Edit link back to its step, and a
 *  two-column grid of answers — the template's summary-section-box. */
function ReviewCard({ icon: Icon, title, onEdit, children }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  onEdit: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 transition-colors hover:border-primary/30 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3 border-b pb-2.5">
        <p className="flex min-w-0 items-center gap-2 text-[13.5px] font-bold text-foreground">
          <Icon className="h-[15px] w-[15px] shrink-0 text-primary" />
          <span className="truncate">{title}</span>
        </p>
        <button type="button" onClick={onEdit}
          className="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-bold text-primary hover:underline">
          <Pencil className="h-3 w-3" />
          Edit
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </div>
  );
}

/** Label above value. `money` tints it primary, `numeric` gives tabular figures,
 *  `ok` renders a captured/attached state in green (or red when missing). */
function ReviewItem({ label, value, money, numeric, ok }: {
  label: string; value: string; money?: boolean; numeric?: boolean; ok?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn(
        'mt-0.5 truncate text-[13.5px] font-bold',
        money && 'tabular-nums text-primary',
        numeric && !money && 'tabular-nums',
        ok === true && 'text-emerald-600 dark:text-emerald-400',
        ok === false && 'text-destructive',
        !money && ok === undefined && 'text-foreground',
      )}>
        {value}{ok === true ? ' ✓' : ''}
      </span>
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
  icon: React.ElementType; children: React.ReactNode; tone?: 'ok' | 'bad'; spin?: boolean;
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
      <input type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" capture="environment" className="hidden"
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
          <input type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" capture="environment" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.currentTarget.value = ''; }} />
        </label>
      )}
    </div>
  );
}
