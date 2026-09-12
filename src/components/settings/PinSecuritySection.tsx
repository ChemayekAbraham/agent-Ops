import { useState } from 'react';
import { Shield, Lock, Trash2, Plus } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
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
      <div>
        <Card className="glass-card border-border/50 shadow-elevated overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 pointer-events-none" />
          
          <CardHeader className="relative">
            <CardTitle className="flex items-center gap-2">
              <div className="p-2 rounded-lg bg-primary/10">
                <Shield className="h-5 w-5 text-primary" />
              </div>
              Quick Access PIN
            </CardTitle>
            <CardDescription>
              Use a 4-digit PIN for faster sign-in on this device
            </CardDescription>
          </CardHeader>
          
          <CardContent className="space-y-4 relative">
            {isPinEnabled ? (
              <>
                {/* PIN Enabled State */}
                <div className="flex items-center justify-between p-4 rounded-xl bg-success/10 border border-success/20">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-success/20">
                      <Lock className="h-5 w-5 text-success" />
                    </div>
                    <div>
                      <p className="font-medium text-success">PIN Enabled</p>
                      <p className="text-sm text-muted-foreground">
                        Quick access is active on this device
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex gap-3">
                  <Button 
                    variant="outline" 
                    onClick={handleChangePIN}
                    className="flex-1"
                  >
                    <Lock className="h-4 w-4 mr-2" />
                    Change PIN
                  </Button>
                  
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive" className="flex-1">
                        <Trash2 className="h-4 w-4 mr-2" />
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
                {/* PIN Disabled State */}
                <div className="flex items-center justify-between p-4 rounded-xl bg-background/50 border border-border/50">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-muted">
                      <Lock className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-medium">PIN Not Set</p>
                      <p className="text-sm text-muted-foreground">
                        Set up a PIN for quick access
                      </p>
                    </div>
                  </div>
                </div>

                <Button 
                  onClick={() => setShowPinSetup(true)}
                  className="w-full"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Set Up PIN
                </Button>

                <p className="text-xs text-muted-foreground text-center">
                  Your PIN is stored securely on this device only
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <PinSetupDialog 
        open={showPinSetup} 
        onOpenChange={setShowPinSetup}
      />
    </>
  );
}
