import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { fetchOpsWalletBuckets } from '@/hooks/ops/useOpsDataLayer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { toast } from 'sonner';
import {
  Search,
  ArrowLeft,
  RefreshCw,
  ChevronRight,
  TriangleAlert,
  Wallet,
  ArrowDownCircle,
  ArrowUpCircle,
  Phone,
  Calendar,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';

/* ─── Types ─────────────────────────────────────────────────────────────── */

interface UserSummary {
  id: string;
  full_name: string;
  phone: string;
  email: string;
  balance: number;
  walletId: string | null;
  totalIn: number;
  totalOut: number;
  entryCount: number;
}

interface LedgerEntry {
  id: string;
  date: string;
  direction: 'cash_in' | 'cash_out';
  category: string;
  description: string;
  amount: number;
  reference_id?: string | null;
  linked_party?: string | null;
  balance_after: number;
}

/* ─── Human-friendly category labels ────────────────────────────────────── */

const CATEGORY_LABELS: Record<string, { label: string; emoji: string; note: string }> = {
  referral_bonus:             { label: 'Referral Reward',        emoji: '👥', note: 'Earned for bringing a friend' },
  agent_commission:           { label: 'Commission Earned',       emoji: '💼', note: 'Earned from helping a tenant' },
  approval_bonus:             { label: 'Approval Bonus',          emoji: '✅', note: 'Bonus for approving a request' },
  subagent_commission:        { label: 'Team Commission',         emoji: '🤝', note: 'Earned from your sub-agent' },
  referral_first_transaction: { label: 'First Deal Bonus',        emoji: '🎉', note: 'Bonus when your referral first transacted' },
  welcome_bonus:              { label: 'Welcome Gift',            emoji: '🎁', note: 'One-time welcome reward' },
  deposit:                    { label: 'Money Added (Deposit)',   emoji: '📲', note: 'Sent from mobile money' },
  wallet_withdrawal:          { label: 'Money Withdrawn',         emoji: '🏧', note: 'Sent out to mobile money' },
  supporter_reward:           { label: 'Investment Return',       emoji: '📈', note: 'Return from supporting a tenant' },
  rent_repayment:             { label: 'Rent Payment Received',   emoji: '🏠', note: 'Tenant paid back rent' },
  manager_credit:             { label: 'Added by Manager',        emoji: '➕', note: 'Manager manually added funds' },
  manager_debit:              { label: 'Removed by Manager',      emoji: '➖', note: 'Manager manually removed funds' },
};

function getCategoryInfo(category: string, direction: string) {
  const meta = CATEGORY_LABELS[category];
  if (meta) return meta;
  if (direction === 'cash_out') return { label: 'Money Sent Out', emoji: '📤', note: '' };
  return { label: 'Money Received', emoji: '📥', note: '' };
}

/* ─── Quick amounts ──────────────────────────────────────────────────────── */
const QUICK_AMOUNTS = [5_000, 10_000, 50_000, 100_000, 500_000];

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════════════════════════════════ */

export function ManagerBankingLedger() {
  const [searchQuery, setSearchQuery] = useState('');
  const [users, setUsers]             = useState<UserSummary[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  const [selectedUser, setSelectedUser] = useState<UserSummary | null>(null);
  const [ledger, setLedger]            = useState<LedgerEntry[]>([]);
  const [loadingLedger, setLoadingLedger] = useState(false);
  const [showOnlyType, setShowOnlyType]  = useState<'all' | 'cash_in' | 'cash_out'>('all');


  /* ── load user list ── */
  const fetchUsers = useCallback(async (q: string) => {
    setLoadingUsers(true);
    try {
      let query = supabase.from('profiles').select('id, full_name, phone, email').order('full_name');
      if (q.trim()) {
        query = query.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`);
      }
      const { data: profiles, error } = await query.limit(60);
      if (error) throw error;
      if (!profiles?.length) { setUsers([]); return; }

      const ids = profiles.map(p => p.id);
      const [walletBuckets, ledgerRes] = await Promise.all([
        fetchOpsWalletBuckets(ids),
        supabase.from('general_ledger').select('user_id, direction, amount').in('user_id', ids),
      ]);

      // NOTE: shared ops layer doesn't expose the wallet row id (it batches via
      // v_user_wallet_strict). Callers that only need balances read that here;
      // downstream code that needs a wallet row id must fetch it separately.
      const walletMap = new Map(walletBuckets.map(w => [w.user_id, { id: null as string | null, balance: w.balance }]));
      const aggMap    = new Map<string, { totalIn: number; totalOut: number; count: number }>();
      for (const row of ledgerRes.data || []) {
        const a = aggMap.get(row.user_id) || { totalIn: 0, totalOut: 0, count: 0 };
        if (row.direction === 'cash_in') a.totalIn += row.amount; else a.totalOut += row.amount;
        a.count++;
        aggMap.set(row.user_id, a);
      }

      setUsers(profiles.map(p => {
        const w = walletMap.get(p.id);
        const a = aggMap.get(p.id) || { totalIn: 0, totalOut: 0, count: 0 };
        return { id: p.id, full_name: p.full_name, phone: p.phone, email: p.email,
                 balance: w?.balance ?? 0, walletId: w?.id ?? null,
                 totalIn: a.totalIn, totalOut: a.totalOut, entryCount: a.count };
      }));
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  useEffect(() => { fetchUsers(''); }, [fetchUsers]);
  useEffect(() => {
    const t = setTimeout(() => fetchUsers(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery, fetchUsers]);

  /* ── load ledger for one user ── */
  const fetchLedger = useCallback(async (userId: string) => {
    setLoadingLedger(true);
    try {
      const { data, error } = await supabase
        .from('general_ledger')
        .select('id, transaction_date, amount, direction, category, description, reference_id, linked_party')
        .eq('user_id', userId)
        .order('transaction_date', { ascending: false })
        .limit(200);
      if (error) throw error;

      let running = 0;
      const withBal: LedgerEntry[] = [...(data || [])].reverse().map(row => {
        if (row.direction === 'cash_in') running += row.amount; else running -= row.amount;
        return {
          id: row.id, date: row.transaction_date,
          direction: row.direction as 'cash_in' | 'cash_out',
          category: row.category,
          description: row.description || getCategoryInfo(row.category, row.direction).label,
          amount: row.amount, reference_id: row.reference_id, linked_party: row.linked_party,
          balance_after: Math.max(0, running),
        };
      });
      setLedger(withBal.reverse());
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingLedger(false);
    }
  }, []);

  const openUser = (u: UserSummary) => { setSelectedUser(u); setShowOnlyType('all'); fetchLedger(u.id); };
  const goBack   = () => { setSelectedUser(null); setLedger([]); fetchUsers(searchQuery); };

  const filtered = showOnlyType === 'all' ? ledger : ledger.filter(e => e.direction === showOnlyType);
  const totalIn  = ledger.filter(e => e.direction === 'cash_in').reduce((s,e) => s+e.amount, 0);
  const totalOut = ledger.filter(e => e.direction === 'cash_out').reduce((s,e) => s+e.amount, 0);

  const grouped = filtered.reduce((acc, e) => {
    const k = format(new Date(e.date), 'yyyy-MM-dd');
    if (!acc[k]) acc[k] = [];
    acc[k].push(e);
    return acc;
  }, {} as Record<string, LedgerEntry[]>);

  /* ═══════════════════════════════════════════════════════════════════
     USER LIST
  ═══════════════════════════════════════════════════════════════════ */
  if (!selectedUser) {
    return (
      <div className="space-y-4 pb-8">

        {/* Title */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold flex items-center gap-2">
              <Wallet className="h-6 w-6 text-primary" />
              Wallet Manager
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Tap any person to see their money history and make changes
            </p>
          </div>
          <Button variant="outline" size="icon" className="h-11 w-11" onClick={() => fetchUsers(searchQuery)}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input
            placeholder="Search by name or phone number…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-12 h-12 text-base"
          />
        </div>

        {/* Summary strip */}
        <div className="grid grid-cols-2 gap-3">
          <Card className="bg-success/5 border-success/20">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground font-medium">Total Money Held</p>
              <p className="text-lg font-bold text-success mt-0.5">
                {formatUGX(users.reduce((s,u) => s+u.balance, 0))}
              </p>
              <p className="text-[11px] text-muted-foreground">across all wallets</p>
            </CardContent>
          </Card>
          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground font-medium">People Listed</p>
              <p className="text-2xl font-bold text-primary mt-0.5">{users.length}</p>
              <p className="text-[11px] text-muted-foreground">tap to manage</p>
            </CardContent>
          </Card>
        </div>

        {/* User list */}
        {loadingUsers ? (
          <div className="space-y-3">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-20 w-full rounded-2xl" />)}
          </div>
        ) : users.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Search className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="font-semibold text-base">Nobody found</p>
            <p className="text-sm">Try a different name or phone number</p>
          </div>
        ) : (
          <div className="space-y-2">
            {users.map(u => (
              <button
                key={u.id}
                onClick={() => openUser(u)}
                style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                className="w-full flex items-center gap-4 p-4 rounded-2xl border bg-card hover:bg-muted/50 active:scale-[0.98] transition-all text-left min-h-[72px]"
              >
                <Avatar className="h-12 w-12 shrink-0">
                  <AvatarFallback className="bg-primary/10 text-primary font-bold text-base">
                    {u.full_name.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-base truncate">{u.full_name}</p>
                  <p className="text-sm text-muted-foreground flex items-center gap-1">
                    <Phone className="h-3 w-3" />
                    {u.phone}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className={`font-bold text-base ${u.balance > 0 ? 'text-success' : 'text-muted-foreground'}`}>
                    {formatUGX(u.balance)}
                  </p>
                  <p className="text-xs text-muted-foreground">{u.entryCount} transactions</p>
                </div>
                <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0 ml-1" />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  /* ═══════════════════════════════════════════════════════════════════
     DETAIL VIEW
  ═══════════════════════════════════════════════════════════════════ */
  return (
    <div className="space-y-4 pb-24">

      {/* Back + name */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={goBack} className="h-11 w-11 shrink-0">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="font-bold text-lg leading-tight truncate">{selectedUser.full_name}</h2>
          <p className="text-sm text-muted-foreground flex items-center gap-1">
            <Phone className="h-3 w-3" />
            {selectedUser.phone}
          </p>
        </div>
        <Button variant="outline" size="icon" className="h-11 w-11 shrink-0" onClick={() => fetchLedger(selectedUser.id)}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Balance hero */}
      <div className="rounded-3xl bg-gradient-to-br from-primary to-primary/70 text-primary-foreground p-6">
        <p className="text-sm font-semibold opacity-80 uppercase tracking-wide">💰 Wallet Balance</p>
        <p className="text-5xl font-extrabold mt-2 font-mono leading-none">
          {formatUGX(selectedUser.balance)}
        </p>
        <p className="text-sm opacity-70 mt-1">This is how much money is in their wallet right now</p>

        <div className="grid grid-cols-2 gap-4 mt-5">
          <div className="bg-primary-foreground/10 rounded-2xl p-3">
            <div className="flex items-center gap-2 mb-1">
              <ArrowDownCircle className="h-4 w-4 text-success" />
              <p className="text-xs opacity-80 font-medium">Total Money In</p>
            </div>
            <p className="text-xl font-bold">+{formatUGX(totalIn)}</p>
          </div>
          <div className="bg-primary-foreground/10 rounded-2xl p-3">
            <div className="flex items-center gap-2 mb-1">
              <ArrowUpCircle className="h-4 w-4 text-destructive" />
              <p className="text-xs opacity-80 font-medium">Total Money Out</p>
            </div>
            <p className="text-xl font-bold">-{formatUGX(totalOut)}</p>
          </div>
        </div>
      </div>

      {/* Manual adjustments prohibited */}
      <div className="flex items-start gap-3 p-4 rounded-2xl bg-muted/50 border border-border">
        <TriangleAlert className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-bold text-muted-foreground">Manual Adjustments Prohibited</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            All balance changes must go through the proper approval workflow (deposits, repayments, commissions).
          </p>
        </div>
      </div>

      {/* Where money came from — simple breakdown */}
      {!loadingLedger && ledger.length > 0 && (
        <div className="rounded-2xl border overflow-hidden">
          <div className="px-4 py-3 bg-muted/50 border-b">
            <p className="font-bold text-sm">📊 Where Their Money Came From</p>
            <p className="text-xs text-muted-foreground">A simple summary of all money movements</p>
          </div>

          {/* Money In section */}
          {totalIn > 0 && (
            <>
              <div className="px-4 py-2 bg-success/5">
                <p className="text-xs font-bold text-success flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5" />
                  MONEY THAT CAME IN — {formatUGX(totalIn)}
                </p>
              </div>
              {Object.entries(
                ledger.filter(e=>e.direction==='cash_in').reduce((acc, e) => {
                  acc[e.category] = (acc[e.category]||0) + e.amount; return acc;
                }, {} as Record<string,number>)
              ).map(([cat, amt]) => {
                const info = getCategoryInfo(cat, 'cash_in');
                return (
                  <div key={cat} className="flex items-center gap-3 px-4 py-3 border-b last:border-b-0 bg-card">
                    <span className="text-2xl">{info.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm">{info.label}</p>
                      {info.note && <p className="text-xs text-muted-foreground">{info.note}</p>}
                    </div>
                    <p className="font-bold text-success font-mono text-sm">+{formatUGX(amt)}</p>
                  </div>
                );
              })}
            </>
          )}

          {/* Money Out section */}
          {totalOut > 0 && (
            <>
              <div className="px-4 py-2 bg-destructive/5">
                <p className="text-xs font-bold text-destructive flex items-center gap-1.5">
                  <TrendingDown className="h-3.5 w-3.5" />
                  MONEY THAT WENT OUT — {formatUGX(totalOut)}
                </p>
              </div>
              {Object.entries(
                ledger.filter(e=>e.direction==='cash_out').reduce((acc, e) => {
                  acc[e.category] = (acc[e.category]||0) + e.amount; return acc;
                }, {} as Record<string,number>)
              ).map(([cat, amt]) => {
                const info = getCategoryInfo(cat, 'cash_out');
                return (
                  <div key={cat} className="flex items-center gap-3 px-4 py-3 border-b last:border-b-0 bg-card">
                    <span className="text-2xl">{info.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm">{info.label}</p>
                      {info.note && <p className="text-xs text-muted-foreground">{info.note}</p>}
                    </div>
                    <p className="font-bold text-destructive font-mono text-sm">-{formatUGX(amt)}</p>
                  </div>
                );
              })}
            </>
          )}

          {/* Net */}
          <div className="flex items-center justify-between px-4 py-4 bg-muted/70 border-t">
            <div>
              <p className="font-bold text-sm">Money Left in Wallet</p>
              <p className="text-xs text-muted-foreground">After all ins and outs</p>
            </div>
            <p className={`font-extrabold text-xl font-mono ${totalIn - totalOut >= 0 ? 'text-success' : 'text-destructive'}`}>
              {formatUGX(Math.max(0, totalIn - totalOut))}
            </p>
          </div>
        </div>
      )}

      {/* Filter pills */}
      <div className="flex gap-2">
        {[
          { key: 'all',      label: 'All Activity' },
          { key: 'cash_in',  label: '📥 Money In' },
          { key: 'cash_out', label: '📤 Money Out' },
        ].map(opt => (
          <Button
            key={opt.key}
            variant={showOnlyType === opt.key ? 'default' : 'outline'}
            size="sm"
            className="h-10 rounded-full px-4 text-sm"
            onClick={() => setShowOnlyType(opt.key as typeof showOnlyType)}
          >
            {opt.label}
          </Button>
        ))}
      </div>

      {/* Transaction list */}
      {loadingLedger ? (
        <div className="space-y-3">
          {[...Array(5)].map((_,i) => <Skeleton key={i} className="h-20 w-full rounded-2xl" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Wallet className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="font-semibold text-base">No transactions yet</p>
          <p className="text-sm">Nothing to show for the selected filter</p>
        </div>
      ) : (
        <div className="space-y-6">
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground px-1">
            Transaction History ({filtered.length} records)
          </p>
          {Object.entries(grouped).map(([dateKey, dayEntries]) => {
            const dayIn  = dayEntries.filter(e=>e.direction==='cash_in').reduce((s,e)=>s+e.amount, 0);
            const dayOut = dayEntries.filter(e=>e.direction==='cash_out').reduce((s,e)=>s+e.amount, 0);
            return (
              <div key={dateKey}>
                {/* Day header */}
                <div className="flex items-center justify-between mb-3 px-1">
                  <div className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-bold text-muted-foreground">
                      {format(new Date(dateKey), 'EEEE, MMM d, yyyy')}
                    </span>
                  </div>
                  <div className="flex gap-3 text-xs font-semibold">
                    {dayIn  > 0 && <span className="text-success">+{formatUGX(dayIn)}</span>}
                    {dayOut > 0 && <span className="text-destructive">-{formatUGX(dayOut)}</span>}
                  </div>
                </div>

                <div className="space-y-2">
                  {dayEntries.map(entry => {
                    const isIn     = entry.direction === 'cash_in';
                    const info     = getCategoryInfo(entry.category, entry.direction);
                    const isMgr    = entry.category === 'manager_credit' || entry.category === 'manager_debit';
                    return (
                      <div
                        key={entry.id}
                        className={`flex items-center gap-4 p-4 rounded-2xl border ${
                          isMgr ? 'bg-warning/5 border-warning/30' : 'bg-card'
                        }`}
                      >
                        {/* Emoji icon */}
                        <div className={`h-12 w-12 rounded-2xl flex items-center justify-center text-2xl shrink-0 ${
                          isIn ? 'bg-success/10' : 'bg-destructive/10'
                        }`}>
                          {info.emoji}
                        </div>

                        {/* Description */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-bold text-sm leading-tight">{info.label}</p>
                            {isMgr && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-warning text-warning">
                                Manager
                              </Badge>
                            )}
                          </div>
                          {entry.linked_party && (
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">
                              {isMgr ? `By: ${entry.linked_party}` : entry.linked_party}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground">
                            {format(new Date(entry.date), 'h:mm a')}
                            {entry.reference_id && ` · #${entry.reference_id.slice(0, 8)}`}
                          </p>
                        </div>

                        {/* Amount + balance */}
                        <div className="text-right shrink-0">
                          <p className={`font-extrabold text-base ${isIn ? 'text-success' : 'text-destructive'}`}>
                            {isIn ? '+' : '-'}{formatUGX(entry.amount)}
                          </p>
                          <p className="text-[11px] text-muted-foreground font-mono">
                            Balance: {formatUGX(entry.balance_after)}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
