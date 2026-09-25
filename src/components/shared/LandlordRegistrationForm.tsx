import { useState, useMemo, useEffect } from 'react';
import {
  emptyLandlordAgreementInline,
  LandlordAgreementInlineFields,
  type LandlordAgreementInlineValue,
} from '@/components/landlord/agreement/LandlordAgreementInlineFields';

import { submitLandlordAgreementFile, twelveMonthEndDate } from '@/lib/landlordAgreementSubmit';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useCaptureLocation } from '@/hooks/useCaptureLocation';
import { useSimilarContacts, describeSimilarContact } from '@/hooks/useSimilarContacts';
import { Button } from '@/components/ui/button';
import { formatUgandaPhone, cleanPhoneNumber, toUgandaLocalDigits } from '@/lib/phoneUtils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Building2, Phone, MapPin, Loader2, CheckCircle2,
  Navigation, AlertTriangle, Share2, Eye, EyeOff,
  RefreshCw, Copy, User, Hash, Zap, Droplets, ListChecks,
  Wallet, ShieldCheck, XCircle, Home, ChevronDown, ChevronUp,
} from 'lucide-react';
import { ListEmptyHouseDialog } from '@/components/agent/ListEmptyHouseDialog';
import { hapticTap, hapticWarning } from '@/lib/haptics';
import { useListingDaytimeGuard } from '@/hooks/useListingDaytimeGuard';
import FormStepHeader from '@/components/shared/FormStepHeader';
import { LandlordAutocompleteInput } from '@/components/agent/LandlordAutocompleteInput';
import type { LandlordOption } from '@/components/agent/LandlordSearchSelect';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import {
  validateFullName,
  joinPersonName,
  splitPersonName,
  validatePersonNameParts,
  type PersonNameParts,
} from '@/lib/authValidation';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import { ugLocationLabel, type UgLocationSelection } from '@/hooks/useUgLocations';

const HOUSE_CATEGORIES = [
  'Single Room', 'Double Room', 'Bedsitter', 'One Bedroom',
  'Two Bedroom', 'Three Bedroom', 'Shop / Lock-up Shop', 'Market Stall',
  'Kiosk / Container', 'Salon / Workshop', 'Office Space', 'Warehouse / Store',
  'Other Commercial Premises', 'Mixed',
];

interface LandlordRegistrationFormProps {
  registeredByRole: 'agent' | 'tenant';
  /**
   * Called after the landlord is saved. Receives the freshly registered
   * landlord so callers (e.g. the rent request flow) can immediately select
   * it — enforcing the rule that a landlord must be registered first.
   */
  onSuccess?: (landlord?: {
    id: string;
    name: string;
    phone: string;
    property_address: string | null;
    district?: string | null;
    town_council?: string | null;
    county?: string | null;
    village?: string | null;
    house_category?: string | null;
    monthly_rent?: number | null;
    latitude?: number | null;
    longitude?: number | null;
  }) => void;
  onClose: () => void;
  toastFn: (opts: {
    title: string;
    description?: string;
    variant?: 'destructive' | 'default';
    action?: { label: string; onClick: () => void };
  }) => void;
  /**
   * Minimal mode (used by the Outstanding Balance tenant flow).
   * Only requires: Landlord Name, Landlord Phone, LC1 Name, LC1 Phone.
   * All other fields (address, GPS, MoMo, meters, password) are hidden /
   * auto-handled.
   */
  minimal?: boolean;
}

