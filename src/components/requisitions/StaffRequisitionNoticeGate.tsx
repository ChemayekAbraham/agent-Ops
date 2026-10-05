import { useCallback, useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, Bell } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

/**
 * Blocking requisition notice — for the person who raised a requisition.
 * Shows each unacknowledged notice from `staff_requisition_my_notices()`
 * until they press OK (`staff_requisition_notice_ack`).
 *
 * FAIL OPEN: renders only when the rpc succeeds AND returns rows. Any error,
 * timeout or offline state leaves the app fully usable.
 */

const POLL_MS = 5 * 60 * 1000;

type Kind = 'moved' | 'amount_changed' | 'declined' | 'returned' | 'paid';

interface Notice {
  id: string;
  requisition_id: string;
  requisition_code: string;
  kind: Kind;
  title: string;
  body: string;
  created_at: string;
}

const ACCENT: Record<Kind, string> = {
  paid: 'border-l-4 border-l-emerald-600',
  declined: 'border-l-4 border-l-destructive',
  returned: 'border-l-4 border-l-blue-600',
  moved: '',
  amount_changed: '',
};

const ICON_TONE: Record<Kind, string> = {
  paid: 'text-emerald-600',
  declined: 'text-destructive',
  returned: 'text-blue-600',
  moved: 'text-muted-foreground',
  amount_changed: 'text-muted-foreground',
};

function fmtKampala(iso: string) {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short',
  });
}

export function StaffRequisitionNoticeGate({ enabled = true }: { enabled?: boolean }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc('staff_requisition_my_notices' as never);
      if (error) { setNotices([]); return; }
      setNotices(Array.isArray(data) ? (data as unknown as Notice[]) : []);
    } catch {
      // Fail open — never block the product on a gate that cannot read itself.
      setNotices([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  const notice = notices[0];
  if (!enabled || !notice) return null;

  const ack = async () => {
    setWorking(true);
    const { error } = await supabase.rpc('staff_requisition_notice_ack' as never, { p_notice_id: notice.id } as never);
    setWorking(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setNotices((prev) => prev.slice(1));
  };

  const kind = (notice.kind in ACCENT ? notice.kind : 'moved') as Kind;

  return (
    <Dialog open onOpenChange={() => { /* cannot be dismissed */ }}>
      <DialogContent
        className={cn('max-h-[90vh] overflow-y-auto sm:max-w-md [&>button]:hidden', ACCENT[kind])}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bell className={cn('h-5 w-5', ICON_TONE[kind])} /> {notice.title}
          </DialogTitle>
          <DialogDescription>
            {notice.requisition_code} • {fmtKampala(notice.created_at)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {notices.length > 1 && (
            <p className="text-xs font-medium text-muted-foreground">1 of {notices.length}</p>
          )}
          <p className="whitespace-pre-wrap text-sm">{notice.body}</p>
          <div className="flex justify-end pt-1">
            <Button onClick={() => void ack()} disabled={working}>
              {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              OK
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default StaffRequisitionNoticeGate;
