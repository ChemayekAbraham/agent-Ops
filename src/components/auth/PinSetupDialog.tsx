import { useState } from 'react';
import { Lock, Check, AlertCircle, Shield, ArrowLeft, ChevronRight } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { usePinAuth } from '@/hooks/usePinAuth';
import { hapticSuccess, hapticError } from '@/lib/haptics';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface PinSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete?: () => void;
}

type Step = 'enter' | 'confirm';

export default function PinSetupDialog({ open, onOpenChange, onComplete }: PinSetupDialogProps) {
  const [step, setStep] = useState<Step>('enter');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [isShaking, setIsShaking] = useState(false);
  const { setupPin } = usePinAuth();

  const handlePinEntered = () => {
    if (pin.length === 4) {
      setStep('confirm');
      setError('');
    }
  };

  const handleConfirmPin = async () => {
    if (confirmPin.length !== 4) return;

    if (pin === confirmPin) {
      const success = await setupPin(pin);
      if (success) {
        hapticSuccess();
        toast.success('PIN created!');
        // Close immediately and navigate
        handleClose();
        onComplete?.();
      }
    } else {
      hapticError();
      setIsShaking(true);
      setError('PINs don\'t match. Try again.');
      setConfirmPin('');
      setTimeout(() => setIsShaking(false), 500);
    }
  };

  const handleClose = () => {
    setStep('enter');
    setPin('');
    setConfirmPin('');
    setError('');
    onOpenChange(false);
  };

  const handleBack = () => {
    setStep('enter');
    setConfirmPin('');
    setError('');
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md p-0 overflow-hidden">
        {/* Header with step indicator */}
        <div className="bg-gradient-to-br from-primary/10 to-primary/5 p-6 border-b border-border/50">
          <DialogHeader className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-primary/20 border border-primary/30">
                  <Shield className="h-5 w-5 text-primary" />
                </div>
                <DialogTitle className="text-lg">
                  {step === 'enter' ? 'Create Your PIN' : 'Confirm Your PIN'}
                </DialogTitle>
              </div>
            </div>
            
            {/* Step indicator */}
            <div className="flex items-center gap-2 pt-2">
              <div className="flex items-center gap-2">
                <div className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors",
                  step === 'enter' 
                    ? "bg-primary text-primary-foreground" 
                    : "bg-primary/20 text-primary"
                )}>
                  {step === 'confirm' ? <Check className="h-4 w-4" /> : '1'}
                </div>
                <span className={cn(
                  "text-sm font-medium",
                  step === 'enter' ? "text-foreground" : "text-muted-foreground"
                )}>
                  Create
                </span>
              </div>
              
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              
              <div className="flex items-center gap-2">
                <div className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors",
                  step === 'confirm' 
                    ? "bg-primary text-primary-foreground" 
                    : "bg-muted text-muted-foreground"
                )}>
                  2
                </div>
                <span className={cn(
                  "text-sm font-medium",
                  step === 'confirm' ? "text-foreground" : "text-muted-foreground"
                )}>
                  Confirm
                </span>
              </div>
            </div>

            <DialogDescription className="text-sm">
              {step === 'enter' 
                ? 'Enter a 4-digit PIN you\'ll use for quick login'
                : 'Re-enter the same PIN to confirm'
              }
            </DialogDescription>
          </DialogHeader>
        </div>

        {/* Content */}
        <div className="p-6">
          {step === 'enter' ? (
            <div className="flex flex-col items-center gap-6">
              {/* Visual indicator */}
              <div className="p-4 rounded-2xl bg-primary/10 border border-primary/20">
                <Lock className="h-10 w-10 text-primary" />
              </div>

              {/* PIN Input */}
              <div className="w-full flex flex-col items-center gap-4">
                <InputOTP
                  maxLength={4}
                  value={pin}
                  onChange={(value) => {
                    setPin(value);
                    if (value.length === 4) {
                      setTimeout(handlePinEntered, 300);
                    }
                  }}
                  containerClassName="justify-center"
                >
                  <InputOTPGroup className="gap-4">
                    {[0, 1, 2, 3].map((index) => (
                      <InputOTPSlot 
                        key={index} 
                        index={index}
                        className={cn(
                          "h-16 w-16 text-2xl font-bold rounded-xl border-2 transition-all",
                          pin.length > index 
                            ? "border-primary bg-primary/5" 
                            : "border-border"
                        )}
                      />
                    ))}
                  </InputOTPGroup>
                </InputOTP>

                {/* Progress dots */}
                <div className="flex items-center gap-2">
                  {[0, 1, 2, 3].map((index) => (
                    <div
                      key={index}
                      className={cn(
                        "w-2.5 h-2.5 rounded-full transition-all",
                        pin.length > index 
                          ? "bg-primary scale-110" 
                          : "bg-muted"
                      )}
                    />
                  ))}
                </div>
              </div>

              {/* Tips */}
              <div className="w-full p-4 rounded-xl bg-muted/50 border border-border/50">
                <p className="text-sm text-muted-foreground text-center">
                  💡 <span className="font-medium text-foreground">Tip:</span> Choose a PIN you'll remember but others can't guess
                </p>
              </div>

              {/* Actions */}
              <div className="w-full flex gap-3">
                <Button 
                  variant="outline" 
                  onClick={handleClose} 
                  className="flex-1 h-12"
                >
                  Skip for now
                </Button>
                <Button 
                  onClick={handlePinEntered} 
                  disabled={pin.length !== 4}
                  className="flex-1 h-12"
                >
                  Continue
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-6">
              {/* Visual indicator */}
              <div 
                className={cn(
                  "p-4 rounded-2xl border transition-all",
                  error 
                    ? "bg-destructive/10 border-destructive/30" 
                    : "bg-green-500/10 border-green-500/30"
                )}
              >
                <Check className={cn(
                  "h-10 w-10",
                  error ? "text-destructive" : "text-green-600"
                )} />
              </div>

              {/* Confirmation message */}
              <div className="text-center">
                <p className="text-sm font-medium text-foreground">
                  Almost done!
                </p>
                <p className="text-sm text-muted-foreground">
                  Enter the same 4-digit PIN again
                </p>
              </div>

              {/* PIN Input */}
              <div 
                className={cn(
                  "w-full flex flex-col items-center gap-4 transition-transform",
                  isShaking && "animate-shake"
                )}
              >
                <InputOTP
                  maxLength={4}
                  value={confirmPin}
                  onChange={(value) => {
                    setConfirmPin(value);
                    setError('');
                    if (value.length === 4) {
                      setTimeout(handleConfirmPin, 300);
                    }
                  }}
                  containerClassName="justify-center"
                >
                  <InputOTPGroup className="gap-4">
                    {[0, 1, 2, 3].map((index) => (
                      <InputOTPSlot 
                        key={index} 
                        index={index}
                        className={cn(
                          "h-16 w-16 text-2xl font-bold rounded-xl border-2 transition-all",
                          error 
                            ? "border-destructive bg-destructive/5"
                            : confirmPin.length > index 
                              ? "border-green-500 bg-green-500/5" 
                              : "border-border"
                        )}
                      />
                    ))}
                  </InputOTPGroup>
                </InputOTP>

                {/* Progress dots */}
                <div className="flex items-center gap-2">
                  {[0, 1, 2, 3].map((index) => (
                    <div
                      key={index}
                      className={cn(
                        "w-2.5 h-2.5 rounded-full transition-all",
                        error
                          ? "bg-destructive"
                          : confirmPin.length > index 
                            ? "bg-green-500 scale-110" 
                            : "bg-muted"
                      )}
                    />
                  ))}
                </div>
              </div>

              {/* Error message */}
              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span className="text-sm font-medium">{error}</span>
                </div>
              )}

              {/* Actions */}
              <div className="w-full flex gap-3">
                <Button 
                  variant="outline" 
                  onClick={handleBack} 
                  className="flex-1 h-12"
                >
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Go back
                </Button>
                <Button 
                  onClick={handleConfirmPin}
                  disabled={confirmPin.length !== 4}
                  className="flex-1 h-12 bg-green-600 hover:bg-green-700"
                >
                  <Check className="h-4 w-4 mr-2" />
                  Create PIN
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
