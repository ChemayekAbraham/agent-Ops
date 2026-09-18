/**
 * "My National ID" — shows who else is attached to the same National ID.
 *
 * The ID holder sees each attached person's photo, name, phone and email and
 * may ask Finance Operations to remove them, giving a written reason. The
 * removal only happens once Finance Operations approves it, and each person's
 * card shows where their request stands. Anyone merely attached sees only the
 * holder's name and phone. The ID number is always masked.
 */
import { useMemo, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Loader2, ShieldCheck, UserMinus, Phone, Mail, Clock } from 'lucide-react';
import { toast } from 'sonner';
import {
  useNationalIdGroup,
  useRequestNationalIdUnlink,
  useMyNationalIdUnlinkRequests,
  maskNationalId,
  type NationalIdGroupMember,
  type UnlinkRequest,
} from '@/hooks/useNationalIdGroup';

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

function initials(name?: string | null) {
  return String(name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?';
}

const stamp = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';

/** The badge shown on a person's card for their latest removal request. */
function RequestStatusBadge({ request }: { request: UnlinkRequest }) {
  if (request.status === 'pending') {
    return (
      <Badge className="bg-amber-500/15 text-[10px] text-amber-700 hover:bg-amber-500/15">
        <Clock className="mr-1 h-3 w-3" />
        Removal pending Finance Operations
      </Badge>
    );
  }
  if (request.status === 'approved') {
    return (
      <Badge className="bg-emerald-500/15 text-[10px] text-emerald-700 hover:bg-emerald-500/15">
        Removal approved {stamp(request.decided_at)}
      </Badge>
    );
  }
  if (request.status === 'rejected') {
    return (
      <Badge variant="destructive" className="text-[10px]">
        Removal refused {stamp(request.decided_at)}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-[10px]">
      Removal closed
    </Badge>
  );
}

export default function NationalIdGroupSheet({ open, onOpenChange }: Props) {
  const { data, isLoading } = useNationalIdGroup(open);
  const requests = useMyNationalIdUnlinkRequests(open);
  const ask = useRequestNationalIdUnlink();
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const masked = maskNationalId(data?.masked_nin);
  const members: NationalIdGroupMember[] = data?.members ?? [];

  /** Latest request per person — the card shows only the most recent one. */
  const latestByMember = useMemo(() => {
    const map = new Map<string, UnlinkRequest>();
    (requests.data ?? []).forEach((r) => {
      if (!map.has(r.member_id)) map.set(r.member_id, r);
    });
    return map;
  }, [requests.data]);

  const confirmRemove = async (memberId: string) => {
    if (reason.trim().length < 10) {
      toast.error('Please write a reason (at least 10 characters).');
      return;
    }
    try {
      await ask.mutateAsync({ memberId, reason: reason.trim() });
      toast.success('Sent to Finance Operations for approval.');
      setRemoving(null);
      setReason('');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };


  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[88vh] overflow-y-auto rounded-t-3xl">
        <SheetHeader className="text-left">
          <SheetTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            My National ID
          </SheetTitle>
          <SheetDescription>
            {masked ? `National ID ${masked}` : 'Your National ID details'}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4 pb-6">
          {isLoading && (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}

          {!isLoading && !data?.found && (
            <p className="rounded-2xl bg-muted/50 p-4 text-sm text-muted-foreground">
              No National ID is saved on your account yet. Add your ID first and this will show
              anyone else attached to it.
            </p>
          )}

          {!isLoading && data?.found && data.is_owner && (
            <>
              <p className="text-sm text-muted-foreground">
                {members.length === 0
                  ? 'Only you are using this National ID.'
                  : `${members.length} ${members.length === 1 ? 'person is' : 'people are'} attached to your National ID.`}
              </p>

              {members.map((m) => {
                const request = latestByMember.get(m.user_id);
                const pending = request?.status === 'pending';
                return (
                <div key={m.user_id} className="rounded-2xl border border-border/60 bg-card p-4">
                  <div className="flex items-start gap-3">
                    <Avatar className="h-11 w-11">
                      <AvatarImage src={m.avatar_url ?? undefined} alt={m.full_name ?? 'Member'} />
                      <AvatarFallback>{initials(m.full_name)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-foreground">{m.full_name || 'Unnamed account'}</p>
                      {m.phone && (
                        <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                          <Phone className="h-3.5 w-3.5" /> {m.phone}
                        </p>
                      )}
                      {m.email && (
                        <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                          <Mail className="h-3.5 w-3.5" /> {m.email}
                        </p>
                      )}
                    </div>
                  </div>

                  {request && (
                    <div className="mt-3 space-y-1">
                      <RequestStatusBadge request={request} />
                      <p className="text-[11px] text-muted-foreground">
                        Your reason: “{request.reason}”
                      </p>
                      {request.decision_note && (
                        <p className="text-[11px] text-muted-foreground">
                          Finance Operations said: “{request.decision_note}”
                        </p>
                      )}
                    </div>
                  )}

                  {removing === m.user_id ? (
                    <div className="mt-3 space-y-2">
                      <Textarea
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Why should this person be removed from your ID? (at least 10 characters)"
                        rows={3}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Finance Operations reviews every removal, so give them the full reason.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={ask.isPending || reason.trim().length < 10}
                          onClick={() => confirmRemove(m.user_id)}
                        >
                          {ask.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                          Send for approval
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => { setRemoving(null); setReason(''); }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-3"
                      disabled={pending}
                      onClick={() => { setRemoving(m.user_id); setReason(''); }}
                    >
                      <UserMinus className="mr-1.5 h-4 w-4" />
                      {pending ? 'Waiting for approval' : 'Ask to remove from my ID'}
                    </Button>
                  )}
                </div>
                );
              })}

            </>
          )}

          {!isLoading && data?.found && data.is_owner === false && (
            <div className="rounded-2xl border border-border/60 bg-card p-4">
              <Badge variant="secondary" className="mb-2">You are attached to this ID</Badge>
              <p className="font-semibold text-foreground">
                {data.owner?.full_name || 'The ID holder'}
              </p>
              {data.owner?.phone && (
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Phone className="h-3.5 w-3.5" /> {data.owner.phone}
                </p>
              )}
              <p className="mt-3 text-xs text-muted-foreground">
                This National ID belongs to them. Only they can see everyone attached to it, and only
                they can remove someone.
              </p>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
