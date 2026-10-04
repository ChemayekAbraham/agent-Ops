import { useEffect, useState, useRef, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { Loader2, Banknote, Phone, CheckCircle2, ShieldCheck, ChevronLeft, User, XCircle } from 'lucide-react';

// Read the friendly `message` field our edge functions return on non-2xx.
async function readEdgeMessage(error: any, fallback: string): Promise<string> {
  try {
    const ctx = error?.context;
    if (ctx && typeof ctx.json === 'function') {
      const body = await ctx.json();
      return body?.message || body?.error || fallback;
    }
    if (ctx?.body) {
      const body = typeof ctx.body === 'string' ? JSON.parse(ctx.body) : ctx.body;
      return body?.message || body?.error || fallback;
    }
  } catch { /* ignore */ }
  return error?.message || fallback;
}

// Read the full JSON body our edge functions return on non-2xx.
async function readEdgeBody(error: any): Promise<any | null> {
  try {
    const ctx = error?.context;
    if (ctx && typeof ctx.json === 'function') return await ctx.json();
    if (ctx?.body) return typeof ctx.body === 'string' ? JSON.parse(ctx.body) : ctx.body;
  } catch { /* ignore */ }
  return null;
}

interface AgentCashPinDepositProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

const QUICK_AMOUNTS = [10000, 50000, 100000, 250000];

type Step = 'form' | 'confirm' | 'pin' | 'success';

/**
 * Cash-with-agent deposit secured by a 4-digit code.
 *  1. The depositor enters the amount + the agent's phone number.
 *  2. The backend resolves the agent, checks their float, and shows a
 *     4-digit code on the AGENT'S dashboard.
 *  3. The agent reads the code back after taking the cash.
 *  4. The depositor enters the code → their withdrawable wallet is credited
 *     and the agent's operational float is debited by the same amount.
 */
export default function AgentCashPinDeposit({ open, onOpenChange, onSuccess }: AgentCashPinDepositProps) {
  const [step, setStep] = useState<Step>('form');
  const [amount, setAmount] = useState('');
  const [agentPhone, setAgentPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState('');
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [creditedAmount, setCreditedAmount] = useState(0);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [canResendAt, setCanResendAt] = useState<number | null>(null);
  const [locked, setLocked] = useState(false);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);

  // Agent phone search
  const [suggestions, setSuggestions] = useState<Array<{ id: string; full_name: string; phone: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [phoneError, setPhoneError] = useState('');
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [selectedFromList, setSelectedFromList] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phoneWrapRef = useRef<HTMLDivElement>(null);

  const validatePhone = (value: string): string => {
    const digits = value.replace(/\D/g, '');
    if (digits.length === 0) return '';
    if (digits.length < 9) return 'Phone number is too short — needs at least 9 digits.';
    if (digits.length > 15) return 'Phone number is too long.';
    // Uganda check: if it starts with 0 it must be 10 digits; if 256 it should be 12
    if (digits.startsWith('0') && digits.length !== 10) return 'Uganda numbers starting with 0 must be exactly 10 digits (e.g. 0772 123 456).';
    if (digits.startsWith('256') && digits.length !== 12) return 'Numbers with 256 country code must be exactly 12 digits (e.g. 256772123456).';
    return '';
  };

  const reset = () => {
    setStep('form'); setAmount(''); setAgentPhone(''); setLoading(false);
    setSessionId(null); setAgentName(''); setPin(''); setPinError(''); setCreditedAmount(0); setExpiresAt(null);
    setSuggestions([]); setShowSuggestions(false); setPhoneError(''); setPhoneTouched(false);
    setSelectedFromList(false); setCanResendAt(null); setLocked(false); setAttemptsLeft(null);
  };

  const searchAgents = useCallback(async (query: string) => {
    const digits = query.replace(/\D/g, '');
    if (digits.length < 3) {
      setSuggestions([]);
      setShowSuggestions(false);
      setHasSearched(false);
      return;
    }
    setHasSearched(true);
    setSearching(true);
    try {
      const { data, error } = await supabase.rpc('search_agents_by_phone', {
        p_phone_term: digits,
        p_limit: 8,
      });
      if (error) {
        console.error('search_agents_by_phone error:', error);
        setSuggestions([]);
      } else {
        setSuggestions((data ?? []) as Array<{ id: string; full_name: string; phone: string }>);
        setShowSuggestions(true);
      }
    } catch {
      setSuggestions([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const onPhoneChange = (value: string) => {
    setAgentPhone(value);
    if (phoneTouched) setPhoneError(validatePhone(value));
    setShowSuggestions(false);
    setSelectedFromList(false);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => searchAgents(value), 300);
  };

  const selectSuggestion = (phone: string, name: string) => {
    setAgentPhone(phone);
    setAgentName(name);
    setPhoneError(validatePhone(phone));
    setShowSuggestions(false);
    setSuggestions([]);
    setSelectedFromList(true);
  };

  const close = () => { reset(); onOpenChange(false); };

  const amountNum = parseFloat(amount);

  // Close suggestions when clicking outside the phone field.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (phoneWrapRef.current && !phoneWrapRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Tick the countdown while the depositor is on the PIN step.
  useEffect(() => {
    if (step !== 'pin' || !expiresAt) return;
    const iv = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(iv);
  }, [step, expiresAt]);

  const secsLeft = expiresAt
    ? Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000))
    : null;
  const expired = secsLeft !== null && secsLeft <= 0;

  // When the code expires, tell the user clearly and send them back to the
  // start so they can request a fresh code.
  useEffect(() => {
    if (step !== 'pin' || !expired) return;
    toast.error('Your confirmation code expired after 5 minutes. Please start over to get a new one.');
    setStep('form');
    setPin('');
    setPinError('');
    setSessionId(null);
    setExpiresAt(null);
    setCanResendAt(null);
  }, [step, expired]);

  const resendCooldownLeft = canResendAt ? Math.max(0, Math.ceil((canResendAt - now) / 1000)) : 0;

  const handleResend = async () => {
    if (!sessionId || resendCooldownLeft > 0) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('agent-cash-deposit-resend', {
        body: { session_id: sessionId },
      });
      if (error) {
        const msg = await readEdgeMessage(error, 'Could not resend the code');
        toast.error(msg);
        return;
      }
      if (!data?.ok) {
        toast.error(data?.message || 'Could not resend the code');
        return;
      }
      setPin('');
      setPinError('');
      setExpiresAt(data.expires_at ?? null);
      setNow(Date.now());
      setCanResendAt(Date.now() + 60_000); // 60-second cooldown
      setLocked(false);
      setAttemptsLeft(null);
      toast.success('A new confirmation code has been sent to the agent.');
    } catch (e) {
      toast.error('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const countdownLabel =
    secsLeft === null
      ? ''
      : `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}`;

  const TZ = 'Africa/Kampala';
  const expiryTimeLabel = (() => {
    if (!expiresAt) return '';
    const d = new Date(expiresAt);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  })();

  const handleCreate = async () => {
    if (!Number.isFinite(amountNum) || amountNum < 500) {
      toast.error('Enter a valid amount (minimum UGX 500)');
      return;
    }
    const err = validatePhone(agentPhone);
    if (err) {
      toast.error(err);
      setPhoneError(err);
      return;
    }
    // If the depositor typed a number that isn't one of the matched agents,
    // ask them to confirm the number before contacting the backend.
    if (!selectedFromList) {
      setShowSuggestions(false);
      setStep('confirm');
      return;
    }
    void submitDeposit();
  };

  const submitDeposit = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('agent-cash-deposit-create', {
        body: { amount: amountNum, agent_phone: agentPhone.trim() },
      });
      if (error) {
        const body = await readEdgeBody(error);
        // Already have a live pending session with this agent → resume it
        // instead of dead-ending the user.
        if (body?.error === 'session_in_progress' && body?.session_id) {
          setSessionId(body.session_id);
          setAgentName((prev) => prev || 'the agent');
          setExpiresAt(null);
          setNow(Date.now());
          setPin('');
          setPinError('');
          setLocked(false);
          setAttemptsLeft(null);
          setStep('pin');
          toast.info('You already have a pending deposit with this agent. Enter the code they gave you.');
          return;
        }
        toast.error(body?.message || body?.error || 'Could not start the deposit');
        return;
      }
      if (!data?.ok) {
        toast.error(data?.message || 'Could not start the deposit');
        return;
      }
      setSessionId(data.session_id);
      setAgentName(data.agent_name || 'the agent');
      setExpiresAt(data.expires_at ?? null);
      setNow(Date.now());
      setLocked(false);
      setAttemptsLeft(null);
      setStep('pin');
    } catch (e) {
      toast.error('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (code: string) => {
    if (!sessionId || code.length !== 4) return;
    setLoading(true);
    setPinError('');
    try {
      const { data, error } = await supabase.functions.invoke('agent-cash-deposit-confirm', {
        body: { session_id: sessionId, pin: code },
      });
      if (error) {
        const body = await readEdgeBody(error);
        const msg = body?.message || (await readEdgeMessage(error, 'Could not confirm the code'));
        // Session is locked: too many wrong attempts, or the final attempt
        // just used up the allowance. Force a fresh start.
        const isLocked =
          body?.error === 'too_many_attempts' ||
          body?.error === 'not_active' ||
          (typeof body?.attempts_remaining === 'number' && body.attempts_remaining <= 0);
        toast.error(msg);
        setPin('');
        setPinError(msg);
        if (typeof body?.attempts_remaining === 'number') setAttemptsLeft(body.attempts_remaining);
        if (isLocked) setLocked(true);
        return;
      }
      if (!data?.ok) {
        const msg = data?.message || 'That code is incorrect. Ask the agent to read it again.';
        toast.error(msg);
        setPin('');
        setPinError(msg);
        return;
      }
      setCreditedAmount(Number(data.amount ?? amountNum));
      setStep('success');
      onSuccess?.();
    } catch (e) {
      const msg = 'Network error. Please try again.';
      toast.error(msg);
      setPin('');
      setPinError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => {
      if (!o) {
        if (step === 'confirm') {
          setStep('form');
        } else {
          close();
        }
      }
    }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="h-5 w-5 text-emerald-600" />
            Cash with agent
          </DialogTitle>
        </DialogHeader>

        {step === 'form' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Hand cash to a Welile agent and get it instantly in your wallet. Enter the amount and the agent's phone number.
            </p>

            <div className="space-y-2">
              <Label className="text-sm font-medium">How much?</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-medium text-sm pointer-events-none">UGX</span>
                <Input
                  type="number"
                  inputMode="decimal"
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="text-2xl font-bold tabular-nums h-14 pl-14 pr-3"
                />
              </div>
              <div className="grid grid-cols-4 gap-2 pt-1">
                {QUICK_AMOUNTS.map((amt) => (
                  <Button key={amt} type="button" variant={amount === String(amt) ? 'default' : 'outline'}
                    className="text-xs h-10 font-medium px-1" onClick={() => setAmount(String(amt))}>
                    {(amt / 1000) + 'k'}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-2 relative" ref={phoneWrapRef}>
              <Label className="text-sm font-medium flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5" /> Agent's phone number
              </Label>
              <Input
                type="tel"
                inputMode="tel"
                placeholder="e.g. 0772 123 456"
                value={agentPhone}
                onChange={(e) => onPhoneChange(e.target.value)}
                onFocus={() => { if (hasSearched) setShowSuggestions(true); }}
                onBlur={() => { setPhoneTouched(true); setPhoneError(validatePhone(agentPhone)); }}
                autoComplete="off"
                className={`h-12 text-base ${phoneError && phoneTouched ? 'border-destructive focus-visible:ring-destructive' : ''}`}
              />
              {showSuggestions && (
                <div className="absolute z-50 left-0 right-0 top-full mt-1 bg-popover border rounded-lg shadow-lg overflow-hidden">
                  {searching && (
                    <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-3 w-3 animate-spin" /> Searching agents…
                    </div>
                  )}
                  {!searching && suggestions.length === 0 && (
                    <div className="px-3 py-3 space-y-2">
                      <div className="flex items-center gap-2 text-xs text-destructive">
                        <XCircle className="h-3.5 w-3.5" />
                        <span className="font-medium">No agents found for this number.</span>
                      </div>
                      <button
                        type="button"
                        className="w-full text-left text-xs text-primary font-medium hover:underline"
                        onClick={() => { setShowSuggestions(false); setPhoneError(''); }}
                      >
                        Continue with <span className="font-semibold">{agentPhone.trim() || 'this number'}</span> anyway
                      </button>
                    </div>
                  )}
                  {suggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="w-full text-left px-3 py-2.5 flex items-center gap-2 hover:bg-accent transition-colors"
                      onClick={() => selectSuggestion(s.phone, s.full_name)}
                    >
                      <User className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{s.full_name}</p>
                        <p className="text-xs text-muted-foreground">{s.phone}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {phoneError && phoneTouched && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <XCircle className="h-3 w-3 shrink-0" /> {phoneError}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                You can type any agent's phone number — it doesn't have to be in the list.
              </p>
            </div>

            <Button onClick={handleCreate} disabled={loading} className="w-full h-12 gap-2">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Get confirmation code
            </Button>
          </div>
        )}

        {step === 'confirm' && (
          <div className="space-y-4">
            <button
              onClick={() => setStep('form')}
              className="text-xs text-muted-foreground flex items-center gap-1 hover:text-foreground rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </button>
            <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/20 text-sm space-y-1">
              <div className="flex items-center gap-2 text-amber-700 font-medium">
                <XCircle className="h-4 w-4 shrink-0" />
                No matching agent found
              </div>
              <p className="text-muted-foreground">
                We couldn't match this number to a saved agent. Please double-check it before continuing.
              </p>
            </div>
            <div className="rounded-xl border p-4 space-y-1">
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5" /> Agent's phone number
              </p>
              <p
                tabIndex={0}
                className="text-2xl font-bold tabular-nums tracking-wide rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {agentPhone.trim()}
              </p>
              <p
                tabIndex={0}
                className="text-sm text-muted-foreground rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                Amount: <span className="font-semibold text-foreground">{formatUGX(amountNum)}</span>
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Button onClick={() => void submitDeposit()} disabled={loading} className="w-full h-12 gap-2">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Yes, proceed with this number
                <span className="sr-only">Press Enter to confirm</span>
              </Button>
              <Button variant="outline" onClick={() => setStep('form')} disabled={loading} className="w-full h-11">
                Edit number
                <span className="sr-only">Press Escape to go back</span>
              </Button>
            </div>
          </div>
        )}

        {step === 'pin' && (
          <div className="space-y-4">
            <button onClick={() => { setStep('form'); setPin(''); }} className="text-xs text-muted-foreground flex items-center gap-1 hover:text-foreground">
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </button>
            <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20 text-sm">
              A 4-digit code is now showing on <span className="font-semibold">{agentName}</span>'s dashboard.
              After you hand over <span className="font-semibold">{formatUGX(amountNum)}</span>, ask the agent to
              read the code and enter it below.
            </div>
            {secsLeft !== null && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-medium">
                  <span className={expired ? 'text-destructive' : secsLeft <= 60 ? 'text-amber-600' : 'text-muted-foreground'}>
                    {expired ? 'Code expired' : 'Code expires in'}
                  </span>
                  <span className={`tabular-nums font-bold ${expired ? 'text-destructive' : secsLeft <= 60 ? 'text-amber-600' : 'text-foreground'}`}>
                    {countdownLabel}
                  </span>
                </div>
                {!expired && (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Valid until <span className="font-semibold tabular-nums text-foreground">{expiryTimeLabel}</span>{' '}
                      <span className="tabular-nums">({TZ})</span>
                    </p>
                    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-1000 ease-linear ${
                          secsLeft <= 60 ? 'bg-destructive' : secsLeft <= 120 ? 'bg-amber-500' : 'bg-emerald-500'
                        }`}
                        style={{ width: `${Math.min(100, Math.max(0, (secsLeft / 300) * 100))}%` }}
                      />
                    </div>
                  </>
                )}
              </div>
            )}
            <div className="flex flex-col items-center gap-2">
              <Label className="text-sm font-medium">Enter the 4-digit code</Label>
              <InputOTP maxLength={4} value={pin} disabled={expired || loading || locked} onChange={(v) => { setPin(v); if (pinError) setPinError(''); if (v.length === 4) void handleConfirm(v); }}>
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                </InputOTPGroup>
              </InputOTP>
              {!locked && attemptsLeft !== null && attemptsLeft > 0 && (
                <p className="text-xs text-amber-600 font-medium">
                  {attemptsLeft} {attemptsLeft === 1 ? 'attempt' : 'attempts'} left before this code locks.
                </p>
              )}
              {!locked && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground hover:text-foreground"
                disabled={loading || resendCooldownLeft > 0 || expired}
                onClick={() => void handleResend()}
              >
                {resendCooldownLeft > 0
                  ? `Resend code in ${resendCooldownLeft}s`
                  : 'Didn\'t get it? Resend code'}
              </Button>
              )}
              {loading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground pt-1">
                  <Loader2 className="h-4 w-4 animate-spin" /> Crediting your wallet…
                </div>
              )}
              {locked && !loading && (
                <div className="w-full mt-1 p-3 rounded-xl bg-destructive/5 border border-destructive/20 space-y-2">
                  <p className="text-sm text-destructive flex items-start gap-1.5">
                    <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{pinError || 'Too many incorrect attempts. This code has been locked for your security.'}</span>
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full gap-1.5"
                    onClick={() => { setStep('form'); setPin(''); setPinError(''); setSessionId(null); setExpiresAt(null); setCanResendAt(null); setLocked(false); setAttemptsLeft(null); }}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" /> Start a new deposit
                  </Button>
                </div>
              )}
              {pinError && !loading && !expired && !locked && (
                <div className="w-full mt-1 p-3 rounded-xl bg-destructive/5 border border-destructive/20 space-y-2">
                  <p className="text-sm text-destructive flex items-start gap-1.5">
                    <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{pinError}</span>
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full gap-1.5"
                    onClick={() => { setPin(''); setPinError(''); }}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" /> Try the code again
                  </Button>
                </div>
              )}
              {expired && !loading && (
                <Button variant="outline" size="sm" className="mt-1" onClick={() => { setStep('form'); setPin(''); setExpiresAt(null); setCanResendAt(null); }}>
                  Start a new deposit
                </Button>
              )}
            </div>
          </div>
        )}

        {step === 'success' && (
          <div className="space-y-4 text-center py-4">
            <CheckCircle2 className="h-14 w-14 text-emerald-500 mx-auto" />
            <div>
              <p className="text-lg font-bold">{formatUGX(creditedAmount)} added</p>
              <p className="text-sm text-muted-foreground">The amount is now in your withdrawable wallet.</p>
            </div>
            <Button onClick={close} className="w-full h-12">Done</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}