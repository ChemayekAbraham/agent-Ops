import { useState } from 'react';
import { Shield, Lock, Trash2, Plus } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { usePinAuth } from '@/hooks/usePinAuth';
import PinSetupDialog from '@/components/auth/PinSetupDialog';
import { toast } from 'sonner';
import { hapticSuccess } from '@/lib/haptics';

export default function PinSecuritySection() {
  const { isPinEnabled, disablePin } = usePinAuth();
  const [showPinSetup, setShowPinSetup] = useState(false);

  const handleDisablePin = () => {
    disablePin();
    hapticSuccess();
    toast.success('PIN disabled', {
      description: 'You will need to use your password to sign in'
    });
  };

  const handleChangePIN = () => {
    setShowPinSetup(true);
  };

  return (
    <>
      <Card className="border-border/40 rounded-2xl">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            <div>
              <CardTitle className="text-sm">Quick Access PIN</CardTitle>
              <CardDescription className="text-xs">Use a 4-digit PIN for faster sign-in on this device</CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {isPinEnabled ? (
            <>
              <div className="flex items-center gap-3 p-3 rounded-xl bg-success/10 border border-success/20">
                <Lock className="h-4 w-4 text-success shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium text-sm text-success">PIN Enabled</p>
                  <p className="text-xs text-muted-foreground">Quick access is active on this device</p>
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleChangePIN}
                  className="flex-1"
                >
                  <Lock className="h-3.5 w-3.5 mr-1.5" />
                  Change PIN
                </Button>

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="sm" className="flex-1">
                      <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                      Remove PIN
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove PIN?</AlertDialogTitle>
                      <AlertDialogDescription>
                        You will need to use your password to sign in. You can set up a new PIN anytime.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={handleDisablePin}>
                        Remove PIN
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3 p-3 rounded-xl border border-border/50">
                <Lock className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium text-sm">PIN Not Set</p>
                  <p className="text-xs text-muted-foreground">Set up a PIN for quick access</p>
                </div>
              </div>

              <Button
                onClick={() => setShowPinSetup(true)}
                size="sm"
                className="w-full"
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Set Up PIN
              </Button>

              <p className="text-[11px] text-muted-foreground text-center">
                Your PIN is stored securely on this device only
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <PinSetupDialog
        open={showPinSetup}
        onOpenChange={setShowPinSetup}
      />
    </>
  );
}
