/**
 * Rent Request Assistant (preview) — posts a rent request as a guided chat.
 *
 * One question per turn, every answer checked as it is given, the Rent Plan
 * priced before any personal details. Collects exactly the fields the
 * AgentRentRequestDialog collects for the daily / weekly / monthly flows and
 * posts through submitAssistantRentRequest, which mirrors the form's submit.
 *
 * Gated: only the accounts in src/lib/rentAssistantPreview.ts see the entry
 * button (see AgentDashboard). The form stays the path every other agent uses.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Camera, Check, ImagePlus, Loader2, Lock, MapPin, RotateCcw, Send, Sparkles, Square, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useAssistantSpeech } from './useAssistantSpeech';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useAgentCapacityMap, DAILY_ELIGIBILITY_THRESHOLD } from '@/hooks/useAgentCapacityMap';
import { listingHasRealPhoto } from '@/hooks/useHouseListings';
import type { UgLocationSelection } from '@/hooks/useUgLocations';
import { LandlordSearchSelect, type LandlordOption } from '@/components/agent/LandlordSearchSelect';
import RegisterLandlordDialog from '@/components/agent/RegisterLandlordDialog';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import { GuarantorConsentCheckbox } from '@/components/agent/GuarantorConsentCheckbox';
import { promptIfNotVetted } from '@/components/agent-vetting/notVettedPrompt';
import { agentNotVettedReason } from '@/lib/agentVetting';
import { optimizeImage } from '@/lib/imageOptimizer';
import { runPassportFaceCheck, faceCheckBlocker, type PassportFaceCheck } from '@/lib/passportFaceCheck';
import { notifyVerificationCreated } from '@/lib/landlordVerificationNotify';
import { normalizeDistrict } from '@/lib/ugandaDistricts';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticSuccess, hapticTap } from '@/lib/haptics';
import { joinPersonName, type PersonNameParts } from '@/lib/authValidation';
import { cn } from '@/lib/utils';
import {
  computeAssistantFees,
  submitAssistantRentRequest,
  weeklyRepaymentFor,
  type AssistantEarnerCycle,
  type AssistantHouse,
  type AssistantIncomeType,
  type AssistantSubmitResult,
} from '@/lib/rentRequestAssistantSubmit';
import {
  checkNationalId,
  checkNewLc1Phone,
  checkTenantPhone,
  loadAgentSelf,
  maskNationalId,
  maskPhone,
  type AgentSelf,
  type RecordVerdict,
} from '@/lib/rentAssistantRecordChecks';

const HOUSE_CATEGORIES = [
  { value: 'single-room', label: 'Single room' },
  { value: 'double-room', label: 'Double room' },
  { value: '1-bed', label: '1 bed house' },
  { value: '2-bed', label: '2 bedroom house' },
  { value: '2-bed-full', label: '2 bed + sitting room' },
  { value: '3-bed', label: '3 bedroom' },
  { value: '3-bed-luxury', label: '3 bed luxury' },
  { value: '4-bed', label: '4+ bedroom' },
  { value: 'shop', label: 'Shop' },
  { value: 'market-stall', label: 'Market stall' },
  { value: 'kiosk', label: 'Kiosk' },
  { value: 'salon-workshop', label: 'Salon / workshop' },
  { value: 'office', label: 'Office' },
  { value: 'warehouse', label: 'Warehouse' },
  { value: 'commercial', label: 'Other business' },
];
const LANGUAGES = ['English', 'Luganda', 'Runyankole', 'Lusoga', 'Acholi', 'Lugbara', 'Other'];
const PAYOUT_DAYS = ['1', '5', '10', '15', '20', '25', '28'];
const PHOTO_SLOTS = ['Front', 'Back', 'Left side', 'Right side'];
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

type UntypedRpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
/** For the RPCs missing from the generated types (same calls the form makes). */
const rpcUntyped: UntypedRpc = (fn, args) => (supabase.rpc as unknown as UntypedRpc).call(supabase, fn, args);
const metaOf = (u: { user_metadata?: Record<string, unknown> } | null | undefined) =>
  (u?.user_metadata ?? {}) as Record<string, string | undefined>;

const UG_PHONE = /^0[3-9][0-9]{8}$/;
const clean = (s: string) => s.replace(/\s/g, '');
const isUgPhone = (s: string) => UG_PHONE.test(clean(s));

