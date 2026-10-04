import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { format } from 'date-fns';
import {
  Banknote, Upload, MapPin, ShieldCheck, CheckCircle2, Clock,
  XCircle, AlertTriangle, User2
} from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PIPELINE_STEPS = [
  { key: 'paid', label: 'Paid', icon: Banknote },
  { key: 'receipt', label: 'Receipt', icon: Upload },
  { key: 'gps', label: 'GPS Verified', icon: MapPin },
  { key: 'agent_ops', label: 'Agent Ops', icon: ShieldCheck },
  { key: 'cfo', label: 'CFO Confirmed', icon: CheckCircle2 },
];

function getStepProgress(withdrawal: any): number {
  const s = withdrawal.status;
  if (s === 'rejected') return -1;
  if (s === 'completed' || s === 'cfo_approved') return 5;
  if (s === 'agent_ops_approved') return 4;
  if (s === 'pending_agent_ops') {
    // Check if GPS and receipt are present
    const hasReceipt = withdrawal.receipt_photo_urls?.length > 0;
    const hasGps = withdrawal.landlord_latitude != null;
    if (hasReceipt && hasGps) return 3;
    if (hasReceipt) return 2;
    return 1;
  }
  return 1;
}

export function FloatPayoutStatusTracker({ open, onOpenChange }: Props) {
  const { user } = useAuth();

  const { data: payouts = [], isLoading } = useQuery({
    queryKey: ['float-payout-status', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data } = await supabase
        .from('agent_float_withdrawals')
        .select('*')
        .eq('agent_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20);
      return data || [];
    },
    enabled: !!user && open,
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[85vh] rounded-t-2xl p-0">
        <SheetHeader className="px-4 pt-4 pb-2">
          <SheetTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-chart-4" />
            Payout Status Tracker
          </SheetTitle>
        </SheetHeader>

        <ScrollArea className="h-[calc(85vh-60px)] px-4">
          {isLoading ? (
            <div className="flex justify-center py-12 text-muted-foreground text-sm">Loading...</div>
          ) : payouts.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">No payouts yet.</div>
          ) : (
            <div className="space-y-4 pb-6">
              {payouts.map((p: any) => {
                const progress = getStepProgress(p);
                const isRejected = p.status === 'rejected';

                return (
                  <div key={p.id} className="border rounded-xl p-3 space-y-3">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <User2 className="h-4 w-4 text-muted-foreground" />
                        <span className="font-semibold text-sm">{p.landlord_name}</span>
                      </div>
                      <Badge
                        variant={isRejected ? 'destructive' : progress >= 5 ? 'default' : 'secondary'}
                        className="text-[10px]"
                      >
                        {isRejected ? 'Rejected' : progress >= 5 ? 'Completed' : 'In Progress'}
                      </Badge>
                    </div>

                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{formatUGX(p.amount)}</span>
                      <span>{format(new Date(p.created_at), 'dd MMM yy, HH:mm')}</span>
                    </div>

                    {/* Pipeline */}
                    {isRejected ? (
                      <div className="flex items-center gap-2 p-2 rounded-lg bg-destructive/10 border border-destructive/20">
                        <XCircle className="h-4 w-4 text-destructive shrink-0" />
                        <div>
                          <p className="text-xs font-medium text-destructive">Payout Rejected</p>
                          {(p.manager_notes || p.agent_ops_notes) && (
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                              {p.agent_ops_notes || p.manager_notes}
                            </p>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        {PIPELINE_STEPS.map((step, i) => {
                          const isDone = progress > i;
                          const isCurrent = progress === i + 1;
                          const StepIcon = step.icon;

                          return (
                            <div key={step.key} className="flex-1 flex flex-col items-center gap-1">
                              <div
                                className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors ${
                                  isDone
                                    ? 'bg-success/20 text-success'
                                    : isCurrent
                                    ? 'bg-warning/20 text-warning ring-2 ring-warning/30'
                                    : 'bg-muted text-muted-foreground'
                                }`}
                              >
                                {isDone ? (
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                ) : isCurrent ? (
                                  <Clock className="h-3.5 w-3.5" />
                                ) : (
                                  <StepIcon className="h-3 w-3" />
                                )}
                              </div>
                              <span className={`text-[8px] text-center leading-tight ${isDone ? 'text-success font-medium' : isCurrent ? 'text-warning font-medium' : 'text-muted-foreground'}`}>
                                {step.label}
                              </span>
                              {i < PIPELINE_STEPS.length - 1 && (
                                <div className={`absolute h-0.5 w-full ${isDone ? 'bg-success/30' : 'bg-muted'}`} />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* GPS Match Indicator */}
                    {p.gps_distance_meters != null && (
                      <div className={`flex items-center gap-1.5 text-[10px] ${p.gps_match ? 'text-success' : 'text-warning'}`}>
                        {p.gps_match ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                        GPS: {p.gps_distance_meters}m from property {p.gps_match ? '✓' : '(manual review needed)'}
                      </div>
                    )}

                    {p.transaction_id && (
                      <p className="text-[10px] text-muted-foreground font-mono">TID: {p.transaction_id}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
