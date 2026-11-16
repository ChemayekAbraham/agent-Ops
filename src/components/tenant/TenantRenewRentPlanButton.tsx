import { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { useMyRentRequest } from '@/hooks/useMyRentRequest';

const COMPLETED = new Set(['completed', 'fully_repaid']);

/** True when the tenant's latest rent request is a completed Rent Plan. */
export function isLatestPlanCompleted(status: string | null | undefined): boolean {
  return COMPLETED.has((status ?? '').toLowerCase());
}

/**
 * E128: "Renew my rent plan" on the tenant dashboard. Shown only when the tenant's latest
 * rent request is completed. Tap → rpc('tenant_request_renewal'); the server's `message`
 * (or its error) stays visible under the button.
 */
export function TenantRenewRentPlanButton() {
  const { data: latest } = useMyRentRequest();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  if (!latest || !isLatestPlanCompleted(latest.status)) return null;

  const ask = async () => {
    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      const { data, error } = await supabase.rpc('tenant_request_renewal');
      if (error) {
        setFailed(true);
        setMessage(error.message);
        return;
      }
      const msg = data && typeof data === 'object' && !Array.isArray(data) ? (data as { message?: unknown }).message : null;
      setMessage(typeof msg === 'string' && msg.trim() ? msg : 'Your renewal request was sent.');
    } catch (e) {
      setFailed(true);
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Button onClick={ask} disabled={busy} className="h-11 w-full gap-2 rounded-xl font-semibold">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Renew my rent plan
      </Button>
      {message && (
        <p role="status" className={failed ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
          {message}
        </p>
      )}
    </div>
  );
}
