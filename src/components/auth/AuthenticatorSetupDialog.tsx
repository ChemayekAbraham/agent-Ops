import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AuthenticatorSetupScreen } from './AuthenticatorSetupScreen';

interface AuthenticatorSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function AuthenticatorSetupDialog({ open, onOpenChange, onSuccess }: AuthenticatorSetupDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 overflow-hidden border-border/80 sm:rounded-2xl">
        <DialogHeader className="sr-only">
          <DialogTitle>Set up authenticator app</DialogTitle>
        </DialogHeader>
        <AuthenticatorSetupScreen
          isDialog
          onSuccess={() => {
            onSuccess?.();
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

export default AuthenticatorSetupDialog;
