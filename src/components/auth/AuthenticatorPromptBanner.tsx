import { useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AuthenticatorSetupDialog } from './AuthenticatorSetupDialog';

const DISMISS_SESSION_KEY = 'mfa_prompt_dismissed_session';

export function AuthenticatorPromptBanner() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_SESSION_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [setupOpen, setSetupOpen] = useState(false);

  const handleDismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_SESSION_KEY, '1');
    } catch {
      // ignore
    }
  };

  if (dismissed) return null;

  return (
    <>
      <div className="relative isolate z-40 border-b border-primary/20 bg-primary/5 px-4 py-3 text-xs sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ShieldAlert className="h-4 w-4" />
            </span>
            <p className="font-medium text-foreground">
              Set up your authenticator app. It will soon be required to sign in.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-8 text-xs font-semibold"
              onClick={() => setSetupOpen(true)}
            >
              Set up now
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={handleDismiss}
              aria-label="Dismiss banner"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <AuthenticatorSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
    </>
  );
}

export default AuthenticatorPromptBanner;
