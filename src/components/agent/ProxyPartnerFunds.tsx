"use client";
import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Users, ArrowUpRight, Clock, CheckCircle2, XCircle, AlertCircle, Info, Hourglass, Download, X, CheckSquare, Eye, RotateCcw, Trash2, Share2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useWallet } from '@/hooks/useWallet';
import { useCurrency } from '@/hooks/useCurrency';
import { WithdrawRequestDialog } from '@/components/wallet/WithdrawRequestDialog';
import { sharePayoutCardViaWhatsApp, type PayoutCardData } from '@/lib/payoutShareCard';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ProxyRecentPayouts } from '@/components/agent/ProxyRecentPayouts';

interface PartnerBalance {
  partnerId: string;
  partnerName: string;
  partnerPhone: string;
  portfolioId: string | null;
  portfolioCode: string | null;
  accountName: string | null;
  totalReturns: number;
  totalWithdrawn: number;
  available: number;
  /**
   * ISO timestamp of the newest CFO-approved ROI item backing this card.
   * Used to keep the most recently approved partners at the top of the queue.
   */
  latestAt: string;
  /**
   * Amount the agent has already pulled into a pending/processing withdrawal
   * for this partner. When > 0 the card is treated as "in flight" — hidden
   * from the default All view but reachable via the In flight filter pill.
   */
  inFlightAmount: number;
}

interface PwoEntry {
  id: string;
  amount: number;
  linked_party: string | null;
  source_id: string | null;
  target_wallet_user_id: string | null;
  description: string | null;
  metadata: Record<string, any> | null;
  created_at: string;
  reviewed_at: string | null;
}

interface PortfolioInfo {
  id: string;
  portfolio_code: string | null;
  account_name: string | null;
  investor_id: string;
  payment_method?: 'mobile_money' | 'bank_transfer' | 'cash' | null;
  mobile_network?: 'MTN' | 'Airtel' | null;
  mobile_money_number?: string | null;
  bank_name?: string | null;
  bank_account_name?: string | null;
  account_number?: string | null;
}

const ACTIVE_PROXY_WITHDRAWAL_STATUSES = [
  'pending',
  'requested',
  'manager_approved',
  'cfo_approved',
  'processing',
] as const;

// Terminal/disbursed statuses — funds have already been deducted from the agent
// wallet via the approve-withdrawal edge function. These count as "delivered"
// against the per-partner ROI balance.
const COMPLETED_PROXY_WITHDRAWAL_STATUSES = [
  'completed',
  'approved',
  'fin_ops_approved',
] as const;

// Terminal statuses that did NOT result in a payout. The ROI is therefore still
// available; the partner simply needs the agent to re-request a payout.
const TERMINAL_UNPAID_STATUSES = ['rejected', 'expired', 'cancelled'] as const;

type FilterMode = 'all' | 'inflight' | 'reattempt' | 'fresh';

// Stable card key — one card per PORTFOLIO (a partner can hold several
// portfolios with different payout methods that each carry their own ROI
// payout; they MUST render as separate cards).
const makeCardKey = (partnerId: string, portfolioId: string | null) =>
  `${partnerId}-${portfolioId || 'none'}`;

const QUERY_CHUNK_SIZE = 100;

const chunkArray = <T,>(items: T[], size = QUERY_CHUNK_SIZE): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

const fetchChunks = async <T,>(
  items: string[],
  buildQuery: (chunk: string[]) => PromiseLike<{ data: any[] | null; error: any }>,
): Promise<T[]> => {
  const rows: T[] = [];
  for (const chunk of chunkArray(items)) {
    if (chunk.length === 0) continue;
    const { data, error } = await buildQuery(chunk);
    if (error) throw error;
    rows.push(...((data || []) as T[]));
  }
  return rows;
};

// Proxy withdrawals stamp the chosen portfolio into the request reason as
// "... | Route: portfolio <uuid>". Parsing it back lets us scope an in-flight
// hold (and the backend FIFO settlement) to the EXACT portfolio that was
// withdrawn, so paying one portfolio never removes a sibling portfolio's card.
const extractRoutePortfolioId = (reason?: string | null): string | null => {
  if (!reason) return null;
  const m = reason.match(/Route:\s*portfolio\s+([0-9a-fA-F-]{36})/);
  return m ? m[1] : null;
};

interface LastTerminal {
  status: string;
  reason: string | null;
  at: string; // ISO date
}

interface Dismissal {
  partner_id: string;
  portfolio_id: string | null;
  snapshot_amount: number;
  dismissed_at: string;
  reason: string | null;
}

