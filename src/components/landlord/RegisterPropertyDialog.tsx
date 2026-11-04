import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ArrowLeft,
  ArrowRight,
  Banknote,
  Building2,
  CheckCircle2,
  Circle,
  Copy,
  Droplets,
  Home,
  Loader2,
  MapPin,
  Navigation,
  Shield,
  TrendingUp,
  User,
  UserPlus,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import { ugLocationLabel, type UgLocationSelection } from '@/hooks/useUgLocations';

interface RegisterPropertyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type PropertyStatus = 'occupied' | 'empty';
type Step = 1 | 2 | 3;

/** Everything the landlord has typed. Kept in the browser so closing the dialog never loses it. */
interface Draft {
  step: Step;
  address: string;
  ugLoc: UgLocationSelection | null;
  monthlyRent: string;
  houses: string;
  payoutDay: string;
  status: PropertyStatus;
  tenantName: string;
  tenantPhone: string;
  electricity: string;
  water: string;
  caretakerName: string;
  caretakerPhone: string;
  lat: number | null;
  lng: number | null;
  lc1Name: string;
  lc1Phone: string;
}

const EMPTY_DRAFT: Draft = {
  step: 1,
  address: '',
  ugLoc: null,
  monthlyRent: '',
  houses: '',
  payoutDay: '',
  status: 'empty',
  tenantName: '',
  tenantPhone: '',
  electricity: '',
  water: '',
  caretakerName: '',
  caretakerPhone: '',
  lat: null,
  lng: null,
  lc1Name: '',
  lc1Phone: '',
};

const PLATFORM_FEE_RATE = 0.1;

const digits = (v: string) => v.replace(/\D/g, '');
const phoneOk = (v: string) => digits(v).length >= 9;
const ordinal = (d: number) => `${d}${d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th'}`;

/** What the server function answers when it declines (it never half-saves). */
const SERVER_ERRORS: Record<string, string> = {
  address_required: 'Please enter the property address.',
  location_required: 'Pick the official location (region → village) from the list.',
  rent_invalid: 'Enter a monthly rent between UGX 1 and UGX 100,000,000.',
  houses_invalid: 'Number of houses must be 1 or more.',
  payout_day_invalid: 'Choose a payout day between the 1st and the 28th.',
  tenant_phone_required: "Enter the tenant's phone number.",
  proof_required: 'Add at least one way for us to verify the property (meter, GPS pin or a contact).',
  profile_missing: 'We could not load your profile.',
  profile_phone_required: 'Add your phone number to your profile first, then register.',
  already_registered: 'You have already registered this property.',
  too_many_registrations: 'You have registered several properties today. Please try again tomorrow.',
};

const draftKey = (userId: string) => `register-property-draft:${userId}`;

function loadDraft(userId: string): Draft {
  try {
    const raw = localStorage.getItem(draftKey(userId));
    if (!raw) return EMPTY_DRAFT;
    return { ...EMPTY_DRAFT, ...(JSON.parse(raw) as Partial<Draft>) };
  } catch {
    return EMPTY_DRAFT;
  }
}

function saveDraft(userId: string, draft: Draft) {
  try {
    localStorage.setItem(draftKey(userId), JSON.stringify(draft));
  } catch {
    // Private mode or storage blocked: the form still works, it just cannot be restored.
  }
}

function clearDraft(userId: string) {
  try {
    localStorage.removeItem(draftKey(userId));
  } catch {
    // Nothing to clear.
  }
}

const STEP_TITLES: Record<Step, string> = {
  1: 'Your property',
  2: 'Who lives there',
  3: 'Get verified',
};

