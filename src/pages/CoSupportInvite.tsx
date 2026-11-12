import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Home, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import {
  useAcceptCoSupport,
  useCoSupportPreview,
  useDeclineCoSupport,
  type CoSupportAcceptResult,
} from '@/hooks/useCoSupport';
import {
  coSupportErrorMessage,
  coSupportInviteCopy,
  coSupportOnboardingPath,
  coSupportSignInPath,
  normalizeCoSupportCode,
  type CoSupportInvite as Invite,
} from '@/lib/coSupport';
import { CoSupportInviteRow } from '@/components/co-support/CoSupportWaitingSection';

/** Section 4: public invitation page, /co-support/:code. */
export default function CoSupportInvite() {
  const { code: rawCode } = useParams();
  const code = normalizeCoSupportCode(rawCode);
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: preview, isLoading, error } = useCoSupportPreview(code, user?.id);
  const accept = useAcceptCoSupport();
  const decline = useDeclineCoSupport();
  const [result, setResult] = useState<CoSupportAcceptResult | null>(null);
  const [declined, setDeclined] = useState(false);

  const shell = (children: React.ReactNode) => (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8 text-foreground">
      <div className="w-full max-w-md space-y-4 rounded-2xl border bg-card p-5 shadow-sm">{children}</div>
    </div>
  );

  if (!code || (preview && !preview.found)) {
    return shell(<p className="text-sm text-foreground">This link is not valid. Ask your partner to share it again.</p>);
  }
  if (isLoading) {
    return shell(<div className="flex justify-center py-6"><Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden /></div>);
  }
  if (error || !preview) {
    return shell(<p className="text-sm text-foreground">{coSupportErrorMessage(error)}</p>);
  }

  // Every sentence on this page comes from the server's figures, addressed to
  // the person who opened the link. Amounts are never computed on screen.
  const copy = coSupportInviteCopy(preview);
  const isHouse = preview.kind === 'house';

  if (preview.your_role === 'lead') {
    return shell(
      <>
        <h1 className="text-lg font-bold">{isHouse ? 'Your shared house' : 'Your shared Rent Plan'}</h1>
        <ul><CoSupportInviteRow invite={preview as Invite} /></ul>
        <Button variant="outline" className="w-full" asChild><Link to="/dashboard/funder">Go to my dashboard</Link></Button>
      </>,
    );
  }

  if (result?.ok) {
    // The accept answer is the freshest record of what was taken; the preview
    // only supplies the names and the kind of support.
    const accepted = coSupportInviteCopy({
      ...preview,
      kind: preview.kind ?? result.kind,
      your_share: preview.your_share ?? result.your_share,
    });
    return shell(
      <>
        <h1 className="text-lg font-bold">{accepted.successTitle}</h1>
        <p className="text-sm">{accepted.successDetail}</p>
        <Button className="w-full" asChild><Link to="/dashboard/funder">Go to my dashboard</Link></Button>
      </>,
    );
  }
  if (declined) {
    return shell(
      <>
        <p className="text-sm">You said no to this invitation.</p>
        <Button variant="outline" className="w-full" asChild><Link to="/">Go to Welile</Link></Button>
      </>,
    );
  }

  const header = (
    <>
      <h1 className="text-lg font-bold leading-snug">{copy.headline}</h1>
      {isHouse && preview.house_title ? <p className="text-sm font-semibold">{preview.house_title}</p> : null}
      <div className="overflow-hidden rounded-lg border bg-muted">
        {preview.house_image_url ? (
          <img src={preview.house_image_url} alt="House" className="aspect-[16/9] w-full object-cover" />
        ) : (
          <div className="flex aspect-[16/9] items-center justify-center bg-primary/5"><Home className="h-8 w-8 text-primary/45" aria-hidden /></div>
        )}
      </div>
      <p className="text-sm">{copy.intro}</p>
      {preview.city ? <p className="text-sm text-muted-foreground">{preview.city}</p> : null}
      {preview.your_share != null ? <p className="text-sm font-semibold">{copy.yourHalf}</p> : null}
      {copy.yourEarning ? <p className="text-sm">{copy.yourEarning}</p> : null}
      {copy.holdLine ? <p className="text-xs font-medium text-muted-foreground">{copy.holdLine}</p> : null}
    </>
  );

  if (!preview.signed_in) {
    return shell(
      <>
        {header}
        <p className="text-xs text-muted-foreground">{copy.signedOutHint}</p>
        <div className="grid gap-2">
          <Button onClick={() => navigate(coSupportSignInPath(code))}>{copy.signInLabel}</Button>
          <Button variant="outline" onClick={() => navigate(coSupportOnboardingPath(code, preview.referrer_id))}>{copy.joinLabel}</Button>
        </div>
      </>,
    );
  }

  if (preview.can_accept) {
    const doAccept = () =>
      accept.mutate(code, {
        onSuccess: (data) => {
          if (data.ok) setResult(data);
          else toast.error(data.message ?? coSupportErrorMessage(data.reason));
        },
        onError: (e) => toast.error(coSupportErrorMessage(e)),
      });
    const doDecline = () =>
      decline.mutate(code, { onSuccess: () => setDeclined(true), onError: (e) => toast.error(coSupportErrorMessage(e)) });
    return shell(
      <>
        {header}
        {result && !result.ok && result.message ? <p className="text-sm text-destructive">{result.message} Nothing was charged.</p> : null}
        <div className="grid gap-2">
          <Button onClick={doAccept} disabled={accept.isPending || decline.isPending}>
            {accept.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {copy.acceptLabel}
          </Button>
          <Button variant="outline" onClick={doDecline} disabled={accept.isPending || decline.isPending}>{copy.declineLabel}</Button>
        </div>
      </>,
    );
  }

  // Where the fix lives: wallet, agreement, or partner sign-up. The server
  // decides which; only the label comes from the copy.
  const next =
    preview.reason === 'not_a_partner'
      ? { to: coSupportOnboardingPath(code, preview.referrer_id) }
      : preview.reason === 'agreement_required' || preview.reason === 'funds_short'
        ? { to: '/dashboard/funder' }
        : null;
  return shell(
    <>
      {header}
      {copy.blockTitle ? <p className="text-sm font-bold text-foreground">{copy.blockTitle}</p> : null}
      {copy.blockDetail ? <p className="text-sm text-foreground">{copy.blockDetail}</p> : null}
      {next && copy.blockAction ? (
        <>
          <Button className="w-full" onClick={() => navigate(next.to)}>{copy.blockAction}</Button>
          {preview.reason !== 'not_a_partner' ? (
            <p className="text-xs text-muted-foreground">Then open this link again to take your half.</p>
          ) : null}
        </>
      ) : null}
    </>,
  );
}
