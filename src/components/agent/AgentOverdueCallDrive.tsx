/**
 * Aggressive overdue-tenant call drive.
 *
 * Every time an agent opens the app, any tenant who is behind is put in front of
 * them as a full-stop prompt with the tenant's number as a one-tap dial link.
 * It cannot be swiped away by accident, it comes back every few minutes while
 * anyone is still behind, and the same list is emailed to the agent once a day.
 *
 * Read-only: the numbers come from `agent_arrears_overview` (SECURITY DEFINER),
 * the same source as the arrears card. Nothing here writes money state.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useProfile } from '@/hooks/useProfile';
import { useAgentArrears, type AgentArrearsTenant } from '@/hooks/useAgentArrears';
import { formatUGX } from '@/lib/rentCalculations';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { PhoneCall, AlertTriangle } from 'lucide-react';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';

/** How long a "I'm calling now" dismissal holds before the prompt returns. */
const SNOOZE_MS = 10 * 60 * 1000;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PLACEHOLDER_DOMAIN_RE = /@(.*\.)?welile\.(user|agent|local|test)$/i;
const isRealEmail = (e?: string | null) =>
  !!e && EMAIL_RE.test(e.trim()) && !PLACEHOLDER_DOMAIN_RE.test(e.trim());

const today = () => new Date().toISOString().slice(0, 10);

export function AgentOverdueCallDrive({ agentId }: { agentId: string }) {
  const { profile } = useProfile();
  const { data } = useAgentArrears(agentId);
  const [open, setOpen] = useState(false);
  const [called, setCalled] = useState<string[]>([]);
  const snoozedUntil = useRef(0);
  const emailedRef = useRef(false);

  const tenants = useMemo<AgentArrearsTenant[]>(
    () =>
      (data?.tenants ?? [])
        .filter((t) => (t.arrears_ugx || 0) > 0)
        .sort((a, b) => (b.arrears_ugx || 0) - (a.arrears_ugx || 0)),
    [data],
  );
  const arrearsTotal = tenants.reduce((s, t) => s + (t.arrears_ugx || 0), 0);

  // Fire on arrival (every app open) and keep coming back while anyone is behind.
  useEffect(() => {
    if (!tenants.length) {
      setOpen(false);
      return;
    }
    const tick = () => {
      if (Date.now() >= snoozedUntil.current) setOpen(true);
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [tenants.length]);

  // Once-a-day email of the same list, to this agent only.
  useEffect(() => {
    if (!tenants.length || emailedRef.current) return;
    if (!isRealEmail(profile?.email)) return;
    const key = `welile-overdue-call-email-${agentId}-${today()}`;
    if (localStorage.getItem(key)) return;
    emailedRef.current = true;
    localStorage.setItem(key, '1');
    supabase.functions
      .invoke('send-transactional-email', {
        body: {
          templateName: 'agent-overdue-call-drive',
          recipientEmail: profile?.email,
          idempotencyKey: `agent-overdue-call-${agentId}-${today()}`,
          templateData: {
            agent_name: profile?.full_name?.split(' ')[0] ?? 'there',
            tenants_behind: tenants.length,
            arrears_total: arrearsTotal,
            tenants: tenants.slice(0, 25).map((t) => ({
              name: t.tenant_name ?? 'Tenant',
              phone: t.tenant_phone ?? '',
              arrears: t.arrears_ugx,
              days_behind: t.days_behind,
            })),
          },
        },
      })
      .catch(() => {
        /* Best effort — the in-app prompt is the primary channel. */
      });
  }, [tenants, arrearsTotal, agentId, profile?.email, profile?.full_name]);

  if (!tenants.length) return null;

  const snooze = () => {
    hapticTap();
    snoozedUntil.current = Date.now() + SNOOZE_MS;
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) snooze(); }}>
      <DialogContent
        className="max-w-md gap-0 overflow-hidden border-2 border-destructive p-0"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="animate-pulse bg-destructive px-5 py-4 text-white">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-6 w-6 shrink-0" />
            <div>
              <p className="text-lg font-black leading-tight">
                Call these {tenants.length} tenant{tenants.length === 1 ? '' : 's'} NOW
              </p>
              <p className="text-sm font-semibold opacity-90">
                {formatUGX(arrearsTotal)} overdue. Tap a number and ask them to pay today.
              </p>
            </div>
          </div>
        </div>

        <div className="max-h-[55vh] space-y-2 overflow-y-auto p-4">
          {tenants.map((t) => {
            const done = called.includes(t.rent_request_id);
            return (
              <div
                key={t.rent_request_id}
                className={cn(
                  'rounded-xl border p-3',
                  done ? 'border-success/40 bg-success/5' : 'border-destructive/40 bg-destructive/5',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{t.tenant_name ?? 'Tenant'}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.days_behind} day{t.days_behind === 1 ? '' : 's'} behind
                    </p>
                  </div>
                  <p className="shrink-0 text-sm font-black text-destructive">
                    {formatUGX(t.arrears_ugx)}
                  </p>
                </div>
                {t.tenant_phone ? (
                  <a
                    href={`tel:${t.tenant_phone}`}
                    className="mt-2 block"
                    onClick={() => {
                      hapticTap();
                      setCalled((c) => (c.includes(t.rent_request_id) ? c : [...c, t.rent_request_id]));
                    }}
                  >
                    <Button
                      className={cn(
                        'h-12 w-full gap-2 text-base font-black text-white',
                        done ? 'bg-success hover:bg-success/90' : 'bg-destructive hover:bg-destructive/90',
                      )}
                    >
                      <PhoneCall className="h-5 w-5" />
                      {done ? `Call again — ${t.tenant_phone}` : `Call ${t.tenant_phone} now`}
                    </Button>
                  </a>
                ) : (
                  <p className="mt-2 text-xs font-semibold text-muted-foreground">
                    No phone number on file — visit this tenant today.
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-t border-border/50 p-3">
          <Button variant="outline" className="h-11 w-full font-bold" onClick={snooze}>
            I am calling them now
          </Button>
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            This keeps coming back until these tenants pay.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
