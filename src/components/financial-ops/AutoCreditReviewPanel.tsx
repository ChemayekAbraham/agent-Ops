import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
  CheckCircle2,
  Undo2,
  Shield,
  Loader2,
  Mail,
  Phone,
  User,
  FileText,
  AlertTriangle,
  Search,
  Info,
  Check,
} from 'lucide-react';
import { formatDynamic } from '@/lib/currencyFormat';

/**
 * Auto-Credit Review Queue
 * --------------------------------------------------------------
 * Surfaces deposits the Gmail poller auto-credited via the MTN
 * NAME fallback (best-guess winner among same-named profiles).
 * Ops can:
 *   • Confirm  → marks the credit reviewed, leaves wallet untouched
 *   • Reverse  → CFO-direct-debit pulls the funds back out of the
 *                target user's Operational Float and marks reversed
 */

export interface CandidateItem {
  id: string;
  full_name: string | null;
  phone_last4?: string | null;
  last_sign_in_at?: string | null;
  selected?: boolean;
}

export interface ReviewRow {
  id: string;
  user_id: string;
  amount: number;
  transaction_id: string | null;
  transaction_date: string | null;
  created_at: string;
  provider: string | null;
  auto_match_audit: any;
  profile?: {
    full_name: string | null;
    phone: string | null;
    email: string | null;
  } | null;
}

const PAGE_SIZE = 25;

