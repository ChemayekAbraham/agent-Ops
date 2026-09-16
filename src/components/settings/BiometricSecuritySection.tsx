import { useState } from 'react';
import { Fingerprint, Scan, Smartphone, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { useBiometricAuth } from '@/hooks/useBiometricAuth';
import { toast } from 'sonner';
import { hapticSuccess, hapticError } from '@/lib/haptics';

export default function BiometricSecuritySection() {
  const {
    isBiometricAvailable,
    isBiometricEnabled,
    biometricType,
    enableBiometric,
    disableBiometric,
    isAuthenticating
  } = useBiometricAuth();

  const [isEnabling, setIsEnabling] = useState(false);

  const getBiometricIcon = (className = 'h-4 w-4') => {
    if (biometricType === 'face') {
      return <Scan className={className} />;
    }
    return <Fingerprint className={className} />;
  };

  const getBiometricName = () => {
    if (biometricType === 'face') return 'Face ID';
    if (biometricType === 'fingerprint') return 'Fingerprint';
    return 'Biometric';
  };

  const handleEnableBiometric = async () => {
    setIsEnabling(true);
    try {
      const success = await enableBiometric();
      if (success) {
        hapticSuccess();
        toast.success(`${getBiometricName()} enabled!`, {
          description: 'You can now use biometric authentication to sign in'
        });
      } else {
        hapticError();
        toast.error('Setup cancelled', {
          description: 'Biometric authentication was not enabled'
        });
      }
    } catch (error) {
      hapticError();
      toast.error('Setup failed', {
        description: 'Could not enable biometric authentication'
      });
    } finally {
      setIsEnabling(false);
    }
  };

  const handleDisableBiometric = () => {
    disableBiometric();
    hapticSuccess();
    toast.success(`${getBiometricName()} disabled`, {
      description: 'You will need to use PIN or password to sign in'
    });
  };

  if (!isBiometricAvailable) {
    return (
      <Card className="border-border/40 rounded-2xl opacity-60">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Fingerprint className="h-4 w-4 text-muted-foreground" />
            <div>
              <CardTitle className="text-sm">Biometric Login</CardTitle>
              <CardDescription className="text-xs">Not available on this device</CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <div className="flex items-center gap-3 p-3 rounded-xl border border-border/50">
            <Smartphone className="h-4 w-4 text-muted-foreground shrink-0" />
            <p className="text-xs text-muted-foreground">
              Fingerprint or Face ID is not available on your device or browser
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/40 rounded-2xl">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          {biometricType === 'face' ? (
            <Scan className="h-4 w-4 text-primary" />
          ) : (
            <Fingerprint className="h-4 w-4 text-primary" />
          )}
          <div>
            <CardTitle className="text-sm">{getBiometricName()} Login</CardTitle>
            <CardDescription className="text-xs">Sign in quickly using {getBiometricName().toLowerCase()}</CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {isBiometricEnabled ? (
          <>
            <div className="flex items-center gap-3 p-3 rounded-xl bg-success/10 border border-success/20">
              <CheckCircle className="h-4 w-4 text-success shrink-0" />
              <div className="min-w-0">
                <p className="font-medium text-sm text-success">{getBiometricName()} Enabled</p>
                <p className="text-xs text-muted-foreground">Quick biometric access is active</p>
              </div>
            </div>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm" className="w-full">
                  <XCircle className="h-3.5 w-3.5 mr-1.5" />
                  Disable {getBiometricName()}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Disable {getBiometricName()}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    You will need to use your PIN or password to sign in. You can enable {getBiometricName().toLowerCase()} again anytime.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDisableBiometric}>
                    Disable
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3 p-3 rounded-xl border border-border/50">
              {getBiometricIcon('h-4 w-4 text-muted-foreground shrink-0')}
              <div className="min-w-0">
                <p className="font-medium text-sm">{getBiometricName()} Not Set Up</p>
                <p className="text-xs text-muted-foreground">Enable for faster sign-in</p>
              </div>
            </div>

            <Button
              onClick={handleEnableBiometric}
              disabled={isEnabling || isAuthenticating}
              size="sm"
              className="w-full"
            >
              {isEnabling ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Setting up...
                </>
              ) : (
                <>
                  {getBiometricIcon('h-3.5 w-3.5 mr-1.5')}
                  Enable {getBiometricName()}
                </>
              )}
            </Button>

            <p className="text-[11px] text-muted-foreground text-center">
              Your biometric data never leaves your device
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
