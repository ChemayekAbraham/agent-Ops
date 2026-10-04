import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  Send, RefreshCw, ShieldCheck, XCircle, AlertTriangle, Clock, Loader2, User2, Zap, CheckCircle2,
} from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface OtpEvent {
  id: string;
  challenge_id: string;
  agent_id: string | null;
  landlord_id: string | null;
  event_type: string;
  landlord_phone: string | null;
  amount: number | null;
  otp_expires_at: string | null;
  detail: string | null;
  failure_reason: string | null;
  metadata: {
    trigger_source?: string;
    sms_sent?: boolean;
    delivery_status?: string;
    attempt_number?: number;
    sms_message_id?: string | null;
    sms_status?: string | null;
    sms_status_code?: number | null;
    [key: string]: unknown;
  } | null;
  created_at: string;
}

const EVENT_META: Record<string, { label: string; icon: typeof Send; className: string }> = {
  sent: { label: 'Sent', icon: Send, className: 'bg-primary/10 text-primary border-primary/20' },
  resent: { label: 'Resent', icon: RefreshCw, className: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  delivery_report: { label: 'Delivered', icon: CheckCircle2, className: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  verified: { label: 'Verified', icon: ShieldCheck, className: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  incorrect_attempt: { label: 'Wrong code', icon: AlertTriangle, className: 'bg-orange-500/10 text-orange-600 border-orange-500/20' },
  failed: { label: 'Failed', icon: XCircle, className: 'bg-destructive/10 text-destructive border-destructive/20' },
};

function metaFor(ev: OtpEvent) {
  // A delivery report can be a delivery confirmation OR a delivery failure.
  if (ev.event_type === 'delivery_report' && ev.metadata?.delivery_status === 'failed') {
    return { label: 'Not delivered', icon: XCircle, className: 'bg-destructive/10 text-destructive border-destructive/20' };
  }
  return EVENT_META[ev.event_type] ?? { label: ev.event_type, icon: Clock, className: 'bg-muted text-muted-foreground border-border' };
}

const FAILURE_REASON_LABELS: Record<string, string> = {
  invalid_code: 'Invalid code',
  expired: 'Expired',
  already_verified: 'Already verified',
  too_many_attempts: 'Too many attempts',
  timeout: 'Timeout',
  disburse_failed: 'Disbursement failed',
};

function failureReasonLabel(reason: string): string {
  return FAILURE_REASON_LABELS[reason]
    ?? reason.replace(/^challenge_/, '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Short, copy-friendly representation of a long Africa's Talking message id.
function shortMessageId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

// Map every Africa's Talking message id seen in a challenge's send/resend events
// to its attempt number, so delivery reports can be tied back to the attempt.
function attemptIndex(group: OtpEvent[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const e of group) {
    if (e.event_type !== 'sent' && e.event_type !== 'resent') continue;
    const mid = e.metadata?.sms_message_id;
    const n = e.metadata?.attempt_number;
    if (mid && typeof n === 'number') map[mid] = n;
  }
  return map;
}

// A challenge can be re-issued when its latest attempt failed and it has not
// been verified or terminally closed. Failure signals: an explicit `failed`
// event, a delivery report marked failed, or a send/resend the gateway rejected.
function isResendable(group: OtpEvent[]): boolean {
  const hasVerified = group.some((e) => e.event_type === 'verified');
  if (hasVerified) return false;
  return group.some((e) =>
    e.event_type === 'failed' ||
    (e.event_type === 'delivery_report' && e.metadata?.delivery_status === 'failed') ||
    ((e.event_type === 'sent' || e.event_type === 'resent') && e.metadata?.sms_sent === false),
  );
}

export function LandlordPayoutOtpAuditSheet({ open, onOpenChange }: Props) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [resendingId, setResendingId] = useState<string | null>(null);

  const resend = useMutation({
    mutationFn: async (challengeId: string) => {
      const { data, error } = await supabase.functions.invoke('issue-landlord-payout-otp', {
        body: { challenge_id: challengeId, trigger_source: 'manual' },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      return data as { sms_sent?: boolean; sms_reason?: string | null };
    },
    onMutate: (challengeId: string) => setResendingId(challengeId),
    onSuccess: (data) => {
      if (data?.sms_sent) {
        toast.success('New OTP sent to the landlord');
      } else {
        toast.warning(`OTP regenerated, but SMS not delivered: ${data?.sms_reason ?? 'unknown reason'}`);
      }
      queryClient.invalidateQueries({ queryKey: ['landlord-otp-audit'] });
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Could not resend OTP');
    },
    onSettled: () => setResendingId(null),
  });

  const { data: events = [], isLoading } = useQuery({
    queryKey: ['landlord-otp-audit', user?.id],
    queryFn: async () => {
      if (!user) return [] as OtpEvent[];
      const { data } = await supabase
        .from('landlord_payout_otp_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      return (data as OtpEvent[]) || [];
    },
    enabled: !!user && open,
  });

  // Group by challenge, newest challenge first
  const grouped = Object.values(
    events.reduce<Record<string, OtpEvent[]>>((acc, ev) => {
      (acc[ev.challenge_id] ||= []).push(ev);
      return acc;
    }, {}),
  ).sort(
    (a, b) => new Date(b[0].created_at).getTime() - new Date(a[0].created_at).getTime(),
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[88vh] p-0 flex flex-col">
        <SheetHeader className="px-4 pt-4 pb-2 border-b">
          <SheetTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Landlord OTP Audit Log
          </SheetTitle>
          <SheetDescription>
            When each landlord payout OTP was sent, resent and verified.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="p-4 space-y-4">
            {isLoading ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading audit log…
              </div>
            ) : grouped.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground text-sm">
                No landlord payout OTP activity yet.
              </div>
            ) : (
              grouped.map((group) => {
                const head = group[0];
                const resendable = isResendable(group);
                const isResending = resendingId === head.challenge_id;
                const attempts = attemptIndex(group);
                const totalAttempts = Object.keys(attempts).length;
                return (
                  <div key={head.challenge_id} className="rounded-lg border bg-card overflow-hidden">
                    <div className="px-3 py-2 bg-muted/40 border-b flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium flex items-center gap-1.5">
                          <User2 className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{head.landlord_phone ?? 'Landlord'}</span>
                        </p>
                        <p className="text-[11px] font-mono text-muted-foreground truncate">
                          challenge {head.challenge_id}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {head.amount != null && (
                          <Badge variant="secondary">{formatUGX(Number(head.amount))}</Badge>
                        )}
                        {totalAttempts > 1 && (
                          <Badge variant="outline" className="text-[10px]">
                            {totalAttempts} attempts
                          </Badge>
                        )}
                        {resendable && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs gap-1.5"
                            disabled={isResending}
                            onClick={() => resend.mutate(head.challenge_id)}
                          >
                            {isResending
                              ? <Loader2 className="h-3 w-3 animate-spin" />
                              : <RefreshCw className="h-3 w-3" />}
                            Resend OTP
                          </Button>
                        )}
                      </div>
                    </div>

                    <ol className="relative ml-4 my-2 border-l border-border">
                      {group
                        .slice()
                        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
                        .map((ev) => {
                          const m = metaFor(ev);
                          const Icon = m.icon;
                          const isSend = ev.event_type === 'sent' || ev.event_type === 'resent';
                          const attemptNo = isSend
                            ? ev.metadata?.attempt_number
                            : (ev.metadata?.sms_message_id ? attempts[ev.metadata.sms_message_id] : undefined);
                          const messageId = ev.metadata?.sms_message_id ?? null;
                          const statusCode = ev.metadata?.sms_status_code ?? null;
                          const statusText = ev.metadata?.sms_status ?? null;
                          return (
                            <li key={ev.id} className="ml-4 py-2 pr-3">
                              <span className="absolute -left-[9px] flex h-4 w-4 items-center justify-center rounded-full bg-background border">
                                <Icon className="h-2.5 w-2.5" />
                              </span>
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-1.5">
                                  <Badge variant="outline" className={m.className}>{m.label}</Badge>
                                  {attemptNo != null && (
                                    <Badge variant="outline" className="text-[10px] bg-muted text-muted-foreground border-border">
                                      Attempt {attemptNo}
                                    </Badge>
                                  )}
                                  {ev.event_type === 'sent' && ev.metadata?.trigger_source === 'auto' && (
                                    <Badge
                                      variant="outline"
                                      className="bg-violet-500/10 text-violet-600 border-violet-500/20 text-[10px] gap-0.5"
                                    >
                                      <Zap className="h-2.5 w-2.5" /> Auto-sent
                                    </Badge>
                                  )}
                                </div>
                                <time className="text-[11px] text-muted-foreground">
                                  {format(new Date(ev.created_at), 'd MMM yyyy, HH:mm:ss')}
                                </time>
                              </div>
                              {(messageId || statusCode != null || statusText) && (
                                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                  {messageId && (
                                    <span
                                      className="text-[10px] font-mono text-muted-foreground"
                                      title={`AT message ID: ${messageId}`}
                                    >
                                      ID {shortMessageId(messageId)}
                                    </span>
                                  )}
                                  {(statusText || statusCode != null) && (
                                    <Badge variant="outline" className="text-[10px] bg-muted text-muted-foreground border-border">
                                      {statusText ?? 'status'}{statusCode != null ? ` (${statusCode})` : ''}
                                    </Badge>
                                  )}
                                </div>
                              )}
                              {ev.failure_reason && (
                                <Badge
                                  variant="outline"
                                  className="mt-1 bg-destructive/10 text-destructive border-destructive/20 text-[10px]"
                                >
                                  {failureReasonLabel(ev.failure_reason)}
                                </Badge>
                              )}
                              {ev.detail && (
                                <p className="text-xs text-muted-foreground mt-1">{ev.detail}</p>
                              )}
                              {ev.otp_expires_at && (ev.event_type === 'sent' || ev.event_type === 'resent') && (
                                <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
                                  <Clock className="h-3 w-3" />
                                  Expires {format(new Date(ev.otp_expires_at), 'HH:mm:ss')}
                                </p>
                              )}
                            </li>
                          );
                        })}
                    </ol>
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}