export function ProxyPartnerFunds() {
  const { user } = useAuth();
  const { wallet } = useWallet();
  const { formatAmount } = useCurrency();
  const [loading, setLoading] = useState(true);
  const [approvedOps, setApprovedOps] = useState<PwoEntry[]>([]);
  const [profiles, setProfiles] = useState<Record<string, { full_name: string; phone: string }>>({});
  const [completedWithdrawals, setCompletedWithdrawals] = useState<any[]>([]);
  const [portfolios, setPortfolios] = useState<PortfolioInfo[]>([]);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [prefillAmount, setPrefillAmount] = useState<number>(0);
  const [prefillReason, setPrefillReason] = useState('');
  const [prefillPayout, setPrefillPayout] = useState<any>(null);
  // Where the locked payout destination came from, shown to the agent so it is
  // obvious the number is the partner's saved one and not something typed here.
  const [payoutSourceLabel, setPayoutSourceLabel] = useState<string | undefined>(undefined);
  const [selectedPartnerId, setSelectedPartnerId] = useState<string>('');
  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string | null>(null);
  const [partnerWithdrawalStatus, setPartnerWithdrawalStatus] = useState<Record<string, string>>({});
  const [partnerWithdrawalIds, setPartnerWithdrawalIds] = useState<Record<string, string>>({});
  const [strictWithdrawableByPartner, setStrictWithdrawableByPartner] = useState<Record<string, number>>({});
  // Amount settled per approval (approval_id → total amount_settled). Used to
  // subtract partial settlements so a residual the partner is still owed stays
  // visible and the displayed owed amount stays correct.
  const [settledByApproval, setSettledByApproval] = useState<Record<string, number>>({});
  // Partners whose proxy assignment is `is_managed_account=true`. Their ROI
  // is credited to the AGENT's wallet (not their own), so the ceiling clamp
  // must use the agent's strict withdrawable instead of the partner's zero.
  const [managedPartnerIds, setManagedPartnerIds] = useState<Set<string>>(new Set());
  // Partners whose proxy assignment was CREATED on a Saturday or Sunday.
  // Surfaced as a "Weekend" badge next to the partner name so the agent can
  // quickly spot weekend-only assignments (usually different SLA / cadence).
  const [weekendPartnerIds, setWeekendPartnerIds] = useState<Set<string>>(new Set());
  // Agent's own strict withdrawable — shared ceiling across managed cards.
  const [agentStrictWithdrawable, setAgentStrictWithdrawable] = useState<number>(0);
  // Removed managedPartnerIds state as ROI now always goes to the partner's wallet.
  // Sum of in-flight (pending/processing/manager_approved/cfo_approved/requested)
  // withdrawal amounts per partner. Treated as already-paid for display so the
  // card disappears from the default view the instant Caro initiates.
  const [activeWithdrawalsByPartner, setActiveWithdrawalsByPartner] = useState<Record<string, number>>({});
  // Per-card in-flight amounts, keyed by `${partnerId}-${portfolioId}`. A
  // routed withdrawal only hides ITS portfolio card; unrouted (legacy) holds
  // fall back to `activeWithdrawalsByPartner` and hide every card of that
  // partner.
  const [activeWithdrawalsByCard, setActiveWithdrawalsByCard] = useState<Record<string, number>>({});
  const [lastTerminalByPartner, setLastTerminalByPartner] = useState<Record<string, LastTerminal>>({});
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<{ key: string; withdrawalId: string; partnerName: string; partnerId: string } | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  // Dismissal state
  const [dismissals, setDismissals] = useState<Dismissal[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearTargets, setClearTargets] = useState<Array<{ partnerId: string; portfolioId: string | null; amount: number; partnerName: string }>>([]);
  const [clearReason, setClearReason] = useState('');
  const [clearing, setClearing] = useState(false);
  // Revert-to-nearing-payout dialog state
  const [revertOpen, setRevertOpen] = useState(false);
  const [revertTarget, setRevertTarget] = useState<PartnerBalance | null>(null);
  const [revertReason, setRevertReason] = useState('');
  const [reverting, setReverting] = useState(false);
  const [hiddenSheetOpen, setHiddenSheetOpen] = useState(false);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);
  // Custody V2: partner UUIDs we currently render. Used to scope a second
  // realtime channel (withdrawal_requests rows now belong to the partner,
  // not the agent — `user_id=eq.<agent>` no longer catches them).
  const [partnerIdsForRealtime, setPartnerIdsForRealtime] = useState<string[]>([]);
  const [portfolioIdsForRealtime, setPortfolioIdsForRealtime] = useState<string[]>([]);
  // Optimistic submit lock keyed per CARD (partner+portfolio) so submitting a
  // payout for one portfolio doesn't grey out a sibling portfolio's card.
  const [submittingCardKeys, setSubmittingCardKeys] = useState<Set<string>>(new Set());
  const partnerRealtimeKey = partnerIdsForRealtime.join(',');
  const portfolioRealtimeKey = portfolioIdsForRealtime.join(',');
  useEffect(() => {
    if (!user?.id) return;
    loadProxyFunds();
  }, [user?.id]);

  // Real-time subscription: auto-refresh when withdrawal statuses change.
  // Covers BOTH legacy agent-owned rows (`user_id = agent`) AND Custody V2
  // rows where the partner is the legal owner (`user_id = partner`). Without
  // the second filter, withdrawal cards never disappear after submission
  // because the partner-owned insert doesn't match the agent filter.
  useEffect(() => {
    if (!user?.id) return;

    const reload = () => loadProxyFunds(false);

    const agentChannel = supabase
      .channel(`proxy-withdrawal-updates-agent-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'proxy_agent_assignments',
          filter: `agent_id=eq.${user.id}`,
        },
        reload,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agent_proxy_card_dismissals',
          filter: `agent_id=eq.${user.id}`,
        },
        reload,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pending_wallet_operations',
          filter: `target_wallet_user_id=eq.${user.id}`,
        },
        reload,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'withdrawal_requests',
          filter: `user_id=eq.${user.id}`,
        },
        reload,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'withdrawal_requests',
          filter: `agent_id=eq.${user.id}`,
        },
        reload,
      )
      // (No proxy_payout_settlements listener: that table is not in the
      // Realtime publication, so it never fired. Settlements also update the
      // withdrawal_requests rows listened to above — doc 147.)
      .subscribe();

    // Per-partner channel — re-subscribed whenever the partner set changes.
    let partnerChannel: ReturnType<typeof supabase.channel> | null = null;
    if (partnerIdsForRealtime.length > 0 || portfolioIdsForRealtime.length > 0) {
      partnerChannel = supabase.channel(
        `proxy-withdrawal-updates-partners-${user.id}`,
      );
      partnerIdsForRealtime.forEach((pid) => {
        partnerChannel!.on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'withdrawal_requests',
            filter: `user_id=eq.${pid}`,
          },
          reload,
        );
      });
      portfolioIdsForRealtime.forEach((portfolioId) => {
        partnerChannel!.on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'pending_wallet_operations',
            filter: `source_id=eq.${portfolioId}`,
          },
          reload,
        );
      });
      partnerChannel.subscribe();
    }

    return () => {
      supabase.removeChannel(agentChannel);
      if (partnerChannel) supabase.removeChannel(partnerChannel);
    };
  }, [user?.id, partnerRealtimeKey, portfolioRealtimeKey]);

  const loadProxyFunds = async (showSpinner = true) => {
    if (!user?.id) return;
    if (showSpinner) setLoading(true);
    try {
      // Step 1: Get ROI payouts approved through the Partner Ops → COO → CFO flow.
      // Two sources of CFO-approved ROI payouts the agent should see:
      //
      //   (A) LEGACY custody — `pending_wallet_operations.target_wallet_user_id
      //       = agent.id`. The credit was parked on the agent's wallet and
      //       the agent withdraws on behalf of the partner.
      //
      //   (B) PROXY CUSTODY v2 — credit lands directly on the partner's
      //       wallet (target_wallet_user_id IS NULL or = partner.id). The
      //       agent is bridged to the partner via an active, approved row
      //       in `proxy_agent_assignments`. Without this branch, partners
      //       like SSENKAALI PIUS never appear in the proxy list after CFO
      //       approval.
      //
      // Both branches require: category='roi_payout', status='approved',
      // metadata.coo_approved_by NOT NULL (full Partner Ops → COO → CFO
      // chain), and source_id resolving to an `investor_portfolios` row.
      // Branch (A) additionally requires reviewed_by ∈ CFO ids; branch (B)
      // trusts the proxy_agent_assignments approval as the bridge.

      // Resolve active proxy partners delegated to this agent (Custody v2).
      const { data: proxyAssignments } = await supabase
        .from('proxy_agent_assignments')
        .select('beneficiary_id, is_managed_account, created_at')
        .eq('agent_id', user.id)
        .eq('is_active', true)
        .eq('approval_status', 'approved');
      const proxyPartnerIds = Array.from(
        new Set((proxyAssignments || []).map((r: any) => r.beneficiary_id).filter(Boolean)),
      ) as string[];
      // Managed-proxy partners — ROI for these lands in the AGENT's wallet
      // (per Managed-Proxy Payout Routing). Without this set, the ceiling
      // clamp uses the partner's zero withdrawable and silently drops every
      // managed card from the list (the bug Caro reported).
      const managedSet = new Set<string>(
        (proxyAssignments || [])
          .filter((r: any) => r.is_managed_account === true && r.beneficiary_id)
          .map((r: any) => r.beneficiary_id as string),
      );
      setManagedPartnerIds(managedSet);

      // Weekend assignments — Sat (6) or Sun (0) at the assignment's creation.
      const weekendSet = new Set<string>(
        (proxyAssignments || [])
          .filter((r: any) => {
            if (!r.beneficiary_id || !r.created_at) return false;
            const dow = new Date(r.created_at).getDay();
            return dow === 0 || dow === 6;
          })
          .map((r: any) => r.beneficiary_id as string),
      );
      setWeekendPartnerIds(weekendSet);

      // Load through the backend helper instead of a browser-side
      // `.in(source_id, hundreds...)` query. The long URL was returning 400,
      // so the UI silently had zero v2 ROI rows even though CFO approvals
      // existed. The RPC enforces the same active proxy-assignment bridge
      // server-side and returns both legacy and Custody-v2 approvals.
      const { data: proxyRoiRows, error: proxyRoiError } = await (supabase as any).rpc(
        'get_agent_proxy_roi_payouts',
        { p_agent_id: user.id },
      );
      if (proxyRoiError) throw proxyRoiError;

      let rawOps = ((proxyRoiRows || []) as PwoEntry[]).sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );

      // NOTE: intentionally no "today only" filter. A CFO-approved partner
      // must stay in this queue until they are actually paid out (Lillian
      // reported approved partners disappearing overnight). Settlement +
      // routed-withdrawal checks in `get_agent_proxy_roi_payouts` already
      // drop partners once their payout is delivered.

      // ── Settlement filter ─────────────────────────────────────────────
      // Drop any approval already settled by a delivered withdrawal.
      // This is the SOLE source of truth for "this approval is closed" — no
      // more guessing from balance math.
      //
      // IMPORTANT: high-volume agents (e.g. 500+ approvals) overflow the
      // PostgREST URL length when every approval_id is crammed into a single
      // `.in(...)` filter. The request then fails, `settledRows` comes back
      // empty, NO approvals get filtered, and hundreds of already-PAID
      // approvals reappear in the queue. Chunk the lookup so the URL stays
      // small, and surface any error instead of silently showing paid cards.
      if (rawOps.length > 0) {
        const allIds = rawOps.map((o) => o.id);
        const CHUNK = 100;
        const settledMap: Record<string, number> = {};
        let settlementLookupFailed = false;
        for (let i = 0; i < allIds.length; i += CHUNK) {
          const slice = allIds.slice(i, i + CHUNK);
          const { data: settledRows, error: settledErr } = await supabase
            .from('proxy_payout_settlements')
            .select('approval_id, amount_settled')
            .in('approval_id', slice);
          if (settledErr) {
            settlementLookupFailed = true;
            break;
          }
          (settledRows || []).forEach((r: any) => {
            settledMap[r.approval_id] =
              (settledMap[r.approval_id] || 0) + (Number(r.amount_settled) || 0);
          });
        }
        if (settlementLookupFailed) {
          // Never fall through to showing every approval as "owed" — that is
          // exactly the bug where paid partners flood back into the queue.
          toast.error('Could not verify settled payouts. Refreshing…');
          setLoading(false);
          return;
        }
        // Amount-aware: drop an approval ONLY when its settled total fully
        // covers the approved amount. A PARTIALLY-settled approval (FIFO
        // backfill consumed only part of it) keeps its residual visible so the
        // partner is not silently under-shown as fully paid.
        setSettledByApproval(settledMap);
        rawOps = rawOps.filter((o) => {
          const settled = settledMap[o.id] || 0;
          if (settled <= 0) return true;
          const amt = Number(o.amount) || 0;
          // keep when a meaningful residual (> 1 UGX dust) is still owed
          return settled < amt - 1;
        });
      } else {
        setSettledByApproval({});
      }
      if (rawOps.length === 0) {
        setProfiles({});
        setCompletedWithdrawals([]);
        setPortfolios([]);
        setPartnerWithdrawalStatus({});
        setActiveWithdrawalsByPartner({});
        setActiveWithdrawalsByCard({});
        setLastTerminalByPartner({});
        setStrictWithdrawableByPartner({});
        setPartnerIdsForRealtime([]);
        setApprovedOps([]);
        setLoading(false);
        return;
      }

      // Step 2: Collect portfolio IDs first to resolve actual partner (investor) IDs
      const portfolioIds = new Set<string>();
      rawOps.forEach(op => {
        if (op.source_id) portfolioIds.add(op.source_id);
      });
      const uniquePortfolioIds = [...portfolioIds];
      setPortfolioIdsForRealtime(uniquePortfolioIds.slice(0, 100));

      // Fetch portfolios first so we can resolve partner IDs
      let fetchedPortfolios: PortfolioInfo[] = [];
      if (uniquePortfolioIds.length > 0) {
        fetchedPortfolios = await fetchChunks<PortfolioInfo>(uniquePortfolioIds, (chunk) =>
          supabase
            .from('investor_portfolios')
            .select('id, portfolio_code, account_name, investor_id, payment_method, mobile_network, mobile_money_number, bank_name, bank_account_name, account_number')
            .in('id', chunk),
        );
      }
      setPortfolios(fetchedPortfolios);

      // Build portfolio→investor map
      const portfolioToInvestor: Record<string, string> = {};
      fetchedPortfolios.forEach(p => { portfolioToInvestor[p.id] = p.investor_id; });

      const validProxyPartnerIds = new Set(proxyPartnerIds);
      const ops = rawOps.filter((op) => {
        const investor = op.source_id ? portfolioToInvestor[op.source_id] : null;
        const targetWalletUserId = op.target_wallet_user_id;
        const belongsToCurrentAgent = !targetWalletUserId
          || targetWalletUserId === user.id
          || targetWalletUserId === investor;
        return !!investor
          && investor !== user.id
          && validProxyPartnerIds.has(investor)
          && belongsToCurrentAgent;
      });
      setApprovedOps(ops);

      if (ops.length === 0) {
        setProfiles({});
        setCompletedWithdrawals([]);
        setPartnerWithdrawalStatus({});
        setActiveWithdrawalsByPartner({});
        setActiveWithdrawalsByCard({});
        setLastTerminalByPartner({});
        setStrictWithdrawableByPartner({});
        setPartnerIdsForRealtime([]);
        setLoading(false);
        return;
      }

      // Partner identity is ALWAYS the portfolio's investor_id. Any op whose
      // source_id no longer maps to a portfolio is dropped — it cannot be
      // tied to a real CFO-approved partner return.
      const partnerIds = new Set<string>();
      ops.forEach(op => {
        const investor = op.source_id ? portfolioToInvestor[op.source_id] : null;
        if (investor && investor !== user.id) partnerIds.add(investor);
      });

      const uniquePartnerIds = [...partnerIds];
      // Publish the partner set so the realtime effect can subscribe to
      // `user_id=eq.<partner>` — that's where Custody V2 rows live.
      setPartnerIdsForRealtime(uniquePartnerIds);

      if (uniquePartnerIds.length === 0) {
        setProfiles({});
        setCompletedWithdrawals([]);
        setPartnerWithdrawalStatus({});
        setActiveWithdrawalsByPartner({});
        setActiveWithdrawalsByCard({});
        setLastTerminalByPartner({});
        setLoading(false);
        return;
      }

      // Step 4: Fetch profiles, completed withdrawals, active withdrawals, and
      // terminal-unpaid history in parallel
      const userScopeIds = Array.from(new Set([user.id, ...uniquePartnerIds]));
      const [profileRows, completedRows, activeWithdrawalRows, terminalRows, strictBalanceRows] = await Promise.all([
        fetchChunks<any>(uniquePartnerIds, (chunk) =>
          supabase.from('profiles').select('id, full_name, phone').in('id', chunk),
        ),
        // Completed withdrawals for these partners (already delivered)
        // Custody V2: partner-owned rows (`user_id = partner`, no
        // `linked_party`). Legacy: agent-owned rows (`user_id = agent`,
        // `linked_party = partner`). Pull both, dedupe in JS.
        fetchChunks<any>(userScopeIds, (chunk) =>
          supabase
            .from('withdrawal_requests')
            .select('id, user_id, linked_party, amount, status, reason, updated_at, created_at')
            .in('user_id', chunk)
            .in('status', [...COMPLETED_PROXY_WITHDRAWAL_STATUSES])
            .or(`linked_party.not.is.null,agent_id.eq.${user.id}`),
        ),
        // Active (pending/processing) withdrawal requests — same dual scope.
        fetchChunks<any>(userScopeIds, (chunk) =>
          supabase
            .from('withdrawal_requests')
            .select('id, user_id, linked_party, status, reason, amount, updated_at, created_at, agent_id')
            .in('user_id', chunk)
            .in('status', [...ACTIVE_PROXY_WITHDRAWAL_STATUSES])
            .or(`linked_party.not.is.null,agent_id.eq.${user.id}`),
        ),
        // Terminal-unpaid: rejected / expired / cancelled.
        fetchChunks<any>(userScopeIds, (chunk) =>
          supabase
            .from('withdrawal_requests')
            .select('id, user_id, linked_party, status, rejection_reason, updated_at, created_at, agent_id')
            .in('user_id', chunk)
            .in('status', [...TERMINAL_UNPAID_STATUSES])
            .or(`linked_party.not.is.null,agent_id.eq.${user.id}`)
            // Defense-in-depth: only consider terminal events from the last 7 days
            // so old rejections naturally fall off Caro's view.
            .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
            .order('updated_at', { ascending: false })
            .limit(500),
        ),
        fetchChunks<any>(userScopeIds, (chunk) =>
          supabase
            .from('v_user_wallet_strict')
            .select('user_id, withdrawable')
            // Include the AGENT's own row so the managed-proxy clamp can use
            // the agent's strict withdrawable (managed funds land in agent
            // wallet, not partner wallet).
            .in('user_id', chunk),
        ),
      ]);

      const profileMap: Record<string, { full_name: string; phone: string }> = {};
      profileRows.forEach(p => {
        // Store the raw name (empty when missing) so downstream resolution can
        // fall back to portfolio account names / metadata instead of prematurely
        // locking the card to the literal string "Unknown".
        profileMap[p.id] = { full_name: p.full_name || '', phone: p.phone || '' };
      });
      setProfiles(profileMap);
      const strictMap: Record<string, number> = {};
      strictBalanceRows.forEach((row: any) => {
        strictMap[row.user_id] = Number(row.withdrawable) || 0;
      });
      setStrictWithdrawableByPartner(strictMap);
      setAgentStrictWithdrawable(strictMap[user.id] || 0);
      // Resolve a partner key for every row: prefer linked_party (legacy
      // custody), fall back to user_id when it matches a known partner
      // (Custody V2). Anything that doesn't resolve is dropped.
      const resolvePartnerKey = (w: any): string | null => {
        if (w.linked_party && uniquePartnerIds.includes(w.linked_party)) {
          return w.linked_party;
        }
        if (w.user_id && uniquePartnerIds.includes(w.user_id)) {
          return w.user_id;
        }
        return null;
      };
      const completedNormalized = completedRows
        .map((w: any) => ({ ...w, linked_party: resolvePartnerKey(w) }))
        .filter((w: any) => !!w.linked_party);
      setCompletedWithdrawals(completedNormalized);

      // Build active withdrawal status map + ID map
      const statusMap: Record<string, string> = {};
      const idMap: Record<string, string> = {};
      // Sum of in-flight amounts. `byCard` holds routed withdrawals (we know
      // the exact portfolio) so only that portfolio's card is hidden. `byPartner`
      // holds UNROUTED legacy holds (no portfolio token in the reason) and is
      // applied to every card of the partner as a safe fallback.
      const activeAmountByCard: Record<string, number> = {};
      const activeAmountByPartner: Record<string, number> = {};
      // Track the most recent active-withdrawal timestamp per partner so we
      // can suppress stale terminal banners that have been superseded.
      const lastActiveAtByPartner: Record<string, string> = {};
      activeWithdrawalRows.forEach((w: any) => {
        const partnerKey = resolvePartnerKey(w);
        const wAmt = Number(w.amount) || 0;
        // The portfolio this withdrawal targets, parsed from the stamped
        // "Route: portfolio <uuid>" token. When present, the hold is scoped to
        // a single card; when absent it is a partner-wide (legacy) hold.
        const routePortfolioId = extractRoutePortfolioId(w.reason);

        if (partnerKey) {
          const ts = w.updated_at || w.created_at;
          if (ts && (!lastActiveAtByPartner[partnerKey] || ts > lastActiveAtByPartner[partnerKey])) {
            lastActiveAtByPartner[partnerKey] = ts;
          }
          if (routePortfolioId) {
            const cardKey = makeCardKey(partnerKey, routePortfolioId);
            activeAmountByCard[cardKey] = (activeAmountByCard[cardKey] || 0) + wAmt;
            const existing = statusMap[cardKey];
            if (!existing || w.status === 'pending') {
              statusMap[cardKey] = w.status;
              idMap[cardKey] = w.id;
            }
          } else {
            activeAmountByPartner[partnerKey] =
              (activeAmountByPartner[partnerKey] || 0) + wAmt;
            const existing = statusMap[partnerKey];
            if (!existing || w.status === 'pending') {
              statusMap[partnerKey] = w.status;
              idMap[partnerKey] = w.id;
            }
          }
          return;
        }
        if (!w.linked_party && w.reason) {
          for (const pid of uniquePartnerIds) {
            const name = profileMap[pid]?.full_name;
            if (name && w.reason.includes(name)) {
              if (routePortfolioId) {
                const cardKey = makeCardKey(pid, routePortfolioId);
                activeAmountByCard[cardKey] = (activeAmountByCard[cardKey] || 0) + wAmt;
                const existing = statusMap[cardKey];
                if (!existing || w.status === 'pending') {
                  statusMap[cardKey] = w.status;
                  idMap[cardKey] = w.id;
                }
              } else {
                const existing = statusMap[pid];
                if (!existing || w.status === 'pending') {
                  statusMap[pid] = w.status;
                  idMap[pid] = w.id;
                }
                activeAmountByPartner[pid] = (activeAmountByPartner[pid] || 0) + wAmt;
              }
              const ts = w.updated_at || w.created_at;
              if (ts && (!lastActiveAtByPartner[pid] || ts > lastActiveAtByPartner[pid])) {
                lastActiveAtByPartner[pid] = ts;
              }
              break;
            }
          }
        }
      });
      setPartnerWithdrawalStatus(statusMap);
      setPartnerWithdrawalIds(idMap);
      setActiveWithdrawalsByPartner(activeAmountByPartner);
      setActiveWithdrawalsByCard(activeAmountByCard);

      // Track the most recent successful (delivered) withdrawal timestamp per
      // partner — a terminal event older than this means Caro already
      // re-requested and got paid, so the destructive banner is outdated.
      const lastSuccessAtByPartner: Record<string, string> = {};
      completedRows.forEach((w: any) => {
        const pid = resolvePartnerKey(w);
        if (!pid || !uniquePartnerIds.includes(pid)) return;
        const ts = w.updated_at || w.created_at;
        if (!ts) return;
        if (!lastSuccessAtByPartner[pid] || ts > lastSuccessAtByPartner[pid]) {
          lastSuccessAtByPartner[pid] = ts;
        }
      });

      // Build last-terminal map: most recent rejected/expired/cancelled per partner
      const terminalMap: Record<string, LastTerminal> = {};
      terminalRows.forEach((w: any) => {
        const pid = resolvePartnerKey(w);
        if (!pid || !uniquePartnerIds.includes(pid)) return;
        if (terminalMap[pid]) return; // already have the most recent (ordered desc)
        terminalMap[pid] = {
          status: w.status,
          reason: w.rejection_reason || null,
          at: w.updated_at || w.created_at,
        };
      });

      // Suppress terminal events that have been superseded by a later
      // successful or in-flight withdrawal — those rejections/cancellations
      // are no longer actionable for the agent.
      Object.keys(terminalMap).forEach((pid) => {
        const terminalAt = terminalMap[pid].at;
        const successAt = lastSuccessAtByPartner[pid];
        const activeAt = lastActiveAtByPartner[pid];
        const supersededBySuccess = successAt && successAt >= terminalAt;
        const supersededByActive = activeAt && activeAt >= terminalAt;
        if (supersededBySuccess || supersededByActive) {
          delete terminalMap[pid];
        }
      });

      setLastTerminalByPartner(terminalMap);

      // Load this agent's dismissals (cards she has manually cleared)
      const { data: dismissalRows } = await supabase
        .from('agent_proxy_card_dismissals')
        .select('partner_id, portfolio_id, snapshot_amount, dismissed_at, reason')
        .eq('agent_id', user.id);
      setDismissals((dismissalRows || []) as Dismissal[]);
    } catch (err) {
      console.error('Error loading proxy funds:', err);
    } finally {
      setLoading(false);
    }
  };

  // Build portfolio lookup map
  const portfolioMap = useMemo(() => {
    const map: Record<string, PortfolioInfo> = {};
    portfolios.forEach(p => { map[p.id] = p; });
    return map;
  }, [portfolios]);

  // Dismissal lookup by `${partnerId}-${portfolioId || 'none'}`
  const dismissalMap = useMemo(() => {
    const map: Record<string, Dismissal> = {};
    dismissals.forEach(d => {
      const key = `${d.partner_id}-${d.portfolio_id || 'none'}`;
      map[key] = d;
    });
    return map;
  }, [dismissals]);

  const partnerBalances = useMemo<PartnerBalance[]>(() => {
    if (!user?.id) return [];

    // Build PER-PORTFOLIO approved ROI history, then allocate ONLY the live
    // unsettled amount (strict withdrawable + in-flight holds) onto the newest
    // CFO-approved ROI items first. This prevents old paid approvals from being
    // revived by later balances and showing as stale proxy cards.
    //
    // A partner can hold several portfolios, each with its OWN payout method and
    // its OWN ROI payout (sometimes the exact same amount). Those are distinct
    // payouts and MUST render as separate cards — so we key by
    // `${partnerId}-${portfolioId}` (one card per portfolio), NOT per partner.
    const opsByCard: Record<string, { partnerId: string; portfolioId: string; rows: Array<{ amount: number; createdAt: string; op: PwoEntry }> }> = {};
    // Partners whose ROI lands in the AGENT's wallet rather than their own.
    // This covers BOTH managed-proxy partners and LEGACY custody approvals
    // (target_wallet_user_id === agent). For these the partner's own strict
    // withdrawable is always 0, so clamping the card to it silently hides
    // every legitimately-owed legacy partner (the bug Kabahuma reported where
    // today's freshly-approved partners never appeared). The agent-wallet
    // limit is still enforced at withdrawal time by the strict ledger gate.
    const agentWalletFundedPartners = new Set<string>();
    approvedOps.forEach((op) => {
      if (!op.source_id) return;
      const portfolio = portfolioMap[op.source_id];
      if (!portfolio) return;
      const partnerId = portfolio.investor_id;
      // Subtract any partial settlement so the residual owed stays correct.
      const settled = settledByApproval[op.id] || 0;
      const amount = Math.max(0, (Number(op.amount) || 0) - settled);
      if (!partnerId || partnerId === user.id || amount <= 0) return;
      if (op.target_wallet_user_id === user.id) agentWalletFundedPartners.add(partnerId);
      const cardKey = makeCardKey(partnerId, op.source_id);
      if (!opsByCard[cardKey]) {
        opsByCard[cardKey] = { partnerId, portfolioId: op.source_id, rows: [] };
      }
      opsByCard[cardKey].rows.push({ amount, createdAt: op.created_at, op });
    });

    // NOTE: We intentionally do NOT subtract `completedWithdrawals` from the
    // approved total here. `proxy_payout_settlements` is the sole source of
    // truth for "this approval is closed" and `loadProxyFunds` already drops
    // any approval whose id appears in that table (see the settlement filter
    // above). Subtracting completed withdrawal_requests on top of that
    // double-counts unrelated legacy deliveries against an open approval —
    // e.g. a settled 806,400 legacy payout was eating into an unrelated
    // 7,180,000 Custody-v2 approval, showing 6,373,600 instead of 7,180,000.
    // The `liveOpen` clamp below (strict withdrawable + in-flight) is the
    // live ceiling that keeps the card honest.

    const groupMap: Record<string, {
      partnerId: string;
      portfolioId: string | null;
      totalAmount: number;
      availableAmount: number;
      inFlightAmount: number;
      latestAt: string;
    }> = {};

    Object.entries(opsByCard).forEach(([cardKey, { partnerId, portfolioId, rows }]) => {
      // In-flight for THIS card: a routed hold scoped to this exact portfolio,
      // PLUS any unrouted (legacy) partner-wide hold that can't be pinned to a
      // portfolio. Once a withdrawal is submitted for this card it leaves the
      // actionable queue immediately, but a sibling portfolio's card stays.
      const cardInFlight =
        (activeWithdrawalsByCard[cardKey] || 0) + (activeWithdrawalsByPartner[partnerId] || 0);
      if (cardInFlight > 50) return;
      // A payout card represents the CURRENT approved cycle, not accumulated
      // missed cycles. Keep older unsettled approvals in the audit/history,
      // but do not add them onto the newest cycle amount shown for action.
      const newestRows = rows
        .slice()
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 1);
      const totalApproved = newestRows.reduce((sum, row) => sum + row.amount, 0);
      const totalInFlight = cardInFlight;
      const historicalOpen = Math.max(0, totalApproved);
      // Managed partners → ROI lives in the AGENT's wallet, so the partner's
      // own strict withdrawable is always 0. The amount the partner is OWED is
      // the approved ROI itself, so visibility must follow the approved
      // (historical-open) amount — NOT the agent's current wallet balance.
      // Clamping managed cards to a shared agent-wallet budget silently hid
      // every partner once the owed total exceeded what the agent currently
      // holds (the bug: dozens of CFO/COO-approved partners never appeared).
      // The agent-wallet limit is a real constraint, but it is enforced at
      // withdrawal time by the strict ledger gate / approve-withdrawal — never
      // by dropping a partner the CFO has already approved.
      // Non-managed (Custody v2) → keep the existing partner-wallet clamp.
      const ceilingSource = managedPartnerIds.has(partnerId)
        ? historicalOpen
        : agentWalletFundedPartners.has(partnerId)
          ? historicalOpen
          : (strictWithdrawableByPartner[partnerId] ?? historicalOpen);
      const liveOpen = Math.max(
        0,
        Math.min(historicalOpen, ceilingSource + totalInFlight),
      );
      if (liveOpen <= 50) return;

      let remainingOpen = liveOpen;
      let remainingInFlight = Math.min(totalInFlight, liveOpen);
      // One card per PORTFOLIO. The withdrawal stamps this portfolio's id into
      // the request reason ("Route: portfolio <id>") so the in-flight hold and
      // the backend FIFO settlement both scope to THIS portfolio only — paying
      // one portfolio never clears (or revives) a sibling portfolio's card.
      let total = 0;
      let avail = 0;
      let inflight = 0;
      let latestAt = '';
      newestRows
        .forEach((row) => {
          if (remainingOpen <= 50) return;
          const allocated = Math.min(row.amount, remainingOpen);
          const inFlightAllocated = Math.min(allocated, remainingInFlight);
          const availableAllocated = allocated - inFlightAllocated;
          remainingOpen -= allocated;
          remainingInFlight -= inFlightAllocated;
          total += allocated;
          avail += availableAllocated;
          inflight += inFlightAllocated;
          if (row.createdAt && row.createdAt > latestAt) latestAt = row.createdAt;
        });
      if (total <= 0) return;
      groupMap[cardKey] = {
        partnerId,
        portfolioId,
        totalAmount: total,
        availableAmount: avail,
        inFlightAmount: inflight,
        latestAt,
      };
    });

    return Object.entries(groupMap)
      .filter(([, g]) => g.totalAmount > 0)
      .map(([, group]) => {
        const pInfo = group.portfolioId ? portfolioMap[group.portfolioId] : null;
        // Resolve the partner name through every signal we have so cards never
        // fall back to "Unknown Partner" when a real name exists somewhere:
        //   1. the partner's profile full_name
        //   2. partner_name stamped on the CFO approval metadata
        //   3. the portfolio's account / bank account name (payout identity)
        const partnerName = (profiles[group.partnerId]?.full_name || '').trim()
          || (approvedOps.find(op => {
            const m = op.metadata || {};
            return m.initiated_by === group.partnerId || op.linked_party === group.partnerId;
          })?.metadata?.partner_name as string | undefined)?.trim()
          || (pInfo?.account_name || '').trim()
          || (pInfo?.bank_account_name || '').trim()
          || 'Unknown Partner';

        return {
          partnerId: group.partnerId,
          partnerName,
          partnerPhone: profiles[group.partnerId]?.phone || '',
          portfolioId: group.portfolioId,
          portfolioCode: pInfo?.portfolio_code || null,
          accountName: pInfo?.account_name || null,
          totalReturns: Math.round(group.totalAmount),
          totalWithdrawn: 0,
          available: Math.round(group.availableAmount),
          inFlightAmount: Math.round(group.inFlightAmount),
          latestAt: group.latestAt,
        };
      })
      // Auto-hide cards with negligible balance (rounding dust) and apply
      // agent-side dismissal: once Caro dismisses a card it stays hidden
      // permanently. New ROI accrual no longer un-hides it — she must
      // explicitly Restore it from the "Show N hidden cards" sheet. This is
      // intentional: dismissals carry a written reason ("ALREADY PAID AND
      // EXPIRED" etc.) that should not be silently overridden by a tiny
      // ledger accrual.
      .filter((partner) => {
        // Keep zero-balance cards that are zero ONLY because of an in-flight
        // withdrawal — they need to remain reachable via the In flight pill so
        // Caro can cancel a mistaken withdrawal.
        if (partner.available <= 50 && partner.inFlightAmount <= 50) return false;
        const dKey = `${partner.partnerId}-${partner.portfolioId || 'none'}`;
        const d = dismissalMap[dKey];
        if (d) return false;
        return true;
      })
      .sort((a, b) => {
        // Newest CFO-approved partners first — today's approvals rise to the
        // top of the queue, then fall back to amount and name for ties.
        if (a.latestAt !== b.latestAt) return a.latestAt > b.latestAt ? -1 : 1;
        if (b.available !== a.available) return b.available - a.available;
        if (b.totalReturns !== a.totalReturns) return b.totalReturns - a.totalReturns;
        return a.partnerName.localeCompare(b.partnerName);
      });
  }, [approvedOps, completedWithdrawals, activeWithdrawalsByPartner, activeWithdrawalsByCard, strictWithdrawableByPartner, agentStrictWithdrawable, managedPartnerIds, settledByApproval, profiles, portfolioMap, dismissalMap, user?.id]);

  // Share a branded WhatsApp payout card for a single partner so the proxy
  // agent can confirm name / mobile-money number / amount with the partner.
  const [sharingCardId, setSharingCardId] = useState<string | null>(null);
  const handleShareCard = async (partner: PartnerBalance) => {
    if (sharingCardId) return;
    setSharingCardId(partner.partnerId);
    try {
      const pInfo = partner.portfolioId ? portfolioMap[partner.portfolioId] : null;
      let cardData: PayoutCardData = {
        partnerName: partner.partnerName,
        portfolioName: partner.accountName || partner.portfolioCode || undefined,
        payoutDate: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
        amount: partner.available,
        reference: (partner.portfolioId || partner.partnerId).slice(0, 8).toUpperCase(),
      };
      if (pInfo?.payment_method === 'mobile_money') {
        cardData = {
          ...cardData, mode: 'mobile_money', provider: pInfo.mobile_network || 'MoMo',
          momoName: pInfo.bank_account_name || partner.partnerName,
          momoNumber: pInfo.mobile_money_number || '',
        };
      } else if (pInfo?.payment_method === 'bank_transfer') {
        cardData = {
          ...cardData, mode: 'bank_transfer', bankName: pInfo.bank_name,
          bankAccountName: pInfo.bank_account_name || partner.partnerName, bankAccountNumber: pInfo.account_number,
        };
      } else if (pInfo?.payment_method === 'cash') {
        cardData = { ...cardData, mode: 'cash' };
      } else {
        const { data: saved } = await supabase
          .from('saved_payout_methods' as never)
          .select('*')
          .eq('user_id', partner.partnerId)
          .order('is_default', { ascending: false })
          .order('last_used_at', { ascending: false, nullsFirst: false })
          .limit(1);
        const s: any = (saved ?? [])[0];
        if (s?.payout_mode === 'mobile_money') {
          cardData = { ...cardData, mode: 'mobile_money', provider: s.momo_provider, momoName: s.momo_name || partner.partnerName, momoNumber: s.momo_number };
        } else if (s?.payout_mode === 'bank_transfer') {
          cardData = { ...cardData, mode: 'bank_transfer', bankName: s.bank_name, bankAccountName: s.bank_account_name || partner.partnerName, bankAccountNumber: s.bank_account_number };
        } else {
          cardData = { ...cardData, mode: 'mobile_money', momoName: partner.partnerName };
        }
      }
      const res = await sharePayoutCardViaWhatsApp(cardData);
      if (res.method === 'downloaded') {
        toast.success('Payout card ready', { description: 'Image downloaded — attach it in the WhatsApp chat that just opened.' });
      }
    } catch (err: any) {
      console.error('Share payout card error:', err);
      toast.error('Could not create card', { description: err?.message || 'Please try again.' });
    } finally {
      setSharingCardId(null);
    }
  };

  const handleWithdraw = async (partner: PartnerBalance) => {
    setSelectedPartnerId(partner.partnerId);
    setSelectedPortfolioId(partner.portfolioId);
    setPrefillAmount(partner.available);

    const portfolioLabel = partner.portfolioCode
      ? ` (Portfolio: ${partner.accountName || partner.portfolioCode})`
      : '';
    // Stamp the exact portfolio id as a machine-readable route token so the
    // in-flight hold AND the backend FIFO settlement scope to THIS portfolio
    // only — paying one portfolio never clears a sibling portfolio's card.
    const routeToken = partner.portfolioId ? ` | Route: portfolio ${partner.portfolioId}` : '';
    setPrefillReason(`Proxy payout delivery for ${partner.partnerName}${portfolioLabel}${routeToken}`);

    // Auto-populate payout destination so the agent never re-keys partner
    // MoMo / bank details on a proxy withdrawal. Resolution order:
    //   1. The portfolio's saved payment route (set by Partner Ops).
    //   2. The partner's `saved_payout_methods` (their default, then most
    //      recently added) — same source the partner sees when withdrawing
    //      for themselves.
    //   3. The partner's `profiles.mobile_money_number` as a last resort.
    // If none of those exist, prefillPayout stays null and the form shows
    // empty fields for manual entry (audited).
    const pInfo = partner.portfolioId ? portfolioMap[partner.portfolioId] : null;
    let resolved: any = null;
    let sourceLabel: string | undefined;
    if (pInfo?.payment_method === 'mobile_money') {
      resolved = {
        payoutMode: pInfo.mobile_network === 'Airtel' ? 'airtel' : 'mtn',
        momoNumber: pInfo.mobile_money_number || '',
        momoName: pInfo.account_name || partner.partnerName || '',
      };
      sourceLabel = `the payment details saved on portfolio ${partner.portfolioCode || pInfo.portfolio_code || ''}`.trim();
    } else if (pInfo?.payment_method === 'bank_transfer') {
      resolved = {
        payoutMode: 'bank',
        bankName: pInfo.bank_name || '',
        bankAccountName: pInfo.bank_account_name || partner.partnerName || '',
        bankAccountNumber: pInfo.account_number || '',
      };
      sourceLabel = `the payment details saved on portfolio ${partner.portfolioCode || pInfo.portfolio_code || ''}`.trim();
    } else if (pInfo?.payment_method === 'cash') {
      resolved = { payoutMode: 'cash' };
      sourceLabel = `the payment details saved on portfolio ${partner.portfolioCode || pInfo.portfolio_code || ''}`.trim();
    }

    if (!resolved) {
      try {
        const { data: saved } = await supabase
          .from('saved_payout_methods' as never)
          .select('*')
          .eq('user_id', partner.partnerId)
          .order('is_default', { ascending: false })
          .order('last_used_at', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .limit(1);
        const s: any = (saved ?? [])[0];
        if (s?.payout_mode === 'mobile_money') {
          resolved = {
            payoutMode: s.momo_provider === 'Airtel' ? 'airtel' : 'mtn',
            momoNumber: s.momo_number || '',
            momoName: s.momo_name || partner.partnerName || '',
          };
          sourceLabel = "the partner's saved payout method";
        } else if (s?.payout_mode === 'bank_transfer') {
          resolved = {
            payoutMode: 'bank',
            bankName: s.bank_name || '',
            bankAccountName: s.bank_account_name || partner.partnerName || '',
            bankAccountNumber: s.bank_account_number || '',
          };
          sourceLabel = "the partner's saved payout method";
        } else if (s?.payout_mode === 'cash') {
          resolved = { payoutMode: 'cash' };
          sourceLabel = "the partner's saved payout method";
        }
      } catch { /* non-fatal: fall through to profile lookup */ }
    }

    if (!resolved) {
      try {
        const { data: prof } = await supabase
          .from('profiles')
          .select('mobile_money_number, mobile_money_provider, full_name')
          .eq('id', partner.partnerId)
          .maybeSingle();
        if (prof?.mobile_money_number) {
          const prov = (prof.mobile_money_provider || '').toLowerCase();
          resolved = {
            payoutMode: prov === 'airtel' ? 'airtel' : 'mtn',
            momoNumber: prof.mobile_money_number,
            momoName: prof.full_name || partner.partnerName || '',
          };
          sourceLabel = "the partner's registered mobile money number";
        }
      } catch { /* non-fatal */ }
    }

    setPrefillPayout(resolved);
    setPayoutSourceLabel(sourceLabel);

    // AIM: a portfolio payout MUST use the portfolio's own payment details.
    // If the portfolio carries none and no fallback exists, stop here rather
    // than letting the agent type a destination by hand.
    if (!resolved) {
      toast.error('No payment details on file for this partner', {
        description: 'Ask Partner Ops to save the MoMo or bank details on the portfolio before requesting this payout.',
        duration: 9000,
      });
      return;
    }

    setWithdrawOpen(true);

    try {
      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'proxy_partner_withdrawal',
        table_name: 'withdrawal_requests',
        metadata: {
          partner_id: partner.partnerId,
          partner_name: partner.partnerName,
          portfolio_id: partner.portfolioId,
          portfolio_code: partner.portfolioCode,
          account_name: partner.accountName,
          amount: partner.available,
          agent_id: user?.id,
        },
      });
    } catch (err) {
      console.error('Audit log error:', err);
    }
  };

  const handleWithdrawSuccess = () => {
    // Optimistic lock: instantly disable Withdraw on THIS portfolio's card so
    // the agent can't double-submit before realtime catches up. Scoped to the
    // card (partner+portfolio) so a sibling portfolio stays actionable.
    const lockedCardKey = makeCardKey(selectedPartnerId, selectedPortfolioId);
    if (selectedPartnerId) {
      setSubmittingCardKeys((prev) => {
        const next = new Set(prev);
        next.add(lockedCardKey);
        return next;
      });
    }
    // Refresh immediately for snappy UX, then again shortly after to catch
    // any trigger-side updates (audit log, status forwarding, etc.) that
    // commit a beat after the insert.
    // IMPORTANT: refresh WITHOUT the spinner. `loadProxyFunds(true)` flips
    // `loading`, which makes this component early-return a skeleton — that
    // unmounts <WithdrawRequestDialog/> and destroys its "Request Submitted!"
    // confirmation screen (plus its idempotency ref) mid-success.
    loadProxyFunds(false);
    setTimeout(() => loadProxyFunds(false), 800);
    setTimeout(() => loadProxyFunds(false), 2500);
    // Release the optimistic lock after a generous window — by then DB
    // realtime + settlement insert has resolved the card.
    setTimeout(() => {
      setSubmittingCardKeys((prev) => {
        const next = new Set(prev);
        next.delete(lockedCardKey);
        return next;
      });
    }, 5000);
  };

  const handleCancelRequest = (partner: PartnerBalance) => {
    const key = getStatusKey(partner);
    const withdrawalId = partnerWithdrawalIds[key];
    if (!withdrawalId) return;
    setCancelTarget({ key, withdrawalId, partnerName: partner.partnerName, partnerId: partner.partnerId });
    setCancelReason('');
    setCancelConfirmOpen(true);
  };

  const confirmCancel = async () => {
    if (!cancelTarget || !user?.id || cancelReason.trim().length < 10) return;
    setCancellingId(cancelTarget.withdrawalId);
    try {
      // Backend-only flow — edge function validates the proxy assignment,
      // updates withdrawal status, writes a balanced reversal ledger pair,
      // posts audit log, and notifies COO/Ops. The wallet UI refreshes via
      // the realtime `wallets` subscription. The client must NOT touch
      // wallet, general_ledger, or perform any balance math.
      const { data, error } = await supabase.functions.invoke('cancel-proxy-withdrawal', {
        body: {
          withdrawal_id: cancelTarget.withdrawalId,
          reason: cancelReason.trim(),
        },
      });
      if (error) throw new Error(error.message || 'Cancellation failed');
      if (data?.error) throw new Error(data.error);

      const restored = Number(data?.amount || 0);
      toast.success('Withdrawal cancelled', {
        description: `The ROI withdrawal for ${cancelTarget.partnerName} has been cancelled${restored ? ` and ${formatAmount(restored)} restored` : ''}. COO & Partner Ops have been notified.`,
      });
      loadProxyFunds();
    } catch (err: any) {
      toast.error('Failed to cancel', { description: err.message });
    } finally {
      setCancellingId(null);
      setCancelConfirmOpen(false);
      setCancelTarget(null);
      setCancelReason('');
    }
  };

  const getStatusKey = (partner: PartnerBalance) => {
    // Prefer the card-scoped (routed) status; fall back to a partner-wide
    // (legacy/unrouted) status only when no per-portfolio status exists.
    const cardKey = makeCardKey(partner.partnerId, partner.portfolioId);
    if (partnerWithdrawalStatus[cardKey]) return cardKey;
    return partner.partnerId;
  };

  // Card key used for selection / dismissal storage
  const getCardKey = (partner: PartnerBalance) =>
    makeCardKey(partner.partnerId, partner.portfolioId);

  const toggleSelect = (partner: PartnerBalance) => {
    const key = getCardKey(partner);
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const openClearDialog = (partners: PartnerBalance[]) => {
    if (partners.length === 0) return;
    setClearTargets(partners.map(p => ({
      partnerId: p.partnerId,
      portfolioId: p.portfolioId,
      amount: p.available,
      partnerName: p.partnerName,
    })));
    setClearReason('');
    setClearConfirmOpen(true);
  };

  const confirmClear = async () => {
    if (!user?.id || clearTargets.length === 0) return;
    setClearing(true);
    try {
      const rows = clearTargets.map(t => ({
        agent_id: user.id,
        partner_id: t.partnerId,
        portfolio_id: t.portfolioId,
        snapshot_amount: t.amount,
        reason: clearReason.trim() || null,
      }));
      const { error } = await supabase
        .from('agent_proxy_card_dismissals')
        .upsert(rows, { onConflict: 'agent_id,partner_id,portfolio_id' });
      if (error) throw error;

      // Audit + system event (fire-and-forget)
      try {
        await supabase.from('audit_logs').insert({
          user_id: user.id,
          action_type: 'agent_proxy_card_dismissed',
          table_name: 'agent_proxy_card_dismissals',
          metadata: {
            count: clearTargets.length,
            partners: clearTargets.map(t => t.partnerName),
            reason: clearReason.trim() || 'No reason provided by agent.',
          },
        });
      } catch (e) {
        console.warn('audit log failed', e);
      }

      toast.success(`Cleared ${clearTargets.length} card${clearTargets.length === 1 ? '' : 's'}`, {
        description: 'They will reappear if new returns accrue for the partner.',
      });
      setSelectedKeys(new Set());
      setSelectMode(false);
      setClearConfirmOpen(false);
      setClearTargets([]);
      setClearReason('');
      loadProxyFunds();
    } catch (err: any) {
      toast.error('Failed to clear', { description: err.message });
    } finally {
      setClearing(false);
    }
  };

  const restoreDismissal = async (partnerId: string, portfolioId: string | null) => {
    if (!user?.id) return;
    const restoreKey = `${partnerId}-${portfolioId || 'none'}`;
    setRestoringKey(restoreKey);
    try {
      let q = supabase
        .from('agent_proxy_card_dismissals')
        .delete()
        .eq('agent_id', user.id)
        .eq('partner_id', partnerId);
      q = portfolioId ? q.eq('portfolio_id', portfolioId) : q.is('portfolio_id', null);
      const { error } = await q;
      if (error) throw error;
      toast.success('Card restored');
      loadProxyFunds();
    } catch (err: any) {
      toast.error('Failed to restore', { description: err.message });
    } finally {
      setRestoringKey(null);
    }
  };

  const openRevertDialog = (partner: PartnerBalance) => {
    setRevertTarget(partner);
    setRevertReason('');
    setRevertOpen(true);
  };

  const confirmRevert = async () => {
    if (!user?.id || !revertTarget) return;
    if (revertReason.trim().length < 10) return;
    setReverting(true);
    try {
      // Collect the CFO-approved ROI approvals backing THIS card
      // (partner + portfolio) that are not yet settled by a delivered payout.
      const approvalIds = approvedOps
        .filter((op) => {
          if (op.source_id !== revertTarget.portfolioId) return false;
          const investor = op.source_id ? portfolioMap[op.source_id]?.investor_id : null;
          if (investor !== revertTarget.partnerId) return false;
          const settled = settledByApproval[op.id] || 0;
          return settled <= 0;
        })
        .map((op) => op.id);

      if (approvalIds.length === 0) {
        throw new Error('No reversible ROI approvals found for this partner.');
      }

      const { data, error } = await supabase.functions.invoke('reverse-proxy-roi-approval', {
        body: { approval_ids: approvalIds, reason: revertReason.trim() },
      });
      if (error) throw new Error(error.message || 'Reversal failed');
      if (data?.error) throw new Error(data.error);

      const count = Number(data?.reversed_count || 0);
      if (count === 0) {
        const why = (data?.skipped || []).map((s: any) => s.reason).join('; ');
        throw new Error(why || 'Nothing was reversed.');
      }

      toast.success('Sent back to nearing payout', {
        description: `${revertTarget.partnerName}'s ROI approval was reversed and the partner returned to the COO Nearing Payout list. Reason recorded for audit.`,
      });
      setRevertOpen(false);
      setRevertTarget(null);
      setRevertReason('');
      loadProxyFunds();
    } catch (err: any) {
      toast.error('Failed to revert', { description: err.message });
    } finally {
      setReverting(false);
    }
  };

  const getStatusBadge = (partner: PartnerBalance) => {
    const key = getStatusKey(partner);
    const status = partnerWithdrawalStatus[key];
    if (!status) return null;

    if (status === 'pending' || status === 'requested') {
      return (
        <Badge variant="warning" size="sm" className="gap-1">
          <Clock className="h-3 w-3" />
          Pending
        </Badge>
      );
    }
    if (status === 'manager_approved' || status === 'cfo_approved' || status === 'approved' || status === 'fin_ops_approved' || status === 'processing') {
      return (
        <Badge variant="success" size="sm" className="gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Approved
        </Badge>
      );
    }
    return null;
  };

  if (loading && !withdrawOpen) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (partnerBalances.length === 0 && !withdrawOpen) {
    return (
      <div className="space-y-4">
        <Card className="border-border/50">
          <CardContent className="py-10 text-center text-muted-foreground">
            <Users className="h-10 w-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm font-medium">No proxy partner payouts ready</p>
            <p className="text-xs mt-1">CFO-approved ROI returns for your proxy partners will appear here</p>
          </CardContent>
        </Card>
        <ProxyRecentPayouts />
      </div>
    );
  }

  // Classify each partner card so the agent can see WHY a balance is sitting here.
  // Priority: active in-flight > last terminal (reject/expire/cancel) > fresh (no prior request).
  const classify = (partner: PartnerBalance):
    | { kind: 'active' }
    | { kind: 'inflight' }
    | { kind: 'reattempt'; terminal: LastTerminal }
    | { kind: 'fresh' } => {
    const key = getStatusKey(partner);
    if (partnerWithdrawalStatus[key]) return { kind: 'active' };
    // Card has zero available because Caro already initiated — surface it
    // under the In flight pill but hide it from the default All view.
    if (partner.inFlightAmount > 50 && partner.available <= 50) {
      return { kind: 'inflight' };
    }
    const t = lastTerminalByPartner[partner.partnerId];
    if (t) return { kind: 'reattempt', terminal: t };
    return { kind: 'fresh' };
  };

  const inFlightCount = partnerBalances.filter((p) => {
    const kind = classify(p).kind;
    return kind === 'inflight' || kind === 'active';
  }).length;
  const reattemptCount = partnerBalances.filter((p) => classify(p).kind === 'reattempt').length;
  const freshCount = partnerBalances.filter((p) => classify(p).kind === 'fresh').length;

  const downloadCsv = (rows: PartnerBalance[]) => {
    const headers = ['Partner Name', 'Phone', 'Account Name', 'Portfolio Code', 'Returns Due', 'Delivered', 'To Withdraw'];
    const escape = (v: any) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    rows.forEach((p) => {
      lines.push([
        p.partnerName,
        p.partnerPhone,
        p.accountName || '',
        p.portfolioCode || '',
        p.totalReturns,
        p.totalWithdrawn,
        p.available,
      ].map(escape).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `proxy-partner-funds-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${rows.length} partner${rows.length === 1 ? '' : 's'}`);
  };

  const visibleBalances = partnerBalances.filter((p) => {
    const c = classify(p);
    // Optimistic removal: the instant Caro submits a withdrawal for THIS
    // portfolio card (before realtime / settlement catches up) drop it from the
    // default All view. Scoped to the card so a sibling portfolio stays.
    if (filterMode === 'all' && submittingCardKeys.has(getCardKey(p))) return false;
    // Default All view hides in-flight/active cards — once Caro initiates a
    // withdrawal the partner is treated as paid and the card disappears.
    if (filterMode === 'all') return c.kind !== 'inflight' && c.kind !== 'active';
    if (filterMode === 'inflight') return c.kind === 'inflight' || c.kind === 'active';
    if (filterMode === 'reattempt') return c.kind === 'reattempt';
    if (filterMode === 'fresh') return c.kind === 'fresh';
    return true;
  });

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground px-1">
        Shows every unsettled return the CFO has signed off for delivery to your proxy partner. Balances shown are
        <span className="font-medium text-foreground"> withdrawable now</span>.
      </p>

      <div className="flex flex-wrap gap-1.5 px-1">
        <Button
          size="sm"
          variant={filterMode === 'all' ? 'default' : 'outline'}
          className="h-7 text-xs gap-1"
          onClick={() => setFilterMode('all')}
        >
          All ({partnerBalances.length - inFlightCount})
        </Button>
        <Button
          size="sm"
          variant={filterMode === 'inflight' ? 'default' : 'outline'}
          className="h-7 text-xs gap-1"
          onClick={() => setFilterMode('inflight')}
          disabled={inFlightCount === 0}
        >
          <Hourglass className="h-3 w-3" />
          In flight ({inFlightCount})
        </Button>
        <Button
          size="sm"
          variant={filterMode === 'reattempt' ? 'default' : 'outline'}
          className="h-7 text-xs gap-1"
          onClick={() => setFilterMode('reattempt')}
          disabled={reattemptCount === 0}
        >
          <AlertCircle className="h-3 w-3" />
          Re-request needed ({reattemptCount})
        </Button>
        <Button
          size="sm"
          variant={filterMode === 'fresh' ? 'default' : 'outline'}
          className="h-7 text-xs gap-1"
          onClick={() => setFilterMode('fresh')}
          disabled={freshCount === 0}
        >
          <Hourglass className="h-3 w-3" />
          New ROI ({freshCount})
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1 ml-auto"
          onClick={() => downloadCsv(visibleBalances)}
          disabled={visibleBalances.length === 0}
        >
          <Download className="h-3 w-3" />
          Download
        </Button>
        <Button
          size="sm"
          variant={selectMode ? 'default' : 'outline'}
          className="h-7 text-xs gap-1"
          onClick={() => {
            setSelectMode(s => !s);
            setSelectedKeys(new Set());
          }}
          disabled={visibleBalances.length === 0}
        >
          <CheckSquare className="h-3 w-3" />
          {selectMode ? 'Cancel select' : 'Select to clear'}
        </Button>
      </div>

      {selectMode && (
        <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-xs">
          <button
            type="button"
            className="font-medium text-primary hover:underline"
            onClick={() => {
              const allKeys = new Set(visibleBalances.map(p => getCardKey(p)));
              const allSelected = visibleBalances.every(p => selectedKeys.has(getCardKey(p)));
              setSelectedKeys(allSelected ? new Set() : allKeys);
            }}
          >
            {visibleBalances.every(p => selectedKeys.has(getCardKey(p))) && selectedKeys.size > 0
              ? 'Unselect all'
              : `Select all visible (${visibleBalances.length})`}
          </button>
          <Button
            size="sm"
            variant="destructive"
            className="h-7 text-xs gap-1"
            disabled={selectedKeys.size === 0}
            onClick={() => openClearDialog(
              visibleBalances.filter(p => selectedKeys.has(getCardKey(p)))
            )}
          >
            <Trash2 className="h-3 w-3" />
            Clear {selectedKeys.size} selected
          </Button>
        </div>
      )}

      {visibleBalances.map((partner) => {
        const statusKey = getStatusKey(partner);
        const hasPending = !!partnerWithdrawalStatus[statusKey];
        const statusBadge = getStatusBadge(partner);
        const cardKey = getCardKey(partner);
        const currentStatus = partnerWithdrawalStatus[statusKey];
        const canCancel = currentStatus ? ACTIVE_PROXY_WITHDRAWAL_STATUSES.includes(currentStatus as typeof ACTIVE_PROXY_WITHDRAWAL_STATUSES[number]) : false;
        const classification = classify(partner);
        const isSubmitting = submittingCardKeys.has(cardKey);

        // Registered payout destination for this partner (clear, labelled).
        const pInfo = partner.portfolioId ? portfolioMap[partner.portfolioId] : null;
        const destLabel =
          pInfo?.payment_method === 'bank_transfer' ? 'Account name'
          : pInfo?.payment_method === 'cash' ? 'Payout'
          : 'MoMo name';
        const destName =
          pInfo?.payment_method === 'bank_transfer'
            ? (pInfo.bank_account_name || partner.partnerName)
            : pInfo?.payment_method === 'cash'
            ? 'Cash pickup'
            : (pInfo?.bank_account_name || partner.partnerName || 'Name not set');
        const destExtra =
          pInfo?.payment_method === 'bank_transfer'
            ? [pInfo.bank_name, pInfo.account_number].filter(Boolean).join(' · ')
            : pInfo?.payment_method === 'cash'
            ? ''
            : [pInfo?.mobile_network, pInfo?.mobile_money_number].filter(Boolean).join(' · ');

        return (
          <Card
            key={cardKey}
            className={`border-border/50 shadow-sm ${selectMode && selectedKeys.has(cardKey) ? 'ring-2 ring-primary' : ''}`}
          >
            <CardContent className="p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-2">
                  {selectMode && (
                    <Checkbox
                      checked={selectedKeys.has(cardKey)}
                      onCheckedChange={() => toggleSelect(partner)}
                      className="mt-0.5"
                    />
                  )}
                  <div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <p className="font-semibold text-sm text-foreground">{partner.partnerName}</p>
                    {weekendPartnerIds.has(partner.partnerId) && (
                      <Badge
                        variant="outline"
                        size="sm"
                        className="border-amber-400/60 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300 gap-1"
                        title="Proxy assignment created on a weekend"
                      >
                        Weekend
                      </Badge>
                    )}
                  </div>
                  {(partner.portfolioCode || partner.accountName) && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      📁 {partner.accountName || partner.portfolioCode}
                      {partner.portfolioCode && partner.accountName ? (
                        <span className="text-[10px] text-muted-foreground/60 ml-1">({partner.portfolioCode})</span>
                      ) : null}
                    </p>
                  )}
                  {partner.partnerPhone && (
                    <p className="text-xs text-muted-foreground">{partner.partnerPhone}</p>
                  )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {statusBadge}
                  {!statusBadge && classification.kind === 'reattempt' && (
                    <Badge variant="destructive" size="sm" className="gap-1">
                      <AlertCircle className="h-3 w-3" />
                      {classification.terminal.status === 'rejected'
                        ? 'Last attempt rejected'
                        : classification.terminal.status === 'expired'
                        ? 'Last attempt expired'
                        : 'Last attempt cancelled'}
                    </Badge>
                  )}
                  {!statusBadge && classification.kind === 'fresh' && (
                    <Badge variant="outline" size="sm" className="gap-1 border-primary/40 text-primary">
                      <Hourglass className="h-3 w-3" />
                      Awaiting request
                    </Badge>
                  )}
                  <Badge variant="outline" className="text-xs gap-1">
                    <Users className="h-3 w-3" />
                    Proxy
                  </Badge>
                  {!selectMode && !hasPending && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      title="Clear this card"
                      onClick={() => openClearDialog([partner])}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-success/10 p-2">
                  <p className="text-[10px] text-muted-foreground">Returns Due</p>
                  <p className="text-xs font-bold text-success tabular-nums">{formatAmount(partner.totalReturns)}</p>
                </div>
                <div className="rounded-lg bg-muted/50 p-2">
                  <p className="text-[10px] text-muted-foreground">Delivered</p>
                  <p className="text-xs font-bold tabular-nums">{formatAmount(partner.totalWithdrawn)}</p>
                </div>
                <div className="rounded-lg bg-primary/10 p-2">
                  <p className="text-[10px] text-muted-foreground">To Withdraw</p>
                  <p className="text-xs font-bold text-primary tabular-nums">{formatAmount(partner.available)}</p>
                </div>
              </div>

              <div className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{destLabel}</p>
                <p className="text-xs font-semibold text-foreground">{destName}</p>
                {destExtra && <p className="text-[10px] text-muted-foreground">{destExtra}</p>}
              </div>

              {!statusBadge && classification.kind === 'reattempt' && (
                <div className="flex items-start gap-1.5 rounded-md bg-destructive/5 border border-destructive/20 px-2 py-1.5">
                  <Info className="h-3 w-3 text-destructive shrink-0 mt-0.5" />
                  <p className="text-[11px] leading-snug text-destructive">
                    Last withdrawal {classification.terminal.status} on{' '}
                    {new Date(classification.terminal.at).toLocaleDateString()}.
                    {classification.terminal.reason ? (
                      <> Reason: <span className="font-medium">{classification.terminal.reason}</span>.</>
                    ) : (
                      <> No reason recorded.</>
                    )}{' '}
                    Funds returned — re-request below.
                  </p>
                </div>
              )}
              {!statusBadge && classification.kind === 'fresh' && (
                <div className="flex items-start gap-1.5 rounded-md bg-primary/5 border border-primary/20 px-2 py-1.5">
                  <Info className="h-3 w-3 text-primary shrink-0 mt-0.5" />
                  <p className="text-[11px] leading-snug text-primary">
                    Returns accrued and ready. No withdrawal has been requested yet.
                  </p>
                </div>
              )}

              {(hasPending && canCancel) || isSubmitting ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1 gap-1"
                    disabled
                  >
                    {isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
                    {isSubmitting
                      ? 'Submitting…'
                      : currentStatus === 'pending' || currentStatus === 'requested'
                      ? 'Withdrawal Pending'
                      : 'Withdrawal In Progress'}
                  </Button>
                  {hasPending && canCancel && !isSubmitting && (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="gap-1"
                    disabled={cancellingId === partnerWithdrawalIds[statusKey]}
                    onClick={() => handleCancelRequest(partner)}
                  >
                    {cancellingId === partnerWithdrawalIds[statusKey] ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5" />
                    )}
                    Cancel
                  </Button>
                  )}
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1 gap-1"
                    onClick={() => handleWithdraw(partner)}
                    disabled={partner.available <= 0 || hasPending || isSubmitting}
                  >
                    <ArrowUpRight className="h-3.5 w-3.5" />
                    {hasPending ? 'Withdrawal In Progress' : `Withdraw ${formatAmount(partner.available)}`}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1 shrink-0"
                    title="Send back to nearing payout"
                    onClick={() => openRevertDialog(partner)}
                    disabled={hasPending || isSubmitting}
                  >
                    <Hourglass className="h-3.5 w-3.5" />
                    Nearing
                  </Button>
                </div>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="w-full gap-1 text-muted-foreground hover:text-primary"
                onClick={() => handleShareCard(partner)}
                disabled={sharingCardId === partner.partnerId}
              >
                {sharingCardId === partner.partnerId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Share2 className="h-3.5 w-3.5" />}
                Share payout card
              </Button>
            </CardContent>
          </Card>
        );
      })}

      <WithdrawRequestDialog
        open={withdrawOpen}
        onOpenChange={setWithdrawOpen}
        // For proxy partner withdrawals, the available balance is the
        // per-partner ROI balance (prefillAmount), NOT the agent's own
        // wallet balance. The agent's wallet may show 0 here even when
        // the partner has unwithdrawn ROI ready to disburse.
        walletBalance={prefillAmount || 0}
        onSuccess={handleWithdrawSuccess}
        prefillAmount={prefillAmount}
        prefillReason={prefillReason}
        prefillPayout={prefillPayout}
        linkedParty={selectedPartnerId}
        lockAmount
        // Destination is dictated by the portfolio's saved payment details —
        // read-only for the proxy agent, exactly like the amount.
        lockPayoutDetails
        payoutSourceLabel={payoutSourceLabel}
      />

      <AlertDialog open={cancelConfirmOpen} onOpenChange={(open) => {
        setCancelConfirmOpen(open);
        if (!open) setCancelReason('');
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Withdrawal?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  This will cancel the pending withdrawal for <strong>{cancelTarget?.partnerName}</strong> and restore the ROI funds to the available balance. COO &amp; Operations will be notified.
                </p>
                <div>
                  <Label className="text-xs font-medium">Cancellation Reason (min 10 chars) *</Label>
                  <Textarea
                    placeholder="e.g. Partner requested to delay payout until next month"
                    value={cancelReason}
                    onChange={e => setCancelReason(e.target.value)}
                    maxLength={500}
                    rows={3}
                    className="mt-1"
                  />
                  <p className="text-[10px] text-muted-foreground mt-0.5">{cancelReason.length}/500</p>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Request</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmCancel}
              disabled={cancelReason.trim().length < 10}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Yes, Cancel Withdrawal
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Hidden cards footer */}
      {dismissals.length > 0 && (
        <button
          type="button"
          onClick={() => setHiddenSheetOpen(true)}
          className="w-full text-center text-xs text-muted-foreground hover:text-foreground py-2 underline-offset-2 hover:underline"
        >
          <Eye className="inline h-3 w-3 mr-1" />
          Show {dismissals.length} hidden card{dismissals.length === 1 ? '' : 's'}
        </button>
      )}

      {/* Hidden cards sheet */}
      <Sheet open={hiddenSheetOpen} onOpenChange={setHiddenSheetOpen}>
        <SheetContent side="bottom" className="h-[70dvh] rounded-t-2xl">
          <SheetHeader>
            <SheetTitle>Hidden Partner Cards</SheetTitle>
          </SheetHeader>
          <div className="mt-3 space-y-2 overflow-y-auto pr-1">
            <p className="text-xs text-muted-foreground">
              These cards are hidden from your main list. They will reappear automatically if new returns accrue above the snapshot amount.
            </p>
            {dismissals.length === 0 && (
              <p className="text-sm text-muted-foreground py-6 text-center">No hidden cards.</p>
            )}
            {dismissals.map(d => {
              const restoreKey = `${d.partner_id}-${d.portfolio_id || 'none'}`;
              const profile = profiles[d.partner_id];
              const portfolio = d.portfolio_id ? portfolioMap[d.portfolio_id] : null;
              return (
                <div key={restoreKey} className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{profile?.full_name || portfolio?.account_name || portfolio?.bank_account_name || 'Unknown partner'}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {portfolio?.account_name || portfolio?.portfolio_code || '—'} · Snapshot {formatAmount(Number(d.snapshot_amount))}
                    </p>
                    {d.reason && (
                      <p className="text-[10px] text-muted-foreground/80 italic truncate">"{d.reason}"</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1 shrink-0"
                    disabled={restoringKey === restoreKey}
                    onClick={() => restoreDismissal(d.partner_id, d.portfolio_id)}
                  >
                    {restoringKey === restoreKey ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                    Restore
                  </Button>
                </div>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>

      {/* Clear confirmation dialog */}
      <AlertDialog open={clearConfirmOpen} onOpenChange={(open) => {
        setClearConfirmOpen(open);
        if (!open) { setClearTargets([]); setClearReason(''); }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Clear {clearTargets.length} card{clearTargets.length === 1 ? '' : 's'} from your list?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  This only hides {clearTargets.length === 1 ? 'this card' : 'these cards'} from your view. No financial records are deleted. The card will reappear if new returns accrue for the partner.
                </p>
                {clearTargets.length <= 5 && (
                  <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
                    {clearTargets.map(t => (
                      <li key={`${t.partnerId}-${t.portfolioId || 'none'}`}>
                        <span className="text-foreground font-medium">{t.partnerName}</span> — {formatAmount(t.amount)}
                      </li>
                    ))}
                  </ul>
                )}
                <div>
                  <Label className="text-xs font-medium">Reason (optional)</Label>
                  <Textarea
                    placeholder="e.g. Already paid in cash / partner contacted / awaiting partner response"
                    value={clearReason}
                    onChange={e => setClearReason(e.target.value)}
                    maxLength={300}
                    rows={2}
                    className="mt-1"
                  />
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>Keep on list</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmClear}
              disabled={clearing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Trash2 className="h-3.5 w-3.5 mr-1" />}
              Yes, clear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revert to nearing payout dialog */}
      <AlertDialog open={revertOpen} onOpenChange={(open) => {
        setRevertOpen(open);
        if (!open) { setRevertTarget(null); setRevertReason(''); }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send back to nearing payout?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  This <strong>reverses the CFO-approved ROI</strong> for{' '}
                  <strong>{revertTarget?.partnerName}</strong>: the credited funds are
                  pulled back with a balanced ledger reversal, the card leaves your
                  ready-to-withdraw queue, and the partner returns to the COO
                  Nearing Payout list. Already-delivered payouts cannot be reversed.
                  A reason is required for auditing.
                </p>
                <div>
                  <Label className="text-xs font-medium">Reason (min 10 chars) *</Label>
                  <Textarea
                    placeholder="e.g. Payout deferred to next cycle at partner's request"
                    value={revertReason}
                    onChange={e => setRevertReason(e.target.value)}
                    maxLength={500}
                    rows={3}
                    className="mt-1"
                  />
                  <p className="text-[10px] text-muted-foreground mt-0.5">{revertReason.length}/500</p>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reverting}>Keep on list</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmRevert}
              disabled={reverting || revertReason.trim().length < 10}
            >
              {reverting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Hourglass className="h-3.5 w-3.5 mr-1" />}
              Yes, send back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Recent proxy payouts (read-only history) */}
      <ProxyRecentPayouts />
    </div>
  );
}
