import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { STALE_SESSION_EVENTS } from "@/lib/staleSessionDetector";
import { clearAppStateAndReload } from "@/lib/clearAppState";

/**
 * Full-screen overlay shown after repeated auth/jwt failures. Offers the user
 * a single "Clear app state & sign in again" tap so they can recover without
 * uninstalling / reinstalling the PWA.
 */
export default function AuthRecoveryPrompt() {
  const [visible, setVisible] = useState(false);
  const [reason, setReason] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onRequired = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      setReason(String(detail.reason || "repeated_auth_failures"));
      setVisible(true);
    };
    window.addEventListener(STALE_SESSION_EVENTS.recoveryRequired, onRequired);
    return () => {
      window.removeEventListener(STALE_SESSION_EVENTS.recoveryRequired, onRequired);
    };
  }, []);

  if (!visible) return null;

  const handleClear = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await clearAppStateAndReload("/auth?reason=recovery");
    } catch {
      window.location.replace("/auth?reason=recovery");
    }
  };

  const handleDismiss = () => setVisible(false);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-recovery-title"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-background p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-destructive/10 p-2 text-destructive">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <h2 id="auth-recovery-title" className="text-lg font-semibold text-foreground">
              Sign-in keeps failing
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Your session token is stuck and we couldn't refresh it. Clearing the
              app's saved state will fix this without needing to reinstall.
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              This clears cached data and signs you out. Your account and money
              are safe — nothing on the server is deleted.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-2">
          <Button
            onClick={handleClear}
            disabled={busy}
            className="w-full"
            variant="destructive"
          >
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Clearing…
              </>
            ) : (
              "Clear app state & sign in again"
            )}
          </Button>
          <Button
            onClick={handleDismiss}
            disabled={busy}
            variant="ghost"
            className="w-full"
          >
            Not now
          </Button>
        </div>

        {reason ? (
          <p className="mt-3 text-[10px] uppercase tracking-wide text-muted-foreground">
            code: {reason}
          </p>
        ) : null}
      </div>
    </div>
  );
}
