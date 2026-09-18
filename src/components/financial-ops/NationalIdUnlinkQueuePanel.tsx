/**
 * Finance Operations reviews requests from ID holders to remove someone
 * attached to their National ID. Approving performs the removal and tells the
 * removed person; refusing leaves the link in place.
 */
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { CheckCircle2, IdCard, Loader2, XCircle } from 'lucide-react';
import {
  useNationalIdUnlinkQueue,
  useDecideNationalIdUnlink,
  maskNationalId,
} from '@/hooks/useNationalIdGroup';

const TONES: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-700',
  approved: 'bg-emerald-500/15 text-emerald-700',
  rejected: 'bg-destructive/15 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting for you',
  approved: 'Approved',
  rejected: 'Refused',
  cancelled: 'Closed',
};

const stamp = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

export function NationalIdUnlinkQueuePanel() {
  const [status, setStatus] = useState<'pending' | 'all'>('pending');
  const { data, isLoading } = useNationalIdUnlinkQueue(status);
  const decide = useDecideNationalIdUnlink();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const act = async (id: string, approve: boolean) => {
    setBusyId(id);
    try {
      await decide.mutateAsync({ requestId: id, approve, note: notes[id]?.trim() || undefined });
      toast.success(approve ? 'Removed from the ID and the person has been told.' : 'Request refused.');
      setNotes((n) => ({ ...n, [id]: '' }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const rows = data ?? [];

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold">
            <IdCard className="h-4 w-4 text-primary" />
            National ID removal requests
          </h2>
          <p className="text-xs text-muted-foreground">
            An ID holder has asked for someone to be taken off their National ID. Approving removes them.
          </p>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] font-semibold text-muted-foreground">Show</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as 'pending' | 'all')}>
            <SelectTrigger className="h-9 w-[150px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending" className="text-xs">Waiting for me</SelectItem>
              <SelectItem value="all" className="text-xs">Everything</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {isLoading ? (
          <>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-2/3" />
          </>
        ) : rows.length === 0 ? (
          <p className="rounded-xl bg-muted/50 p-4 text-sm text-muted-foreground">
            Nothing to review right now.
          </p>
        ) : (
          rows.map((r) => (
            <div key={r.id} className="rounded-xl border border-border/60 bg-card p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {r.member_name || 'Unnamed account'}
                    <span className="font-normal text-muted-foreground"> to be removed from </span>
                    {r.owner_name || 'the ID holder'}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    National ID {maskNationalId(r.nin_masked)} · {r.member_phone ?? 'No number'} · asked {stamp(r.created_at)}
                  </p>
                </div>
                <Badge className={`${TONES[r.status] ?? ''} text-[10px]`}>
                  {STATUS_LABEL[r.status] ?? r.status}
                </Badge>
              </div>

              <p className="mt-2 text-xs leading-snug">
                <span className="font-semibold">Reason given: </span>
                {r.reason}
              </p>

              {r.status === 'pending' ? (
                <div className="mt-3 space-y-2">
                  <Input
                    value={notes[r.id] ?? ''}
                    onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                    placeholder="Your note (optional)"
                    className="h-9 text-xs"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="h-8 text-[11px] font-semibold"
                      disabled={busyId === r.id}
                      onClick={() => act(r.id, true)}
                    >
                      {busyId === r.id ? (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                      )}
                      Approve removal
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-[11px] font-semibold"
                      disabled={busyId === r.id}
                      onClick={() => act(r.id, false)}
                    >
                      <XCircle className="mr-1 h-3.5 w-3.5" />
                      Refuse
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {STATUS_LABEL[r.status] ?? r.status} by {r.decided_by_name ?? 'Finance Operations'} · {stamp(r.decided_at)}
                  {r.decision_note ? ` · “${r.decision_note}”` : ''}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
