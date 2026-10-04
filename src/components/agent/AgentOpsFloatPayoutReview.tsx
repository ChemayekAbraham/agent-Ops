import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import {
  Landmark, MapPin, Image, CheckCircle2, XCircle, Loader2,
  Phone, User2, ExternalLink, Clock, Navigation
} from 'lucide-react';
import { toast } from 'sonner';

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const statusColors: Record<string, string> = {
  pending_agent_ops: 'bg-warning/20 text-warning-foreground',
  agent_ops_approved: 'bg-primary/20 text-primary',
  agent_ops_rejected: 'bg-destructive/20 text-destructive',
  cfo_approved: 'bg-success/20 text-success',
  completed: 'bg-success/20 text-success',
};

const statusLabels: Record<string, string> = {
  pending_agent_ops: 'Pending Review',
  agent_ops_approved: 'Ops Approved',
  agent_ops_rejected: 'Rejected',
  cfo_approved: 'CFO Approved',
  completed: 'Completed',
};

interface AgentOpsFloatPayoutReviewProps {
  filterStatus?: string[];
  title?: string;
}

export function AgentOpsFloatPayoutReview({ 
  filterStatus = ['pending_agent_ops'],
  title = 'Landlord Float Payout Requests'
}: AgentOpsFloatPayoutReviewProps) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: payouts = [], isLoading } = useQuery({
    queryKey: ['float-payout-reviews', filterStatus],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_float_withdrawals')
        .select('*')
        .in('status', filterStatus)
        .order('created_at', { ascending: true });
      if (error) throw error;

      // Enrich with agent + landlord names
      const enriched = await Promise.all((data || []).map(async (p: any) => {
        const [{ data: agent }, { data: tenant }] = await Promise.all([
          supabase.from('profiles').select('full_name, phone').eq('id', p.agent_id).single(),
          supabase.from('profiles').select('full_name, phone').eq('id', p.tenant_id).single(),
        ]);
        return { ...p, agent, tenant };
      }));
      return enriched;
    },
    enabled: !!user,
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  const reviewMutation = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'approve' | 'reject' }) => {
      const notes = reviewNotes[id] || '';
      if (action === 'reject' && notes.length < 10) throw new Error('Please provide a reason for rejection (min 10 chars)');

      const newStatus = action === 'approve' ? 'agent_ops_approved' : 'agent_ops_rejected';

      const { error } = await supabase
        .from('agent_float_withdrawals')
        .update({
          status: newStatus,
          agent_ops_reviewed_by: user!.id,
          agent_ops_reviewed_at: new Date().toISOString(),
          agent_ops_notes: notes || null,
          updated_at: new Date().toISOString(),
        } as any)
        .eq('id', id);

      if (error) throw error;

      // If rejected, refund float balance
      if (action === 'reject') {
        const payout = payouts.find(p => p.id === id);
        if (payout) {
          await supabase
            .from('agent_landlord_float')
            .update({
              balance: (await supabase.from('agent_landlord_float').select('balance').eq('agent_id', payout.agent_id).single()).data!.balance + payout.amount,
              total_paid_out: (await supabase.from('agent_landlord_float').select('total_paid_out').eq('agent_id', payout.agent_id).single()).data!.total_paid_out - payout.amount,
              updated_at: new Date().toISOString(),
            } as any)
            .eq('agent_id', payout.agent_id);
        }
      }
    },
    onSuccess: (_, { action }) => {
      qc.invalidateQueries({ queryKey: ['float-payout-reviews'] });
      toast.success(action === 'approve' ? 'Payout approved!' : 'Payout rejected and float refunded.');
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="h-4 w-4 text-chart-4" />
          {title}
          {payouts.length > 0 && <Badge variant="secondary" className="text-xs">{payouts.length}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : payouts.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No pending reviews</p>
        ) : (
          <ScrollArea className="max-h-[60vh]">
            <div className="space-y-3">
              {payouts.map((p: any) => {
                const expanded = expandedId === p.id;
                const agentToLandlordDist = p.agent_latitude && p.landlord_latitude
                  ? Math.round(haversineDistance(p.agent_latitude, p.agent_longitude, p.landlord_latitude, p.landlord_longitude))
                  : null;

                return (
                  <Card key={p.id} className="border">
                    <CardContent className="p-3 space-y-2">
                      {/* Header */}
                      <div className="flex items-center justify-between cursor-pointer" onClick={() => setExpandedId(expanded ? null : p.id)}>
                        <div>
                          <p className="font-bold text-sm">{p.landlord_name}</p>
                          <p className="text-xs text-muted-foreground">Agent: {p.agent?.full_name || 'Unknown'}</p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-sm">{formatUGX(p.amount)}</p>
                          <Badge className={`text-[10px] ${statusColors[p.status] || ''}`}>
                            {statusLabels[p.status] || p.status}
                          </Badge>
                        </div>
                      </div>

                      {expanded && (
                        <div className="space-y-3 pt-2 border-t">
                          {/* Contact Details */}
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="flex items-center gap-1"><Phone className="h-3 w-3" /> Landlord: {p.landlord_phone}</div>
                            <div className="flex items-center gap-1"><User2 className="h-3 w-3" /> Tenant: {p.tenant?.full_name}</div>
                            <div className="flex items-center gap-1"><Clock className="h-3 w-3" /> {format(new Date(p.created_at), 'dd MMM HH:mm')}</div>
                            <div className="flex items-center gap-1">TID: <span className="font-mono font-bold">{p.transaction_id || 'N/A'}</span></div>
                          </div>

                          {/* GPS Analysis */}
                          <div className="p-2 rounded-lg bg-muted/50 space-y-1">
                            <p className="text-xs font-bold flex items-center gap-1"><Navigation className="h-3 w-3" /> GPS Analysis</p>
                            <div className="grid grid-cols-1 gap-1 text-[11px]">
                              {p.agent_latitude && (
                                <div className="flex items-center justify-between">
                                  <span>Agent GPS:</span>
                                  <a
                                    href={`https://www.google.com/maps?q=${p.agent_latitude},${p.agent_longitude}`}
                                    target="_blank" rel="noopener noreferrer"
                                    className="text-primary flex items-center gap-0.5 hover:underline"
                                  >
                                    {Number(p.agent_latitude).toFixed(5)}, {Number(p.agent_longitude).toFixed(5)}
                                    <ExternalLink className="h-2.5 w-2.5" />
                                  </a>
                                </div>
                              )}
                              {p.landlord_latitude && (
                                <div className="flex items-center justify-between">
                                  <span>Landlord GPS:</span>
                                  <a
                                    href={`https://www.google.com/maps?q=${p.landlord_latitude},${p.landlord_longitude}`}
                                    target="_blank" rel="noopener noreferrer"
                                    className="text-primary flex items-center gap-0.5 hover:underline"
                                  >
                                    {Number(p.landlord_latitude).toFixed(5)}, {Number(p.landlord_longitude).toFixed(5)}
                                    <ExternalLink className="h-2.5 w-2.5" />
                                  </a>
                                </div>
                              )}
                              {p.gps_distance_meters !== null && (
                                <div className="flex items-center justify-between">
                                  <span>Landlord ↔ Property:</span>
                                  <Badge variant={p.gps_match ? 'default' : 'destructive'} className="text-[10px]">
                                    {p.gps_distance_meters}m {p.gps_match ? '✓ Match' : '✗ Too far'}
                                  </Badge>
                                </div>
                              )}
                              {agentToLandlordDist !== null && (
                                <div className="flex items-center justify-between">
                                  <span>Agent ↔ Landlord:</span>
                                  <span className="font-mono text-[10px]">{agentToLandlordDist}m apart</span>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Receipt Photos */}
                          {p.receipt_photo_urls?.length > 0 && (
                            <div>
                              <p className="text-xs font-bold mb-1 flex items-center gap-1"><Image className="h-3 w-3" /> Receipts</p>
                              <div className="flex gap-2">
                                {p.receipt_photo_urls.map((url: string, i: number) => (
                                  <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                                    <img src={url} alt={`Receipt ${i + 1}`} className="h-20 w-20 object-cover rounded border hover:opacity-80" />
                                  </a>
                                ))}
                              </div>
                            </div>
                          )}

                          {p.notes && (
                            <p className="text-xs text-muted-foreground">Notes: {p.notes}</p>
                          )}

                          {/* Review Actions */}
                          {p.status === 'pending_agent_ops' && (
                            <div className="space-y-2 pt-2 border-t">
                              <Textarea
                                placeholder="Review notes (required for rejection, min 10 chars)"
                                value={reviewNotes[p.id] || ''}
                                onChange={e => setReviewNotes(prev => ({ ...prev, [p.id]: e.target.value }))}
                                className="h-16 text-sm"
                              />
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  className="flex-1"
                                  disabled={reviewMutation.isPending}
                                  onClick={() => reviewMutation.mutate({ id: p.id, action: 'reject' })}
                                >
                                  <XCircle className="h-3 w-3 mr-1" /> Reject
                                </Button>
                                <Button
                                  size="sm"
                                  className="flex-1"
                                  disabled={reviewMutation.isPending}
                                  onClick={() => reviewMutation.mutate({ id: p.id, action: 'approve' })}
                                >
                                  <CheckCircle2 className="h-3 w-3 mr-1" /> Approve
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
