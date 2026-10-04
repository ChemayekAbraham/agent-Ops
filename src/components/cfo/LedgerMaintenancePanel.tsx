import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ShieldCheck, Unlock, Lock, Loader2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

type State = {
  open_until: string | null;
  opened_at: string | null;
  reason: string | null;
  closed_at: string | null;
  closed_reason: string | null;
} | null;

function formatCountdown(ms: number) {
  if (ms <= 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function LedgerMaintenancePanel() {
  const [state, setState] = useState<State>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [minutes, setMinutes] = useState(30);
  const [reason, setReason] = useState('');
  const [closeReason, setCloseReason] = useState('');
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('ledger_maintenance_state' as any)
      .select('open_until, opened_at, reason, closed_at, closed_reason')
      .eq('id', true)
      .maybeSingle();
    if (error) {
      toast.error('Failed to load maintenance state');
    } else {
      setState(data as unknown as State);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const openUntilMs = state?.open_until ? new Date(state.open_until).getTime() : 0;
  const isOpen = openUntilMs > now;
  const remaining = isOpen ? openUntilMs - now : 0;

  // Auto-refresh state every 30s and right after countdown hits zero
  useEffect(() => {
    if (!isOpen && state?.open_until && openUntilMs <= now) load();
  }, [isOpen, openUntilMs, now, state?.open_until, load]);

  const handleOpen = async () => {
    if (reason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters');
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc('begin_ledger_maintenance' as any, {
      p_minutes: minutes,
      p_reason: reason.trim(),
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`Maintenance window open for ${minutes} min`);
    setReason('');
    load();
  };

  const handleClose = async () => {
    if (closeReason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters');
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc('end_ledger_maintenance' as any, {
      p_reason: closeReason.trim(),
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Maintenance window closed — ledger re-locked');
    setCloseReason('');
    load();
  };

  return (
    <Card className={isOpen ? 'border-amber-500/60 bg-amber-50/40 dark:bg-amber-950/20' : ''}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" />
          Ledger Maintenance
        </CardTitle>
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : isOpen ? (
          <Badge variant="destructive" className="gap-1">
            <Unlock className="h-3 w-3" /> OPEN · {formatCountdown(remaining)}
          </Badge>
        ) : (
          <Badge variant="secondary" className="gap-1">
            <Lock className="h-3 w-3" /> LOCKED
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          When open, raw SQL writes to <code>general_ledger</code> are permitted and auto-logged. Use only for emergency corrections — every prompt-driven correction should go through the normal RPC instead.
        </p>

        {isOpen ? (
          <div className="space-y-3 rounded-md border border-amber-500/30 bg-background/50 p-3">
            <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-medium">Window opened by maintenance</div>
                <div className="text-muted-foreground mt-0.5">{state?.reason}</div>
              </div>
            </div>
            <div>
              <Label htmlFor="close-reason" className="text-xs">Closing reason (≥ 10 chars)</Label>
              <Input
                id="close-reason"
                value={closeReason}
                onChange={(e) => setCloseReason(e.target.value)}
                placeholder="e.g. Reseed complete — wallets balanced"
                className="mt-1"
              />
            </div>
            <Button onClick={handleClose} disabled={busy} variant="destructive" className="w-full">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Lock className="h-4 w-4 mr-1" /> Close window now</>}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="minutes" className="text-xs">Duration (min, max 240)</Label>
                <Input
                  id="minutes"
                  type="number"
                  min={1}
                  max={240}
                  value={minutes}
                  onChange={(e) => setMinutes(Math.max(1, Math.min(240, Number(e.target.value) || 30)))}
                  className="mt-1"
                />
              </div>
              <div className="flex items-end">
                <div className="text-xs text-muted-foreground">
                  Auto-closes at deadline. CFO/Manager only.
                </div>
              </div>
            </div>
            <div>
              <Label htmlFor="open-reason" className="text-xs">Reason (≥ 10 chars)</Label>
              <Input
                id="open-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. CFO 2026-05-07 wipe legacy negatives — DEBT-001"
                className="mt-1"
              />
            </div>
            <Button onClick={handleOpen} disabled={busy || reason.trim().length < 10} className="w-full">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Unlock className="h-4 w-4 mr-1" /> Open maintenance window</>}
            </Button>
            {state?.closed_at && (
              <div className="text-[10px] text-muted-foreground border-t pt-2">
                Last closed {new Date(state.closed_at).toLocaleString()} — {state.closed_reason}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default LedgerMaintenancePanel;