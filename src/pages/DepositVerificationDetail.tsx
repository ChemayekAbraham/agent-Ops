import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  ShieldCheck,
  Mail,
  Hash,
  Sparkles,
  AlertCircle,
  Bot,
  User as UserIcon,
} from 'lucide-react';
import { format } from 'date-fns';
import ScreenLoader from '@/components/common/ScreenLoader';

interface AuditEntry {
  id: string;
  action: string;
  matcher_type: string | null;
  match_score: number | null;
  signals: string[] | null;
  amount: number | null;
  actor_id: string | null;
  actor_email: string | null;
  notes: string | null;
  created_at: string;
}

interface Deposit {
  id: string;
  amount: number;
  status: string;
  provider: string | null;
  transaction_id: string | null;
  transaction_date: string | null;
  created_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  auto_approved: boolean | null;
  rejection_reason: string | null;
}

const SIGNAL_LABELS: Record<string, { label: string; desc: string }> = {
  amount: { label: 'Amount', desc: 'Deposit amount matches the email transaction exactly.' },
  reference: { label: 'Reference / TID', desc: 'Your transaction ID matches the one in the bank/MoMo email.' },
  phone: { label: 'Phone number', desc: 'The phone on the deposit matches the email counterparty.' },
  name: { label: 'Sender name', desc: 'Your account name matches the sender shown in the email.' },
  date: { label: 'Date window', desc: 'The email was received within the expected time window of your deposit.' },
  channel: { label: 'Channel', desc: 'Provider (MTN / Airtel / Bank) on the deposit matches the email source.' },
};

const MATCHER_EXPLAIN: Record<string, { title: string; body: string; tone: 'tid' | 'strong' | 'amount' | 'manual' }> = {
  auto_tid: {
    title: 'Exact transaction ID match',
    body: 'Your transaction ID (TID) was found verbatim inside an incoming bank / MoMo email. This is the strongest possible match, so the system approved your deposit instantly with no human review needed.',
    tone: 'tid',
  },
  tid: {
    title: 'Exact transaction ID match',
    body: 'Your transaction ID (TID) was found verbatim inside an incoming bank / MoMo email — the strongest possible match.',
    tone: 'tid',
  },
  auto_amount_strong: {
    title: 'Amount + corroborating signals',
    body: 'The amount matched exactly AND at least two other independent signals (phone, sender name, date or channel) also matched. The system treated this as a high-confidence match and auto-approved.',
    tone: 'strong',
  },
  amount_strong: {
    title: 'Amount + corroborating signals',
    body: 'The amount matched exactly AND at least two other independent signals (phone, sender name, date or channel) also matched.',
    tone: 'strong',
  },
  amount: {
    title: 'Amount-only match',
    body: 'Only the amount matched in the time window. An operator reviewed the deposit before approving.',
    tone: 'amount',
  },
};

const fmtUgx = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-UG', { style: 'currency', currency: 'UGX', maximumFractionDigits: 0 }).format(n);

