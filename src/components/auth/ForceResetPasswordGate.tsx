import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Lock, Loader2, ShieldAlert, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';

/**
 * Global gate: when a user's `profiles.must_change_password` flag is TRUE
 * (e.g. after the CTO issues a temporary password), this blocks the entire
 * app with a mandatory reset screen until the user sets a new password.
 */
export default function ForceResetPasswordGate() {
  const { user } = useAuth();
  const [required, setRequired] = useState(false);
  const [checked, setChecked] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const checkFlag = useCallback(async (userId: string) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('must_change_password')
      .eq('id', userId)
      .maybeSingle();
    if (!error) {
      setRequired(!!data?.must_change_password);
    }
    setChecked(true);
  }, []);

  useEffect(() => {
    if (!user?.id) {
      setRequired(false);
      setChecked(false);
      return;
    }
    void checkFlag(user.id);
  }, [user?.id, checkFlag]);

  useEffect(() => {
    if (required) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [required]);

  const isValid =
    newPassword.length >= 8 &&
    newPassword === confirmPassword;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || !user?.id) return;
    setSaving(true);
    try {
      const { error: pwErr } = await supabase.auth.updateUser({ password: newPassword });
      if (pwErr) {
        const weak = /weak|pwned|breach|data breach|known/i.test(pwErr.message || '');
        toast.error(weak ? 'Choose a stronger password' : 'Failed to update password', {
          description: weak
            ? 'This password appeared in known data breaches. Please choose a different one.'
            : pwErr.message,
        });
        setSaving(false);
        return;
      }

      // Fire-and-forget: the trigger-based IP capture used elsewhere can't
      // see this write (it goes through GoTrue directly, never PostgREST),
      // so this edge function call, from this same browser request, is the
      // only place the real IP is available.
      supabase.functions.invoke('record-password-change').catch(() => {});

      const { error: flagErr } = await supabase
        .from('profiles')
        .update({ must_change_password: false })
        .eq('id', user.id);
      if (flagErr) {
        // Password did change; surface but still clear the gate to avoid lockout.
        console.warn('[ForceResetPasswordGate] Could not clear flag:', flagErr.message);
      }

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'forced_password_reset_completed',
        table_name: 'profiles',
        record_id: user.id,
        metadata: { completed_at: new Date().toISOString() },
      }).then(() => {}, () => {});

      toast.success('Password updated', { description: 'You can now use your new password.' });
      setRequired(false);
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      toast.error('Something went wrong', { description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  if (!user?.id || !checked || !required) return null;

  return createPortal(
    <div className="fixed inset-0 z-[200] grid h-screen w-screen place-items-center overflow-y-auto bg-background/95 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-3">
          <div className="mx-auto w-16 h-16 rounded-2xl bg-destructive/10 border-2 border-destructive/20 flex items-center justify-center">
            <ShieldAlert className="h-8 w-8 text-destructive" />
          </div>
          <div>
            <h1 className="text-xl font-black text-foreground">Set a New Password</h1>
            <p className="text-sm text-muted-foreground mt-1">
              You signed in with a temporary password. For your security, you must set your
              own new password before you can continue.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="rounded-2xl border border-border/50 bg-card p-5 shadow-xl space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="frp-new" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                New Password
              </Label>
              <Input
                id="frp-new"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min 8 characters"
                className="h-12 rounded-xl"
                autoFocus
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="frp-confirm" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Confirm Password
              </Label>
              <Input
                id="frp-confirm"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                className="h-12 rounded-xl"
                autoComplete="new-password"
              />
              {confirmPassword && newPassword !== confirmPassword && (
                <p className="text-xs text-destructive">Passwords do not match</p>
              )}
            </div>
            <Button type="submit" disabled={!isValid || saving} className="w-full h-12 rounded-xl font-bold gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
              Set New Password
            </Button>
          </div>
        </form>

        <p className="text-center text-[11px] text-muted-foreground/60 flex items-center justify-center gap-1">
          <KeyRound className="h-3 w-3" /> This step is required and cannot be skipped
        </p>
      </div>
    </div>,
    document.body
  );
}
