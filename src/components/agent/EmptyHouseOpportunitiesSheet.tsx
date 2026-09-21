import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Home, Loader2, Search, SlidersHorizontal, Check, Share2, ShieldCheck, MapPin, Users, Phone, MessageSquare, Navigation, ImageIcon, Eye, Clock, CheckCircle2, UserCheck, Wallet, X, CalendarDays, ShoppingCart, ArrowRight, ArrowLeft } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatUGX } from '@/lib/rentCalculations';
import { prettyName } from '@/lib/formatting';
import { UGANDA_DISTRICTS, CITY_TO_DISTRICT } from '@/lib/ugandaDistricts';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import { EmptyHouseDetailSheet, housePlace, type HouseOpportunity } from '@/components/agent/EmptyHouseDetailSheet';


const PAGE_SIZE = 20;

/**
 * Listings carry free-typed district text (typos, appended notes, city names).
 * Resolve each raw value back to an official Uganda district so the filter list
 * shows real districts only.
 */
const officialDistrict = (raw: string | null | undefined): string | null => {
  const cleaned = (raw ?? '').trim();
  if (!cleaned) return null;
  const key = cleaned.toLowerCase();
  if (CITY_TO_DISTRICT[key]) return CITY_TO_DISTRICT[key];
  const exact = UGANDA_DISTRICTS.find((d) => d.toLowerCase() === key);
  if (exact) return exact;
  const cityPrefix = Object.keys(CITY_TO_DISTRICT).find((c) => key.startsWith(c));
  if (cityPrefix) return CITY_TO_DISTRICT[cityPrefix];
  // Longest district name that the typed text starts with, e.g. "Kampalakfide ihdjb" → Kampala.
  const prefixed = UGANDA_DISTRICTS
    .filter((d) => key.startsWith(d.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  return prefixed ?? null;
};

const placeOf = (h: HouseOpportunity) =>
  [h.village, h.sub_county, h.district].filter(Boolean).join(', ') || h.region || 'Location on file';

const hasGps = (h: HouseOpportunity) =>
  typeof h.latitude === 'number' && typeof h.longitude === 'number' && (h.latitude !== 0 || h.longitude !== 0);

const mapsUrl = (h: HouseOpportunity) => `https://www.google.com/maps/search/?api=1&query=${h.latitude},${h.longitude}`;

type HouseProgress = {
  house_id: string;
  is_funded: boolean;
  tenant_activated: boolean;
  monthly_paid_this_month: boolean;
};

/** Live progress badges: funded → tenant activated → paid this month. */
function HouseProgressBadges({ progress }: { progress?: HouseProgress }) {
  const items = [
    { active: Boolean(progress?.is_funded), on: 'Funded', off: 'Awaiting funding', Icon: progress?.is_funded ? CheckCircle2 : Clock },
    { active: Boolean(progress?.tenant_activated), on: 'Tenant activated', off: 'Tenant pending', Icon: UserCheck },
    { active: Boolean(progress?.monthly_paid_this_month), on: 'Paid this month', off: 'Monthly payment pending', Icon: Wallet },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(({ active, on, off, Icon }) => (
        <Badge
          key={on}
          variant="outline"
          className={`h-5 gap-1 text-[10px] ${
            active
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
              : 'border-muted-foreground/20 bg-muted text-muted-foreground'
          }`}
        >
          <Icon className="h-3 w-3" /> {active ? on : off}
        </Badge>
      ))}
    </div>
  );
}

/**
 * Self support: specific EMPTY houses are matched to a partner.
 *
 * The partner funds one month of rent for each house they pick. The agent who
 * listed the house places a tenant as soon as the note is fulfilled, and the
 * partner earns 15% of that rent every month for the next 12 months, paid from
 * what the tenant repays.
 *
 * mode="agent"   — an agent tags a partner (default).
 * mode="partner" — a funder picks houses for themselves on their own dashboard.
 */
export function EmptyHouseOpportunitiesSheet({
  open,
  onOpenChange,
  mode = 'agent',
  selfName,
  selfPhone,
  selfEmail,
  initialMaxRent,
  projection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode?: 'agent' | 'partner';
  selfName?: string | null;
  selfPhone?: string | null;
  selfEmail?: string | null;
  /** Pre-fills the max-rent filter when the sheet opens (e.g. from the funder calculator). */
  initialMaxRent?: number | null;
  /** Projected return from the funder calculator, shown on the first picker screen. */
  projection?: { houses: number; funding: number; monthly: number } | null;
}) {
  const isPartner = mode === 'partner';

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);
  const [step, setStep] = useState<'browse' | 'checkout'>('browse');
  const [selected, setSelected] = useState<Record<string, HouseOpportunity>>({});
  const [district, setDistrict] = useState('all');
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [mapPinOnly, setMapPinOnly] = useState(false);
  const [minRent, setMinRent] = useState('');
  const [maxRent, setMaxRent] = useState('');
  const [nearMe, setNearMe] = useState<{ lat: number; lng: number; radiusKm: number } | null>(null);
  const [sort, setSort] = useState<'recommended' | 'nearest' | 'newest' | 'rent_high' | 'rent_low'>('recommended');
  const [locating, setLocating] = useState(false);


  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [email, setEmail] = useState('');
  const [contributionType, setContributionType] = useState<'monthly' | 'compounding'>('compounding');
  const [deductionDay, setDeductionDay] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [createdNote, setCreatedNote] = useState<{ id: string; activation_token?: string } | null>(null);
  const [createdNotes, setCreatedNotes] = useState<
    { id: string; activation_token?: string; label: string; amount: number }[]
  >([]);
  const [splitPerHouse, setSplitPerHouse] = useState(true);
  const [detailHouse, setDetailHouse] = useState<HouseOpportunity | null>(null);
  // Partner mode only: "Promise a date" holds the houses for 7 days.
  const [promisedDate, setPromisedDate] = useState('');
  const [fundingNow, setFundingNow] = useState(false);



  const partnerName = isPartner ? (selfName || '').trim() : joinPersonName(nameParts);

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setPage(0); }, 350);
    return () => clearTimeout(t);
  }, [search]);

  // Pre-fill the max-rent filter from the funder calculator when the sheet opens.
  useEffect(() => {
    if (open && initialMaxRent && initialMaxRent > 0) {
      setMaxRent(String(Math.round(initialMaxRent)));
      setPage(0);
    }
  }, [open, initialMaxRent]);

  const reset = () => {
    setSearch(''); setDebounced(''); setPage(0); setSelected({}); setStep('browse');
    setNameParts({ firstName: '', otherNames: '', lastName: '' });
    setWhatsappNumber(''); setPhoneNumber(''); setEmail('');
    setContributionType('compounding'); setDeductionDay('1');
    setErrorMsg(null); setCreatedNote(null); setCreatedNotes([]); setSplitPerHouse(true);
    setDistrict('all'); setVerifiedOnly(false); setMapPinOnly(false);
    setMinRent(''); setMaxRent(''); setNearMe(null); setSort('recommended');

  };

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['empty-house-opportunities', debounced, page, district, verifiedOnly, mapPinOnly, minRent, maxRent, nearMe, sort],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_list_empty_house_opportunities', {
        p_search: debounced || null,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
        // ILIKE pattern so an official district also matches free-typed variants
        // stored on listings ("Kampala…", "Wakiso xyz").
        p_district: district === 'all' ? null : `${district}%`,
        p_verified_only: verifiedOnly,
        p_gps_only: mapPinOnly || Boolean(nearMe),
        p_min_rent: minRent ? Number(minRent) : null,
        p_max_rent: maxRent ? Number(maxRent) : null,
        p_near_lat: nearMe?.lat ?? null,
        p_near_lng: nearMe?.lng ?? null,
        p_radius_km: nearMe?.radiusKm ?? null,
        p_sort: sort,
      });
      if (error) throw error;
      const payload = (data ?? {}) as { total?: number; houses?: HouseOpportunity[]; districts?: string[] };
      return {
        total: Number(payload.total || 0),
        houses: payload.houses ?? [],
        districts: payload.districts ?? [],
      };
    },
  });

  const districtOptions = useMemo(() => {
    const set = new Set<string>();
    for (const raw of data?.districts ?? []) {
      const official = officialDistrict(raw);
      if (official) set.add(official);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [data?.districts]);
  const activeFilterCount =
    (district !== 'all' ? 1 : 0) + (verifiedOnly ? 1 : 0) + (mapPinOnly ? 1 : 0) +
    (minRent ? 1 : 0) + (maxRent ? 1 : 0) + (nearMe ? 1 : 0);

  const clearFilters = () => {
    setDistrict('all'); setVerifiedOnly(false); setMapPinOnly(false);
    setMinRent(''); setMaxRent(''); setNearMe(null); setPage(0);
  };

  const filterChips: { key: string; label: string; onRemove: () => void }[] = [
    ...(search.trim() ? [{ key: 'search', label: `Search: "${search.trim()}"`, onRemove: () => { setSearch(''); setPage(0); } }] : []),
    ...(district !== 'all' ? [{ key: 'district', label: `District: ${district}`, onRemove: () => { setDistrict('all'); setPage(0); } }] : []),
    ...(verifiedOnly ? [{ key: 'verified', label: 'Verified only', onRemove: () => { setVerifiedOnly(false); setPage(0); } }] : []),
    ...(mapPinOnly ? [{ key: 'pin', label: 'Has map pin', onRemove: () => { setMapPinOnly(false); setPage(0); } }] : []),
    ...(minRent ? [{ key: 'minRent', label: `Min rent: ${minRent}`, onRemove: () => { setMinRent(''); setPage(0); } }] : []),
    ...(maxRent ? [{ key: 'maxRent', label: `Max rent: ${maxRent}`, onRemove: () => { setMaxRent(''); setPage(0); } }] : []),
    ...(nearMe ? [{ key: 'nearMe', label: `Within ${nearMe.radiusKm} km`, onRemove: () => { setNearMe(null); setPage(0); } }] : []),
  ];


  const useMyLocation = () => {
    if (!navigator.geolocation) { toast.error('Location is not available on this device'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setNearMe({ lat: pos.coords.latitude, lng: pos.coords.longitude, radiusKm: 10 });
        setPage(0);
        setLocating(false);
      },
      () => { setLocating(false); toast.error('Could not get your location'); },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };


  const queryClient = useQueryClient();

  // Live funding / tenant / payout progress for houses this user already supports.
  const { data: progressRows } = useQuery({
    queryKey: ['empty-house-progress'],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('partner_supported_house_returns');
      if (error) throw error;
      const payload = (data ?? {}) as { houses?: HouseProgress[] };
      return payload.houses ?? [];
    },
    staleTime: 30_000,
  });

  const progressByHouse = useMemo(() => {
    const map: Record<string, HouseProgress> = {};
    for (const row of progressRows ?? []) if (row?.house_id) map[row.house_id] = row;
    return map;
  }, [progressRows]);

  useEffect(() => {
    if (!open) return;
    const invalidate = () => { queryClient.invalidateQueries({ queryKey: ['empty-house-progress'] }); };
    const channel = supabase
      .channel('empty-house-progress')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'promissory_note_house_intents' }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'promissory_notes' }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_landlord_payouts' }, invalidate)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [open, queryClient]);

  const houses = data?.houses ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const picked = useMemo(() => Object.values(selected), [selected]);
  const rentTotal = picked.reduce((s, h) => s + Number(h.monthly_rent || 0), 0);
  const monthlyReturn = Math.round(rentTotal * 0.15);
  const annualReturn = monthlyReturn * 12;

  const phoneDigits = (v: string) => v.replace(/\D/g, '');
  const isValidPhone = (v: string) => phoneDigits(v).length === 10;

  const missing = (): string[] => {
    const out: string[] = [];
    if (picked.length === 0) out.push('At least one empty house');
    if (isPartner) return out;
    const nameCheck = validatePersonNameParts(nameParts);
    if (!nameCheck.valid) out.push(nameCheck.error || 'Partner name');
    if (!isValidPhone(whatsappNumber)) out.push('WhatsApp number (10 digits)');
    if (phoneNumber.trim() && !isValidPhone(phoneNumber)) out.push('Phone number (10 digits)');
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) out.push('Valid email');
    return out;
  };


  const toggle = (h: HouseOpportunity) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[h.house_id]) delete next[h.house_id];
      else next[h.house_id] = h;
      return next;
    });
  };

  const handleSubmit = async () => {
    if (submitting) return;
    setErrorMsg(null);
    const gaps = missing();
    if (gaps.length) {
      const msg = `Please complete: ${gaps.join(', ')}`;
      setErrorMsg(msg);
      toast.error(msg);
      return;
    }

    setSubmitting(true);
    try {
      const buildPayload = (amount: number): Record<string, string | number | null> => {
        const payload: Record<string, string | number | null> = {
          partner_name: (isPartner ? (selfName || '') : partnerName).trim(),
          whatsapp_number: (isPartner ? (selfPhone || '') : whatsappNumber).trim(),
          phone_number: (isPartner ? (selfPhone || '') : phoneNumber).trim() || null,
          email: (isPartner ? (selfEmail || '') : email).trim() || null,
          amount,
          contribution_type: contributionType === 'monthly' ? 'monthly' : 'once_off',
        };
        if (isPartner && promisedDate) payload.promised_funding_date = promisedDate;
        if (contributionType === 'monthly') {
          payload.deduction_day = String(Number(deductionDay));
          const now = new Date();
          const next = new Date(now.getFullYear(), now.getMonth(), Number(deductionDay));
          if (next <= now) next.setMonth(next.getMonth() + 1);
          payload.next_deduction_date = next.toISOString().split('T')[0];
        }
        return payload;
      };

      const createFor = async (houseIds: string[], amount: number) => {
        const { data, error } = await supabase.rpc('agent_create_promissory_note_for_houses', {
          p_payload: buildPayload(amount),
          p_house_ids: houseIds,
        });
        if (error) throw error;
        const result = (data ?? {}) as { note?: { id: string; activation_token?: string } };
        if (!result.note) throw new Error('Note was not created');
        void supabase.functions
          .invoke('notify-promissory-note-pledge', { body: { note_id: result.note.id } })
          .catch(() => {});
        void supabase.functions
          .invoke('notify-house-booking', { body: { note_id: result.note.id } })
          .catch(() => {});
        return result.note;
      };


      if (splitPerHouse && picked.length > 1) {
        const made: { id: string; activation_token?: string; label: string; amount: number }[] = [];
        for (const h of picked) {
          const amount = Number(h.monthly_rent || 0);
          const note = await createFor([h.house_id], amount);
          made.push({ ...note, label: h.title || housePlace(h), amount });
          setCreatedNotes([...made]);
        }
        toast.success(`${made.length} promissory notes created — one per house`);
      } else {
        const note = await createFor(picked.map((h) => h.house_id), rentTotal);
        setCreatedNote(note);
        toast.success(`Note created for ${picked.length} empty house${picked.length === 1 ? '' : 's'}`);
      }
    } catch (err: unknown) {
      const raw = String((err as { message?: string })?.message || 'Failed to create note');
      const msg = raw.includes('HOUSES_UNAVAILABLE')
        ? 'Some selected houses are no longer empty. Refresh the list and pick again.'
        : raw;
      setErrorMsg(msg);
      toast.error(msg);
      if (raw.includes('HOUSES_UNAVAILABLE')) { setSelected({}); void refetch(); }
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Partner mode only — book the picked houses and immediately submit the funding
   * through the existing house-support path (operational review, then release to
   * the landlords). No money moves in the client.
   */
  const handleFundNow = async () => {
    if (fundingNow || submitting) return;
    setErrorMsg(null);
    if (picked.length === 0) {
      const msg = 'Pick at least one empty house first';
      setErrorMsg(msg);
      toast.error(msg);
      return;
    }

    setFundingNow(true);
    try {
      const houseIds = picked.map((h) => h.house_id);
      const { data, error } = await supabase.rpc('agent_create_promissory_note_for_houses', {
        p_payload: {
          partner_name: (selfName || '').trim(),
          whatsapp_number: (selfPhone || '').trim(),
          phone_number: (selfPhone || '').trim() || null,
          email: (selfEmail || '').trim() || null,
          amount: rentTotal,
          contribution_type: 'once_off',
        },
        p_house_ids: houseIds,
      });
      if (error) throw error;
      const note = ((data ?? {}) as { note?: { id: string } }).note;
      if (!note) throw new Error('Booking was not created');

      const { error: fundErr } = await supabase.rpc('funder_fund_booked_houses', {
        p_house_ids: houseIds,
        p_term_months: 1,
        p_idempotency_key: `fund-${note.id}`,
      });
      if (fundErr) throw fundErr;

      void supabase.functions.invoke('notify-house-booking', { body: { note_id: note.id } }).catch(() => {});
      toast.success(
        `Funding submitted for ${picked.length} house${picked.length === 1 ? '' : 's'} — it goes for operational review, then agents place tenants.`,
      );
      window.dispatchEvent(new Event('supporter-contribution-changed'));
      setSelected({});
      void refetch();
      onOpenChange(false);
    } catch (err: unknown) {
      const raw = String((err as { message?: string })?.message || 'Failed to fund these houses');
      const msg = raw.includes('HOUSES_UNAVAILABLE')
        ? 'Some selected houses are no longer empty. Refresh the list and pick again.'
        : raw.includes('AGREEMENT_REQUIRED')
          ? 'Please sign your partnership agreement before funding houses.'
          : raw.includes('INSUFFICIENT') || raw.includes('BALANCE')
            ? 'Your balance is not enough for these houses. Add funds or promise a date instead.'
            : raw;
      setErrorMsg(msg);
      toast.error(msg);
      if (raw.includes('HOUSES_UNAVAILABLE')) { setSelected({}); void refetch(); }
    } finally {
      setFundingNow(false);
    }
  };


  const handleShare = async () => {
    if (!createdNote?.activation_token) return;
    const link = `${getPublicOrigin()}/activate?token=${createdNote.activation_token}`;
    const text = `Hi ${partnerName}, you are supporting ${picked.length} home${picked.length === 1 ? '' : 's'} on Welile. You contribute one month of rent (${formatUGX(rentTotal)}) and earn 15% of that rent every month for 12 months — ${formatUGX(monthlyReturn)} per month. Activate here: ${link}`;
    if (navigator.share) {
      navigator.share({ title: 'Welile funding opportunity', text, url: link }).catch(() => {});
    } else {
      await navigator.clipboard.writeText(link);
      toast.success('Activation link copied');
    }
  };

  return (
    <>
    <Sheet open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <SheetContent side="bottom" className="h-[96vh] overflow-y-auto p-0">
        <div className="bg-background border-b px-4 py-3">
          <SheetHeader className="text-left space-y-1">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Home className="h-4 w-4 text-primary" /> Empty house opportunities
            </SheetTitle>
            <SheetDescription className="text-[11px] leading-snug">
              {isPartner ? (
                <>
                  Pick the empty houses you want to fund. You pay one month of rent, the agent who listed
                  the house moves a tenant in once your note is fulfilled, and you earn
                  <span className="font-semibold text-emerald-600"> 15% of that rent every month for 12 months</span>.
                </>
              ) : (
                <>
                  Pick the empty houses this partner will fund. They pay one month of rent, the agent who
                  listed the house moves a tenant in once the note is fulfilled, and the partner earns
                  <span className="font-semibold text-emerald-600"> 15% of that rent every month for 12 months</span>.
                </>
              )}
            </SheetDescription>

          </SheetHeader>

          {projection && createdNotes.length === 0 && !createdNote && (
            <div className="mt-10 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-3 py-2">
              <p className="text-[11px] leading-snug">
                <span className="font-semibold">Your plan:</span> fund{' '}
                <span className="font-semibold">{projection.houses.toLocaleString()} {projection.houses === 1 ? 'house' : 'houses'}</span>
                {' '}(≈ {formatUGX(projection.funding)}) → earn{' '}
                <span className="font-semibold text-emerald-600">≈ {formatUGX(projection.monthly)}/month</span>
                {' '}({formatUGX(projection.monthly * 12)} over 12 months)
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Exact figures are shown on each house below as you pick.
              </p>
            </div>
          )}
        </div>

        {/* Summary — pinned at the top of the sheet, not floating */}
        {!createdNote && createdNotes.length === 0 && (
          <div className="border-b bg-background px-4 py-3 space-y-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">
                {picked.length} house{picked.length === 1 ? '' : 's'} · one month of rent
              </span>
              <span className="font-bold">{formatUGX(rentTotal)}</span>
            </div>
            <div className="flex items-center justify-between rounded-xl bg-emerald-500/10 px-3 py-2">
              <span className="text-[11px] font-semibold text-emerald-700">{isPartner ? 'You earn' : 'Partner earns'} 15% per month</span>
              <span className="text-sm font-bold text-emerald-600">{formatUGX(monthlyReturn)}</span>
            </div>
            <p className="text-[10px] text-muted-foreground text-center">
              {formatUGX(annualReturn)} over 12 months, paid monthly from what the tenant repays.
            </p>
            {isPartner ? (
              <div className="space-y-2">
                <div>
                  <Label className="text-[11px]">Promised funding date (optional)</Label>
                  <Input
                    type="date"
                    value={promisedDate}
                    min={new Date().toISOString().split('T')[0]}
                    onChange={(e) => setPromisedDate(e.target.value)}
                    className="mt-0.5 h-10 text-xs"
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Booked houses are held for you for 7 days. If they are not funded by then they go back
                    to the open empty-house list and we notify you by SMS and email.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    className="h-11 gap-2 text-xs font-semibold"
                    onClick={handleSubmit}
                    disabled={submitting || fundingNow}
                  >
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarDays className="h-4 w-4" />}
                    {submitting ? 'Booking…' : 'Promise a date'}
                  </Button>
                  <Button
                    className="h-11 gap-2 text-xs font-semibold"
                    onClick={handleFundNow}
                    disabled={submitting || fundingNow}
                  >
                    {fundingNow ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    {fundingNow ? 'Submitting…' : 'Fund now'}
                  </Button>
                </div>
              </div>
            ) : (
              <Button className="w-full h-11 gap-2 font-semibold" onClick={handleSubmit} disabled={submitting}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {submitting ? 'Creating…' : 'Create note for these houses'}
              </Button>
            )}
          </div>
        )}



        {createdNotes.length > 0 ? (
          <div className="p-4 space-y-4">
            <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4 text-center space-y-1">
              <p className="text-sm font-semibold">
                {createdNotes.length} promissory notes created — one per house
              </p>
              <p className="text-lg font-bold text-primary">{formatUGX(rentTotal)}</p>
              <p className="text-[11px] text-muted-foreground">
                {isPartner ? 'You earn' : 'Partner earns'}{' '}
                <span className="font-semibold text-emerald-600">{formatUGX(monthlyReturn)}</span> per month
                ({formatUGX(annualReturn)} over 12 months)
              </p>
            </div>
            <div className="space-y-2">
              {createdNotes.map((n) => {
                const m = Math.round(Number(n.amount || 0) * 0.15);
                return (
                <div key={n.id} className="rounded-xl border p-3 space-y-2">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold truncate">{n.label}</p>
                      <p className="text-[11px] text-muted-foreground">{formatUGX(n.amount)} · one month of rent</p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 shrink-0"
                      disabled={!n.activation_token}
                      onClick={async () => {
                        if (!n.activation_token) return;
                        await navigator.clipboard.writeText(`${getPublicOrigin()}/activate?token=${n.activation_token}`);
                        toast.success('Activation link copied');
                      }}
                    >
                      <Share2 className="h-3.5 w-3.5" /> Link
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-[10px]">
                    <div>
                      <p className="text-muted-foreground">15% monthly</p>
                      <p className="font-semibold text-emerald-600">{formatUGX(m)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">12-month total</p>
                      <p className="font-semibold text-emerald-600">{formatUGX(m * 12)}</p>
                    </div>
                  </div>
                </div>
                );
              })}
            </div>

            <Button variant="ghost" className="w-full text-xs" onClick={() => { reset(); onOpenChange(false); }}>
              Done
            </Button>
          </div>
        ) : createdNote ? (
          <div className="p-4 space-y-4">
            <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4 text-center space-y-1.5">
              <p className="text-sm font-semibold">
                {isPartner ? 'Your note is created' : `Note created for ${partnerName}`}
              </p>
              <p className="text-lg font-bold text-primary">{formatUGX(rentTotal)}</p>
              <p className="text-[11px] text-muted-foreground">
                {picked.length} empty house{picked.length === 1 ? '' : 's'} tagged ·{' '}
                {isPartner ? 'you earn' : 'partner earns'}{' '}
                <span className="font-semibold text-emerald-600">{formatUGX(monthlyReturn)}</span> per month
                ({formatUGX(annualReturn)} over 12 months)
              </p>
            </div>
            {picked.length > 0 && (
              <div className="rounded-2xl border p-3 space-y-2">
                <p className="text-xs font-bold">Earnings breakdown per house</p>
                {picked.map((h) => {
                  const rent = Number(h.monthly_rent || 0);
                  const m = Math.round(rent * 0.15);
                  return (
                    <div key={h.house_id} className="rounded-xl bg-muted/40 px-3 py-2">
                      <p className="text-[11px] font-semibold truncate">{h.title || housePlace(h)}</p>
                      <div className="mt-1 grid grid-cols-3 gap-2 text-[10px]">
                        <div>
                          <p className="text-muted-foreground">Rent (1 month)</p>
                          <p className="font-semibold">{formatUGX(rent)}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">15% monthly</p>
                          <p className="font-semibold text-emerald-600">{formatUGX(m)}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">12-month total</p>
                          <p className="font-semibold text-emerald-600">{formatUGX(m * 12)}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <Button variant="outline" className="w-full gap-2" onClick={handleShare}>
              <Share2 className="h-4 w-4" /> {isPartner ? 'Copy activation link' : 'Share activation link'}
            </Button>
            <Button variant="ghost" className="w-full text-xs" onClick={() => { reset(); onOpenChange(false); }}>
              Done
            </Button>
          </div>
        ) : (
          <div className="p-4 space-y-4 pb-40">
            {/* Partner tag */}
            {step === 'checkout' && (
            <div className="rounded-2xl border p-3 space-y-2.5">
              <p className="text-xs font-bold">{isPartner ? 'How you will contribute' : 'Tag the partner'}</p>
              {!isPartner && (
                <>
                  <div>
                    <Label className="text-xs">Partner name *</Label>
                    <div className="mt-0.5">
                      <PersonNameFields idPrefix="house-opportunity-partner" value={nameParts} onChange={setNameParts} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">WhatsApp *</Label>
                      <Input value={whatsappNumber} onChange={(e) => setWhatsappNumber(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="0780000000" inputMode="numeric" className="mt-0.5 h-9" />
                    </div>
                    <div>
                      <Label className="text-xs">Phone</Label>
                      <Input value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="0780000000" inputMode="numeric" className="mt-0.5 h-9" />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">Email</Label>
                    <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="partner@email.com" type="email" className="mt-0.5 h-9" />
                  </div>
                </>
              )}
              {isPartner && (
                <p className="text-[11px] text-muted-foreground">
                  This note is created in your name{selfName ? ` (${selfName})` : ''} using the contacts on your profile.
                </p>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Contribution</Label>
                  <Select value={contributionType} onValueChange={(v: 'monthly' | 'compounding') => setContributionType(v)}>
                    <SelectTrigger className="mt-0.5 h-9 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="compounding">One month, once off</SelectItem>
                      <SelectItem value="monthly">Every month</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {contributionType === 'monthly' && (
                  <div>
                    <Label className="text-xs">Day of month</Label>
                    <Select value={deductionDay} onValueChange={setDeductionDay}>
                      <SelectTrigger className="mt-0.5 h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 28 }, (_, i) => (
                          <SelectItem key={i + 1} value={String(i + 1)}>Day {i + 1}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              {picked.length > 1 && (
                <div>
                  <Label className="text-xs">Notes to generate</Label>
                  <Select value={splitPerHouse ? 'per_house' : 'single'} onValueChange={(v) => setSplitPerHouse(v === 'per_house')}>
                    <SelectTrigger className="mt-0.5 h-9 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="per_house">One note per house ({picked.length})</SelectItem>
                      <SelectItem value="single">One note for all houses</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {splitPerHouse
                      ? 'Each house gets its own note and its own activation link, funded with that house\u2019s one month of rent.'
                      : 'All selected houses are tagged on a single note.'}
                  </p>
                </div>
              )}
            </div>
            )}



            {step === 'browse' && (
            <>
            {/* Search + filters */}
            <div className="space-y-2">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by landlord name or phone, village, district or house"
                    className="pl-9 h-10"
                  />
                </div>
                <Popover modal>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant={activeFilterCount > 0 ? 'default' : 'outline'}
                      className="h-10 shrink-0 gap-1.5"
                    >
                      <SlidersHorizontal className="h-4 w-4" />
                      Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    collisionPadding={12}
                    className="z-[200] max-h-[70vh] overflow-y-auto w-[calc(100vw-2rem)] sm:w-[420px] rounded-2xl border bg-popover p-3 space-y-3"
                  >
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">Sort by</Label>
                      <Select
                        value={sort}
                        onValueChange={(v) => {
                          const next = v as typeof sort;
                          setSort(next);
                          setPage(0);
                          if (next === 'nearest' && !nearMe) useMyLocation();
                        }}
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="recommended">Recommended</SelectItem>
                          <SelectItem value="nearest">Nearest to me</SelectItem>
                          <SelectItem value="newest">Newest listings</SelectItem>
                          <SelectItem value="rent_high">Highest funding need</SelectItem>
                          <SelectItem value="rent_low">Lowest funding need</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-[11px] text-muted-foreground">District</Label>
                        <Select value={district} onValueChange={(v) => { setDistrict(v); setPage(0); }}>
                          <SelectTrigger className="h-9">
                            <SelectValue placeholder="All districts" />
                          </SelectTrigger>
                          <SelectContent className="max-h-64">
                            <SelectItem value="all">All districts</SelectItem>
                            {districtOptions.map((d) => (
                              <SelectItem key={d} value={d}>{d}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[11px] text-muted-foreground">Monthly rent (UGX)</Label>
                        <div className="flex gap-2">
                          <Input
                            inputMode="numeric"
                            value={minRent}
                            onChange={(e) => { setMinRent(e.target.value.replace(/\D/g, '')); setPage(0); }}
                            placeholder="Min"
                            className="h-9"
                          />
                          <Input
                            inputMode="numeric"
                            value={maxRent}
                            onChange={(e) => { setMaxRent(e.target.value.replace(/\D/g, '')); setPage(0); }}
                            placeholder="Max"
                            className="h-9"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={mapPinOnly ? 'default' : 'outline'}
                        className="h-8 gap-1.5"
                        onClick={() => { setMapPinOnly((v) => !v); setPage(0); }}
                      >
                        <MapPin className="h-3.5 w-3.5" /> On the map only
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={verifiedOnly ? 'default' : 'outline'}
                        className="h-8 gap-1.5"
                        onClick={() => { setVerifiedOnly((v) => !v); setPage(0); }}
                      >
                        <ShieldCheck className="h-3.5 w-3.5" /> Verified only
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={nearMe ? 'default' : 'outline'}
                        className="h-8 gap-1.5"
                        disabled={locating}
                        onClick={() => (nearMe ? (setNearMe(null), setPage(0)) : useMyLocation())}
                      >
                        {locating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Navigation className="h-3.5 w-3.5" />}
                        {nearMe ? `Within ${nearMe.radiusKm} km` : 'Near me'}
                      </Button>
                      {nearMe && (
                        <Select
                          value={String(nearMe.radiusKm)}
                          onValueChange={(v) => { setNearMe({ ...nearMe, radiusKm: Number(v) }); setPage(0); }}
                        >
                          <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {[2, 5, 10, 25, 50].map((r) => (
                              <SelectItem key={r} value={String(r)}>{r} km</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {activeFilterCount > 0 && (
                        <Button type="button" size="sm" variant="ghost" className="h-8" onClick={clearFilters}>
                          Clear
                        </Button>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            {filterChips.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Active filters</span>
                {filterChips.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    onClick={chip.onRemove}
                    aria-label={`Remove filter ${chip.label}`}
                    className="inline-flex items-center gap-1 rounded-full border bg-muted/60 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    {chip.label}
                    <X className="h-3 w-3 text-muted-foreground" />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => { setSearch(''); clearFilters(); }}
                  className="ml-1 text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Clear all
                </button>
              </div>
            )}




            {/* Houses */}
            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
              </div>
            ) : houses.length === 0 ? (
              <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                No empty houses available right now.
              </div>
            ) : (
              <div className="space-y-2">
                {houses.map((h) => {
                  const isPicked = Boolean(selected[h.house_id]);
                  const photos = (h.image_urls && h.image_urls.length ? h.image_urls : h.image_url ? [h.image_url] : []).slice(0, 4);
                  return (
                    <div
                      key={h.house_id}
                      className={`w-full rounded-2xl border transition ${isPicked ? 'border-primary bg-primary/5' : 'border-border'}`}
                    >
                      <button type="button" onClick={() => toggle(h)} className="w-full text-left p-3">
                        {photos.length > 0 ? (
                          <div className="mb-2.5 flex gap-1.5 overflow-x-auto">
                            {photos.map((src, i) => (
                              <img
                                key={`${h.house_id}-${i}`}
                                src={src}
                                alt={`${h.title || 'Empty house'} photo ${i + 1}`}
                                loading="lazy"
                                className="h-24 w-32 shrink-0 rounded-xl object-cover bg-muted"
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="mb-2.5 flex h-24 items-center justify-center gap-2 rounded-xl bg-muted text-[11px] text-muted-foreground">
                            <ImageIcon className="h-4 w-4" /> No photo on file
                          </div>
                        )}
                        <div className="flex items-start gap-3">
                          <Checkbox checked={isPicked} className="mt-1 pointer-events-none" />
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold truncate">
                                {h.title || prettyName(h.house_category) || 'Empty house'}
                              </span>
                              {h.verified && (
                                <Badge variant="outline" className="h-5 gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600">
                                  <ShieldCheck className="h-3 w-3" /> Verified
                                </Badge>
                              )}
                              {nearMe && h.distance_km != null && (
                                <Badge variant="outline" className="h-5 gap-1 text-[10px]">
                                  <Navigation className="h-3 w-3" /> {h.distance_km < 1 ? `${Math.round(h.distance_km * 1000)} m` : `${h.distance_km.toFixed(1)} km`}
                                </Badge>
                              )}
                            </div>
                            <p className="flex items-center gap-1 text-[11px] text-muted-foreground truncate">
                              <MapPin className="h-3 w-3 shrink-0" /> {placeOf(h)}
                            </p>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
                              <span className="text-muted-foreground">Rent</span>
                              <span className="font-semibold">{formatUGX(h.monthly_rent)}/mo</span>
                              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-bold text-emerald-600">
                                {isPartner ? 'You earn' : 'Partner earns'} {formatUGX(h.partner_monthly_return)}/month
                              </span>
                              <span className="text-muted-foreground">
                                {formatUGX(h.partner_annual_return)} over 12 months
                              </span>
                            </div>
                            {h.listing_agent_name && (
                              <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                <Users className="h-3 w-3" /> {h.listing_agent_name} places the tenant once funded
                              </p>
                            )}
                            <div className="pt-0.5">
                              <HouseProgressBadges progress={progressByHouse[h.house_id]} />
                            </div>
                          </div>
                        </div>
                      </button>
                      {(h.landlord_name || h.landlord_phone) && (
                        <div className="mx-3 mb-3 rounded-2xl border border-primary/15 bg-primary/5 p-3">
                          <div className="flex flex-col gap-2">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-[10px] font-bold uppercase tracking-wide text-primary/80">Landlord</p>
                              {h.landlord_phone && (
                                <div className="flex flex-wrap justify-end gap-1.5">
                                  <Button asChild variant="outline" size="sm" className="h-8 gap-1 px-2.5 text-[11px]">
                                    <a href={`tel:${h.landlord_phone}`}>
                                      <Phone className="h-3.5 w-3.5" /> Call
                                    </a>
                                  </Button>
                                  <Button asChild variant="secondary" size="sm" className="h-8 gap-1 px-2.5 text-[11px]">
                                    <a href={`sms:${h.landlord_phone}`}>
                                      <MessageSquare className="h-3.5 w-3.5" /> Message
                                    </a>
                                  </Button>
                                </div>
                              )}
                            </div>
                            <div className="min-w-0 space-y-0.5">
                              <p className="text-sm font-bold leading-tight truncate">
                                {h.landlord_name || 'Name not on file'}
                              </p>
                              {h.landlord_phone && (
                                <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                                  <Phone className="h-3.5 w-3.5 shrink-0" /> {h.landlord_phone}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-8 gap-1 text-[11px]"
                          onClick={(e) => { e.stopPropagation(); setDetailHouse(h); }}
                        >
                          <Eye className="h-3 w-3" /> View details
                        </Button>
                        {hasGps(h) && (
                          <Button asChild variant="outline" size="sm" className="h-8 gap-1 text-[11px]">
                            <a href={mapsUrl(h)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                              <Navigation className="h-3 w-3" /> GPS location
                            </a>
                          </Button>
                        )}
                        {hasGps(h) && (
                          <span className="text-[10px] text-muted-foreground">
                            {Number(h.latitude).toFixed(5)}, {Number(h.longitude).toFixed(5)}
                          </span>
                        )}
                      </div>

                    </div>
                  );
                })}

              </div>
            )}

            {pages > 1 && (
              <div className="flex items-center justify-between text-xs">
                <Button variant="outline" size="sm" disabled={page === 0 || isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                  Previous
                </Button>
                <span className="text-muted-foreground">Page {page + 1} of {pages} · {total} empty houses</span>
                <Button variant="outline" size="sm" disabled={page + 1 >= pages || isFetching} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            )}

            {step === 'browse' && picked.length > 0 && (
              <div className="sticky bottom-0 -mx-4 mt-2 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
                <div className="flex items-center gap-3">
                  <div className="relative shrink-0 rounded-xl bg-primary/10 p-2">
                    <ShoppingCart className="h-5 w-5 text-primary" />
                    <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                      {picked.length}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] text-muted-foreground truncate">
                      {picked.length} house{picked.length === 1 ? '' : 's'} in cart · one month of rent
                    </p>
                    <p className="text-sm font-bold">{formatUGX(rentTotal)}</p>
                  </div>
                  <Button className="h-10 gap-1.5 text-xs font-semibold" onClick={() => setStep('checkout')}>
                    Checkout <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
            </>
            )}

            {step === 'checkout' && picked.length > 0 && (
              <div className="rounded-2xl border p-3 space-y-2">
                <p className="text-xs font-bold">Your cart · {picked.length} house{picked.length === 1 ? '' : 's'}</p>
                <div className="space-y-1.5">
                  {picked.map((h) => {
                    const rent = Number(h.monthly_rent || 0);
                    const m = Math.round(rent * 0.15);
                    return (
                      <div key={h.house_id} className="rounded-xl bg-muted/40 px-3 py-2">
                        <div className="flex items-start gap-2">
                          <p className="min-w-0 flex-1 text-[11px] font-semibold truncate">{h.title || housePlace(h)}</p>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 shrink-0 gap-1 px-1.5 text-[10px] text-destructive"
                            onClick={() => toggle(h)}
                          >
                            <X className="h-3 w-3" /> Remove
                          </Button>
                        </div>
                        <div className="mt-1 grid grid-cols-3 gap-2 text-[10px]">
                          <div>
                            <p className="text-muted-foreground">Rent (1 month)</p>
                            <p className="font-semibold">{formatUGX(rent)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">15% monthly</p>
                            <p className="font-semibold text-emerald-600">{formatUGX(m)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">12-month total</p>
                            <p className="font-semibold text-emerald-600">{formatUGX(m * 12)}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between border-t pt-2 text-[11px]">
                  <span className="text-muted-foreground">All houses</span>
                  <span className="font-bold">
                    {formatUGX(monthlyReturn)}/month · {formatUGX(annualReturn)} over 12 months
                  </span>
                </div>
                <Button variant="outline" className="w-full h-9 gap-1.5 text-xs" onClick={() => setStep('browse')}>
                  <ArrowLeft className="h-3.5 w-3.5" /> Add more houses
                </Button>
              </div>
            )}

            {errorMsg && (
              <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-2.5 text-[11px] text-destructive">
                {errorMsg}
              </div>
            )}
          </div>
        )}




      </SheetContent>
    </Sheet>

      <EmptyHouseDetailSheet
        house={detailHouse}
        open={Boolean(detailHouse)}
        onOpenChange={(v) => { if (!v) setDetailHouse(null); }}
        isPicked={detailHouse ? Boolean(selected[detailHouse.house_id]) : false}
        onTogglePick={(h) => toggle(h)}
        isPartner={isPartner}
      />
    </>
  );
}

