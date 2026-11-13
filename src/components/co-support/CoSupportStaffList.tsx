import { Loader2, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import { coSupportErrorMessage } from '@/lib/coSupport';
import { useCoSupportStaffList } from '@/hooks/useCoSupport';
import { CoSupportStaffCancel } from './CoSupportStaffCancel';

/** Partner Ops "Shared supports": Rent Plans and houses two partners share. */
export function CoSupportStaffList() {
  const { data, isLoading, error } = useCoSupportStaffList();

  return (
    <section className="space-y-3 rounded-2xl border bg-card p-4 shadow-sm">
      <h2 className="flex items-center gap-2 text-base font-bold text-foreground">
        <Users className="h-4 w-4 text-primary" aria-hidden />
        Shared supports
      </h2>
      {isLoading ? (
        <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden /></div>
      ) : error ? (
        <p className="text-sm text-destructive">{coSupportErrorMessage(error)}</p>
      ) : !data?.length ? (
        <p className="text-sm text-muted-foreground">No shared supports yet.</p>
      ) : (
        <ul className="space-y-2">
          {data.map((r) => {
            const canCancel = !(Number(r.landlord_paid_out) > 0) && !(r.kind === 'house' && r.status === 'awaiting_approval');
            return (
              <li key={r.invite_id} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-foreground">{r.title}</p>
                  <Badge variant="outline">{r.kind === 'house' ? 'Empty house' : 'Rent Plan'}</Badge>
                  <Badge variant={r.status === 'funded' ? 'default' : 'secondary'}>
                    {r.status === 'funded' ? 'Funded' : 'Waiting for approval'}
                  </Badge>
                </div>
                {r.place ? <p className="text-xs text-muted-foreground">{r.place}</p> : null}
                <ul className="text-sm text-foreground">
                  {r.partners.map((p) => (
                    <li key={p.partner_id}>{p.name ?? 'Partner'}: {formatUGX(Number(p.amount) || 0)}</li>
                  ))}
                </ul>
                {r.accepted_at ? (
                  <p className="text-xs text-muted-foreground">Accepted {new Date(r.accepted_at).toLocaleDateString()}</p>
                ) : null}
                {canCancel ? <CoSupportStaffCancel inviteId={r.invite_id} kind={r.kind} /> : null}
                {r.kind === 'house' && r.status === 'awaiting_approval' ? (
                  <p className="text-xs text-muted-foreground">Shared house, approved together. Reject it from the approval queue to cancel both halves.</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