export default function LandlordRegistrationForm({
  registeredByRole,
  onSuccess,
  onClose,
  toastFn,
  minimal = false,
}: LandlordRegistrationFormProps) {
  const { user } = useAuth();
  const { location, loading: locationLoading, error: locationError, captureLocation } = useCaptureLocation();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  // Two-step flow: Step 1 = enter name & phone, Step 2 = confirm & register.
  const [step, setStep] = useState<1 | 2>(1);
  // Inline stepped progress message shown while saving so the agent always
  // sees forward motion, even on a weak connection.
  const [progressMsg, setProgressMsg] = useState('');
  // Inline error state when the submission itself fails (network, DB, etc.)
  const [submitError, setSubmitError] = useState('');
  const [showListHouse, setShowListHouse] = useState(false);
  const guardListingHours = useListingDaytimeGuard();
  const [activationLink, setActivationLink] = useState('');
  // Id of the landlord just created, used to deep-link to its record.
  const [registeredLandlordId, setRegisteredLandlordId] = useState<string | null>(null);
  const [agreementDetails, setAgreementDetails] = useState<LandlordAgreementInlineValue>(emptyLandlordAgreementInline);
  const [locationCaptured, setLocationCaptured] = useState(false);
  // Optional details are tucked away so the core flow is just Name + Phone.
  const [showMore, setShowMore] = useState(false);

  // Inline validation errors
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Pre-save duplicate-phone check state (runs on blur, before submit)
  const [checkingPhone, setCheckingPhone] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);

  // Pure validation — no side effects, safe to call during render.
  const computeFieldError = (name: string, value: string) => {
    const trimmed = value.trim();
    let msg = '';
    if (name === 'landlordName') {
      // Pragmatic gate for field capture: two name parts, letters only.
      // Ugandan surnames trip the stricter gibberish heuristics, which made
      // valid names read as "enter a full name" even after being typed.
      if (!trimmed) msg = 'Landlord name is required';
      else {
        const parts = trimmed.split(/\s+/).filter((p) => p.replace(/[^a-zA-Z]/g, '').length > 0);
        if (/[0-9@#$%^&*_=+<>{}\[\]\\\/|~`"]/.test(trimmed)) {
          msg = 'Use letters only — no digits or symbols.';
        } else if (parts.length < 2) {
          msg = 'Add a surname too, e.g. John Ssentamu.';
        } else if (parts.some((p) => p.replace(/[^a-zA-Z]/g, '').length < 2)) {
          msg = 'Each name needs at least 2 letters.';
        }
      }
    }
    if (name === 'landlordPhone') {
      if (!trimmed) msg = 'Phone number is required';
      else if (!/^\d{9,10}$/.test(toUgandaLocalDigits(trimmed))) msg = 'Enter a valid Ugandan number, e.g. 0771 234 567.';
    }
    if (name === 'propertyAddress') {
      // Address is optional now — only validate when something was typed.
      if (trimmed && trimmed.length < 5) msg = 'Address looks too short — add a bit more detail.';
    }
    if (name === 'lc1Name') {
      if (!trimmed) msg = 'LC1 name is required';
      else {
        const r = validatePersonNameParts(splitPersonName(trimmed));
        if (!r.valid) msg = r.error || 'Enter the LC1 chairperson\u2019s real full name.';
      }
    }
    if (name === 'lc1Phone') {
      if (!trimmed) msg = 'LC1 phone is required';
      else if (!/^\d{9,10}$/.test(toUgandaLocalDigits(trimmed))) msg = 'Enter a valid Ugandan number, e.g. 0771 234 567.';
    }
    return msg;
  };

  // Validate + persist to error state. Returns the message.
  const validateField = (name: string, value: string) => {
    const msg = computeFieldError(name, value);
    setErrors((prev) => ({ ...prev, [name]: msg }));
    return msg;
  };

  const clearError = (name: string) => {
    setErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const clearSubmitError = () => setSubmitError('');

  // Pre-save check: verify the landlord isn't already registered BEFORE the
  // agent taps Register. Matches on BOTH the phone number AND the landlord's
  // name (case-insensitive, whitespace-normalized) so duplicate records are
  // never created. Surfaces the exact field error inline.
  // Returns true when the landlord is free to register.
  const checkPhoneAvailable = async (rawValue: string): Promise<boolean> => {
    const formatError = validateField('landlordPhone', toUgandaLocalDigits(rawValue));
    if (formatError) {
      setPhoneVerified(false);
      return false;
    }
    const phoneClean = toUgandaLocalDigits(rawValue);
    setCheckingPhone(true);
    setPhoneVerified(false);
    try {
      const { data, error } = await supabase
        .rpc('find_landlord_duplicate', {
          p_name: landlordName.trim(),
          p_phone: phoneClean,
        });
      if (error) {
        // Network/DB hiccup — don't block; the submit-time check is the backstop.
        return true;
      }
      if (Array.isArray(data) && data.length > 0) {
        const match = data[0] as { name?: string; matched_on?: string };
        const matchedOn = match.matched_on ?? 'phone';
        const who = match.name ? `"${match.name}"` : 'this landlord';
        if (matchedOn === 'name') {
          setErrors((prev) => ({
            ...prev,
            landlordName:
              `A landlord named ${who} already exists. Search and reuse them instead of registering a duplicate.`,
          }));
        } else {
          setErrors((prev) => ({
            ...prev,
            landlordPhone:
              'Registration failed. A landlord with this phone number is already registered.',
          }));
        }
        setPhoneVerified(false);
        return false;
      }
      setPhoneVerified(true);
      return true;
    } finally {
      setCheckingPhone(false);
    }
  };

  // Scroll to and focus the input inside a given [data-field] wrapper so the
  // agent is taken straight to the field that needs their attention.
  const focusField = (name: string) => {
    requestAnimationFrame(() => {
      const wrapper = document.querySelector(`[data-field="${name}"]`);
      wrapper?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const input = wrapper?.querySelector(
        'input, textarea, select'
      ) as HTMLElement | null;
      input?.focus();
    });
  };

  // Core fields
  const [landlordName, setLandlordName] = useState('');
  const [landlordPhone, setLandlordPhone] = useState('');
  const [propertyAddress, setPropertyAddress] = useState('');
  // Official Uganda administrative location (region → village) from the shared
  // ug_* dataset. Mandatory: it replaces every free-text location guess and is
  // what lets us drop the old village: 'To be confirmed' placeholder.
  const [ugLoc, setUgLoc] = useState<UgLocationSelection | null>(null);
  const [ugLocError, setUgLocError] = useState<string | null>(null);

  // Fuzzy duplicate detection. The existing find_landlord_duplicate check is
  // exact-match only, so "Walyomu Michael" and "Walyoumu Micheal" read as two
  // different people. This catches the near misses, scoped by the official
  // location the agent has already picked.
  // The hook also returns `matches` and `checking` for a richer
  // "here are the near matches, reuse one" panel when that is designed.
  const { blocking: blockingLandlordMatch } = useSimilarContacts({
    kind: 'landlord',
    name: landlordName,
    villageId: ugLoc?.villageId ?? null,
    village: ugLoc?.village ?? null,
    district: ugLoc?.district ?? null,
  });
  const [numberOfRentals, setNumberOfRentals] = useState('');
  const [houseCategory, setHouseCategory] = useState('');

  // LC1 (only collected in minimal/outstanding mode)
  // Captured in parts, submitted as the same single `name` string.
  const [lc1NameParts, setLc1NameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const lc1Name = joinPersonName(lc1NameParts);
  const setLc1Name = (next: string) => setLc1NameParts(splitPersonName(next));
  const [lc1Phone, setLc1Phone] = useState('');

  // Mobile Money
  const [momoName, setMomoName] = useState('');
  const [momoNumber, setMomoNumber] = useState('');
  // Optional bank details (additive — never required, never validated as a set)
  const [bankName, setBankName] = useState('');
  const [bankBranch, setBankBranch] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankAccountName, setBankAccountName] = useState('');


  // Utility meters
  const [nwscMeter, setNwscMeter] = useState('');
  const [uedclMeter, setUedclMeter] = useState('');

  // Password
  const [tempPassword, setTempPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const generateTempPassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setTempPassword(result);
    return result;
  };

  // In minimal mode, auto-generate the temp password silently so the user
  // never has to interact with it.
  useEffect(() => {
    if (minimal && !tempPassword) {
      generateTempPassword();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minimal]);

  // ── Tap-to-reuse existing landlords ──────────────────────────────────────
  // The shared `LandlordAutocompleteInput` typeahead (used across every
  // rent-request and listing form) surfaces matching landlords directly inside
  // the name/phone fields as the agent types. Tapping one reuses that record
  // instead of registering a duplicate — a verified landlord reused this way
  // never has to be verified again.

  // Reuse an existing landlord instead of registering a duplicate. A verified
  // landlord passed back this way is selected immediately by the caller (e.g.
  // the rent request flow) and never needs re-verification.
  const useExistingLandlord = (l: LandlordOption) => {
    hapticTap();
    toastFn({
      title: l.verified ? 'Verified landlord selected' : 'Landlord selected',
      description: l.verified
        ? `${l.name} is already verified — no need to register or verify again.`
        : `${l.name} is already in the system.`,
    });
    onSuccess?.({
      id: l.id,
      name: l.name,
      phone: l.phone,
      property_address: l.property_address ?? null,
      district: l.district ?? null,
      town_council: l.town_council ?? null,
      county: l.county ?? null,
      village: l.village ?? null,
      house_category: l.house_category ?? null,
      monthly_rent: l.monthly_rent ?? null,
      latitude: l.latitude ?? null,
      longitude: l.longitude ?? null,
    });
    onClose();
  };

  // Single tap-target used by the shared typeahead in both name and phone
  // fields. In the minimal Outstanding-Balance flow we only autofill (LC1
  // capture must still happen), otherwise we reuse the existing record.
  const handleLandlordPick = (l: LandlordOption) => {
    if (minimal) {
      setLandlordName(l.name || '');
      setLandlordPhone(formatUgandaPhone(l.phone || ''));
      clearError('landlordName');
      clearError('landlordPhone');
      return;
    }
    useExistingLandlord(l);
  };

  // Name matching logic
  const nameMatchScore = useMemo(() => {
    if (!landlordName.trim() || !momoName.trim()) return null;
    const a = landlordName.trim().toLowerCase().split(/\s+/);
    const b = momoName.trim().toLowerCase().split(/\s+/);
    const matched = a.filter(w => b.includes(w)).length;
    const total = Math.max(a.length, b.length);
    return total > 0 ? Math.round((matched / total) * 100) : 0;
  }, [landlordName, momoName]);

  // Qualification score
  const qualificationScore = useMemo(() => {
    let score = 0;
    const max = 100;
    if (landlordName.trim()) score += 10;
    if (landlordPhone.trim()) score += 10;
    if (propertyAddress.trim()) score += 10;
    if (numberOfRentals && parseInt(numberOfRentals) > 0) score += 10;
    if (houseCategory) score += 5;
    if (locationCaptured) score += 15;
    if (momoName.trim() && momoNumber.trim()) score += 10;
    if (nameMatchScore !== null && nameMatchScore >= 80) score += 10;
    if (nwscMeter.trim()) score += 10;
    if (uedclMeter.trim()) score += 10;
    return Math.min(score, max);
  }, [landlordName, landlordPhone, propertyAddress, numberOfRentals, houseCategory, locationCaptured, momoName, momoNumber, nameMatchScore, nwscMeter, uedclMeter]);

  // Live required-field checklist so the agent sees exactly what's still
  // missing or invalid BEFORE tapping Next/Register. `computeFieldError` is
  // pure, so this is safe to derive during render.
  const requiredChecklist = useMemo(() => {
    const items: { name: string; label: string; ok: boolean; error: string }[] = [
      {
        name: 'landlordName',
        label: 'Landlord name',
        error: computeFieldError('landlordName', landlordName),
        ok: !computeFieldError('landlordName', landlordName),
      },
      {
        name: 'landlordPhone',
        label: 'Phone number',
        error: computeFieldError('landlordPhone', landlordPhone),
        ok: !computeFieldError('landlordPhone', landlordPhone),
      },
    ];
    if (minimal) {
      items.push(
        {
          name: 'lc1Name',
          label: 'LC1 chairperson name',
          error: computeFieldError('lc1Name', lc1Name),
          ok: !computeFieldError('lc1Name', lc1Name),
        },
        {
          name: 'lc1Phone',
          label: 'LC1 chairperson phone',
          error: computeFieldError('lc1Phone', lc1Phone),
          ok: !computeFieldError('lc1Phone', lc1Phone),
        },
      );
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landlordName, landlordPhone, lc1Name, lc1Phone, minimal]);

  const missingCount = requiredChecklist.filter((i) => !i.ok).length;

  const resetForm = () => {
    setLandlordName(''); setLandlordPhone(''); setPropertyAddress('');
    setNumberOfRentals(''); setHouseCategory('');
    setMomoName(''); setMomoNumber('');
    setNwscMeter(''); setUedclMeter('');
    setTempPassword(''); setShowPassword(false);
    setSuccess(false); setActivationLink(''); setRegisteredLandlordId(null); setLocationCaptured(false);
    setAgreementDetails(emptyLandlordAgreementInline);
    setStep(1);
  };

  // Step 1 → Step 2: validate the essentials and confirm the phone is available
  // before advancing to the confirmation step.
  const handleNext = async () => {
    if (!user) return;

    const fieldsToValidate: { name: string; value: string }[] = [
      { name: 'landlordName', value: landlordName },
      { name: 'landlordPhone', value: landlordPhone },
    ];
    if (minimal) {
      fieldsToValidate.push(
        { name: 'lc1Name', value: lc1Name },
        { name: 'lc1Phone', value: lc1Phone }
      );
    }

    const newErrors: Record<string, string> = {};
    for (const { name, value } of fieldsToValidate) {
      const msg = validateField(name, value);
      if (msg) newErrors[name] = msg;
    }

    if (Object.keys(newErrors).length > 0) {
      const firstError = Object.keys(newErrors)[0];
      if (!['landlordName', 'landlordPhone', 'lc1Name', 'lc1Phone'].includes(firstError)) {
        setShowMore(true);
      }
      hapticWarning();
      focusField(firstError);
      toastFn({
        title: 'Please fix the errors',
        description: 'Some required fields are missing or invalid.',
        variant: 'destructive',
      });
      return;
    }

    // Confirm the phone number is free before advancing to Step 2.
    if (!ugLoc) {
      setUgLocError('Pick the official location (region → village) from the list.');
      hapticWarning();
      focusField('ugLocation');
      toastFn({
        title: 'Location required',
        description: 'Choose the official village so ops can find this property.',
        variant: 'destructive',
      });
      return;
    }
    // A near-certain duplicate in the same village. Surfaced as a field error
    // rather than a toast so it stays on screen while the agent decides
    // whether to reuse the existing record.
    if (blockingLandlordMatch) {
      setErrors((prev) => ({
        ...prev,
        landlordName: describeSimilarContact(blockingLandlordMatch, 'landlord'),
      }));
      hapticWarning();
      setStep(1);
      focusField('landlordName');
      toastFn({
        title: 'This landlord looks already registered',
        description: describeSimilarContact(blockingLandlordMatch, 'landlord'),
        variant: 'destructive',
      });
      return;
    }

    if (!phoneVerified) {
      const available = await checkPhoneAvailable(landlordPhone);
      if (!available) {
        hapticWarning();
        focusField('landlordPhone');
        toastFn({
          title: 'Check the phone number',
          description: 'This phone is already registered or invalid.',
          variant: 'destructive',
        });
        return;
      }
    }

    // The signed agreement is optional everywhere, including when an agent
    // registers a brand-new landlord. It can be attached later.



    hapticTap();
    setSubmitError('');
    setStep(2);
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!user) return;

    // Inline validate every required field before submit
    const fieldsToValidate: { name: string; value: string }[] = [
      { name: 'landlordName', value: landlordName },
      { name: 'landlordPhone', value: landlordPhone },
    ];
    if (minimal) {
      fieldsToValidate.push(
        { name: 'lc1Name', value: lc1Name },
        { name: 'lc1Phone', value: lc1Phone }
      );
    }

    const newErrors: Record<string, string> = {};
    for (const { name, value } of fieldsToValidate) {
      const msg = validateField(name, value);
      if (msg) newErrors[name] = msg;
    }

    if (Object.keys(newErrors).length > 0) {
      // Reveal the optional section if the only problem hides there, then
      // jump straight to the first broken field so the button never feels dead.
      const firstError = Object.keys(newErrors)[0];
      if (!['landlordName', 'landlordPhone', 'lc1Name', 'lc1Phone'].includes(firstError)) {
        setShowMore(true);
      }
      hapticWarning();
      focusField(firstError);
      toastFn({
        title: 'Please fix the errors',
        description: 'Some required fields are missing or invalid.',
        variant: 'destructive',
      });
      return;
    }

    // Signed agreement stays optional — never blocks registration.



    // Pre-save duplicate check: if the phone hasn't already been verified as
    // free, run the check now and surface the exact field error before saving.
    if (!ugLoc) {
      setUgLocError('Pick the official location (region → village) from the list.');
      hapticWarning();
      setStep(1);
      focusField('ugLocation');
      toastFn({
        title: 'Location required',
        description: 'Choose the official village so ops can find this property.',
        variant: 'destructive',
      });
      return;
    }
    if (!phoneVerified) {
      const available = await checkPhoneAvailable(landlordPhone);
      if (!available) {
        hapticWarning();
        focusField('landlordPhone');
        toastFn({
          title: 'Check the phone number',
          description: 'This phone is already registered or invalid.',
          variant: 'destructive',
        });
        return;
      }
    }

    // Make sure we always have a password to seed the activation invite.
    // It's auto-generated silently so an ordinary agent never has to think
    // about it — they only ever type a name and phone.
    const passwordToUse = tempPassword || generateTempPassword();
    // landlords.property_address is NOT NULL — when no street detail is typed we
    // use the official location path (never a "To be confirmed" placeholder).
    const addressToUse = propertyAddress.trim() || (ugLoc ? ugLocationLabel(ugLoc) : '');

    setLoading(true);
    setProgressMsg('Saving details…');

    // ── Live-session guard ──────────────────────────────────────────────────
    // The RLS INSERT policy on `landlords` is granted to the `authenticated`
    // role only. If the agent's access token has silently expired (very common
    // on mobile after the app has been backgrounded) the request goes out as
    // `anon` and PostgREST rejects it with the cryptic
    // "new row violates row-level security policy" error — even though the UI
    // still shows them logged in. Verify (and refresh) the session here so we
    // either recover automatically or show a clear "sign in again" message
    // instead of a confusing failure.
    try {
      let { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        const { data: refreshed } = await supabase.auth.refreshSession();
        session = refreshed.session;
      }
      if (!session?.access_token || session.user?.id !== user.id) {
        setLoading(false);
        setProgressMsg('');
        const msg = 'Your session has expired. Please sign in again, then register the landlord.';
        setSubmitError(msg);
        hapticWarning();
        toastFn({ title: 'Session expired', description: msg, variant: 'destructive' });
        return;
      }
    } catch {
      setLoading(false);
      setProgressMsg('');
      const msg = 'Could not confirm your session. Please sign in again and try once more.';
      setSubmitError(msg);
      hapticWarning();
      toastFn({ title: 'Session check failed', description: msg, variant: 'destructive' });
      return;
    }

    const landlordPhoneClean = toUgandaLocalDigits(landlordPhone);
    const lc1PhoneClean = toUgandaLocalDigits(lc1Phone);
    const momoNumberClean = cleanPhoneNumber(momoNumber);

    try {
      setProgressMsg('Checking for duplicates…');
      const { data: existingMatches } = await supabase
        .rpc('find_landlord_duplicate', {
          p_name: landlordName.trim(),
          p_phone: landlordPhoneClean,
        });

      if (Array.isArray(existingMatches) && existingMatches.length > 0) {
        const match = existingMatches[0] as { name?: string; matched_on?: string };
        const matchedOn = match.matched_on ?? 'phone';
        const who = match.name ? `"${match.name}"` : 'This landlord';
        const byName = matchedOn === 'name';
        const detail =
          matchedOn === 'name'
            ? `${who} already exists. Search and reuse them instead of registering a duplicate.`
            : 'Registration failed. A landlord with this phone number is already registered.';
        setErrors((prev) => ({
          ...prev,
          [byName ? 'landlordName' : 'landlordPhone']: detail,
        }));
        setSubmitError(detail);
        hapticWarning();
        setStep(1);
        focusField(byName ? 'landlordName' : 'landlordPhone');
        toastFn({ title: 'Already Exists', description: detail, variant: 'destructive' });
        setLoading(false);
        setProgressMsg('');
        return;
      }

      const insertData: Record<string, unknown> = {
        name: landlordName.trim(),
        phone: landlordPhoneClean,
        property_address: addressToUse,
        registered_by: user.id,
        latitude: location?.latitude || null,
        longitude: location?.longitude || null,
        location_captured_at: location ? new Date().toISOString() : null,
        location_captured_by: location ? user.id : null,
        mobile_money_name: momoName.trim() || null,
        mobile_money_number: momoNumberClean || null,
        bank_name: bankName.trim() || null,
        bank_branch: bankBranch.trim() || null,
        account_number: bankAccountNumber.trim() || null,
        bank_account_name: bankAccountName.trim() || null,

        water_meter_number: nwscMeter.trim() || null,
        electricity_meter_number: uedclMeter.trim() || null,
        number_of_houses: numberOfRentals ? parseInt(numberOfRentals) : null,
        house_category: houseCategory || null,
      };

      // Official location — resolved names exactly as spelled in the dataset,
      // plus the village id for a hard link back to the hierarchy.
      if (ugLoc) {
        insertData.region = ugLoc.region ?? null;
        insertData.district = ugLoc.district;
        insertData.county = ugLoc.county;
        insertData.sub_county = ugLoc.subcounty;
        insertData.village = ugLoc.village;
        insertData.ug_village_id = ugLoc.villageId;
      }

      if (registeredByRole === 'tenant') {
        insertData.tenant_id = user.id;
      }

      setProgressMsg('Saving the landlord…');
      const { data: newLandlord, error } = await supabase
        .from('landlords')
        .insert(insertData as any)
        .select('id, name, phone, property_address, latitude, longitude, house_category')
        .single();
      if (error) throw error;
      setRegisteredLandlordId(newLandlord?.id ?? null);

      if (registeredByRole === 'agent' && !minimal && agreementDetails.file) {
        const signedFile = agreementDetails.file;
        setProgressMsg('Saving the signed agreement…');
        const agreementDate = new Date().toISOString().slice(0, 10);
        await submitLandlordAgreementFile({
          landlordId: newLandlord.id,
          file: signedFile,
          details: {
            landlord_name: landlordName.trim(),
            landlord_phone: landlordPhoneClean,
            agreement_date: agreementDate,
            start_date: agreementDate,
            end_date: twelveMonthEndDate(agreementDate),
            property_address: addressToUse,
            // The approved contract does not collect separate rent terms.
            // Keep the existing RPC contract satisfied without adding fields
            // to the normal landlord registration form.
            monthly_rent: '0',
            payment_day: '1',
            landlord_signature_name: landlordName.trim(),
            landlord_signed_on: agreementDate,
            welile_signature_name: 'Welile Technologies Limited',
            welile_signed_on: agreementDate,
            witness_name: 'As named in the signed agreement',
            witness_signed_on: agreementDate,
            house_category: houseCategory || null,
            mobile_money_name: momoName.trim() || null,
            mobile_money_number: momoNumberClean || null,
            water_meter_number: nwscMeter.trim() || null,
            electricity_meter_number: uedclMeter.trim() || null,
          },
        });
      }

      // Persist LC1 chairperson when collected (minimal/outstanding flow).
      if (minimal && lc1Name.trim() && lc1PhoneClean) {
        // Reuse an existing chairperson matched on the normalised phone —
        // inserting a duplicate is refused by the database guard.
        const { data: existingLc1 } = await supabase
          .rpc('find_lc1_by_phone', { p_phone: lc1PhoneClean });
        const lc1Err = ((existingLc1 ?? []) as any[]).length
          ? null
          : (
              await supabase.from('lc1_chairpersons').insert({
                name: lc1Name.trim(),
                phone: lc1PhoneClean,
                village: ugLoc?.village ?? null,
                registered_by: user.id,
              } as any)
            ).error;
        if (lc1Err) {
          console.warn('[LandlordRegistration] LC1 insert failed:', lc1Err);
        }
      }

      // Registration bonus is NOT paid at signup. The full UGX 5,000 is auto-
      // credited by the `pay_landlord_registration_verified_bonus` DB trigger
      // the moment Landlord Ops verifies this landlord. This prevents paying
      // for unverifiable / fake landlords.
      toastFn({
        title: 'Landlord Saved',
        description: 'You earn UGX 5,000 once Landlord Ops verifies this landlord.',
      });

      // Create activation invite
      setProgressMsg('Almost done…');
      const placeholderEmail = `${landlordPhone.trim().replace(/[^0-9]/g, '')}@welile.user`;
      const { data: invite } = await supabase
        .from('supporter_invites')
        .insert({
          created_by: user.id,
          full_name: landlordName.trim(),
          phone: landlordPhoneClean,
          email: placeholderEmail,
          temp_password: passwordToUse,
          role: 'landlord',
          property_address: addressToUse,
          latitude: location?.latitude || null,
          longitude: location?.longitude || null,
          location_accuracy: location?.accuracy || null,
        })
        .select('activation_token')
        .single();

      if (invite) {
        setActivationLink(`${getPublicOrigin()}/join?t=${invite.activation_token}`);
      }

      setSuccess(true);
      toastFn({
        title: 'Landlord Registered!',
        description: agreementDetails.file
          ? 'The signed agreement is attached and ready for verification.'
          : 'The landlord was saved. A signed agreement can be attached when you post a new Rent Request.',
      });
      onSuccess?.(newLandlord ? {
        id: newLandlord.id,
        name: newLandlord.name,
        phone: newLandlord.phone,
        property_address: (newLandlord as any).property_address ?? null,
        district: ugLoc?.district ?? null,
        county: ugLoc?.county ?? null,
        village: ugLoc?.village ?? null,
        house_category: (newLandlord as any).house_category ?? null,
        latitude: (newLandlord as any).latitude ?? null,
        longitude: (newLandlord as any).longitude ?? null,
      } : undefined);
    } catch (err: any) {
      let msg = err?.message || 'Something went wrong while saving. Please try again.';
      // An RLS violation here means the request reached the server without a
      // valid signed-in session (token expired mid-flow) — translate it into a
      // plain "sign in again" instruction instead of the raw policy error.
      if (
        err?.code === '42501' ||
        /row-level security|violates row-level|permission denied/i.test(String(err?.message))
      ) {
        msg = 'Your session has expired. Please sign in again, then register the landlord.';
      }
      setSubmitError(msg);
      hapticWarning();
      // If the failure points at a specific field, drop inline helper text that
      // says exactly what to fix and take the agent straight to it (entered
      // values stay intact). Otherwise the Try Again banner shows.
      const lower = msg.toLowerCase();
      const isDuplicate =
        err?.code === '23505' || lower.includes('duplicate') || lower.includes('already');
      if (isDuplicate && lower.includes('lc1')) {
        setErrors((prev) => ({
          ...prev,
          lc1Phone: 'This LC1 phone is already registered. Enter a different number.',
        }));
        setStep(1);
        focusField('lc1Phone');
      } else if (isDuplicate) {
        const dupMsg = 'Registration failed. A landlord with this phone number is already registered.';
        setErrors((prev) => ({ ...prev, landlordPhone: dupMsg }));
        setSubmitError(dupMsg);
        setStep(1);
        focusField('landlordPhone');
      } else if (lower.includes('phone')) {
        setErrors((prev) => ({
          ...prev,
          landlordPhone: 'Check the phone number — it should be 10 digits like 07XX XXX XXX.',
        }));
        setStep(1);
        focusField('landlordPhone');
      } else if (lower.includes('name')) {
        setErrors((prev) => ({
          ...prev,
          landlordName: "Check the landlord's name — use their full name as on the National ID.",
        }));
        setStep(1);
        focusField('landlordName');
      }
      toastFn({
        title: 'Registration Failed',
        description: msg,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
      setProgressMsg('');
    }
  };

  const shareViaWhatsApp = () => {
    const message = `Hello ${landlordName}, you have been registered on Welile. Tap this link to activate your account:\n\n${activationLink}\n\nJust tap and your account is activated!`;
    const whatsappUrl = `https://wa.me/${landlordPhone.trim().replace(/[^0-9]/g, '')}?text=${encodeURIComponent(message)}`;
    window.open(whatsappUrl, '_blank');
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(activationLink);
      toastFn({ title: 'Link Copied!' });
    } catch {
      toastFn({ title: 'Copy failed', variant: 'destructive' });
    }
  };

  return (
    <>
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
            className="w-16 h-16 mx-auto mb-2 rounded-full bg-success/20 flex items-center justify-center"
          >
            <CheckCircle2 className="h-8 w-8 text-success" />
          </motion.div>
          <h3 className="text-lg font-semibold">Landlord Registered!</h3>
          <p className="text-muted-foreground text-sm">
            {registeredByRole === 'agent'
              ? agreementDetails.file
                ? 'The signed landlord agreement was uploaded and preserved in agreement history.'
                : 'The landlord has been registered. A signed agreement can be attached when you post a new Rent Request.'
              : 'The landlord has been registered successfully.'}
          </p>

          {registeredByRole === 'agent' && agreementDetails.file && (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" /> Signed agreement uploaded and preserved in history.
            </div>
          )}

          {/* Qualification Score */}
          <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
            <p className="text-xs text-muted-foreground mb-1">Qualification Score</p>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${qualificationScore >= 80 ? 'bg-success' : qualificationScore >= 50 ? 'bg-warning' : 'bg-destructive'}`}
                  style={{ width: `${qualificationScore}%` }}
                />
              </div>
              <span className="text-sm font-bold">{qualificationScore}%</span>
            </div>
          </div>

          {activationLink && (
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-muted/50 border text-xs break-all text-left text-muted-foreground">
                {activationLink}
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => { hapticTap(); shareViaWhatsApp(); }}
                  className="flex-1 h-12 bg-green-600 hover:bg-green-700 text-white touch-manipulation select-none transition-transform active:scale-[0.98]"
                >
                  <Share2 className="h-4 w-4 mr-2" />
                  WhatsApp
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { hapticTap(); copyLink(); }}
                  className="h-12 gap-2 touch-manipulation select-none transition-transform active:scale-[0.98]"
                >
                  <Copy className="h-4 w-4" />
                  Copy
                </Button>
              </div>
            </div>
          )}

          {success && (
            <Button
              onClick={() => { hapticTap(); resetForm(); }}
              className="w-full h-14 text-base font-semibold gap-2 touch-manipulation select-none transition-transform active:scale-[0.98]"
            >
              <Building2 className="h-5 w-5" /> Register Another Landlord
            </Button>
          )}

          {registeredByRole === 'agent' && registeredLandlordId && (() => {
            const recordLink = `${window.location.origin}/dashboard/agent?submission=${registeredLandlordId}&type=landlord`;
            return (
              <div className="rounded-lg border bg-muted/40 p-2.5 text-left space-y-2">
                <p className="text-[11px] font-semibold text-muted-foreground">Direct link to this landlord</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate text-[11px] text-foreground/80">{recordLink}</code>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 shrink-0"
                    onClick={async () => {
                      hapticTap();
                      try {
                        await navigator.clipboard.writeText(recordLink);
                        toastFn({ title: 'Link copied', description: 'Opens straight to this landlord record.' });
                      } catch {
                        toastFn({ title: 'Could not copy link', variant: 'destructive' });
                      }
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy
                  </Button>
                </div>
              </div>
            );
          })()}

          {success && registeredByRole === 'agent' && (
            <Button
              variant="secondary"
              onClick={() => {
                hapticTap();
                onClose();
                window.dispatchEvent(new CustomEvent('open-submissions', { detail: { tab: 'landlords', recordId: registeredLandlordId } }));
              }}
              className="w-full h-12 gap-2 touch-manipulation select-none transition-transform active:scale-[0.98]"
            >
              <ListChecks className="h-5 w-5" /> View my submissions
            </Button>
          )}

          {success && (
            <Button
              variant="outline"
              onClick={() => { hapticTap(); onClose(); }}
              className="w-full h-12 touch-manipulation select-none transition-transform active:scale-[0.98]"
            >
              Done
            </Button>
          )}
        </motion.div>
      ) : (
        <motion.form
          key="form"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          onSubmit={handleSubmit}
          className="space-y-4"
        >
          {/* Step-by-step progress indicator */}
          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-semibold transition-colors ${step === 1 && !success ? 'bg-primary/15 text-primary border border-primary/25' : 'bg-muted text-muted-foreground border border-muted'}`}>
              <span className={`flex items-center justify-center w-4 h-4 rounded-full text-[9px] ${step === 1 && !success ? 'bg-primary text-primary-foreground' : 'bg-muted-foreground/20 text-muted-foreground'}`}>1</span>
              Name &amp; Phone
            </div>
            <div className="flex-1 h-px bg-border" />
            <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-semibold transition-colors ${step === 2 || success ? (success ? 'bg-success/15 text-success border border-success/25' : 'bg-primary/15 text-primary border border-primary/25') : 'bg-muted text-muted-foreground border border-muted'}`}>
              <span className={`flex items-center justify-center w-4 h-4 rounded-full text-[9px] ${step === 2 || success ? (success ? 'bg-success text-white' : 'bg-primary text-primary-foreground') : 'bg-muted-foreground/20 text-muted-foreground'}`}>2</span>
              Confirmation
            </div>
          </div>

          {step === 1 && (
          <>
          {/* Friendly, low-pressure intro for first-time / casual agents */}
          {!minimal && (
            <FormStepHeader
              icon={User}
              stepLabel="Step 1 of 2"
              title="Landlord details"
              subtitle="Just a name and phone registers them — everything else is optional and can be added later."
            />
          )}

          {/* Landlord Name */}
          <div data-field="landlordName" className="space-y-1">
            <Label className="text-sm font-semibold flex items-center gap-1.5">
              <User className="h-4 w-4" /> Landlord Name *
            </Label>
            <LandlordAutocompleteInput
              field="name"
              mode="status"
              value={landlordName}
              onChange={(v) => { setLandlordName(v); clearError('landlordName'); clearSubmitError(); setPhoneVerified(false); }}
              onBlur={(e) => validateField('landlordName', e.target.value)}
              onSelect={handleLandlordPick}
              placeholder="e.g. John Bosco Ssentamu — as on National ID"
              className={`h-12 text-base ${errors.landlordName ? 'border-destructive focus-visible:ring-destructive' : ''}`}
              required
            />
            {errors.landlordName && (
              <p className="text-[11px] text-destructive flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> {errors.landlordName}
              </p>
            )}
          </div>

          {/* Phone Number */}
          <div data-field="landlordPhone" className="space-y-1">
            <Label className="text-sm font-semibold flex items-center gap-1.5">
              <Phone className="h-4 w-4" /> Phone Number *
            </Label>
            <LandlordAutocompleteInput
              field="phone"
              mode="status"
              type="tel"
              inputMode="tel"
              value={landlordPhone}
              onChange={(v) => { setLandlordPhone(formatUgandaPhone(v)); clearError('landlordPhone'); clearSubmitError(); setPhoneVerified(false); }}
              onBlur={(e) => { void checkPhoneAvailable(e.target.value); }}
              onSelect={handleLandlordPick}
              placeholder="07XX XXX XXX — 10 digits"
              className={`h-12 text-base ${errors.landlordPhone ? 'border-destructive focus-visible:ring-destructive' : ''}`}
              required
            />
            {checkingPhone && (
              <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Checking if this number is already registered…
              </p>
            )}
            {!checkingPhone && errors.landlordPhone && (
              <p className="text-[11px] text-destructive flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> {errors.landlordPhone}
              </p>
            )}
            {!checkingPhone && !errors.landlordPhone && phoneVerified && (
              <p className="text-[11px] text-emerald-600 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Number is available
              </p>
            )}
          </div>

          {/* Minimal-mode LC1 fields (Outstanding Balance flow) */}
          {/* Official location — mandatory in every mode. Single shared picker,
              same ug_* dataset as house listings and rent requests. */}
          <div data-field="ugLocation" className="space-y-1">
            <UgLocationPicker
              value={ugLoc}
              onChange={(sel) => { setUgLoc(sel); setUgLocError(null); }}
              label="Official location (region → village)"
              required
              error={ugLocError}
            />
          </div>

          {minimal && (
            <div className="space-y-2 p-2.5 rounded-lg border bg-muted/30">
              <div className="flex items-center gap-1.5">
                <ShieldCheck className="h-3 w-3 text-primary" />
                <span className="text-xs font-semibold">LC1 Chairperson</span>
              </div>
              <div className="space-y-2">
                <div data-field="lc1Name" className="space-y-1">
                  <Label className="text-sm font-semibold flex items-center gap-1.5">
                    <User className="h-4 w-4" /> LC1 Chairperson Name *
                  </Label>
                  <PersonNameFields
                    idPrefix="landlord-form-lc1"
                    value={lc1NameParts}
                    onChange={(next) => { setLc1NameParts(next); clearError('lc1Name'); }}
                    errors={{ firstName: errors.lc1Name || null }}
                  />
                </div>
                <div data-field="lc1Phone" className="space-y-1">
                  <Label className="text-sm font-semibold flex items-center gap-1.5">
                    <Phone className="h-4 w-4" /> LC1 Phone *
                  </Label>
                  <Input
                    type="tel"
                    inputMode="tel"
                    value={lc1Phone}
                    onChange={(e) => { setLc1Phone(formatUgandaPhone(e.target.value)); clearError('lc1Phone'); }}
                    onBlur={(e) => validateField('lc1Phone', toUgandaLocalDigits(e.target.value))}
                    placeholder="07XX XXX XXX — 10 digits"
                    className={`h-12 text-base ${errors.lc1Phone ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                    required
                  />
                  {errors.lc1Phone && (
                    <p className="text-[11px] text-destructive flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> {errors.lc1Phone}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Next-step cue — once the essentials are filled, point the agent
              straight at the Register button so they always know what to do. */}
          {/* Required-fields checklist — shows exactly what's still missing or
              invalid so the agent never has to guess before tapping Next. */}
          {missingCount > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              data-field="requiredChecklist"
              className="p-3 rounded-lg bg-warning/10 border border-warning/30 space-y-2"
            >
              <div className="flex items-center gap-1.5">
                <ListChecks className="h-4 w-4 text-warning shrink-0" />
                <p className="text-xs font-semibold text-foreground">
                  {missingCount} {missingCount === 1 ? 'field still needs' : 'fields still need'} your attention
                </p>
              </div>
              <ul className="space-y-1.5">
                {requiredChecklist.map((item) => (
                  <li key={item.name}>
                    <button
                      type="button"
                      onClick={() => { hapticTap(); focusField(item.name); }}
                      className="w-full flex items-start gap-2 text-left rounded-md px-1 py-0.5 transition-colors hover:bg-warning/10 active:scale-[0.99] touch-manipulation"
                    >
                      {item.ok ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                      )}
                      <span className="flex-1 min-w-0">
                        <span className={`text-[11px] font-medium ${item.ok ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                          {item.label}
                        </span>
                        {!item.ok && item.error && (
                          <span className="block text-[10px] text-destructive">{item.error}</span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </motion.div>
          )}

          {(() => {
            const nameOk = landlordName.trim().length >= 2 && !errors.landlordName;
            const phoneOk =
              /^\d{9,10}$/.test(toUgandaLocalDigits(landlordPhone)) && !errors.landlordPhone;
            const lcOk = !minimal || (lc1Name.trim().length >= 2 && /^\d{9,10}$/.test(toUgandaLocalDigits(lc1Phone)));
            const ready = nameOk && phoneOk && lcOk && !!ugLoc && !loading;
            if (!ready) return null;
            return (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-2 p-2.5 rounded-lg bg-primary/10 border border-primary/20"
              >
                <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                <p className="text-xs font-medium text-foreground">
                  All set — tap <span className="font-semibold text-primary">Next</span> to review &amp; confirm.
                </p>
              </motion.div>
            );
          })()}

          {registeredByRole === 'agent' && !minimal && (
            <div data-field="landlordAgreement">
              <LandlordAgreementInlineFields
                value={agreementDetails}
                onChange={setAgreementDetails}
                landlordName={landlordName}
                landlordPhone={cleanPhoneNumber(landlordPhone)}
                propertyAddress={propertyAddress || (ugLoc ? ugLocationLabel(ugLoc) : '')}
              />
            </div>
          )}

          {/* Next — advance to the confirmation step once essentials are valid */}
          <div className="sticky bottom-0 -mx-1 px-1 pt-2 pb-1 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-t border-border/60 z-10">
            <Button
              type="button"
              onClick={handleNext}
              className="w-full h-14 text-base font-semibold gap-2 touch-manipulation select-none transition-transform active:scale-[0.98] disabled:opacity-70"
              disabled={loading || checkingPhone}
            >
              {checkingPhone ? (
                <><Loader2 className="h-5 w-5 animate-spin" /> Checking number…</>
              ) : (
                <><CheckCircle2 className="h-5 w-5" /> Next</>
              )}
            </Button>
            {/* Step hint shown before the essentials are complete so a first-time
                agent always understands the single next action. */}
            {!(landlordName.trim().length >= 2 && /^\d{9,10}$/.test(toUgandaLocalDigits(landlordPhone))) && (
              <p className="text-xs text-center text-muted-foreground mt-1.5">
                Step 1: enter the landlord's name &amp; phone, then tap Next.
              </p>
            )}
          </div>

          {/* Toggle to reveal the optional property / payout details */}
          {!minimal && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => { hapticTap(); setShowMore((s) => !s); }}
              className="w-full h-11 gap-2 text-xs text-muted-foreground touch-manipulation select-none"
            >
              {showMore ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {showMore ? 'Hide extra details' : 'Add property & payout details (optional)'}
            </Button>
          )}

          {/* ===== Optional collapsible section ===== */}
          {!minimal && showMore && (
          <div className="space-y-3 pt-1">
          {/* List-a-house shortcut — a landlord needs a verified house before
              they can be used on a rent request. Agent earns UGX 5,000 total. */}
          {registeredByRole === 'agent' && (
            <div className="p-3 rounded-lg border border-primary/30 bg-primary/5 space-y-2">
              <p className="text-xs text-muted-foreground">
                A landlord needs at least one <span className="font-medium text-foreground">verified house</span> before
                you can post a rent request for them.
              </p>
              <p className="text-xs text-muted-foreground">
                List a house and earn <span className="font-semibold text-foreground">UGX 5,000</span> when Landlord Ops
                verifies it — <span className="font-semibold text-foreground">UGX 1,000 now</span>,{' '}
                <span className="font-semibold text-foreground">UGX 4,000 on verification</span>, straight to your withdrawable wallet.
              </p>
              <Button
                type="button"
                variant="outline"
                className="w-full h-12 gap-2 touch-manipulation select-none transition-transform active:scale-[0.98]"
                onClick={() => {
                  if (!guardListingHours()) return;
                  hapticTap();
                  setShowListHouse(true);
                }}
              >
                <Home className="h-4 w-4" />
                List a house for this landlord
              </Button>
            </div>
          )}

          {/* Qualification Score Bar */}
          <div className="p-2.5 rounded-lg bg-muted/50 border">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-muted-foreground">Qualification Score</span>
              <span className={`text-xs font-bold ${qualificationScore >= 80 ? 'text-success' : qualificationScore >= 50 ? 'text-warning' : 'text-destructive'}`}>
                {qualificationScore}%
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${qualificationScore >= 80 ? 'bg-success' : qualificationScore >= 50 ? 'bg-warning' : 'bg-destructive'}`}
                style={{ width: `${qualificationScore}%` }}
              />
            </div>
          </div>

          {/* Number of Rentals & Category in row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-sm font-semibold flex items-center gap-1.5">
                <Hash className="h-4 w-4" /> No. of Rentals
              </Label>
              <Input
                type="number"
                min="1"
                value={numberOfRentals}
                onChange={(e) => setNumberOfRentals(e.target.value)}
                placeholder="e.g. 5"
                className="h-12 text-base"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-semibold flex items-center gap-1.5">
                <Building2 className="h-4 w-4" /> Category
              </Label>
              <Select value={houseCategory} onValueChange={setHouseCategory}>
                <SelectTrigger className="h-12 text-base">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {HOUSE_CATEGORIES.map(cat => (
                    <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Property Address */}
          <div data-field="propertyAddress" className="space-y-1">
            <Label className="text-sm font-semibold flex items-center gap-1.5">
              <MapPin className="h-4 w-4" /> Property Address
              <span className="text-[10px] font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              value={propertyAddress}
              onChange={(e) => { setPropertyAddress(e.target.value); clearError('propertyAddress'); }}
              onBlur={(e) => validateField('propertyAddress', e.target.value)}
              placeholder="e.g., Kabalagala, Block 5, Plot 12"
              className={`h-12 text-base ${errors.propertyAddress ? 'border-destructive focus-visible:ring-destructive' : ''}`}
            />
            {errors.propertyAddress && (
              <p className="text-[11px] text-destructive flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> {errors.propertyAddress}
              </p>
            )}
          </div>

          {/* GPS Location */}
          <div className={`flex items-center justify-between p-2.5 rounded-lg border ${
            locationCaptured ? 'bg-success/10 border-success/30'
              : locationError ? 'bg-destructive/10 border-destructive/30'
              : 'bg-muted/50 border-muted'
          }`}>
            <div className="flex items-center gap-2">
              {locationLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              ) : locationCaptured ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
              ) : locationError ? (
                <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
              ) : (
                <Navigation className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <div>
                <p className={`text-xs font-medium ${locationCaptured ? 'text-success' : ''}`}>
                  {locationLoading ? 'Capturing GPS...'
                    : locationCaptured ? 'GPS Captured'
                    : locationError || 'GPS not captured'}
                </p>
                {locationCaptured && location && (
                  <p className="text-[10px] text-muted-foreground">
                    {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
                    {location.accuracy && ` (±${Math.round(location.accuracy)}m)`}
                  </p>
                )}
              </div>
            </div>
            <Button
              type="button" variant="ghost" size="sm" disabled={locationLoading}
              onClick={async () => {
                const loc = await captureLocation();
                if (loc) setLocationCaptured(true);
              }}
              className="gap-1 text-[10px] h-7 px-2"
            >
              <RefreshCw className={`h-3 w-3 ${locationLoading ? 'animate-spin' : ''}`} />
              {locationCaptured ? 'Refresh' : 'Capture'}
            </Button>
          </div>

          {/* Mobile Money Section */}
          <div className="space-y-2 p-2.5 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-1.5">
              <Wallet className="h-3 w-3 text-primary" />
              <span className="text-xs font-semibold">Mobile Money Details</span>
              {nameMatchScore !== null && (
                <span className={`ml-auto flex items-center gap-1 text-[10px] font-medium ${nameMatchScore >= 80 ? 'text-success' : nameMatchScore >= 50 ? 'text-warning' : 'text-destructive'}`}>
                  {nameMatchScore >= 80 ? <ShieldCheck className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                  {nameMatchScore}% match
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs font-semibold text-muted-foreground">MoMo Name</Label>
                <Input
                  value={momoName}
                  onChange={(e) => setMomoName(e.target.value)}
                  placeholder="Name on MoMo"
                  className="h-12 text-base"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-semibold text-muted-foreground">MoMo Number</Label>
                <Input
                  type="tel"
                  inputMode="tel"
                  value={momoNumber}
                  onChange={(e) => setMomoNumber(formatUgandaPhone(e.target.value))}
                  placeholder="07XX XXX XXX"
                  className="h-12 text-base"
                />
              </div>
            </div>
          </div>

          {/* Bank Details (optional) — sits beside mobile money, never required */}
          <div className="space-y-2 p-2.5 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-1.5">
              <Wallet className="h-3 w-3 text-primary" />
              <span className="text-xs font-semibold">Bank Details</span>
              <span className="ml-auto text-[10px] font-normal text-muted-foreground">optional</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs font-semibold text-muted-foreground">Bank Name</Label>
                <Input
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  placeholder="e.g. Stanbic Bank"
                  className="h-12 text-base"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-semibold text-muted-foreground">Branch</Label>
                <Input
                  value={bankBranch}
                  onChange={(e) => setBankBranch(e.target.value)}
                  placeholder="e.g. Kampala Road"
                  className="h-12 text-base"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-semibold text-muted-foreground">Bank Account Number</Label>
                <Input
                  inputMode="numeric"
                  value={bankAccountNumber}
                  onChange={(e) => setBankAccountNumber(e.target.value)}
                  placeholder="Account number"
                  className="h-12 text-base"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-semibold text-muted-foreground">Bank Account Name</Label>
                <Input
                  value={bankAccountName}
                  onChange={(e) => setBankAccountName(e.target.value)}
                  placeholder="Name on the account"
                  className="h-12 text-base"
                />
              </div>
            </div>
          </div>


          {/* Utility Meters */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-sm font-semibold flex items-center gap-1.5">
                <Droplets className="h-4 w-4 text-blue-500" /> NWSC Meter
                <span className="text-[10px] font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                value={nwscMeter}
                onChange={(e) => setNwscMeter(e.target.value)}
                placeholder="In landlord's name"
                className="h-12 text-base"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-semibold flex items-center gap-1.5">
                <Zap className="h-4 w-4 text-yellow-500" /> UEDCL Meter
                <span className="text-[10px] font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                value={uedclMeter}
                onChange={(e) => setUedclMeter(e.target.value)}
                placeholder="In landlord's name"
                className="h-12 text-base"
              />
            </div>
          </div>

          {/* Temporary Password */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">Temporary Password</Label>
              <Button type="button" variant="ghost" size="sm" onClick={generateTempPassword}
                className="gap-1 text-[10px] h-6 px-2 text-primary">
                <RefreshCw className="h-3 w-3" /> Generate
              </Button>
            </div>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                value={tempPassword}
                placeholder="Auto-generated"
                className="h-12 pr-12 text-base"
                readOnly
              />
              <Button type="button" variant="ghost" size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                onClick={() => setShowPassword(!showPassword)}>
                {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
          </div>
          )}
          </>
          )}

          {/* ===== Step 2: Confirmation ===== */}
          {step === 2 && !success && (
          <>
            <FormStepHeader
              icon={CheckCircle2}
              stepLabel="Step 2 of 2"
              title="Confirm & register"
              subtitle="Check the details below, then tap Register."
            />
            {(() => {
              const nameErr = computeFieldError('landlordName', landlordName);
              const phoneErr = computeFieldError('landlordPhone', landlordPhone);
              const lc1NameErr = minimal ? computeFieldError('lc1Name', lc1Name) : '';
              const lc1PhoneErr = minimal ? computeFieldError('lc1Phone', lc1Phone) : '';
              const anyErr = nameErr || phoneErr || lc1NameErr || lc1PhoneErr;
              if (!anyErr) return null;
              return (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-start gap-2 p-2.5 rounded-lg bg-warning/10 border border-warning/30"
                >
                  <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                  <p className="text-[11px] font-medium text-foreground">
                    Some details need fixing before you can register. Tap{' '}
                    <span className="font-semibold">Back to edit</span> to correct the highlighted fields.
                  </p>
                </motion.div>
              );
            })()}

            <div className="space-y-2 p-3 rounded-xl border bg-muted/30">
              <p className="text-xs font-semibold text-foreground">Confirm the details</p>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                  <User className="h-3 w-3" /> Name
                </span>
                <span className="text-xs font-medium text-foreground text-right truncate">{landlordName}</span>
              </div>
              {errors.landlordName ? (
                <p className="text-[11px] text-destructive flex items-center justify-end gap-1">
                  <AlertTriangle className="h-3 w-3" /> {errors.landlordName}
                </p>
              ) : (
                <p className="text-[11px] text-emerald-600 flex items-center justify-end gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Name looks good
                </p>
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                  <Phone className="h-3 w-3" /> Phone
                </span>
                <span className="text-xs font-medium text-foreground text-right">{landlordPhone}</span>
              </div>
              {errors.landlordPhone ? (
                <p className="text-[11px] text-destructive flex items-center justify-end gap-1">
                  <AlertTriangle className="h-3 w-3" /> {errors.landlordPhone}
                </p>
              ) : (
                <p className="text-[11px] text-emerald-600 flex items-center justify-end gap-1">
                  <CheckCircle2 className="h-3 w-3" /> {phoneVerified ? 'Number is available' : 'Phone looks good'}
                </p>
              )}
              {minimal && (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                      <ShieldCheck className="h-3 w-3" /> LC1 Name
                    </span>
                    <span className="text-xs font-medium text-foreground text-right truncate">{lc1Name}</span>
                  </div>
                  {errors.lc1Name ? (
                    <p className="text-[11px] text-destructive flex items-center justify-end gap-1">
                      <AlertTriangle className="h-3 w-3" /> {errors.lc1Name}
                    </p>
                  ) : (
                    <p className="text-[11px] text-emerald-600 flex items-center justify-end gap-1">
                      <CheckCircle2 className="h-3 w-3" /> LC1 name looks good
                    </p>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                      <Phone className="h-3 w-3" /> LC1 Phone
                    </span>
                    <span className="text-xs font-medium text-foreground text-right">{lc1Phone}</span>
                  </div>
                  {errors.lc1Phone ? (
                    <p className="text-[11px] text-destructive flex items-center justify-end gap-1">
                      <AlertTriangle className="h-3 w-3" /> {errors.lc1Phone}
                    </p>
                  ) : (
                    <p className="text-[11px] text-emerald-600 flex items-center justify-end gap-1">
                      <CheckCircle2 className="h-3 w-3" /> LC1 phone looks good
                    </p>
                  )}
                </>
              )}
              {propertyAddress.trim() && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                    <MapPin className="h-3 w-3" /> Address
                  </span>
                  <span className="text-xs font-medium text-foreground text-right truncate">{propertyAddress}</span>
                </div>
              )}
            </div>

            {/* Inline stepped progress so the agent always sees forward motion */}
            {loading && progressMsg && (
              <p className="flex items-center justify-center gap-2 text-sm font-medium text-primary animate-pulse">
                <Loader2 className="h-4 w-4 animate-spin" /> {progressMsg}
              </p>
            )}

            {/* Sticky bottom action bar — primary action always reachable */}
            <div className="sticky bottom-0 -mx-1 px-1 pt-2 pb-1 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-t border-border/60 z-10 space-y-1.5">
              {/* Register — final submit on the confirmation step */}
              <Button
                type="submit"
                onClick={() => hapticTap()}
                className="w-full h-14 text-base font-semibold gap-2 touch-manipulation select-none transition-transform active:scale-[0.98] disabled:opacity-70"
                disabled={loading}
              >
                {loading ? (
                  <><Loader2 className="h-5 w-5 animate-spin" /> Registering...</>
                ) : (
                  <><Building2 className="h-5 w-5" /> Register Landlord</>
                )}
              </Button>

              {/* Back to edit the entered details */}
              {!loading && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => { hapticTap(); setStep(1); }}
                  className="w-full h-11 gap-2 text-sm text-muted-foreground touch-manipulation select-none"
                >
                  <ChevronUp className="h-4 w-4 rotate-90" /> Back to edit
                </Button>
              )}
            </div>

            {/* Inline error banner — stays on screen so agents on weak networks always know what happened */}
            <AnimatePresence>
              {submitError && !loading && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="p-3.5 rounded-xl bg-destructive/10 border border-destructive/30 space-y-2"
                >
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5 p-1 rounded-full bg-destructive/20">
                      <XCircle className="h-4 w-4 text-destructive" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-destructive">Could not save</p>
                      <p className="text-xs text-destructive/80 mt-0.5">{submitError}</p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    onClick={() => { hapticTap(); clearSubmitError(); handleSubmit(); }}
                    className="w-full h-12 text-sm font-semibold gap-2 touch-manipulation select-none transition-transform active:scale-[0.98]"
                  >
                    <RefreshCw className="h-4 w-4" /> Try Again
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </>
          )}
        </motion.form>
      )}
    </AnimatePresence>

    {registeredByRole === 'agent' && (
      <ListEmptyHouseDialog
        open={showListHouse}
        onOpenChange={setShowListHouse}
        initialLandlordName={landlordName}
        initialLandlordPhone={landlordPhone}
      />
    )}
    </>
  );
}
