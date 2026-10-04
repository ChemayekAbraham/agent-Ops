import { useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { BadgeCheck, IdCard, Loader2, Phone, ShieldQuestion, UserCog, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useProxyAgentApplications,
  useDecideProxyAgent,
  type ProxyApplicationRow,
} from '@/hooks/useProxyAgentApproval';

const statusTone: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  approved: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  rejected: 'bg-destructive/15 text-destructive border-destructive/30',
  suspended: 'bg-muted text-muted-foreground border-border',
};

function ApplicationCard({ row }: { row: ProxyApplicationRow }) {
  const decide = useDecideProxyAgent();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const submit = (decision: 'approved' | 'rejected') => {
    if (decision === 'rejected' && reason.trim().length < 10) {
      toast.error('Give a reason of at least 10 characters');
      return;
    }
    decide.mutate(
      { agentUserId: row.agent_user_id, decision, notes: decision === 'rejected' ? reason.trim() : undefined },
      {
        onSuccess: () => {
          toast.success(decision === 'approved' ? 'Proxy agent approved' : 'Application rejected');
          setRejecting(false);
          setReason('');
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save the decision'),
      },
    );
  };

  const name = row.full_name || row.profile_name || 'Unnamed applicant';
  const phone = row.phone || row.profile_phone || '—';

  return (
    <div className="rounded-xl border bg-card p-3 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-sm truncate">{name}</p>
          <p className="text-xs text-muted-foreground">
            Applied {format(new Date(row.submitted_at), 'd MMM yyyy, HH:mm')}
          </p>
        </div>
        <Badge variant="outline" className={statusTone[row.status] ?? ''}>{row.status}</Badge>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex items-center gap-1.5 min-w-0">
          <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="truncate">{phone}</span>
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          <IdCard className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="truncate">{row.nin || '—'}</span>
        </div>
        <div className="text-muted-foreground truncate">
          Lead partner: <span className="text-foreground">{row.lead_name || 'Not attached'}</span>
        </div>
        <div className="text-muted-foreground truncate">
          Invite code: <span className="text-foreground">{row.invite_code || '—'}</span>
        </div>
      </div>

      {row.status !== 'pending' && (row.review_notes || row.reviewer_name) && (
        <p className="text-xs text-muted-foreground">
          {row.reviewer_name ? `Reviewed by ${row.reviewer_name}` : 'Reviewed'}
          {row.reviewed_at ? ` on ${format(new Date(row.reviewed_at), 'd MMM yyyy')}` : ''}
          {row.review_notes ? ` — ${row.review_notes}` : ''}
        </p>
      )}

      {row.status === 'pending' && (
        <>
          {rejecting && (
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this application rejected? (min 10 characters)"
              className="text-sm"
              rows={2}
            />
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1"
              disabled={decide.isPending}
              onClick={() => (rejecting ? submit('rejected') : submit('approved'))}
            >
              {decide.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {rejecting ? 'Confirm rejection' : (<><BadgeCheck className="mr-1.5 h-3.5 w-3.5" />Approve</>)}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={decide.isPending}
              onClick={() => { setRejecting((v) => !v); setReason(''); }}
            >
              {rejecting ? <X className="h-3.5 w-3.5" /> : 'Reject'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function ProxyAgentApplicationsQueue() {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const { data, isLoading, error } = useProxyAgentApplications(status);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <UserCog className="h-4 w-4 text-primary" />
          Proxy agent applications
          {status === 'pending' && data && data.length > 0 && (
            <Badge variant="outline" className={statusTone.pending}>{data.length} awaiting</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Tabs value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="pending">Pending</TabsTrigger>
            <TabsTrigger value="approved">Approved</TabsTrigger>
            <TabsTrigger value="rejected">Rejected</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading applications…
          </div>
        )}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {!isLoading && !error && (data ?? []).length === 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            <ShieldQuestion className="h-4 w-4" /> No {status === 'all' ? '' : status} applications.
          </div>
        )}
        <div className="space-y-2">
          {(data ?? []).map((row) => (
            <ApplicationCard key={row.agent_user_id} row={row} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