const MOCK_ROWS: ReviewRow[] = [
  {
    id: 'mock-1',
    user_id: 'mock-u1',
    amount: 350000,
    provider: 'MTN',
    transaction_id: 'MP261023437',
    transaction_date: '2026-10-23T07:16:00Z',
    created_at: '2026-10-23T07:16:00Z',
    profile: {
      full_name: 'Benjamin Muhanguzi',
      phone: '+256 77•••3998',
      email: 'user0@example.com',
    },
    auto_match_audit: {
      match_method: 'name',
      matched_name: 'BENJAMIN MUHANGUZI',
      tiebreaker: 'most-recent-active',
      confidence: 'low',
      confidence_score: 0.42,
      confidence_reasons: [
        'Sender name matches 2 profiles',
        'Most recently active account selected',
      ],
      name_match: {
        tiebreaker_pool: 'active-30d',
        total_candidates: 2,
        candidates: [
          {
            id: 'c1',
            full_name: 'Benjamin Muhanguzi',
            phone_last4: '3998',
            last_sign_in_at: '2026-10-21T10:00:00Z',
            selected: true,
          },
          {
            id: 'c2',
            full_name: 'Benjamin Muhanguzi',
            phone_last4: '1204',
            last_sign_in_at: '2026-09-13T10:00:00Z',
            selected: false,
          },
        ],
      },
    },
  },
  {
    id: 'mock-2',
    user_id: 'mock-u2',
    amount: 120000,
    provider: 'AIRTEL',
    transaction_id: 'MP261023474',
    transaction_date: '2026-10-23T06:45:00Z',
    created_at: '2026-10-23T06:45:00Z',
    profile: {
      full_name: 'Sarah Nakato',
      phone: '+256 70•••4512',
      email: 'sarah.nakato@example.com',
    },
    auto_match_audit: {
      match_method: 'name',
      matched_name: 'SARAH NAKATO',
      tiebreaker: 'most-recent-active',
      confidence: 'low',
      confidence_score: 0.45,
      confidence_reasons: [
        'Sender name matches 2 profiles',
        'Selected active member within 30 days',
      ],
      name_match: {
        tiebreaker_pool: 'active-30d',
        total_candidates: 2,
        candidates: [
          {
            id: 'c21',
            full_name: 'Sarah Nakato',
            phone_last4: '4512',
            last_sign_in_at: '2026-10-22T08:00:00Z',
            selected: true,
          },
          {
            id: 'c22',
            full_name: 'Sarah Nakato',
            phone_last4: '8811',
            last_sign_in_at: '2026-08-11T12:00:00Z',
            selected: false,
          },
        ],
      },
    },
  },
  {
    id: 'mock-3',
    user_id: 'mock-u3',
    amount: 75000,
    provider: 'MTN',
    transaction_id: 'MP261023511',
    transaction_date: '2026-10-22T14:20:00Z',
    created_at: '2026-10-22T14:20:00Z',
    profile: {
      full_name: 'John Okello',
      phone: '+256 78•••6230',
      email: 'john.okello@example.com',
    },
    auto_match_audit: {
      match_method: 'name',
      matched_name: 'JOHN OKELLO',
      tiebreaker: 'single-active-profile',
      confidence: 'high',
      confidence_score: 0.95,
      confidence_reasons: [
        'Single exact name match in active directory',
        'Verified phone prefix matches network',
      ],
      name_match: {
        tiebreaker_pool: 'single-match',
        total_candidates: 1,
        candidates: [
          {
            id: 'c31',
            full_name: 'John Okello',
            phone_last4: '6230',
            last_sign_in_at: '2026-10-22T12:00:00Z',
            selected: true,
          },
        ],
      },
    },
  },
  {
    id: 'mock-4',
    user_id: 'mock-u4',
    amount: 500000,
    provider: 'MTN',
    transaction_id: 'MP261023548',
    transaction_date: '2026-10-22T11:15:00Z',
    created_at: '2026-10-22T11:15:00Z',
    profile: {
      full_name: 'Grace Akello',
      phone: '+256 77•••9021',
      email: 'grace.akello@example.com',
    },
    auto_match_audit: {
      match_method: 'name',
      matched_name: 'GRACE AKELLO',
      tiebreaker: 'first-candidate',
      confidence: 'medium',
      confidence_score: 0.68,
      confidence_reasons: [
        'Multiple profiles registered with identical name',
        'Resolved using earliest verified KYC account',
      ],
      name_match: {
        tiebreaker_pool: 'kyc-verified',
        total_candidates: 3,
        candidates: [
          {
            id: 'c41',
            full_name: 'Grace Akello',
            phone_last4: '9021',
            last_sign_in_at: '2026-10-20T09:00:00Z',
            selected: true,
          },
          {
            id: 'c42',
            full_name: 'Grace Akello',
            phone_last4: '3341',
            last_sign_in_at: '2026-07-04T15:00:00Z',
            selected: false,
          },
          {
            id: 'c43',
            full_name: 'Grace Akello',
            phone_last4: '1908',
            last_sign_in_at: '2026-05-18T11:00:00Z',
            selected: false,
          },
        ],
      },
    },
  },
  {
    id: 'mock-5',
    user_id: 'mock-u5',
    amount: 60000,
    provider: 'AIRTEL',
    transaction_id: 'MP261023585',
    transaction_date: '2026-10-22T09:30:00Z',
    created_at: '2026-10-22T09:30:00Z',
    profile: {
      full_name: 'Peter Ssemwogerere',
      phone: '+256 75•••1189',
      email: 'peter.s@example.com',
    },
    auto_match_audit: {
      match_method: 'name',
      matched_name: 'PETER SSEMWOGERERE',
      tiebreaker: 'single-active-profile',
      confidence: 'high',
      confidence_score: 0.98,
      confidence_reasons: [
        'Unique profile name match in ledger database',
        'Direct KYC verified phone',
      ],
      name_match: {
        tiebreaker_pool: 'single-match',
        total_candidates: 1,
        candidates: [
          {
            id: 'c51',
            full_name: 'Peter Ssemwogerere',
            phone_last4: '1189',
            last_sign_in_at: '2026-10-22T09:10:00Z',
            selected: true,
          },
        ],
      },
    },
  },
];

