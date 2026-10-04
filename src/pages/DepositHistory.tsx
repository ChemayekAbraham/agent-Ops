import { useEffect, useState } from 'react';
import { roleToSlug } from '@/lib/roleRoutes';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import ScreenLoader from '@/components/common/ScreenLoader';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Clock, CheckCircle2, XCircle, Loader2, Phone, Calendar, Hash, Download, MessageCircle, ShieldCheck, Target, Info, BadgeCheck } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { downloadDepositReceipt, buildDepositReceiptWhatsApp, type DepositReceiptData } from '@/lib/receiptPdf';
import { shareViaWhatsApp } from '@/lib/shareReceipt';
import { useAuth } from '@/hooks/useAuth';
import { canViewDepositPurpose } from '@/lib/depositPurposeVisibility';
import { isAutoCancelledDuplicate } from '@/lib/depositDuplicateDetection';
import {
  DepositAutoMatchAudit,
  type DepositAutoMatchAuditPayload,
} from '@/components/wallet/DepositAutoMatchAudit';

interface DepositRequest {
  id: string;
  amount: number;
  status: string;
  provider: string | null;
  transaction_id: string | null;
  transaction_date: string | null;
  created_at: string;
  notes: string | null;
  rejection_reason: string | null;
  auto_match_audit?: DepositAutoMatchAuditPayload | null;
  approved_at: string | null;
  rejected_at: string | null;
  deposit_purpose?: string | null;
  purpose_audit?: {
    chosen_purpose?: string;
    chosen_at?: string;
    chosen_by?: string;
    entry_point?: 'gate' | 'default' | 'in_form';
    required_choice?: boolean;
  } | null;
}

const PURPOSE_LABELS: Record<string, string> = {
  operational_float: 'Operational Float',
  personal_deposit: 'Personal Deposit',
  partnership_deposit: 'Supporter Wallet Top-Up',
  personal_rent_repayment: 'Personal Rent Repayment',
  other: 'Other',
};

const ENTRY_POINT_LABELS: Record<string, string> = {
  gate: 'Forced choice screen',
  default: 'Pre-selected default',
  in_form: 'Picked in form',
};

const purposeLabel = (d: DepositRequest): string | null => {
  const p = d.purpose_audit?.chosen_purpose ?? d.deposit_purpose ?? null;
  if (!p) return null;
  return PURPOSE_LABELS[p] ?? p;
};

