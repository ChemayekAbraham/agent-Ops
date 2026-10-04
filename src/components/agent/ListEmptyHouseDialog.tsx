import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Home, MapPin, Loader2, ShieldCheck, Search, X, UserCheck, Share2, MessageCircle, Copy, Check, PartyPopper, ChevronDown, ArrowLeft, ArrowRight, Camera, Trophy, Sparkles, User, ImagePlus, CheckCircle2, AlertTriangle, GripVertical, RotateCcw } from 'lucide-react';
import { PhoneInput } from '@/components/ui/phone-input';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { calculateDailyRentalRate } from '@/hooks/useHouseListings';
import { Lc1ChairpersonPicker, validateLc1Selection, type Lc1Selection } from './Lc1ChairpersonPicker';
import { isValidPhoneNumberGlobal, normalizeUgandaPhone, displayNormalizeUgandaPhone, formatUgandaPhone, toUgandaLocalDigits } from '@/lib/phoneUtils';
import FormStepHeader from '@/components/shared/FormStepHeader';
import FieldError from '@/components/shared/FieldError';
import { HouseImageUploader, uploadHouseImages, type HouseImageFile } from './HouseImageUploader';
import { notifyVerificationCreated } from '@/lib/landlordVerificationNotify';
import VerificationRequestDetailSheet from './VerificationRequestDetailSheet';
import { LandlordAutocompleteInput } from './LandlordAutocompleteInput';
import type { LandlordOption } from './LandlordSearchSelect';
import { reverseGeocode } from '@/lib/reverseGeocode';
import { GpsQualityIndicator } from '@/components/shared/GpsQualityIndicator';
import { captureSmartLocation } from '@/hooks/useSmartLocation';
import {
  saveHouseListingDraft,
  loadHouseListingDraft,
  clearHouseListingDraft,
} from '@/lib/houseListingDraft';
import { isListingDaytime, LISTING_NIGHT_MESSAGE } from '@/lib/listingHours';

const APP_URL = 'https://welileapp.com';

interface ListEmptyHouseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  /** Pre-fill the landlord fields (e.g. when opened from the landlord registration form). */
  initialLandlordName?: string;
  initialLandlordPhone?: string;
  /** Pre-fill the LC1 chairperson fields (e.g. when opened from the rent-request verification gate). */
  initialLc1Name?: string;
  initialLc1Phone?: string;
  initialLc1Village?: string;
  /** When true, shows promotional campaign badge and applies promo defaults (opened from the agent dashboard banner). */
  fromPromoBanner?: boolean;
}

const HOUSE_CATEGORIES = [
  { value: 'single_room', label: 'Single Room' },
  { value: 'double_room', label: 'Double Room' },
  { value: 'bedsitter', label: 'Bedsitter' },
  { value: 'one_bedroom', label: '1 Bedroom' },
  { value: 'two_bedroom', label: '2 Bedrooms' },
  { value: 'three_bedroom', label: '3 Bedrooms' },
  { value: 'studio', label: 'Studio' },
  { value: 'shop', label: 'Shop / Lock-up Shop' },
  { value: 'market_stall', label: 'Market Stall' },
  { value: 'kiosk', label: 'Kiosk / Container' },
  { value: 'salon_workshop', label: 'Salon / Workshop' },
  { value: 'office_space', label: 'Office Space' },
  { value: 'warehouse_store', label: 'Warehouse / Store' },
  { value: 'commercial_premises', label: 'Other Commercial Premises' },
];

import { normalizeDistrict, UGANDA_REGION_GROUPS } from '@/lib/ugandaDistricts';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import type { UgLocationSelection } from '@/hooks/useUgLocations';

// Map a selected village's district back to the backend region enum.
const DISTRICT_TO_BACKEND_REGION: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const g of UGANDA_REGION_GROUPS) {
    for (const d of g.districts) m[d.name] = d.backendRegion;
  }
  return m;
})();

