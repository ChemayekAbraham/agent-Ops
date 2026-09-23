import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Cake } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

type PendingNotice = {
  notice_id: string;
  staff_id: string;
  staff_ref: string | null;
  full_name: string | null;
  birthday_on: string | null;
  turning_age: number | null;
};

const POLL_MS = 10 * 60 * 1000;

const INTERNAL_STAFF_ROLES = [
  'hr', 'ceo', 'coo', 'cfo', 'cto', 'cmo', 'crm', 'employee', 'manager',
  'operations', 'super_admin', 'admin', 'access_admin',
  'tenant_ops', 'landlord_ops', 'agent_ops', 'financial_ops', 'partner_ops',
] as const;

function formatDate(value: string | null) {
  if (!value) return '—';
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
}

export default function HRBirthdayNoticeDialog() {
  const { user, roles } = useAuth();
  const [pending, setPending] = useState<PendingNotice[]>([]);
  const [busy, setBusy] = useState(false);

  // Only internal staff can ever be a birthday-notice recipient. Everyone else
  // (tenants, agents, landlords, supporters) must never fetch at all.
  const isInternalStaff = useMemo(
    () => (roles ?? []).some((r) => (INTERNAL_STAFF_ROLES as readonly string[]).includes(r as string)),
    [roles],
  );
  const canFetch = !!user && isInternalStaff;

  const load = useCallback(async () => {
    if (!canFetch) return;
    const { data, error } = await supabase.rpc('hr_birthday_pending' as never);
    if (error) {
      setPending([]);
      return;
    }
    setPending(((data ?? []) as unknown as PendingNotice[]));
  }, [canFetch]);

  useEffect(() => {
    if (!canFetch) return;
    void load();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [canFetch, load]);

  const current = pending[0];
  if (!canFetch || !current) return null;

  const acknowledge = async () => {
    setBusy(true);
    const { error } = await supabase.rpc('hr_birthday_acknowledge' as never, {
      p_notice_id: current.notice_id,
    } as never);
    if (error) {
      const message = error.message ?? '';
      const lower = message.toLowerCase();
      // 'notice not found or already acknowledged' means another device handled it — treat as success.
      if (lower.includes('already acknowledged') || lower.includes('not found')) {
        setBusy(false);
        await load();
        return;
      }
      toast.error(message);
      setBusy(false);
      return;
    }
    setBusy(false);
    await load();
  };

  const snooze = async () => {
    setBusy(true);
    const { error } = await supabase.rpc('hr_birthday_snooze' as never, {
      p_notice_id: current.notice_id,
      p_minutes: 120,
    } as never);
    if (error) {
      const lower = (error.message ?? '').toLowerCase();
      // Another device already handled it — nothing left to snooze, treat as success.
      if (lower.includes('already acknowledged') || lower.includes('not found')) {
        setBusy(false);
        await load();
        return;
      }
      toast.error(error.message);
      setBusy(false);
      return;
    }
    setBusy(false);
    await load();
  };

  return (
    // Radix Dialog primitives (portals to document.body, overlay + content in the
    // z-50 band, body scroll locked by Radix while open), close control hidden and
    // escape / outside interaction prevented. 100dvh with a 100vh fallback so the
    // actions stay above the fold under mobile browser chrome.
    <Dialog open onOpenChange={() => { /* cannot be dismissed */ }}>
      <DialogContent
        style={{ height: '100vh', maxHeight: '100dvh' }}
        className="left-0 top-0 h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none [&>button]:hidden"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div
          className="flex h-full flex-col items-center justify-center overflow-y-auto px-6 text-center"
          style={{
            paddingTop: 'max(1.5rem, env(safe-area-inset-top))',
            paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))',
          }}
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Cake className="h-8 w-8" aria-hidden />
          </span>

          <DialogTitle className="mt-6 text-lg font-semibold uppercase tracking-wide text-muted-foreground">
            Staff birthday
          </DialogTitle>

          <DialogDescription className="sr-only">
            A staff birthday notice that must be acknowledged before continuing.
          </DialogDescription>

          <p className="mt-4 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
            {current.full_name ?? 'Staff member'}
          </p>

          {current.staff_ref && (
            <p className="mt-2 text-xl font-medium text-muted-foreground sm:text-2xl">{current.staff_ref}</p>
          )}

          <p className="mt-6 text-2xl font-semibold sm:text-3xl">
            Turning {current.turning_age ?? '—'}
          </p>

          <p className="mt-2 text-lg text-muted-foreground sm:text-xl">{formatDate(current.birthday_on)}</p>

          {pending.length > 1 && (
            <p className="mt-6 text-sm text-muted-foreground">
              {pending.length - 1} more notice{pending.length - 1 === 1 ? '' : 's'} after this one.
            </p>
          )}

          <div className="mt-8 flex w-full max-w-sm flex-col items-center gap-3">
            <Button size="lg" className="h-14 w-full text-base" onClick={() => void acknowledge()} disabled={busy}>
              Seen
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-12 w-full text-base"
              onClick={() => void snooze()}
              disabled={busy}
            >
              Remind me in 2 hours
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
