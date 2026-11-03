import { useState } from 'react';
import { ShieldCheck, Smartphone, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useSafeAuth } from '@/components/auth/useSafeAuth';
import { useAuthenticatorMfa } from '@/hooks/useAuthenticatorMfa';
import { AuthenticatorSetupDialog } from '@/components/auth/AuthenticatorSetupDialog';

export function AuthenticatorAppCard() {
  const { user } = useSafeAuth();
  const { status, stage, refresh } = useAuthenticatorMfa(user?.id);
  const [setupOpen, setSetupOpen] = useState(false);

  // If user is not staff/admin and mode is not enforcing for them, we can still show or hide
  const isEnrolled = status?.enrolled || stage === 'verified';

  return (
    <>
      <Card className="border-border/40 rounded-2xl">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  Authenticator app
                  {isEnrolled && (
                    <Badge variant="outline" className="border-emerald-600/30 text-emerald-600 bg-emerald-500/10 text-[10px]">
                      Enrolled
                    </Badge>
                  )}
                </CardTitle>
              </div>
              <CardDescription className="text-xs">
                Time-based one-time codes (TOTP) from Google Authenticator or Microsoft Authenticator for step-up verification and sign-in.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isEnrolled ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-card px-3 py-2.5">
              <div className="flex items-center gap-2 text-xs text-foreground">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                <span>Your authenticator app is configured and active.</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setSetupOpen(true)}
              >
                Re-configure
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-card px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Set up authenticator app</p>
                <p className="text-xs text-muted-foreground">
                  Optional extra sign-in protection for staff accounts.
                </p>
              </div>
              <Button
                id="settings-setup-authenticator"
                size="sm"
                className="h-8 text-xs font-semibold shrink-0"
                onClick={() => setSetupOpen(true)}
              >
                Set up now
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <AuthenticatorSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        onSuccess={() => void refresh()}
      />
    </>
  );
}

export default AuthenticatorAppCard;
