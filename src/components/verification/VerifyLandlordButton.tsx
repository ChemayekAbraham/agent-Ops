import { useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Building, CheckCircle2, Loader2, ShieldCheck, Lock } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { hapticTap, hapticSuccess } from '@/lib/haptics';
import { setLandlordVerification } from '@/lib/landlord-ops/verification';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

interface VerifyLandlordButtonProps {
  landlordId: string;
  landlordName: string;
  verified?: boolean;
  readyToReceive?: boolean;
  onVerified: () => void;
}

export function VerifyLandlordButton({ 
  landlordId, 
  landlordName,
  verified, 
  readyToReceive,
  onVerified
}: VerifyLandlordButtonProps) {
  const { user, role } = useAuth();
  const [loading, setLoading] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState(false);
  const [action, setAction] = useState<'verify' | 'ready'>('verify');
  const [pressProgress, setPressProgress] = useState(0);

  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const isManager = role === 'manager';

  const handleVerify = async () => {
    if (!user || !isManager) return;
    hapticTap();
    setLoading(true);

    try {
      await setLandlordVerification({
        landlordId,
        status: 'verified',
        reason: 'Verified by Landlord Operations after reviewing the landlord record',
        source: 'ops_manual',
      });

      toast.success(`Landlord ${landlordName} verified successfully!`);
      setConfirmDialog(false);
      onVerified();
    } catch (error: any) {
      toast.error(error.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const handleMarkReady = async () => {
    if (!user || !isManager) return;
    hapticTap();
    setLoading(true);

    try {
      await setLandlordVerification({
        landlordId,
        status: 'verified',
        reason: 'Verified and marked ready to receive payments by Landlord Operations',
        source: 'ops_manual',
      });

      const { error } = await supabase
        .from('landlords')
        .update({ ready_to_receive: true })
        .eq('id', landlordId);

      if (error) throw error;

      toast.success(`Landlord ${landlordName} is now ready to receive payments!`);
      setConfirmDialog(false);
      onVerified();
    } catch (error: any) {
      toast.error(error.message || 'Failed to update landlord status');
    } finally {
      setLoading(false);
    }
  };

  if (!isManager) {
    // Show status badges for non-managers
    if (readyToReceive) {
      return (
        <Badge variant="outline" className="gap-1 bg-success/10 text-success border-success/30">
          <ShieldCheck className="h-3 w-3" />
          Ready to Receive
        </Badge>
      );
    }
    if (verified) {
      return (
        <Badge variant="outline" className="gap-1 bg-primary/10 text-primary border-primary/30">
          <CheckCircle2 className="h-3 w-3" />
          Verified
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="gap-1 bg-muted text-muted-foreground">
        Pending Verification
      </Badge>
    );
  }

  const LONG_PRESS_MS = 1200;

  const clearPressTimers = useCallback(() => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    if (progressTimer.current) clearInterval(progressTimer.current);
    pressTimer.current = null;
    progressTimer.current = null;
    setPressProgress(0);
  }, []);

  const startLongPress = useCallback((targetAction: 'verify' | 'ready') => {
    clearPressTimers();
    setPressProgress(0);
    const start = Date.now();
    progressTimer.current = setInterval(() => {
      const elapsed = Date.now() - start;
      const pct = Math.min(elapsed / LONG_PRESS_MS, 1);
      setPressProgress(pct);
    }, 30);
    pressTimer.current = setTimeout(() => {
      clearPressTimers();
      hapticSuccess();
      setAction(targetAction);
      setConfirmDialog(true);
    }, LONG_PRESS_MS);
  }, [clearPressTimers]);

  // Manager view with action buttons
  if (readyToReceive) {
    return (
      <Badge variant="outline" className="gap-1 bg-success/10 text-success border-success/30">
        <ShieldCheck className="h-3 w-3" />
        Ready to Receive
      </Badge>
    );
  }

  return (
    <>
      <div className="flex gap-2">
        {!verified && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 relative overflow-hidden select-none touch-none"
            onPointerDown={() => startLongPress('verify')}
            onPointerUp={clearPressTimers}
            onPointerLeave={clearPressTimers}
            onPointerCancel={clearPressTimers}
            onContextMenu={(e) => e.preventDefault()}
          >
            <span
              className="absolute inset-0 bg-primary/10 origin-left transition-none"
              style={{ transform: `scaleX(${pressProgress})` }}
            />
            <Lock className="h-3.5 w-3.5 relative z-10" />
            <span className="relative z-10">Hold to Verify</span>
          </Button>
        )}
        <Button
          size="sm"
          variant="success"
          className="gap-1.5 relative overflow-hidden select-none touch-none"
          onPointerDown={() => startLongPress('ready')}
          onPointerUp={clearPressTimers}
          onPointerLeave={clearPressTimers}
          onPointerCancel={clearPressTimers}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span
            className="absolute inset-0 bg-success/20 origin-left transition-none"
            style={{ transform: `scaleX(${pressProgress})` }}
          />
          <ShieldCheck className="h-4 w-4 relative z-10" />
          <span className="relative z-10">
            {verified ? 'Hold to Mark Ready' : 'Hold to Verify & Ready'}
          </span>
        </Button>
      </div>

      <Dialog open={confirmDialog} onOpenChange={setConfirmDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building className="h-5 w-5 text-primary" />
              {action === 'verify' ? 'Verify Landlord' : 'Ready to Receive'}
            </DialogTitle>
            <DialogDescription>
              {action === 'verify' 
                ? `Confirm that landlord "${landlordName}" has been verified?`
                : `Mark landlord "${landlordName}" as ready to receive rent payments from supporters?`
              }
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex gap-2">
            <Button 
              variant="outline" 
              onClick={() => setConfirmDialog(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              variant="success"
              onClick={action === 'verify' ? handleVerify : handleMarkReady}
              disabled={loading}
              className="gap-2"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
