/**
 * "My National ID" — shows who else is attached to the same National ID.
 *
 * The ID holder sees each attached person's photo, name, phone and email and
 * may remove them (with a written reason). Anyone merely attached sees only
 * the holder's name and phone. The ID number is always masked.
 */
import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Loader2, ShieldCheck, UserMinus, Phone, Mail } from 'lucide-react';
import { toast } from 'sonner';
import {
  useNationalIdGroup,
  useUnlinkFromMyNationalId,
  maskNationalId,
  type NationalIdGroupMember,
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

export default function NationalIdGroupSheet({ open, onOpenChange }: Props) {
  const { data, isLoading } = useNationalIdGroup(open);
  const unlink = useUnlinkFromMyNationalId();
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const masked = maskNationalId(data?.masked_nin);
  const members: NationalIdGroupMember[] = data?.members ?? [];

  const confirmRemove = async (memberId: string) => {
    if (reason.trim().length < 10) {
      toast.error('Please write a short reason (at least 10 characters).');
      return;
    }
    try {
      const res = await unlink.mutateAsync({ memberId, reason: reason.trim() });
      toast.success(res.sms_sent ? 'Removed. They have been sent an SMS.' : 'Removed from your National ID.');
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

              {members.map((m) => (
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

                  {removing === m.user_id ? (
                    <div className="mt-3 space-y-2">
                      <Textarea
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Why are you removing this person? (at least 10 characters)"
                        rows={3}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={unlink.isPending || reason.trim().length < 10}
                          onClick={() => confirmRemove(m.user_id)}
                        >
                          {unlink.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                          Confirm removal
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
                      onClick={() => { setRemoving(m.user_id); setReason(''); }}
                    >
                      <UserMinus className="mr-1.5 h-4 w-4" />
                      Remove from my ID
                    </Button>
                  )}
                </div>
              ))}
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
