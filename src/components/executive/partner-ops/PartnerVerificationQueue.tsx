import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ShieldCheck, ShieldX, UserCheck, Clock, RefreshCw } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';

const SELF_REG_SOURCE = 'funder-onboarding';

interface FunderRow {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  district: string | null;
  city: string | null;
  occupation: string | null;
  created_at: string;
  funder_verified_at: string | null;
  funder_rejected_at: string | null;
  funder_rejection_reason: string | null;
}

type QueueTab = 'pending' | 'verified' | 'rejected';

export function PartnerVerificationQueue() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<QueueTab>('pending');
  const [target, setTarget] = useState<{ row: FunderRow; mode: 'approve' | 'reject' } | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { data: rows = [], isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['partner-ops-self-registered-funders'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select(
          'id, full_name, email, phone, district, city, occupation, created_at, funder_verified_at, funder_rejected_at, funder_rejection_reason',
        )
        .eq('signup_source', SELF_REG_SOURCE)
        .order('created_at', { ascending: false })
        .limit(400);
      if (error) throw error;
      return (data || []) as FunderRow[];
    },
    staleTime: 30_000,
  });

  const pending = rows.filter((r) => !r.funder_verified_at && !r.funder_rejected_at);
  const verified = rows.filter((r) => !!r.funder_verified_at);
  const rejected = rows.filter((r) => !r.funder_verified_at && !!r.funder_rejected_at);

  const visible = tab === 'pending' ? pending : tab === 'verified' ? verified : rejected;

  const submit = async () => {
    if (!target) return;
    const trimmed = reason.trim();
    if (trimmed.length < 10) {
      toast({
        title: 'Add a longer note',
        description: 'Write at least 10 characters explaining this decision.',
        variant: 'destructive',
      });
      return;
    }
    setSubmitting(true);
    try {
      const fn = target.mode === 'approve'
        ? 'approve_self_registered_funder'
        : 'reject_self_registered_funder';
      const { error } = await supabase.rpc(fn as never, {
        _target_user: target.row.id,
        _reason: trimmed,
      } as never);
      if (error) throw error;
      toast({
        title: target.mode === 'approve' ? 'Partner verified' : 'Partner rejected',
        description: `${target.row.full_name || target.row.email || 'Partner'} was ${
          target.mode === 'approve' ? 'verified and can now create portfolios' : 'rejected'
        }.`,
      });
      setTarget(null);
      setReason('');
      await queryClient.invalidateQueries({ queryKey: ['partner-ops-self-registered-funders'] });
      await queryClient.invalidateQueries({ queryKey: ['funder-approval-status'] });
    } catch (err: any) {
      const raw: string = err?.message || '';
      toast({
        title: 'Could not save decision',
        description: raw.includes('insufficient_privileges')
          ? 'Your role cannot verify partners. Ask a Partner Ops lead, the COO or a manager.'
          : raw.includes('reason_min_10_chars')
            ? 'The note must be at least 10 characters.'
            : raw || 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <UserCheck className="h-5 w-5 text-primary" />
            Partner Verification
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Partners who registered themselves cannot support tenants or create portfolios until
            verified here.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isRefetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </CardHeader>

      <CardContent>
        <Tabs value={tab} onValueChange={(v) => setTab(v as QueueTab)}>
          <TabsList className="mb-4">
            <TabsTrigger value="pending">Awaiting verification ({pending.length})</TabsTrigger>
            <TabsTrigger value="verified">Verified ({verified.length})</TabsTrigger>
            <TabsTrigger value="rejected">Rejected ({rejected.length})</TabsTrigger>
          </TabsList>

          <TabsContent value={tab} className="mt-0 space-y-3">
            {isLoading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Loading partners…</p>
            ) : visible.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Nothing here right now.
              </p>
            ) : (
              visible.map((row) => (
                <div
                  key={row.id}
                  className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{row.full_name || 'Unnamed partner'}</span>
                      {row.funder_verified_at ? (
                        <Badge variant="secondary" className="gap-1">
                          <ShieldCheck className="h-3 w-3" /> Verified
                        </Badge>
                      ) : row.funder_rejected_at ? (
                        <Badge variant="destructive" className="gap-1">
                          <ShieldX className="h-3 w-3" /> Rejected
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1">
                          <Clock className="h-3 w-3" /> Awaiting verification
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {[row.phone, row.email].filter(Boolean).join(' · ') || 'No contact on file'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {[row.occupation, row.city, row.district].filter(Boolean).join(' · ')}
                      {row.occupation || row.city || row.district ? ' · ' : ''}
                      Registered {format(new Date(row.created_at), 'd MMM yyyy')}
                    </p>
                    {row.funder_rejection_reason && !row.funder_verified_at && (
                      <p className="mt-1 text-xs text-destructive">
                        Reason: {row.funder_rejection_reason}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 gap-2">
                    {!row.funder_verified_at && (
                      <Button
                        size="sm"
                        onClick={() => {
                          setTarget({ row, mode: 'approve' });
                          setReason('');
                        }}
                      >
                        <ShieldCheck className="mr-2 h-4 w-4" />
                        Verify
                      </Button>
                    )}
                    {!row.funder_rejected_at && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setTarget({ row, mode: 'reject' });
                          setReason('');
                        }}
                      >
                        <ShieldX className="mr-2 h-4 w-4" />
                        Reject
                      </Button>
                    )}
                  </div>
                </div>
              ))
            )}
          </TabsContent>
        </Tabs>
      </CardContent>

      <Dialog open={!!target} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {target?.mode === 'approve' ? 'Verify partner' : 'Reject partner'}
            </DialogTitle>
            <DialogDescription>
              {target?.mode === 'approve'
                ? 'Confirm you checked this partner’s identity and contact details. They will be able to support tenants immediately.'
                : 'The partner stays blocked from supporting tenants. They will see this reason.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <p className="text-sm font-medium">
              {target?.row.full_name || target?.row.email || 'Partner'}
            </p>
            <Textarea
              placeholder="Note (minimum 10 characters) — what did you check or why is this rejected?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              maxLength={500}
            />
            <p className="text-xs text-muted-foreground">{reason.trim().length}/10 characters minimum</p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={submitting || reason.trim().length < 10}
              variant={target?.mode === 'reject' ? 'destructive' : 'default'}
            >
              {submitting ? 'Saving…' : target?.mode === 'approve' ? 'Verify partner' : 'Reject partner'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default PartnerVerificationQueue;