export default function DepositVerificationDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [deposit, setDeposit] = useState<Deposit | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const { data: dep, error: depErr } = await supabase
          .from('deposit_requests')
          .select('id, amount, status, provider, transaction_id, transaction_date, created_at, approved_at, rejected_at, auto_approved, rejection_reason')
          .eq('id', id)
          .maybeSingle();
        if (depErr) throw depErr;
        setDeposit(dep as Deposit | null);

        const { data: rows, error: audErr } = await supabase
          .from('email_match_audit_log')
          .select('id, action, matcher_type, match_score, signals, amount, actor_id, actor_email, notes, created_at')
          .eq('deposit_request_id', id)
          .order('created_at', { ascending: true });
        if (audErr) throw audErr;
        setAudit((rows ?? []) as unknown as AuditEntry[]);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  if (loading) {
    return (
      <ScreenLoader />
    );
  }

  if (!deposit) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center">
        <AlertCircle className="h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">Deposit not found or you don't have access.</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/deposit-history')}>Back to history</Button>
      </div>
    );
  }

  // Pick the "decisive" audit entry — prefer bulk_approve / approve, fall back to auto_claim
  const decisive =
    audit.find((a) => a.action === 'bulk_approve') ||
    audit.find((a) => a.action === 'approve') ||
    audit.find((a) => a.action === 'auto_claim') ||
    audit[audit.length - 1] ||
    null;

  const explain = decisive?.matcher_type ? MATCHER_EXPLAIN[decisive.matcher_type] : null;
  const signals = decisive?.signals ?? [];

  const statusBadge = (() => {
    switch (deposit.status) {
      case 'approved':
        return (
          <Badge className="bg-success/20 text-success border-success/30">
            <CheckCircle2 className="h-3 w-3 mr-1" /> Verified
          </Badge>
        );
      case 'rejected':
        return (
          <Badge variant="destructive">
            <XCircle className="h-3 w-3 mr-1" /> Rejected
          </Badge>
        );
      default:
        return (
          <Badge variant="secondary" className="bg-warning/20 text-warning border-warning/30">
            <Clock className="h-3 w-3 mr-1" /> Pending
          </Badge>
        );
    }
  })();

  const toneClass =
    explain?.tone === 'tid'
      ? 'border-emerald-500/30 bg-emerald-500/5'
      : explain?.tone === 'strong'
        ? 'border-primary/30 bg-primary/5'
        : explain?.tone === 'amount'
          ? 'border-amber-500/30 bg-amber-500/5'
          : 'border-border bg-muted/30';

  return (
    <div className="min-h-screen bg-background pb-20">
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b">
        <div className="flex items-center gap-3 p-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-lg font-semibold">Why this deposit was approved</h1>
            <p className="text-xs text-muted-foreground">Verification audit trail</p>
          </div>
        </div>
      </div>

      <div className="p-4 space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="text-2xl">{fmtUgx(deposit.amount)}</CardTitle>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {statusBadge}
                  {deposit.auto_approved && (
                    <Badge variant="outline" className="border-primary/30 text-primary">
                      <Sparkles className="h-3 w-3 mr-1" /> Auto-approved
                    </Badge>
                  )}
                  {deposit.provider && (
                    <Badge variant="outline" className="uppercase">{deposit.provider}</Badge>
                  )}
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="text-sm space-y-1 pt-2">
            {deposit.transaction_id && (
              <div className="flex items-center gap-2">
                <Hash className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Your TID:</span>
                <span className="font-mono font-medium">{deposit.transaction_id}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Requested:</span>
              <span>{format(new Date(deposit.created_at), 'MMM d, yyyy h:mm a')}</span>
            </div>
            {deposit.approved_at && (
              <div className="flex items-center gap-2 text-success">
                <CheckCircle2 className="h-4 w-4" />
                <span>Verified {format(new Date(deposit.approved_at), 'MMM d, yyyy h:mm a')}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Why it was approved */}
        {explain ? (
          <Card className={toneClass}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-primary" />
                {explain.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground leading-relaxed">{explain.body}</p>
              {decisive?.match_score != null && (
                <div className="text-xs">
                  <span className="text-muted-foreground">Confidence score: </span>
                  <span className="font-semibold text-foreground">{decisive.match_score}</span>
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground text-center">
              No automated email match was recorded for this deposit.
            </CardContent>
          </Card>
        )}

        {/* Matching evidence (signals) */}
        {signals && signals.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Mail className="h-4 w-4 text-primary" />
                Matching evidence from the bank email
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {signals.map((s) => {
                const info = SIGNAL_LABELS[s] ?? { label: s, desc: 'Matched signal.' };
                return (
                  <div key={s} className="flex items-start gap-2 p-2 rounded-md border border-success/20 bg-success/5">
                    <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{info.label}</div>
                      <div className="text-xs text-muted-foreground">{info.desc}</div>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}

        {/* Timeline */}
        {audit.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Audit timeline</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {audit.map((a) => {
                const isBot = !a.actor_id;
                return (
                  <div key={a.id} className="flex gap-3 text-sm">
                    <div className="mt-0.5">
                      {isBot ? (
                        <Bot className="h-4 w-4 text-primary" />
                      ) : (
                        <UserIcon className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium capitalize">{a.action.replace(/_/g, ' ')}</span>
                        {a.matcher_type && (
                          <Badge variant="outline" className="text-[10px]">
                            {a.matcher_type.replace(/^auto_/, '').replace(/_/g, ' ')}
                          </Badge>
                        )}
                      </div>
                      {a.notes && <div className="text-xs text-muted-foreground mt-0.5">{a.notes}</div>}
                      <div className="text-[11px] text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
                        <span>{format(new Date(a.created_at), 'MMM d, yyyy h:mm:ss a')}</span>
                        <span>·</span>
                        <span>{isBot ? 'System auto-matcher' : (a.actor_email ?? 'Operator')}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
