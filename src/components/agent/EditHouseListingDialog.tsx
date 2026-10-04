import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { HouseListing, calculateDailyRentalRate } from '@/hooks/useHouseListings';
import { formatUGX } from '@/lib/rentCalculations';
import { Loader2, X, AlertTriangle, Check, User, UserPlus } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { HouseImageUploader, uploadHouseImages, type HouseImageFile } from './HouseImageUploader';

import { FieldError } from '@/components/shared/FormFeedback';
import { LandlordSearchSelect, type LandlordOption } from './LandlordSearchSelect';
import { toUgandaLocalDigits, normalizeUgandaPhone, isValidUgandanPhoneNumber } from '@/lib/phoneUtils';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import { resolveUgVillage, type UgLocationSelection } from '@/hooks/useUgLocations';
import { normalizeDistrict, UGANDA_REGION_GROUPS } from '@/lib/ugandaDistricts';
import { supabase as sb } from '@/integrations/supabase/client';

/** District → backend region, mirroring ListEmptyHouseDialog. */
const DISTRICT_TO_BACKEND_REGION: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const g of UGANDA_REGION_GROUPS) {
    for (const d of g.districts) m[d.name] = d.backendRegion;
  }
  return m;
})();

interface EditHouseListingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listing: HouseListing | null;
  onSaved?: () => void;
}

const MAX_PHOTOS = 5;