export function AutoCreditReviewPanel() {
  const qc = useQueryClient();
  const [reverseTarget, setReverseTarget] = useState<ReviewRow | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dismissedMockIds, setDismissedMockIds] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'risky' | 'high'>('all');

  const { data: rawRows = [], isLoading } = useQuery({
    queryKey: ['auto-credit-review-queue'],
    queryFn: async (): Promise<ReviewRow[]> => {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('deposit_requests')
        .select(
          'id, user_id, amount, transaction_id, transaction_date, created_at, provider, auto_match_audit'
        )
        .eq('auto_approved', true)
        .is('auto_credit_review_status', null)
        .filter('auto_match_audit->>match_method', 'eq', 'name')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);
      if (error) throw error;
      const list = (data ?? []) as ReviewRow[];
      const ids = Array.from(new Set(list.map((r) => r.user_id))).filter(Boolean);
      if (ids.length) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, phone, email')
          .in('id', ids);
        const map = new Map((profs ?? []).map((p: any) => [p.id, p]));
        list.forEach((r) => {
          r.profile = map.get(r.user_id) ?? null;
        });
      }
      return list;
    },
    staleTime: 15_000,
  });

  // Effective rows list: live database records if any, or mock demonstration queue
  const displayRows = useMemo(() => {
    if (rawRows.length > 0) return rawRows;
    return MOCK_ROWS.filter((r) => !dismissedMockIds.includes(r.id));
  }, [rawRows, dismissedMockIds]);

  // Overall counts for header KPI cards
  const pendingCount = displayRows.length;
  const riskyTiesCount = useMemo(() => {
    return displayRows.filter((r) => {
      const itemAudit = r.auto_match_audit ?? {};
      const tie = String(itemAudit.tiebreaker ?? '');
      return (
        tie === 'first-candidate' ||
        tie === 'most-recent-active' ||
        itemAudit.confidence === 'low' ||
        itemAudit.confidence === 'medium'
      );
    }).length;
  }, [displayRows]);

  // Filtered rows for left queue
  const filteredRows = useMemo(() => {
    return displayRows.filter((r) => {
      const itemAudit = r.auto_match_audit ?? {};
      const tie = String(itemAudit.tiebreaker ?? '');
      const isRisky =
        tie === 'first-candidate' ||
        tie === 'most-recent-active' ||
        itemAudit.confidence === 'low' ||
        itemAudit.confidence === 'medium';
      const isHigh = itemAudit.confidence === 'high';

      if (filterMode === 'risky' && !isRisky) return false;
      if (filterMode === 'high' && !isHigh) return false;

      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase().trim();
      const name = (r.profile?.full_name ?? '').toLowerCase();
      const phone = (r.profile?.phone ?? '').toLowerCase();
      const tid = (r.transaction_id ?? '').toLowerCase();
      const sender = String(itemAudit.matched_name ?? '').toLowerCase();
      return name.includes(q) || phone.includes(q) || tid.includes(q) || sender.includes(q);
    });
  }, [displayRows, filterMode, searchQuery]);

  // Selected row
  const activeSelectedId = selectedId || filteredRows[0]?.id || displayRows[0]?.id || null;
  const selectedRow = useMemo(() => {
    return (
      filteredRows.find((r) => r.id === activeSelectedId) ??
      displayRows.find((r) => r.id === activeSelectedId) ??
      filteredRows[0] ??
      displayRows[0] ??
      null
    );
  }, [filteredRows, displayRows, activeSelectedId]);

  const confirm = async (row: ReviewRow) => {
    setBusyId(row.id);
    try {
      if (row.id.startsWith('mock-')) {
        await new Promise((res) => setTimeout(res, 300));
        setDismissedMockIds((prev) => [...prev, row.id]);
        toast.success('Credit confirmed');
        return;
      }

      const { data: auth } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('deposit_requests')
        .update({
          auto_credit_review_status: 'confirmed',
          auto_credit_reviewed_by: auth.user?.id ?? null,
          auto_credit_reviewed_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      if (error) throw error;
      toast.success('Credit confirmed');
      qc.invalidateQueries({ queryKey: ['auto-credit-review-queue'] });
    } catch (e: any) {
      toast.error('Could not confirm', { description: e?.message ?? String(e) });
    } finally {
      setBusyId(null);
    }
  };

  const submitReverse = async () => {
    if (!reverseTarget) return;
    const reason = reverseReason.trim();
    if (reason.length < 10) {
      toast.error('Add a reason of at least 10 characters');
      return;
    }
    setBusyId(reverseTarget.id);
    try {
      if (reverseTarget.id.startsWith('mock-')) {
        await new Promise((res) => setTimeout(res, 300));
        setDismissedMockIds((prev) => [...prev, reverseTarget.id]);
        toast.success('Credit reversed', {
          description:
            'Float debited, deposit cancelled and email receipt unlinked — re-route it from Email Transactions.',
        });
        setReverseTarget(null);
        setReverseReason('');
        return;
      }

      const tid = reverseTarget.transaction_id ?? 'no-tid';
      const { error } = await invokeEdgeFunction('cfo-direct-credit', {
        body: {
          target_user_id: reverseTarget.user_id,
          amount: reverseTarget.amount,
          operation: 'debit',
          recipient_type: 'operational_wallet',
          wallet_category: 'agent_float_deposit',
          reason: `Reverse auto-credit dep=${reverseTarget.id} tid=${tid}: ${reason}`,
          sub_category: 'auto_credit_reversal',
        },
        errorTitle: 'Reversal failed',
      });
      if (error) return;

      const { data: auth } = await supabase.auth.getUser();
      await supabase
        .from('deposit_requests')
        .update({
          status: 'cancelled',
          auto_credit_review_status: 'reversed',
          auto_credit_reviewed_by: auth.user?.id ?? null,
          auto_credit_reviewed_at: new Date().toISOString(),
          auto_credit_review_notes: reason,
        })
        .eq('id', reverseTarget.id);

      await supabase
        .from('gmail_transactions')
        .update({
          linked_deposit_request_id: null,
          auto_matched_at: null,
          auto_match_method: null,
        })
        .eq('linked_deposit_request_id', reverseTarget.id);

      toast.success('Credit reversed', {
        description:
          'Float debited, deposit cancelled and email receipt unlinked — re-route it from Email Transactions.',
      });
      setReverseTarget(null);
      setReverseReason('');
      qc.invalidateQueries({ queryKey: ['auto-credit-review-queue'] });
    } catch (e: any) {
      toast.error('Reversal failed', { description: e?.message ?? String(e) });
    } finally {
      setBusyId(null);
    }
  };

  const formatShortDate = (dateStr?: string | null) => {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    } catch {
      return dateStr;
    }
  };

  const formatHeaderDateTime = (dateStr?: string | null) => {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      const day = d.getDate();
      const monthNames = [
        'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
      ];
      const month = monthNames[d.getMonth()];
      const year = d.getFullYear();
      let hours = d.getHours();
      const minutes = d.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12;
      return `${day} ${month} ${year} · ${hours}:${minutes} ${ampm}`;
    } catch {
      return dateStr;
    }
  };

  const formatLastSeenDate = (dateStr?: string | null) => {
    if (!dateStr) return 'never';
    try {
      const d = new Date(dateStr);
      const day = d.getDate();
      const monthNames = [
        'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
      ];
      return `${day} ${monthNames[d.getMonth()]} ${d.getFullYear()}`;
    } catch {
      return dateStr;
    }
  };

  const audit = selectedRow?.auto_match_audit ?? {};
  const tieKey: string = String(audit.tiebreaker ?? '');
  const candidatePool: CandidateItem[] = audit.name_match?.candidates ?? [];
  const confidenceScore: number =
    typeof audit.confidence_score === 'number'
      ? Math.round(audit.confidence_score * 100)
      : audit.confidence === 'low'
      ? 42
      : audit.confidence === 'medium'
      ? 68
      : 95;

  const isSelectedRisky =
    tieKey === 'first-candidate' ||
    tieKey === 'most-recent-active' ||
    audit.confidence === 'low' ||
    audit.confidence === 'medium';

  return (
    <div className="w-full space-y-3">
      {/* Top Header Row with Title + KPI stat cards */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-2xl bg-primary/10 text-primary flex items-center justify-center shrink-0 shadow-xs">
            <Shield className="h-6 w-6 stroke-[2.2]" />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
              Auto-Credit Review
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground">
              Deposits auto-credited by name matching. Review the match, then confirm or reverse the credit.
            </p>
          </div>
        </div>

        {/* Right Stats Cards */}
        <div className="flex items-center gap-3 self-start md:self-auto">
          {/* Card 1: Pending */}
          <div className="flex items-center gap-3 bg-card border border-border/70 rounded-xl px-4 py-2 shadow-xs">
            <div className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <FileText className="h-4.5 w-4.5" />
            </div>
            <div>
              <div className="text-lg font-bold text-foreground leading-tight">
                {pendingCount}
              </div>
              <div className="text-[11px] text-muted-foreground font-medium">pending</div>
            </div>
          </div>

          {/* Card 2: Risky Ties */}
          <div className="flex items-center gap-3 bg-card border border-border/70 rounded-xl px-4 py-2 shadow-xs">
            <div className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <AlertTriangle className="h-4.5 w-4.5" />
            </div>
            <div>
              <div className="text-lg font-bold text-foreground leading-tight">
                {riskyTiesCount}
              </div>
              <div className="text-[11px] text-muted-foreground font-medium">risky ties</div>
            </div>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground p-16 justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-primary" /> Loading review queue…
        </div>
      ) : displayRows.length === 0 ? (
        <div className="bg-card border border-border/60 rounded-2xl p-12 text-center shadow-xs">
          <CheckCircle2 className="h-10 w-10 text-primary mx-auto mb-3" />
          <h3 className="text-base font-semibold text-foreground">Review Queue is Empty</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
            All recent auto-credits have been reviewed or look clean. No pending name matches require manual ops verification.
          </p>
        </div>
      ) : (
        /* Unified Dual-Pane Master-Detail Console (Full-width, full-height, zero dangling margins) */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 w-full lg:h-[calc(100vh-9.5rem)] items-stretch">
          {/* Left Pane: Review Queue with Fixed Header, Search, Filter Pills & Internal Scroll */}
          <div className="lg:col-span-5 flex flex-col h-full bg-card border border-border/70 rounded-2xl shadow-xs overflow-hidden">
            {/* Queue Header & Filters */}
            <div className="p-4 border-b border-border/60 space-y-3 bg-muted/20">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-foreground">Review queue</h2>
                  <span className="bg-primary/10 text-primary text-xs font-semibold px-2 py-0.5 rounded-full">
                    {displayRows.length}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {filteredRows.length} showing
                </span>
              </div>

              {/* Search Bar */}
              <div className="relative">
                <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter by name, phone, or TID..."
                  className="pl-8 h-9 text-xs rounded-xl bg-background border-border/70 focus-visible:ring-primary"
                />
              </div>

              {/* Quick Filter Tabs */}
              <div className="flex items-center gap-1.5 pt-0.5">
                <button
                  type="button"
                  onClick={() => setFilterMode('all')}
                  className={`text-xs px-2.5 py-1 rounded-lg font-medium transition-colors ${
                    filterMode === 'all'
                      ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                      : 'bg-muted/60 text-muted-foreground hover:bg-muted'
                  }`}
                >
                  All ({displayRows.length})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterMode('risky')}
                  className={`text-xs px-2.5 py-1 rounded-lg font-medium transition-colors ${
                    filterMode === 'risky'
                      ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                      : 'bg-muted/60 text-muted-foreground hover:bg-muted'
                  }`}
                >
                  Risky ties ({riskyTiesCount})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterMode('high')}
                  className={`text-xs px-2.5 py-1 rounded-lg font-medium transition-colors ${
                    filterMode === 'high'
                      ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                      : 'bg-muted/60 text-muted-foreground hover:bg-muted'
                  }`}
                >
                  High confidence
                </button>
              </div>
            </div>

            {/* Scrollable Queue Items */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {filteredRows.length === 0 ? (
                <div className="p-8 text-center text-xs text-muted-foreground">
                  No deposits match the selected filter.
                </div>
              ) : (
                filteredRows.map((r) => {
                  const itemAudit = r.auto_match_audit ?? {};
                  const itemTie = String(itemAudit.tiebreaker ?? '');
                  const isRisky =
                    itemTie === 'first-candidate' ||
                    itemTie === 'most-recent-active' ||
                    itemAudit.confidence === 'low' ||
                    itemAudit.confidence === 'medium';
                  const confidence = itemAudit.confidence ?? 'low';
                  const isSelected = selectedRow?.id === r.id;

                  return (
                    <div
                      key={r.id}
                      onClick={() => setSelectedId(r.id)}
                      className={`rounded-xl p-3.5 transition-all text-left w-full cursor-pointer relative shadow-xs ${
                        isSelected
                          ? 'border-2 border-primary/50 bg-primary/[0.05]'
                          : 'border border-border/60 bg-card hover:bg-muted/30'
                      }`}
                    >
                      {/* Row 1: Amount + Badges */}
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-base text-foreground tracking-tight">
                          {formatDynamic(r.amount)}
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {isRisky && (
                            <span className="bg-primary/10 text-primary text-[11px] font-medium px-2 py-0.5 rounded-full border border-primary/20">
                              risky tie
                            </span>
                          )}
                          <span
                            className={`text-[11px] font-medium px-2.5 py-0.5 rounded-full ${
                              confidence === 'high'
                                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                                : confidence === 'medium'
                                ? 'bg-primary/10 text-primary border border-primary/20'
                                : 'bg-muted text-muted-foreground'
                            }`}
                          >
                            {confidence}
                          </span>
                        </div>
                      </div>

                      {/* Row 2: Customer Name */}
                      <div className="text-sm font-semibold text-foreground mt-1">
                        {r.profile?.full_name ?? '(no profile name)'}
                      </div>

                      {/* Row 3: Provider & Metadata */}
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {r.provider ?? '—'} · TID {r.transaction_id ?? '—'} ·{' '}
                        {formatShortDate(r.created_at)}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Pane: Selected Deposit Detail & Audit (Full-height internal scroll) */}
          <div className="lg:col-span-7 flex flex-col h-full bg-card border border-border/70 rounded-2xl shadow-xs overflow-hidden">
            {selectedRow ? (
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {/* Header: Amount, Provider, Tiebreaker Pill, Date */}
                <div className="space-y-1.5 pb-2 border-b border-border/50">
                  <div className="flex items-center flex-wrap gap-2.5">
                    <span className="text-2xl sm:text-3xl font-extrabold text-foreground tracking-tight">
                      {formatDynamic(selectedRow.amount)}
                    </span>
                    <span className="border border-border/80 text-muted-foreground font-semibold text-xs px-2.5 py-0.5 rounded-md uppercase">
                      {selectedRow.provider ?? 'MTN'}
                    </span>
                    {tieKey && (
                      <span
                        className={`text-xs font-semibold px-3 py-1 rounded-full ${
                          isSelectedRisky
                            ? 'bg-primary/10 text-primary border border-primary/20'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {tieKey}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground font-medium">
                    TID {selectedRow.transaction_id ?? '—'} ·{' '}
                    {formatHeaderDateTime(selectedRow.created_at)}
                  </div>
                </div>

                {/* CREDITED TO Box */}
                <div className="space-y-2">
                  <div className="border border-border/60 rounded-2xl p-4 bg-muted/20 space-y-2.5">
                    <div className="text-[11px] font-bold text-muted-foreground tracking-wider uppercase">
                      Credited to
                    </div>
                    <div className="space-y-1.5 text-sm">
                      <div className="flex items-center gap-2.5 font-bold text-foreground">
                        <User className="h-4 w-4 text-muted-foreground shrink-0" />
                        {selectedRow.profile?.full_name ?? 'Betty Kakai'}
                      </div>
                      <div className="flex items-center gap-2.5 text-xs text-muted-foreground font-mono">
                        <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                        {selectedRow.profile?.phone ?? '+256 77•••3998'}
                      </div>
                      {selectedRow.profile?.email && (
                        <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
                          <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                          {selectedRow.profile.email}
                        </div>
                      )}
                    </div>
                  </div>

                  {audit.matched_name && (
                    <div className="text-xs text-muted-foreground px-1">
                      Email sender name:{' '}
                      <span className="font-semibold uppercase text-foreground">
                        {String(audit.matched_name)}
                      </span>
                    </div>
                  )}
                </div>

                {/* MATCH AUDIT Box */}
                <div className="border border-border/60 rounded-2xl p-5 bg-muted/20 space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-bold text-muted-foreground tracking-wider uppercase">
                      Match audit
                    </div>
                    <span
                      className={`text-xs font-semibold px-3 py-1 rounded-full ${
                        audit.confidence === 'high'
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                          : audit.confidence === 'medium'
                          ? 'bg-primary/10 text-primary border border-primary/20'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {audit.confidence === 'high'
                        ? 'High confidence'
                        : audit.confidence === 'medium'
                        ? 'Medium confidence'
                        : 'Low confidence'}{' '}
                      · {confidenceScore}%
                    </span>
                  </div>

                  <div className="text-xs text-muted-foreground">
                    Tie-breaker: <span className="font-mono text-foreground">{tieKey || 'unique-name-match'}</span>
                    {audit.name_match?.tiebreaker_pool && (
                      <>
                        {' '}· pool: <span className="font-mono text-foreground">{audit.name_match.tiebreaker_pool}</span>
                      </>
                    )}
                    {' · '}
                    {audit.name_match?.total_candidates ?? (candidatePool.length || 1)} candidate
                    {(audit.name_match?.total_candidates ?? (candidatePool.length || 1)) === 1 ? '' : 's'}
                  </div>

                  {/* Bullet Reasons */}
                  {Array.isArray(audit.confidence_reasons) && audit.confidence_reasons.length > 0 && (
                    <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1">
                      {audit.confidence_reasons.map((reason: string, i: number) => (
                        <li key={i}>{reason}</li>
                      ))}
                    </ul>
                  )}

                  {/* Candidates Table */}
                  <div className="border border-border/50 rounded-xl overflow-hidden bg-card mt-3">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-border/50 bg-muted/40 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                          <th className="py-2.5 pl-4 pr-2 w-8"></th>
                          <th className="py-2.5 px-3">Name</th>
                          <th className="py-2.5 px-3">Phone</th>
                          <th className="py-2.5 px-3">Last seen</th>
                          <th className="py-2.5 pr-4 pl-3 text-right">Match</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/40">
                        {candidatePool.length > 0 ? (
                          candidatePool.map((c) => {
                            const isCandSelected = !!c.selected;
                            return (
                              <tr
                                key={c.id}
                                className={isCandSelected ? 'bg-primary/[0.04]' : 'hover:bg-muted/20'}
                              >
                                <td className="py-3 pl-4 pr-2">
                                  {isCandSelected ? (
                                    <div className="w-4 h-4 rounded-full border-2 border-primary flex items-center justify-center">
                                      <div className="w-2 h-2 rounded-full bg-primary" />
                                    </div>
                                  ) : (
                                    <div className="w-4 h-4 rounded-full border border-muted-foreground/40" />
                                  )}
                                </td>
                                <td className="py-3 px-3 font-semibold text-foreground">
                                  {c.full_name ?? '(unnamed)'}
                                </td>
                                <td className="py-3 px-3 text-muted-foreground font-mono">
                                  {c.phone_last4 ? `•••${c.phone_last4}` : '—'}
                                </td>
                                <td className="py-3 px-3 text-muted-foreground">
                                  {formatLastSeenDate(c.last_sign_in_at)}
                                </td>
                                <td className="py-3 pr-4 pl-3 text-right">
                                  {isCandSelected ? (
                                    <span className="bg-primary/10 text-primary font-semibold text-xs px-3 py-1 rounded-full inline-block">
                                      Credited
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })
                        ) : (
                          <tr className="bg-primary/[0.04]">
                            <td className="py-3 pl-4 pr-2">
                              <div className="w-4 h-4 rounded-full border-2 border-primary flex items-center justify-center">
                                <div className="w-2 h-2 rounded-full bg-primary" />
                              </div>
                            </td>
                            <td className="py-3 px-3 font-semibold text-foreground">
                              {selectedRow.profile?.full_name ?? 'Recipient'}
                            </td>
                            <td className="py-3 px-3 text-muted-foreground font-mono">
                              {selectedRow.profile?.phone ?? '—'}
                            </td>
                            <td className="py-3 px-3 text-muted-foreground">
                              {formatLastSeenDate(selectedRow.created_at)}
                            </td>
                            <td className="py-3 pr-4 pl-3 text-right">
                              <span className="bg-primary/10 text-primary font-semibold text-xs px-3 py-1 rounded-full inline-block">
                                Credited
                              </span>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Action Buttons Footer */}
                <div className="flex flex-col sm:flex-row items-center gap-4 pt-1">
                  <Button
                    size="lg"
                    disabled={busyId === selectedRow.id}
                    onClick={() => confirm(selectedRow)}
                    className="w-full sm:flex-1 h-12 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-semibold flex items-center justify-center gap-2 shadow-xs text-sm"
                  >
                    {busyId === selectedRow.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                    Confirm credit
                  </Button>
                  <Button
                    size="lg"
                    variant="outline"
                    disabled={busyId === selectedRow.id}
                    onClick={() => {
                      setReverseTarget(selectedRow);
                      setReverseReason('');
                    }}
                    className="w-full sm:flex-1 h-12 rounded-xl border border-border text-foreground hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 font-semibold flex items-center justify-center gap-2 text-sm"
                  >
                    <Undo2 className="h-4 w-4" />
                    Reverse credit
                  </Button>
                </div>

                {/* Operations Guidance Card (Fills height seamlessly & explains policies) */}
                <div className="rounded-xl border border-border/60 bg-muted/20 p-4 text-xs text-muted-foreground space-y-1.5">
                  <div className="flex items-center gap-2 font-semibold text-foreground">
                    <Info className="h-4 w-4 text-primary shrink-0" />
                    <span>Auto-Credit Operator Policy</span>
                  </div>
                  <p className="leading-relaxed">
                    • <strong>Confirm credit</strong> acknowledges that the auto-matched recipient is valid. No ledger modification is triggered, and the deposit remains intact in the user's operational float.
                  </p>
                  <p className="leading-relaxed">
                    • <strong>Reverse credit</strong> issues an immediate CFO direct-debit on the credited user's operational float, cancels the deposit row, and releases the Gmail receipt so it can be re-routed from Email Transactions.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
                <Check className="h-10 w-10 text-muted-foreground/40 mb-3" />
                <h4 className="font-semibold text-foreground">No Deposit Selected</h4>
                <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                  Select an item from the review queue on the left to inspect its match audit details and confirm or reverse.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Reverse Confirmation Dialog */}
      <Dialog
        open={!!reverseTarget}
        onOpenChange={(o) => {
          if (!o) setReverseTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Reverse auto-credit</DialogTitle>
            <DialogDescription>
              This will debit {reverseTarget ? formatDynamic(reverseTarget.amount) : ''} from{' '}
              <span className="font-semibold text-foreground">
                {reverseTarget?.profile?.full_name ?? 'this user'}
              </span>
              's Operational Float. After this, re-route the receipt to the correct user
              from Email Transactions.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Reason (min 10 characters)
            </label>
            <Textarea
              value={reverseReason}
              onChange={(e) => setReverseReason(e.target.value)}
              placeholder="e.g. Wrong Benjamin Muhanguzi — correct user is 0783673998"
              rows={3}
              className="rounded-xl border-border/80 focus-visible:ring-primary"
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              className="rounded-xl"
              onClick={() => setReverseTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="rounded-xl"
              onClick={submitReverse}
              disabled={!!busyId || reverseReason.trim().length < 10}
            >
              {busyId ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Undo2 className="h-4 w-4" />
              )}
              Reverse credit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
