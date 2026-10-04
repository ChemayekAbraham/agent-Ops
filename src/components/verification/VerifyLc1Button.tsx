import { useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, Loader2, ShieldCheck, Lock, Landmark } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { hapticTap, hapticSuccess } from '@/lib/haptics';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

interface VerifyLc1ButtonProps {
  lc1Id: string;
  lc1Name: string;
  verified?: boolean | null;
  onVerified: () => void;
}

/**
 * Manager-only LC1 chairperson verification control.
 *
 * Mirrors {@link VerifyLandlordButton}: a hold-to-confirm (long-press) button
 * that flips `lc1_chairpersons.verified = true`. This is required because the
 * rent-request gate (2026-06-15) refuses to let agents post unless the linked
 * LC1 chairperson is verified — and previously no Ops flow existed to do so.
 *
 * Non-managers see a read-only status badge.
 */
export function VerifyLc1Button({ lc1Id, lc1Name, verified, onVerified }: VerifyLc1ButtonProps) {
  const { user, role, roles } = useAuth();
  const [loading, setLoading] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState(false);
  const [pressProgress, setPressProgress] = useState(0);

  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Landlord Operations (and managers/super admins/COO) may verify LC1 chairpersons.
  const OPS_ROLES = ['manager', 'super_admin', 'coo', 'operations'] as const;
  const isManager =
    OPS_ROLES.includes(role as (typeof OPS_ROLES)[number]) ||
    (roles ?? []).some((r) => OPS_ROLES.includes(r as (typeof OPS_ROLES)[number]));

  const LONG_PRESS_MS = 1200;

  const clearPressTimers = useCallback(() => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    if (progressTimer.current) clearInterval(progressTimer.current);
    pressTimer.current = null;
    progressTimer.current = null;
    setPressProgress(0);
  }, []);

  const startLongPress = useCallback(() => {
    clearPressTimers();
    setPressProgress(0);
    const start = Date.now();
    progressTimer.current = setInterval(() => {
      const elapsed = Date.now() - start;
      setPressProgress(Math.min(elapsed / LONG_PRESS_MS, 1));
    }, 30);
    pressTimer.current = setTimeout(() => {
      clearPressTimers();
      hapticSuccess();
      setConfirmDialog(true);
    }, LONG_PRESS_MS);
  }, [clearPressTimers]);

  const handleVerify = async () => {
    if (!user || !isManager) return;
    hapticTap();
    setLoading(true);
    try {
      const { error } = await supabase
        .from('lc1_chairpersons')
        .update({
          verified: true,
          verified_at: new Date().toISOString(),
          verified_by: user.id,
        })
        .eq('id', lc1Id);
      if (error) throw error;
      toast.success(`LC1 chairperson ${lc1Name} verified successfully!`);
      setConfirmDialog(false);
      onVerified();
    } catch (error: any) {
      toast.error(error.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  if (verified) {
    return (
      <Badge variant="outline" className="gap-1 bg-emerald-500/15 text-emerald-700 border-emerald-500/30 text-[10px] h-5 px-1.5">
        <ShieldCheck className="h-3 w-3" /> Verified
      </Badge>
    );
  }

  if (!isManager) {
    return (
      <Badge variant="outline" className="gap-1 bg-amber-500/10 text-amber-700 border-amber-500/30 text-[10px] h-5 px-1.5">
        Pending Verification
      </Badge>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5 relative overflow-hidden select-none touch-none h-8"
        onPointerDown={startLongPress}
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

      <Dialog open={confirmDialog} onOpenChange={setConfirmDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Landmark className="h-5 w-5 text-primary" />
              Verify LC1 Chairperson
            </DialogTitle>
            <DialogDescription>
              Confirm that LC1 chairperson "{lc1Name}" has been verified? Agents can post rent requests for tenants under this LC1 once verified.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex gap-2">
            <Button variant="outline" onClick={() => setConfirmDialog(false)} disabled={loading}>
              Cancel
            </Button>
            <Button variant="success" onClick={handleVerify} disabled={loading} className="gap-2">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}