import { useState } from 'react';
import { motion } from 'framer-motion';
import { Lock, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UserAvatar } from '@/components/UserAvatar';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface SupporterInactivityLockProps {
  userEmail: string;
  fullName?: string;
  avatarUrl?: string | null;
  onUnlock: () => void;
}

export function SupporterInactivityLock({
  userEmail,
  fullName,
  avatarUrl,
  onUnlock,
}: SupporterInactivityLockProps) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const handleUnlock = async () => {
    if (!password.trim()) {
      toast({ title: 'Enter your password', variant: 'destructive' });
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: userEmail,
        password,
      });
      if (error) {
        toast({ title: 'Incorrect password', description: 'Please try again.', variant: 'destructive' });
        setPassword('');
      } else {
        onUnlock();
      }
    } catch {
      toast({ title: 'Something went wrong', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-3xl backdrop-saturate-150"
    >
      <div className="flex flex-col items-center gap-5 px-6 py-10 max-w-sm w-full text-center">
        {/* Avatar */}
        <UserAvatar avatarUrl={avatarUrl} fullName={fullName} size="lg" />

        {/* Lock icon badge */}
        <div className="p-3 rounded-full bg-muted/60">
          <Lock className="h-6 w-6 text-muted-foreground" />
        </div>

        {/* Text */}
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold text-foreground">Session Locked</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            For your security, your Partner dashboard has been locked due to inactivity. Enter your password to continue.
          </p>
        </div>

        {/* Password input */}
        <div className="w-full space-y-3">
          <Input
            type="password"
            placeholder="Enter your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
            autoFocus
            className="h-12 text-center text-base rounded-xl"
          />

          <Button
            onClick={handleUnlock}
            disabled={loading || !password.trim()}
            className="w-full h-12 rounded-xl gap-2 text-base font-bold"
          >
            <LogIn className="h-4.5 w-4.5" />
            {loading ? 'Verifying…' : 'Unlock'}
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground/70">
          {fullName ? `Signed in as ${fullName}` : userEmail}
        </p>
      </div>
    </motion.div>
  );
}
