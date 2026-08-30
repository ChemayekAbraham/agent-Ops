import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Home, Loader2, Search, Check, Share2, ShieldCheck, MapPin, Users, Phone, Navigation, ImageIcon, Eye } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import { EmptyHouseDetailSheet, type HouseOpportunity } from '@/components/agent/EmptyHouseDetailSheet';


const PAGE_SIZE = 20;

const placeOf = (h: HouseOpportunity) =>
  [h.village, h.sub_county, h.district].filter(Boolean).join(', ') || h.region || 'Location on file';

const hasGps = (h: HouseOpportunity) =>
  typeof h.latitude === 'number' && typeof h.longitude === 'number' && (h.latitude !== 0 || h.longitude !== 0);

const mapsUrl = (h: HouseOpportunity) => `https://www.google.com/maps/search/?api=1&query=${h.latitude},${h.longitude}`;

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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode?: 'agent' | 'partner';
  selfName?: string | null;
  selfPhone?: string | null;
  selfEmail?: string | null;
}) {
  const isPartner = mode === 'partner';

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Record<string, HouseOpportunity>>({});

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


  const partnerName = isPartner ? (selfName || '').trim() : joinPersonName(nameParts);

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setPage(0); }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const reset = () => {
    setSearch(''); setDebounced(''); setPage(0); setSelected({});
    setNameParts({ firstName: '', otherNames: '', lastName: '' });
    setWhatsappNumber(''); setPhoneNumber(''); setEmail('');
    setContributionType('compounding'); setDeductionDay('1');
    setErrorMsg(null); setCreatedNote(null);
  };

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['empty-house-opportunities', debounced, page],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_list_empty_house_opportunities', {
        p_search: debounced || null,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      const payload = (data ?? {}) as { total?: number; houses?: HouseOpportunity[] };
      return { total: Number(payload.total || 0), houses: payload.houses ?? [] };
    },
  });

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
      const payload: Record<string, string | number | null> = {
        partner_name: (isPartner ? (selfName || '') : partnerName).trim(),
        whatsapp_number: (isPartner ? (selfPhone || '') : whatsappNumber).trim(),
        phone_number: (isPartner ? (selfPhone || '') : phoneNumber).trim() || null,
        email: (isPartner ? (selfEmail || '') : email).trim() || null,
        amount: rentTotal,
        contribution_type: contributionType === 'monthly' ? 'monthly' : 'once_off',
      };

      if (contributionType === 'monthly') {
        payload.deduction_day = String(Number(deductionDay));
        const now = new Date();
        const next = new Date(now.getFullYear(), now.getMonth(), Number(deductionDay));
        if (next <= now) next.setMonth(next.getMonth() + 1);
        payload.next_deduction_date = next.toISOString().split('T')[0];
      }

      const { data, error } = await supabase.rpc('agent_create_promissory_note_for_houses', {
        p_payload: payload,
        p_house_ids: picked.map((h) => h.house_id),
      });
      if (error) throw error;
      const result = (data ?? {}) as { note?: { id: string; activation_token?: string } };
      if (!result.note) throw new Error('Note was not created');
      setCreatedNote(result.note);
      void supabase.functions
        .invoke('notify-promissory-note-pledge', { body: { note_id: result.note.id } })
        .catch(() => {});
      toast.success(`Note created for ${picked.length} empty house${picked.length === 1 ? '' : 's'}`);
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
        <div className="sticky top-0 z-20 bg-background border-b px-4 py-3">
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
        </div>

        {createdNote ? (
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
            </div>


            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by district, village or house name"
                className="pl-9 h-10"
              />
            </div>

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
                                {h.title || h.house_category || 'Empty house'}
                              </span>
                              {h.verified && (
                                <Badge variant="outline" className="h-5 gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600">
                                  <ShieldCheck className="h-3 w-3" /> Verified
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
                            {h.landlord_name && (
                              <p className="text-[11px]">
                                <span className="text-muted-foreground">Landlord</span>{' '}
                                <span className="font-medium">{h.landlord_name}</span>
                              </p>
                            )}
                            {h.listing_agent_name && (
                              <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                <Users className="h-3 w-3" /> {h.listing_agent_name} places the tenant once funded
                              </p>
                            )}
                          </div>
                        </div>
                      </button>
                      <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-8 gap-1 text-[11px]"
                          onClick={(e) => { e.stopPropagation(); setDetailHouse(h); }}
                        >
                          <Eye className="h-3 w-3" /> View details
                        </Button>
                        {h.landlord_phone && (
                          <Button asChild variant="outline" size="sm" className="h-8 gap-1 text-[11px]">
                            <a href={`tel:${h.landlord_phone}`} onClick={(e) => e.stopPropagation()}>
                              <Phone className="h-3 w-3" /> {h.landlord_phone}
                            </a>
                          </Button>
                        )}
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

            {errorMsg && (
              <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-2.5 text-[11px] text-destructive">
                {errorMsg}
              </div>
            )}
          </div>
        )}

        {/* Sticky summary */}
        {!createdNote && (
          <div className="sticky bottom-0 z-20 border-t bg-background/95 backdrop-blur px-4 py-3 space-y-2">
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
            <Button className="w-full h-11 gap-2 font-semibold" onClick={handleSubmit} disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {submitting ? 'Creating…' : 'Create note for these houses'}
            </Button>
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

