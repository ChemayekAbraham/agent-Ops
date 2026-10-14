import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Gift } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { pendingForMe, type BonusPending } from './api';

const SNOOZE_MS = 60 * 60 * 1000;
const key = (uid: string, pid: string) => `bonus-prompt-snooze:${uid}:${pid}`;

function snoozed(uid: string, pid: string): boolean {
  try { return Number(localStorage.getItem(key(uid, pid)) || 0) > Date.now(); } catch { return false; }
}

const HEADINGS: Record<BonusPending['kind'], string> = {
  approve: 'Bonus pool awaiting your approval',
  pay: 'Approved bonus pool ready to pay',
  rework: 'Bonus pool returned for rework',
};

/** Fails open: any error shows nothing. Rendered only when no payroll prompt is showing. */
export function BonusPromptGate() {
  const [item, setItem] = useState<BonusPending | null>(null);
  const [uid, setUid] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const { data } = await supabase.auth.getUser();
      const u = data.user?.id;
      if (!u) { setItem(null); return; }
      setUid(u);
      const rows = await pendingForMe();
      setItem(rows.find((r) => !snoozed(u, r.pool_id)) ?? null);
    } catch { setItem(null); }
  }, []);

  useEffect(() => { void load(); }, [location.pathname, load]);

  if (!item || !uid) return null;
  if (location.pathname === `/hr/bonuses/${item.pool_id}`) return null;

  const later = () => {
    try { localStorage.setItem(key(uid, item.pool_id), String(Date.now() + SNOOZE_MS)); } catch { /* ignore */ }
    void load();
  };
  const open = () => { const t = `/hr/bonuses/${item.pool_id}`; setItem(null); navigate(t); };

  return (
    <Dialog open onOpenChange={() => { /* cannot be dismissed */ }}>
      <DialogContent className="sm:max-w-lg [&>button]:hidden"
        onEscapeKeyDown={(e) => e.preventDefault()} onPointerDownOutside={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Gift className="h-5 w-5 text-primary" /> {HEADINGS[item.kind]}</DialogTitle>
          <DialogDescription>{item.title}</DialogDescription>
        </DialogHeader>
        <p className="text-lg font-bold text-primary">{formatUGX(Number(item.allocated))} · {item.people} people</p>
        {item.kind === 'rework' && item.return_note && (
          <p className="whitespace-pre-wrap rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-800">{item.return_note}</p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button onClick={open}>{item.kind === 'rework' ? 'Open' : 'Review'}</Button>
          <Button variant="outline" onClick={later}>Later</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default BonusPromptGate;