export function EditHouseListingDialog({ open, onOpenChange, listing, onSaved }: EditHouseListingDialogProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [title, setTitle] = useState('');
  const [address, setAddress] = useState('');
  const [monthlyRent, setMonthlyRent] = useState<number>(0);
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  // Official Uganda administrative location (shared picker / shared ug_* dataset).
  const [ugLoc, setUgLoc] = useState<UgLocationSelection | null>(null);
  const [locLoading, setLocLoading] = useState(false);
  const [locError, setLocError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  // Photos already stored on the listing (kept unless the agent removes them).
  const [existingUrls, setExistingUrls] = useState<string[]>([]);
  // Newly captured/selected photos pending upload.
  const [newImages, setNewImages] = useState<HouseImageFile[]>([]);

  // Landlord attachment (search existing or register new). Mirrors the
  // ListEmptyHouseDialog flow so the same debounced trigram search + duplicate
  // guard + auto-create fallback is used when the agent edits a listing.
  const [selectedLandlord, setSelectedLandlord] = useState<LandlordOption | null>(null);
  const [manualLandlord, setManualLandlord] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  const [loadingLandlord, setLoadingLandlord] = useState(false);

  useEffect(() => {
    if (listing) {
      setTitle(listing.title);
      setAddress(listing.address);
      setMonthlyRent(listing.monthly_rent);
      setDescription(listing.description ?? '');
      setExistingUrls(Array.isArray(listing.image_urls) ? listing.image_urls.filter(Boolean) : []);
      setNewImages([]);
      setAttempted(false);
      setLocError(null);
      setUgLoc(null);
      void prefillLocation(listing);
      // Reset landlord state, then hydrate from the currently linked landlord.
      setSelectedLandlord(null);
      setManualLandlord(false);
      setManualName('');
      setManualPhone('');
      if (listing.landlord_id) {
        setLoadingLandlord(true);
        supabase
          .from('landlords_directory')
          .select('id, name, phone, property_address, district, town_council, county, village, verified')
          .eq('id', listing.landlord_id)
          .maybeSingle()
          .then(({ data }) => {
            if (data) setSelectedLandlord(data as LandlordOption);
          })
          .then(undefined, () => {})
          // supabase's PostgrestBuilder doesn't chain .finally in all versions
          .then(() => setLoadingLandlord(false));
      }
    }
  }, [listing]);

  /**
   * Pre-fill the picker: stored village id first (one RPC), otherwise resolve
   * from the stored names. On failure we leave the picker empty and surface a
   * note — stored values are never wiped, the agent simply re-picks.
   */
  async function prefillLocation(l: HouseListing) {
    const villageId = (l as any).ug_village_id as number | null | undefined;
    setLocLoading(true);
    try {
      if (villageId) {
        const sel = await resolveUgVillage(villageId);
        if (sel) { setUgLoc(sel); return; }
      }
      const villageName = (l.village || '').trim();
      if (villageName) {
        const { data, error } = await sb.rpc('ug_search_villages' as any, {
          p_query: villageName,
          p_limit: 10,
          p_district_id: null,
          p_district_name: l.district ? (normalizeDistrict(l.district) || l.district) : null,
        });
        if (error) throw error;
        const rows = (data ?? []) as any[];
        const exact = rows.find((r) => String(r.village_name).toLowerCase() === villageName.toLowerCase()) ?? null;
        if (exact) {
          const sel = await resolveUgVillage(exact.village_id);
          if (sel) { setUgLoc(sel); return; }
        }
      }
      setLocError('We could not match the saved location to the official dataset — please select it below.');
    } catch {
      setLocError('Could not load the official location list. Select the village again below.');
    } finally {
      setLocLoading(false);
    }
  }

  if (!listing) return null;

  const calc = monthlyRent > 0 ? calculateDailyRentalRate(monthlyRent) : null;
  const totalPhotos = existingUrls.length + newImages.length;
  const remainingSlots = Math.max(0, MAX_PHOTOS - existingUrls.length);
  const manualPhoneError = manualLandlord
    ? (manualPhone.trim() ? (isValidUgandanPhoneNumber(manualPhone).valid ? null : 'Enter a valid Ugandan phone number (e.g. 0771234567)') : 'Phone number is required')
    : null;
  const manualLandlordReady =
    manualLandlord && manualName.trim().length >= 2 && !manualPhoneError;
  const hasLandlord = !!selectedLandlord?.id || manualLandlordReady;
  const canSave = hasLandlord && !!ugLoc;
  const storedLocationLabel = [listing.village, listing.sub_county, listing.district, listing.region]
    .filter(Boolean).join(', ');
  const regionForPhotos = ugLoc
    ? (ugLoc.region || DISTRICT_TO_BACKEND_REGION[ugLoc.district] || listing.region)
    : listing.region;

  const handleSave = async () => {
    setAttempted(true);
    if (!title.trim() || !address.trim() || monthlyRent <= 0) {
      toast({ title: 'Missing info', description: 'Title, address and rent are required.', variant: 'destructive' });
      return;
    }
    if (!ugLoc) {
      toast({ title: 'Location required', description: 'Select the official village where the house is located.', variant: 'destructive' });
      return;
    }
    const listingRegion = ugLoc.region || DISTRICT_TO_BACKEND_REGION[ugLoc.district] || listing.region;
    setSaving(true);
    try {
      // Resolve landlord first — we never want to save a listing without one.
      let landlordId: string | null = selectedLandlord?.id ?? null;
      let landlordName: string | null = selectedLandlord?.name ?? null;
      let landlordPhone: string | null = selectedLandlord?.phone ?? null;

      if (!landlordId && manualLandlord) {
        const canonicalPhone = toUgandaLocalDigits(manualPhone);
        const cleanName = manualName.trim();
        // Duplicate guard — reuse existing landlord if name+phone already exists.
        const { data: matches } = await supabase.rpc('find_landlord_duplicate', {
          p_name: cleanName,
          p_phone: canonicalPhone,
        });
        const dup = Array.isArray(matches) && matches.length > 0 ? matches[0] : null;
        if (dup?.id) {
          landlordId = dup.id;
          landlordName = (dup as any).name ?? cleanName;
          landlordPhone = (dup as any).phone ?? canonicalPhone;
          toast({
            title: `Linked to existing landlord "${landlordName}"`,
            description: 'A landlord with these details already existed — reused to avoid a duplicate.',
          });
        } else {
          const { data: newLandlord, error: llErr } = await supabase
            .from('landlords')
            .insert({
              name: cleanName,
              phone: canonicalPhone,
              property_address: address.trim() || null,
              region: listingRegion || null,
              district: ugLoc.district,
              village: ugLoc.village,
              registered_by: user?.id ?? null,
              managed_by_agent_id: user?.id ?? null,
            })
            .select('id')
            .single();
          if (llErr || !newLandlord?.id) {
            throw new Error(llErr?.message ? `Could not save the landlord: ${llErr.message}` : 'Could not save the landlord.');
          }
          landlordId = newLandlord.id;
          landlordName = cleanName;
          landlordPhone = canonicalPhone;
        }
      }

      if (!landlordId) {
        throw new Error('Attach a landlord (search an existing one or register a new one) before saving.');
      }

      // Upload any newly added photos and merge with the ones the agent kept.
      let imageUrls = [...existingUrls];
      if (newImages.length && user?.id) {
        const uploaded = await uploadHouseImages(
          user.id,
          listing.id,
          newImages.map(i => i.file),
          newImages.map(i => i.thumbnailFile),
        );
        imageUrls = [...imageUrls, ...uploaded];
      }
      const updates: any = {
        title: title.trim(),
        address: address.trim(),
        region: listingRegion,
        district: ugLoc.district,
        sub_county: ugLoc.subcounty,
        village: ugLoc.village,
        ug_village_id: ugLoc.villageId,
        description: description.trim() || null,
        monthly_rent: monthlyRent,
        image_urls: imageUrls,
        landlord_id: landlordId,
        landlord_name: landlordName,
        landlord_phone: landlordPhone ? normalizeUgandaPhone(landlordPhone) : null,
      };
      if (calc) {
        updates.access_fee = calc.accessFee;
        updates.platform_fee = calc.platformFee;
        updates.total_monthly_cost = calc.totalMonthlyCost;
        updates.daily_rate = calc.dailyRate;
      }
      const { error } = await supabase.from('house_listings').update(updates).eq('id', listing.id);
      if (error) throw error;
      toast({ title: 'Listing updated' });
      onSaved?.();
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: 'Update failed', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit listing</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="edit-title">Title</Label>
            <Input id="edit-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-address">Street / plot / house detail</Label>
            <Input
              id="edit-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="e.g. Plot 14, Kisaasi–Kyanja Road, house behind the mosque"
            />
            {attempted && !address.trim() ? <FieldError message="Street / plot detail is required" /> : null}
          </div>

          {/* Official Uganda administrative location — shared picker + shared dataset. */}
          <div className="space-y-1">
            {locLoading ? (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Matching the saved location to the official list…
              </div>
            ) : (
              <>
                <UgLocationPicker
                  label="Official location (village)"
                  value={ugLoc}
                  onChange={(sel) => { setUgLoc(sel); if (sel) setLocError(null); }}
                  required
                  error={attempted && !ugLoc ? 'Select the official village where the house is located' : null}
                />
                {!ugLoc && locError ? (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">{locError}</p>
                ) : null}
                {!ugLoc && storedLocationLabel ? (
                  <p className="text-[11px] text-muted-foreground">
                    Currently saved: {storedLocationLabel} — kept until you pick an official village.
                  </p>
                ) : null}
              </>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-rent">Monthly rent (UGX)</Label>
            <Input
              id="edit-rent"
              type="number"
              inputMode="numeric"
              min={0}
              value={monthlyRent || ''}
              onChange={(e) => setMonthlyRent(Number(e.target.value) || 0)}
            />
            {calc && (
              <p className="text-[11px] text-muted-foreground">
                Daily rate updates to <span className="font-semibold text-success">{formatUGX(calc.dailyRate)}/day</span>
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-desc">Description (optional)</Label>
            <Textarea id="edit-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </div>

          {/* Attach / change landlord — debounced trigram search, or register a new one. */}
          <div className="space-y-2 pt-1 border-t border-border pt-3">
            <div className="flex items-center justify-between gap-2">
              <Label className="flex items-center gap-1.5 text-sm">
                <User className="h-3.5 w-3.5" /> Landlord
              </Label>
              {selectedLandlord?.id && (
                <button
                  type="button"
                  onClick={() => { setSelectedLandlord(null); setManualLandlord(false); }}
                  className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Change
                </button>
              )}
            </div>

            {selectedLandlord?.id ? (
              <div className="flex items-start gap-2 p-2 rounded-lg border border-border bg-muted/40">
                <Check className="h-4 w-4 text-success shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{selectedLandlord.name}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {selectedLandlord.phone}
                    {selectedLandlord.verified ? ' · Verified' : ''}
                  </p>
                </div>
              </div>
            ) : loadingLandlord ? (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading current landlord…
              </div>
            ) : manualLandlord ? (
              <div className="space-y-2 p-2 rounded-lg border border-dashed border-border">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-muted-foreground">Register a new landlord</p>
                  <button
                    type="button"
                    onClick={() => { setManualLandlord(false); setManualName(''); setManualPhone(''); }}
                    className="text-[11px] text-muted-foreground underline underline-offset-2"
                  >
                    Search instead
                  </button>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="edit-ll-name" className="text-xs">Full name</Label>
                  <Input id="edit-ll-name" value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="Landlord name" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="edit-ll-phone" className="text-xs">Phone (Ugandan)</Label>
                  <Input
                    id="edit-ll-phone"
                    value={manualPhone}
                    onChange={(e) => setManualPhone(e.target.value)}
                    placeholder="0771234567"
                    inputMode="tel"
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                  {manualPhoneError && manualPhone.trim() ? <FieldError message={manualPhoneError} /> : null}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <LandlordSearchSelect
                  value={selectedLandlord}
                  onChange={setSelectedLandlord}
                  inline
                  onAddNew={() => setManualLandlord(true)}
                />
                <button
                  type="button"
                  onClick={() => setManualLandlord(true)}
                  className="inline-flex items-center gap-1 text-[11px] text-primary underline underline-offset-2"
                >
                  <UserPlus className="h-3 w-3" /> Register new landlord
                </button>
              </div>
            )}
          </div>

          {/* Photos: existing (removable) + add new */}
          <div className="space-y-2 pt-1">
            <Label className="text-xs">Photos ({totalPhotos}/{MAX_PHOTOS})</Label>
            {existingUrls.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {existingUrls.map((url) => (
                  <div key={url} className="relative shrink-0 w-20 h-20 rounded-lg overflow-hidden border border-border">
                    <img src={url} alt="" className="w-full h-full object-cover" loading="lazy" />
                    <button
                      type="button"
                      onClick={() => setExistingUrls((prev) => prev.filter((u) => u !== url))}
                      className="absolute top-0.5 right-0.5 bg-destructive text-destructive-foreground rounded-full p-0.5"
                      aria-label="Remove photo"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <HouseImageUploader
              images={newImages}
              onChange={setNewImages}
              maxImages={remainingSlots}
              region={regionForPhotos}
              district={ugLoc?.district ?? listing.district ?? undefined}
              village={ugLoc?.village ?? listing.village ?? undefined}
            />
            {totalPhotos === 0 && (
              <div className="flex items-center gap-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                <p className="text-[10px] text-amber-700 dark:text-amber-400">
                  Houses without a real photo are hidden from tenants. Add at least one photo so this listing appears.
                </p>
              </div>
            )}
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !canSave} className="gap-2">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}