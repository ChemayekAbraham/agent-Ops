import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Check, CheckCircle2, Circle, Copy, Droplets, Home, Loader2, Navigation,
  RotateCcw, Send, Shield, Square, User, UserPlus, Volume2, VolumeX, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import { ugLocationLabel, type UgLocationSelection } from '@/hooks/useUgLocations';
import { useAssistantSpeech } from '@/components/agent/rentRequestAssistant/useAssistantSpeech';
import welileLogo from '@/assets/welile-logo.png';
import { hapticTap } from '@/lib/haptics';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';

/**
 * Register Property as a chat, the same way Post Rent Request works.
 * It asks the same questions as the old form dialog, one at a time, checks the same rules
 * and registers through the same server function, `register_landlord_property`.
 */

type PropertyStatus = 'occupied' | 'empty';
type StepId =
  | 'address' | 'location' | 'rent' | 'houses' | 'payoutDay' | 'status'
  | 'tenantPhone' | 'tenantName' | 'verify' | 'review';

/** Everything the landlord has answered. Kept in the browser so closing the chat never loses it. */
interface Draft {
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
  address: '', ugLoc: null, monthlyRent: '', houses: '', payoutDay: '', status: 'empty',
  tenantName: '', tenantPhone: '', electricity: '', water: '', caretakerName: '', caretakerPhone: '',
  lat: null, lng: null, lc1Name: '', lc1Phone: '',
};

const PLATFORM_FEE_RATE = 0.1;
const OPTIONAL: StepId[] = ['houses', 'payoutDay', 'tenantName'];
const TEXT_STEPS: StepId[] = ['address', 'rent', 'houses', 'tenantPhone', 'tenantName'];

const digits = (v: string) => v.replace(/\D/g, '');
const phoneOk = (v: string) => digits(v).length >= 9;
const groupDigits = (v: string) => (digits(v) ? Number(digits(v)).toLocaleString('en-US') : '');
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

const draftKey = (userId: string) => `register-property-chat-draft:${userId}`;

interface Saved { draft: Draft; current: StepId }

function loadSaved(userId: string): Saved {
  try {
    const raw = localStorage.getItem(draftKey(userId));
    if (!raw) return { draft: EMPTY_DRAFT, current: 'address' };
    const parsed = JSON.parse(raw) as Partial<Saved>;
    return { draft: { ...EMPTY_DRAFT, ...(parsed.draft ?? {}) }, current: parsed.current ?? 'address' };
  } catch {
    return { draft: EMPTY_DRAFT, current: 'address' };
  }
}
function save(userId: string, value: Saved) {
  try { localStorage.setItem(draftKey(userId), JSON.stringify(value)); } catch { /* private mode: it just cannot be restored */ }
}
function clearSaved(userId: string) {
  try { localStorage.removeItem(draftKey(userId)); } catch { /* nothing to clear */ }
}

