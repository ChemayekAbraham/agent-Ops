import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ExternalLink, Loader2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import {
  useAcceptCoSupport,
  useCoSupportPreview,
  useCoSupportLeadPhoto,
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
import DepositFlow from '@/components/payments/DepositFlow';
import { useUserAvatars } from '@/hooks/useUserAvatars';
import { CoSupportInvitationHeader, CoSupportJoined } from '@/components/co-support/CoSupportInvitationViews';
import { CoSupportFloatSheet, type CoSupportDeposit } from '@/components/co-support/CoSupportFloatSheet';
import { CoSupportDepositWatch, type CoSupportWatchResult } from '@/components/co-support/CoSupportDepositWatch';
import { CoSupportInviteRow } from '@/components/co-support/CoSupportWaitingSection';

/** Section 4: public invitation page, /co-support/:code. */
export default function CoSupportInvite() {
  const { code: rawCode } = useParams();
  const code = normalizeCoSupportCode(rawCode);
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: initialPreview, isLoading, error } = useCoSupportPreview(code, user?.id);
  const accept = useAcceptCoSupport();
  const decline = useDeclineCoSupport();
  const [result, setResult] = useState<CoSupportAcceptResult | null>(null);
  const [declined, setDeclined] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [deposit, setDeposit] = useState<CoSupportDeposit | null>(null);
  const [watchOpen, setWatchOpen] = useState(false);
  const [watch, setWatch] = useState<CoSupportWatchResult>({ state: 'idle', preview: null });
  const [watchError, setWatchError] = useState<string | null>(null);
  const preview = watch.preview ?? initialPreview;
  const leadPhoto = useCoSupportLeadPhoto(preview?.lead_avatar_url);
  const { avatarFor } = useUserAvatars([user?.id], !!user?.id && !!result?.ok);
  const [, refreshClock] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => refreshClock(value => value + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const shell = (children: React.ReactNode) => (
    <div className="co-support-page min-h-screen bg-muted/40 px-4 pb-8 pt-6 text-foreground">
      <div className="co-support-card mx-auto w-full max-w-md space-y-4 rounded-2xl border border-border/60 bg-card p-5">{children}</div>
    </div>
  );

  if (!code || (preview && !preview.found)) {
    return shell(<p className="text-sm text-foreground">{coSupportErrorMessage('INVITE_NOT_FOUND')}</p>);
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
    return <CoSupportJoined preview={preview} copy={accepted} leadPhoto={leadPhoto} ownPhoto={avatarFor(user?.id)} />;
  }
  if (declined) {
    return shell(
      <>
        <p className="text-sm">You said no to this invitation.</p>
        <Button variant="outline" className="w-full" asChild><Link to="/">Go to Welile</Link></Button>
      </>,
    );
  }

  const header = <CoSupportInvitationHeader preview={preview} copy={copy} leadPhoto={leadPhoto} />;
  const buttonClass = 'h-12 w-full rounded-2xl text-[15px] font-semibold';
  const depositWatch = deposit ? <CoSupportDepositWatch key={deposit.submittedAt} code={code} userId={user?.id} deposit={deposit} onChange={setWatch} onError={error => setWatchError(String(error))} /> : null;

  if (!preview.signed_in) {
    return shell(
      <>
        {header}
        <div className="grid gap-2">
          <Button className={buttonClass} onClick={() => navigate(coSupportSignInPath(code))}>{copy.signInLabel}</Button>
          <Button variant="outline" className={`${buttonClass} border-success bg-card text-success hover:bg-success/5 hover:text-success`} onClick={() => navigate(coSupportOnboardingPath(code, preview.referrer_id))}>{copy.joinLabel}<ExternalLink className="h-4 w-4" aria-hidden /></Button>
        </div>
        <p className="text-center text-xs leading-relaxed text-muted-foreground">{copy.signedOutHint}</p>
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
    return <> {shell(
      <>
        {header}
        {result && !result.ok && result.message ? <p className="text-sm text-destructive">{result.message}</p> : null}
        <div className="grid gap-2">
          <Button className={buttonClass} onClick={doAccept} disabled={accept.isPending || decline.isPending}>
            {accept.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {copy.acceptLabel}
          </Button>
          <Button variant="outline" className={`${buttonClass} border-destructive bg-card text-destructive hover:bg-destructive/5 hover:text-destructive`} onClick={doDecline} disabled={accept.isPending || decline.isPending}>{copy.declineLabel}</Button>
        </div>
      </>,
    )}{depositWatch}{deposit ? <CoSupportFloatSheet open={watchOpen} onOpenChange={setWatchOpen} state={watch.state} deposit={deposit} preview={watch.preview} copy={copy} error={watchError} onRetry={() => { setWatchOpen(false); setDeposit(null); setDepositOpen(true); }} /> : null}</>;
  }

  // Where the fix lives: wallet, agreement, or partner sign-up. The server
  // decides which; only the label comes from the copy.
  const next =
    preview.reason === 'not_a_partner'
      ? { to: coSupportOnboardingPath(code, preview.referrer_id) }
      : preview.reason === 'agreement_required' || preview.reason === 'funds_short'
        ? { to: '/dashboard/funder' }
        : null;
  return <>
    {shell(<>
      {header}
      {copy.blockTitle || copy.blockDetail ? <section className="space-y-2.5 rounded-xl border border-warning/35 bg-warning/10 p-3.5 text-foreground">
        {copy.blockTitle ? <div className="flex items-start gap-2"><Wallet className="mt-0.5 h-[18px] w-[18px] shrink-0 text-warning" aria-hidden /><h2 className="text-[15px] font-bold">{copy.blockTitle}</h2></div> : null}
        {preview.reason === 'funds_short' ? <>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-[13px]">{copy.floatLines.map(line => <div key={line.label} className="contents"><dt>{line.label}</dt><dd className="co-support-amount text-right font-mono">{line.amount}</dd></div>)}</dl>
          {copy.floatNotes.map(note => <p key={note} className="text-xs leading-relaxed text-muted-foreground">{note}</p>)}
        </> : copy.blockDetail ? <p className="text-sm leading-relaxed">{copy.blockDetail}</p> : null}
      </section> : null}
      {next && copy.blockAction ? <Button className={buttonClass} onClick={() => preview.reason === 'funds_short' ? setDepositOpen(true) : navigate(next.to)}>{copy.blockAction}</Button> : null}
    </>)}
    <DepositFlow open={depositOpen} onOpenChange={setDepositOpen}
      heading={copy.depositTitle} intro={copy.depositIntro}
      defaultPurpose="operational_float" lockPurpose defaultAmount={preview.float_needed}
      defaultChannel="momo" defaultMomoProvider="mtn"
      onSubmitted={submitted => {
        setWatchError(null);
        setDeposit({ ...submitted, submittedAt: Date.now() });
        setDepositOpen(false);
        setWatchOpen(true);
      }} />
    {depositWatch}
    {deposit ? <CoSupportFloatSheet open={watchOpen} onOpenChange={setWatchOpen}
      state={watch.state} deposit={deposit} preview={watch.preview} copy={copy} error={watchError}
      onRetry={() => { setWatchOpen(false); setDeposit(null); setDepositOpen(true); }} /> : null}
  </>;
}
