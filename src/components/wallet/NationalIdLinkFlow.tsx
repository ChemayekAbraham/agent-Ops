/**
 * Asking to be linked to a National ID another account already holds.
 *
 * Three things must happen, in this order: a code goes to the number on the
 * holder's account and is typed back here, the holder answers Yes in the app
 * (this screen re-checks every 25 seconds), and staff confirm the details.
 * The request closes on its own after 7 days.
 *
 * Only the ID number is shown — never anything about the holder.
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, Clock, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useNationalIdLinkOtp, useNationalIdLinkState, useRequestNationalIdLink,
} from '@/hooks/useNationalIdLink';

function Step({
  state, title, note,
}: { state: 'done' | 'todo' | 'failed'; title: string; note?: string }) {
  const Icon = state === 'done' ? CheckCircle2 : state === 'failed' ? XCircle : Clock;
  const tone =
    state === 'done' ? 'text-emerald-600' : state === 'failed' ? 'text-destructive' : 'text-muted-foreground';
  return (
    <div className="flex items-start gap-2">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
      <div className="min-w-0">
        <p className="text-xs font-semibold text-foreground">{title}</p>
        {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
      </div>
    </div>
  );
}

export default function NationalIdLinkFlow({
  nin, onLinked,
}: {
  /** The ID number the person typed off the card. */
  nin: string;
  /** Called once staff have confirmed and the account may continue. */
  onLinked?: () => void;
}) {
  const start = useRequestNationalIdLink();
  const [requestId, setRequestId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const state = useNationalIdLinkState(requestId);
  const { send, verify } = useNationalIdLinkOtp();
  const [code, setCode] = useState('');

  /** Creates the request if it is not there yet, and returns its id. */
  const ensureRequest = async (): Promise<string> => {
    if (requestId) return requestId;
    const res = await start.mutateAsync(nin);
    const id = res.request_id ?? null;
    if (!id) throw new Error('Could not start that request. Please try again.');
    setRequestId(id);
    setStartError(null);
    return id;
  };

  // One request per account per ID; asking again picks up the open one.
  useEffect(() => {
    if (requestId || start.isPending || !nin) return;
    start
      .mutateAsync(nin)
      .then((res) => {
        setRequestId(res.request_id ?? null);
        setStartError(null);
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : 'Could not start that request.';
        setStartError(msg);
        toast.error(msg);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nin]);


  const s = state.data;
  const [seen, setSeen] = useState<string | null>(null);

  // The moment the ID holder answers, say so here — the person asking should
  // never have to guess or refresh.
  useEffect(() => {
    const now = s?.status;
    if (!now || now === seen) return;
    if (seen !== null) {
      if (now === 'owner_approved') {
        toast.success('The ID holder allowed it. You can carry on with your details now.');
      } else if (now === 'rejected_by_owner') {
        toast.error('The ID holder did not agree, so your account was not linked.');
      } else if (now === 'active') {
        toast.success('Welile staff confirmed it. Your account is now on that National ID.');
      } else if (now === 'rejected_by_staff') {
        toast.error('Welile staff did not confirm it. Contact Welile Support on 0748747134.');
      } else if (now === 'expired') {
        toast.error('Nobody answered within 7 days, so this request closed. You can start again.');
      }
    }
    setSeen(now);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.status]);

  useEffect(() => {
    if (s?.status === 'active' || s?.status === 'owner_approved') onLinked?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.status]);

  const status = s?.status;
  const closed =
    status === 'rejected_by_owner' || status === 'rejected_by_staff' || status === 'expired';

  const doSend = async () => {
    try {
      const id = await ensureRequest();
      await send.mutateAsync(id);
      toast.success('Code sent to the number on that National ID.');
      state.refetch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not send the code.';
      setStartError(msg);
      toast.error(msg);
    }
  };


  const doVerify = async () => {
    if (!requestId) return;
    try {
      await verify.mutateAsync({ requestId, code });
      setCode('');
      toast.success('Code confirmed. Waiting for the ID holder to allow it in their app.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That code is not right.');
    }
  };

  return (
    <div className="space-y-3 rounded-2xl border-2 border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15">
          <ShieldAlert className="h-5 w-5 text-amber-600" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-foreground">This National ID is already registered</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            National ID <span className="font-mono font-semibold text-foreground">{nin}</span> is
            already on another Welile account. You can be added to it, but the person who holds it
            must agree first.
          </p>
        </div>
      </div>

      {start.isPending || state.isLoading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Setting up your request…
        </p>
      ) : (
        <>
          <div className="space-y-2">
            <Step
              state={s?.code_verified ? 'done' : 'todo'}
              title="Code sent to the number on that National ID"
              note={
                s?.code_verified
                  ? 'Confirmed.'
                  : 'Ask the holder for the code we texted them, then type it below.'
              }
            />
            <Step
              state={status === 'rejected_by_owner' ? 'failed' : s?.owner_confirmed ? 'done' : 'todo'}
              title="The ID holder allows it in their app"
              note={
                status === 'rejected_by_owner'
                  ? 'They did not agree, so your account was not linked.'
                  : s?.owner_confirmed
                    ? 'They agreed.'
                    : 'We check every few seconds. They see a prompt when they open Welile.'
              }
            />
            <Step
              state={status === 'active' ? 'done' : status === 'rejected_by_staff' ? 'failed' : 'todo'}
              title="Welile staff confirm the details"
              note={
                status === 'active'
                  ? 'Done — you can continue.'
                  : status === 'rejected_by_staff'
                    ? 'Staff did not confirm it. Contact Welile Support on 0748747134.'
                    : 'The last step, once the holder has agreed.'
              }
            />
          </div>

          {!closed && status !== 'active' && !s?.code_verified && (
            <div className="space-y-2">
              <Button variant="outline" className="h-11 w-full" onClick={doSend} disabled={send.isPending}>
                {send.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {s?.code_sent ? 'Send the code again' : 'Send code to the ID holder'}
              </Button>
              {s?.code_sent && (
                <div>
                  <Label className="text-xs">6-digit code from the ID holder</Label>
                  <div className="flex gap-2">
                    <Input
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="123456"
                      inputMode="numeric"
                      className="h-11 tracking-[0.3em]"
                    />
                    <Button
                      className="h-11"
                      onClick={doVerify}
                      disabled={code.length !== 6 || verify.isPending}
                    >
                      {verify.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {s?.expires_at && !closed && status !== 'active' && (
            <p className="text-[11px] text-muted-foreground">
              This request closes on its own on{' '}
              {new Date(s.expires_at).toLocaleDateString('en-GB', { dateStyle: 'medium' })} if it is
              not answered.
            </p>
          )}
          {closed && (
            <p className="text-[11px] text-destructive">
              {status === 'expired'
                ? 'Nobody answered within 7 days, so this request closed. You can start again.'
                : 'This request was closed.'}
            </p>
          )}
        </>
      )}
    </div>
  );
}
