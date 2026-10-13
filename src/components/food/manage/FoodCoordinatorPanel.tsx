import { useState } from 'react';
import FoodLoadError from '@/components/food/FoodLoadError';
import { Lock, ShieldCheck, UserCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  useFoodCoordinatorAssignments, useTransferFoodCoordinator, useFoodCoordinatorStatus,
  useFoodCoordinatorCandidates, type FoodHandoverMode,
} from '@/hooks/useFoodService';

const MIN_REASON = 10;

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function FoodCoordinatorPanel({ canAuthor }: { canAuthor: boolean }) {
  const assignmentsQ = useFoodCoordinatorAssignments();
  const { data: assignments, isLoading } = assignmentsQ;
  const { data: status } = useFoodCoordinatorStatus();
  const transfer = useTransferFoodCoordinator();

  // No default successor and no suggestion: whoever does the handover picks.
  const [toUserId, setToUserId] = useState('');
  const [mode, setMode] = useState<FoodHandoverMode>('full_transfer');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);

  // Only the active coordinator may look a successor up, so the query is not
  // even issued for anyone else.
  const { data: candidates = [], isLoading: candidatesLoading } =
    useFoodCoordinatorCandidates(canAuthor);

  const reasonOk = reason.trim().length >= MIN_REASON;
  const formOk = toUserId !== '' && reasonOk;
  const successorName = candidates.find((c) => c.user_id === toUserId)?.full_name ?? 'the new holder';

  const current = (assignments ?? []).filter((a) => !a.revoked_at);
  const past = (assignments ?? []).filter((a) => a.revoked_at);

  return (
    <div className="space-y-6">
      <FoodLoadError queries={[assignmentsQ]} />
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Current access
        </h2>

        {isLoading ? (
          <Skeleton className="h-20 w-full rounded-xl" />
        ) : current.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
            No active assignment.
          </p>
        ) : (
          <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/70 bg-card">
            {current.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {a.coordinator_name ?? a.coordinator_id}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Since {when(a.assigned_at)}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className={a.access_level === 'active'
                    ? 'border-success/30 bg-success/10 text-success'
                    : 'border-border bg-muted text-muted-foreground'}
                >
                  {a.access_level === 'active' ? 'Active coordinator' : 'Backup (read-only)'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <UserCog className="h-4 w-4" aria-hidden="true" />
          Hand over the role
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Transfers Food Coordinator access to another verified account. The change is
          recorded permanently.
        </p>

        {!canAuthor && (
          <p className="mb-3 rounded-lg border border-border/70 bg-muted/60 p-3 text-xs text-muted-foreground">
            Only the active Food Coordinator can hand the role over.
          </p>
        )}

        {canAuthor && !candidatesLoading && candidates.length === 0 && (
          <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
            There is nobody else to hand the role to. A successor must hold a
            staff account before they can be made Food Coordinator.
          </p>
        )}

        <div className="space-y-4 rounded-xl border border-border/70 bg-card p-4">
          <div className="space-y-1.5">
            <Label htmlFor="successor">Hand over to</Label>
            <Select
              value={toUserId}
              onValueChange={setToUserId}
              disabled={!canAuthor || candidatesLoading || candidates.length === 0}
            >
              <SelectTrigger id="successor">
                <SelectValue
                  placeholder={candidatesLoading ? 'Loading people…' : 'Choose a person'} />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.user_id} value={c.user_id}>{c.full_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>What happens to your own access</Label>
            <RadioGroup
              value={mode}
              onValueChange={(v) => setMode(v as FoodHandoverMode)}
              disabled={!canAuthor}
              className="gap-2"
            >
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 p-3">
                <RadioGroupItem value="full_transfer" className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium">Full transfer</span>
                  <span className="block text-xs text-muted-foreground">
                    You lose access entirely. Only the new holder can manage food.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 p-3">
                <RadioGroupItem value="transfer_with_backup" className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium">Transfer, keep me as backup</span>
                  <span className="block text-xs text-muted-foreground">
                    The new holder manages food; you keep read-only access.
                  </span>
                </span>
              </label>
            </RadioGroup>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="handover-reason">Reason</Label>
            <Textarea
              id="handover-reason"
              rows={2}
              value={reason}
              maxLength={300}
              disabled={!canAuthor}
              placeholder="Why is the role moving?"
              onChange={(e) => setReason(e.target.value)}
            />
            <p className={reason.length > 0 && !reasonOk
              ? 'text-[11px] text-destructive'
              : 'text-[11px] text-muted-foreground'}>
              At least {MIN_REASON} characters — this goes into the permanent record.
            </p>
          </div>

          <Button
            disabled={!canAuthor || !formOk || transfer.isPending}
            onClick={() => setConfirming(true)}
          >
            Hand over
          </Button>
        </div>
      </section>

      <section>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <Lock className="h-4 w-4" aria-hidden="true" />
          Handover history
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Previous holders are kept, never deleted.
        </p>

        {past.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
            No previous holders.
          </p>
        ) : (
          <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/70 bg-card">
            {past.map((a) => (
              <li key={a.id} className="p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {a.coordinator_name ?? a.coordinator_id}
                  </p>
                  <span className="text-xs text-muted-foreground">
                    Ended {a.revoked_at ? when(a.revoked_at) : '—'}
                  </span>
                </div>
                {a.reason && (
                  <p className="mt-0.5 text-xs italic text-muted-foreground">{a.reason}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hand over to {successorName}?</AlertDialogTitle>
            <AlertDialogDescription>
              {successorName} becomes the active Food Coordinator and will be able to
              change the menu, prices and orders.{' '}
              {mode === 'full_transfer'
                ? 'You will lose access to Food Management.'
                : 'You will keep read-only access as backup.'}{' '}
              This is written to a permanent record that cannot be edited or removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={transfer.isPending}
              onClick={() => transfer.mutate(
                { toUserId, mode, reason: reason.trim() },
                {
                  onSuccess: () => { setToUserId(''); setReason(''); },
                  onSettled: () => setConfirming(false),
                },
              )}
            >
              Hand over
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
