import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { NOT_VETTED_EVENT } from './notVettedPrompt';

/** Mounted once in App; opened by promptIfNotVetted() when the server refuses a create. */
export default function NotVettedDialog() {
  const [reason, setReason] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const h = (e: Event) => setReason(String((e as CustomEvent).detail ?? ''));
    window.addEventListener(NOT_VETTED_EVENT, h);
    return () => window.removeEventListener(NOT_VETTED_EVENT, h);
  }, []);

  return (
    <AlertDialog open={!!reason} onOpenChange={(o) => !o && setReason(null)}>
      <AlertDialogContent className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" /> Verify your agent account
          </AlertDialogTitle>
          <AlertDialogDescription className="text-sm">{reason}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11">Not now</AlertDialogCancel>
          <AlertDialogAction
            className="min-h-11"
            onClick={() => { setReason(null); navigate('/dashboard/agent/verification'); }}
          >
            Go to verification
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
