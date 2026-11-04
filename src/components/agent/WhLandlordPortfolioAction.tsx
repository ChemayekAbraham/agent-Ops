import { useEffect, useState } from 'react';
import { Banknote, Clock, Loader2, ShieldCheck, AlertCircle, CheckCircle2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { sendLandlordPortfolioCode, verifyLandlordPortfolioCode } from '@/lib/welileHomesLandlordVerify';

const CODE_TTL_SECONDS = 10 * 60;
const RESEND_COOLDOWN = 60;
const STORE_PREFIX = 'welile.wh-landlord-code.';

type Pending = { sentAt: number; code: string };
const storeKey = (phone: string) => STORE_PREFIX + phone.replace(/\D/g, '').slice(-9);
function readPending(phone: string): Pending | null {
  try {
    const raw = localStorage.getItem(storeKey(phone));
    if (!raw) return null;
    const p = JSON.parse(raw) as Pending;
    if (typeof p?.sentAt !== 'number') return null;
    // Keep for a while after expiry so the agent still sees "expired" and can Resend.
    if (Date.now() - p.sentAt > 60 * 60 * 1000) { localStorage.removeItem(storeKey(phone)); return null; }
    return { sentAt: p.sentAt, code: typeof p.code === 'string' ? p.code : '' };
  } catch { return null; }
}
function writePending(phone: string, p: Pending | null) {
  try {
    if (p) localStorage.setItem(storeKey(phone), JSON.stringify(p));
    else localStorage.removeItem(storeKey(phone));
  } catch { /* storage unavailable */ }
}

/** True while any landlord code entry is open, so the parent sheet must not close on outside taps. */
export function hasPendingLandlordCode(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith(STORE_PREFIX)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * One landlord SMS code per portfolio. The code is checked only on the server
 * (`wh_portfolio_verify_landlord`); this component never decides verification itself.
 * The open code entry (send time + typed digits) is kept in localStorage so tapping
 * outside, switching apps, or refreshing never closes it or sends a new code;
 * it closes only on successful verification or Cancel.
 */
export function WhLandlordPortfolioAction({
  landlordName, landlordPhone, tenantCount, totalRent, verified, verifiedAt, stageLabel, onVerified, onRequestFloat,
}: {
  landlordName: string;
  landlordPhone: string;
  tenantCount: number;
  totalRent: number;
  verified: boolean;
  verifiedAt?: string | null;
  /** When a float request is open or later, the current stage label replaces the buttons. */
  stageLabel?: string | null;
  onVerified: () => void;
  onRequestFloat: () => void;
}) {
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(() => readPending(landlordPhone)?.sentAt ?? null);
  const [now, setNow] = useState(Date.now());
  const [code, setCode] = useState(() => readPending(landlordPhone)?.code ?? '');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sentAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    const wake = () => setNow(Date.now());
    document.addEventListener('visibilitychange', wake);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', wake); };
  }, [sentAt]);

  // Persist the open entry so it survives remounts, app switches and refreshes.
  useEffect(() => {
    if (sentAt) writePending(landlordPhone, { sentAt, code });
  }, [sentAt, code, landlordPhone]);

  const cancel = () => { writePending(landlordPhone, null); setSentAt(null); setCode(''); setError(null); };

  useEffect(() => { if (verified) cancel(); }, [verified]); // eslint-disable-line react-hooks/exhaustive-deps

  if (stageLabel) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-300">
        <Clock className="h-3.5 w-3.5 shrink-0" /> {stageLabel}
      </div>
    );
  }

  const elapsed = sentAt ? Math.floor((now - sentAt) / 1000) : 0;
  const left = Math.max(0, CODE_TTL_SECONDS - elapsed);
  const cooldownLeft = Math.max(0, RESEND_COOLDOWN - elapsed);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const noPhone = landlordPhone.replace(/\D/g, '').length < 9;

  const send = async () => {
    setSending(true); setError(null);
    try {
      await sendLandlordPortfolioCode({ phone: landlordPhone, tenantCount });
      setSentAt(Date.now()); setNow(Date.now()); setCode('');
      toast({ title: 'Code sent to landlord', description: `6-digit code sent to ${landlordPhone}.` });
    } catch (e: any) {
      toast({ title: 'Could not send code', description: e.message, variant: 'destructive' });
    } finally { setSending(false); }
  };

  const check = async (value: string) => {
    if (left <= 0) { setError('This code has expired. Tap Resend code.'); return; }
    setChecking(true); setError(null);
    try {
      const res = await verifyLandlordPortfolioCode({ phone: landlordPhone, code: value });
      if (res.success === false) { setError(res.error); setCode(''); return; }
      writePending(landlordPhone, null);
      toast({ title: 'Landlord verified', description: `${landlordName} confirmed ${res.tenantCount} tenants.` });
      onVerified();
    } catch (e: any) {
      setError(e.message || 'Could not check the code');
    } finally { setChecking(false); }
  };

  if (verified) {
    return (
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
        <span className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-3.5 w-3.5" /> Landlord verified{verifiedAt ? ` · ${new Date(verifiedAt).toLocaleString()}` : ''}
        </span>
        <Button size="sm" className="h-9 gap-1.5 font-semibold" onClick={onRequestFloat}>
          <Banknote className="h-4 w-4" /> Request float
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
        <Badge variant="outline" className="w-fit text-[11px] font-normal">Draft · landlord not verified</Badge>
        <Button size="sm" variant={sentAt ? 'outline' : 'default'} className="h-9 gap-1.5 font-semibold"
          disabled={sending || noPhone || tenantCount === 0 || (!!sentAt && cooldownLeft > 0)}
          onClick={() => (sentAt ? send() : setConfirmOpen(true))}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : sentAt ? <RotateCw className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
          {sentAt ? (cooldownLeft > 0 ? `Resend code in ${cooldownLeft}s` : 'Resend code') : 'Verify landlord'}
        </Button>
      </div>
      {noPhone && <p className="text-xs text-destructive">Add the landlord phone number to verify.</p>}

      {sentAt && (
        <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            Enter the code {landlordName} reads to you.{' '}
            <span className={left > 0 ? 'text-foreground font-medium' : 'text-destructive font-medium'}>
              {left > 0 ? `Valid for ${fmt(left)}` : 'Code expired'}
            </span>
          </p>
          <InputOTP maxLength={6} value={code} disabled={checking || left <= 0}
            onChange={(v) => { setCode(v); setError(null); if (v.length === 6) check(v); }}>
            <InputOTPGroup>
              {[0, 1, 2, 3, 4, 5].map((i) => <InputOTPSlot key={i} index={i} />)}
            </InputOTPGroup>
          </InputOTP>
          {checking && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking code…</p>}
          {error && <p className="flex items-center gap-1.5 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}</p>}
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={checking} onClick={cancel}>Cancel</Button>
          </div>
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Verify landlord</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1.5 text-sm">
                <p>A 6-digit SMS code will go to the landlord's phone on file. Tenants are not sent any code.</p>
                <dl className="grid grid-cols-2 gap-1 rounded-md border p-2 text-foreground">
                  <dt className="text-muted-foreground">Landlord</dt><dd className="font-medium">{landlordName}</dd>
                  <dt className="text-muted-foreground">Phone</dt><dd className="font-medium">{landlordPhone}</dd>
                  <dt className="text-muted-foreground">Tenants</dt><dd className="font-medium">{tenantCount}</dd>
                  <dt className="text-muted-foreground">Monthly rent</dt><dd className="font-medium">{formatUGX(totalRent)}</dd>
                </dl>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmOpen(false); send(); }}>Send code</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
