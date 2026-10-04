import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface ForcePasswordChangeProps {
  userId: string;
  onPasswordChanged: () => void;
}

export default function ForcePasswordChange({ userId, onPasswordChanged }: ForcePasswordChangeProps) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changing, setChanging] = useState(false);
  const [mounted, setMounted] = useState(false);

  const isValid = newPassword.length >= 8 && newPassword === confirmPassword && newPassword !== 'WelileManager';

  useEffect(() => {
    setMounted(true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    setChanging(true);
    try {
      // Use the staff access password RPC (not auth password)
      const { error } = await supabase.rpc('set_staff_access_password', {
        p_user_id: userId,
        p_new_password: newPassword,
      });

      if (error) {
        toast.error('Failed to update access password', { description: error.message });
        setChanging(false);
        return;
      }

      // Audit log
      await supabase.from('audit_logs').insert({
        user_id: userId,
        action_type: 'staff_password_changed',
        metadata: { changed_at: new Date().toISOString() },
      });

      toast.success('Access password updated successfully');
      onPasswordChanged();
    } catch {
      toast.error('Something went wrong');
    } finally {
      setChanging(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] grid h-screen w-screen place-items-center overflow-y-auto bg-background/95 p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-3">
          <div className="mx-auto w-16 h-16 rounded-2xl bg-destructive/10 border-2 border-destructive/20 flex items-center justify-center">
            <ShieldAlert className="h-8 w-8 text-destructive" />
          </div>
          <div>
            <h1 className="text-xl font-black text-foreground">Set Your Access Password</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Create a personal access password for the manager portal.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="rounded-2xl border border-border/50 bg-card p-5 shadow-xl space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-pw" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                New Access Password
              </Label>
              <Input
                id="new-pw"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min 8 characters"
                className="h-12 rounded-xl"
                autoFocus
              />
              {newPassword === 'WelileManager' && (
                <p className="text-xs text-destructive">Cannot reuse the temporary password</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-pw" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Confirm Password
              </Label>
              <Input
                id="confirm-pw"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                className="h-12 rounded-xl"
              />
              {confirmPassword && newPassword !== confirmPassword && (
                <p className="text-xs text-destructive">Passwords do not match</p>
              )}
            </div>
            <Button type="submit" disabled={!isValid || changing} className="w-full h-12 rounded-xl font-bold gap-2">
              {changing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
              Set Access Password
            </Button>
          </div>
        </form>

        <p className="text-center text-[11px] text-muted-foreground/50">
          This action is logged for security auditing
        </p>
      </div>
    </div>,
    document.body
  );
}
