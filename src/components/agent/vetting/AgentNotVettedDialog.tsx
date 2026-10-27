import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { agentNotVettedReason } from '@/lib/agentVetting';

const EVENT = 'agent-not-vetted';

/**
 * When a create (Add Tenant / Rent Plan request) is refused because the agent
 * is not verified, show the server's reason with a way to the verification
 * screen. Returns true when it handled the error so callers skip their toast.
 */
export function handleAgentNotVetted(err: unknown): boolean {
  const reason = agentNotVettedReason(err);
  if (!reason) return false;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: reason }));
  return true;
}

/** Mounted once in the app shell. */
export function AgentNotVettedDialogHost() {
  const [reason, setReason] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const onEvent = (e: Event) => setReason(String((e as CustomEvent).detail ?? ''));
    window.addEventListener(EVENT, onEvent);
    return () => window.removeEventListener(EVENT, onEvent);
  }, []);

  return (
    <AlertDialog open={reason !== null} onOpenChange={(o) => !o && setReason(null)}>
      <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Verify your agent account</AlertDialogTitle>
          <AlertDialogDescription className="text-sm text-foreground">{reason}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11">Not now</AlertDialogCancel>
          <AlertDialogAction
            className="min-h-11"
            onClick={() => {
              setReason(null);
              navigate('/dashboard/agent/verification');
            }}
          >
            Go to verification
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
