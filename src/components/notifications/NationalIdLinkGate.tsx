/**
 * The National ID holder's answer.
 *
 * Someone else photographed a National ID that this account holds. Only the
 * holder can allow it, so this dialog cannot be closed until it is answered.
 * The holder is shown the ID number and nothing else.
 */
import { useState } from 'react';
import { Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  useNationalIdLinkOwnerDecision, useNationalIdLinkRequestsForHolder,
} from '@/hooks/useNationalIdLink';

export default function NationalIdLinkGate() {
  const requests = useNationalIdLinkRequestsForHolder();
  const decide = useNationalIdLinkOwnerDecision();
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null);

  const row = requests.data?.[0];
  if (!row) return null;

  const answer = async (approve: boolean) => {
    try {
      await decide.mutateAsync({ id: row.id, approve, note: approve ? undefined : note });
      toast.success(approve ? 'Thank you — you allowed it.' : 'Thank you — you refused it.');
      setNote('');
      setConfirming(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send your answer.');
    }
  };

  const codeEntered = !!row.code_verified_at;

  return (
    <Dialog open>
      <DialogContent
        className="max-w-md [&>button]:hidden"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-600" />
            Someone wants to use your National ID
          </DialogTitle>
          <DialogDescription>
            <span className="font-semibold text-foreground">
              {row.requester_name ?? 'A Welile account'}
            </span>
            {row.requester_phone && (
              <span className="font-mono text-foreground"> ({row.requester_phone})</span>
            )}{' '}
            is asking to be linked to National ID{' '}
            <span className="font-mono font-semibold text-foreground">{row.nin}</span>. Only allow
            this if you know this person and you agree.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Asked on{' '}
            {new Date(row.created_at as string).toLocaleString('en-GB', {
              dateStyle: 'medium', timeStyle: 'short',
            })}
            . This request closes on its own on{' '}
            {new Date(row.expires_at as string).toLocaleDateString('en-GB', { dateStyle: 'medium' })}.
          </p>

          {!codeEntered && (
            <p className="rounded-lg bg-amber-500/10 p-3 text-xs text-amber-700">
              You can only allow this once the person has entered the code we sent to your number.
              Share the code only if you agree.
            </p>
          )}

          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="If you are refusing, you can say why (optional)."
            className="text-sm"
            rows={2}
          />

          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              className="h-11"
              onClick={() => setConfirming('reject')}
              disabled={decide.isPending}
            >
              No, I do not agree
            </Button>
            <Button
              className="h-11"
              onClick={() => setConfirming('approve')}
              disabled={decide.isPending || !codeEntered}
            >
              {decide.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Yes, I allow it
            </Button>
          </div>
        </div>

        <AlertDialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirming === 'approve' ? 'Allow this account on your National ID?' : 'Refuse this request?'}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirming === 'approve'
                  ? 'This account will be added to your National ID. Only agree if you know the person.'
                  : 'The account will not be added to your National ID.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={decide.isPending}>Go back</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  answer(confirming === 'approve');
                }}
                disabled={decide.isPending}
              >
                {decide.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {confirming === 'approve' ? 'Yes, allow it' : 'Yes, refuse it'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
