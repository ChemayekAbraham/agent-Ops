import { useCallback, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { renewalErrorMessage } from '@/lib/renewalAdvice';

async function callOtp(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('rent-renewal-otp', { body });
  const msg = (data as any)?.error;
  if (msg) throw new Error(msg);
  if (error) {
    let detail = '';
    try { detail = (await (error as any).context?.json())?.error ?? ''; } catch { /* ignore */ }
    throw new Error(detail || error.message || 'Request failed');
  }
  return data as any;
}

/** The rent and days the tenant is confirming. Leave both out for a renewal at the same rent and days. */
export interface RenewalConsentFigures {
  newRent?: number | null;
  newDays?: number | null;
  /** the server's daily payment for these figures, shown to the agent next to the code box (display only) */
  dailyRepayment?: number | null;
}

const figuresBody = (f?: RenewalConsentFigures) => ({
  ...(f?.newRent != null ? { new_rent_amount: f.newRent } : {}),
  ...(f?.newDays != null ? { new_days: f.newDays } : {}),
});

/**
 * Tenant consent step for renewing a completed Rent Plan. The backend refuses
 * the renewal unless this code was confirmed, so this is the only way through.
 * The code is bound to the rent AND days passed in `figures`: pass the same figures
 * to renew_rent_request, or the backend refuses the renewal (RENEWAL_OTP_MISMATCH).
 */
export function useRenewalOtp() {
  const [state, setState] = useState<{ prevId: string; tenantName: string; figures?: RenewalConsentFigures } | null>(null);
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setState(null); setCode(''); setSentTo(null); setError(null);
  };

  const send = async (prevId: string, figures?: RenewalConsentFigures) => {
    setBusy(true); setError(null);
    try {
      const r = await callOtp({ action: 'send', prev_request_id: prevId, ...figuresBody(figures) });
      setSentTo(r.phone_masked);
    } catch (e: any) { setError(renewalErrorMessage(e)); } finally { setBusy(false); }
  };

  const requestConsent = useCallback((prevId: string, tenantName: string, figures?: RenewalConsentFigures) => {
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setState({ prevId, tenantName, figures });
      void send(prevId, figures);
    });
  }, []);

  const verify = async () => {
    if (!state) return;
    setBusy(true); setError(null);
    try {
      await callOtp({ action: 'verify', prev_request_id: state.prevId, code, ...figuresBody(state.figures) });
      finish(true);
    } catch (e: any) { setError(renewalErrorMessage(e)); } finally { setBusy(false); }
  };

  const dialog = (
    <Dialog open={!!state} onOpenChange={(o) => { if (!o && !busy) finish(false); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Tenant confirmation code</DialogTitle>
          <DialogDescription>
            {sentTo
              ? `A code was sent to ${state?.tenantName || 'the tenant'} on ${sentTo}. Ask the tenant for the code to confirm this Rent Plan renewal.`
              : `Sending a confirmation code to ${state?.tenantName || 'the tenant'}…`}
          </DialogDescription>
        </DialogHeader>
        {state?.figures?.newRent != null && state.figures.newDays != null && (
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm" aria-label="What the tenant is agreeing to">
            <p className="text-xs text-muted-foreground">The tenant is agreeing to</p>
            <p className="font-semibold">{formatUGX(state.figures.newRent)} for {state.figures.newDays} days</p>
            {state.figures.dailyRepayment != null && <p className="text-xs text-muted-foreground">{formatUGX(state.figures.dailyRepayment)} a day. The same figures are in the text message.</p>}
          </div>
        )}
        <Input
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="6-digit code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          className="text-center text-lg tracking-widest"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" disabled={busy} onClick={() => state && send(state.prevId, state.figures)}>
            Resend code
          </Button>
          <Button className="flex-1" disabled={busy || code.length !== 6} onClick={verify}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  return { requestConsent, dialog };
}