export function ListEmptyHouseDialog({ open, onOpenChange, onSuccess, initialLandlordName, initialLandlordPhone, initialLc1Name, initialLc1Phone, initialLc1Village, fromPromoBanner = false }: ListEmptyHouseDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  // Guided wizard step (1-4) so agents who struggle with long forms only see
  // one simple question at a time.
  const [step, setStep] = useState(1);
  // LC1 chairperson: search-first selection or a brand-new registration.
  const [lc1Selection, setLc1Selection] = useState<Lc1Selection | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [showOptional, setShowOptional] = useState(false);
  // Landlord phone real-time validation error
  const [landlordPhoneError, setLandlordPhoneError] = useState<string>('');
  // Inline banner shown at the bottom of the form (right above the action
  // buttons) so agents see submit errors/success WITHOUT the dialog jumping
  // them back to the top of step 3. Auto-clears after a short delay.
  const [formMessage, setFormMessage] = useState<
    { kind: 'error' | 'success' | 'info'; text: string; description?: string } | null
  >(null);
  const showFormMessage = (
    kind: 'error' | 'success' | 'info',
    text: string,
    description?: string,
  ) => {
    setFormMessage({ kind, text, description });
  };
  // Auto-dismiss inline banner after 6s (success stays a bit longer).
  useEffect(() => {
    if (!formMessage) return;
    const t = window.setTimeout(
      () => setFormMessage(null),
      formMessage.kind === 'success' ? 8000 : 6000,
    );
    return () => window.clearTimeout(t);
  }, [formMessage]);
  const [successListing, setSuccessListing] = useState<null | {
    id: string;
    shortCode: string | null;
    title: string;
    region: string;
    dailyRate: number;
  }>(null);
  const [copied, setCopied] = useState(false);
  // ─── Landlord search-first flow ───
  // Agents must search the system for the landlord (by verified name) before
  // listing, so houses link to an existing verified landlord instead of
  // creating duplicates.
  type LandlordHit = {
    id: string;
    name: string;
    phone: string;
    verified: boolean;
    verifiedHouses: number;
  };
  const [landlordQuery, setLandlordQuery] = useState('');
  const [landlordResults, setLandlordResults] = useState<LandlordHit[]>([]);
  const [searchingLandlord, setSearchingLandlord] = useState(false);
  const [searchedOnce, setSearchedOnce] = useState(false);
  const [selectedLandlord, setSelectedLandlord] = useState<LandlordHit | null>(null);
  const [manualLandlord, setManualLandlord] = useState(false);
  // Verification ping: when the linked landlord exists but isn't verified yet,
  // the agent can ping Landlord Ops to verify so the house can go live.
  const [verifyReqState, setVerifyReqState] = useState<'idle' | 'sending' | 'sent' | 'exists'>('idle');
  // Real DB status of the latest verification request (polls while dialog open).
  type VerifyDbStatus = 'pending' | 'verified' | 'rejected' | null;
  const [verifyDbStatus, setVerifyDbStatus] = useState<VerifyDbStatus>(null);
  const [verifyDbComment, setVerifyDbComment] = useState<string | null>(null);
  const [verifyRequestId, setVerifyRequestId] = useState<string | null>(null);
  // Side panel: shows verification request details in-place via the toast action,
  // keeping this dialog's state intact (no navigation away).
  const [detailSheetOpen, setDetailSheetOpen] = useState(false);
  const [detailRequestId, setDetailRequestId] = useState<string | null>(null);
  const navigate = useNavigate();
  // Auto-fill: the agent's most recently used landlord (remembered locally) and
  // a flag noting that location/area was pre-filled from the agent profile.
  const [lastLandlord, setLastLandlord] = useState<LandlordHit | null>(null);
  const [prefilledFromProfile, setPrefilledFromProfile] = useState(false);
  // ─── House-posting block (3-strike auto-block + manual Landlord Ops block) ───
  // When the agent is blocked they cannot list any house; we show the reason and
  // a live countdown to when posting reopens. No commission is earned while blocked.
  type ListingBlock = {
    blocked: boolean;
    blocked_until?: string | null;
    reason?: string | null;
    auto_blocked?: boolean | null;
    rejection_count?: number | null;
  };
  const [listingBlock, setListingBlock] = useState<ListingBlock | null>(null);
  const [blockChecking, setBlockChecking] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  // Phone-based auto-detection: when the agent types a landlord phone that is
  // already registered anywhere in the system (even one created from just an
  // estimation, with no photos/houses yet), surface it so they reuse it and
  // complete the real house, location and rent instead of creating a duplicate.
  type PhoneMatch = {
    id: string;
    name: string;
    phone: string | null;
    monthly_rent: number | null;
    property_address: string | null;
    village: string | null;
    district: string | null;
    region: string | null;
    house_category: string | null;
    number_of_rooms: number | null;
    /** How many houses this landlord has listed (0 = estimation only). */
    house_count: number;
    /** How many photos exist across all of this landlord's houses. */
    photo_count: number;
  };
  const [phoneMatch, setPhoneMatch] = useState<PhoneMatch | null>(null);
  const [checkingPhone, setCheckingPhone] = useState(false);
  // House photos — at least one is REQUIRED to list an empty house.
  const [images, setImages] = useState<HouseImageFile[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  // Unique GPS pin for THIS house. Captured from the device so every listing
  // gets its own coordinates instead of a shared/blank location.
  const [geo, setGeo] = useState<{ lat: number; lng: number; accuracy: number | null } | null>(null);
  const [capturingGeo, setCapturingGeo] = useState(false);
  // Agent must explicitly confirm the pinned GPS location is correct before submitting.
  const [geoConfirmed, setGeoConfirmed] = useState(false);
  // Human-readable place name resolved from the pinned coordinates.
  const [resolvedPlace, setResolvedPlace] = useState<string | null>(null);
  const [resolvingPlace, setResolvingPlace] = useState(false);
  // ─── Draft persistence (survives a camera-triggered page reload on mobile) ───
  // When true, the form was restored from a saved draft, so we show a banner.
  const [draftRestored, setDraftRestored] = useState(false);
  // Guards the auto-save effect so it never overwrites the stored draft before
  // the restore attempt has run for this open.
  const draftReadyRef = useRef(false);
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Capture a fresh, unique GPS pin for this house from the device.
  // Uses the resilient smart-location helper: high-accuracy first, automatic
  // low-accuracy fallback, and a HARD timeout ceiling so the spinner can never
  // hang forever (some Android phones never fire getCurrentPosition's success
  // OR error callback, leaving agents stuck on a spinning "Pin location").
  const captureGeo = async () => {
    if (capturingGeo) return;
    setCapturingGeo(true);
    try {
      const result = await captureSmartLocation();
      if (result.ok !== true) {
        if (result.reason === 'denied') {
          toast.error('Location permission is blocked. Enable location access for this site and tap Pin location again.');
        } else if (result.reason === 'unsupported') {
          toast.error('GPS is not supported on this device');
        } else if (result.reason === 'timeout') {
          toast.error('GPS took too long. Stand outside with a clear view of the sky and tap Pin location again.');
        } else {
          toast.error('Could not get your location. Check that location/GPS is turned on and try again.');
        }
        return;
      }
      setGeo({ lat: result.latitude, lng: result.longitude, accuracy: result.accuracy ?? null });
      setGeoConfirmed(false);
      toast.success(
        result.source === 'high'
          ? 'Exact location pinned for this house'
          : 'Location pinned (approximate) — move outdoors & re-pin for a sharper fix',
      );
    } finally {
      // Guaranteed to run — the spinner always resets even on an unexpected error.
      setCapturingGeo(false);
    }
  };

  // Resolve the pinned coordinates to a readable location name.
  useEffect(() => {
    if (!geo) {
      setResolvedPlace(null);
      return;
    }
    let active = true;
    setResolvingPlace(true);
    setResolvedPlace(null);
    reverseGeocode(geo.lat, geo.lng)
      .then((res) => {
        if (active) setResolvedPlace(res?.address ?? null);
      })
      .finally(() => {
        if (active) setResolvingPlace(false);
      });
    return () => {
      active = false;
    };
  }, [geo?.lat, geo?.lng]);
  const [form, setForm] = useState({
    title: '',
    description: '',
    house_category: 'single_room',
    number_of_rooms: 1,
    monthly_rent: '',
    region: '',
    district: '',
    address: '',
    village: '',
    landlord_name: '',
    landlord_phone: '',
    landlord_has_smartphone: true,
    has_water: false,
    has_electricity: false,
    has_security: false,
    has_parking: false,
    is_furnished: false,
    // Caretaker
    caretaker_type: 'none' as 'none' | 'self' | 'other',
    caretaker_name: '',
    caretaker_phone: '',
    // LC1 Chairperson
    lc1_name: '',
    lc1_phone: '',
    lc1_village: '',
  });

  // Official Uganda administrative location (village → district) chosen through
  // the shared picker. One tap fills region / district / village consistently.
  const [ugLoc, setUgLoc] = useState<UgLocationSelection | null>(null);
  const applyUgLocation = (sel: UgLocationSelection | null) => {
    setUgLoc(sel);
    if (!sel) return;
    const normalizedDistrict = normalizeDistrict(sel.district) || sel.district;
    setForm((f) => ({
      ...f,
      region: DISTRICT_TO_BACKEND_REGION[normalizedDistrict] ?? f.region,
      district: normalizedDistrict,
      village: sel.village,
      lc1_village: f.lc1_village || sel.village,
    }));
  };

  // Pre-fill landlord details when the dialog opens from the landlord form.
  useEffect(() => {
    if (open && (initialLandlordName || initialLandlordPhone)) {
      setForm((f) => ({
        ...f,
        landlord_name: initialLandlordName ?? f.landlord_name,
        landlord_phone: initialLandlordPhone ?? f.landlord_phone,
      }));
      // Treat a pre-filled landlord (from the registration form) as a manual
      // new-landlord entry so the search-first gate is satisfied.
      setManualLandlord(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialLandlordName, initialLandlordPhone]);

  // Pre-fill LC1 chairperson details when opened from the rent-request
  // verification gate, so the agent re-uses what they already typed instead of
  // re-keying it — listing the house then registers the missing LC1 too.
  useEffect(() => {
    if (open && (initialLc1Name || initialLc1Phone || initialLc1Village)) {
      setForm((f) => ({
        ...f,
        lc1_name: initialLc1Name ?? f.lc1_name,
        lc1_phone: initialLc1Phone ?? f.lc1_phone,
        lc1_village: initialLc1Village ?? f.lc1_village,
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialLc1Name, initialLc1Phone, initialLc1Village]);

  // Check whether this agent is currently blocked from posting houses whenever
  // the dialog opens. The DB also enforces this on insert, but checking up front
  // lets us show a clear notice + countdown instead of letting them fill the form.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBlockChecking(true);
    (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase as any).rpc('get_my_listing_block');
        if (cancelled) return;
        if (error) {
          setListingBlock(null);
        } else {
          setListingBlock((data as ListingBlock) ?? { blocked: false });
        }
      } catch {
        if (!cancelled) setListingBlock(null);
      } finally {
        if (!cancelled) setBlockChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Live countdown tick (every second) while a block notice is showing.
  useEffect(() => {
    if (!open || !listingBlock?.blocked) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open, listingBlock?.blocked]);

  // Promo banner mode: pre-apply empty-house defaults and show campaign badge.
  useEffect(() => {
    if (open && fromPromoBanner) {
      setForm((f) => ({ ...f, is_furnished: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fromPromoBanner]);

  // ─── Auto-fill from the agent profile (location/area) + remember last landlord ───
  // Runs once each time the dialog opens so an agent who works in one area can
  // list a house with almost no typing.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) return;

      // 1) Pre-fill the house location + LC1 area from the agent's profile.
      const { data: prof } = await supabase
        .from('profiles')
        .select('region, district, village')
        .eq('id', user.id)
        .maybeSingle();
      if (prof && !cancelled) {
        const filledSomething = !!(prof.region || prof.district || prof.village);
        setForm((f) => ({
          ...f,
          region: f.region || prof.region || '',
          district: f.district || prof.district || '',
          village: f.village || prof.village || '',
          lc1_village: f.lc1_village || prof.village || '',
        }));
        if (filledSomething) setPrefilledFromProfile(true);
      }

      // 2) Remember the agent's most recently used landlord for one-tap reuse.
      try {
        const raw = localStorage.getItem(`welile_last_landlord_${user.id}`);
        if (raw && !cancelled) setLastLandlord(JSON.parse(raw) as LandlordHit);
      } catch {
        /* ignore corrupt cache */
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ─── Restore a saved draft when the dialog opens ───
  // Lets an agent whose page reloaded (e.g. the OS took over for the camera)
  // pick up exactly where they left off. Photos can't survive a reload, so only
  // the typed/text portion is restored. Skipped when opened with context-specific
  // pre-fills (landlord/LC1) so those always win.
  useEffect(() => {
    if (!open) {
      draftReadyRef.current = false;
      setDraftRestored(false);
      return;
    }
    const hasContextPrefill = !!(
      initialLandlordName || initialLandlordPhone || initialLc1Name || initialLc1Phone || initialLc1Village
    );
    if (!hasContextPrefill) {
      const draft = loadHouseListingDraft();
      if (draft) {
        if (draft.form) setForm((f) => ({ ...f, ...(draft.form as typeof f) }));
        if (typeof draft.step === 'number') setStep(draft.step);
        if (typeof draft.showOptional === 'boolean') setShowOptional(draft.showOptional);
        if (typeof draft.manualLandlord === 'boolean') setManualLandlord(draft.manualLandlord);
        if (draft.selectedLandlord) setSelectedLandlord(draft.selectedLandlord as LandlordHit);
        if (draft.lc1Selection) setLc1Selection(draft.lc1Selection as Lc1Selection);
        if (draft.geo) setGeo(draft.geo);
        if (typeof draft.geoConfirmed === 'boolean') setGeoConfirmed(draft.geoConfirmed);
        if (typeof draft.landlordQuery === 'string') setLandlordQuery(draft.landlordQuery);
        setDraftRestored(true);
      }
    }
    // Persistence may begin now that the restore attempt is done.
    draftReadyRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ─── Persist the draft (debounced) as the agent fills the form ───
  useEffect(() => {
    if (!open || !draftReadyRef.current) return;
    if (successListing || listingBlock?.blocked) return;
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => {
      saveHouseListingDraft({
        form,
        step,
        showOptional,
        manualLandlord,
        selectedLandlord,
        lc1Selection,
        geo,
        geoConfirmed,
        landlordQuery,
      });
    }, 400);
    return () => {
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form, step, showOptional, manualLandlord, selectedLandlord, lc1Selection, geo, geoConfirmed, landlordQuery, successListing, listingBlock?.blocked]);

  // ─── Auto-detect an existing landlord from the typed phone number ───
  // While the agent is keying a new landlord's phone, quietly check the system.
  // If that number already belongs to a registered landlord (even one with only
  // estimated details), surface a "reuse" card so no duplicate is created.
  useEffect(() => {
    if (!manualLandlord || selectedLandlord) {
      setPhoneMatch(null);
      return;
    }
    const phone = form.landlord_phone;
    // Only look up once the number is structurally valid.
    if (validateLandlordPhone(phone)) {
      setPhoneMatch(null);
      return;
    }
    let cancelled = false;
    setCheckingPhone(true);
    const t = setTimeout(async () => {
      try {
        const canonical = toUgandaLocalDigits(phone);
        // Match on phone OR case-insensitive name so an existing landlord is
        // surfaced for reuse instead of being duplicated.
        const { data: matches } = await supabase.rpc('find_landlord_duplicate', {
          p_name: form.landlord_name.trim(),
          p_phone: canonical,
        });
        const m = Array.isArray(matches) && matches.length > 0 ? matches[0] : null;
        if (!m?.id) {
          if (!cancelled) setPhoneMatch(null);
          return;
        }
        const { data: full } = await supabase
          .from('landlords')
          .select('id, name, phone, monthly_rent, property_address, village, district, region, house_category, number_of_rooms')
          .eq('id', m.id)
          .maybeSingle();
        if (!full) {
          if (!cancelled) setPhoneMatch(null);
          return;
        }
        // Gauge completeness: how many houses + photos this landlord already has.
        const { data: houses } = await supabase
          .from('house_listings')
          .select('id')
          .eq('landlord_id', m.id);
        const houseIds = (houses ?? []).map((h) => h.id);
        let photoCount = 0;
        if (houseIds.length) {
          const { count } = await supabase
            .from('listing_photos')
            .select('*', { count: 'exact', head: true })
            .in('listing_id', houseIds);
          photoCount = count ?? 0;
        }
        if (!cancelled) {
          setPhoneMatch({
            ...(full as Omit<PhoneMatch, 'house_count' | 'photo_count'>),
            house_count: houseIds.length,
            photo_count: photoCount,
          });
        }
      } catch {
        if (!cancelled) setPhoneMatch(null);
      } finally {
        if (!cancelled) setCheckingPhone(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.landlord_phone, form.landlord_name, manualLandlord, selectedLandlord]);

  const monthlyRent = parseInt(form.monthly_rent) || 0;
  const pricing = calculateDailyRentalRate(monthlyRent);

  // ─── Search the system for a landlord by verified name (or phone) ───
  const searchLandlords = async () => {
    const q = landlordQuery.trim();
    if (q.length < 2) {
      toast.error('Type at least 2 letters of the landlord name');
      return;
    }
    setSearchingLandlord(true);
    setSearchedOnce(true);
    try {
      const { data: landlords, error } = await supabase.rpc('search_landlords_fuzzy', {
        p_query: q,
        p_limit: 20,
        p_threshold: 0.15,
      });
      if (error) throw error;

      const ids = (landlords || []).map((l) => l.id);
      // Count verified houses per landlord so the agent can confirm the match.
      const counts: Record<string, number> = {};
      const verifiedById: Record<string, boolean> = {};
      if (ids.length) {
        const { data: landlordFlags } = await supabase
          .from('landlords')
          .select('id, verified')
          .in('id', ids);
        for (const l of landlordFlags || []) {
          verifiedById[l.id] = !!l.verified;
        }

        const { data: houses } = await supabase
          .from('house_listings')
          .select('landlord_id')
          .in('landlord_id', ids)
          .eq('verified', true);
        for (const h of houses || []) {
          if (h.landlord_id) counts[h.landlord_id] = (counts[h.landlord_id] || 0) + 1;
        }
      }

      // A landlord is "verified" (and therefore trustworthy to list against) if
      // either their landlord record is verified OR they already have at least
      // one verified house in the system. Landlords do NOT need to be app users
      // — every landlord in the system is searchable.
      const hits: LandlordHit[] = (landlords || []).map((l) => {
        const verifiedHouses = counts[l.id] || 0;
        return {
          id: l.id,
          name: l.name,
          phone: l.phone || '',
          verified: !!verifiedById[l.id] || verifiedHouses > 0,
          verifiedHouses,
        };
      });
      // Surface verified landlords (and those with verified houses) first.
      hits.sort((a, b) => {
        if (a.verified !== b.verified) return a.verified ? -1 : 1;
        return b.verifiedHouses - a.verifiedHouses;
      });
      setLandlordResults(hits);
    } catch (err: any) {
      console.error('[ListEmptyHouseDialog] landlord search failed:', err);
      toast.error('Could not search landlords');
    } finally {
      setSearchingLandlord(false);
    }
  };

  const selectLandlord = (hit: LandlordHit) => {
    setSelectedLandlord(hit);
    setManualLandlord(false);
    setVerifyReqState('idle');
    setVerifyDbStatus(null);
    setVerifyDbComment(null);
    setVerifyRequestId(null);
    setForm((f) => ({ ...f, landlord_name: hit.name, landlord_phone: normalizeUgandaPhone(hit.phone) }));
    setLandlordPhoneError('');
    // Pull any recorded estimations onto the (editable) house fields so the
    // agent only edits what's wrong rather than re-typing everything.
    applyLandlordEstimations(hit.id);
  };

  const clearLandlordSelection = () => {
    setSelectedLandlord(null);
    setVerifyReqState('idle');
    setVerifyDbStatus(null);
    setVerifyDbComment(null);
    setVerifyRequestId(null);
    setForm((f) => ({ ...f, landlord_name: '', landlord_phone: '' }));
    setLandlordPhoneError('');
  };

  // Ask Landlord Operations to verify an already-registered (but unverified)
  // landlord so the agent can get this house live. Fire-and-forget notify.
  const requestLandlordVerification = async () => {
    if (!selectedLandlord?.id) return;
    setVerifyReqState('sending');
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setVerifyReqState('idle'); return; }
      const agentName =
        (user.user_metadata as any)?.full_name ||
        (user.user_metadata as any)?.name ||
        'Agent';
      const agentPhone = (user.user_metadata as any)?.phone || user.phone || null;
      const llName = selectedLandlord.name || null;
      const llPhone = (form.landlord_phone || selectedLandlord.phone || '').toString().trim() || null;
      const { data: inserted, error } = await supabase
        .from('landlord_verification_requests')
        .insert({
          landlord_id: selectedLandlord.id,
          landlord_name: llName,
          landlord_phone: llPhone,
          requested_by: user.id,
          agent_name: agentName,
          agent_phone: agentPhone,
          status: 'pending',
        })
        .select('id')
        .single();
      if (error) {
        if ((error as any).code === '23505') {
          setVerifyReqState('exists');
          toast.info('Verification already requested', {
            description: 'Landlord Operations already has a pending request for this landlord.',
          });
          return;
        }
        throw error;
      }
      setVerifyReqState('sent');
      setVerifyDbStatus('pending');
      setVerifyRequestId(inserted?.id ?? null);
      toast.success('Verification request sent', {
        description: `Landlord Operations will review ${llName || 'this landlord'} shortly.`,
      });
      void notifyVerificationCreated({
        agentId: user.id,
        agentName,
        landlordId: selectedLandlord.id,
        landlordName: llName,
        landlordPhone: llPhone,
        requestId: inserted?.id ?? null,
      });
    } catch (err: any) {
      setVerifyReqState('idle');
      setVerifyDbStatus(null);
      toast.error('Could not send request', { description: err?.message || 'Please try again.' });
    }
  };

  // ─── Poll the real verification status from the DB ───
  const fetchVerificationStatus = async (landlordId: string) => {
    try {
      // 1) Check if the landlord record itself was verified directly.
      const { data: ll } = await supabase
        .from('landlords')
        .select('verified')
        .eq('id', landlordId)
        .maybeSingle();
      if (ll?.verified) {
        setVerifyDbStatus('verified');
        setSelectedLandlord((prev) => (prev ? { ...prev, verified: true } : prev));
        return;
      }
      // 2) Check the latest verification request for this landlord.
      const { data: req } = await supabase
        .from('landlord_verification_requests')
        .select('id, status, reject_comment')
        .eq('landlord_id', landlordId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (req) {
        setVerifyDbStatus(req.status as VerifyDbStatus);
        setVerifyDbComment(req.reject_comment || null);
        setVerifyRequestId(req.id);
        if (req.status === 'verified') {
          setSelectedLandlord((prev) => (prev ? { ...prev, verified: true } : prev));
        }
      } else {
        setVerifyDbStatus(null);
        setVerifyDbComment(null);
        setVerifyRequestId(null);
      }
    } catch {
      /* non-critical — never block listing */
    }
  };

  // Poll the DB status every 8 s while a landlord is selected and the dialog is open.
  useEffect(() => {
    if (!open || !selectedLandlord?.id) return;
    fetchVerificationStatus(selectedLandlord.id);
    const interval = setInterval(() => {
      if (selectedLandlord?.id) fetchVerificationStatus(selectedLandlord.id);
    }, 8000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedLandlord?.id]);

  // Toast the agent whenever the polled verification status flips to verified/rejected.
  const prevVerifyDbStatus = useRef<VerifyDbStatus>(null);
  useEffect(() => {
    if (!open) return;
    const prev = prevVerifyDbStatus.current;
    prevVerifyDbStatus.current = verifyDbStatus;
    if (prev === 'pending' && verifyDbStatus === 'verified') {
      toast.success('Landlord verified!', {
        description: `${selectedLandlord?.name || 'The landlord'} is now verified — you can list this house.`,
        action: verifyRequestId
          ? {
              label: 'View details',
              onClick: () => { setDetailRequestId(verifyRequestId); setDetailSheetOpen(true); },
            }
          : undefined,
      });
    }
    if (prev === 'pending' && verifyDbStatus === 'rejected') {
      toast.error('Verification rejected', {
        description: `Landlord Ops rejected the verification request.${verifyDbComment ? ` Reason: ${verifyDbComment}` : ''}`,
        action: verifyRequestId
          ? {
              label: 'View details',
              onClick: () => { setDetailRequestId(verifyRequestId); setDetailSheetOpen(true); },
            }
          : undefined,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifyDbStatus, open, selectedLandlord?.name, verifyDbComment, verifyRequestId, navigate]);

  // Pre-fill any EMPTY house fields from an existing landlord's stored
  // estimations (rent / location). Never overwrites what the agent already
  // typed — everything stays fully editable.
  const applyLandlordEstimations = async (landlordId: string) => {
    try {
      const { data: l } = await supabase
        .from('landlords')
        .select('monthly_rent, property_address, village, district, region, house_category, number_of_rooms')
        .eq('id', landlordId)
        .maybeSingle();
      if (!l) return;
      setForm((f) => ({
        ...f,
        region: f.region || (l.region ?? ''),
        district: f.district || (l.district ?? ''),
        address: f.address || (l.property_address ?? ''),
        village: f.village || (l.village ?? ''),
        monthly_rent: f.monthly_rent || (l.monthly_rent ? String(l.monthly_rent) : ''),
        house_category: f.house_category && f.house_category !== 'single_room'
          ? f.house_category
          : (l.house_category ?? f.house_category),
        number_of_rooms: f.number_of_rooms && f.number_of_rooms !== 1
          ? f.number_of_rooms
          : (l.number_of_rooms ?? f.number_of_rooms),
      }));
    } catch {
      /* best effort — never blocks listing */
    }
  };

  // Link a phone-matched landlord to the form (no toast / navigation).
  const linkPhoneMatch = (m: PhoneMatch) => {
    const normalized = normalizeUgandaPhone(m.phone || form.landlord_phone);
    setSelectedLandlord({
      id: m.id,
      name: m.name,
      phone: normalized,
      verified: false,
      verifiedHouses: 0,
    });
    setManualLandlord(false);
    setVerifyReqState('idle');
    setVerifyDbStatus(null);
    setVerifyDbComment(null);
    setVerifyRequestId(null);
    setForm((f) => ({ ...f, landlord_name: m.name, landlord_phone: normalized }));
    applyLandlordEstimations(m.id);
    setPhoneMatch(null);
    setLandlordPhoneError('');
  };

  // Reuse a landlord that was auto-detected from the typed phone number.
  const usePhoneMatch = () => {
    if (!phoneMatch) return;
    linkPhoneMatch(phoneMatch);
    toast.success('Landlord found in the system — add their house, location & rent below');
  };

  // Build a completeness checklist for a matched landlord so the agent can see
  // at a glance what still needs to be added (location, rent, house, photos).
  const landlordChecklist = (m: PhoneMatch) => {
    const items = [
      { label: 'Location', ok: !!(m.region || m.village || m.property_address) },
      { label: 'Rent amount', ok: !!(m.monthly_rent && m.monthly_rent > 0) },
      { label: 'House details', ok: !!(m.house_category && m.number_of_rooms) && m.house_count > 0 },
      { label: 'Photos', ok: m.photo_count > 0 },
    ];
    const doneCount = items.filter((i) => i.ok).length;
    return { items, doneCount, total: items.length };
  };

  // Maps each checklist item to the wizard step + DOM anchor of its field so the
  // "Complete landlord profile" button can jump straight to what's missing.
  const FIELD_ANCHORS: Record<string, { step: number; id: string }> = {
    'Location': { step: 1, id: 'lh-field-location' },
    'Rent amount': { step: 1, id: 'lh-field-rent' },
    'House details': { step: 1, id: 'lh-field-house' },
    'Photos': { step: 2, id: 'lh-field-photos' },
  };

  // Smooth-scroll to a field anchor, briefly highlight it and focus its first input.
  const scrollToAnchor = (id: string) => {
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-primary', 'ring-offset-2', 'rounded-xl');
      const focusable = el.querySelector<HTMLElement>('input, select, textarea, [role="combobox"], button');
      focusable?.focus({ preventScroll: true });
      setTimeout(() => el.classList.remove('ring-2', 'ring-primary', 'ring-offset-2', 'rounded-xl'), 2200);
    });
  };

  // One-tap: link the matched landlord and jump straight to the first field that
  // still needs completing.
  const completeLandlordProfile = () => {
    if (!phoneMatch) return;
    const { items } = landlordChecklist(phoneMatch);
    const firstMissing = items.find((i) => !i.ok);
    const name = phoneMatch.name;
    linkPhoneMatch(phoneMatch);
    const target = (firstMissing ? FIELD_ANCHORS[firstMissing.label] : FIELD_ANCHORS['Location']) ?? FIELD_ANCHORS['Location'];
    setStep(target.step);
    toast.success(
      firstMissing
        ? `Complete the ${firstMissing.label.toLowerCase()} for ${name}`
        : `${name} is already complete — review and list`,
    );
    setTimeout(() => scrollToAnchor(target.id), 320);
  };

  // Strict landlord phone validation with user-friendly messages.
  const validateLandlordPhone = (phone: string): string => {
    const trimmed = phone.trim();
    if (!trimmed) return 'Landlord phone number is required';

    const global = isValidPhoneNumberGlobal(trimmed);
    if (!global.valid) return global.reason || 'Phone number looks invalid';

    // Uganda-specific checks
    const cleaned = trimmed.replace(/\D/g, '');
    const isUgandaFormat =
      trimmed.startsWith('+256') ||
      trimmed.startsWith('256') ||
      trimmed.startsWith('0');

    if (!isUgandaFormat) {
      return 'Please use a Ugandan number starting with 07, 08, 09 or +256';
    }

    const national = cleaned.startsWith('256') ? cleaned.slice(3) : cleaned.startsWith('0') ? cleaned.slice(1) : cleaned;
    if (national.length !== 9) {
      return `Phone number should have 9 digits after the country code (found ${national.length})`;
    }

    // Uganda mobile prefixes: 70-79
    if (!national.startsWith('7') && !national.startsWith('8') && !national.startsWith('9')) {
      return 'Please use a valid Uganda mobile number (starting with 07, 08 or 09)';
    }

    return '';
  };

  const scrollDialogToTop = () => {
    requestAnimationFrame(() => {
      document
        .querySelector('[role="dialog"]')
        ?.scrollTo({ top: 0, behavior: 'auto' });
    });
  };

  // ─── Guided wizard navigation ───
  const TOTAL_STEPS = 3;
  const STEP_LABELS = ['House & Location', 'Photos', 'Landlord & List'];

  // Validate just the current step before moving forward. Returns true if OK.
  const validateStep = (s: number): boolean => {
    if (s === 1) {
      // Essentials: rent, village (which drives region/district), GPS.
      if (!monthlyRent || monthlyRent < 10000) {
        toast.error('Monthly rent must be at least UGX 10,000');
        showFormMessage('error', 'Monthly rent must be at least UGX 10,000');
        return false;
      }
      if (!ugLoc) {
        toast.error('Search and select the village where the house is located');
        showFormMessage('error', 'Search and select the village where the house is located');
        return false;
      }
      // Every listed house MUST carry its own GPS pin.
      if (!geo) {
        toast.error('Pin the exact GPS location of this house');
        showFormMessage('error', 'Pin the exact GPS location of this house');
        return false;
      }
      // The agent must explicitly confirm the pinned location is correct.
      if (!geoConfirmed) {
        toast.error('Confirm the GPS location is correct before continuing');
        showFormMessage('error', 'Confirm the GPS location is correct before continuing');
        return false;
      }
    }
    if (s === 2) {
      // Photos are required.
      if (images.length < 3) {
        toast.error('Take at least 3 photos of the house');
        showFormMessage('error', 'Take at least 3 photos of the house');
        return false;
      }
    }
    if (s === 3) {
      // Landlord name is mandatory — every listing must carry a named landlord.
      if (!form.landlord_name.trim() && !selectedLandlord?.name) {
        toast.error('Landlord name is required');
        showFormMessage('error', 'Landlord name is required');
        return false;
      }
      // Landlord phone is mandatory — every listing must carry a reachable landlord number.
      const phoneErr = validateLandlordPhone(form.landlord_phone);
      if (phoneErr) {
        toast.error(phoneErr);
        showFormMessage('error', phoneErr);
        setLandlordPhoneError(phoneErr);
        return false;
      }
      if (form.caretaker_type === 'other' && (!form.caretaker_name.trim() || !form.caretaker_phone.trim())) {
        toast.error('Enter the caretaker name and phone');
        showFormMessage('error', 'Enter the caretaker name and phone');
        return false;
      }
      // LC1 chairperson is mandatory for every listing.
      const lc1Err = validateLc1Selection(lc1Selection);
      if (lc1Err) {
        toast.error(lc1Err);
        showFormMessage('error', lc1Err);
        return false;
      }
    }
    return true;
  };

  const goNext = () => {
    setAttempted(true);
    if (!validateStep(step)) {
      return;
    }
    setAttempted(false);
    setFormMessage(null);
    setStep((s) => Math.min(TOTAL_STEPS, s + 1));
    scrollDialogToTop();
  };

  const goBack = () => {
    setFormMessage(null);
    setStep((s) => Math.max(1, s - 1));
    scrollDialogToTop();
  };

  // ─── Preflight gate check ───
  // Compute every MANDATORY requirement up front so the agent can see at a
  // glance exactly what is still missing (and on which step) before they can
  // submit. Each gate carries the wizard step the agent should go back to.
  type PreflightGate = { label: string; ok: boolean; hint: string; step: number };
  const caretakerOk = form.caretaker_type !== 'other' || (!!form.caretaker_name.trim() && !!form.caretaker_phone.trim());
  // LC1 is mandatory — flag it as incomplete until a valid chairperson is set.
  const lc1PartialErr = validateLc1Selection(lc1Selection);
  const preflightGates: PreflightGate[] = [
    { label: 'Monthly rent (min UGX 10,000)', ok: !!monthlyRent && monthlyRent >= 10000, hint: 'Enter a monthly rent of at least UGX 10,000', step: 1 },
    { label: 'Village selected', ok: !!ugLoc, hint: 'Search and select the village where the house is located', step: 1 },
  ];
  preflightGates.push({ label: 'GPS location pinned', ok: !!geo, hint: 'Stand at the house and pin its exact GPS coordinates', step: 1 });
  preflightGates.push({ label: 'GPS location confirmed', ok: !!geo && geoConfirmed, hint: 'Tick the box confirming the pin sits on the house', step: 1 });
  preflightGates.push({ label: 'At least 3 photos', ok: images.length >= 3, hint: 'Take at least 3 photos of the house', step: 2 });
  preflightGates.push({ label: 'Landlord name', ok: !!(form.landlord_name.trim() || selectedLandlord?.name), hint: 'Enter the landlord name', step: 3 });
  preflightGates.push({ label: 'Landlord phone number', ok: !validateLandlordPhone(form.landlord_phone), hint: landlordPhoneError || 'Add a valid Ugandan phone number (e.g. 0771234567)', step: 3 });
  if (form.caretaker_type === 'other') {
    preflightGates.push({ label: 'Caretaker details', ok: caretakerOk, hint: 'Enter the caretaker name and phone', step: 3 });
  }
  preflightGates.push({ label: 'LC1 chairperson details', ok: !lc1PartialErr, hint: lc1PartialErr || 'Complete the LC1 chairperson details', step: 3 });
  const missingGates = preflightGates.filter((g) => !g.ok);
  const allGatesPass = missingGates.length === 0;

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    // If the form is submitted (e.g. Enter key) before the last step, just
    // advance the wizard instead of running full validation.
    if (step < TOTAL_STEPS) {
      goNext();
      return;
    }
    setAttempted(true);

    const failWith = (msg: string) => {
      toast.error(msg);
      showFormMessage('error', msg);
    };

    // ─── Daytime-only listing gate ───
    // House listing is restricted to 6:00 AM – 6:00 PM (EAT) so agents
    // capture photos and GPS in daylight. Server trigger enforces the same
    // rule; this is the friendly client-side message.
    if (!isListingDaytime()) {
      failWith(LISTING_NIGHT_MESSAGE);
      return;
    }

    // ─── Preflight jump ───
    // If ANY gate is missing, jump the agent to the step that owns the first
    // missing field and surface a toast. This prevents the silent "stuck on
    // step 3" experience where a hidden step-3 gate (landlord phone / LC1 /
    // caretaker) blocks submission with no visible action.
    const firstMissing = preflightGates.find((g) => !g.ok);
    if (firstMissing) {
      if (firstMissing.step !== step) {
        setStep(firstMissing.step);
      }
      const msg = firstMissing.hint || `${firstMissing.label} is required`;
      toast.error(msg);
      showFormMessage('error', msg);
      return;
    }

    if (!monthlyRent || monthlyRent < 10000) {
      failWith('Monthly rent must be at least UGX 10,000');
      return;
    }
    if (!ugLoc) {
      failWith('Search and select the village where the house is located');
      return;
    }
    if (images.length < 3) {
      failWith('Take at least 3 photos of the house');
      return;
    }
    // Landlord name is mandatory for every listing.
    if (!form.landlord_name.trim() && !selectedLandlord?.name) {
      failWith('Landlord name is required');
      return;
    }
    // Landlord phone is mandatory for every listing.
    if (!form.landlord_phone.trim()) {
      failWith('Landlord phone number is required');
      return;
    }
    if (form.caretaker_type === 'other' && (!form.caretaker_name.trim() || !form.caretaker_phone.trim())) {
      failWith('Enter the caretaker name and phone');
      return;
    }
    // LC1 chairperson is mandatory for every listing.
    {
      const lc1Err = validateLc1Selection(lc1Selection);
      if (lc1Err) { failWith(lc1Err); return; }
    }

    setSubmitting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Try to find or create landlord reference
      let landlordId: string | null = null;
      if (selectedLandlord?.id) {
        // Agent picked an existing landlord from the system search — link directly.
        landlordId = selectedLandlord.id;
      } else if (form.landlord_phone) {
        // Canonical, format-agnostic lookup (same normalizer as the search RPC).
        const canonicalPhone = toUgandaLocalDigits(form.landlord_phone);
        // Match on BOTH phone AND case-insensitive name so we never create a
        // duplicate landlord record — reuse the existing one and tell the agent.
        const { data: matches } = await supabase
          .rpc('find_landlord_duplicate', {
            p_name: form.landlord_name.trim(),
            p_phone: canonicalPhone,
          });
        const landlord = Array.isArray(matches) && matches.length > 0 ? matches[0] : null;

        if (landlord?.id) {
          landlordId = landlord.id;
          const matchedOn = (landlord as { matched_on?: string }).matched_on;
          if (matchedOn === 'name') {
            toast.info(`Linked to existing landlord "${landlord.name}"`, {
              description: 'A landlord with this name already existed — reused to avoid a duplicate.',
            });
          }
        } else if (form.landlord_name.trim()) {
          // Landlord doesn't exist yet — create one so the listing links properly
          const { data: newLandlord, error: landlordErr } = await supabase
            .from('landlords')
            .insert({
              name: form.landlord_name.trim(),
              phone: canonicalPhone,
              has_smartphone: form.landlord_has_smartphone,
              property_address: ugLoc.village,
              village: ugLoc.village,
              district: ugLoc.district,
              region: DISTRICT_TO_BACKEND_REGION[ugLoc.district] ?? 'Central',
              // Stamp ownership so (a) the RLS RETURNING select below is visible
              // to this agent (user_can_access_landlord matches registered_by /
              // managed_by_agent_id) and (b) the landlord is properly linked to
              // the agent. Without this the insert succeeds but `.select().single()`
              // returns no row, throwing "Could not save the landlord" and the
              // whole listing fails even though a hidden orphan landlord was saved.
              registered_by: user.id,
              managed_by_agent_id: user.id,
            })
            .select('id')
            .single();
          if (landlordErr || !newLandlord?.id) {
            throw new Error(
              landlordErr?.message
                ? `Could not save the landlord: ${landlordErr.message}`
                : 'Could not save the landlord. Please check the name and phone and try again.',
            );
          }
          landlordId = newLandlord.id;
        }
      }

      // Hard guard: never create a listing without a linked landlord. If we got
      // this far without resolving a landlord id, the landlord details are
      // missing/failed — surface it instead of silently creating an orphan house.
      if (!landlordId) {
        throw new Error('A landlord with a name and phone number is required to list this house.');
      }

      // Determine caretaker details
      const isAgentCaretaker = form.caretaker_type === 'self';
      const caretakerUserId = isAgentCaretaker ? user.id : null;
      const caretakerName = form.caretaker_type === 'other' ? form.caretaker_name : (isAgentCaretaker ? null : null);
      const caretakerPhone = form.caretaker_type === 'other' ? form.caretaker_phone : null;

      const listingRegion = DISTRICT_TO_BACKEND_REGION[ugLoc.district] ?? 'Central';
      const { data: listing, error } = await supabase
        .from('house_listings')
        .insert({
          agent_id: user.id,
          landlord_id: landlordId,
          title: form.title || `${HOUSE_CATEGORIES.find(c => c.value === form.house_category)?.label} in ${listingRegion}`,
          description: form.description || null,
          house_category: form.house_category,
          number_of_rooms: form.number_of_rooms,
          monthly_rent: monthlyRent,
          daily_rate: pricing.dailyRate,
          access_fee: pricing.accessFee,
          platform_fee: pricing.platformFee,
          total_monthly_cost: pricing.totalMonthlyCost,
          region: ugLoc.region || listingRegion,
          district: ugLoc.district,
          sub_county: ugLoc.subcounty,
          village: ugLoc.village,
          ug_village_id: ugLoc.villageId,
          address: (form.address || '').trim() || ugLoc.village,
          latitude: geo?.lat ?? null,
          longitude: geo?.lng ?? null,
          has_water: form.has_water,
          has_electricity: form.has_electricity,
          has_security: form.has_security,
          has_parking: form.has_parking,
          is_furnished: form.is_furnished,
          // Caretaker fields
          landlord_has_smartphone: form.landlord_has_smartphone,
          is_agent_caretaker: isAgentCaretaker,
          caretaker_user_id: caretakerUserId,
          caretaker_name: caretakerName,
          caretaker_phone: caretakerPhone,
          // LC1 fields
          lc1_chairperson_name: lc1Selection?.name ?? null,
          lc1_chairperson_phone: lc1Selection?.phone ?? null,
          lc1_chairperson_village: lc1Selection?.village || ugLoc.village,
        } as any)
        .select('id')
        .single();

      if (error) throw error;

      // Upload the captured house photos and attach them to the new listing.
      if (listing?.id && images.length > 0) {
        try {
          const uploaded = await uploadHouseImages(
            user.id,
            listing.id,
            images.map((i) => i.file),
            images.map((i) => i.thumbnailFile),
          );
          if (uploaded.length > 0) {
            await supabase
              .from('house_listings')
              .update({ image_urls: uploaded } as any)
              .eq('id', listing.id);
          }
        } catch (photoErr) {
          console.warn('[ListEmptyHouseDialog] photo upload warning:', photoErr);
        }
      }

      // Remember this landlord locally so the next listing can reuse them in one tap.
      try {
        const remembered: LandlordHit | null = selectedLandlord
          ? selectedLandlord
          : (landlordId && form.landlord_name.trim())
            ? { id: landlordId, name: form.landlord_name.trim(), phone: form.landlord_phone.trim(), verified: false, verifiedHouses: 0 }
            : null;
        if (remembered) {
          localStorage.setItem(`welile_last_landlord_${user.id}`, JSON.stringify(remembered));
          setLastLandlord(remembered);
        }
      } catch {
        /* non-critical */
      }

      // Milestone-only policy (2026-07-23): no instant reward on listing.
      // The full UGX 5,000 listing bonus is credited by `credit-listing-bonus`
      // once Landlord Ops verifies the house.

      // ─── LC1 chairperson persistence ───
      // Existing LC1 (picked from search) → nothing to insert, no bonus.
      // New LC1 (agent registering) → insert with registered_by = agent. The
      // full UGX 5,000 commission is paid in a SINGLE payment by
      // `credit-lc1-verification-bonus` once Landlord Ops verifies the LC1
      // chairperson. There is no longer an instant registration reward.
      if (lc1Selection?.mode === 'new') {
        try {
          const lc1Phone = lc1Selection.phone.trim();
          const lc1Village = lc1Selection.village.trim();
          // Guard against duplicates (and double-paying) if the agent skipped the
          // search: reuse an existing row when phone+village already matches.
          const { data: existingLc1 } = await supabase
            .from('lc1_chairpersons')
            .select('id, registered_by')
            .eq('phone', lc1Phone)
            .eq('village', lc1Village)
            .maybeSingle();

          let lc1Id = existingLc1?.id ?? null;
          if (lc1Id) {
            if (!existingLc1?.registered_by) {
              await supabase
                .from('lc1_chairpersons')
                .update({ registered_by: user.id } as any)
                .eq('id', lc1Id);
            }
          } else {
            const { data: createdLc1, error: lc1InsertErr } = await supabase
              .from('lc1_chairpersons')
              .insert({
                name: lc1Selection.name.trim(),
                phone: lc1Phone,
                village: lc1Village,
                region: lc1Selection.region || null,
                district: lc1Selection.district || null,
                county: lc1Selection.county || null,
                sub_county: lc1Selection.sub_county || null,
                parish: lc1Selection.parish || null,
                town_council: lc1Selection.town_council || null,
                cell: lc1Selection.cell || null,
                zone: lc1Selection.zone || null,
                ug_village_id: lc1Selection.ug_village_id ?? null,
                registered_by: user.id,
              } as any)
              .select('id')
              .single();
            if (lc1InsertErr) throw lc1InsertErr;
            lc1Id = createdLc1?.id ?? null;
          }

          // No instant LC1-registration reward — the full UGX 5,000 is credited
          // only after Landlord Ops verifies the chairperson.
        } catch (lc1Err) {
          console.warn('[ListEmptyHouseDialog] LC1 registration warning:', lc1Err);
        }
      }

      toast.success('House listed successfully!', {
        description: `You'll earn UGX 2,000 once Landlord Ops verifies this house, plus UGX 5,000 when a tenant is placed.`,
      });
      showFormMessage(
        'success',
        'House listed successfully!',
        'UGX 2,000 on verification · UGX 5,000 on tenant placement.',
      );
      onSuccess?.();

      // Fetch short_code (generated by DB trigger) so the share link is friendly
      const { data: created } = await supabase
        .from('house_listings')
        .select('id, short_code, title, region, daily_rate')
        .eq('id', listing.id)
        .maybeSingle();

      const successRegion = ugLoc ? (DISTRICT_TO_BACKEND_REGION[ugLoc.district] ?? 'Central') : ((created as any)?.region || '');
      setSuccessListing({
        id: listing.id,
        shortCode: (created as any)?.short_code ?? null,
        title: (created as any)?.title || form.title || `${HOUSE_CATEGORIES.find(c => c.value === form.house_category)?.label} in ${successRegion}`,
        region: successRegion,
        dailyRate: pricing.dailyRate,
      });
      setAttempted(false);
      // The listing is committed — the saved draft is no longer needed.
      clearHouseListingDraft();
      setDraftRestored(false);
    } catch (err: any) {
      console.error('[ListEmptyHouseDialog] submit failed:', err);
      const raw = String(err?.message || '');
      if (raw.includes('AGENT_LISTING_BLOCKED')) {
        // The agent got blocked mid-flow — surface the block screen with reason + countdown.
        toast.error('House posting is blocked', {
          description: 'You cannot list houses right now. No commission is earned while blocked.',
        });
        showFormMessage(
          'error',
          'House posting is blocked',
          'You cannot list houses right now. No commission is earned while blocked.',
        );
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data } = await (supabase as any).rpc('get_my_listing_block');
          setListingBlock((data as ListingBlock) ?? { blocked: true, reason: raw.replace('AGENT_LISTING_BLOCKED:', '').trim() });
        } catch {
          setListingBlock({ blocked: true, reason: raw.replace('AGENT_LISTING_BLOCKED:', '').trim() });
        }
      } else {
        toast.error(err?.message || 'Failed to list house');
        showFormMessage('error', err?.message || 'Failed to list house');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setForm({
      title: '', description: '', house_category: 'single_room',
      number_of_rooms: 1, monthly_rent: '', region: '', district: '',
      address: '', village: '', landlord_name: '', landlord_phone: '',
      landlord_has_smartphone: true,
      has_water: false, has_electricity: false, has_security: false,
      has_parking: false, is_furnished: false,
      caretaker_type: 'none', caretaker_name: '', caretaker_phone: '',
      lc1_name: '', lc1_phone: '', lc1_village: '',
    });
    setLc1Selection(null);
    setShowOptional(false);
    setLandlordQuery('');
    setLandlordResults([]);
    setSearchedOnce(false);
    setSelectedLandlord(null);
    setManualLandlord(false);
    setPrefilledFromProfile(false);
    setPhoneMatch(null);
    setGeo(null);
    setCapturingGeo(false);
    setGeoConfirmed(false);
    setCheckingPhone(false);
    setStep(1);
    setImages([]);
    setPreviewIndex(0);
    setDragOverIndex(null);
    setIsDragging(false);
    // Discard any persisted draft — a reset is an explicit "start over".
    clearHouseListingDraft();
    setDraftRestored(false);
  };

  const buildShare = () => {
    if (!successListing) return { url: '', message: '' };
    const ref = successListing.shortCode || successListing.id;
    const url = `${APP_URL}/house/${ref}`;
    const message = `🏠 New rental on Welile!\n\n*${successListing.title}*\n📍 ${successListing.region}\n💰 ${formatUGX(successListing.dailyRate)}/day\n\n👉 ${url}`;
    return { url, message };
  };

  const handleWhatsApp = () => {
    const { message } = buildShare();
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  };

  const handleCopy = async () => {
    const { message } = buildShare();
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      toast.success('Link copied — paste anywhere to share');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy');
    }
  };

  const handleNativeShare = async () => {
    const { url, message } = buildShare();
    if (navigator.share) {
      try { await navigator.share({ title: successListing?.title || 'House on Welile', text: message, url }); } catch {}
    } else {
      handleCopy();
    }
  };

  const closeAll = () => {
    setSuccessListing(null);
    resetForm();
    onOpenChange(false);
  };

  const listAnother = () => {
    setSuccessListing(null);
    resetForm();
  };

  return (
    <>
    <Dialog open={open} onOpenChange={(v) => { if (!v) closeAll(); else onOpenChange(v); }}>
      <DialogContent
        stable
        // Keep the wizard open when the OS file picker / camera steals focus, or
        // when the agent taps outside / interacts with a nested picker. The only
        // ways to close are the X button and the explicit Cancel/Done actions,
        // so a half-filled form is never lost by an accidental tap.
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => { if (!successListing) e.preventDefault(); }}
        className={`app-dialog-bottom-sheet w-[calc(100vw-1rem)] sm:max-w-md !overflow-y-auto overflow-x-hidden overscroll-contain rounded-t-2xl rounded-b-none sm:rounded-2xl p-4 sm:p-6 max-h-[96vh] max-h-[96dvh] [touch-action:pan-y] [-webkit-overflow-scrolling:touch]`}
      >
        {listingBlock?.blocked ? (
          (() => {
            const until = listingBlock.blocked_until ? new Date(listingBlock.blocked_until).getTime() : 0;
            const remainingMs = Math.max(0, until - nowTick);
            const totalSec = Math.floor(remainingMs / 1000);
            const days = Math.floor(totalSec / 86400);
            const hours = Math.floor((totalSec % 86400) / 3600);
            const mins = Math.floor((totalSec % 3600) / 60);
            const secs = totalSec % 60;
            const pad = (n: number) => String(n).padStart(2, '0');
            return (
              <div className="space-y-5 py-2">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-destructive">
                    <AlertTriangle className="h-5 w-5" />
                    House posting blocked
                  </DialogTitle>
                  <DialogDescription>
                    You can't list houses right now. While blocked you earn no listing
                    rewards or commission.
                  </DialogDescription>
                </DialogHeader>

                <div className="p-4 rounded-xl bg-destructive/5 border border-destructive/20 space-y-2">
                  <p className="text-[10px] font-semibold text-destructive/80 uppercase tracking-wider">
                    {listingBlock.auto_blocked ? 'Reason (3 listings rejected)' : 'Reason from Landlord Ops'}
                  </p>
                  <p className="text-sm font-medium text-foreground whitespace-pre-line">
                    {listingBlock.reason || 'Your house posting has been temporarily blocked.'}
                  </p>
                </div>

                <div className="p-4 rounded-xl bg-muted/40 border border-border text-center space-y-2">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    You can post again in
                  </p>
                  {remainingMs > 0 ? (
                    <p className="text-2xl font-bold tabular-nums text-foreground">
                      {days > 0 ? `${days}d ` : ''}{pad(hours)}:{pad(mins)}:{pad(secs)}
                    </p>
                  ) : (
                    <p className="text-sm font-semibold text-emerald-600">
                      The block has expired — close and reopen to start listing.
                    </p>
                  )}
                  {listingBlock.blocked_until && (
                    <p className="text-[11px] text-muted-foreground">
                      Posting reopens {new Date(listingBlock.blocked_until).toLocaleString()}
                    </p>
                  )}
                </div>

                <Button type="button" variant="secondary" className="w-full h-11" onClick={closeAll}>
                  Close
                </Button>
              </div>
            );
          })()
        ) : successListing ? (
          <div className="space-y-5 py-2">
            <div className="text-center space-y-2">
              <div className="w-14 h-14 mx-auto rounded-full bg-success/15 flex items-center justify-center">
                <PartyPopper className="h-7 w-7 text-success" />
              </div>
              <DialogTitle className="text-xl">House listed!</DialogTitle>
              <p className="text-sm text-muted-foreground">
                You'll earn <span className="font-semibold text-foreground">UGX 2,000</span> once Landlord Ops
                verifies this house, plus <span className="font-semibold text-foreground">UGX 10,000</span> when
                a tenant is placed here.
              </p>
            </div>

            <div className="p-3 rounded-xl bg-muted/40 border border-border space-y-1">
              <p className="font-semibold text-sm truncate">{successListing.title}</p>
              <p className="text-xs text-muted-foreground">
                📍 {successListing.region} · 💰 {formatUGX(successListing.dailyRate)}/day
              </p>
            </div>

            <div className="space-y-2">
              <Button
                type="button"
                onClick={handleWhatsApp}
                className="w-full h-12 bg-[#25D366] hover:bg-[#1FB955] text-white"
              >
                <MessageCircle className="h-5 w-5 mr-2" />
                Share on WhatsApp
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant="outline" onClick={handleCopy} className="h-11">
                  {copied ? <Check className="h-4 w-4 mr-2 text-success" /> : <Copy className="h-4 w-4 mr-2" />}
                  {copied ? 'Copied' : 'Copy link'}
                </Button>
                <Button type="button" variant="outline" onClick={handleNativeShare} className="h-11">
                  <Share2 className="h-4 w-4 mr-2" />
                  More
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border">
              <Button type="button" variant="ghost" onClick={listAnother}>List another</Button>
              <Button type="button" variant="secondary" onClick={closeAll}>Done</Button>
            </div>
          </div>
        ) : (
        <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Home className="h-5 w-5 text-primary" />
            List Empty House
          </DialogTitle>
          <DialogDescription>
            Register an available rental · Earn UGX 10,000 when a tenant is placed
          </DialogDescription>
        </DialogHeader>


        {/* Promotional campaign badge when opened from the agent dashboard banner */}
        {fromPromoBanner && (
          <div className="flex items-center gap-2.5 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
            <div className="h-8 w-8 rounded-lg bg-emerald-500/20 flex items-center justify-center shrink-0">
              <Trophy className="h-4 w-4 text-emerald-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-emerald-700 leading-tight">
                Weekly Prize Campaign
              </p>
              <p className="text-xs text-emerald-600/80 leading-snug">
                This listing counts toward the UGX 70,000 prize. Register 10 landlords with empty houses to win.
              </p>
            </div>
            <div className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/15 border border-amber-400/25">
              <Sparkles className="h-3 w-3 text-amber-600" />
              <span className="text-[10px] font-bold text-amber-700 uppercase tracking-wider">Promo</span>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          {/* Draft restored notice — shown when we recovered a previous session */}
          {draftRestored && !successListing && (
            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20">
              <RotateCcw className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-blue-700 leading-tight">
                  We restored your earlier progress
                </p>
                <p className="text-xs text-blue-600/80 leading-snug mt-0.5">
                  Please re-add your photos — they can't be saved between sessions.
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 shrink-0 text-blue-700 hover:text-blue-800"
                onClick={() => { resetForm(); }}
              >
                Start fresh
              </Button>
            </div>
          )}
          {/* Progress stepper — big, visual, minimal reading */}
          <div className="flex items-stretch gap-1.5">
            {STEP_LABELS.map((label, i) => {
              const n = i + 1;
              const active = n === step;
              const done = n < step;
              return (
                <div key={label} className="flex-1 min-w-0 text-center">
                  <div
                    className={`mx-auto mb-1 flex h-10 w-10 items-center justify-center rounded-full text-base font-bold ${
                      done
                        ? 'bg-success text-success-foreground'
                        : active
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {done ? <Check className="h-5 w-5" /> : n}
                  </div>
                  <span className={`block truncate text-xs leading-tight ${active ? 'text-foreground font-semibold' : 'text-muted-foreground'}`}>{label}</span>
                </div>
              );
            })}
          </div>

          {/* ── Step 3: Landlord ── */}
          {step === 3 && (
          <>
          <FormStepHeader
            icon={User}
            stepLabel="Step 3 of 3"
            title="Landlord & LC1"
            subtitle="Landlord name, phone and the LC1 chairperson are all required to list."
          />
          {/* Landlord Info */}
          <div className="space-y-3 p-3 rounded-xl bg-muted/30 border border-border">
            <p className="text-xs font-semibold text-muted-foreground uppercase">Landlord Details <span className="normal-case text-[10px] font-normal text-destructive">(name & phone required)</span></p>

            {/* Step 1 — search the system for a verified landlord */}
            {!selectedLandlord && !manualLandlord && (
              <div className="space-y-2">
                {/* One-tap reuse of the agent's most recently used landlord */}
                {lastLandlord && (
                  <button
                    type="button"
                    onClick={() => selectLandlord(lastLandlord)}
                    className="w-full text-left p-2.5 rounded-lg border border-primary/40 bg-primary/5 hover:bg-primary/10 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-[11px] font-bold text-primary uppercase tracking-wide">
                        <UserCheck className="h-3.5 w-3.5" /> Use last landlord
                      </span>
                      {lastLandlord.verified && (
                        <ShieldCheck className="h-3.5 w-3.5 text-success shrink-0" />
                      )}
                    </div>
                    <p className="font-medium text-sm truncate mt-0.5">{lastLandlord.name}</p>
                    <p className="text-xs text-muted-foreground">{lastLandlord.phone}</p>
                  </button>
                )}
                <Label className="text-sm font-medium">Search the landlord in the system first</Label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    placeholder="Landlord name or phone"
                    className="h-12 text-base flex-1 min-w-0"
                    value={landlordQuery}
                    onChange={(e) => setLandlordQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); searchLandlords(); }
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-12 w-full sm:w-auto px-4 sm:px-5 shrink-0"
                    onClick={searchLandlords}
                    disabled={searchingLandlord}
                  >
                    {searchingLandlord ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                    <span>{searchingLandlord ? 'Searching…' : 'Search'}</span>
                  </Button>
                </div>

                {searchedOnce && !searchingLandlord && landlordResults.length > 0 && (
                  <p className="text-xs font-semibold text-success flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    {landlordResults.length} landlord{landlordResults.length > 1 ? 's' : ''} found
                  </p>
                )}

                {landlordResults.length > 0 && (
                  <div className="space-y-1.5 max-h-56 overflow-y-auto">
                    {landlordResults.map((hit) => (
                      <button
                        type="button"
                        key={hit.id}
                        onClick={() => selectLandlord(hit)}
                        className="w-full text-left p-2.5 rounded-lg border border-border bg-background hover:bg-accent/40 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm truncate">{hit.name}</span>
                          {hit.verified ? (
                            <span className="flex items-center gap-1 text-[10px] font-semibold text-success shrink-0">
                              <ShieldCheck className="h-3.5 w-3.5" /> Verified
                            </span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground shrink-0">Unverified</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">{hit.phone}</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {hit.verifiedHouses > 0
                            ? `${hit.verifiedHouses} verified house${hit.verifiedHouses > 1 ? 's' : ''} in system`
                            : 'No verified houses yet'}
                        </p>
                      </button>
                    ))}
                  </div>
                )}

                {searchedOnce && !searchingLandlord && landlordResults.length === 0 && (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 flex items-start gap-2.5">
                    <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-destructive">No registered landlord found</p>
                      <p className="text-xs text-muted-foreground mt-1 leading-snug">
                        Try a different spelling or phone number. Only landlords already registered in the system can be selected.
                      </p>
                      <div className="mt-2 space-y-1">
                        <p className="text-[11px] text-muted-foreground">
                          <span className="font-medium">Name:</span> e.g. <span className="font-mono text-foreground">John Mukasa</span>
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          <span className="font-medium">Phone:</span> <span className="font-mono text-foreground">07xxxxxxxx</span> or <span className="font-mono text-foreground">+2567xxxxxxxx</span>
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <Button
                  type="button"
                  variant="outline"
                  className="h-12 w-full gap-2 text-sm font-semibold"
                  onClick={() => { setManualLandlord(true); setForm(f => ({ ...f, landlord_name: landlordQuery.trim().match(/^[0-9+]/) ? f.landlord_name : landlordQuery.trim() })); }}
                >
                  <UserCheck className="h-4 w-4" /> Can't find them? Add a new landlord
                </Button>
              </div>
            )}

            {/* Selected existing landlord */}
            {selectedLandlord && (
              <div className="p-2.5 rounded-lg border border-success/40 bg-success/5 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate flex items-center gap-1.5">
                      {selectedLandlord.verified && <ShieldCheck className="h-4 w-4 text-success shrink-0" />}
                      {selectedLandlord.name}
                    </p>
                    <p className="text-xs text-muted-foreground">{selectedLandlord.phone}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {selectedLandlord.verifiedHouses > 0
                        ? `${selectedLandlord.verifiedHouses} verified house${selectedLandlord.verifiedHouses > 1 ? 's' : ''} in system`
                        : 'No verified houses yet'}
                    </p>
                  </div>
                  <Button type="button" variant="ghost" size="sm" className="h-8 text-xs shrink-0" onClick={clearLandlordSelection}>
                    <X className="h-3.5 w-3.5 mr-1" /> Change
                  </Button>
                </div>
                {!selectedLandlord.verified && verifyDbStatus !== 'verified' && (
                  <div className="pt-1.5 border-t border-amber-500/30 space-y-2">
                    {verifyDbStatus === 'pending' ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-700 bg-amber-500/10 px-2 py-1.5 rounded-lg">
                          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                          Verification pending — Landlord Ops is reviewing
                        </div>
                        <p className="text-[11px] text-amber-700 leading-snug">
                          You’ll get a notification once they approve or reject. You can close this dialog and come back later.
                        </p>
                      </div>
                    ) : verifyDbStatus === 'rejected' ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-destructive bg-destructive/10 px-2 py-1.5 rounded-lg">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                          Verification rejected
                        </div>
                        {verifyDbComment && (
                          <p className="text-[11px] text-destructive/80 leading-snug">
                            Reason: {verifyDbComment}
                          </p>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-9 w-full gap-1.5 rounded-xl border-amber-500/40 text-amber-700 hover:bg-amber-50"
                          disabled={verifyReqState === 'sending'}
                          onClick={requestLandlordVerification}
                        >
                          {verifyReqState === 'sending' ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ShieldCheck className="h-3.5 w-3.5" />
                          )}
                          Request verification again
                        </Button>
                      </div>
                    ) : verifyReqState === 'sent' || verifyReqState === 'exists' ? (
                      <p className="text-[11px] font-medium text-success flex items-center gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                        Verification request sent to Landlord Operations.
                      </p>
                    ) : (
                      <>
                        <p className="text-[11px] text-amber-700 flex items-start gap-1.5 leading-snug">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
                          This landlord is registered but not yet verified. Ask Landlord Operations to verify them so this house can go live.
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-9 w-full gap-1.5 rounded-xl border-amber-500/40 text-amber-700 hover:bg-amber-50"
                          disabled={verifyReqState === 'sending'}
                          onClick={requestLandlordVerification}
                        >
                          {verifyReqState === 'sending' ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ShieldCheck className="h-3.5 w-3.5" />
                          )}
                          Ping Landlord Ops to verify
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Manual new landlord entry (after search returned no match) */}
            {manualLandlord && !selectedLandlord && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <Label className="text-sm font-medium">Landlord Name <span className="text-destructive">*</span></Label>
                    <LandlordAutocompleteInput
                      field="name"
                      placeholder="Name — type to find an existing landlord"
                      className="h-12 text-base"
                      value={form.landlord_name}
                      onChange={(v) => setForm(f => ({ ...f, landlord_name: v }))}
                      onSelect={(l: LandlordOption) => selectLandlord({
                        id: l.id,
                        name: l.name,
                        phone: l.phone || '',
                        verified: !!l.verified,
                        verifiedHouses: 0,
                      })}
                    />
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Landlord Phone <span className="text-destructive">*</span></Label>
                    <PhoneInput
                      placeholder="0771234567"
                      value={form.landlord_phone}
                      onChange={(v) => {
                        const masked = formatUgandaPhone(v);
                        setForm(f => ({ ...f, landlord_phone: masked }));
                        // Real-time validation: clear error while typing, re-check on blur or if length seems complete
                        if (!masked.trim()) {
                          setLandlordPhoneError('');
                        } else if (masked.replace(/\D/g, '').length >= 9) {
                          setLandlordPhoneError(validateLandlordPhone(masked));
                        } else {
                          setLandlordPhoneError('');
                        }
                      }}
                      onBlur={() => {
                        if (form.landlord_phone.trim()) {
                          const normalized = normalizeUgandaPhone(form.landlord_phone);
                          if (normalized !== form.landlord_phone) {
                            setForm(f => ({ ...f, landlord_phone: normalized }));
                          }
                          setLandlordPhoneError(validateLandlordPhone(normalized));
                        }
                      }}
                      onContactPicked={({ name, phone }) => {
                        if (name && !form.landlord_name.trim()) setForm(f => ({ ...f, landlord_name: name }));
                        const normalized = normalizeUgandaPhone(phone);
                        setForm(f => ({ ...f, landlord_phone: normalized }));
                        setLandlordPhoneError(validateLandlordPhone(normalized));
                      }}
                      className={landlordPhoneError ? 'border-destructive focus-visible:ring-destructive' : ''}
                    />
                    {/* Reserve a fixed-height row so toggling between the error and
                        the success chip never shifts the layout (mobile stability). */}
                    <div className="mt-1 min-h-[18px]">
                      {landlordPhoneError ? (
                        <p className="text-[11px] text-destructive flex items-center gap-1">
                          <span className="inline-block h-3 w-3 rounded-full bg-destructive/10 text-destructive flex items-center justify-center text-[9px] font-bold">!</span>
                          {landlordPhoneError}
                        </p>
                      ) : form.landlord_phone && validateLandlordPhone(form.landlord_phone) === '' ? (
                        <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                          <span className="text-base leading-none">🇺🇬</span>
                          <span className="font-medium text-foreground">{displayNormalizeUgandaPhone(form.landlord_phone)}</span>
                          <span className="text-[10px] bg-success/10 text-success px-1.5 py-0.5 rounded-full">Uganda mobile</span>
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
                {/* Auto-detected: this phone already belongs to a registered landlord */}
                {checkingPhone && !phoneMatch && (
                  <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" /> Checking the system for this number…
                  </p>
                )}
                {phoneMatch && (
                  <div className="w-full text-left p-3 rounded-xl border-2 border-primary/40 bg-primary/5">
                    <div className="flex items-center gap-1.5 text-[11px] font-bold text-primary uppercase tracking-wide">
                      <UserCheck className="h-3.5 w-3.5" /> Already in the system
                    </div>
                    <p className="font-semibold text-sm truncate mt-1">{phoneMatch.name}</p>
                    <p className="text-xs text-muted-foreground">{normalizeUgandaPhone(phoneMatch.phone || form.landlord_phone)}</p>
                    {(phoneMatch.monthly_rent || phoneMatch.region || phoneMatch.village || phoneMatch.property_address) && (
                      <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
                        {phoneMatch.monthly_rent ? `Est. rent ${formatUGX(phoneMatch.monthly_rent)}` : 'No rent recorded yet'}
                        {(phoneMatch.village || phoneMatch.region) ? ` · ${[phoneMatch.village, phoneMatch.region].filter(Boolean).join(', ')}` : ''}
                      </p>
                    )}
                    {/* Completeness indicator — what still needs to be added */}
                    {(() => {
                      const { items, doneCount, total } = landlordChecklist(phoneMatch);
                      return (
                        <div className="mt-2 rounded-lg bg-background/60 border border-border p-2">
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Profile completeness</span>
                            <span className={`text-[10px] font-bold ${doneCount === total ? 'text-success' : 'text-amber-600'}`}>{doneCount}/{total}</span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {items.map((it) => (
                              <span
                                key={it.label}
                                className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${
                                  it.ok
                                    ? 'bg-success/10 text-success border-success/20'
                                    : 'bg-amber-500/10 text-amber-700 border-amber-400/30'
                                }`}
                              >
                                {it.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                                {it.label}
                              </span>
                            ))}
                          </div>
                          {doneCount < total && (
                            <p className="text-[10px] text-amber-700 mt-1.5 leading-snug">
                              Missing: {items.filter((i) => !i.ok).map((i) => i.label.toLowerCase()).join(', ')}.
                            </p>
                          )}
                        </div>
                      );
                    })()}
                    {/* One-tap: link the landlord and jump to the first missing field */}
                    {(() => {
                      const { doneCount, total } = landlordChecklist(phoneMatch);
                      const complete = doneCount === total;
                      return (
                        <div className="mt-2.5 space-y-1.5">
                          {!complete && (
                            <Button
                              type="button"
                              onClick={completeLandlordProfile}
                              className="w-full h-11 gap-1.5 text-sm font-semibold"
                            >
                              <ArrowRight className="h-4 w-4" /> Complete landlord profile
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant={complete ? 'default' : 'outline'}
                            onClick={usePhoneMatch}
                            className="w-full h-11 gap-1.5 text-sm font-semibold"
                          >
                            <UserCheck className="h-4 w-4" /> {complete ? 'Use this landlord' : 'Just use as-is'}
                          </Button>
                        </div>
                      );
                    })()}
                  </div>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  className="h-8 text-xs"
                  onClick={() => { setManualLandlord(false); setForm(f => ({ ...f, landlord_name: '', landlord_phone: '' })); setLandlordPhoneError(''); }}
                >
                  ← Back to search
                </Button>
              </div>
            )}

            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={!form.landlord_has_smartphone}
                onCheckedChange={v => setForm(f => ({
                  ...f,
                  landlord_has_smartphone: !v,
                  // Auto-fill the caretaker as the agent (self) so a smartphone-less
                  // landlord needs no extra typing. Reset to none if reverted.
                  caretaker_type: v ? (f.caretaker_type === 'none' ? 'self' : f.caretaker_type) : 'none',
                }))}
              />
              <span className="text-sm">Landlord doesn't have / can't use a smartphone</span>
            </label>
            {attempted && !!validateLandlordPhone(form.landlord_phone) && (
              <FieldError
                message={
                  selectedLandlord || manualLandlord
                    ? validateLandlordPhone(form.landlord_phone)
                    : 'Search and pick the landlord, or add a new one, so we have their phone number.'
                }
              />
            )}
          </div>

          {/* Caretaker Section — only if landlord has no smartphone */}
          {!form.landlord_has_smartphone && (
            <div className="space-y-3 p-3 rounded-xl bg-accent/30 border border-accent/50">
              <div className="flex items-center gap-2">
                <UserCheck className="h-4 w-4 text-accent-foreground" />
                <p className="text-xs font-semibold text-accent-foreground uppercase">Caretaker Registration</p>
              </div>
              <p className="text-xs text-muted-foreground">Since the landlord can't use a smartphone, assign a caretaker to manage this rental on the platform.</p>
              
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={form.caretaker_type === 'self' ? 'default' : 'outline'}
                  onClick={() => setForm(f => ({ ...f, caretaker_type: 'self' }))}
                  className="flex-1 h-12 text-sm font-semibold"
                >
                  I'm the Caretaker
                </Button>
                <Button
                  type="button"
                  variant={form.caretaker_type === 'other' ? 'default' : 'outline'}
                  onClick={() => setForm(f => ({ ...f, caretaker_type: 'other' }))}
                  className="flex-1 h-12 text-sm font-semibold"
                >
                  Someone Else
                </Button>
              </div>

              {form.caretaker_type === 'self' && (
                <p className="flex items-center justify-center gap-1.5 rounded-lg bg-success/10 p-2 text-xs font-medium text-success">
                  <Check className="h-3.5 w-3.5" /> You'll be registered as the caretaker for this rental
                </p>
              )}

              {form.caretaker_type === 'other' && (
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <Label className="text-sm font-medium">Caretaker Name *</Label>
                    <Input
                      placeholder="Full name"
                      className={`h-12 text-base ${attempted && !form.caretaker_name.trim() ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                      value={form.caretaker_name}
                      onChange={e => setForm(f => ({ ...f, caretaker_name: e.target.value }))}
                    />
                    {attempted && !form.caretaker_name.trim() && (
                      <FieldError message="Enter the caretaker's full name." />
                    )}
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Caretaker Phone *</Label>
                    <Input
                      placeholder="0771234567"
                      type="tel"
                      inputMode="tel"
                      className={`h-12 text-base ${attempted && !form.caretaker_phone.trim() ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                      value={form.caretaker_phone}
                      onChange={e => setForm(f => ({ ...f, caretaker_phone: e.target.value }))}
                    />
                    {attempted && !form.caretaker_phone.trim() && (
                      <FieldError message="Enter the caretaker's phone number." />
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          </>
          )}

          {/* ── Step 1: House type & rent ── */}
          {step === 1 && (
          <>
          <FormStepHeader
            icon={Home}
            stepLabel="Step 1 of 3"
            title="What kind of house?"
            subtitle="Tap the picture that matches."
          />
          {/* Property Details */}
          <div id="lh-field-house" className="space-y-3">
            <div>
              <Label className="text-sm font-medium">Rooms</Label>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={20}
                value={form.number_of_rooms}
                onChange={e => setForm(f => ({ ...f, number_of_rooms: parseInt(e.target.value) || 1 }))}
                className="h-12 w-full text-base"
              />
            </div>
            {/* House category dropdown */}
            <div>
              <Label className="text-sm font-medium">House type</Label>
              <Select
                value={form.house_category}
                onValueChange={(v) => setForm(f => ({ ...f, house_category: v }))}
              >
                <SelectTrigger className="h-12 w-full text-base">
                  <SelectValue placeholder="Select house type" />
                </SelectTrigger>
                <SelectContent className="bg-popover">
                  {HOUSE_CATEGORIES.map(c => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div id="lh-field-rent">
              <Label className="text-sm font-medium">Monthly Rent (UGX) *</Label>
              <Input
                type="number"
                inputMode="numeric"
                placeholder="e.g. 150000"
                value={form.monthly_rent}
                onChange={e => setForm(f => ({ ...f, monthly_rent: e.target.value }))}
                className={`h-12 text-base ${attempted && (!monthlyRent || monthlyRent < 10000) ? 'border-destructive focus-visible:ring-destructive' : ''}`}
              />
              {attempted && (!monthlyRent || monthlyRent < 10000) ? (
                <FieldError
                  message={
                    !monthlyRent
                      ? 'Enter the monthly rent the landlord charges.'
                      : 'Monthly rent must be at least UGX 10,000.'
                  }
                />
              ) : (
                !monthlyRent && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Type the full monthly rent in shillings, e.g. 150000.
                  </p>
                )
              )}
              {monthlyRent > 0 && (
                <div className="mt-2 p-3 rounded-lg bg-success/10 border border-success/20">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Landlord gets</span>
                    <span className="font-semibold">{formatUGX(monthlyRent)}/month</span>
                  </div>
                  <div className="border-t border-success/20 mt-2 pt-2 flex justify-between">
                    <span className="text-sm font-bold text-success">Daily Rate</span>
                    <span className="text-sm font-bold text-success">{formatUGX(pricing.dailyRate)}/day</span>
                  </div>
                </div>
              )}
            </div>
          </div>
          </>
          )}

          {/* ── Step 1 (cont.): Photos & place ── */}
          {step === 1 && (
          <>
          <FormStepHeader
            icon={ImagePlus}
            title="Location"
            subtitle="Tell us where the house is."
          />
          {/* Location */}
          <div id="lh-field-location" className="space-y-3 p-3 rounded-xl bg-muted/30 border border-border">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase">Location</p>
              {prefilledFromProfile && (
                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-primary">
                  <Sparkles className="h-3 w-3" /> Filled from your profile
                </span>
              )}
            </div>

            {/* Village search — the single source of truth for location.
                Region and district are derived automatically from the selected village. */}
            <UgLocationPicker
              label="Village"
              value={ugLoc}
              onChange={applyUgLocation}
              required
              error={attempted && !ugLoc ? 'Search and select the village where the house is located' : null}
            />

            {/* Unique GPS pin for THIS house */}
            <div className={`rounded-lg border bg-background p-3 ${attempted && !geo ? 'border-destructive bg-destructive/5' : 'border-border'}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Exact GPS location *</p>
                  <p className="text-[11px] text-muted-foreground">
                    {geo
                      ? `Pinned: ${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}${geo.accuracy ? ` · ±${Math.round(geo.accuracy)}m` : ''}`
                      : 'Stand at the house and pin its unique coordinates.'}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={geo ? 'outline' : 'default'}
                  onClick={captureGeo}
                  disabled={capturingGeo}
                  className="h-9 shrink-0"
                >
                  {capturingGeo ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <MapPin className="h-4 w-4" />
                  )}
                  <span className="ml-1">{geo ? 'Re-pin' : 'Pin location'}</span>
                </Button>
              </div>
              {geo && (
                <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-success">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Unique location captured for this house
                </span>
              )}
              {attempted && !geo && (
                <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" /> GPS location is required to list this house
                </span>
              )}
              {geo && (
                <div className="mt-3 space-y-1.5">
                  <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1">
                    <p className="text-[11px] font-medium text-muted-foreground">Coordinates</p>
                    <p className="text-sm font-semibold tabular-nums">
                      {geo.lat.toFixed(6)}, {geo.lng.toFixed(6)}
                    </p>
                    <p className="mt-2 text-[11px] font-medium text-muted-foreground">Resolved location</p>
                    <p className="text-sm">
                      {resolvingPlace
                        ? 'Resolving location name…'
                        : resolvedPlace || 'Location name unavailable'}
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <GpsQualityIndicator
                      latitude={geo.lat}
                      longitude={geo.lng}
                      accuracy={geo.accuracy}
                    />
                    {geo.accuracy != null && geo.accuracy > 100 && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-destructive">
                        <AlertTriangle className="h-3.5 w-3.5" /> Low accuracy — move outdoors & re-pin
                      </span>
                    )}
                  </div>
                  <label
                    className={`mt-1 flex items-start gap-2 rounded-lg border p-2.5 cursor-pointer ${
                      attempted && !geoConfirmed ? 'border-destructive bg-destructive/5' : 'border-border bg-muted/30'
                    }`}
                  >
                    <Checkbox
                      checked={geoConfirmed}
                      onCheckedChange={(v) => setGeoConfirmed(v === true)}
                      className="mt-0.5"
                    />
                    <span className="text-xs font-medium leading-snug">
                      I confirm this GPS location is correct and the pin sits on the actual house. *
                    </span>
                  </label>
                </div>
              )}
            </div>

          </div>
          </>
          )}

          {/* ── Step 2: Photo review gallery ── */}
          {step === 2 && (
          <>
          <FormStepHeader
            icon={Camera}
            stepLabel="Step 2 of 3"
            title="Photo review"
            subtitle="Review your photos before submitting the listing."
          />
          {/* Photo uploader — agents can still add more */}
          <div
            id="lh-field-photos"
            className={`space-y-2 p-3 rounded-xl border ${
              attempted && images.length < 3 ? 'border-destructive bg-destructive/5' : 'border-border bg-muted/30'
            }`}
          >
            <p className="text-sm font-medium">
              House photos <span className="text-destructive">*</span>
              <span className="text-muted-foreground font-normal ml-1">({images.length} added)</span>
            </p>
            <HouseImageUploader
              images={images}
              onChange={(newImages) => {
                setImages(newImages);
                setPreviewIndex((prev) => Math.min(prev, Math.max(0, newImages.length - 1)));
              }}
              region={ugLoc ? (DISTRICT_TO_BACKEND_REGION[ugLoc.district] ?? 'Central') : ''}
              district={ugLoc?.district ?? ''}
              village={ugLoc?.village ?? ''}
              maxImages={14}
              minImages={3}
              cameraOnly
            />
            {attempted && images.length < 3 && (
              <FieldError message="Take at least 3 photos of the house to list it." />
            )}
          </div>

          {/* Full gallery preview — large image + thumbnail strip */}
          {images.length > 0 && (
            <div className="space-y-3 p-3 rounded-xl border border-border bg-muted/20">
              <p className="text-xs font-semibold text-muted-foreground uppercase">Preview gallery</p>

              {/* Main large preview */}
              <div className="relative aspect-[4/3] rounded-xl overflow-hidden bg-muted border border-border">
                <img
                  src={images[previewIndex]?.previewUrl}
                  alt={`House photo ${previewIndex + 1} of ${images.length}`}
                  className="w-full h-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => {
                    const id = images[previewIndex]?.id;
                    if (id) {
                      const img = images.find(i => i.id === id);
                      if (img) URL.revokeObjectURL(img.previewUrl);
                      const next = images.filter(i => i.id !== id);
                      setImages(next);
                      setPreviewIndex((prev) => Math.min(prev, Math.max(0, next.length - 1)));
                    }
                  }}
                  className="absolute top-2 right-2 bg-destructive text-destructive-foreground rounded-full p-1.5 shadow-lg hover:scale-105 transition-transform"
                  aria-label="Remove this photo"
                >
                  <X className="h-4 w-4" />
                </button>
                <div className="absolute bottom-2 left-2 bg-black/60 text-white text-xs font-medium px-2.5 py-1 rounded-full backdrop-blur-sm">
                  {previewIndex + 1} / {images.length}
                </div>
              </div>

              {/* Thumbnail strip — clickable and draggable to reorder */}
              <div className="flex gap-2 overflow-x-auto pb-1 snap-x items-center">
                {images.map((img, i) => (
                  <div
                    key={img.id}
                    draggable
                    onDragStart={() => {
                      setIsDragging(true);
                      setDragOverIndex(i);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (dragOverIndex !== i) setDragOverIndex(i);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = dragOverIndex ?? i;
                      if (from !== i) {
                        const next = [...images];
                        const [moved] = next.splice(from, 1);
                        next.splice(i, 0, moved);
                        setImages(next);
                        // Keep the preview on the moved image
                        if (previewIndex === from) {
                          setPreviewIndex(i);
                        } else if (from < i && previewIndex > from && previewIndex <= i) {
                          setPreviewIndex(previewIndex - 1);
                        } else if (from > i && previewIndex >= i && previewIndex < from) {
                          setPreviewIndex(previewIndex + 1);
                        }
                      }
                      setDragOverIndex(null);
                      setIsDragging(false);
                    }}
                    onDragEnd={() => {
                      setDragOverIndex(null);
                      setIsDragging(false);
                    }}
                    onClick={() => setPreviewIndex(i)}
                    className={`relative shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 transition-all cursor-grab active:cursor-grabbing ${
                      i === previewIndex
                        ? 'border-primary ring-2 ring-primary/30'
                        : dragOverIndex === i && isDragging
                          ? 'border-dashed border-primary bg-primary/10 scale-105'
                          : 'border-border opacity-80 hover:opacity-100'
                    }`}
                  >
                    <div className="absolute top-0.5 left-0.5 z-10 bg-black/40 text-white rounded-full p-0.5">
                      <GripVertical className="h-3 w-3" />
                    </div>
                    <img
                      src={img.previewUrl}
                      alt={`Thumbnail ${i + 1}`}
                      className="w-full h-full object-cover pointer-events-none"
                      draggable={false}
                    />
                    {img.source === 'existing' && (
                      <div className="absolute bottom-0 left-0 right-0 bg-amber-500/80 text-[8px] text-center text-white font-medium py-0.5">
                        Reused
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Empty state when no photos yet */}
          {images.length === 0 && (
            <div className="p-6 rounded-xl border border-dashed border-border bg-muted/20 text-center space-y-2">
              <ImagePlus className="h-8 w-8 mx-auto text-muted-foreground" />
              <p className="text-sm font-medium text-muted-foreground">No photos yet</p>
              <p className="text-xs text-muted-foreground">Tap the button above "<b>Take Photo</b>" to upload your photos (3 pictures at least)</p>
            </div>
          )}
          </>
          )}

          {/* ── Step 3 (cont.): LC1 (optional) & confirm ── */}
          {step === 3 && (
          <>
          <FormStepHeader
            icon={CheckCircle2}
            title="Almost done"
            subtitle="The LC1 chairperson is required to list the house."
          />
          {/* LC1 Chairperson — required; registering a new one earns UGX 5,000 */}
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-muted-foreground uppercase">LC1 Chairperson <span className="normal-case text-[10px] font-normal text-destructive">(required · earns UGX 5,000)</span></p>
          </div>
          <Lc1ChairpersonPicker
            value={lc1Selection}
            onChange={setLc1Selection}
            defaultRegion={ugLoc ? (DISTRICT_TO_BACKEND_REGION[ugLoc.district] ?? 'Central') : ''}
            defaultDistrict={ugLoc?.district ?? ''}
            defaultVillage={ugLoc?.village ?? ''}
            scopeDistrictName={ugLoc?.district ?? null}
            attempted={attempted}
          />

          {/* Amenities */}
          {/* Optional extras — collapsed by default to keep the form short */}
          <div className="border border-border rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setShowOptional(s => !s)}
              className="w-full flex items-center justify-between px-3 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
            >
              <span className="text-xs font-semibold text-muted-foreground uppercase">
                Optional details {showOptional ? '' : '(title, description, amenities)'}
              </span>
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${showOptional ? 'rotate-180' : ''}`} />
            </button>
            {showOptional && (
              <div className="p-3 space-y-3">
                <div>
                  <Label className="text-xs">House Title</Label>
                  <Input
                    placeholder="e.g. Spacious single room near town"
                    value={form.title}
                    onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  />
                </div>
                <div>
                  <Label className="text-xs">Description</Label>
                  <Textarea
                    placeholder="Describe the property..."
                    value={form.description}
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                    rows={2}
                  />
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Amenities</p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { key: 'has_water', label: '💧 Water' },
                      { key: 'has_electricity', label: '⚡ Electricity' },
                      { key: 'has_security', label: '🔒 Security' },
                      { key: 'has_parking', label: '🚗 Parking' },
                      { key: 'is_furnished', label: '🛋️ Furnished' },
                    ].map(a => (
                      <label key={a.key} className="flex items-center gap-2 p-2 rounded-lg bg-muted/30 cursor-pointer">
                        <Checkbox
                          checked={(form as any)[a.key]}
                          onCheckedChange={v => setForm(f => ({ ...f, [a.key]: !!v }))}
                        />
                        <span className="text-sm">{a.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Bonus reminder */}
          <div className="flex items-center gap-2 rounded-xl border border-chart-4/20 bg-chart-4/10 p-3">
            <Trophy className="h-4 w-4 shrink-0 text-chart-4" />
            <p className="text-xs font-semibold text-chart-4">
              You earn UGX 10,000 the moment a tenant is placed in this house.
            </p>
          </div>

          {/* ── Preflight check: exactly what's still required before listing ── */}
          <div className={`rounded-xl border p-3 space-y-2 ${allGatesPass ? 'border-success/30 bg-success/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
            <p className={`text-xs font-bold flex items-center gap-1.5 ${allGatesPass ? 'text-success' : 'text-amber-700 dark:text-amber-400'}`}>
              {allGatesPass ? <Check className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
              {allGatesPass
                ? 'All set — you can list this house'
                : `${missingGates.length} thing${missingGates.length === 1 ? '' : 's'} still needed before you can list`}
            </p>
            <ul className="space-y-1.5">
              {preflightGates.map((g) => (
                <li key={g.label} className="flex items-start gap-2 text-xs">
                  <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${g.ok ? 'bg-success text-success-foreground' : 'bg-amber-500 text-white'}`}>
                    {g.ok ? <Check className="h-2.5 w-2.5" /> : '!'}
                  </span>
                  <span className="min-w-0">
                    <span className={g.ok ? 'text-muted-foreground line-through' : 'font-medium text-foreground'}>{g.label}</span>
                    {!g.ok && (
                      <span className="block text-[11px] text-amber-700 dark:text-amber-400">
                        {g.hint}
                        {g.step !== step && (
                          <button type="button" onClick={() => { setStep(g.step); scrollDialogToTop(); }} className="ml-1 underline font-semibold">
                            Fix on step {g.step}
                          </button>
                        )}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          </>
          )}

          {/* Wizard navigation — big Back / Next / List buttons.
              Sticky to the bottom of the scrollable dialog so the main action
              is always reachable on small phones without scrolling.
              Solid background (no backdrop-blur dependency) and a safe-area
              inset so it stays tappable on low-end Androids and gesture-bar /
              notched phones common across Africa. */}
          <div
            className="sticky bottom-0 -mx-4 sm:-mx-6 mt-2 flex gap-2 border-t border-border bg-background px-4 sm:px-6 pt-3 pb-1 relative"
            style={{ paddingBottom: 'max(0.25rem, env(safe-area-inset-bottom))' }}
          >
            {formMessage && (
              <div
                role={formMessage.kind === 'error' ? 'alert' : 'status'}
                aria-live="polite"
                className={`absolute left-0 right-0 -top-2 -translate-y-full mx-4 sm:mx-6 rounded-xl border px-3 py-2.5 shadow-lg flex items-start gap-2 ${
                  formMessage.kind === 'error'
                    ? 'bg-destructive/10 border-destructive/30 text-destructive'
                    : formMessage.kind === 'success'
                      ? 'bg-success/10 border-success/30 text-success'
                      : 'bg-primary/10 border-primary/30 text-primary'
                }`}
              >
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                    formMessage.kind === 'error'
                      ? 'bg-destructive text-destructive-foreground'
                      : formMessage.kind === 'success'
                        ? 'bg-success text-success-foreground'
                        : 'bg-primary text-primary-foreground'
                  }`}
                >
                  {formMessage.kind === 'success' ? <Check className="h-3 w-3" /> : '!'}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold leading-tight">{formMessage.text}</p>
                  {formMessage.description && (
                    <p className="text-xs opacity-90 leading-snug mt-0.5">{formMessage.description}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setFormMessage(null)}
                  aria-label="Dismiss"
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold opacity-70 hover:opacity-100"
                >
                  ✕
                </button>
              </div>
            )}
            {step > 1 && (
              <Button type="button" variant="outline" className="h-14 flex-1 min-w-0 text-base font-semibold active:scale-95 touch-manipulation" onClick={goBack}>
                <ArrowLeft className="h-5 w-5 mr-1 shrink-0" /> Back
              </Button>
            )}
            {step < TOTAL_STEPS ? (
              <Button
                type="button"
                className="h-14 flex-[2] min-w-0 text-base font-bold active:scale-95 touch-manipulation"
                onClick={goNext}
                disabled={step === 2 && images.length < 3}
              >
                Next <ArrowRight className="h-5 w-5 ml-1 shrink-0" />
              </Button>
            ) : (
              <Button
                type="submit"
                className="h-14 flex-[2] min-w-0 text-base font-bold active:scale-95 touch-manipulation"
                disabled={submitting}
                onClick={(e) => {
                  // Defensive: some mobile browsers swallow form submit when
                  // a native-validated input (e.g. type="number") rejects silently.
                  // Guarantee the handler always runs.
                  if (e.currentTarget.form) return;
                  handleSubmit();
                }}
              >
                {submitting ? <Loader2 className="h-5 w-5 animate-spin mr-2" /> : <Home className="h-5 w-5 mr-2" />}
                <span className="truncate">{allGatesPass ? 'List house' : `${missingGates.length} item${missingGates.length === 1 ? '' : 's'} left`}</span>
              </Button>
            )}
          </div>
        </form>
        </>
        )}
      </DialogContent>
    </Dialog>
    <VerificationRequestDetailSheet
      requestId={detailRequestId}
      open={detailSheetOpen}
      onOpenChange={setDetailSheetOpen}
    />
    </>
  );
}
