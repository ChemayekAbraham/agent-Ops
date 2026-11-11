import { useState } from 'react';
import { Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
import { formatUGX } from '@/lib/rentCalculations';
import {
  useCancelCoSupport,
  useFundCoSupportAlone,
  useMyCoSupportInvites,
  useReinviteCoSupport,
} from '@/hooks/useCoSupport';
import { coSupportErrorMessage, type CoSupportInvite } from '@/lib/coSupport';
import { CoSupportCountdown, CoSupportShareSheet } from './CoSupportShareSheet';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const QUIET: CoSupportInvite['status'][] = ['cancelled', 'replaced', 'funded_alone', 'plan_unavailable'];

const QUIET_NOTE: Record<string, string> = {
  cancelled: 'You stopped sharing this Rent Plan.',
  replaced: 'You sent a new link for this Rent Plan.',
  funded_alone: 'You paid the full amount for this Rent Plan.',
  plan_unavailable: 'This Rent Plan is no longer available.',
};

/** One row of section 3; also used on the invitation page when the viewer is the sender. */
export function CoSupportInviteRow({ invite }: { invite: CoSupportInvite }) {
  const cancel = useCancelCoSupport();
  const reinvite = useReinviteCoSupport();
  const fundAlone = useFundCoSupportAlone();
  const [share, setShare] = useState<CoSupportInvite | null>(null);
  const [confirmFull, setConfirmFull] = useState(false);
  const busy = cancel.isPending || reinvite.isPending || fundAlone.isPending;
  const onError = (error: unknown) => toast.error(coSupportErrorMessage(error));

  const doReinvite = (newLink: boolean) =>
    reinvite.mutate(
      { inviteId: invite.id, newLink },
      { onSuccess: (data) => setShare(data), onError },
    );
  const doCancel = () => cancel.mutate(invite.id, { onSuccess: () => toast.success('Sharing stopped. Your half is free again.'), onError });
  const doFundAlone = () =>
    fundAlone.mutate(invite.id, { onSuccess: () => toast.success('You now support the full Rent Plan.'), onError });

  const title = (
    <p className="text-sm font-semibold text-foreground">
      {invite.tenant_first_name ?? 'Tenant'}
      {invite.city ? <span className="font-normal text-muted-foreground"> · {invite.city}</span> : null}
    </p>
  );

  let body: React.ReactNode = null;
  let actions: React.ReactNode = null;

  if (invite.status === 'open') {
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-foreground">Waiting for your partner</span>
        <CoSupportCountdown expiresAt={invite.expires_at} />
      </div>
    );
    actions = (
      <>
        <Button size="sm" onClick={() => setShare(invite)} disabled={busy || !invite.code}>Share again</Button>
        <Button size="sm" variant="outline" onClick={doCancel} disabled={busy}>Cancel</Button>
      </>
    );
  } else if (invite.status === 'declined' || invite.status === 'expired') {
    body = (
      <p className="text-sm text-foreground">
        {invite.status === 'declined' ? `${invite.partner_first_name ?? 'Your partner'} said no` : 'The 48 hours ran out'}
      </p>
    );
    actions = (
      <>
        <Button size="sm" onClick={() => doReinvite(false)} disabled={busy}>Ask again</Button>
        <Button size="sm" variant="outline" onClick={() => doReinvite(true)} disabled={busy}>Invite someone else</Button>
        <Button size="sm" variant="outline" onClick={() => setConfirmFull(true)} disabled={busy}>Pay the full amount</Button>
        <Button size="sm" variant="ghost" onClick={doCancel} disabled={busy}>Cancel</Button>
      </>
    );
  } else if (invite.status === 'completed') {
    body = (
      <div className="space-y-0.5">
        <p className="text-sm text-foreground">Supported with {invite.partner_first_name ?? 'your partner'}</p>
        {invite.your_monthly_rent_profit_share != null ? (
          <p className="text-sm text-foreground">
            Your Rent Profit Share: <span className="font-semibold text-primary">{formatUGX(invite.your_monthly_rent_profit_share)}</span> a month
          </p>
        ) : null}
      </div>
    );
  } else {
    body = <p className="text-sm text-muted-foreground">{QUIET_NOTE[invite.status] ?? 'This invitation is closed.'}</p>;
  }

  return (
    <li className="space-y-2 rounded-lg border bg-card p-3">
      {title}
      {body}
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      <CoSupportShareSheet invite={share} open={!!share} onOpenChange={(o) => !o && setShare(null)} />
      <AlertDialog open={confirmFull} onOpenChange={setConfirmFull}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pay the full amount?</AlertDialogTitle>
            <AlertDialogDescription>You'll pay the full {formatUGX(invite.plan_amount)} from your float.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction onClick={doFundAlone}>Pay the full amount</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** Section 3: the sender's "Waiting for your partner" list on the funder dashboard. */
export function CoSupportWaitingSection() {
  const { data } = useMyCoSupportInvites();
  const now = Date.now();
  const rows = (data ?? []).filter(
    (r) =>
      r.your_role === 'lead' &&
      !(QUIET.includes(r.status) && now - new Date(r.created_at).getTime() > SEVEN_DAYS_MS),
  );
  if (rows.length === 0) return null;
  return (
    <section className="space-y-2 rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
      <h2 className="flex items-center gap-2 text-base font-bold text-foreground">
        <Users className="h-4 w-4 text-primary" aria-hidden />
        Waiting for your partner
      </h2>
      <ul className="space-y-2">
        {rows.map((r) => (
          <CoSupportInviteRow key={r.id} invite={r} />
        ))}
      </ul>
    </section>
  );
}
