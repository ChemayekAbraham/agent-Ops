import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Home, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useAcceptCoSupport,
  useCoSupportPreview,
  useDeclineCoSupport,
  type CoSupportAcceptResult,
} from '@/hooks/useCoSupport';
import {
  coSupportBlockMessage,
  coSupportErrorMessage,
  coSupportOnboardingPath,
  coSupportSignInPath,
  normalizeCoSupportCode,
  type CoSupportInvite as Invite,
} from '@/lib/coSupport';
import { CoSupportCountdown } from '@/components/co-support/CoSupportShareSheet';
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

  if (preview.your_role === 'lead') {
    return shell(
      <>
        <h1 className="text-lg font-bold">Your shared Rent Plan</h1>
        <ul><CoSupportInviteRow invite={preview as Invite} /></ul>
        <Button variant="outline" className="w-full" asChild><Link to="/dashboard/funder">Go to my dashboard</Link></Button>
      </>,
    );
  }

  if (result?.ok) {
    return shell(
      <>
        <h1 className="text-lg font-bold">You and {preview.lead_first_name ?? 'your partner'} now support this Rent Plan.</h1>
        <p className="text-sm">Your portfolio: {formatUGX(result.your_share)}</p>
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
      <h1 className="text-lg font-bold leading-snug">
        {preview.lead_first_name ?? 'A partner'} wants to support {preview.tenant_first_name ?? 'a tenant'}'s Rent Plan with you
      </h1>
      <div className="overflow-hidden rounded-lg border bg-muted">
        {preview.house_image_url ? (
          <img src={preview.house_image_url} alt="House" className="aspect-[16/9] w-full object-cover" />
        ) : (
          <div className="flex aspect-[16/9] items-center justify-center bg-primary/5"><Home className="h-8 w-8 text-primary/45" aria-hidden /></div>
        )}
      </div>
      {preview.city ? <p className="text-sm text-muted-foreground">{preview.city}</p> : null}
      {preview.your_share != null ? <p className="text-sm font-semibold">Your half: {formatUGX(preview.your_share)}</p> : null}
      {preview.expires_at ? <CoSupportCountdown expiresAt={preview.expires_at} /> : null}
    </>
  );

  if (!preview.signed_in) {
    return shell(
      <>
        {header}
        <div className="grid gap-2">
          <Button onClick={() => navigate(coSupportSignInPath(code))}>I have an account</Button>
          <Button variant="outline" onClick={() => navigate(coSupportOnboardingPath(code, preview.referrer_id))}>I'm new to Welile</Button>
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
        {preview.your_monthly_rent_profit_share != null ? (
          <p className="text-sm">
            Your Rent Profit Share: <span className="font-semibold text-primary">{formatUGX(preview.your_monthly_rent_profit_share)}</span> a month
          </p>
        ) : null}
        {result && !result.ok && result.message ? <p className="text-sm text-destructive">{result.message} Nothing was charged.</p> : null}
        <div className="grid gap-2">
          <Button onClick={doAccept} disabled={accept.isPending || decline.isPending}>
            {accept.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Accept
          </Button>
          <Button variant="outline" onClick={doDecline} disabled={accept.isPending || decline.isPending}>Decline</Button>
        </div>
      </>,
    );
  }

  const block = coSupportBlockMessage(preview);
  const next =
    preview.reason === 'not_a_partner'
      ? { label: 'Finish partner sign-up', to: coSupportOnboardingPath(code, preview.referrer_id) }
      : preview.reason === 'agreement_required'
        ? { label: 'Sign your partnership agreement', to: '/dashboard/funder' }
        : preview.reason === 'funds_short'
          ? { label: 'Add float to your wallet', to: '/dashboard/funder' }
          : null;
  return shell(
    <>
      {header}
      {block ? <p className="text-sm text-foreground">{block}</p> : null}
      {next ? (
        <>
          <Button className="w-full" onClick={() => navigate(next.to)}>{next.label}</Button>
          {preview.reason !== 'not_a_partner' ? (
            <p className="text-xs text-muted-foreground">Then open this link again to take your half.</p>
          ) : null}
        </>
      ) : null}
    </>,
  );
}