export default function RegisterPropertyDialog({
  open,
  onOpenChange,
  onSuccess,
}: RegisterPropertyDialogProps) {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [restoredFor, setRestoredFor] = useState<string | null>(null);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [capturingLocation, setCapturingLocation] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsPhone, setNeedsPhone] = useState(false);
  const [reference, setReference] = useState<string | null>(null);
  const [tenantLinked, setTenantLinked] = useState(false);

  const patch = (p: Partial<Draft>) => {
    setError(null);
    setDraft((d) => ({ ...d, ...p }));
  };

  // Restore this landlord's unfinished form when the dialog opens.
  useEffect(() => {
    if (open && user && restoredFor !== user.id) {
      setDraft(loadDraft(user.id));
      setRestoredFor(user.id);
    }
  }, [open, user, restoredFor]);

  // Keep the draft up to date while the form is being filled in.
  useEffect(() => {
    if (user && restoredFor === user.id && !reference) saveDraft(user.id, draft);
  }, [draft, user, restoredFor, reference]);

  const rent = parseInt(draft.monthlyRent, 10) || 0;
  const platformFee = Math.round(rent * PLATFORM_FEE_RATE);
  const youReceive = rent - platformFee;

  const proofs = useMemo(
    () => ({
      meter: !!(draft.electricity.trim() || draft.water.trim()),
      gps: draft.lat !== null && draft.lng !== null,
      caretaker: phoneOk(draft.caretakerPhone),
      lc1: phoneOk(draft.lc1Phone) && !!draft.lc1Name.trim(),
    }),
    [draft],
  );
  const proofCount = Object.values(proofs).filter(Boolean).length;

  const captureLocation = () => {
    if (!navigator.geolocation) {
      toast.error('This device cannot share its location.');
      return;
    }
    setCapturingLocation(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        patch({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setCapturingLocation(false);
        toast.success('Property location captured');
      },
      () => {
        setCapturingLocation(false);
        toast.error('Could not get your location. Please allow location access and try again.');
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  /** Returns a message when the current step is not ready to leave, otherwise null. */
  const validateStep = (step: Step): string | null => {
    if (step === 1) {
      if (draft.address.trim().length < 3) return 'Please enter the property address.';
      if (!draft.ugLoc) return 'Pick the official location (region → village) from the list.';
      if (rent <= 0) return 'Enter the total monthly rent for this property.';
    }
    if (step === 2 && draft.status === 'occupied' && !phoneOk(draft.tenantPhone)) {
      return "Enter the tenant's phone number (at least 9 digits).";
    }
    if (step === 3) {
      if (proofCount === 0) return 'Add at least one way for us to verify the property.';
      if (draft.caretakerPhone.trim() && !proofs.caretaker) return 'The caretaker phone number looks too short.';
      if (draft.lc1Phone.trim() && !phoneOk(draft.lc1Phone)) return 'The LC1 phone number looks too short.';
      if (!acceptedTerms) return 'Please accept the Welile Guaranteed Rent terms.';
    }
    return null;
  };

  const goNext = () => {
    const problem = validateStep(draft.step);
    if (problem) {
      setError(problem);
      return;
    }
    patch({ step: (draft.step + 1) as Step });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || loading) return;
    // Re-check every step so a restored draft cannot skip a requirement.
    for (const s of [1, 2, 3] as Step[]) {
      const problem = validateStep(s);
      if (problem) {
        setError(problem);
        setDraft((d) => ({ ...d, step: s }));
        return;
      }
    }
    if (!draft.ugLoc) return;

    setLoading(true);
    setError(null);
    try {
      // The function is newer than the generated database types, so call it through a narrow cast.
      const rpc = supabase as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: Error | null }>;
      };
      const { data, error: rpcError } = await rpc.rpc('register_landlord_property', {
        p_property_address: draft.address,
        p_ug_village_id: draft.ugLoc.villageId,
        p_region: draft.ugLoc.region,
        p_district: draft.ugLoc.district,
        p_county: draft.ugLoc.county,
        p_subcounty: draft.ugLoc.subcounty,
        p_village: draft.ugLoc.village,
        p_monthly_rent: rent,
        p_number_of_houses: draft.houses ? parseInt(draft.houses, 10) : null,
        p_payout_day: draft.payoutDay ? parseInt(draft.payoutDay, 10) : null,
        p_electricity_meter: draft.electricity,
        p_water_meter: draft.water,
        p_caretaker_name: draft.caretakerName,
        p_caretaker_phone: draft.caretakerPhone,
        p_latitude: draft.lat,
        p_longitude: draft.lng,
        p_property_status: draft.status,
        p_tenant_name: draft.status === 'occupied' ? draft.tenantName : null,
        p_tenant_phone: draft.status === 'occupied' ? draft.tenantPhone : null,
        p_lc1_name: draft.lc1Name,
        p_lc1_phone: draft.lc1Phone,
      });
      if (rpcError) throw rpcError;

      const result = (data ?? {}) as { ok?: boolean; error?: string; reference?: string; tenant_linked?: boolean };
      if (!result.ok) {
        const code = result.error ?? '';
        setNeedsPhone(code === 'profile_phone_required');
        setError(SERVER_ERRORS[code] ?? 'We could not register the property. Please try again.');
        return;
      }

      clearDraft(user.id);
      setReference(result.reference ?? null);
      setTenantLinked(!!result.tenant_linked);
      toast.success('Property registered');
      onSuccess?.();
    } catch (err) {
      console.error('register_landlord_property failed:', err);
      setError('Something went wrong and nothing was saved. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const startOver = () => {
    if (user) clearDraft(user.id);
    setDraft(EMPTY_DRAFT);
    setAcceptedTerms(false);
    setError(null);
    setNeedsPhone(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && reference) {
      // Finished: leave a clean form behind for the next property.
      setReference(null);
      setDraft(EMPTY_DRAFT);
      setAcceptedTerms(false);
      setNeedsPhone(false);
    }
    onOpenChange(next);
  };

  const copyReference = async () => {
    if (!reference) return;
    try {
      await navigator.clipboard.writeText(reference);
      toast.success('Reference copied');
    } catch {
      toast.error('Could not copy. Please note it down.');
    }
  };

  const hasDraftContent = !!(draft.address || draft.monthlyRent || draft.ugLoc);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto ios-fixed-scroll" stable>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            Register Property
          </DialogTitle>
          <DialogDescription>
            {reference ? 'Your property has been submitted' : 'Register your property for Welile Guaranteed Monthly Rent'}
          </DialogDescription>
        </DialogHeader>

        {reference ? (
          <div className="py-4 text-center space-y-4">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success/20">
              <CheckCircle2 className="h-8 w-8 text-success" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">Property submitted</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                A manager will verify it. Keep this reference to ask about your property.
              </p>
            </div>
            <button
              type="button"
              onClick={copyReference}
              className="mx-auto flex items-center gap-2 rounded-xl border border-border bg-muted/50 px-4 py-2 font-mono text-lg font-bold tracking-widest"
              aria-label={`Copy reference ${reference}`}
            >
              {reference}
              <Copy className="h-4 w-4 text-muted-foreground" />
            </button>
            <ol className="mx-auto max-w-xs space-y-2 text-left text-sm">
              <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-success" /> Registered</li>
              <li className="flex items-center gap-2"><Circle className="h-4 w-4 text-primary" /> Under review by a manager <span className="text-xs text-muted-foreground">(about 5 days on average)</span></li>
              <li className="flex items-center gap-2 text-muted-foreground"><Circle className="h-4 w-4" /> Verified: 12-month Guaranteed Monthly Rent starts</li>
              <li className="flex items-center gap-2 text-muted-foreground"><Circle className="h-4 w-4" /> Rent paid to your Welile Wallet{draft.payoutDay ? ` on the ${ordinal(parseInt(draft.payoutDay, 10))}` : ''}</li>
            </ol>
            {draft.status === 'occupied' && (
              <p className="text-xs text-muted-foreground">
                {tenantLinked
                  ? 'Your tenant already has a Welile account and has been linked to this property.'
                  : 'Your tenant does not have a Welile account yet. Their details are saved with the property.'}
              </p>
            )}
            <Button onClick={() => handleOpenChange(false)}>Done</Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            {/* Progress */}
            <div aria-label={`Step ${draft.step} of 3: ${STEP_TITLES[draft.step]}`} className="space-y-2">
              <div className="flex gap-1.5">
                {([1, 2, 3] as Step[]).map((s) => (
                  <div
                    key={s}
                    className={cn('h-1.5 flex-1 rounded-full transition-colors', s <= draft.step ? 'bg-primary' : 'bg-muted')}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">
                  <span className="text-muted-foreground">Step {draft.step} of 3 · </span>
                  {STEP_TITLES[draft.step]}
                </p>
                {hasDraftContent && (
                  <button type="button" onClick={startOver} className="text-xs text-muted-foreground underline">
                    Start over
                  </button>
                )}
              </div>
            </div>

            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={draft.step}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.15 }}
                className="space-y-4"
              >
                {draft.step === 1 && (
                  <>
                    <div className="space-y-1">
                      <Label htmlFor="rp-address" className="flex items-center gap-1 text-xs">
                        <MapPin className="h-3 w-3" /> Property address or landmark *
                      </Label>
                      <Input
                        id="rp-address"
                        value={draft.address}
                        onChange={(e) => patch({ address: e.target.value })}
                        placeholder="e.g. Kira Road, Block 5"
                        className="h-10"
                        autoComplete="street-address"
                      />
                    </div>

                    <UgLocationPicker
                      value={draft.ugLoc}
                      onChange={(sel) => patch({ ugLoc: sel })}
                      label="Official location (region → village)"
                      required
                    />

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="rp-rent" className="flex items-center gap-1 text-xs">
                          <Banknote className="h-3 w-3" /> Total monthly rent (UGX) *
                        </Label>
                        <Input
                          id="rp-rent"
                          inputMode="numeric"
                          value={draft.monthlyRent}
                          onChange={(e) => patch({ monthlyRent: digits(e.target.value) })}
                          placeholder="500000"
                          className="h-10"
                        />
                        <p className="text-[10px] text-muted-foreground">For the whole property, all houses together</p>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="rp-houses" className="text-xs">Number of houses</Label>
                        <Input
                          id="rp-houses"
                          inputMode="numeric"
                          value={draft.houses}
                          onChange={(e) => patch({ houses: digits(e.target.value).slice(0, 4) })}
                          placeholder="e.g. 5"
                          className="h-10"
                        />
                      </div>
                    </div>

                    {rent > 0 && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="space-y-2 rounded-xl border border-border/50 bg-muted/50 p-3"
                      >
                        <p className="flex items-center gap-1.5 text-xs font-semibold">
                          <TrendingUp className="h-3.5 w-3.5 text-success" /> What you receive
                        </p>
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          <div>
                            <p className="text-muted-foreground">Monthly rent</p>
                            <p className="font-medium">{formatUGX(rent)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">10% Welile fee</p>
                            <p className="font-medium text-primary">{formatUGX(platformFee)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">You receive</p>
                            <p className="font-semibold text-success">{formatUGX(youReceive)}</p>
                          </div>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          Over 12 months: <span className="font-semibold text-foreground">{formatUGX(youReceive * 12)}</span>
                        </p>
                      </motion.div>
                    )}

                    <div className="space-y-1">
                      <Label htmlFor="rp-payout-date" className="text-xs">Preferred payout day (optional)</Label>
                      <Select value={draft.payoutDay} onValueChange={(v) => patch({ payoutDay: v })}>
                        <SelectTrigger id="rp-payout-date" className="h-10">
                          <SelectValue placeholder="Choose a day of the month" />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
                            <SelectItem key={day} value={String(day)}>
                              {ordinal(day)} of every month
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}

                {draft.step === 2 && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      {(['occupied', 'empty'] as PropertyStatus[]).map((s) => (
                        <button
                          key={s}
                          type="button"
                          aria-pressed={draft.status === s}
                          onClick={() => patch({ status: s })}
                          className={cn(
                            'rounded-xl border-2 p-3 text-left transition-all',
                            draft.status === s ? 'border-primary bg-primary/5' : 'border-border hover:border-border/80',
                          )}
                        >
                          {s === 'occupied' ? (
                            <UserPlus className={cn('mb-1 h-5 w-5', draft.status === s ? 'text-primary' : 'text-muted-foreground')} />
                          ) : (
                            <Home className={cn('mb-1 h-5 w-5', draft.status === s ? 'text-primary' : 'text-muted-foreground')} />
                          )}
                          <p className="text-sm font-medium">{s === 'occupied' ? 'It has a tenant' : 'It is empty'}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {s === 'occupied' ? "I'll add their phone number" : 'Welile finds a tenant'}
                          </p>
                        </button>
                      ))}
                    </div>

                    {draft.status === 'occupied' && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="grid grid-cols-2 gap-3"
                      >
                        <div className="space-y-1">
                          <Label htmlFor="rp-tenant-phone" className="text-xs">Tenant phone *</Label>
                          <Input
                            id="rp-tenant-phone"
                            type="tel"
                            inputMode="tel"
                            value={draft.tenantPhone}
                            onChange={(e) => patch({ tenantPhone: e.target.value })}
                            placeholder="0783..."
                            className="h-10"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="rp-tenant-name" className="text-xs">Tenant name (optional)</Label>
                          <Input
                            id="rp-tenant-name"
                            value={draft.tenantName}
                            onChange={(e) => patch({ tenantName: e.target.value })}
                            placeholder="Full name"
                            className="h-10"
                          />
                        </div>
                        <p className="col-span-2 text-[11px] text-muted-foreground">
                          If your tenant already has a Welile account we link them automatically.
                        </p>
                      </motion.div>
                    )}
                  </>
                )}

                {draft.step === 3 && (
                  <>
                    <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
                      <p className="flex items-center gap-1.5 text-sm font-semibold">
                        <Shield className="h-4 w-4 text-primary" /> Add at least one way to verify
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        A manager checks one of these. {proofCount > 0 ? `${proofCount} added.` : 'None added yet.'}
                      </p>
                    </div>

                    <div className="space-y-2 rounded-xl border border-border/50 p-3">
                      <p className="flex items-center gap-1.5 text-xs font-semibold">
                        {proofs.meter ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <Circle className="h-3.5 w-3.5 text-muted-foreground" />}
                        Meter number
                      </p>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label htmlFor="rp-uedcl" className="flex items-center gap-1 text-xs">
                            <Zap className="h-3 w-3 text-amber-500" /> UEDCL (electricity)
                          </Label>
                          <Input
                            id="rp-uedcl"
                            value={draft.electricity}
                            onChange={(e) => patch({ electricity: e.target.value })}
                            placeholder="Meter number"
                            className="h-10"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="rp-nwsc" className="flex items-center gap-1 text-xs">
                            <Droplets className="h-3 w-3 text-blue-500" /> NWSC (water)
                          </Label>
                          <Input
                            id="rp-nwsc"
                            value={draft.water}
                            onChange={(e) => patch({ water: e.target.value })}
                            placeholder="Meter number"
                            className="h-10"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2 rounded-xl border border-border/50 p-3">
                      <p className="flex items-center gap-1.5 text-xs font-semibold">
                        {proofs.gps ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <Circle className="h-3.5 w-3.5 text-muted-foreground" />}
                        GPS pin (stand at the property)
                      </p>
                      {proofs.gps ? (
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs">
                            <p className="font-medium text-success">Location captured</p>
                            <a
                              href={`https://www.google.com/maps?q=${draft.lat},${draft.lng}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary underline"
                            >
                              View on Google Maps
                            </a>
                          </div>
                          <Button type="button" variant="outline" size="sm" onClick={captureLocation} disabled={capturingLocation}>
                            Re-capture
                          </Button>
                        </div>
                      ) : (
                        <Button type="button" variant="outline" size="sm" className="w-full gap-2" onClick={captureLocation} disabled={capturingLocation}>
                          {capturingLocation ? (
                            <><Loader2 className="h-4 w-4 animate-spin" /> Capturing location…</>
                          ) : (
                            <><Navigation className="h-4 w-4" /> Capture property location</>
                          )}
                        </Button>
                      )}
                    </div>

                    <div className="space-y-2 rounded-xl border border-border/50 p-3">
                      <p className="flex items-center gap-1.5 text-xs font-semibold">
                        {proofs.caretaker ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <Circle className="h-3.5 w-3.5 text-muted-foreground" />}
                        <User className="h-3 w-3" /> Caretaker contact
                      </p>
                      <div className="grid grid-cols-2 gap-3">
                        <Input
                          aria-label="Caretaker name"
                          value={draft.caretakerName}
                          onChange={(e) => patch({ caretakerName: e.target.value })}
                          placeholder="Name"
                          className="h-10"
                        />
                        <Input
                          aria-label="Caretaker phone"
                          type="tel"
                          inputMode="tel"
                          value={draft.caretakerPhone}
                          onChange={(e) => patch({ caretakerPhone: e.target.value })}
                          placeholder="0783..."
                          className="h-10"
                        />
                      </div>
                    </div>

                    <div className="space-y-2 rounded-xl border border-border/50 p-3">
                      <p className="flex items-center gap-1.5 text-xs font-semibold">
                        {proofs.lc1 ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <Circle className="h-3.5 w-3.5 text-muted-foreground" />}
                        LC1 chairperson
                      </p>
                      <div className="grid grid-cols-2 gap-3">
                        <Input
                          aria-label="LC1 chairperson name"
                          value={draft.lc1Name}
                          onChange={(e) => patch({ lc1Name: e.target.value })}
                          placeholder="Name"
                          className="h-10"
                        />
                        <Input
                          aria-label="LC1 chairperson phone"
                          type="tel"
                          inputMode="tel"
                          value={draft.lc1Phone}
                          onChange={(e) => patch({ lc1Phone: e.target.value })}
                          placeholder="0783..."
                          className="h-10"
                        />
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Village: <span className="font-medium text-foreground">{draft.ugLoc ? ugLocationLabel(draft.ugLoc) : '—'}</span>
                      </p>
                    </div>

                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                      <div className="flex items-start gap-3">
                        <Checkbox
                          id="rp-terms"
                          checked={acceptedTerms}
                          onCheckedChange={(checked) => { setError(null); setAcceptedTerms(checked === true); }}
                          className="mt-0.5"
                        />
                        <label htmlFor="rp-terms" className="cursor-pointer text-xs leading-relaxed text-muted-foreground">
                          I agree to the <span className="font-semibold text-foreground">Welile Guaranteed Rent</span> terms:
                          a <span className="font-semibold text-primary">10% platform fee</span> is deducted from each rent
                          deposit, and once a manager verifies the property I receive{' '}
                          <span className="font-semibold text-success">guaranteed monthly rent for 12 months</span> paid to my Welile Wallet.
                        </label>
                      </div>
                    </div>
                  </>
                )}
              </motion.div>
            </AnimatePresence>

            {error && (
              <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
                <p>{error}</p>
                {needsPhone && (
                  <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => navigate('/your-profile')}>
                    Go to your profile
                  </Button>
                )}
              </div>
            )}

            <div className="flex gap-2">
              {draft.step > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => patch({ step: (draft.step - 1) as Step })}
                  disabled={loading}
                >
                  <ArrowLeft className="h-4 w-4" /> Back
                </Button>
              )}
              {draft.step < 3 ? (
                <Button type="button" className="flex-1 gap-1.5" onClick={goNext}>
                  Continue <ArrowRight className="h-4 w-4" />
                </Button>
              ) : (
                <Button type="submit" className="flex-1" disabled={loading}>
                  {loading ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Registering…</>
                  ) : (
                    <><Building2 className="mr-2 h-4 w-4" /> Register for Guaranteed Rent</>
                  )}
                </Button>
              )}
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
