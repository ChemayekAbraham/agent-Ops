import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type PendingNotice = {
  notice_id: string;
  staff_id: string;
  staff_ref: string | null;
  full_name: string | null;
  birthday_on: string | null;
  turning_age: number | null;
};

const POLL_MS = 10 * 60 * 1000;

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

  return (
    <AlertDialog open>
      {/* AlertDialog never closes on outside click; Escape is blocked explicitly below. */}
      <AlertDialogContent onEscapeKeyDown={(e) => e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Staff birthday notice</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-1 text-sm">
              <p className="font-medium text-foreground">
                {current.full_name ?? 'Staff member'}
                {current.staff_ref ? ` · ${current.staff_ref}` : ''}
              </p>
              <p>Turning {current.turning_age ?? '—'}</p>
              <p>{formatDate(current.birthday_on)}</p>
              {pending.length > 1 && (
                <p className="text-xs text-muted-foreground">
                  {pending.length - 1} more notice{pending.length - 1 === 1 ? '' : 's'} after this one.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button onClick={() => void acknowledge()} disabled={busy}>
            Acknowledge
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
