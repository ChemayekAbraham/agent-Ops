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
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  useNationalIdLinkOwnerDecision, useNationalIdLinkRequestsForHolder,
} from '@/hooks/useNationalIdLink';

export default function NationalIdLinkGate() {
  const requests = useNationalIdLinkRequestsForHolder();
  const decide = useNationalIdLinkOwnerDecision();
  const [note, setNote] = useState('');

  const row = requests.data?.[0];
  if (!row) return null;

  const answer = async (approve: boolean) => {
    try {
      await decide.mutateAsync({ id: row.id, approve, note: approve ? undefined : note });
      toast.success(approve ? 'Thank you — you allowed it.' : 'Thank you — you refused it.');
      setNote('');
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
            A Welile account is asking to be linked to National ID{' '}
            <span className="font-mono font-semibold text-foreground">{row.nin}</span>. Only allow
            this if you know the person and you agree.
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
              onClick={() => answer(false)}
              disabled={decide.isPending}
            >
              No, I do not agree
            </Button>
            <Button
              className="h-11"
              onClick={() => answer(true)}
              disabled={decide.isPending || !codeEntered}
            >
              {decide.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Yes, I allow it
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
