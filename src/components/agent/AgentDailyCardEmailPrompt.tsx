import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Mail, Loader2, CheckCircle2 } from 'lucide-react';
import { hapticTap } from '@/lib/haptics';
import { toast } from 'sonner';

// Synthetic phone-based placeholder domains that are NOT real inboxes.
const PLACEHOLDER_DOMAIN_RE = /@(.*\.)?welile\.(user|agent|local|test)$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function isRealEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return false;
  if (PLACEHOLDER_DOMAIN_RE.test(e)) return false;
  return true;
}

/**
 * Prompt shown on the agent dashboard to agents who do not yet have a real
 * email on file. They must add one before they can receive the daily capacity
 * card by email. The moment they save a valid email, it is persisted to their
 * profile and their latest card is sent immediately.
 */
export function AgentDailyCardEmailPrompt() {
  const { user } = useAuth();
  const { profile, loading, refreshProfile } = useProfile();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  if (!user?.id) return null;
  // Don't flash the prompt before we know the email; hide once a real email exists.
  if (loading || isRealEmail(profile?.email)) return null;

  const handleSave = async () => {
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) {
      toast.error('Please enter a valid email address');
      return;
    }
    if (PLACEHOLDER_DOMAIN_RE.test(value)) {
      toast.error('Please enter your real email address');
      return;
    }
    hapticTap();
    setBusy(true);
    try {
      const { error } = await supabase.rpc('agent_set_own_contact_email', { p_email: value });
      if (error) throw error;
      await refreshProfile();
      toast.success('Email saved — sending your latest card now');
      // Fire off the agent's most recent card immediately. Best-effort.
      try {
        await supabase.functions.invoke('send-agent-capacity-card', {
          body: { agentId: user.id, force: true },
        });
      } catch {
        /* The daily cron will still deliver it tonight. */
      }
    } catch (err) {
      toast.error((err as Error)?.message || 'Could not save your email. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800/50 p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-400">
          <Mail className="h-5 w-5" />
        </div>
        <div className="space-y-0.5">
          <p className="text-sm font-bold text-amber-900 dark:text-amber-200">
            Add your email to get the daily card
          </p>
          <p className="text-xs text-amber-800/80 dark:text-amber-300/80">
            We email your capacity report card every evening. Add a real email to start receiving it — you'll get your latest card right away.
          </p>
        </div>
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <Input
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
          className="h-11 bg-background"
        />
        <Button
          onClick={handleSave}
          disabled={busy || !email.trim()}
          className="h-11 px-4 font-bold gap-2 shrink-0"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          Save & receive
        </Button>
      </div>
    </div>
  );
}