/** What is wrong with a typed phone number, in plain words; null when it is fine. */
function phoneProblem(text: string, whose: string): string | null {
  const d = formatPhone(text).replace(/\D/g, '');
  if (!d) return `I didn’t catch a number 🤔 Type ${whose}’s phone, like 0783 123 456.`;
  if (UG_PHONE.test(d)) return null;
  if (/^[37][0-9]{8}$/.test(d)) return `Looks like the 0 at the start is missing. Did you mean ${formatPhone(`0${d}`)}? 🤔`;
  if (d.length < 10) return `That’s only ${d.length} digits. A Ugandan number has 10, like 0783 123 456 📱`;
  if (!/^0[37]/.test(d)) return 'Ugandan numbers start with 07 (or 03 for landlines) 🤔 Check the number again.';
  return 'That number doesn’t look right 🤔 Use one like 0783 123 456.';
}
const formatPhone = (raw: string) => {
  // A pasted +256 / 256 number becomes the local 0… form as it is typed.
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('256')) d = `0${d.slice(3)}`;
  d = d.slice(0, 10);
  if (d.length <= 4) return d;
  if (d.length <= 7) return `${d.slice(0, 4)} ${d.slice(4)}`;
  return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
};
const groupDigits = (raw: string) => raw.replace(/\D/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function mapHouseCategory(cat: string | null): string {
  switch ((cat || '').toLowerCase()) {
    case 'single_room': case 'studio': case 'bedsitter': return 'single-room';
    case 'double_room': return 'double-room';
    case 'one_bedroom': return '1-bed';
    case 'two_bedroom': return '2-bed';
    case 'three_bedroom': return '3-bed';
    case 'shop': case 'commercial': return 'commercial';
    default: return '';
  }
}

type StepId =
  | 'type' | 'rent' | 'plan'
  | 'tenantPhone' | 'tenantName' | 'nationalId' | 'language' | 'smartphone'
  | 'landlord' | 'house' | 'location' | 'address' | 'category' | 'photos' | 'tenantPhoto' | 'gps'
  | 'lc1Phone' | 'lc1Name' | 'lc1Village' | 'city' | 'lcLetter' | 'payoutDay'
  | 'review';

type PlanType = 'daily' | 'weekly' | 'monthly';
type Lc1Match = { id: string; name: string; verified: boolean; village: string } | null;
type Photo = { file: File; preview: string };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

function greetingNow(): { text: string; emoji: string } {
  const h = new Date().getHours();
  if (h < 12) return { text: 'Good morning', emoji: '🌅' };
  if (h < 17) return { text: 'Good afternoon', emoji: '☀️' };
  return { text: 'Good evening', emoji: '🌙' };
}

export default function RentRequestAssistant({ open, onOpenChange, onSuccess }: Props) {
  const { user } = useAuth();
  const capIds = useMemo(() => (user?.id ? [user.id] : []), [user?.id]);
  const { data: capMap, isLoading: capLoading } = useAgentCapacityMap(capIds);
  const myCap = user?.id ? capMap?.get(user.id) : undefined;
  const perTenantMax = myCap?.unlimited_posting ? Number.MAX_SAFE_INTEGER : (myCap?.per_tenant_max ?? 500_000);
  const postingBlocked = !!myCap && !myCap.unlimited_posting && !myCap.can_post_rent_today;

  // ----- answers -----
  const [planType, setPlanType] = useState<PlanType | null>(null);
  const [rentText, setRentText] = useState('');
  const [duration, setDuration] = useState<'30' | '60' | '90'>('30');
  const [repaymentPeriod, setRepaymentPeriod] = useState('7');
  const [tenantPhone, setTenantPhone] = useState('');
  const [tenantNameParts, setTenantNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const [nationalId, setNationalId] = useState('');
  const [language, setLanguage] = useState('');
  const [noSmartphone, setNoSmartphone] = useState<boolean | null>(null);
  const [landlord, setLandlord] = useState<LandlordOption | null>(null);
  const [landlordStatus, setLandlordStatus] = useState<'idle' | 'checking' | 'verified' | 'unverified' | 'missing'>('idle');
  const [agreementOnFile, setAgreementOnFile] = useState<boolean | null>(null);
  const [verifyReq, setVerifyReq] = useState<'idle' | 'sending' | 'sent' | 'exists'>('idle');
  const [showRegisterLandlord, setShowRegisterLandlord] = useState(false);
  const [houses, setHouses] = useState<AssistantHouse[] | null>(null);
  const [house, setHouse] = useState<AssistantHouse | null>(null);
  const [houseChoiceMade, setHouseChoiceMade] = useState(false);
  const [location, setLocation] = useState<UgLocationSelection | null>(null);
  const [address, setAddress] = useState('');
  const [district, setDistrict] = useState('');
  const [category, setCategory] = useState('');
  const [housePhotos, setHousePhotos] = useState<(Photo | null)[]>([null, null, null, null]);
  const [tenantPhoto, setTenantPhoto] = useState<Photo | null>(null);
  const [faceCheck, setFaceCheck] = useState<PassportFaceCheck | null>(null);
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [lc1Phone, setLc1Phone] = useState('');
  const [lc1Match, setLc1Match] = useState<Lc1Match>(null);
  const [lc1Looking, setLc1Looking] = useState(false);
  const [lc1NameParts, setLc1NameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const [lc1Village, setLc1Village] = useState('');
  const [city, setCity] = useState('');
  const [lcLetter, setLcLetter] = useState<Photo | null>(null);
  const [lcLetterDecided, setLcLetterDecided] = useState(false);
  const [payoutDay, setPayoutDay] = useState('');
  const [consent, setConsent] = useState(false);

  // ----- flow -----
  const [current, setCurrent] = useState<StepId>('type');
  const [furthest, setFurthest] = useState<StepId>('type');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** A corrected answer the agent can accept with one tap ("Did you mean …?"). */
  const [fixOffer, setFixOffer] = useState<string | null>(null);
  /** Wrong tries per question; the third one adds a tip. */
  const [wrongTries, setWrongTries] = useState<Partial<Record<StepId, number>>>({});
  const [posting, setPosting] = useState(false);
  const [result, setResult] = useState<{ id: string; existing: boolean; lcLetterFailed: boolean } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const greeting = useMemo(greetingNow, [open]);

  const incomeType: AssistantIncomeType = planType === 'daily' ? 'daily' : 'weekly-monthly';
  const earnerCycle: AssistantEarnerCycle = planType === 'monthly' ? 'monthly' : 'weekly';
  const amount = parseInt(rentText.replace(/\D/g, ''), 10) || 0;
  const fees = planType ? computeAssistantFees(incomeType, amount, duration, repaymentPeriod) : null;
  const tenantName = joinPersonName(tenantNameParts);
  const lc1Name = lc1Match ? lc1Match.name : joinPersonName(lc1NameParts);

  // ----- existing-record checks (never reveal whose record it is) -----
  const [agentSelf, setAgentSelf] = useState<AgentSelf | null>(null);
  const [recordChecking, setRecordChecking] = useState(false);
  const [recordBlock, setRecordBlock] = useState<RecordBlock | null>(null);
  useEffect(() => {
    if (!open || !user?.id) return;
    let cancelled = false;
    const fallbackPhone = metaOf(user).phone || user.phone || null;
    loadAgentSelf(user.id, fallbackPhone)
      .then((me) => { if (!cancelled) setAgentSelf(me); })
      .catch(() => { if (!cancelled) setAgentSelf({ phone: fallbackPhone, nationalId: null }); });
    return () => { cancelled = true; };
  }, [open, user]);

  const steps: StepId[] = useMemo(() => {
    const all: StepId[] = [
      'type', 'rent', 'plan',
      'tenantPhone', 'tenantName', 'nationalId', 'language', 'smartphone',
      'landlord', 'house', 'location', 'address', 'category', 'photos', 'tenantPhoto', 'gps',
      'lc1Phone', 'lc1Name', 'lc1Village', 'city', 'lcLetter', 'payoutDay', 'review',
    ];
    return all.filter((s) => !(s === 'lc1Name' && lc1Match));
  }, [lc1Match]);
  const idx = steps.indexOf(current);
  const furthestIdx = Math.max(steps.indexOf(furthest), idx);

  const reset = useCallback(() => {
    setPlanType(null); setRentText(''); setDuration('30'); setRepaymentPeriod('7');
    setTenantPhone(''); setTenantNameParts({ firstName: '', otherNames: '', lastName: '' }); setNationalId('');
    setLanguage(''); setNoSmartphone(null); setLandlord(null); setLandlordStatus('idle'); setAgreementOnFile(null);
    setVerifyReq('idle'); setHouses(null); setHouse(null); setHouseChoiceMade(false); setLocation(null); setAddress('');
    setDistrict(''); setCategory(''); setHousePhotos([null, null, null, null]); setTenantPhoto(null); setFaceCheck(null);
    setGps(null); setLc1Phone(''); setLc1Match(null); setLc1NameParts({ firstName: '', otherNames: '', lastName: '' });
    setLc1Village(''); setCity(''); setLcLetter(null); setLcLetterDecided(false); setPayoutDay(''); setConsent(false);
    setCurrent('type'); setFurthest('type'); setDraft(''); setError(null); setResult(null); setRecordBlock(null);
    setFixOffer(null); setWrongTries({});
  }, []);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }));
  }, [open, current, error, result, houses, landlordStatus, lc1Match, faceCheck, posting]);

  // Seed the composer with the stored value when a text step opens.
  useEffect(() => {
    const seed: Partial<Record<StepId, string>> = {
      rent: rentText ? groupDigits(rentText) : '',
      tenantPhone, nationalId, address, lc1Phone, lc1Village, city,
    };
    setDraft(seed[current] ?? '');
    setError(null);
    setFixOffer(null);
    // Keep a notice raised for this very step (the pre-post re-check sends the agent back with one).
    setRecordBlock((b) => (b && b.step === current ? b : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // ----- landlord checks (same RPCs as the form) -----
  useEffect(() => {
    const landlordId = landlord?.id;
    if (!landlordId) { setLandlordStatus('idle'); setAgreementOnFile(null); return; }
    let cancelled = false;
    setLandlordStatus('checking');
    setVerifyReq('idle');
    (async () => {
      try {
        const [{ data, error: e1 }, { data: agreement, error: e2 }] = await Promise.all([
          rpcUntyped('get_landlord_verification_status', { p_id: landlordId }),
          rpcUntyped('landlord_has_current_agreement', { p_landlord_id: landlordId }),
        ]);
        if (cancelled) return;
        const row = (Array.isArray(data) ? data[0] : data) as { exists_flag?: boolean; verified?: boolean } | null | undefined;
        if (e1) setLandlordStatus('idle');
        else if (!row || row.exists_flag === false) setLandlordStatus('missing');
        else setLandlordStatus(row.verified ? 'verified' : 'unverified');
        setAgreementOnFile(e2 ? null : agreement === true);
      } catch {
        if (!cancelled) { setLandlordStatus('idle'); setAgreementOnFile(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [landlord?.id]);

  const requestLandlordVerification = async () => {
    if (!landlord || !user) return;
    setVerifyReq('sending');
    const meta = metaOf(user);
    const agentName = meta.full_name || meta.name || 'Agent';
    const agentPhone = meta.phone || user.phone || null;
    try {
      const { data: inserted, error: e } = await supabase
        .from('landlord_verification_requests')
        .insert({
          landlord_id: landlord.id,
          landlord_name: landlord.name,
          landlord_phone: landlord.phone || null,
          requested_by: user.id,
          agent_name: agentName,
          agent_phone: agentPhone,
          status: 'pending',
        })
        .select('id')
        .single();
      if (e) {
        if ((e as { code?: string }).code === '23505') { setVerifyReq('exists'); return; }
        throw e;
      }
      setVerifyReq('sent');
      void notifyVerificationCreated({
        agentId: user.id, agentName, landlordId: landlord.id, landlordName: landlord.name,
        landlordPhone: landlord.phone || null, requestId: inserted?.id ?? null,
      });
    } catch (err) {
      setVerifyReq('idle');
      toast.error('Could not send the request', { description: err instanceof Error ? err.message : 'Please try again.' });
    }
  };

  // Available houses for the chosen landlord (photoless ones shown but blocked).
  useEffect(() => {
    if (current !== 'house' || !landlord?.id) return;
    let cancelled = false;
    setHouses(null);
    (async () => {
      const { data, error: e } = await supabase
        .from('house_listings')
        .select('id, title, address, region, district, house_category, monthly_rent, latitude, longitude, landlord_id, image_urls')
        .eq('landlord_id', landlord.id)
        .eq('status', 'available')
        .is('tenant_id', null)
        .is('reserved_at', null)
        .eq('is_hidden', false)
        .order('created_at', { ascending: false })
        .limit(20);
      if (cancelled) return;
      if (e) { setHouses([]); return; }
      const rows = (data || []) as unknown as Array<Omit<AssistantHouse, 'image_urls'> & { image_urls: unknown }>;
      setHouses(rows.map((r) => ({ ...r, image_urls: Array.isArray(r.image_urls) ? (r.image_urls as string[]) : [] })));
    })();
    return () => { cancelled = true; };
  }, [current, landlord?.id]);

  const pickHouse = (h: AssistantHouse | null) => {
    hapticTap();
    setHouse(h);
    setHouseChoiceMade(true);
    if (h) {
      if (h.address) setAddress(h.address);
      if (h.district) setDistrict(normalizeDistrict(h.district));
      if (h.region && !city) setCity(h.region);
      const mapped = mapHouseCategory(h.house_category);
      if (mapped) setCategory(mapped);
      if (h.latitude != null && h.longitude != null) setGps({ lat: Number(h.latitude), lng: Number(h.longitude), accuracy: 0 });
    }
    advance('house');
  };

  // ----- photos -----
  const readPhoto = async (file: File): Promise<Photo | null> => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type.toLowerCase())) { toast.error('Use a JPG, PNG, WebP or HEIC photo'); return null; }
    if (file.size > 10 * 1024 * 1024) { toast.error('That photo is over 10 MB'); return null; }
    try {
      const optimized = await optimizeImage(file);
      return { file: optimized.file, preview: optimized.previewUrl };
    } catch {
      return { file, preview: URL.createObjectURL(file) };
    }
  };
  const onHousePhoto = async (i: number, file: File | undefined) => {
    if (!file) return;
    const p = await readPhoto(file);
    if (!p) return;
    setHousePhotos((prev) => { const next = [...prev]; if (next[i]) URL.revokeObjectURL(next[i]!.preview); next[i] = p; return next; });
  };
  const onTenantPhoto = async (file: File | undefined) => {
    if (!file) return;
    const p = await readPhoto(file);
    if (!p) return;
    setTenantPhoto((prev) => { if (prev) URL.revokeObjectURL(prev.preview); return p; });
    setFaceCheck({ status: 'checking' });
    const res = await runPassportFaceCheck(p.file, { source: 'agent_rent_request' });
    setFaceCheck(res);
  };
  const onLcLetter = (file: File | undefined) => {
    if (!file) return;
    if (!['image/jpeg', 'image/jpg', 'image/png'].includes(file.type.toLowerCase())) { toast.error('The LC letter must be a JPG or PNG photo'); return; }
    if (file.size > 10 * 1024 * 1024) { toast.error('The LC letter must be 10 MB or smaller'); return; }
    setLcLetter({ file, preview: URL.createObjectURL(file) });
    setLcLetterDecided(true);
  };

  const captureGps = () => {
    if (!navigator.geolocation) { toast.error('GPS is not supported on this phone'); return; }
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }); setGpsLoading(false); },
      (err) => { setGpsLoading(false); toast.error(err.code === 1 ? 'Location permission denied' : 'Could not get GPS. Try again.'); },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  };

  // ----- LC1 lookup -----
  const lookupLc1 = async (phone: string): Promise<Lc1Match> => {
    setLc1Looking(true);
    try {
      const { data } = await supabase.rpc('find_lc1_by_phone', { p_phone: clean(phone) });
      return ((data ?? [])[0] as Lc1Match) ?? null;
    } catch {
      return null;
    } finally {
      setLc1Looking(false);
    }
  };

  // ----- validation (same rules as the form, said kindly and specifically) -----
  const validate = (s: StepId, text = draft): string | null => {
    switch (s) {
      case 'type':
        return planType ? null : 'Pick one of the options above so I know how they’ll pay back 👆';
      case 'language':
        return language ? null : 'Pick a language above 👆 so their SMS messages make sense to them.';
      case 'smartphone':
        return noSmartphone === null ? 'Just tap Yes or No above 👆' : null;
      case 'house':
        return houseChoiceMade ? null : 'Pick a house above, or tap “The house isn’t listed” 👆';
      case 'category':
        return category ? null : 'Pick the type of place above 👆';
      case 'payoutDay':
        return payoutDay ? null : 'Pick a payout day above 👆';
      case 'rent': {
        const n = parseInt(text.replace(/\D/g, ''), 10) || 0;
        if (!n) return 'I didn’t catch an amount 🤔 Type the monthly rent, like 450,000.';
        if (n < 50000) {
          return n * 1000 >= 50000 && n < 50000 / 10
            ? `Hmm, ${formatUGX(n)} looks too small for a month’s rent. Did you mean ${formatUGX(n * 1000)}? 🤔`
            : `${formatUGX(n)} is below the UGX 50,000 minimum for a Rent Plan. Check the amount with the tenant 🙏`;
        }
        if (myCap && n > perTenantMax) return `${formatUGX(n)} is more than your cap of ${formatUGX(perTenantMax)} per tenant 😕 Check the amount, or pick a house within your cap.`;
        return null;
      }
      case 'tenantPhone':
        return phoneProblem(text, 'the tenant');
      case 'tenantName':
        if (!tenantNameParts.firstName.trim() && !tenantNameParts.lastName.trim()) return 'I need their name before we move on 🙂 Type the first and last name.';
        if (!tenantNameParts.lastName.trim()) return `And ${tenantNameParts.firstName.trim()}’s last name? I need both, as on the ID 🪪`;
        return tenantNameParts.firstName.trim() ? null : 'And their first name? I need both, as on the ID 🪪';
      case 'nationalId': {
        const id = text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        if (!id) return 'I didn’t catch the NIN 🤔 It’s on the front of the card, like CM12345678ABCD.';
        if (id.length < 10) return `That’s only ${id.length} characters. The NIN on the card is usually 14, like CM12345678ABCD 🪪`;
        if (id.length > 14) return `That’s ${id.length} characters, a bit too long. The NIN is 14 at most 🪪`;
        return null;
      }
      case 'landlord':
        if (!landlord) return 'Search for the landlord above, or register them if they’re new 👆';
        if (landlordStatus === 'missing') return 'Hmm, that landlord is no longer on Welile 😕 Pick another, or register them.';
        if (clean(landlord.phone || '') && clean(landlord.phone) === clean(tenantPhone)) return `${landlord.name} has the same phone as the tenant 🤔 The tenant and landlord need different numbers.`;
        return null;
      case 'address':
        return text.trim() ? null : 'Type an address, even a nearby landmark works 🙂';
      case 'photos': {
        const missing = housePhotos.filter((p) => !p).length;
        return missing ? `${missing === 4 ? 'I need' : 'Just'} ${missing} more photo${missing === 1 ? '' : 's'} 📸 Front, back, left and right.` : null;
      }
      case 'tenantPhoto':
        if (!tenantPhoto) return `Take ${tenantNameParts.firstName.trim() || 'the tenant'}’s passport photo first 📸`;
        return faceCheckBlocker(faceCheck);
      case 'gps':
        return gps ? null : 'Tap capture while you’re standing at the house 🛰️';
      case 'lc1Phone': {
        const p = phoneProblem(text, 'the LC1');
        if (p) return p;
        const c = clean(formatPhone(text));
        if (c === clean(tenantPhone)) return 'That’s the tenant’s own number 🙂 The LC1 has to be a different person.';
        if (landlord && c === clean(landlord.phone || '')) return `That’s ${landlord.name}’s number, the landlord 🙂 The LC1 has to be a different person.`;
        return null;
      }
      case 'lc1Name':
        if (!lc1NameParts.firstName.trim() || !lc1NameParts.lastName.trim()) return 'I need the LC1’s first and last name 🙂';
        return null;
      case 'lc1Village':
        return text.trim() ? null : 'Which village? Type its name, like Kireka B 🏡';
      case 'city':
        return text.trim() ? null : 'Type the town or city, like Kira 🌆';
      default:
        return null;
    }
  };

  /** A corrected value to offer as a one-tap fix, when the mistake is a common one. */
  const fixFor = (s: StepId, text: string): string | null => {
    if (s === 'rent') {
      const n = parseInt(text.replace(/\D/g, ''), 10) || 0;
      return n > 0 && n < 5000 && n * 1000 >= 50000 ? groupDigits(String(n * 1000)) : null;
    }
    if (s === 'tenantPhone' || s === 'lc1Phone') {
      const d = text.replace(/\D/g, '');
      return /^[37][0-9]{8}$/.test(d) ? formatPhone(`0${d}`) : null;
    }
    return null;
  };

  /** One extra hint after the second wrong try at the same question. */
  const tipFor = (s: StepId): string | null => {
    switch (s) {
      case 'rent': return '💡 Tip: type the numbers only, like 450000. I’ll add the commas.';
      case 'tenantPhone': return '💡 Tip: ask the tenant to flash your phone, then copy the number from your call log.';
      case 'lc1Phone': return '💡 Tip: ask the LC1 to flash your phone, then copy the number from your call log.';
      case 'nationalId': return '💡 Tip: the NIN is printed on the front of the card next to “NIN”. Letters O and I are rare; check for zeros and ones.';
      case 'photos': return '💡 Tip: tap each empty box to open the camera.';
      case 'gps': return '💡 Tip: turn on location for this site in your browser settings, then step outside for a clearer signal.';
      default: return null;
    }
  };

  /** Rejects a wrong answer: says what is wrong, offers a fix if there is one, adds a tip on the third try. */
  const reject = (s: StepId, problem: string, text = draft) => {
    const tries = (wrongTries[s] ?? 0) + 1;
    setWrongTries((t) => ({ ...t, [s]: tries }));
    const tip = tries >= 3 ? tipFor(s) : null;
    setError(tip ? `${problem}\n${tip}` : problem);
    setFixOffer(fixFor(s, text));
  };

  /**
   * Runs the existing-record check for a step. Returns true when the value is
   * new; otherwise shows the locked notice (or a retry message) and returns false.
   */
  async function recordIsNew(step: RecordBlock['step'], value: string): Promise<boolean> {
    setRecordBlock(null);
    setRecordChecking(true);
    let verdict: RecordVerdict;
    try {
      verdict = step === 'tenantPhone' ? await checkTenantPhone(value, agentSelf)
        : step === 'nationalId' ? await checkNationalId(value, agentSelf)
          : await checkNewLc1Phone(value, agentSelf);
    } finally {
      setRecordChecking(false);
    }
    if (verdict.status === 'free') return true;
    if (verdict.status === 'unknown') {
      setError('I couldn’t check Welile’s records just now. Check your connection and send it again.');
      return false;
    }
    setRecordBlock(blockFor(step, verdict.hit === 'self', value));
    return false;
  }

  function advance(from: StepId) {
    const i = steps.indexOf(from);
    // When an earlier answer was edited, go back to where the agent had reached —
    // except for answers the next step depends on, which walk forward one step.
    const dependsOnNext = from === 'type' || from === 'rent' || from === 'landlord';
    const target = !dependsOnNext && i < furthestIdx && steps[furthestIdx] !== from
      ? steps[furthestIdx]
      : steps[Math.min(i + 1, steps.length - 1)];
    setCurrent(target);
    if (steps.indexOf(target) > steps.indexOf(furthest)) setFurthest(target);
  }

  const submitText = async (text = draft) => {
    const s = current;
    const problem = validate(s, text);
    if (problem) { reject(s, problem, text); return; }
    setFixOffer(null);
    hapticTap();
    switch (s) {
      case 'rent': setRentText(text.replace(/\D/g, '')); break;
      case 'tenantPhone': {
        const value = formatPhone(text);
        if (!(await recordIsNew('tenantPhone', value))) return;
        setTenantPhone(value);
        break;
      }
      case 'nationalId': {
        const value = text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        if (!(await recordIsNew('nationalId', value))) return;
        setNationalId(value);
        break;
      }
      case 'address': setAddress(text.trim()); break;
      case 'lc1Phone': {
        setLc1Phone(formatPhone(text));
        const m = await lookupLc1(text);
        setLc1Match(m);
        if (m?.village && !lc1Village) setLc1Village(m.village);
        // A brand-new LC1 must not be the agent or a landlord.
        if (!m && !(await recordIsNew('lc1Phone', formatPhone(text)))) return;
        if (m) {
          // A known LC1 skips the name question; `steps` only drops it next render.
          setCurrent('lc1Village');
          if (steps.indexOf('lc1Village') > steps.indexOf(furthest)) setFurthest('lc1Village');
          return;
        }
        // Unknown LC1: always ask the name next (it may have been skipped before).
        setCurrent('lc1Name');
        if (steps.indexOf('lc1Name') > steps.indexOf(furthest) || !steps.includes('lc1Name')) setFurthest('lc1Name');
        return;
      }
      case 'lc1Village': setLc1Village(text.trim()); break;
      case 'city': setCity(text.trim()); break;
    }
    advance(s);
  };

  const continueStep = () => {
    const problem = validate(current);
    if (problem) { reject(current, problem); return; }
    hapticTap();
    advance(current);
  };

  const post = async () => {
    if (!user || !fees || !landlord || !tenantPhoto || posting) return;
    if (!consent) { setError('Tick the box to accept guarantor responsibility.'); return; }
    if (postingBlocked) { setError('Posting is closed for you right now.'); return; }
    setPosting(true);
    setError(null);
    // Re-check right before posting: the number or ID may have been registered since it was typed.
    const [phoneNow, ninNow] = await Promise.all([checkTenantPhone(tenantPhone, agentSelf), checkNationalId(nationalId, agentSelf)]);
    for (const [step, verdict, value] of [['tenantPhone', phoneNow, tenantPhone], ['nationalId', ninNow, nationalId]] as const) {
      if (verdict.status === 'taken') {
        setPosting(false);
        setCurrent(step);
        setRecordBlock(blockFor(step, verdict.hit === 'self', value));
        return;
      }
      if (verdict.status === 'unknown') {
        setPosting(false);
        setError('I couldn’t check Welile’s records just now. Check your connection and tap Post again.');
        return;
      }
    }
    const res = await submitAssistantRentRequest({
      agentId: user.id,
      incomeType,
      earnerCycle,
      fees,
      tenantName,
      tenantPhone,
      tenantNationalId: nationalId,
      preferredLanguage: language,
      noSmartphone: !!noSmartphone,
      landlordId: landlord.id,
      landlordName: landlord.name,
      landlordPhone: landlord.phone || '',
      house,
      houseCategory: category,
      propertyCity: city,
      propertyDistrict: district || location?.district || '',
      location,
      gps,
      housePhotos: housePhotos.filter(Boolean).map((p) => p!.file),
      tenantPhoto: tenantPhoto.file,
      faceCheckSha256: faceCheck?.sha256 ?? null,
      lc1Name,
      lc1Phone,
      lc1Village,
      lcLetter: lcLetter?.file ?? null,
      landlordPayoutDay: payoutDay || '1',
    });
    setPosting(false);
    if (res.ok) {
      hapticSuccess();
      setResult({ id: res.rentRequestId, existing: res.tenantExisting, lcLetterFailed: res.lcLetterFailed });
      onSuccess?.();
      return;
    }
    const fail = res as Extract<AssistantSubmitResult, { ok: false }>;
    if (fail.raw && promptIfNotVetted(fail.raw, fail.message)) {
      setError(agentNotVettedReason(fail.raw) ?? agentNotVettedReason(fail.message) ?? fail.message);
      return;
    }
    setError(fail.message);
    if (fail.backTo) {
      if (fail.backTo === 'house') { setHouse(null); setHouseChoiceMade(false); }
      setCurrent(fail.backTo);
    }
  };

  // ----- copy -----
  const questionOf = (s: StepId): string => {
    const first = tenantNameParts.firstName.trim() || 'the tenant';
    const landlordFirst = landlord?.name?.split(' ')[0] || 'the landlord';
    switch (s) {
      case 'type': return 'Let’s get started! 💼 How does the tenant earn their money? It decides how they’ll pay back.';
      case 'rent': return planType === 'weekly'
        ? 'Nice. How much is one month’s rent? 🏠 Welile pays the landlord this every month.'
        : 'Great! How much is the rent each month? 🏠 It needs to be at least UGX 50,000.';
      case 'plan': return planType === 'daily'
        ? `For ${formatUGX(amount)} rent, how long does the tenant need to pay it back? ⏳`
        : planType === 'weekly' ? 'How many weeks should Welile cover? 📅' : 'When will the tenant pay it back? 📅';
      case 'tenantPhone': return 'Lovely, the plan is set 👌 Now let’s meet the tenant. What’s their phone number? 📱';
      case 'tenantName': return 'Got it. What’s their full name, exactly as it’s written on their National ID? 🪪';
      case 'nationalId': return `Thanks! Now the NIN from ${first}’s National ID card. It usually starts with CM or CF. 🔢`;
      case 'language': return `Which language does ${first} understand best? 🗣️ I’ll send their SMS messages in it.`;
      case 'smartphone': return `Does ${first} have a smartphone? 📲`;
      case 'landlord': return `${first === 'the tenant' ? 'The tenant' : first} is all set ✅ Now the house. Who’s the landlord? Search by name or phone.`;
      case 'house': return `Which of ${landlordFirst}’s houses is it? 🏘️ Only houses with photos can be used.`;
      case 'location': return 'Where is the house? 📍 Pick the district, sub-county and village.';
      case 'address': return 'What’s the address? A plot number, road or landmark is fine. 🛣️';
      case 'category': return 'What kind of place is it? 🏠';
      case 'photos': return 'Photo time! 📸 Stand outside the house and take 4 photos: front, back, left and right.';
      case 'tenantPhoto': return `Now a passport photo of ${first}, please 🙂 I’ll check the face is clear.`;
      case 'gps': return 'While you’re standing at the house, capture its GPS location 🛰️';
      case 'lc1Phone': return `Almost there! 🙌 Last person: the LC1 chairperson who knows ${first}. What’s their phone number?`;
      case 'lc1Name': return 'I don’t know this LC1 yet 🤝 What’s their name?';
      case 'lc1Village': return 'Which village is the LC1 for? 🏡';
      case 'city': return 'Which town or city is the house in? 🌆';
      case 'lcLetter': return 'Do you have a stamped LC1 letter? 📄 It’s optional: JPG or PNG, up to 10 MB.';
      case 'payoutDay': return `Which day of the month should Welile pay ${landlordFirst}? 🗓️ Most agents pick the day the rent falls due.`;
      case 'review': return 'All done, well done! 🎉 Here’s the request. Tap any answer above if you want to change it.';
    }
  };

  const answerOf = (s: StepId): string => {
    switch (s) {
      case 'type': return planType === 'daily' ? 'Daily income earner' : planType === 'weekly' ? 'Weekly earner' : 'Monthly earner';
      case 'rent': return formatUGX(amount);
      case 'plan': return planType === 'daily' ? `${duration} days` : planType === 'weekly' ? `${parseInt(repaymentPeriod, 10) / 7} week${repaymentPeriod === '7' ? '' : 's'}` : repaymentPeriod === '30' ? 'After 1 month' : 'Over 4 months';
      case 'tenantPhone': return tenantPhone;
      case 'tenantName': return tenantName;
      case 'nationalId': return nationalId;
      case 'language': return language;
      case 'smartphone': return noSmartphone ? 'No smartphone' : 'Has a smartphone';
      case 'landlord': return landlord?.name ?? '';
      case 'house': return house ? house.title : 'No listed house';
      case 'location': return location ? `${location.district} › ${location.subcounty} › ${location.village}` : '';
      case 'address': return address;
      case 'category': return HOUSE_CATEGORIES.find((c) => c.value === category)?.label ?? '';
      case 'photos': return '4 house photos taken';
      case 'tenantPhoto': return 'Passport photo taken';
      case 'gps': return gps ? (gps.accuracy ? `GPS captured, accurate to ${Math.round(gps.accuracy)} m` : 'GPS from the house listing') : '';
      case 'lc1Phone': return lc1Phone;
      case 'lc1Name': return lc1Name;
      case 'lc1Village': return lc1Village;
      case 'city': return city;
      case 'lcLetter': return lcLetter ? 'LC letter added' : 'No LC letter';
      case 'payoutDay': return `The ${ordinal(payoutDay)}`;
      case 'review': return '';
    }
  };

  const isTextStep = ['rent', 'tenantPhone', 'nationalId', 'address', 'lc1Phone', 'lc1Village', 'city'].includes(current);

  const spokenReply = capLoading
    ? 'Checking whether you can post today.'
    : postingBlocked && myCap
      ? `You can’t post a Rent Plan yet ${myCap.posting_rule === 'weekly' ? 'this week' : 'today'}. ${blockedReason(myCap)}`
      : result
        ? `Done. ${tenantNameParts.firstName}’s request for ${formatUGX(amount)} is now with our team.${!result.existing ? ` ${tenantNameParts.firstName} will get an SMS in ${language || 'English'} inviting them to join Welile.` : ''}${result.lcLetterFailed ? ' The LC letter didn’t upload. Add it later from My rent requests.' : ''}`
        : recordBlock && recordBlock.step === current
          ? `${recordHeadline(recordBlock, true)} ${recordBody(recordBlock)}`
          : error || questionOf(current);
  const speech = useAssistantSpeech(spokenReply, open && !showRegisterLandlord, user?.id);

  useEffect(() => {
    if (speech.failed) toast.error('Voice playback is unavailable. You can still read the assistant’s replies.');
  }, [speech.failed]);

  if (!open) return null;

  // ----- render -----
  // z-[115]: full-screen, so it must cover the bottom role bar (100), the assistant launcher/bubble (105/106) and the WhatsApp button (60).
  return (
    <div className="fixed inset-0 z-[115] flex flex-col bg-background text-foreground" role="dialog" aria-modal="true" aria-label="Rent request assistant">
      <header className="flex items-center gap-2.5 border-b border-border bg-card px-3 py-2.5 pt-safe">
        <button type="button" aria-label="Close" onClick={() => onOpenChange(false)} className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-muted">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <Avatar size="lg" />
        <div className="min-w-0 flex-1">
          <p className="font-display text-base font-bold leading-tight">Welile Assistant</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            {result ? 'Request posted' : 'Preview · posting a Rent Plan with you'}
          </p>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="shrink-0 text-primary" disabled={!speech.supported} aria-label={speech.enabled ? 'Turn voice off' : 'Turn voice on'} aria-pressed={speech.enabled} onClick={speech.toggle}>
                {speech.enabled ? <Volume2 /> : <VolumeX />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{speech.supported ? (speech.enabled ? 'Turn voice off' : 'Turn voice on') : 'Voice unavailable on this browser'}</TooltipContent>
          </Tooltip>
          {speech.enabled && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="shrink-0 text-primary" aria-label={speech.speaking ? 'Stop speaking' : 'Replay reply'} onClick={speech.speaking ? speech.stop : speech.replay}>
                  {speech.speaking ? <Square /> : <RotateCcw />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{speech.speaking ? 'Stop speaking' : 'Replay reply'}</TooltipContent>
            </Tooltip>
          )}
        </TooltipProvider>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-xl flex-col gap-3.5">
          <div className="px-1 pb-1 pt-2">
            <h1 className="font-display text-[26px] font-extrabold leading-8 tracking-tight">
              {greeting.text}, <span className="text-foreground/65">{metaOf(user).full_name?.split(' ')[0] || 'Agent'}</span> {greeting.emoji}
            </h1>
            <p className="mt-1 text-base text-muted-foreground">I’ll help you add a new tenant whenever you’re ready!</p>
          </div>

          {capLoading ? (
            <Bot><Bubble><Loader2 className="inline h-4 w-4 animate-spin" /> Checking whether you can post today…</Bubble></Bot>
          ) : postingBlocked && myCap ? (
            <Bot>
              <Bubble tone="warn">
                <b>You can’t post a Rent Plan yet {myCap.posting_rule === 'weekly' ? 'this week' : 'today'}.</b>{' '}
                {blockedReason(myCap)}
              </Bubble>
            </Bot>
          ) : (
            <>
              {myCap && (
                <Bot><Bubble>Good news 🎉 You can post a rent request today! {myCap.tenants_due > 0 ? `${myCap.tenants_paid_today} of your ${myCap.tenants_due} tenants due have already paid.` : ''}</Bubble></Bot>
              )}

              {steps.slice(0, idx).map((s) => (
                <div key={s} className="flex flex-col gap-3.5">
                  <Bot><Bubble>{questionOf(s)}</Bubble></Bot>
                  {answerOf(s) && (
                    <button type="button" onClick={() => !result && !posting && setCurrent(s)} className="self-end" aria-label={`Change answer: ${answerOf(s)}`}>
                      <MeBubble>{answerOf(s)}</MeBubble>
                    </button>
                  )}
                  {s === 'plan' && fees && <PlanSummary planType={planType!} fees={fees} amount={amount} />}
                  {s === 'landlord' && landlord && <LandlordStatusNote status={landlordStatus} agreement={agreementOnFile} verifyReq={verifyReq} onRequest={requestLandlordVerification} name={landlord.name} />}
                  {s === 'lc1Phone' && lc1Match && (
                    <Bot><Bubble><b>{lc1Match.name}</b>, LC1 for {lc1Match.village || 'their village'}{lc1Match.verified ? ' · verified' : ' · not verified yet'}. I’ll send them a verification SMS.</Bubble></Bot>
                  )}
                </div>
              ))}

              {!result && (
                <div className="flex flex-col gap-3">
                  <Bot><Bubble>{questionOf(current)}</Bubble></Bot>
                  <div className="pl-9">{renderWidget()}</div>
                  {recordChecking && <Bot><Bubble><Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> Checking Welile’s records…</Bubble></Bot>}
                  {recordBlock && recordBlock.step === current && (
                    <RecordExistsNotice block={recordBlock} onRetry={() => { setDraft(''); setRecordBlock(null); }} />
                  )}
                  {error && (
                    <Bot>
                      <Bubble tone="warn"><span className="whitespace-pre-line">{error}</span></Bubble>
                      {fixOffer && (
                        <div className="flex flex-wrap gap-2">
                          <Chip onClick={() => { setDraft(fixOffer); void submitText(fixOffer); }}>Yes, use {fixOffer}</Chip>
                          <Chip onClick={() => { setError(null); setFixOffer(null); }}>No, I’ll retype it</Chip>
                        </div>
                      )}
                    </Bot>
                  )}
                </div>
              )}

              {result && (
                <>
                  <Bot>
                    <Bubble>
                      <span className="mb-1.5 inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-semibold text-success"><Check className="h-3 w-3" /> Posted</span>
                      <br />
                      Done. {tenantNameParts.firstName}’s request for {formatUGX(amount)} is now with our team.
                      {!result.existing && ` ${tenantNameParts.firstName} will get an SMS in ${language || 'English'} inviting them to join Welile.`}
                    </Bubble>
                  </Bot>
                  {result.lcLetterFailed && <Bot><Bubble tone="warn">The LC letter didn’t upload. Add it later from My rent requests.</Bubble></Bot>}
                  <div className="flex flex-wrap gap-2 pl-9">
                    <Chip onClick={reset}>Post another</Chip>
                    <Chip onClick={() => onOpenChange(false)}>Back to dashboard</Chip>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {!result && !postingBlocked && !capLoading && current !== 'review' && (
        <footer className="border-t border-border bg-card px-3 pb-safe pt-2.5">
          <div className="mx-auto flex max-w-xl items-center gap-2 pb-3">
            {isTextStep ? (
              <form
                className="flex flex-1 items-center gap-2"
                onSubmit={(e) => { e.preventDefault(); void submitText(); }}
              >
                <input
                  aria-label="Your answer"
                  autoFocus
                  inputMode={['rent', 'tenantPhone', 'lc1Phone'].includes(current) ? 'numeric' : 'text'}
                  value={draft}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (current === 'rent') setDraft(groupDigits(v));
                    else if (current === 'tenantPhone' || current === 'lc1Phone') setDraft(formatPhone(v));
                    else if (current === 'nationalId') setDraft(v.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 14));
                    else setDraft(v);
                    setError(null);
                    setFixOffer(null);
                    setRecordBlock(null);
                  }}
                  placeholder={placeholderOf(current)}
                  className="h-11 min-w-0 flex-1 rounded-full border border-border bg-background px-4 text-base outline-none focus:border-primary"
                />
                <button type="submit" aria-label="Send" disabled={lc1Looking || recordChecking} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-60">
                  {lc1Looking || recordChecking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={continueStep}
                className="h-11 flex-1 rounded-full bg-primary font-semibold text-primary-foreground"
              >
                Continue
              </button>
            )}
          </div>
        </footer>
      )}

      <RegisterLandlordDialog
        open={showRegisterLandlord}
        onOpenChange={setShowRegisterLandlord}
        onSuccess={(l) => {
          setShowRegisterLandlord(false);
          if (l) setLandlord({ id: l.id, name: l.name, phone: l.phone, property_address: l.property_address });
        }}
      />
    </div>
  );

  function renderWidget(): ReactNode {
    switch (current) {
      case 'type':
        return (
          <div className="flex flex-col gap-2">
            {([
              ['daily', 'Daily income earner', 'Pays back every day over 30, 60 or 90 days'],
              ['weekly', 'Weekly earner', 'Pays once a week'],
              ['monthly', 'Monthly earner', 'Pays after 1 month, or over 4 months'],
            ] as const).map(([v, title, sub]) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  hapticTap();
                  setPlanType(v);
                  if (v === 'daily') setDuration('30');
                  else setRepaymentPeriod(v === 'weekly' ? '7' : '30');
                  advance('type');
                }}
                className={cn('flex min-h-16 items-center gap-3 rounded-2xl border bg-card p-3 text-left', planType === v ? 'border-primary' : 'border-border')}
              >
                <span className="flex-1">
                  <span className="block font-display text-[15px] font-bold">{title}</span>
                  <span className="block text-xs text-muted-foreground">{sub}</span>
                </span>
              </button>
            ))}
          </div>
        );
      case 'plan': {
        const options: [string, string][] = planType === 'daily'
          ? [['30', '30 days'], ['60', '60 days'], ['90', '90 days']]
          : planType === 'weekly'
            ? [['7', '1 week'], ['14', '2 weeks'], ['21', '3 weeks']]
            : [['30', 'After 1 month'], ['120', 'Over 4 months']];
        const selected = planType === 'daily' ? duration : repaymentPeriod;
        return (
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap gap-2">
              {options.map(([v, label]) => (
                <Chip key={v} on={selected === v} onClick={() => (planType === 'daily' ? setDuration(v as '30' | '60' | '90') : setRepaymentPeriod(v))}>{label}</Chip>
              ))}
            </div>
            {fees && <PlanSummary planType={planType!} fees={fees} amount={amount} />}
          </div>
        );
      }
      case 'tenantName':
        return (
          <NameFields value={tenantNameParts} onChange={setTenantNameParts} />
        );
      case 'language':
        return (
          <div className="flex flex-wrap gap-2">
            {LANGUAGES.map((l) => <Chip key={l} on={language === l} onClick={() => { setLanguage(l); advance('language'); }}>{l}</Chip>)}
          </div>
        );
      case 'smartphone':
        return (
          <div className="flex flex-wrap gap-2">
            <Chip on={noSmartphone === false} onClick={() => { setNoSmartphone(false); advance('smartphone'); }}>Yes, a smartphone</Chip>
            <Chip on={noSmartphone === true} onClick={() => { setNoSmartphone(true); advance('smartphone'); }}>No smartphone</Chip>
          </div>
        );
      case 'landlord':
        return (
          <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-2">
            <LandlordSearchSelect value={landlord} inline registeredBy={null} onChange={(l) => { setLandlord(l); setError(null); }} onAddNew={() => setShowRegisterLandlord(true)} />
            {landlord && <LandlordStatusNote status={landlordStatus} agreement={agreementOnFile} verifyReq={verifyReq} onRequest={requestLandlordVerification} name={landlord.name} />}
          </div>
        );
      case 'house':
        if (houses === null) return <p className="text-sm text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> Looking up houses…</p>;
        return (
          <div className="flex flex-col gap-2">
            {houses.length === 0 && <p className="text-sm text-muted-foreground">No available houses are listed for this landlord.</p>}
            {houses.map((h) => {
              const usable = listingHasRealPhoto(h);
              return (
                <button
                  key={h.id}
                  type="button"
                  disabled={!usable}
                  onClick={() => pickHouse(h)}
                  className={cn('flex items-center gap-3 rounded-xl border bg-card p-2.5 text-left disabled:opacity-60', house?.id === h.id ? 'border-2 border-primary' : 'border-border')}
                >
                  {usable
                    ? <img src={h.image_urls[0]} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
                    : <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-muted"><Camera className="h-4 w-4 text-muted-foreground" /></span>}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold">{h.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {usable ? `${h.image_urls.length} photo${h.image_urls.length === 1 ? '' : 's'}${h.monthly_rent ? ` · ${formatUGX(h.monthly_rent)}` : ''}` : 'No photos · can’t be used yet'}
                    </span>
                  </span>
                </button>
              );
            })}
            <Chip onClick={() => pickHouse(null)}>The house isn’t listed</Chip>
          </div>
        );
      case 'location':
        return (
          <div className="rounded-2xl border border-border bg-card p-3">
            <UgLocationPicker
              value={location}
              onChange={(sel) => {
                setLocation(sel);
                if (sel) {
                  if (!address) setAddress(sel.village);
                  setCity(sel.subcounty || sel.county);
                  setDistrict(normalizeDistrict(sel.district) || sel.district);
                  setLc1Village((v) => v || sel.village);
                }
              }}
            />
            <button type="button" onClick={() => advance('location')} className="mt-2 text-sm font-semibold text-primary">Skip, I’ll type the address</button>
          </div>
        );
      case 'category':
        return (
          <div className="flex flex-wrap gap-2">
            {HOUSE_CATEGORIES.map((c) => <Chip key={c.value} on={category === c.value} onClick={() => { setCategory(c.value); advance('category'); }}>{c.label}</Chip>)}
          </div>
        );
      case 'photos':
        return (
          <div className="grid max-w-xs grid-cols-2 gap-2">
            {PHOTO_SLOTS.map((label, i) => (
              <label key={label} className={cn('relative flex h-24 cursor-pointer flex-col items-center justify-center gap-1 overflow-hidden rounded-xl text-xs font-semibold', housePhotos[i] ? '' : 'border-2 border-dashed border-primary/40 bg-primary/5 text-primary')}>
                {housePhotos[i] ? (
                  <>
                    <img src={housePhotos[i]!.preview} alt={`${label} of the house`} className="absolute inset-0 h-full w-full object-cover" />
                    <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-2 py-1 text-white"><Check className="h-3 w-3" />{label}</span>
                  </>
                ) : (<><Camera className="h-5 w-5" />{label}</>)}
                <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => { void onHousePhoto(i, e.target.files?.[0]); e.target.value = ''; }} />
              </label>
            ))}
          </div>
        );
      case 'tenantPhoto':
        return (
          <div className="flex items-center gap-3">
            <label className={cn('relative flex h-24 w-20 cursor-pointer items-center justify-center overflow-hidden rounded-xl', tenantPhoto ? '' : 'border-2 border-dashed border-primary/40 bg-primary/5 text-primary')}>
              {tenantPhoto ? <img src={tenantPhoto.preview} alt="Tenant passport photo" className="h-full w-full object-cover" /> : <ImagePlus className="h-6 w-6" />}
              <input type="file" accept="image/*" capture="user" className="sr-only" onChange={(e) => { void onTenantPhoto(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            <p className="text-sm text-muted-foreground">
              {!tenantPhoto ? 'Tap to take the photo.'
                : faceCheck?.status === 'checking' ? 'Checking the face…'
                : faceCheck?.status === 'no_face' ? 'No face found. Tap the photo to retake it.'
                : 'Face found. Looks good.'}
            </p>
          </div>
        );
      case 'gps':
        return (
          <div className="flex flex-wrap items-center gap-2">
            <Chip on={!!gps} onClick={captureGps}>
              {gpsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPin className="h-3.5 w-3.5" />}
              {gps ? 'Recapture GPS' : 'Capture GPS'}
            </Chip>
            {gps && <span className="text-sm text-muted-foreground">{gps.accuracy ? `Accurate to ${Math.round(gps.accuracy)} m` : 'From the house listing'}</span>}
          </div>
        );
      case 'lc1Name':
        return <NameFields value={lc1NameParts} onChange={setLc1NameParts} />;
      case 'lcLetter':
        return (
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border border-primary/30 bg-card px-3.5 text-sm font-semibold text-primary">
              <ImagePlus className="h-3.5 w-3.5" /> {lcLetter ? 'Replace letter' : 'Add the letter'}
              <input type="file" accept="image/jpeg,image/png" className="sr-only" onChange={(e) => { onLcLetter(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            {!lcLetterDecided && <Chip onClick={() => { setLcLetterDecided(true); advance('lcLetter'); }}>No letter</Chip>}
          </div>
        );
      case 'payoutDay':
        return (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              {PAYOUT_DAYS.map((d) => <Chip key={d} on={payoutDay === d} onClick={() => { setPayoutDay(d); advance('payoutDay'); }}>{ordinal(d)}</Chip>)}
            </div>
            <p className="text-xs text-muted-foreground">Any day from the 1st to the 28th.</p>
          </div>
        );
      case 'review':
        return (
          <div className="flex flex-col gap-3">
            <div className="rounded-2xl border border-border bg-card p-3 text-sm">
              <Row k="Rent Plan" v={`${formatUGX(amount)} · ${answerOf('plan')}`} />
              <Row k="Tenant" v={`${tenantName} · ${tenantPhone}`} />
              <Row k="Landlord" v={`${landlord?.name ?? ''}${landlordStatus === 'unverified' ? ' (verification pending)' : ''}`} />
              <Row k="House" v={`${answerOf('category')} · ${address}`} />
              <Row k="LC1" v={`${lc1Name} · ${lc1Village}`} />
              <Row k="Landlord paid on" v={`The ${ordinal(payoutDay)}`} />
            </div>
            <GuarantorConsentCheckbox checked={consent} onCheckedChange={(c) => { setConsent(c); setError(null); }} />
            <button
              type="button"
              onClick={() => void post()}
              disabled={posting}
              className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-primary font-display text-base font-bold text-primary-foreground shadow-lg disabled:opacity-70"
            >
              {posting ? <><Loader2 className="h-5 w-5 animate-spin" /> Posting…</> : <><Send className="h-5 w-5" /> Post rent request</>}
            </button>
          </div>
        );
      default:
        // Text steps answer in the composer below.
        return null;
    }
  }

  function blockedReason(c: NonNullable<typeof myCap>): string {
    if (c.posting_rule === 'weekly') {
      return c.weekly_posting?.reason ?? 'Your collections last week were below the target. You can post again when a week meets it.';
    }
    const needed = Math.max(0, Math.ceil(c.tenants_due * DAILY_ELIGIBILITY_THRESHOLD) - c.tenants_paid_today);
    const t = (n: number) => (n === 1 ? 'tenant' : 'tenants');
    return `You have reached ${c.tenants_paid_today} of ${c.tenants_due} ${t(c.tenants_due)} today, and ${c.tenants_paid_yesterday} yesterday. Collect from ${needed} more ${t(needed)} today to post new Rent Plans. Any payment counts, however small.`;
  }
}

function ordinal(d: string): string {
  const n = parseInt(d, 10) || 1;
  const s = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
  return `${n}${s}`;
}

function placeholderOf(s: StepId): string {
  switch (s) {
    case 'rent': return 'e.g. 450,000';
    case 'tenantPhone': case 'lc1Phone': return 'e.g. 0783 123 456';
    case 'nationalId': return 'e.g. CM12345678ABCD';
    case 'address': return 'e.g. Plot 14, Kireka Road';
    case 'lc1Village': return 'e.g. Kireka B';
    case 'city': return 'e.g. Kira';
    default: return 'Type your answer';
  }
}

function Avatar({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  return (
    <span
      aria-hidden="true"
      className={cn('flex shrink-0 items-center justify-center rounded-full text-white', size === 'lg' ? 'h-9 w-9' : 'h-7 w-7')}
      style={{ background: 'linear-gradient(137deg, hsl(271 85% 62%), hsl(271 81% 48%) 54%, hsl(258 72% 34%))' }}
    >
      <Sparkles className={size === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
    </span>
  );
}

interface RecordBlock {
  step: 'tenantPhone' | 'nationalId' | 'lc1Phone';
  /** The agent typed their own number or ID. */
  self: boolean;
  /** The refused value, masked. */
  masked: string;
}

function blockFor(step: RecordBlock['step'], self: boolean, value: string): RecordBlock {
  return { step, self, masked: step === 'nationalId' ? maskNationalId(value) : maskPhone(value) };
}

/** `spoken` drops the masked value, which reads badly aloud. */
function recordHeadline(block: RecordBlock, spoken: boolean): string {
  if (block.self) return block.step === 'nationalId' ? 'That’s your own National ID.' : 'That’s your own number.';
  if (spoken) return block.step === 'nationalId' ? 'That National ID is already on Welile.' : 'That number is already on Welile.';
  return `${block.masked} is already on Welile.`;
}

function recordBody(block: RecordBlock): string {
  if (block.self) {
    return block.step === 'lc1Phone'
      ? 'The LC1 has to be someone else, so they can vouch for the tenant.'
      : 'A tenant needs their own, so their Rent Plan messages reach them and not you.';
  }
  if (block.step === 'nationalId') return 'One National ID belongs to one person, so I can’t add it again. Check the card with the tenant and type it again.';
  if (block.step === 'lc1Phone') return 'It already belongs to someone else, so it can’t be a new LC1’s number. Ask the chairperson for their own phone.';
  return 'A new tenant needs a number that isn’t registered yet. Ask the tenant to read it out again, or use another number they own.';
}

/**
 * Shown when a typed number or ID is already on Welile. It says the record
 * exists, never whose it is, and the chat stays on the same question.
 */
function RecordExistsNotice({ block, onRetry }: { block: RecordBlock; onRetry: () => void }) {
  const [why, setWhy] = useState(false);
  const what = block.step === 'nationalId' ? 'National ID' : 'number';
  const headline = recordHeadline(block, false);
  const body = recordBody(block);
  return (
    <Bot>
      <Bubble tone="warn">
        <span className="mb-1 flex items-center gap-1.5 font-semibold"><Lock className="h-4 w-4 shrink-0" /> {headline}</span>
        {body}
        {!block.self && why && (
          <span className="mt-2 block text-sm text-muted-foreground">
            Numbers and IDs belong to people. If I showed who owns one, anyone could look people up, so I only tell you it’s taken. I won’t move to the next question until the {what} is new.
          </span>
        )}
      </Bubble>
      <div className="flex flex-wrap gap-2">
        <Chip onClick={onRetry}>Type a different {what}</Chip>
        {!block.self && !why && <Chip onClick={() => setWhy(true)}>Why can’t I see whose?</Chip>}
      </div>
    </Bot>
  );
}

function Bot({ children }: { children: ReactNode }) {
  return <div className="flex items-start gap-2"><Avatar /><div className="flex min-w-0 flex-col gap-2">{children}</div></div>;
}

function Bubble({ children, tone }: { children: ReactNode; tone?: 'warn' }) {
  return (
    <div className={cn(
      'max-w-[19rem] rounded-[6px_18px_18px_18px] border px-3.5 py-2.5 text-[15px] leading-[21px]',
      tone === 'warn' ? 'border-warning/40 bg-warning/10 text-foreground' : 'border-border bg-card',
    )}>
      {children}
    </div>
  );
}

function MeBubble({ children }: { children: ReactNode }) {
  return <div className="max-w-[17rem] rounded-[18px_6px_18px_18px] bg-primary px-3.5 py-2.5 text-left text-[15px] leading-[21px] text-primary-foreground">{children}</div>;
}

function Chip({ children, on, onClick }: { children: ReactNode; on?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={() => { hapticTap(); onClick?.(); }}
      aria-pressed={on}
      className={cn(
        'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold',
        on ? 'border-primary bg-primary text-primary-foreground' : 'border-primary/30 bg-card text-primary',
      )}
    >
      {on && <Check className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border py-1.5 last:border-0">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right font-medium">{v}</span>
    </div>
  );
}

function NameFields({ value, onChange }: { value: PersonNameParts; onChange: (v: PersonNameParts) => void }) {
  const cap = (s: string) => s.replace(/^\s+/, '').replace(/\s{2,}/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  const field = (key: keyof PersonNameParts, label: string, required: boolean) => (
    <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
      {label}{required ? '' : ' (optional)'}
      <input
        value={value[key]}
        onChange={(e) => onChange({ ...value, [key]: cap(e.target.value) })}
        className="h-11 rounded-xl border border-border bg-background px-3 text-base font-normal text-foreground outline-none focus:border-primary"
      />
    </label>
  );
  return (
    <div className="flex max-w-xs flex-col gap-2 rounded-2xl border border-border bg-card p-3">
      {field('firstName', 'First name', true)}
      {field('otherNames', 'Other names', false)}
      {field('lastName', 'Last name', true)}
    </div>
  );
}

function PlanSummary({ planType, fees, amount }: { planType: PlanType; fees: NonNullable<ReturnType<typeof computeAssistantFees>>; amount: number }) {
  const [open, setOpen] = useState(false);
  const headline = planType === 'weekly'
    ? { label: 'Weekly repayment', value: formatUGX(weeklyRepaymentFor(amount)), unit: 'a week' }
    : planType === 'daily'
      ? { label: `${fees.durationDays}-day Rent Plan`, value: formatUGX(fees.dailyRepayment), unit: 'a day' }
      : { label: fees.durationDays === 30 ? '1 month' : '4 months', value: formatUGX(fees.totalRepayment), unit: 'in total' };
  return (
    <Bot>
      <div className="w-64 rounded-[6px_18px_18px_18px] border border-border bg-card px-3.5 py-2.5">
        <p className="text-xs text-muted-foreground">{headline.label}</p>
        <p className="flex items-baseline gap-1.5"><span className="font-mono text-[22px] font-semibold leading-7 text-primary">{headline.value}</span><span className="text-sm text-muted-foreground">{headline.unit}</span></p>
        <p className="text-sm leading-5">
          {planType === 'weekly'
            ? `One month’s rent plus 33%, split over 4 weeks. Payments start today.`
            : `That is ${formatUGX(fees.totalRepayment)} in total, starting the day after funding.`}
        </p>
        {open && (
          <div className="mt-2 space-y-1 border-t border-dashed border-border pt-2 text-[13px]">
            <div className="flex justify-between"><span className="text-muted-foreground">Rent</span><span className="font-mono">{formatUGX(fees.rentAmount)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Access fee</span><span className="font-mono">{formatUGX(fees.accessFee)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">{planType === 'daily' ? 'Request fee' : 'Platform fee'}</span><span className="font-mono">{formatUGX(fees.requestFee)}</span></div>
          </div>
        )}
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 min-h-8 text-[13px] font-semibold text-primary">
          {open ? 'Hide breakdown' : 'See breakdown'}
        </button>
      </div>
    </Bot>
  );
}

function LandlordStatusNote({ status, agreement, verifyReq, onRequest, name }: {
  status: 'idle' | 'checking' | 'verified' | 'unverified' | 'missing';
  agreement: boolean | null;
  verifyReq: 'idle' | 'sending' | 'sent' | 'exists';
  onRequest: () => void;
  name: string;
}) {
  if (status === 'idle') return null;
  if (status === 'checking') return <p className="px-1 text-xs text-muted-foreground"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Checking {name}…</p>;
  if (status === 'missing') return <p className="px-1 text-sm text-destructive">{name} is no longer in the system. Pick another landlord or register them.</p>;
  return (
    <div className="flex flex-col gap-1.5 px-1">
      <div className="flex flex-wrap gap-1.5">
        <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', status === 'verified' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning-foreground')}>
          {status === 'verified' ? 'Verified landlord' : 'Verification pending'}
        </span>
        {agreement === false && <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">No signed agreement on file</span>}
      </div>
      {status === 'unverified' && (
        verifyReq === 'sent' || verifyReq === 'exists'
          ? <p className="text-xs text-muted-foreground">Landlord Ops {verifyReq === 'sent' ? 'have been asked' : 'were already asked'} to verify {name}. You can still post; the request waits for their check.</p>
          : (
            <button type="button" onClick={onRequest} disabled={verifyReq === 'sending'} className="self-start text-sm font-semibold text-primary disabled:opacity-60">
              {verifyReq === 'sending' ? 'Sending…' : `Ask Landlord Ops to verify ${name.split(' ')[0]}`}
            </button>
          )
      )}
    </div>
  );
}