function greet() {
  const h = new Date().getHours();
  return h < 12 ? { text: 'Good morning', emoji: '☀️' } : h < 17 ? { text: 'Good afternoon', emoji: '🌤️' } : { text: 'Good evening', emoji: '🌙' };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export default function RegisterPropertyAssistant({ open, onOpenChange, onSuccess }: Props) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [current, setCurrent] = useState<StepId>('address');
  const [text, setText] = useState('');
  const [restoredFor, setRestoredFor] = useState<string | null>(null);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsPhone, setNeedsPhone] = useState(false);
  const [result, setResult] = useState<{ reference: string | null; tenantLinked: boolean } | null>(null);

  const patch = (p: Partial<Draft>) => { setError(null); setDraft((d) => ({ ...d, ...p })); };

  // Restore this landlord's unfinished chat when it opens.
  useEffect(() => {
    if (open && user && restoredFor !== user.id) {
      const s = loadSaved(user.id);
      setDraft(s.draft);
      setCurrent(s.current);
      setRestoredFor(user.id);
    }
  }, [open, user, restoredFor]);

  // Keep the draft up to date as answers come in.
  useEffect(() => {
    if (user && restoredFor === user.id && !result) save(user.id, { draft, current });
  }, [draft, current, user, restoredFor, result]);

  const rent = parseInt(draft.monthlyRent, 10) || 0;
  const platformFee = Math.round(rent * PLATFORM_FEE_RATE);
  const youReceive = rent - platformFee;

  const proofs = useMemo(() => ({
    meter: !!(draft.electricity.trim() || draft.water.trim()),
    gps: draft.lat !== null && draft.lng !== null,
    caretaker: phoneOk(draft.caretakerPhone),
    lc1: phoneOk(draft.lc1Phone) && !!draft.lc1Name.trim(),
  }), [draft]);
  const proofCount = Object.values(proofs).filter(Boolean).length;

  const steps: StepId[] = useMemo(
    () => ['address', 'location', 'rent', 'houses', 'payoutDay', 'status',
      ...(draft.status === 'occupied' ? (['tenantPhone', 'tenantName'] as StepId[]) : []),
      'verify', 'review'],
    [draft.status],
  );
  const idx = Math.max(0, steps.indexOf(current));

  /** A message when the step is not ready to leave, otherwise null. Same rules as the old form. */
  const problemWith = useCallback((step: StepId, value?: string): string | null => {
    switch (step) {
      case 'address': return (value ?? draft.address).trim().length < 3 ? 'Please enter the property address.' : null;
      case 'location': return draft.ugLoc ? null : 'Pick the official location (region → village) from the list.';
      case 'rent': return (parseInt(digits(value ?? draft.monthlyRent), 10) || 0) <= 0 ? 'Enter the total monthly rent for this property.' : null;
      case 'tenantPhone': return phoneOk(value ?? draft.tenantPhone) ? null : "Enter the tenant's phone number (at least 9 digits).";
      case 'verify':
        if (proofCount === 0) return 'Add at least one way for us to verify the property.';
        if (draft.caretakerPhone.trim() && !proofs.caretaker) return 'The caretaker phone number looks too short.';
        if (draft.lc1Phone.trim() && !phoneOk(draft.lc1Phone)) return 'The LC1 phone number looks too short.';
        return null;
      case 'review': return acceptedTerms ? null : 'Please accept the Welile Guaranteed Rent terms.';
      default: return null;
    }
  }, [draft, proofCount, proofs.caretaker, acceptedTerms]);

  const advance = () => {
    setError(null);
    setNeedsPhone(false);
    setCurrent(steps[Math.min(idx + 1, steps.length - 1)]);
  };

  // Put the current answer in the box when a text step opens (or is opened again to change it).
  useEffect(() => {
    if (!TEXT_STEPS.includes(current)) return;
    const v = current === 'address' ? draft.address
      : current === 'rent' ? groupDigits(draft.monthlyRent)
      : current === 'houses' ? draft.houses
      : current === 'tenantPhone' ? draft.tenantPhone
      : draft.tenantName;
    setText(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // Scroll to the newest message.
  useEffect(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }));
  }, [current, result, error, restoredFor]);

  const submitText = () => {
    const value = text.trim();
    if (!value && OPTIONAL.includes(current)) { advance(); return; }
    const problem = problemWith(current, value);
    if (problem) { setError(problem); return; }
    if (current === 'address') patch({ address: value });
    else if (current === 'rent') patch({ monthlyRent: digits(value) });
    else if (current === 'houses') patch({ houses: digits(value).slice(0, 4) });
    else if (current === 'tenantPhone') patch({ tenantPhone: value });
    else if (current === 'tenantName') patch({ tenantName: value });
    advance();
  };

  const continueStep = () => {
    const problem = problemWith(current);
    if (problem) { setError(problem); return; }
    advance();
  };

  const captureLocation = () => {
    if (!navigator.geolocation) { toast.error('This device cannot share its location.'); return; }
    setCapturing(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { patch({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setCapturing(false); toast.success('Property location captured'); },
      () => { setCapturing(false); toast.error('Could not get your location. Please allow location access and try again.'); },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const register = async () => {
    if (!user || loading) return;
    // Re-check every step so a restored draft cannot skip a requirement.
    for (const s of steps) {
      const problem = problemWith(s);
      if (problem) { setError(problem); setCurrent(s); return; }
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
      const res = (data ?? {}) as { ok?: boolean; error?: string; reference?: string; tenant_linked?: boolean };
      if (!res.ok) {
        const code = res.error ?? '';
        setNeedsPhone(code === 'profile_phone_required');
        setError(SERVER_ERRORS[code] ?? 'We could not register the property. Please try again.');
        return;
      }
      clearSaved(user.id);
      setResult({ reference: res.reference ?? null, tenantLinked: !!res.tenant_linked });
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
    if (user) clearSaved(user.id);
    setDraft(EMPTY_DRAFT);
    setCurrent('address');
    setText('');
    setAcceptedTerms(false);
    setError(null);
    setNeedsPhone(false);
  };

  const close = () => {
    if (result) {
      // Finished: leave a clean chat behind for the next property.
      setResult(null);
      setDraft(EMPTY_DRAFT);
      setCurrent('address');
      setAcceptedTerms(false);
      setNeedsPhone(false);
    }
    onOpenChange(false);
  };

  const copyReference = async () => {
    if (!result?.reference) return;
    try { await navigator.clipboard.writeText(result.reference); toast.success('Reference copied'); }
    catch { toast.error('Could not copy. Please note it down.'); }
  };

  const questionOf = (s: StepId): string => {
    switch (s) {
      case 'address': return 'What’s the property’s address, or a landmark close to it? 📍';
      case 'location': return 'Which village is it in? Pick the official location from the list.';
      case 'rent': return 'What’s the total monthly rent for the whole property, all the houses together? 💰';
      case 'houses': return 'How many houses are on the property? You can skip this one.';
      case 'payoutDay': return 'Which day of the month would you like to be paid? You can skip this one.';
      case 'status': return 'Does the property have a tenant right now? 🏠';
      case 'tenantPhone': return 'What’s the tenant’s phone number? If they’re already on Welile, I’ll link them.';
      case 'tenantName': return 'And their name? You can skip this one.';
      case 'verify': return 'Almost done! 🔐 Give us at least one way to verify the property. A manager checks one of them.';
      case 'review': return 'Here’s what I have. Check it, then register when you’re ready.';
    }
  };

  const answerOf = (s: StepId): string | null => {
    switch (s) {
      case 'address': return draft.address || null;
      case 'location': return draft.ugLoc ? ugLocationLabel(draft.ugLoc) : null;
      case 'rent': return rent > 0 ? formatUGX(rent) : null;
      case 'houses': return draft.houses || 'Skipped';
      case 'payoutDay': return draft.payoutDay ? `The ${ordinal(parseInt(draft.payoutDay, 10))} of every month` : 'Skipped';
      case 'status': return draft.status === 'occupied' ? 'It has a tenant' : 'It is empty';
      case 'tenantPhone': return draft.tenantPhone || null;
      case 'tenantName': return draft.tenantName || 'Skipped';
      case 'verify': return `${proofCount} way${proofCount === 1 ? '' : 's'} added`;
      default: return null;
    }
  };

  const first = (user?.user_metadata as { full_name?: string } | undefined)?.full_name?.split(' ')[0] || 'there';
  const greeting = greet();
  const hasContent = !!(draft.address || draft.monthlyRent || draft.ugLoc);

  const spokenReply = result ? 'Your property has been submitted. A manager will verify it.' : error || questionOf(current);
  const speech = useAssistantSpeech(spokenReply, open, user?.id);
  useEffect(() => {
    if (speech.failed) toast.error('Voice playback is unavailable. You can still read the assistant’s replies.');
  }, [speech.failed]);

  if (!open) return null;

  const isTextStep = TEXT_STEPS.includes(current);
  const optional = OPTIONAL.includes(current);

  return (
    // z-[115]: full-screen, so it covers the bottom role bar, the assistant launcher and the WhatsApp button.
    <div className="fixed inset-0 z-[115] flex flex-col bg-background text-foreground" role="dialog" aria-modal="true" aria-label="Register property assistant">
      <header className="flex items-center gap-2.5 border-b border-border bg-card px-3 py-2.5 pt-safe">
        <button type="button" aria-label="Close" onClick={close} className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-muted">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <Avatar size="lg" />
        <div className="min-w-0 flex-1">
          <p className="font-display text-base font-bold leading-tight">Register Property</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            {result ? 'Property submitted' : 'Registering with you'}
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon" className="shrink-0 text-primary" disabled={!speech.supported}
          aria-label={speech.enabled ? 'Turn voice off' : 'Turn voice on'} aria-pressed={speech.enabled} onClick={speech.toggle}>
          {speech.enabled ? <Volume2 /> : <VolumeX />}
        </Button>
        {speech.enabled && (
          <Button type="button" variant="ghost" size="icon" className="shrink-0 text-primary"
            aria-label={speech.speaking ? 'Stop speaking' : 'Replay reply'} onClick={speech.speaking ? speech.stop : speech.replay}>
            {speech.speaking ? <Square /> : <RotateCcw />}
          </Button>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-primary/[0.07] px-4 py-4">
        <div className="mx-auto flex max-w-xl flex-col gap-3.5">
          <div className="px-1 pb-1 pt-2">
            <h1 className="font-display text-[26px] font-extrabold leading-8 tracking-tight">
              {greeting.text}, <span className="text-foreground/65">{first}</span> {greeting.emoji}
            </h1>
            <p className="mt-1 text-base text-muted-foreground">I’ll help you register your property for Welile Guaranteed Monthly Rent.</p>
            {hasContent && !result && (
              <button type="button" onClick={startOver} className="mt-2 text-xs text-muted-foreground underline">Start over</button>
            )}
          </div>

          {steps.slice(0, idx).map((s) => {
            const a = answerOf(s);
            return (
              <div key={s} className="flex flex-col gap-3.5">
                <Bot><Bubble>{questionOf(s)}</Bubble></Bot>
                {a && (
                  <button type="button" onClick={() => !result && !loading && setCurrent(s)} className="self-end" aria-label={`Change answer: ${a}`}>
                    <MeBubble>{a}</MeBubble>
                  </button>
                )}
                {s === 'rent' && rent > 0 && (
                  <Bot>
                    <Bubble>
                      After Welile’s 10% fee ({formatUGX(platformFee)}) you’d receive <b>{formatUGX(youReceive)}</b> a month,
                      that’s <b>{formatUGX(youReceive * 12)}</b> over 12 months. 🎉
                    </Bubble>
                  </Bot>
                )}
              </div>
            );
          })}

          {!result && (
            <div className="flex flex-col gap-3">
              <Bot><Bubble>{questionOf(current)}</Bubble></Bot>
              <div className="pl-9">{renderWidget()}</div>
              {error && (
                <Bot>
                  <Bubble tone="warn"><span className="whitespace-pre-line">{error}</span></Bubble>
                  {needsPhone && (
                    <div className="flex flex-wrap gap-2">
                      <Chip onClick={() => navigate('/your-profile')}>Go to your profile</Chip>
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
                  <span className="mb-1.5 inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-semibold text-success"><Check className="h-3 w-3" /> Submitted</span>
                  <br />
                  Done! A manager will verify your property. Keep this reference to ask about it.
                </Bubble>
              </Bot>
              {result.reference && (
                <div className="pl-9">
                  <button type="button" onClick={copyReference} aria-label={`Copy reference ${result.reference}`}
                    className="flex items-center gap-2 rounded-2xl border border-border bg-card px-4 py-2 font-mono text-lg font-bold tracking-widest">
                    {result.reference}
                    <Copy className="h-4 w-4 text-muted-foreground" />
                  </button>
                </div>
              )}
              <Bot>
                <Bubble>
                  <ol className="space-y-1.5 text-sm">
                    <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-success" /> Registered</li>
                    <li className="flex items-center gap-2"><Circle className="h-4 w-4 text-primary" /> Under review by a manager <span className="text-xs text-muted-foreground">(about 5 days)</span></li>
                    <li className="flex items-center gap-2 text-muted-foreground"><Circle className="h-4 w-4" /> Verified: 12-month Guaranteed Monthly Rent starts</li>
                    <li className="flex items-center gap-2 text-muted-foreground"><Circle className="h-4 w-4" /> Rent paid to your Welile Wallet{draft.payoutDay ? ` on the ${ordinal(parseInt(draft.payoutDay, 10))}` : ''}</li>
                  </ol>
                </Bubble>
              </Bot>
              {draft.status === 'occupied' && (
                <Bot>
                  <Bubble>
                    {result.tenantLinked
                      ? 'Your tenant already has a Welile account and has been linked to this property.'
                      : 'Your tenant doesn’t have a Welile account yet. Their details are saved with the property.'}
                  </Bubble>
                </Bot>
              )}
              <div className="flex flex-wrap gap-2 pl-9">
                <Chip onClick={() => { setResult(null); startOver(); }}>Register another</Chip>
                <Chip onClick={close}>Back to dashboard</Chip>
              </div>
            </>
          )}
        </div>
      </div>

      {!result && (
        <footer className="border-t border-border bg-card px-3 pb-safe pt-2.5">
          <div className="mx-auto flex max-w-xl items-center gap-2 pb-3">
            {isTextStep ? (
              <form className="flex flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); submitText(); }}>
                <input
                  aria-label="Your answer"
                  autoFocus
                  inputMode={current === 'rent' || current === 'houses' ? 'numeric' : current === 'tenantPhone' ? 'tel' : 'text'}
                  value={text}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (current === 'rent') setText(groupDigits(v));
                    else if (current === 'houses') setText(digits(v).slice(0, 4));
                    else if (current === 'tenantPhone') setText(v.replace(/[^\d+\s]/g, '').slice(0, 16));
                    else setText(v);
                    setError(null);
                  }}
                  placeholder={current === 'address' ? 'e.g. Kira Road, Block 5' : current === 'rent' ? 'e.g. 500,000'
                    : current === 'houses' ? 'e.g. 5' : current === 'tenantPhone' ? '0783…' : 'Full name'}
                  className="h-11 min-w-0 flex-1 rounded-full border border-border bg-background px-4 text-base outline-none focus:border-primary"
                />
                <button type="submit" aria-label={optional && !text.trim() ? 'Skip' : 'Send'}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground hover:bg-success/90">
                  <Send className="h-4 w-4" />
                </button>
              </form>
            ) : current === 'review' ? (
              <button type="button" onClick={() => void register()} disabled={loading}
                className="h-11 flex-1 rounded-full bg-success font-semibold text-success-foreground hover:bg-success/90 active:scale-[0.99] disabled:opacity-60">
                {loading ? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Registering…</span> : 'Register for Guaranteed Rent'}
              </button>
            ) : (
              <button type="button" onClick={continueStep}
                className="h-11 flex-1 rounded-full bg-success font-semibold text-success-foreground active:scale-[0.99] hover:bg-success/90">
                {current === 'payoutDay' && !draft.payoutDay ? 'Skip' : 'Continue'}
              </button>
            )}
          </div>
        </footer>
      )}
    </div>
  );

  function renderWidget(): ReactNode {
    switch (current) {
      case 'location':
        return (
          <div className="rounded-2xl border border-border bg-card p-3">
            <UgLocationPicker
              value={draft.ugLoc}
              onChange={(sel) => patch({ ugLoc: sel })}
              label="Official location (region → village)"
              required
            />
          </div>
        );
      case 'payoutDay':
        return (
          <div className="grid grid-cols-7 gap-1.5">
            {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
              <button
                key={day}
                type="button"
                aria-pressed={draft.payoutDay === String(day)}
                onClick={() => { hapticTap(); patch({ payoutDay: draft.payoutDay === String(day) ? '' : String(day) }); }}
                className={cn(
                  'h-10 rounded-full border text-sm font-semibold',
                  draft.payoutDay === String(day) ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-foreground',
                )}
              >
                {day}
              </button>
            ))}
          </div>
        );
      case 'status':
        return (
          <div className="flex flex-col gap-2">
            {(['occupied', 'empty'] as PropertyStatus[]).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={draft.status === s}
                onClick={() => { hapticTap(); patch({ status: s }); }}
                className={cn('flex min-h-16 items-center gap-3 rounded-2xl border bg-card p-3 text-left', draft.status === s ? 'border-primary' : 'border-border')}
              >
                <span className="grid h-9 w-9 flex-none place-items-center rounded-full bg-muted">
                  {s === 'occupied' ? <UserPlus className="h-5 w-5" /> : <Home className="h-5 w-5" />}
                </span>
                <span className="flex-1">
                  <span className="block font-display text-[15px] font-bold">{s === 'occupied' ? 'It has a tenant' : 'It is empty'}</span>
                  <span className="block text-xs text-muted-foreground">{s === 'occupied' ? 'I’ll add their phone number' : 'Welile finds a tenant'}</span>
                </span>
                {draft.status === s && <Check className="h-4 w-4 text-primary" />}
              </button>
            ))}
          </div>
        );
      case 'verify':
        return (
          <div className="flex flex-col gap-2.5">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Shield className="h-3.5 w-3.5" /> {proofCount > 0 ? `${proofCount} added` : 'None added yet'}
            </p>

            <Card title="Meter number" done={proofs.meter}>
              <div className="grid grid-cols-2 gap-2">
                <Field icon={<Zap className="h-3 w-3 text-amber-500" />} label="UEDCL (electricity)">
                  <input aria-label="UEDCL meter number" value={draft.electricity} onChange={(e) => patch({ electricity: e.target.value })} placeholder="Meter number" className={INPUT} />
                </Field>
                <Field icon={<Droplets className="h-3 w-3 text-blue-500" />} label="NWSC (water)">
                  <input aria-label="NWSC meter number" value={draft.water} onChange={(e) => patch({ water: e.target.value })} placeholder="Meter number" className={INPUT} />
                </Field>
              </div>
            </Card>

            <Card title="GPS pin (stand at the property)" done={proofs.gps}>
              {proofs.gps ? (
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div>
                    <p className="font-medium text-success">Location captured</p>
                    <a href={`https://www.google.com/maps?q=${draft.lat},${draft.lng}`} target="_blank" rel="noopener noreferrer" className="text-primary underline">View on Google Maps</a>
                  </div>
                  <Button type="button" variant="outline" size="sm" className="rounded-full" onClick={captureLocation} disabled={capturing}>Re-capture</Button>
                </div>
              ) : (
                <Button type="button" variant="outline" className="h-11 w-full gap-2 rounded-full" onClick={captureLocation} disabled={capturing}>
                  {capturing ? <><Loader2 className="h-4 w-4 animate-spin" /> Capturing location…</> : <><Navigation className="h-4 w-4" /> Capture property location</>}
                </Button>
              )}
            </Card>

            <Card title="Caretaker contact" icon={<User className="h-3 w-3" />} done={proofs.caretaker}>
              <div className="grid grid-cols-2 gap-2">
                <input aria-label="Caretaker name" value={draft.caretakerName} onChange={(e) => patch({ caretakerName: e.target.value })} placeholder="Name" className={INPUT} />
                <input aria-label="Caretaker phone" type="tel" inputMode="tel" value={draft.caretakerPhone} onChange={(e) => patch({ caretakerPhone: e.target.value })} placeholder="0783…" className={INPUT} />
              </div>
            </Card>

            <Card title="LC1 chairperson" done={proofs.lc1}>
              <div className="grid grid-cols-2 gap-2">
                <input aria-label="LC1 chairperson name" value={draft.lc1Name} onChange={(e) => patch({ lc1Name: e.target.value })} placeholder="Name" className={INPUT} />
                <input aria-label="LC1 chairperson phone" type="tel" inputMode="tel" value={draft.lc1Phone} onChange={(e) => patch({ lc1Phone: e.target.value })} placeholder="0783…" className={INPUT} />
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Village: <span className="font-medium text-foreground">{draft.ugLoc ? ugLocationLabel(draft.ugLoc) : '—'}</span>
              </p>
            </Card>
          </div>
        );
      case 'review':
        return (
          <div className="flex flex-col gap-3">
            <div className="rounded-2xl border border-border bg-card p-3 text-sm">
              <Row k="Address" v={draft.address} />
              <Row k="Location" v={draft.ugLoc ? ugLocationLabel(draft.ugLoc) : '—'} />
              <Row k="Monthly rent" v={formatUGX(rent)} />
              <Row k="You receive (after 10% fee)" v={formatUGX(youReceive)} />
              <Row k="Houses" v={draft.houses || '—'} />
              <Row k="Payout day" v={draft.payoutDay ? `${ordinal(parseInt(draft.payoutDay, 10))} of every month` : '—'} />
              <Row k="Tenant" v={draft.status === 'occupied' ? (draft.tenantName ? `${draft.tenantName}, ${draft.tenantPhone}` : draft.tenantPhone) : 'Empty'} />
              <Row k="Verified by" v={[proofs.meter && 'Meter', proofs.gps && 'GPS pin', proofs.caretaker && 'Caretaker', proofs.lc1 && 'LC1'].filter(Boolean).join(', ') || '—'} />
            </div>
            <div className="rounded-2xl border border-border bg-card p-3">
              <div className="flex items-start gap-3">
                <Checkbox id="rpa-terms" checked={acceptedTerms} onCheckedChange={(c) => { setError(null); setAcceptedTerms(c === true); }} className="mt-0.5" />
                <label htmlFor="rpa-terms" className="cursor-pointer text-xs leading-relaxed text-muted-foreground">
                  I agree to the <span className="font-semibold text-foreground">Welile Guaranteed Rent</span> terms:
                  a <span className="font-semibold text-foreground">10% platform fee</span> is deducted from each rent
                  deposit, and once a manager verifies the property I receive{' '}
                  <span className="font-semibold text-foreground">guaranteed monthly rent for 12 months</span> paid to my Welile Wallet.
                </label>
              </div>
            </div>
          </div>
        );
      default:
        return optional ? (
          <div className="flex flex-wrap gap-2"><Chip onClick={advance}>Skip</Chip></div>
        ) : null;
    }
  }
}

const INPUT = 'h-11 w-full min-w-0 rounded-xl border border-border bg-background px-3 text-base outline-none focus:border-primary';

function Avatar({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  return (
    <span aria-hidden="true" className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary', size === 'lg' ? 'h-9 w-9' : 'h-7 w-7')}>
      <img src={welileLogo} alt="" draggable={false} className="h-full w-full object-cover" />
    </span>
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

function Chip({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button type="button" onClick={() => { hapticTap(); onClick?.(); }}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-primary/30 bg-card px-3.5 text-sm font-semibold text-primary">
      {children}
    </button>
  );
}

function Card({ title, icon, done, children }: { title: string; icon?: ReactNode; done: boolean; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
        {done ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <Circle className="h-3.5 w-3.5 text-muted-foreground" />}
        {icon}
        {title}
      </p>
      {children}
    </div>
  );
}

function Field({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-1 text-xs">{icon} {label}</span>
      {children}
    </label>
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
