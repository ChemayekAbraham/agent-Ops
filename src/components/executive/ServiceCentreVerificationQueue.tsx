import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { MapPin, CheckCircle, XCircle, Loader2, Building2, ExternalLink, Wallet } from 'lucide-react';
import { format } from 'date-fns';
import { ServiceCentreNewEntryDialog } from './service-centres/ServiceCentreNewEntryDialog';
import { ServiceCentreEntriesList } from './service-centres/ServiceCentreEntriesList';
import { ServiceCentreAdvancesPanel } from './service-centres/ServiceCentreAdvancesPanel';
import { ActiveServiceCentresList } from './service-centres/ActiveServiceCentresList';
import { ServiceCentreStageTracker } from './service-centres/ServiceCentreStageTracker';


export function ServiceCentreVerificationQueue() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('pending');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});

  // Fetch pending submissions
  const { data: setups, isLoading: setupsLoading } = useQuery({
    queryKey: ['service-centre-pending-setups'],
    queryFn: async () => {
      const { data } = await supabase
        .from('service_centre_setups' as any)
        .select('*')
        .in('status', ['pending'])
        .order('created_at', { ascending: true });
      return (data || []) as any[];
    },
    staleTime: 30000,
  });

  const handleVerify = async (id: string) => {
    if (!user?.id) return;
    const rawAmount = (amounts[id] ?? '').replace(/[^0-9.]/g, '');
    const amount = Number(rawAmount);
    const comment = (comments[id] ?? '').trim();
    if (!rawAmount || !Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter the service centre amount (UGX) before verifying.');
      return;
    }
    if (comment.length < 10) {
      toast.error('Add a comment of at least 10 characters before verifying.');
      return;
    }
    setProcessingId(id);
    try {
      const { data, error } = await supabase
        .from('service_centre_setups' as any)
        .update({
          status: 'verified',
          verified_by: user.id,
          verified_at: new Date().toISOString(),
          verified_amount: amount,
          verification_comment: comment,
        } as any)
        .eq('id', id)
        .select('id, verified_amount, verification_comment');
      if (error) throw error;
      if (!data?.length) throw new Error('Verification did not save — no row was updated.');
      toast.success('Service Centre verified with amount and comment attached.');
      setAmounts((p) => ({ ...p, [id]: '' }));
      setComments((p) => ({ ...p, [id]: '' }));
      queryClient.invalidateQueries({ queryKey: ['service-centre-pending-setups'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to verify');
    } finally {
      setProcessingId(null);
    }
  };

  const handleReject = async (id: string) => {
    if (!rejectionReason.trim() || rejectionReason.trim().length < 10) {
      toast.error('Please provide a reason (at least 10 characters).');
      return;
    }
    setProcessingId(id);
    try {
      const { error } = await supabase
        .from('service_centre_setups' as any)
        .update({
          status: 'rejected',
          rejection_reason: rejectionReason.trim(),
        } as any)
        .eq('id', id);
      if (error) throw error;
      toast.success('Service Centre rejected.');
      setRejectingId(null);
      setRejectionReason('');
      queryClient.invalidateQueries({ queryKey: ['service-centre-pending-setups'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to reject');
    } finally {
      setProcessingId(null);
    }
  };

  const isLoading = setupsLoading;

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Building2 className="h-4 w-4 text-primary" />
          Service Centre Pipeline
          {(setups?.length || 0) > 0 && (
            <span className="bg-primary/10 text-primary text-xs font-bold px-2 py-0.5 rounded-full">
              {setups?.length || 0}
            </span>
          )}
          <span className="ml-auto">
            <ServiceCentreNewEntryDialog />
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full grid grid-cols-4 mb-3">
            <TabsTrigger
              value="pending"
              className="text-xs gap-1 relative data-[state=inactive]:animate-pulse data-[state=inactive]:bg-destructive/15 data-[state=inactive]:text-destructive"
            >
              <Loader2 className="h-3 w-3" />
              Pending ({setups?.length || 0})
              {(setups?.length || 0) > 0 && (
                <span className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center">
                  {setups?.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="active" className="text-xs gap-1">
              <CheckCircle className="h-3 w-3" />
              Active
            </TabsTrigger>
            <TabsTrigger value="entries" className="text-xs gap-1">
              <Building2 className="h-3 w-3" />
              Entries
            </TabsTrigger>
            <TabsTrigger value="advances" className="text-xs gap-1">
              <Wallet className="h-3 w-3" />
              Money
            </TabsTrigger>
          </TabsList>

          {/* ── Pending Verification Tab ── */}
          <TabsContent value="pending">
            {setupsLoading ? (
              <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : !setups?.length ? (
              <p className="text-sm text-muted-foreground text-center py-4">No pending service centre submissions.</p>
            ) : (
              <div className="space-y-4">
                {setups.map((s: any) => (
                  <div key={s.id} className="rounded-xl border border-border p-3 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-0.5">
                        <p className="text-sm font-semibold text-foreground">{s.agent_name}</p>
                        <p className="text-xs text-muted-foreground">📱 {s.agent_phone}</p>
                        <p className="text-xs text-muted-foreground">{format(new Date(s.created_at), 'dd MMM yyyy HH:mm')}</p>
                      </div>
                      <a
                        href={`https://www.google.com/maps?q=${s.latitude},${s.longitude}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-primary hover:underline shrink-0"
                      >
                        <MapPin className="h-3 w-3" />
                        View on Map
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>

                    <img src={s.photo_url} alt="Service Centre" className="rounded-lg max-h-40 w-full object-cover border" />
                    <p className="text-xs text-muted-foreground">📍 {s.location_name || 'No description'}</p>
                    <p className="text-xs text-muted-foreground">🌐 {Number(s.latitude).toFixed(5)}, {Number(s.longitude).toFixed(5)}</p>

                    <ServiceCentreStageTracker setup={s} />


                    {rejectingId !== s.id && (
                      <div className="space-y-2 rounded-lg border border-dashed border-border bg-muted/40 p-2.5">
                        <p className="text-[11px] font-semibold text-foreground">Attach before verifying</p>
                        <div className="space-y-1">
                          <label className="text-[11px] text-muted-foreground" htmlFor={`sc-amount-${s.id}`}>
                            Service centre amount (UGX)
                          </label>
                          <Input
                            id={`sc-amount-${s.id}`}
                            inputMode="numeric"
                            placeholder="e.g. 350000"
                            value={amounts[s.id] ?? ''}
                            onChange={(e) => setAmounts((p) => ({ ...p, [s.id]: e.target.value }))}
                            className="h-8 text-xs"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[11px] text-muted-foreground" htmlFor={`sc-comment-${s.id}`}>
                            Comment / description (min 10 chars)
                          </label>
                          <Textarea
                            id={`sc-comment-${s.id}`}
                            placeholder="What was agreed, what the amount covers, any conditions…"
                            value={comments[s.id] ?? ''}
                            onChange={(e) => setComments((p) => ({ ...p, [s.id]: e.target.value }))}
                            maxLength={1000}
                            rows={3}
                            className="text-xs"
                          />
                        </div>
                      </div>
                    )}

                    {rejectingId === s.id ? (
                      <div className="space-y-2">
                        <Input
                          placeholder="Reason for rejection (min 10 chars)"
                          value={rejectionReason}
                          onChange={(e) => setRejectionReason(e.target.value)}
                          maxLength={500}
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleReject(s.id)}
                            disabled={processingId === s.id}
                            className="flex-1 gap-1"
                          >
                            {processingId === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
                            Confirm Reject
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => { setRejectingId(null); setRejectionReason(''); }}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => handleVerify(s.id)}
                          disabled={processingId === s.id}
                          className="flex-1 gap-1"
                        >
                          {processingId === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                          Verify ✅
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setRejectingId(s.id)}
                          className="flex-1 gap-1"
                        >
                          <XCircle className="h-3 w-3" />
                          Reject
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* ── Active (COO vetted) ── */}
          <TabsContent value="active">
            <ActiveServiceCentresList />
          </TabsContent>

          {/* ── Entries (COO → CEO → Verified) ── */}
          <TabsContent value="entries">
            <ServiceCentreEntriesList />
          </TabsContent>

          {/* ── Service centre money (advances) ── */}
          <TabsContent value="advances">
            <ServiceCentreAdvancesPanel />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
