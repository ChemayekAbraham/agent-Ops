import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, ArrowLeft, CheckCircle2, Users, Banknote, Search, X, FileDown, FileText } from 'lucide-react';
import { format } from 'date-fns';
import { generatePartnerWithdrawalsPdf } from '@/lib/partnerWithdrawalsPdf';
import { generatePartnerWithdrawalStatementPdf } from '@/lib/partnerWithdrawalStatementPdf';
import { toast } from 'sonner';

interface WithdrawalRow {
  id: string;
  user_id: string;
  amount: number;
  status: string;
  reason: string | null;
  created_at: string;
  fin_ops_verified_at: string | null;
  fin_ops_reference: string | null;
  payout_method: string | null;
  mobile_money_name: string | null;
  mobile_money_number: string | null;
  mobile_money_provider: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_account_name: string | null;
  linked_party: string | null;
  proxy_partner_id: string | null;
  fin_ops_payment_method: string | null;
}

interface Props {
  onBack: () => void;
}

export function ApprovedPartnerWithdrawals({ onBack }: Props) {
  const [loading, setLoading] = useState(true);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRow[]>([]);
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const [statementFor, setStatementFor] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      // Partner-linked withdrawals live under two columns: `linked_party` (direct
      // partner withdrawals) and `proxy_partner_id` (proxy payout deliveries).
      // Fetch every page so search + export see the whole system, not a 200-row slice.
      const PAGE = 1000;
      const rows: WithdrawalRow[] = [];
      for (let page = 0; page < 30; page++) {
        const { data, error } = await supabase
          .from('withdrawal_requests')
          .select('id, user_id, amount, status, reason, created_at, fin_ops_verified_at, fin_ops_reference, payout_method, mobile_money_name, mobile_money_number, mobile_money_provider, bank_name, bank_account_number, bank_account_name, linked_party, proxy_partner_id, fin_ops_payment_method')
          .in('status', ['completed', 'fin_ops_approved', 'approved', 'cfo_approved', 'coo_approved', 'manager_approved', 'processing'])
          .or('linked_party.not.is.null,proxy_partner_id.not.is.null')
          .order('created_at', { ascending: false })
          .range(page * PAGE, page * PAGE + PAGE - 1);

        if (error) throw error;
        const chunk = (data || []) as WithdrawalRow[];
        rows.push(...chunk);
        if (chunk.length < PAGE) break;
      }
      setWithdrawals(rows);

      // Fetch profile names for user_ids and linked_parties
      const ids = new Set<string>();
      rows.forEach(r => {
        ids.add(r.user_id);
        if (r.linked_party) ids.add(r.linked_party);
        if (r.proxy_partner_id) ids.add(r.proxy_partner_id);
      });
      const uniqueIds = [...ids].filter(Boolean);
      const map: Record<string, string> = {};
      for (let i = 0; i < uniqueIds.length; i += 500) {
        const { data: profileData } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', uniqueIds.slice(i, i + 500));
        // Keep empty when the name is missing so the render can fall back to the
        // payout (momo / bank) name instead of showing the literal "Unknown".
        (profileData || []).forEach(p => { map[p.id] = p.full_name || ''; });
      }
      setProfiles(map);
    } catch (err) {
      console.error('Error loading approved withdrawals:', err);
    } finally {
      setLoading(false);
    }
  };

  const partnerIdOf = (w: WithdrawalRow) => w.linked_party || w.proxy_partner_id || null;

  // Partners withdraw per portfolio. The portfolio identity is carried in the
  // withdrawal narration: "(Portfolio: <name/code>)" and, when routed, a
  // "Route: portfolio <uuid>" suffix. Parse both so the statement can be tied
  // to exactly one portfolio.
  const portfolioOf = (w: WithdrawalRow): { name: string | null; id: string | null } => {
    const reason = w.reason || '';
    const nameMatch = reason.match(/Portfolio:\s*([^)|]+)/i);
    const idMatch = reason.match(/Route:\s*portfolio\s*([0-9a-f-]{36})/i);
    return {
      name: nameMatch ? nameMatch[1].trim() : null,
      id: idMatch ? idMatch[1] : null,
    };
  };

  const partnerNameOf = (w: WithdrawalRow) => {
    const pid = partnerIdOf(w);
    if (!pid) return '—';
    return profiles[pid] || w.mobile_money_name || w.bank_account_name || 'Unknown Partner';
  };

  const filtered = withdrawals.filter(w => {
    if (!search) return true;
    const q = search.toLowerCase();
    const agentName = profiles[w.user_id]?.toLowerCase() || '';
    const partnerName = partnerNameOf(w).toLowerCase();
    const payeeName = (w.mobile_money_name || w.bank_account_name || '').toLowerCase();
    const portfolioName = (portfolioOf(w).name || '').toLowerCase();
    return agentName.includes(q) || partnerName.includes(q) || payeeName.includes(q) || portfolioName.includes(q) || w.reason?.toLowerCase().includes(q);
  });

  const totalAmount = filtered.reduce((sum, w) => sum + (w.amount || 0), 0);
  const completedCount = filtered.filter(w => w.status === 'completed').length;
  const pendingCount = filtered.length - completedCount;

  const statusBadge = (status: string) => {
    if (status === 'completed') return <Badge variant="success" size="sm">Completed</Badge>;
    if (status === 'processing') return <Badge variant="warning" size="sm">Processing</Badge>;
    return <Badge variant="outline" size="sm" className="capitalize">{status.replace(/_/g, ' ')}</Badge>;
  };

  const handleExport = async () => {
    if (filtered.length === 0) {
      toast.error('Nothing to export');
      return;
    }
    setExporting(true);
    try {
      const blob = await generatePartnerWithdrawalsPdf({
        searchTerm: search.trim() || undefined,
        rows: filtered.map(w => ({
          partner: partnerNameOf(w),
          portfolio: portfolioOf(w).name || '—',
          agent: profiles[w.user_id] || 'Unknown Agent',
          payee: w.mobile_money_name || w.bank_account_name || '—',
          method: (w.fin_ops_payment_method || w.payout_method || '—').replace(/_/g, ' '),
          reference: w.fin_ops_reference || '—',
          amount: w.amount || 0,
          status: w.status,
          date: w.created_at,
        })),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const slug = search.trim() ? `-${search.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
      a.download = `partner-withdrawals${slug}-${format(new Date(), 'yyyy-MM-dd')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${filtered.length} record${filtered.length === 1 ? '' : 's'}`);
    } catch (err) {
      console.error('Partner withdrawals export failed:', err);
      toast.error('Could not generate the PDF');
    } finally {
      setExporting(false);
    }
  };

  // Single-card financial statement, scoped to the portfolio that was withdrawn for.
  const handleStatement = async (w: WithdrawalRow) => {
    setStatementFor(w.id);
    try {
      const { name: portfolioName, id: portfolioId } = portfolioOf(w);
      const partnerId = partnerIdOf(w);

      let portfolio: any = null;
      const cols = 'id, portfolio_code, investment_amount, roi_percentage, roi_mode, duration_months, payout_day, next_roi_date, maturity_date, total_roi_earned, status';
      if (portfolioId) {
        const { data } = await supabase.from('investor_portfolios').select(cols).eq('id', portfolioId).maybeSingle();
        portfolio = data;
      }
      if (!portfolio && portfolioName && partnerId) {
        const { data } = await supabase
          .from('investor_portfolios')
          .select(cols)
          .eq('investor_id', partnerId)
          .eq('portfolio_code', portfolioName)
          .maybeSingle();
        portfolio = data;
      }

      // Payout history limited to the same partner + same portfolio narration.
      const history = withdrawals
        .filter(r => {
          if (partnerIdOf(r) !== partnerId) return false;
          const p = portfolioOf(r);
          if (portfolioId && p.id) return p.id === portfolioId;
          if (portfolioName && p.name) return p.name.toLowerCase() === portfolioName.toLowerCase();
          return r.id === w.id;
        })
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        .map(r => ({
          date: r.created_at,
          amount: r.amount || 0,
          status: r.status,
          method: (r.fin_ops_payment_method || r.payout_method || '—').replace(/_/g, ' '),
          reference: r.fin_ops_reference || '—',
          isCurrent: r.id === w.id,
        }));

      const blob = await generatePartnerWithdrawalStatementPdf({
        withdrawalId: w.id,
        partner: partnerNameOf(w),
        agent: profiles[w.user_id] || 'Unknown Agent',
        payee: w.mobile_money_name || w.bank_account_name || '—',
        method: (w.fin_ops_payment_method || w.payout_method || '—').replace(/_/g, ' '),
        reference: w.fin_ops_reference || '—',
        amount: w.amount || 0,
        status: w.status,
        date: w.created_at,
        note: w.reason,
        portfolio: {
          portfolioName: portfolioName || portfolio?.portfolio_code || null,
          portfolioCode: portfolio?.portfolio_code || null,
          capitalAmount: portfolio?.investment_amount ?? null,
          roiPercentage: portfolio?.roi_percentage ?? null,
          roiMode: portfolio?.roi_mode ?? null,
          durationMonths: portfolio?.duration_months ?? null,
          payoutDay: portfolio?.payout_day ?? null,
          nextRoiDate: portfolio?.next_roi_date ?? null,
          maturityDate: portfolio?.maturity_date ?? null,
          totalRoiEarned: portfolio?.total_roi_earned ?? null,
          status: portfolio?.status ?? null,
        },
        history,
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const slug = (portfolioName || partnerNameOf(w) || 'portfolio').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      a.download = `portfolio-statement-${slug}-${format(new Date(w.created_at), 'yyyy-MM-dd')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(portfolioName ? `Statement ready — ${portfolioName}` : 'Statement ready');
    } catch (err) {
      console.error('Portfolio statement export failed:', err);
      toast.error('Could not generate the statement');
    } finally {
      setStatementFor(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <div>
          <h2 className="text-lg font-bold">Partner & Proxy Partner Withdrawals</h2>
          <p className="text-xs text-muted-foreground">All approved and completed withdrawals linked to partners</p>
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="border-border/50">
          <CardContent className="p-3 text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Total</p>
            <p className="text-sm font-bold">{filtered.length}</p>
          </CardContent>
        </Card>
        <Card className="border-border/50">
          <CardContent className="p-3 text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Amount</p>
            <p className="text-sm font-bold text-success">{formatUGX(totalAmount)}</p>
          </CardContent>
        </Card>
        <Card className="border-border/50">
          <CardContent className="p-3 text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Completed</p>
            <p className="text-sm font-bold">{completedCount} <span className="text-muted-foreground font-normal text-xs">/ {pendingCount} pending</span></p>
          </CardContent>
        </Card>
      </div>

      {/* Search + export */}
      <div className="flex flex-wrap items-center gap-2">
      <div className="relative max-w-xs flex-1 min-w-[200px]">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search agent, partner, payee…"
          className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-8 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted">
            <X className="h-3 w-3 text-muted-foreground" />
          </button>
        )}
      </div>
        <Button size="sm" variant="outline" onClick={handleExport} disabled={exporting || filtered.length === 0} className="gap-1">
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
          Export PDF ({filtered.length})
        </Button>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <Card className="border-border/50">
          <CardContent className="py-10 text-center text-muted-foreground">
            <Banknote className="h-10 w-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No approved partner withdrawals found</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(w => {
            const agentName = profiles[w.user_id] || 'Unknown Agent';
            const payeeName = w.mobile_money_name || w.bank_account_name || '—';
            const partnerName = partnerNameOf(w);
            const method = (w.fin_ops_payment_method || w.payout_method || '—').replace(/_/g, ' ');
            const portfolioName = portfolioOf(w).name;
            // The exact destination the money was actually sent to, so the card
            // can be reconciled against the telecom / bank record.
            const destination = w.mobile_money_number
              ? `${(w.mobile_money_provider || 'Mobile money')} ${w.mobile_money_number}`
              : w.bank_account_number
                ? `${w.bank_name ? `${w.bank_name} · ` : ''}A/C ${w.bank_account_number}`
                : null;

            return (
              <Card key={w.id} className="border-border/50">
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-start justify-between">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold">{formatUGX(w.amount)}</p>
                        {statusBadge(w.status)}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Partner:</span> {partnerName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Portfolio:</span> {portfolioName || '—'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Agent:</span> {agentName}
                      </p>
                    </div>
                    <div className="text-right text-[10px] text-muted-foreground space-y-0.5">
                      <p>{format(new Date(w.created_at), 'MMM d, yyyy')}</p>
                      <p className="capitalize">{method}</p>
                      {w.fin_ops_reference && <p className="font-mono">Ref: {w.fin_ops_reference}</p>}
                    </div>
                  </div>
                  {payeeName !== '—' && (
                    <p className="text-[10px] text-muted-foreground">
                      Payee: <span className="font-medium">{payeeName}</span>
                    </p>
                  )}
                  {destination && (
                    <p className="text-[10px] text-muted-foreground">
                      Sent to: <span className="font-medium font-mono text-foreground">{destination}</span>
                    </p>
                  )}
                  {w.reason && (
                    <p className="text-[10px] text-muted-foreground italic truncate">{w.reason}</p>
                  )}
                  <div className="pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 text-[11px]"
                      onClick={() => handleStatement(w)}
                      disabled={statementFor === w.id}
                    >
                      {statementFor === w.id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <FileText className="h-3 w-3" />}
                      Statement PDF
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
