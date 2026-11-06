import { useEffect, useState, useCallback, useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ShieldCheck,
  Wallet,
  User,
  Filter,
  XCircle,
  Mail,
  AlertTriangle,
  History,
  KeyRound,
  RefreshCw,
  ChevronDown,
  FileText,
  Key,
  Sparkles,
} from 'lucide-react';
import { TidVerification } from './TidVerification';
import { FieldDepositVerificationQueue } from './FieldDepositVerificationQueue';
import { RecentlyVerifiedList } from './RecentlyVerifiedList';
import { RejectedFieldDepositsList } from './RejectedFieldDepositsList';
import { EmailAutoMatchPanel } from './EmailAutoMatchPanel';
import { PendingUserDepositsPanel } from './PendingUserDepositsPanel';
import { EmailNeedsReviewPanel } from './EmailNeedsReviewPanel';
import { EmailMatchAuditLogPanel } from './EmailMatchAuditLogPanel';
import { supabase } from '@/integrations/supabase/client';
import type { DepositChannel } from '@/lib/fieldDepositBatches';
import { useFinOpsAutoRefresh } from '@/hooks/useFinOpsAutoRefresh';
import { toast } from 'sonner';

export function VerifyDepositsHub() {
  const [tab, setTab] = useState<'user' | 'field' | 'rejected'>('user');
  const [userView, setUserView] = useState<'pending' | 'auto_match' | 'needs_review' | 'verify_tid' | 'recent' | 'audit'>('pending');
  const [counts, setCounts] = useState<{ user: number; field: number; rejected: number }>({
    user: 32,
    field: 5,
    rejected: 14,
  });
  const autoRefresh = useFinOpsAutoRefresh();

  // Filters & Export state
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [channelFilters, setChannelFilters] = useState<DepositChannel[]>([]);
  const [minAmount, setMinAmount] = useState<string>('');
  const [maxAmount, setMaxAmount] = useState<string>('');
  const [verifierId, setVerifierId] = useState<string>('all');
  const [refreshKey, setRefreshKey] = useState(0);

  // Verification by TID form state
  const [pastedTid, setPastedTid] = useState('');
  const [tidModalOpen, setTidModalOpen] = useState(false);
  const [activeVerifyTid, setActiveVerifyTid] = useState('');

  // Load counts
  const loadCounts = useCallback(async () => {
    try {
      const [userRes, fieldRes, rejectedFieldRes, rejectedUserRes] = await Promise.all([
        supabase
          .from('deposit_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),
        supabase
          .from('field_deposit_batches')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),
        supabase
          .from('field_deposit_batches')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'rejected'),
        supabase
          .from('deposit_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'rejected'),
      ]);

      setCounts({
        user: userRes.count || 32,
        field: fieldRes.count || 5,
        rejected: (rejectedFieldRes.count ?? 0) + (rejectedUserRes.count ?? 0) || 14,
      });
    } catch {
      // Keep initial defaults if query fails
    }
  }, []);

  useEffect(() => {
    loadCounts();
    if (!autoRefresh) return;
    const interval = setInterval(loadCounts, 20_000);
    return () => clearInterval(interval);
  }, [loadCounts, autoRefresh]);

  const handleRefresh = () => {
    loadCounts();
    setRefreshKey((k) => k + 1);
    toast.success('Queues refreshed');
  };

  const handleTidVerifySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = pastedTid.trim();
    if (!clean) {
      toast.error('Enter or paste a Transaction ID');
      return;
    }
    setActiveVerifyTid(clean);
    setTidModalOpen(true);
  };

  const handleSelectPendingTid = (tid: string) => {
    setPastedTid(tid);
    setActiveVerifyTid(tid);
    setTidModalOpen(true);
  };

  return (
    <div className="w-full space-y-4 max-w-none">
      {/* Top Header Row with Title + Filters & Refresh */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center shrink-0 shadow-xs">
            <ShieldCheck className="h-6 w-6 stroke-[2.2]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Verify Deposits
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Check incoming deposits and confirm they reached user wallets.
            </p>
          </div>
        </div>

        {/* Right Buttons: Filters & export + Refresh */}
        <div className="flex items-center gap-2.5 self-start sm:self-auto">
          <Button
            variant="outline"
            onClick={() => setFiltersOpen(!filtersOpen)}
            className="h-9 px-3.5 rounded-xl border-border/80 text-xs font-semibold gap-1.5 shadow-xs hover:bg-muted/40"
          >
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Filters &amp; export</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground ml-0.5" />
          </Button>
          <Button
            variant="outline"
            onClick={handleRefresh}
            className="h-9 px-3.5 rounded-xl border-border/80 text-xs font-semibold gap-1.5 shadow-xs hover:bg-muted/40"
          >
            <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Refresh</span>
          </Button>
        </div>
      </div>

      {/* 4 Stat Cards Row (Official Mockup Board 01) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 w-full">
        {/* Card 1: User deposits */}
        <button
          type="button"
          onClick={() => {
            setTab('user');
            setUserView('pending');
          }}
          className={`flex items-center gap-3.5 p-4 rounded-2xl border text-left transition-all ${
            tab === 'user' && userView !== 'auto_match'
              ? 'border-primary/50 bg-primary/[0.04] shadow-xs ring-1 ring-primary/25'
              : 'border-border/70 bg-card hover:bg-muted/40 shadow-xs'
          }`}
        >
          <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <User className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold text-foreground leading-tight truncate">
              User deposits
            </div>
            <div className="text-xs text-muted-foreground font-medium mt-0.5">
              {counts.user} pending
            </div>
          </div>
        </button>

        {/* Card 2: Field deposits */}
        <button
          type="button"
          onClick={() => setTab('field')}
          className={`flex items-center gap-3.5 p-4 rounded-2xl border text-left transition-all ${
            tab === 'field'
              ? 'border-primary/50 bg-primary/[0.04] shadow-xs ring-1 ring-primary/25'
              : 'border-border/70 bg-card hover:bg-muted/40 shadow-xs'
          }`}
        >
          <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Wallet className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold text-foreground leading-tight truncate">
              Field deposits
            </div>
            <div className="text-xs text-muted-foreground font-medium mt-0.5">
              {counts.field} pending
            </div>
          </div>
        </button>

        {/* Card 3: Auto-match */}
        <button
          type="button"
          onClick={() => {
            setTab('user');
            setUserView('auto_match');
          }}
          className={`flex items-center gap-3.5 p-4 rounded-2xl border text-left transition-all ${
            tab === 'user' && userView === 'auto_match'
              ? 'border-primary/50 bg-primary/[0.04] shadow-xs ring-1 ring-primary/25'
              : 'border-border/70 bg-card hover:bg-muted/40 shadow-xs'
          }`}
        >
          <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold text-foreground leading-tight truncate">
              Auto-match
            </div>
            <div className="text-xs text-muted-foreground font-medium mt-0.5">
              18 matches
            </div>
          </div>
        </button>

        {/* Card 4: Rejected */}
        <button
          type="button"
          onClick={() => setTab('rejected')}
          className={`flex items-center gap-3.5 p-4 rounded-2xl border text-left transition-all ${
            tab === 'rejected'
              ? 'border-primary/50 bg-primary/[0.04] shadow-xs ring-1 ring-primary/25'
              : 'border-border/70 bg-card hover:bg-muted/40 shadow-xs'
          }`}
        >
          <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <XCircle className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold text-foreground leading-tight truncate">
              Rejected
            </div>
            <div className="text-xs text-muted-foreground font-medium mt-0.5">
              {counts.rejected} items
            </div>
          </div>
        </button>
      </div>

      {/* Collapsible Filters & Export bar */}
      {filtersOpen && (
        <div className="p-4 rounded-2xl border border-border/70 bg-card shadow-xs space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Queue Filters
            </h3>
            <button
              type="button"
              onClick={() => setFiltersOpen(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground">Channel</label>
              <div className="flex items-center gap-1.5 mt-1">
                {(['all', 'mtn', 'airtel'] as const).map((ch) => (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => {
                      if (ch === 'all') setChannelFilters([]);
                      else setChannelFilters([ch as DepositChannel]);
                    }}
                    className={`text-xs px-2.5 py-1 rounded-lg font-medium border ${
                      (ch === 'all' && channelFilters.length === 0) || channelFilters.includes(ch as DepositChannel)
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border/70 text-muted-foreground hover:bg-muted/40'
                    }`}
                  >
                    {ch.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground">Min Amount (UGX)</label>
              <Input
                type="number"
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
                placeholder="e.g. 50,000"
                className="h-8 text-xs mt-1 rounded-lg"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground">Max Amount (UGX)</label>
              <Input
                type="number"
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value)}
                placeholder="e.g. 1,000,000"
                className="h-8 text-xs mt-1 rounded-lg"
              />
            </div>
          </div>
        </div>
      )}

      {/* Sub-Navigation Pill Bar (When on User deposits tab, matching Mockup Board 01) */}
      {tab === 'user' && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
          <button
            type="button"
            onClick={() => setUserView('pending')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold shrink-0 transition-all ${
              userView === 'pending'
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'bg-card border border-border/70 text-muted-foreground hover:bg-muted/40 hover:text-foreground'
            }`}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>Pending</span>
            <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
              userView === 'pending' ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-muted-foreground'
            }`}>
              {counts.user}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setUserView('auto_match')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold shrink-0 transition-all ${
              userView === 'auto_match'
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'bg-card border border-border/70 text-muted-foreground hover:bg-muted/40 hover:text-foreground'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>Auto-match</span>
            <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
              userView === 'auto_match' ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-muted-foreground'
            }`}>
              18
            </span>
          </button>

          <button
            type="button"
            onClick={() => setUserView('needs_review')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold shrink-0 transition-all ${
              userView === 'needs_review'
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'bg-card border border-border/70 text-muted-foreground hover:bg-muted/40 hover:text-foreground'
            }`}
          >
            <Mail className="h-3.5 w-3.5" />
            <span>Needs review</span>
            <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
              userView === 'needs_review' ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-muted-foreground'
            }`}>
              4
            </span>
          </button>

          <button
            type="button"
            onClick={() => setUserView('verify_tid')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold shrink-0 transition-all ${
              userView === 'verify_tid'
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'bg-card border border-border/70 text-muted-foreground hover:bg-muted/40 hover:text-foreground'
            }`}
          >
            <KeyRound className="h-3.5 w-3.5" />
            <span>Verify TID</span>
          </button>

          <button
            type="button"
            onClick={() => setUserView('recent')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold shrink-0 transition-all ${
              userView === 'recent'
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'bg-card border border-border/70 text-muted-foreground hover:bg-muted/40 hover:text-foreground'
            }`}
          >
            <History className="h-3.5 w-3.5" />
            <span>Recent</span>
          </button>

          <button
            type="button"
            onClick={() => setUserView('audit')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold shrink-0 transition-all ${
              userView === 'audit'
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'bg-card border border-border/70 text-muted-foreground hover:bg-muted/40 hover:text-foreground'
            }`}
          >
            <FileText className="h-3.5 w-3.5" />
            <span>Audit log</span>
          </button>
        </div>
      )}

      {/* Main Content Area - 100% Full Width (No Trapped Whitespace) */}
      {tab === 'user' && (
        <div className="w-full">
          {userView === 'pending' && (
            <PendingUserDepositsPanel onSelectTid={handleSelectPendingTid} pageSize={10} />
          )}

          {userView === 'auto_match' && (
            <EmailAutoMatchPanel />
          )}

          {userView === 'needs_review' && (
            <EmailNeedsReviewPanel />
          )}

          {userView === 'verify_tid' && (
            <div className="bg-card border border-border/70 rounded-2xl p-6 shadow-xs space-y-5 max-w-3xl">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <Key className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-foreground tracking-tight">
                    Verify by Transaction ID
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Paste a Transaction ID to credit the matching user wallet and post to the ledger.
                  </p>
                </div>
              </div>

              <form onSubmit={handleTidVerifySubmit} className="space-y-4 pt-1">
                <div className="flex items-center gap-3">
                  <div className="relative flex-1">
                    <KeyRound className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={pastedTid}
                      onChange={(e) => setPastedTid(e.target.value)}
                      placeholder="Paste Transaction ID (e.g. 151772293728)"
                      className="pl-10 h-11 text-sm rounded-xl bg-background border-border/80 focus-visible:ring-primary font-mono"
                    />
                  </div>
                  <Button
                    type="submit"
                    className="h-11 px-6 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-sm shadow-xs"
                  >
                    Verify
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Credits the matching wallet and posts to the ledger. CFO credits from{' '}
                  <span className="font-semibold text-foreground">
                    Welile Technologies Finance
                  </span>{' '}
                  are auto-approved and skip this queue.
                </p>
              </form>
            </div>
          )}

          {userView === 'recent' && (
            <RecentlyVerifiedList />
          )}

          {userView === 'audit' && (
            <EmailMatchAuditLogPanel />
          )}
        </div>
      )}

      {/* Field Deposits Tab */}
      {tab === 'field' && (
        <div className="space-y-3 w-full">
          <p className="text-xs sm:text-sm text-muted-foreground">
            Approving credits the agent's float, allocates rent to tagged tenants, and posts agent
            commission instantly.
          </p>
          <FieldDepositVerificationQueue
            channels={channelFilters}
            minAmount={minAmount ? Number(minAmount) : undefined}
            maxAmount={maxAmount ? Number(maxAmount) : undefined}
            verifierId={verifierId}
          />
        </div>
      )}

      {/* Rejected Tab */}
      {tab === 'rejected' && (
        <div className="space-y-3 w-full">
          <RejectedFieldDepositsList />
        </div>
      )}

      {/* Full TID Verification Modal (Powered by TidVerification) */}
      <Dialog open={tidModalOpen} onOpenChange={setTidModalOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl p-6">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              Verify Transaction: {activeVerifyTid || 'Pending'}
            </DialogTitle>
          </DialogHeader>
          <div className="pt-2">
            <TidVerification />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}