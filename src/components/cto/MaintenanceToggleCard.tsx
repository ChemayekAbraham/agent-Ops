import { useEffect, useState } from 'react';
import { Lock, Unlock, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

/**
 * CTO-only control to toggle the platform-wide maintenance lock.
 * Reads/writes `treasury_controls` rows: `maintenance_mode` and
 * `maintenance_message`. RLS allows CTO/CFO/super_admin to UPDATE.
 */
export default function MaintenanceToggleCard() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState(
    'Welile is under scheduled maintenance. Service resumes shortly.',
  );

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('treasury_controls')
      .select('control_key, enabled, value')
      .in('control_key', ['maintenance_mode', 'maintenance_message']);
    const rows = (data ?? []) as Array<{ control_key: string; enabled: boolean; value: string | null }>;
    const mode = rows.find((r) => r.control_key === 'maintenance_mode');
    const msg = rows.find((r) => r.control_key === 'maintenance_message');
    setActive(!!mode?.enabled);
    if (msg?.value) setMessage(msg.value);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const setMode = async (next: boolean) => {
    setBusy(true);
    const { error } = await supabase
      .from('treasury_controls')
      .update({ enabled: next, value: message, updated_at: new Date().toISOString() })
      .eq('control_key', 'maintenance_mode');
    if (error) {
      toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    } else {
      // Best-effort: also persist message text alongside.
      await supabase
        .from('treasury_controls')
        .update({ value: message, updated_at: new Date().toISOString() })
        .eq('control_key', 'maintenance_message');
      setActive(next);
      toast({
        title: next ? 'Maintenance ENABLED' : 'Maintenance disabled',
        description: next
          ? 'All non-privileged users now see the lock screen.'
          : 'Platform is live for all users.',
      });
    }
    setBusy(false);
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            {active ? <Lock className="h-4 w-4 text-destructive" /> : <Unlock className="h-4 w-4 text-green-600" />}
            Platform Maintenance Mode
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            When enabled, all users see a lock screen. CTO, CFO and super_admin keep access.
          </p>
        </div>
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
            active ? 'bg-destructive/10 text-destructive' : 'bg-green-500/10 text-green-600'
          }`}
        >
          {loading ? '...' : active ? 'ACTIVE' : 'OFF'}
        </span>
      </div>

      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={2}
        className="w-full text-sm rounded-lg border border-border bg-background p-2 mb-3"
        placeholder="Message shown to users on the lock screen"
      />

      <div className="flex gap-2">
        <Button
          variant={active ? 'outline' : 'destructive'}
          size="sm"
          disabled={busy || loading || active}
          onClick={() => void setMode(true)}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4 mr-1" />}
          Enable Maintenance
        </Button>
        <Button
          variant="default"
          size="sm"
          disabled={busy || loading || !active}
          onClick={() => void setMode(false)}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlock className="h-4 w-4 mr-1" />}
          Disable Maintenance
        </Button>
      </div>
    </div>
  );
}