const purposeBadgeClass = (p: string | null) => {
  switch (p) {
    case 'operational_float':
      return 'bg-primary/15 text-primary border-primary/30';
    case 'personal_deposit':
      return 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30';
    case 'partnership_deposit':
      return 'bg-violet-500/15 text-violet-700 border-violet-500/30';
    case 'personal_rent_repayment':
      return 'bg-amber-500/15 text-amber-700 border-amber-500/30';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
};

export default function DepositHistory() {
  const navigate = useNavigate();
  const { role } = useAuth();
  const [deposits, setDeposits] = useState<DepositRequest[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDeposits();
  }, []);

  const fetchDeposits = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        navigate('/auth');
        return;
      }

      const { data, error } = await supabase
        .from('deposit_requests')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setDeposits((data || []) as unknown as DepositRequest[]);
    } catch (error) {
      console.error('Error fetching deposits:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-UG', {
      style: 'currency',
      currency: 'UGX',
      minimumFractionDigits: 0,
    }).format(amount);
  };

  const getStatusBadge = (deposit: DepositRequest) => {
    if (isAutoCancelledDuplicate(deposit)) {
      return (
        <Badge
          variant="outline"
          className="bg-emerald-500/10 text-emerald-700 border-emerald-500/30"
        >
          <BadgeCheck className="h-3 w-3 mr-1" />
          Already credited
        </Badge>
      );
    }
    switch (deposit.status) {
      case 'approved':
        return (
          <Badge className="bg-success/20 text-success border-success/30">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Verified
          </Badge>
        );
      case 'rejected':
        return (
          <Badge variant="destructive">
            <XCircle className="h-3 w-3 mr-1" />
            Rejected
          </Badge>
        );
      default:
        return (
          <Badge variant="secondary" className="bg-warning/20 text-warning border-warning/30">
            <Clock className="h-3 w-3 mr-1" />
            Pending
          </Badge>
        );
    }
  };

  const getProviderBadge = (provider: string | null) => {
    if (!provider) return null;
    const colors = provider === 'mtn' 
      ? 'bg-yellow-500/20 text-yellow-600 border-yellow-500/30' 
      : 'bg-red-500/20 text-red-600 border-red-500/30';
    return (
      <Badge variant="outline" className={colors}>
        {provider.toUpperCase()}
      </Badge>
    );
  };

  if (loading) {
    return (
      <ScreenLoader />
    );
  }

  return (
    <div className="min-h-screen bg-background pb-20">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b">
        <div className="flex items-center gap-3 p-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-lg font-semibold">Deposit History</h1>
            <p className="text-xs text-muted-foreground">
              {deposits.length} deposit request{deposits.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {deposits.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Phone className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="font-medium mb-2">No Deposits Yet</h3>
              <p className="text-sm text-muted-foreground mb-4">
                You haven't made any deposit requests yet.
              </p>
              <Button onClick={() => navigate('/dashboard/tenant')}>
                Make a Deposit
              </Button>
            </CardContent>
          </Card>
        ) : (
          deposits.map((deposit) => (
            <Card key={deposit.id} className="overflow-hidden">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <CardTitle className="text-xl">
                      {formatCurrency(deposit.amount)}
                    </CardTitle>
                    <div className="flex items-center gap-2 flex-wrap">
                      {getStatusBadge(deposit)}
                      {getProviderBadge(deposit.provider)}
                      {purposeLabel(deposit) && (
                        <Badge
                          variant="outline"
                          className={purposeBadgeClass(
                            deposit.purpose_audit?.chosen_purpose ?? deposit.deposit_purpose ?? null
                          )}
                        >
                          <Target className="h-3 w-3 mr-1" />
                          {purposeLabel(deposit)}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {deposit.notes && (
                  <div className="flex items-start gap-2 text-sm">
                    <span className="text-muted-foreground">Reason:</span>
                    <span className="font-medium">{deposit.notes}</span>
                  </div>
                )}

                {deposit.transaction_id && (
                  <div className="flex items-center gap-2 text-sm">
                    <Hash className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Transaction ID:</span>
                    <span className="font-mono font-medium">{deposit.transaction_id}</span>
                  </div>
                )}
                
                {deposit.transaction_date && (
                  <div className="flex items-center gap-2 text-sm">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Transaction Date:</span>
                    <span>{format(new Date(deposit.transaction_date), 'MMM d, yyyy h:mm a')}</span>
                  </div>
                )}

                <div className="flex items-center gap-2 text-sm">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Requested:</span>
                  <span>{format(new Date(deposit.created_at), 'MMM d, yyyy h:mm a')}</span>
                </div>

                {deposit.status === 'approved' && deposit.approved_at && (
                  <div className="flex items-center gap-2 text-sm text-success">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>Verified on {format(new Date(deposit.approved_at), 'MMM d, yyyy h:mm a')}</span>
                  </div>
                )}

                {deposit.status === 'approved' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full justify-start gap-2 text-xs text-primary hover:text-primary"
                    onClick={() => navigate(`/deposit-history/${deposit.id}`)}
                  >
                    <Info className="h-3.5 w-3.5" />
                    Why was this approved? View verification details
                  </Button>
                )}

                {isAutoCancelledDuplicate(deposit) ? (
                  <div className="p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10">
                    <p className="text-sm text-emerald-800 font-medium flex items-center gap-1.5">
                      <BadgeCheck className="h-4 w-4" />
                      Already credited — no duplicate created
                    </p>
                    <p className="text-xs text-emerald-700/90 mt-1">
                      {deposit.rejection_reason}
                    </p>
                    <p className="text-[11px] text-emerald-700/80 mt-1">
                      We matched this transaction reference to a mobile-money
                      receipt that had already been auto-verified earlier, so
                      this in-app submission was cancelled to avoid double
                      crediting your wallet.
                    </p>
                  </div>
                ) : deposit.status === 'rejected' && deposit.rejection_reason && (
                  <div className="p-3 bg-destructive/10 rounded-lg border border-destructive/20">
                    <p className="text-sm text-destructive">
                      <strong>Rejection reason:</strong> {deposit.rejection_reason}
                    </p>
                  </div>
                )}

                <DepositAutoMatchAudit audit={deposit.auto_match_audit} />

                {/* ─── Purpose Audit Trail (role-scoped) ─── */}
                {(() => {
                  const purpose =
                    deposit.purpose_audit?.chosen_purpose ?? deposit.deposit_purpose ?? null;
                  if (!canViewDepositPurpose(purpose, role)) return null;
                  return (
                  <div className="p-3 rounded-lg border border-primary/20 bg-primary/5 space-y-1.5">
                    <div className="flex items-center gap-2 text-xs font-semibold text-primary">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      Purpose Audit
                    </div>
                    <div className="grid gap-1 text-[11px] text-muted-foreground">
                      <div className="flex justify-between gap-2">
                        <span>Chosen purpose:</span>
                        <span className="font-medium text-foreground">
                          {PURPOSE_LABELS[purpose ?? ''] ?? purpose}
                        </span>
                      </div>
                      {deposit.purpose_audit?.chosen_at && (
                        <div className="flex justify-between gap-2">
                          <span>Chosen at:</span>
                          <span className="font-medium text-foreground">
                            {format(new Date(deposit.purpose_audit.chosen_at), 'MMM d, yyyy h:mm:ss a')}
                          </span>
                        </div>
                      )}
                      {deposit.purpose_audit?.entry_point && (
                        <div className="flex justify-between gap-2">
                          <span>How chosen:</span>
                          <span className="font-medium text-foreground">
                            {ENTRY_POINT_LABELS[deposit.purpose_audit.entry_point] ?? deposit.purpose_audit.entry_point}
                            {deposit.purpose_audit.required_choice ? ' (required)' : ''}
                          </span>
                        </div>
                      )}
                      {deposit.purpose_audit?.chosen_by && (
                        <div className="flex justify-between gap-2">
                          <span>Chosen by:</span>
                          <span className="font-mono text-[10px] text-foreground truncate max-w-[60%]">
                            {deposit.purpose_audit.chosen_by}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                  );
                })()}

                {/* Receipt Actions */}
                <div className="flex gap-2 pt-2 border-t border-border/50">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 gap-1.5 text-xs"
                    onClick={() => {
                      const receiptData: DepositReceiptData = {
                        amount: deposit.amount,
                        status: deposit.status,
                        provider: deposit.provider,
                        transactionId: deposit.transaction_id,
                        transactionDate: deposit.transaction_date,
                        createdAt: deposit.created_at,
                        approvedAt: deposit.approved_at,
                        notes: deposit.notes,
                        purpose: purposeLabel(deposit),
                      };
                      downloadDepositReceipt(receiptData);
                      toast.success('Receipt downloaded!');
                    }}
                  >
                    <Download className="h-3.5 w-3.5" />
                    PDF Receipt
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 gap-1.5 text-xs border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10"
                    onClick={() => {
                      const receiptData: DepositReceiptData = {
                        amount: deposit.amount,
                        status: deposit.status,
                        provider: deposit.provider,
                        transactionId: deposit.transaction_id,
                        transactionDate: deposit.transaction_date,
                        createdAt: deposit.created_at,
                        approvedAt: deposit.approved_at,
                        notes: deposit.notes,
                        purpose: purposeLabel(deposit),
                      };
                      const text = buildDepositReceiptWhatsApp(receiptData);
                      shareViaWhatsApp(text);
                      toast.success('Opening WhatsApp...');
                    }}
                  >
                    <MessageCircle className="h-3.5 w-3.5" />
                    WhatsApp
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
