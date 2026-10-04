import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import {
  MapPin, Camera, CheckCircle2, XCircle, Loader2, Clock, Phone,
  User2, AlertTriangle, Eye, Shield
} from 'lucide-react';
import { toast } from 'sonner';

const statusColors: Record<string, string> = {
  pending_receipt: 'bg-muted text-muted-foreground',
  pending_landlord_ops: 'bg-warning/20 text-warning border-warning/30',
  landlord_ops_approved: 'bg-blue-500/20 text-blue-600 border-blue-500/30',
  cfo_approved: 'bg-success/20 text-success border-success/30',
  completed: 'bg-success/20 text-success border-success/30',
  rejected: 'bg-destructive/20 text-destructive border-destructive/30',
};

const statusLabels: Record<string, string> = {
  pending_receipt: 'Awaiting Receipt',
  pending_landlord_ops: 'Pending Review',
  landlord_ops_approved: 'Ops Approved',
  cfo_approved: 'CFO Approved',
  completed: 'Completed',
  rejected: 'Rejected',
};

interface LandlordOpsPayoutReviewProps {
  /** 'landlord_ops' for operational review, 'cfo' for financial sign-off */
  reviewRole: 'landlord_ops' | 'cfo';
}

export function LandlordOpsPayoutReview({ reviewRole }: LandlordOpsPayoutReviewProps) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [selectedPayout, setSelectedPayout] = useState<any>(null);
  const [reviewNotes, setReviewNotes] = useState('');

  const targetStatus = reviewRole === 'landlord_ops' ? 'pending_landlord_ops' : 'landlord_ops_approved';

  const { data: payouts = [], isLoading } = useQuery({
    queryKey: ['landlord-payouts-review', reviewRole],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_landlord_payouts')
        .select('*')
        .eq('status', targetStatus)
        .order('created_at', { ascending: true });
      if (error) throw error;

      // Enrich with agent info
      const enriched = await Promise.all((data || []).map(async (p: any) => {
        const { data: agent } = await supabase.from('profiles').select('full_name, phone').eq('id', p.agent_id).single();
        return { ...p, agent };
      }));
      return enriched;
    },
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  const approveMutation = useMutation({
    mutationFn: async (payoutId: string) => {
      if (!user) throw new Error('Not authenticated');
      const now = new Date().toISOString();
      const updateData: any = {};

      if (reviewRole === 'landlord_ops') {
        updateData.status = 'landlord_ops_approved';
        updateData.landlord_ops_approved_by = user.id;
        updateData.landlord_ops_approved_at = now;
        updateData.landlord_ops_notes = reviewNotes || null;
      } else {
        updateData.status = 'completed';
        updateData.cfo_approved_by = user.id;
        updateData.cfo_approved_at = now;
        updateData.cfo_notes = reviewNotes || null;
      }
      updateData.updated_at = now;

      const { error } = await supabase
        .from('agent_landlord_payouts')
        .update(updateData)
        .eq('id', payoutId);
      if (error) throw error;

      // Audit log
      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: `landlord_payout_${reviewRole}_approve`,
        table_name: 'agent_landlord_payouts',
        record_id: payoutId,
        metadata: { notes: reviewNotes, role: reviewRole },
      });
    },
    onSuccess: () => {
      toast.success('Payout approved!');
      setSelectedPayout(null);
      setReviewNotes('');
      qc.invalidateQueries({ queryKey: ['landlord-payouts-review'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const rejectMutation = useMutation({
    mutationFn: async (payoutId: string) => {
      if (!user) throw new Error('Not authenticated');
      if (!reviewNotes.trim() || reviewNotes.length < 10) throw new Error('Rejection reason must be at least 10 characters');

      const { error } = await supabase
        .from('agent_landlord_payouts')
        .update({
          status: 'rejected',
          rejection_reason: reviewNotes,
          updated_at: new Date().toISOString(),
        })
        .eq('id', payoutId);
      if (error) throw error;

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: `landlord_payout_${reviewRole}_reject`,
        table_name: 'agent_landlord_payouts',
        record_id: payoutId,
        metadata: { reason: reviewNotes, role: reviewRole },
      });
    },
    onSuccess: () => {
      toast.success('Payout rejected');
      setSelectedPayout(null);
      setReviewNotes('');
      qc.invalidateQueries({ queryKey: ['landlord-payouts-review'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const title = reviewRole === 'landlord_ops' ? 'Landlord Ops: Payout Verification' : 'CFO: Landlord Payout Sign-off';

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            {title}
            {payouts.length > 0 && <Badge variant="destructive" className="text-[10px] ml-auto">{payouts.length}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading ? (
            <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : payouts.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">No payouts pending review</p>
          ) : (
            payouts.map((p: any) => (
              <div
                key={p.id}
                className="p-3 rounded-lg border bg-card hover:bg-muted/30 cursor-pointer transition-colors"
                onClick={() => { setSelectedPayout(p); setReviewNotes(''); }}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium text-sm">{p.landlord_name}</span>
                  <Badge variant="outline" className={`text-[10px] ${statusColors[p.status] || ''}`}>
                    {statusLabels[p.status] || p.status}
                  </Badge>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="font-bold text-foreground">{formatUGX(p.amount)}</span>
                  <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{p.landlord_phone}</span>
                  <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{format(new Date(p.created_at), 'HH:mm')}</span>
                </div>
                <div className="flex items-center gap-2 mt-1 text-xs">
                  <User2 className="h-3 w-3 text-muted-foreground" />
                  <span>Agent: {p.agent?.full_name || 'Unknown'}</span>
                  {p.gps_match ? (
                    <Badge variant="outline" className="text-[9px] bg-success/10 text-success">GPS ✓ Match</Badge>
                  ) : p.gps_distance_meters != null ? (
                    <Badge variant="outline" className="text-[9px] bg-warning/10 text-warning">
                      GPS {p.gps_distance_meters}m away
                    </Badge>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Detail dialog */}
      <Dialog open={!!selectedPayout} onOpenChange={() => setSelectedPayout(null)}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm">Review Landlord Payout</DialogTitle>
          </DialogHeader>
          {selectedPayout && (
            <div className="space-y-4">
              {/* Payout details */}
              <div className="p-3 rounded-lg bg-primary/5 border border-primary/20 space-y-1 text-xs">
                <div className="grid grid-cols-2 gap-1">
                  <div><span className="text-muted-foreground">Landlord:</span> <span className="font-bold">{selectedPayout.landlord_name}</span></div>
                  <div><span className="text-muted-foreground">Amount:</span> <span className="font-bold">{formatUGX(selectedPayout.amount)}</span></div>
                  <div><span className="text-muted-foreground">Phone:</span> <span className="font-mono">{selectedPayout.landlord_phone}</span></div>
                  <div><span className="text-muted-foreground">Provider:</span> {selectedPayout.mobile_money_provider}</div>
                  <div className="col-span-2"><span className="text-muted-foreground">TID:</span> <span className="font-mono font-bold">{selectedPayout.transaction_id}</span></div>
                  <div><span className="text-muted-foreground">Agent:</span> {selectedPayout.agent?.full_name}</div>
                  <div><span className="text-muted-foreground">Date:</span> {format(new Date(selectedPayout.created_at), 'dd MMM yyyy HH:mm')}</div>
                </div>
              </div>

              {/* GPS verification */}
              <div className="p-3 rounded-lg border space-y-1">
                <h4 className="text-xs font-bold flex items-center gap-1"><MapPin className="h-3 w-3" />GPS Verification</h4>
                {selectedPayout.latitude && (
                  <p className="text-xs text-muted-foreground">
                    Agent location: {Number(selectedPayout.latitude).toFixed(5)}, {Number(selectedPayout.longitude).toFixed(5)}
                    {selectedPayout.location_accuracy && ` (±${Number(selectedPayout.location_accuracy).toFixed(0)}m)`}
                  </p>
                )}
                {selectedPayout.gps_distance_meters != null && (
                  <div className="flex items-center gap-2">
                    {selectedPayout.gps_match ? (
                      <Badge className="bg-success/20 text-success text-[10px]">
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        Within {selectedPayout.gps_distance_meters}m of property
                      </Badge>
                    ) : (
                      <Badge className="bg-warning/20 text-warning text-[10px]">
                        <AlertTriangle className="h-3 w-3 mr-1" />
                        {selectedPayout.gps_distance_meters}m from property
                      </Badge>
                    )}
                  </div>
                )}
              </div>

              {/* Receipt photos */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold flex items-center gap-1"><Camera className="h-3 w-3" />Receipt Photos</h4>
                <div className="flex gap-2 flex-wrap">
                  {(selectedPayout.receipt_photo_urls || []).map((url: string, i: number) => (
                    <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                      <img src={url} alt={`Receipt ${i + 1}`} className="h-24 w-24 object-cover rounded-lg border hover:border-primary transition-colors" />
                    </a>
                  ))}
                </div>
              </div>

              {selectedPayout.notes && (
                <div className="text-xs"><span className="text-muted-foreground">Agent notes:</span> {selectedPayout.notes}</div>
              )}

              {/* Review actions */}
              <div className="space-y-2 border-t pt-3">
                <Textarea
                  placeholder={reviewRole === 'landlord_ops' ? 'Verification notes (required for rejection)' : 'CFO notes (required for rejection)'}
                  value={reviewNotes}
                  onChange={e => setReviewNotes(e.target.value)}
                  className="text-sm h-16"
                />
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="flex-1"
                    disabled={rejectMutation.isPending || approveMutation.isPending}
                    onClick={() => rejectMutation.mutate(selectedPayout.id)}
                  >
                    {rejectMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3 mr-1" />}
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={approveMutation.isPending || rejectMutation.isPending}
                    onClick={() => approveMutation.mutate(selectedPayout.id)}
                  >
                    {approveMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3 mr-1" />}
                    Approve
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
