import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { archivePdfBlob } from '@/lib/pdfVault';
import { ArchivedPdfsDrawer } from '@/components/financial-ops/ArchivedPdfsDrawer';
import { Badge } from '@/components/ui/badge';
import { Mail, RefreshCw, Loader2, CheckCircle2, AlertCircle, Smartphone, Bug, ShieldAlert, Copy, Check, Wifi, WifiOff, ShieldCheck, ShieldQuestion, History, LinkIcon, ChevronDown, ChevronUp, FileDown, FileText, AlertTriangle, Search, X, Pencil, Trash2, Star, Users, ArrowRight, Zap, Undo2, Wallet, HelpCircle, Phone, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { RouteEmailDepositDialog, type EmailRowForRouting, type PrefilledUser } from '@/components/financial-ops/RouteEmailDepositDialog';
import { UserSearchPicker, type UserResult } from '@/components/cfo/UserSearchPicker';
import { BucketTransferLauncher } from '@/components/financial-ops/BucketTransferDialog';
import { BacklogSweepLauncher } from '@/components/financial-ops/BacklogSweepDialog';
import { Info, Inbox, AlertOctagon, Send, Menu } from 'lucide-react';
import { Wrench, Clock, TrendingUp } from 'lucide-react';
import { SlidersHorizontal } from 'lucide-react';
import { CalendarRange } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import { toast as sonnerToast } from 'sonner';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { normalizeMomoTid } from '@/lib/momoTid';
import { downloadCsv, csvTimestamp } from '@/lib/csvExport';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip as RTooltip, CartesianGrid, Legend, Brush } from 'recharts';
import { DebitBucketAuditSearch } from './DebitBucketAuditSearch';

import { ProxyDebitBreakdownDialog } from './ProxyDebitBreakdownDialog';
import { EmailPeriodComparison } from './EmailPeriodComparison';
import { DepositNumberConflictsPanel } from './DepositNumberConflictsPanel';
import { SwipeableEmailRow, type SwipeAction } from './SwipeableEmailRow';
import { GmailStyleEmailList } from './GmailStyleEmailList';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// ── Business logic lives in src/lib/emailTransactionsLogic.ts and
// src/hooks/useEmailTransactionsPanel.ts (relocated out of this file — zero
// behavior change; see docs/HANDOVER). This file now owns presentation only.
import {
  type GmailTx,
  type PollState,
  type MatchedUser,
  type StoredUserRule,
  type RuleSource,
  dateKeyInTz,
  extractCashReceiptCode,
  isWelileOutboundEcho,
  deriveChannel,
  fmtUgx,
  confidenceScore,
  channelCacheKey,
  TIMEZONE_OPTIONS,
  CHANNEL_OPTIONS,
  escapeRegex,
  autoCreditGateReport,
  parseFailureReasons,
} from '@/lib/emailTransactionsLogic';
import {
  useEmailTransactionsPanel,
  type SortMode,
  type PaginationMode,
  type RoutingHistoryEntry,
} from '@/hooks/useEmailTransactionsPanel';
import { useTelecomBalances } from '@/hooks/useTelecomBalances';

/**
 * Live MTN / Airtel float balances as reported on the most recent
 * balance-carrying email for each channel. Re-reads whenever new mail lands.
 */
function TelecomBalanceStrip({ refreshKey }: { refreshKey: string | null }) {
  const bal = useTelecomBalances(refreshKey);

  const fmt = (n: number) => `UGX ${Math.round(n).toLocaleString()}`;
  const time = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
  };

  const item = (label: string, tone: string, v: { amount: number; at: string } | null) => (
    <div
      className="flex items-center gap-1.5 rounded-full border bg-muted/40 px-2 py-1"
      title={v ? `${label} balance from the latest email · ${time(v.at)}` : `No ${label} balance found yet`}
    >
      <span className={`h-2 w-2 rounded-full ${tone}`} aria-hidden />
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-xs font-semibold tabular-nums">{v ? fmt(v.amount) : '—'}</span>
    </div>
  );

  const totalAmount = (bal.mtn?.amount ?? 0) + (bal.airtel?.amount ?? 0);
  const totalAt = bal.mtn?.at && bal.airtel?.at
    ? (new Date(bal.mtn.at) > new Date(bal.airtel.at) ? bal.mtn.at : bal.airtel.at)
    : (bal.mtn?.at ?? bal.airtel?.at ?? null);

  return (
    <div className="flex flex-wrap items-center gap-2 shrink-0" aria-label="Latest telecom balances">
      {/* Total is the primary, easy-to-read element */}
      <div
        className="flex flex-col rounded-lg border-2 border-purple-400 bg-purple-100 px-3 py-1.5 shadow-sm dark:border-purple-700 dark:bg-purple-950/60"
        title={totalAt ? `Combined float balance · latest email ${time(totalAt)}` : 'Combined float balance'}
      >
        <span className="text-[10px] font-bold uppercase tracking-wide text-purple-800 dark:text-purple-200">Total float</span>
        <span className="text-base font-extrabold tabular-nums leading-tight text-purple-900 dark:text-purple-100">{fmt(totalAmount)}</span>
      </div>

      {/* Provider breakdown shown as smaller secondary chips */}
      <div className="flex items-center gap-1.5">
        {item('MTN', 'bg-warning', bal.mtn)}
        {item('Airtel', 'bg-destructive', bal.airtel)}
      </div>
    </div>
  );
}

/**
 * Live feed of transaction confirmation emails extracted from the
 * connected Gmail inbox. A background cron polls every minute; this
 * panel mirrors the table in real time and exposes a manual "Poll now".
 *
 * All state, effects and handlers live in `useEmailTransactionsPanel()`
 * (src/hooks/useEmailTransactionsPanel.ts) — this component is presentation
 * only. See docs/HANDOVER for the relocation note.
 */
export function EmailTransactionsPanel() {
  const {
    toast, rows, setRows, state, setState, loadError,
    setLoadError, lastSuccessAt, setLastSuccessAt, loading, setLoading, polling,
    setPolling, initialTz, todayKeyInitial, fromDate, setFromDate, toDate,
    setToDate, browserTz, tz, setTz, netThreshold, setNetThreshold,
    searchQuery, setSearchQuery, searchOptionsOpen, setSearchOptionsOpen, phoneQuery, setPhoneQuery,
    pageSize, setPageSize, currentPage, setCurrentPage, paginationMode, setPaginationMode,
    infiniteCount, setInfiniteCount, infiniteSentinelRef, matchFilter, setMatchFilter, workspaceTab,
    setWorkspaceTab, directionFilter, setDirectionFilter, focusDirection, setFocusDirection, focusView,
    setFocusView, gmailNavOpen, setGmailNavOpen, needsRoutingOnly, setNeedsRoutingOnly, debitFilter,
    setDebitFilter, debitSort, setDebitSort, statusFilter, setStatusFilter, sortMode,
    setSortMode, filterPresets, setFilterPresets, activePresetId, setActivePresetId, presetNameDraft,
    setPresetNameDraft, presetSaveOpen, setPresetSaveOpen, currentPresetSnapshot, savePreset, applyPreset,
    deletePreset, channelCacheRef, flushChannelCache, userMatches, setUserMatches, routingHistory,
    setRoutingHistory, justRoutedIds, setJustRoutedIds, userBalances, setUserBalances, userProxies,
    setUserProxies, userRecentTx, setUserRecentTx, balanceRefreshedAt, setBalanceRefreshedAt, reverseBusy,
    setReverseBusy, expandedRows, setExpandedRows, toggleRowExpanded, creditedDeposits, setCreditedDeposits,
    ledgerCredits, setLedgerCredits, manualMarks, setManualMarks, selectedIds, setSelectedIds,
    bulkBusy, setBulkBusy, withdrawalMatches, setWithdrawalMatches, autoApproving, setAutoApproving,
    inviteSms, setInviteSms, editingRow, setEditingRow, routingRow, setRoutingRow,
    routingSuggestedUser, setRoutingSuggestedUser, routingMode, setRoutingMode, inlineRouteUsers, setInlineRouteUsers,
    historyDrawerRow, setHistoryDrawerRow, historyDrawerQuery, setHistoryDrawerQuery, historyDrawerType, setHistoryDrawerType,
    pendingSwipe, setPendingSwipe, swipeAck, setSwipeAck, autoDebitBusy, setAutoDebitBusy,
    autoDebitProgress, setAutoDebitProgress, autoDebitResults, setAutoDebitResults, rulesVersion, setRulesVersion,
    storedUserRules, setStoredUserRules, mobileFiltersOpen, setMobileFiltersOpen, mobileStatsOpen, setMobileStatsOpen,
    chartBrush, setChartBrush, tooltipPlacement, setTooltipPlacement, statTooltipSide, unparsedOpen,
    setUnparsedOpen, persistUserRules, deleteUserRule, load, recordTidAutoCreditAudit, applyBulkMark,
    markRowResolved, reverseRoutingEntry, channelToPaymentMethod, autoApproveWithdrawal, pollNow, fromTs,
    toTs, inRange, searchActiveForRange, dateRows, searchTokens, expandedSearchTokens,
    matchesSearch, phoneDigits, phoneNeedle, phoneActive, matchesPhone, filteredRows,
    searchActive, channelCache, cacheSnapshot, rowChannel, ch, rangeActive,
    parsedCount, unparsedRows, validity, flaggedCount, isCountable, totalAmount,
    totalIn, totalOut, netAmount, unmatchedInCount, unmatchedOutCount, channelBreakdown,
    totalFees, feeCount, dailySeries, isNeedsRouting, getRowStatus, ALERTS_SEEN_KEY,
    ALERT_PREFS_KEY, alertPrefs, setAlertPrefs, updateAlertPrefs, alertsSeenTs, setAlertsSeenTs,
    rowTimeMs, alertRows, unreadAlertRows, unreadAlertCount, formatAlertArrival, unreadArrivalSpan,
    isUnreadAlertRow, markAlertsSeen, promptedUnreadRef, selectAllAlertRows, resolveAlertRows, getDebitMeta,
    isNeedsDebitRouting, visibleRows, navIndex, canPrevNav, canNextNav, totalVisible,
    goToPage, computeSuggestedFor, navigateToRow, routeQueue, setRouteQueue, historyQueue,
    setHistoryQueue, alertDetailsRow, setAlertDetailsRow, alertSettingsOpen, setAlertSettingsOpen, startRouteQueue,
    startHistoryQueue, historyQueueIndex, swipeNavigate, refreshRowStatus, gmailLabelCounts, gmailLabels,
    applyRecentWindow,
  } = useEmailTransactionsPanel();
  return (
    <div className="space-y-3.5">
      {/* ── Top Workspace Tab Navigation ── */}
      <div className="flex items-center gap-1.5 p-1 rounded-2xl bg-muted/60 border border-border/80 overflow-x-auto shadow-sm">
        <button
          type="button"
          onClick={() => setWorkspaceTab('inbox')}
          className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all shrink-0 ${
            workspaceTab === 'inbox'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Inbox className="h-4 w-4" /> Live Inbox
          <span className="text-[11px] tabular-nums font-normal opacity-80">({rows.length})</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setWorkspaceTab('needs_review');
            setFocusView('ops');
          }}
          className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all shrink-0 ${
            workspaceTab === 'needs_review'
              ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/30'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <AlertTriangle className="h-4 w-4 text-amber-600" /> Needs Review
          {(flaggedCount + unmatchedInCount + unmatchedOutCount) > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-amber-500 text-white text-[10px] font-bold">
              {flaggedCount + unmatchedInCount + unmatchedOutCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            setWorkspaceTab('settled');
            setFocusView('ops');
          }}
          className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all shrink-0 ${
            workspaceTab === 'settled'
              ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <CheckCircle2 className="h-4 w-4 text-emerald-600" /> Auto-Matched & Settled
        </button>
        <button
          type="button"
          onClick={() => setWorkspaceTab('analytics')}
          className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all shrink-0 ${
            workspaceTab === 'analytics'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <TrendingUp className="h-4 w-4" /> Analytics & Breakdown
        </button>
        <button
          type="button"
          onClick={() => setWorkspaceTab('diagnostics')}
          className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all shrink-0 ${
            workspaceTab === 'diagnostics'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Wrench className="h-4 w-4" /> Connection & Diagnostics
        </button>
      </div>

      {/* ── Gmail-style app bar: hamburger, product name, one big rounded
          search field, then the layout switch on the far right. ───────── */}
      <div className="flex items-center gap-2 sm:gap-3 rounded-full border bg-card px-2 py-1.5 sm:px-3 sm:py-2">
        <Button
          size="icon"
          variant="ghost"
          className="h-9 w-9 shrink-0 rounded-full lg:hidden"
          aria-label={gmailNavOpen ? 'Hide labels' : 'Show labels'}
          aria-expanded={gmailNavOpen}
          onClick={() => setGmailNavOpen((v) => !v)}
        >
          <Menu className="h-4 w-4" />
        </Button>
        <div className="hidden sm:flex items-center gap-2 shrink-0 pl-1 pr-1">
          <Mail className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium tracking-tight">Email transactions</span>
        </div>
        <TelecomBalanceStrip refreshKey={rows[0]?.id ?? null} />
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search mail — amount, name, phone, transaction id…"
            aria-label="Search mail"
            className="h-10 w-full rounded-full border-0 bg-muted/60 pl-10 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:bg-background placeholder:text-muted-foreground/70 transition-colors"
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setSearchOptionsOpen((v) => !v)}
              aria-expanded={searchOptionsOpen}
              aria-label="Show search options"
              title="Show search options"
              className={`rounded-full p-1.5 hover:bg-muted ${searchOptionsOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </button>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 h-9 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            const next = focusView === 'gmail' ? 'ops' : 'gmail';
            setFocusView(next);
            if (next === 'gmail') setFocusDirection(null);
          }}
        >
          {focusView === 'gmail' ? 'Ops layout' : 'Inbox layout'}
        </Button>
      </div>

      {/* Gmail's advanced search card — drops beneath the search field with
          From / Date within / Sort, plus Search + Clear actions. */}
      {searchOptionsOpen && (
        <div className="rounded-2xl border bg-card p-4 shadow-sm space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid grid-cols-[88px_1fr] items-center gap-3">
              <span className="text-xs text-muted-foreground text-right">From</span>
              <div className="relative">
                <Phone className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="search"
                  inputMode="tel"
                  value={phoneQuery}
                  onChange={(e) => setPhoneQuery(e.target.value)}
                  placeholder="Phone number"
                  aria-label="Filter by depositor phone number"
                  className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/70"
                />
              </div>
            </label>
            <label className="grid grid-cols-[88px_1fr] items-center gap-3">
              <span className="text-xs text-muted-foreground text-right">Has the words</span>
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Amount, name, reference…"
                aria-label="Has the words"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/70"
              />
            </label>
            <div className="grid grid-cols-[88px_1fr] items-center gap-3">
              <span className="text-xs text-muted-foreground text-right">Date within</span>
              <Select
                value="custom"
                onValueChange={(v) => {
                  if (v === 'custom') return;
                  applyRecentWindow(Number(v));
                }}
              >
                <SelectTrigger className="h-9 text-sm" aria-label="Date within">
                  <SelectValue placeholder="Any time" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="custom">{fromDate} → {toDate}</SelectItem>
                  <SelectItem value="1">1 day</SelectItem>
                  <SelectItem value="3">3 days</SelectItem>
                  <SelectItem value="7">1 week</SelectItem>
                  <SelectItem value="14">2 weeks</SelectItem>
                  <SelectItem value="30">1 month</SelectItem>
                  <SelectItem value="90">3 months</SelectItem>
                  <SelectItem value="180">6 months</SelectItem>
                  <SelectItem value="365">1 year</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-[88px_1fr] items-center gap-3">
              <span className="text-xs text-muted-foreground text-right">Sort by</span>
              <Select value={sortMode} onValueChange={(v) => setSortMode(v as SortMode)}>
                <SelectTrigger className="h-9 text-sm" aria-label="Sort mail">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest first</SelectItem>
                  <SelectItem value="oldest">Oldest first</SelectItem>
                  <SelectItem value="amount_high">Amount: high to low</SelectItem>
                  <SelectItem value="amount_low">Amount: low to high</SelectItem>
                  <SelectItem value="status">Status (needs routing first)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-[88px_1fr] items-center gap-3">
              <span className="text-xs text-muted-foreground text-right">Date from</span>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-9 text-sm" aria-label="Date from" />
            </div>
            <div className="grid grid-cols-[88px_1fr] items-center gap-3">
              <span className="text-xs text-muted-foreground text-right">Date to</span>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-9 text-sm" aria-label="Date to" />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 rounded-full px-4 text-xs"
              onClick={() => { setSearchQuery(''); setPhoneQuery(''); applyRecentWindow(7); }}
            >
              Clear
            </Button>
            <Button
              size="sm"
              className="h-9 rounded-full px-5 text-xs"
              onClick={() => {
                setSearchOptionsOpen(false);
                if (typeof document !== 'undefined') {
                  document.getElementById('email-tx-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
              }}
            >
              <Search className="h-3.5 w-3.5 mr-1.5" /> Search
            </Button>
          </div>
        </div>
      )}

      {/* Compact quick date pills (Gmail chip row) — always visible. */}
      <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
        {([
          { label: 'Today', days: 1 },
          { label: 'Last 7 days', days: 7 },
          { label: 'Last 30 days', days: 30 },
        ]).map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => applyRecentWindow(p.days)}
            className="shrink-0 rounded-full border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {p.label}
          </button>
        ))}
        {(searchQuery || phoneQuery) && (
          <button
            type="button"
            onClick={() => { setSearchQuery(''); setPhoneQuery(''); }}
            className="shrink-0 inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs text-primary"
          >
            Clear filters <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* ── Gmail body: label rail on the left, mail list + ops panels on
          the right (visible on inbox, needs_review and settled tabs). ─── */}
      {(workspaceTab === 'inbox' || workspaceTab === 'needs_review' || workspaceTab === 'settled') && (
      <div className="flex gap-4">
        <aside
          className={`${gmailNavOpen ? 'block' : 'hidden'} lg:block w-full max-w-[256px] shrink-0 lg:w-[232px] lg:sticky lg:top-3 lg:self-start`}
          aria-label="Mail labels"
        >
          <nav className="space-y-0.5 pr-1 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto">
            {gmailLabels.map(({ key, label, Icon, count, active, apply }) => (
              <button
                key={key}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  apply();
                  // Secondary filters (match confidence / debit breakdown) are
                  // sticky and can silently empty a label's view. Clear them so
                  // the list always matches the counter next to the label.
                  setMatchFilter('all');
                  setDebitFilter('all');
                  setGmailNavOpen(false);
                  // Selecting a label always lands the operator in the Gmail
                  // reading experience for that label, never the ops table.
                  setFocusView('gmail');
                  setSearchOptionsOpen(false);
                  if (typeof document !== 'undefined') {
                    document.getElementById('email-tx-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }}
                className={`group flex w-full items-center gap-3.5 rounded-r-full py-2 pl-4 pr-3 text-left text-[13px] transition-colors ${
                  active
                    ? 'bg-primary/10 font-bold text-primary'
                    : 'text-foreground/70 hover:bg-muted/70 hover:text-foreground'
                }`}
              >
                <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'}`} />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {/* Always show the counter — a visible 0 explains an empty view
                    instead of leaving the label looking broken. */}
                <span className={`shrink-0 text-[11px] tabular-nums ${active ? 'font-bold text-primary' : count > 0 ? 'font-semibold text-muted-foreground' : 'text-muted-foreground/50'}`}>
                  {count}
                </span>
              </button>
            ))}
          </nav>
        </aside>
        <div className={`min-w-0 flex-1 space-y-4 ${gmailNavOpen ? 'hidden lg:block' : ''}`}>
      <div id="email-tx-results" className="rounded-2xl border bg-card overflow-hidden scroll-mt-20 shadow-sm">
        {/* Prominent, full-width search bar — lets ops find any email by
            amount, name, phone (any format), reference id, or any word in
            the body / subject. Sticky on scroll so it's always reachable. */}
        <div className="p-3.5 border-b bg-card/95 backdrop-blur sm:sticky sm:top-0 sm:z-10 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h3 className="font-medium text-sm flex items-center gap-2">
              <Mail className="h-3.5 w-3.5 text-muted-foreground" />
              <button
                type="button"
                onClick={() => {
                  // Clicking "Recent emails" narrows the list to the last 7 days
                  // (the standard "recent" window) and clears the free-text search
                  // so the date filter is actually applied.
                  const todayKey = dateKeyInTz(new Date(), tz);
                  const [y, m, d] = todayKey.split('-').map(Number);
                  const toUtc = Date.UTC(y, m - 1, d);
                  const fromUtc = toUtc - 6 * 86_400_000; // inclusive 7-day window
                  const fmtKey = (ms: number) => {
                    const dt = new Date(ms);
                    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
                  };
                  setSearchQuery('');
                  setPhoneQuery('');
                  setFromDate(fmtKey(fromUtc));
                  setToDate(fmtKey(toUtc));
                  if (typeof document !== 'undefined') {
                    document.getElementById('email-tx-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }}
                className="hover:underline underline-offset-4 decoration-muted-foreground/40 cursor-pointer"
                aria-label="Show recent emails (last 7 days)"
                title="Show recent emails (last 7 days)"
              >
                Recent emails
              </button>
              {unreadAlertCount > 0 && (
                <Badge
                  variant="outline"
                  className="border-orange-600/40 text-orange-600 text-[10px] font-mono font-normal"
                  aria-label={`${unreadAlertCount} unread items needing attention`}
                >
                  {unreadAlertCount} new
                </Badge>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => setAlertSettingsOpen(true)}
                aria-label="Alert notification settings"
                title="Alert notification settings"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
              </Button>
            </h3>
            <div className="flex items-center gap-2">
              {searchActive && (
                <span className="text-xs text-muted-foreground">
                  {filteredRows.length} match{filteredRows.length === 1 ? '' : 'es'}
                </span>
              )}
            </div>
          </div>
          {/* Mobile quick date windows. Flow/status narrowing lives in the
              left label rail (Inbox / Money in / Money out / Needs routing /
              Unparsed / Credited). */}
          <div className="sm:hidden -mx-1 overflow-x-auto">
            <div className="flex items-center gap-1.5 px-1 pb-1 w-max">
              {([
                { label: 'Today', days: 1, offset: 0 },
                { label: '7d', days: 7, offset: 0 },
                { label: '30d', days: 30, offset: 0 },
              ] as Array<{ label: string; days: number; offset: number }>).map((p) => {
                const applyPreset = () => {
                  const todayKey = dateKeyInTz(new Date(), tz);
                  const [y, m, d] = todayKey.split('-').map(Number);
                  const toUtc = Date.UTC(y, m - 1, d) - p.offset * 86_400_000;
                  const fromUtc = toUtc - (p.days - 1) * 86_400_000;
                  const fmtKey = (ms: number) => {
                    const dt = new Date(ms);
                    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
                  };
                  setSearchQuery('');
                  setFromDate(fmtKey(fromUtc));
                  setToDate(fmtKey(toUtc));
                };
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={applyPreset}
                    className="shrink-0 text-[11px] px-2.5 py-1 rounded-full border bg-background hover:bg-muted text-muted-foreground border-border"
                  >
                    {p.label}
                  </button>
                );
              })}
              {/* Custom window — same from/to state the desktop date inputs use,
                  so a hand-picked range behaves exactly like a preset. */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="shrink-0 inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border bg-background hover:bg-muted text-muted-foreground border-border"
                    aria-label="Pick a custom date range"
                  >
                    <CalendarRange className="h-3 w-3" />
                    Custom
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-3 space-y-2 z-[200] pointer-events-auto">
                  <p className="text-[11px] font-medium">Custom date range</p>
                  <div className="space-y-1.5">
                    <label className="block text-[10px] uppercase tracking-wide text-muted-foreground">From</label>
                    <Input
                      type="date"
                      value={fromDate}
                      max={toDate || undefined}
                      onChange={(e) => { setSearchQuery(''); setFromDate(e.target.value); }}
                      className="h-9 text-sm"
                      aria-label="Custom range date from"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[10px] uppercase tracking-wide text-muted-foreground">To</label>
                    <Input
                      type="date"
                      value={toDate}
                      min={fromDate || undefined}
                      onChange={(e) => { setSearchQuery(''); setToDate(e.target.value); }}
                      className="h-9 text-sm"
                      aria-label="Custom range date to"
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Both ends are inclusive, in {tz.split('/').pop()} time.
                  </p>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </div>
        
        <div className="p-3 sm:p-4 border-b sticky top-[104px] z-[18] bg-card sm:static sm:z-auto">
          {/* Saved filter presets — one-tap switching between saved views.
              Always visible (mobile-first) so operators never have to expand the
              chip groups to restore a triage view. */}
          <div className="mt-2 sm:mt-0 sm:mb-3">
            <div className="flex items-center gap-1 overflow-x-auto pb-1" role="group" aria-label="Saved filter presets">
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground pr-1">Views</span>
              {filterPresets.length === 0 && (
                <span className="shrink-0 text-[11px] text-muted-foreground">None saved yet</span>
              )}
              {filterPresets.map((p) => {
                const active = activePresetId === p.id;
                return (
                  <span
                    key={p.id}
                    className={`shrink-0 inline-flex items-center gap-1 rounded-full border pl-2.5 pr-1 py-1 text-[11px] transition-colors ${
                      active
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background hover:bg-muted text-muted-foreground border-border'
                    }`}
                  >
                    <button type="button" onClick={() => applyPreset(p)} aria-pressed={active} className="max-w-[120px] truncate">
                      {p.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => deletePreset(p.id)}
                      aria-label={`Delete preset ${p.name}`}
                      className="opacity-70 hover:opacity-100 p-0.5"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                );
              })}
              <button
                type="button"
                onClick={() => setPresetSaveOpen((v) => !v)}
                className="shrink-0 inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-[11px] font-medium hover:bg-muted"
              >
                <Star className="h-3 w-3" /> Save view
              </button>
            </div>
            {presetSaveOpen && (
              <div className="mt-2 flex items-center gap-2">
                <Input
                  value={presetNameDraft}
                  onChange={(e) => setPresetNameDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') savePreset(); }}
                  placeholder="Name this view (e.g. Needs routing)"
                  className="h-8 text-xs"
                  aria-label="Preset name"
                />
                <Button size="sm" className="h-8 text-xs" onClick={savePreset} disabled={!presetNameDraft.trim()}>
                  Save
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* ── Gmail list toolbar: refresh on the left, result count on the
            right — the strip that sits above every Gmail inbox. ────────── */}
        <div className="flex items-center justify-between gap-2 border-b px-2 py-1.5">
          <div className="flex items-center gap-0.5">
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 rounded-full"
              onClick={() => load()}
              disabled={loading}
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 rounded-full"
              onClick={() => setAlertSettingsOpen(true)}
              aria-label="View settings"
              title="View settings"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </div>
          <span className="pr-1 text-[11px] tabular-nums text-muted-foreground">
            {visibleRows.length} of {rows.length}
          </span>
        </div>

        {!loading && loadError && rows.length > 0 && (
          <div className="mx-3 mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
            <span className="font-semibold">Partial load</span> — some emails could not be read:{' '}
            <span className="font-mono break-all">{loadError.message}</span>
          </div>
        )}
        {loading ? (
          <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : rows.length === 0 && loadError?.denied ? (
          <div className="p-10 text-center text-sm space-y-2">
            <ShieldAlert className="h-8 w-8 mx-auto text-destructive opacity-70" />
            <p className="font-semibold text-destructive">Access denied — you can't read the transaction emails</p>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              This is a permission problem, not an empty inbox. Your account can open Financial Ops but is not
              allowed to read captured emails. Ask a manager to grant you the Financial Ops dashboard permission.
            </p>
            <p className="text-[10px] text-muted-foreground/80 font-mono break-all">{loadError.message}</p>
          </div>
        ) : rows.length === 0 && loadError ? (
          <div className="p-10 text-center text-sm space-y-2">
            <AlertTriangle className="h-8 w-8 mx-auto text-warning opacity-70" />
            <p className="font-semibold">Could not load transaction emails</p>
            <p className="text-[10px] text-muted-foreground/80 font-mono break-all">{loadError.message}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => load()}>Try again</Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground space-y-2">
            <Mail className="h-8 w-8 mx-auto opacity-30" />
            <p>No transaction emails captured yet.</p>
            <p className="text-xs">Click <strong>Poll now</strong> to check Gmail for new emails, or just wait a minute — it checks on its own.</p>
          </div>
        ) : (
          <div className="divide-y max-h-[calc(100vh-16rem)] min-h-[420px] overflow-y-auto">
            {selectedIds.size > 0 && (
              <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-background/95 backdrop-blur px-3 py-2 shadow-sm">
                <div className="text-xs font-medium">
                  <span className="text-primary">{selectedIds.size}</span> selected
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bulkBusy || alertRows.length === 0}
                    onClick={selectAllAlertRows}
                  >
                    Select unresolved ({alertRows.length})
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bulkBusy || visibleRows.length === 0}
                    onClick={() => setSelectedIds(new Set(visibleRows.map((r) => r.id)))}
                  >
                    Select all shown ({visibleRows.length})
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bulkBusy}
                    onClick={() => startRouteQueue(visibleRows.filter((r) => selectedIds.has(r.id)))}
                  >
                    <Zap className="h-3.5 w-3.5 mr-1" /> Route selected ({selectedIds.size})
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bulkBusy}
                    onClick={() => startHistoryQueue(visibleRows.filter((r) => selectedIds.has(r.id)))}
                  >
                    <History className="h-3.5 w-3.5 mr-1" /> Open history ({selectedIds.size})
                  </Button>
                  <Button
                    size="sm"
                    disabled={bulkBusy}
                    onClick={() => resolveAlertRows(alertRows.filter((r) => selectedIds.has(r.id)))}
                  >
                    {bulkBusy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
                    Resolve selected alerts
                  </Button>
                  <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => applyBulkMark('credited')}>
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Mark as paid in
                  </Button>
                  <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => applyBulkMark('uncredited')}>
                    <Undo2 className="h-3.5 w-3.5 mr-1" /> Mark as not paid in
                  </Button>
                  <Button size="sm" variant="ghost" disabled={bulkBusy} onClick={() => setSelectedIds(new Set())}>
                    Clear
                  </Button>
                </div>
              </div>
            )}
            {focusView === 'gmail' ? (
              // Every label (Inbox / Money in / Money out / Needs routing /
              // Unparsed / Credited) renders as a Gmail inbox that endlessly
              // scrolls through ALL rows behind that label's count.
              <GmailStyleEmailList
                rows={visibleRows}
                onCreditUser={(row, user) => {
                  const transaction = visibleRows.find((candidate) => candidate.id === row.id);
                  if (!transaction) return;
                  navigateToRow(transaction, 'credit', {
                    id: user.id,
                    full_name: user.full_name,
                    phone: user.phone,
                  });
                }}
              />
            ) : (() => {
              const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
              const safePage = Math.min(currentPage, totalPages);
              const isInfinite = paginationMode === 'infinite';
              const shownCount = isInfinite
                ? Math.min(infiniteCount, visibleRows.length)
                : Math.min(safePage * pageSize, visibleRows.length);
              const startIdx = isInfinite ? 0 : (safePage - 1) * pageSize;
              const pageRows = isInfinite
                ? visibleRows.slice(0, shownCount)
                : visibleRows.slice(startIdx, startIdx + pageSize);
              (window as any).__emailPaginationMeta = {
                totalPages, safePage, total: visibleRows.length, mode: paginationMode, shownCount,
              };
              return pageRows.map((r) => {
                const matches = userMatches[r.id] ?? [];
                const hasRef = matches.some((u) => u.matched_on.startsWith('reference '));
                const hasFrom = matches.some((u) => u.matched_on.startsWith('from '));
                const isConfident = hasRef || hasFrom;
                const isFlagged = r.parsed && !validity.get(r.id)!.valid;
                const history = routingHistory[r.id] ?? [];
                const isRouted = history.length > 0;
                const isReversed = history.some((h) => /revers/i.test(h.reason || ''));
                // Auto-debited rows: a withdrawable debit posted by the
                // auto-debit run. Detected from the routing history reason
                // (prefixed "DEBIT (auto, ...)" or "DEBIT (sweep, ...)") so the
                // badge survives reloads. Matches both the realtime poller and
                // the backlog sweep.
                const autoDebitEntry = history.find(
                  (h) => h.route === 'withdrawable_debit' && /^DEBIT\b/i.test(h.reason || ''),
                );
                const isAutoDebited = !!autoDebitEntry && !isReversed;
                const autoImpact = autoDebitResults[r.id];
                // Whether the debit landed on a managed proxy agent's wallet
                // (user had insufficient balance). Detected from the reason
                // string written by the edge functions.
                const isProxyDebit = /via managed proxy/i.test(autoDebitEntry?.reason || '');
                const debitedName = autoDebitEntry?.target_user_name
                  || autoImpact?.userName || 'matched user';
                // Clean, human-readable reason for the debit. The edge function
                // writes "DEBIT (auto|sweep, <method>[, via managed proxy for
                // <partner>][, partial …]): <reason>". Split off the leading tag
                // so the breakdown can show the routing context and the reason
                // separately.
                const rawDebitReason = autoDebitEntry?.reason || '';
                const debitReasonText =
                  rawDebitReason.includes('):')
                    ? rawDebitReason.slice(rawDebitReason.indexOf('):') + 2).trim()
                    : rawDebitReason.trim();
                const debitProxyPartner = (() => {
                  const m = rawDebitReason.match(/via managed proxy for ([^,):]+)/i);
                  return m ? m[1].trim() : null;
                })();
                const debitIsPartial = /partial/i.test(rawDebitReason);
                const debitAmountValue = autoDebitEntry?.amount ?? autoImpact?.amount ?? Number(r.amount ?? 0);
                // The wallet that actually got charged. For a managed-proxy
                // debit this is the proxy agent's own wallet, so we can surface
                // their current ledger-derived balance straight on the email.
                const debitTargetId = autoDebitEntry?.target_user_id ?? null;
                const debitWalletBalance = debitTargetId ? userBalances[debitTargetId] : undefined;
                // Already-credited incoming deposit (linked to a non-terminal
                // deposit_request by the poller). Distinct emerald treatment
                // tells reviewers this email's money already landed in the
                // shown user's wallet — DO NOT credit again.
                const credited = creditedDeposits[r.id] ?? [];
                const manualMark = manualMarks[r.id];
                const isCredited = manualMark
                  ? manualMark.mark === 'credited'
                  : credited.length > 0;
                // Bank "received from WELILE TECHNOLOGIES LIMITED" echo of a
                // payout we already sent — never a real uncredited deposit.
                const isEcho = isWelileOutboundEcho(r);
                const totalCredited = credited.reduce((s, c) => s + c.amount, 0);
                const emailAmount = Number(r.amount ?? 0);
                const creditShortfall = emailAmount > 0 ? Math.max(0, emailAmount - totalCredited) : 0;
                const isFullyCredited = manualMark?.mark === 'credited'
                  ? true
                  : (emailAmount > 0 && totalCredited >= emailAmount);
                // True when at least one credited deposit was matched to this
                // email by its transaction reference (TID). Drives the clear
                // "Already Credited — No Routing Needed" status.
                const matchedByTid = credited.some((c) => c.matched_by_tid);
                const matchedTid = credited.find((c) => c.matched_tid)?.matched_tid ?? null;
                // Auto-credit provenance: which signal resolved the wallet and
                // how confident the matcher was. phone_source='body' at ≈0.6 is
                // the "possible user ≈60%" body-phone signal — surface it plainly
                // so reviewers know to spot-check those credits.
                const autoCredit = credited.find((c) => c.auto_confidence || c.auto_phone_source || c.auto_match_method);
                const autoConfidence = autoCredit?.auto_confidence ?? null;
                const autoScore = autoCredit?.auto_confidence_score ?? null;
                const autoPhoneSource = autoCredit?.auto_phone_source ?? null;
                const autoScorePct = typeof autoScore === 'number' ? Math.round(autoScore * 100) : null;
                const isBodyPhoneCredit = autoPhoneSource === 'body';
                // ── "Not Matched Yet" diagnostics ─────────────────────────
                // For an incoming deposit email that hasn't been credited or
                // routed, surface WHY it can't auto-map to a wallet: which of
                // the two reference signals (MoMo TID vs cash receipt code) the
                // email carries, and whether a depositing user was matched.
                const normTidForRow = normalizeMomoTid(r.transaction_id ?? '');
                const hasMomoTid = normTidForRow.length >= 6;
                const receiptCodeForRow = extractCashReceiptCode(r);
                const hasReceiptCode = !!receiptCodeForRow;
                const hasUserMatch = (userMatches[r.id]?.length ?? 0) > 0;
                // ── Insufficient-funds warning for outgoing payouts ───────
                // When an outgoing email (sent / charge) is matched to a
                // user wallet whose current balance cannot cover the payout
                // amount, this row is about to fail on debit. Make it
                // visually unignorable so reviewers don't blindly auto-debit
                // or approve a doomed withdrawal.
                const isOutgoing = r.direction === 'out' || r.direction === 'charge';
                const outAmount = Number(r.amount ?? 0);
                const rankedMatches = isOutgoing && outAmount > 0
                  ? [...matches]
                      .map((u) => {
                        const mo = u.matched_on;
                        const score = mo.startsWith('reference ')
                          ? 100
                          : mo.startsWith('from ') || mo.startsWith('to ')
                            ? 90
                            : mo.startsWith('name-')
                              ? 75
                              : 60;
                        return { u, score };
                      })
                      .sort((a, b) => b.score - a.score)
                  : [];
                const topMatch = rankedMatches[0]?.u;
                const topBal = topMatch ? userBalances[topMatch.id] : undefined;
                const isInsufficientPayout =
                  isOutgoing &&
                  !isRouted &&
                  outAmount > 0 &&
                  !!topMatch &&
                  typeof topBal === 'number' &&
                  topBal < outAmount;
                const shortfall = isInsufficientPayout
                  ? Math.max(0, outAmount - (topBal as number))
                  : 0;
                // Build a screen-reader description of the row's match status so
                // assistive tech announces *why* this row is highlighted, not
                // just that it's styled differently.
                const matchAriaLabel = isConfident
                  ? (() => {
                      const names = matches
                        .filter((u) => u.matched_on.startsWith('reference ') || u.matched_on.startsWith('from '))
                        .map((u) => u.full_name)
                        .slice(0, 3)
                        .join(', ');
                      const types = [hasRef && 'reference ID', hasFrom && 'sender phone'].filter(Boolean).join(' and ');
                      const extra = matches.length > 3 ? ` and ${matches.length - 3} more` : '';
                      return `Confident match by ${types}: ${names}${extra}`;
                    })()
                  : isFlagged
                    ? 'Flagged: parsed amount needs manual review'
                    : matches.length
                      ? `Possible user match (low confidence): ${matches.map((u) => u.full_name).slice(0, 3).join(', ')}`
                      : 'No depositing user matched';
                // Primary swipe action for this row — mirrors the on-row CTA:
                // incoming uncredited deposits go to a wallet (credit), outgoing
                // unrouted payouts charge a wallet (debit). Anything already
                // settled has no swipe action.
                const swipeAction: SwipeAction | null =
                  r.direction === 'in' && !isCredited && !isRouted && !isEcho
                    ? {
                        label: 'Send to wallet',
                        hint: 'Route deposit',
                        icon: <Zap className="h-5 w-5" />,
                        colorClass: 'bg-emerald-600',
                        onAction: () => setPendingSwipe({ row: r, mode: 'credit' }),
                        ariaLabel: `Send deposit of ${fmtUgx(Number(r.amount ?? 0))}${r.counterparty ? ` from ${r.counterparty}` : ''} to a wallet`,
                      }
                    : isOutgoing && !isRouted && !isAutoDebited && Number(r.amount ?? 0) > 0
                      ? {
                          label: 'Charge wallet',
                          hint: 'Debit user',
                          icon: <Wallet className="h-5 w-5" />,
                          colorClass: 'bg-rose-600',
                          onAction: () => setPendingSwipe({ row: r, mode: 'debit' }),
                          ariaLabel: `Charge wallet ${fmtUgx(Number(r.amount ?? 0))}${r.counterparty ? ` for payout to ${r.counterparty}` : ''}`,
                        }
                      : null;
                // Secondary swipe action (swipe RIGHT): for money-in rows that
                // still need attention, mark the email resolved without opening
                // the row. Already-settled rows instead open the full routing
                // history so operators can audit with one gesture.
                const swipeSecondaryAction: SwipeAction | null =
                  !manualMark && r.direction === 'in' && !isCredited
                    ? {
                        label: 'Mark resolved',
                        hint: 'Resolve',
                        icon: <CheckCircle2 className="h-5 w-5" />,
                        colorClass: 'bg-sky-600',
                        onAction: () => setPendingSwipe({ row: r, mode: 'resolve' }),
                        ariaLabel: `Mark this ${fmtUgx(Number(r.amount ?? 0))} email${r.counterparty ? ` from ${r.counterparty}` : ''} as resolved`,
                      }
                    : {
                        label: 'View history',
                        hint: 'History',
                        icon: <History className="h-5 w-5" />,
                        colorClass: 'bg-slate-600',
                        onAction: () => setHistoryDrawerRow(r),
                        ariaLabel: `View routing history for this ${fmtUgx(Number(r.amount ?? 0))} email`,
                      };
                // ── Consolidated "latest outcome" status ──────────────────
                // A single, plain-language pill shown at the top of the row so
                // reviewers can verify what happened to the money WITHOUT
                // opening the details view. Priority: reversed → credited →
                // charged/auto-debited → routed → still pending.
                const latestRouteEntry = history[0] ?? null;
                // Resolve the timestamp AND the exact underlying field it came
                // from, so the tooltip can label it precisely (e.g. the routing
                // history `created_at` vs a deposit's `credited_at` vs a manual
                // mark's `created_at`).
                const outcomeWhenSource: { when: string; label: string; field: string } | null =
                  latestRouteEntry?.created_at
                    ? {
                        when: latestRouteEntry.created_at,
                        label: isReversed
                          ? 'Reversed at'
                          : (latestRouteEntry.route === 'withdrawable_debit' || /^DEBIT\b/i.test(latestRouteEntry.reason || ''))
                            ? 'Charged at'
                            : 'Routed at',
                        field: 'email_routing_history.created_at',
                      }
                    : isCredited && credited[0]?.credited_at
                      ? {
                          when: credited[0].credited_at,
                          label: 'Credited at',
                          field: 'deposit_requests.credited_at',
                        }
                      : manualMark?.created_at
                        ? {
                            when: manualMark.created_at,
                            label: `Manually marked ${manualMark.mark === 'credited' ? 'paid in' : 'not paid in'} at`,
                            field: 'email_credit_manual_marks.created_at',
                          }
                        : null;
                const outcomeWhen = outcomeWhenSource?.when ?? null;
                const outcomeStatus: {
                  label: string;
                  detail: string;
                  tone: string;
                  tip: string;
                } | null = isReversed
                  ? {
                      label: 'Reversed',
                      detail: `Previous routing was reversed${latestRouteEntry?.routed_by_name ? ` by ${latestRouteEntry.routed_by_name}` : ''}.`,
                      tone: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
                      tip: 'A previous credit or charge was undone. The money is back where it started — re-route it to the correct wallet if needed.',
                    }
                  : isCredited
                    ? {
                        label: isFullyCredited ? 'Credited' : 'Partially credited',
                        detail: isFullyCredited
                          ? `${fmtUgx(totalCredited)} landed in the wallet.`
                          : `${fmtUgx(totalCredited)} of ${fmtUgx(emailAmount)} credited — ${fmtUgx(creditShortfall)} still short.`,
                        tone: isFullyCredited
                          ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
                          : 'bg-amber-500/15 text-amber-700 border-amber-500/30',
                        tip: isFullyCredited
                          ? 'The full email amount has already reached a user wallet. Nothing more to do — do not route it again.'
                          : 'Only part of the email amount has reached a wallet. Route the remaining shortfall to complete it.',
                      }
                    : isAutoDebited
                      ? {
                          label: isProxyDebit ? 'Charged (proxy)' : 'Charged',
                          detail: `${fmtUgx(debitAmountValue)} charged to ${debitedName}'s wallet${debitIsPartial ? ' (partial)' : ''}.`,
                          tone: 'bg-rose-500/15 text-rose-700 border-rose-500/30',
                          tip: isProxyDebit
                            ? "The user had insufficient balance, so this payout was charged to their managed proxy agent's wallet."
                            : "This payout was charged from the matched user's wallet. The money has left their balance.",
                        }
                      : isRouted && latestRouteEntry
                        ? {
                            label: 'Routed',
                            detail: `${fmtUgx(latestRouteEntry.amount ?? emailAmount)} routed to ${latestRouteEntry.target_user_name || 'a wallet'}${latestRouteEntry.routed_by_name ? ` by ${latestRouteEntry.routed_by_name}` : ''}.`,
                            tone: 'bg-violet-500/15 text-violet-700 border-violet-500/30',
                            tip: 'A staff member manually sent this money to a wallet. The recipient and who routed it are shown in the detail.',
                          }
                        : r.direction === 'in'
                          ? {
                              label: 'Awaiting routing',
                              detail: 'This deposit has not been sent to a wallet yet.',
                              tone: 'bg-muted text-muted-foreground border-border',
                              tip: 'Incoming money that has not reached any wallet. It still needs action — route it to the correct user.',
                            }
                          : isOutgoing && outAmount > 0
                            ? {
                                label: 'Not charged yet',
                                detail: 'This payout has not been charged to a wallet yet.',
                                tone: 'bg-muted text-muted-foreground border-border',
                                tip: "Outgoing money that has not been charged to any wallet yet. Charge it to the payer's wallet when ready.",
                              }
                            : null;
                return (
              <SwipeableEmailRow key={r.id} action={swipeAction} secondaryAction={swipeSecondaryAction}>
              <div
                role="article"
                aria-label={matchAriaLabel}
                data-match-status={isConfident ? 'confident' : isFlagged ? 'flagged' : 'none'}
                className={`p-4 transition-colors ${
                  isInsufficientPayout
                    // Loudest treatment in the list: thick destructive accent,
                    // tinted surface, persistent ring, and a slow pulse so
                    // the row catches the eye even when scrolling fast.
                    ? 'bg-destructive/15 hover:bg-destructive/20 border-l-8 border-l-destructive ring-2 ring-destructive/40 ring-inset shadow-sm focus-within:ring-2 focus-within:ring-destructive/60'
                    : isCredited
                    // Already-credited incoming deposits get a distinct
                    // treatment so reviewers can scan the list and see at a
                    // glance which emails have already landed in a wallet.
                    // Partial credits use amber (needs attention); fully
                    // credited use emerald (safe to skip).
                    ? isFullyCredited
                      ? 'bg-emerald-500/10 hover:bg-emerald-500/15 border-l-4 border-l-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/40'
                      : 'bg-amber-500/10 hover:bg-amber-500/15 border-l-4 border-l-amber-500 focus-within:ring-2 focus-within:ring-amber-500/40'
                    : isRouted
                    // Routed rows get a distinct violet treatment so reviewers
                    // can scan the list and immediately see which emails have
                    // already been re-routed (and how many times).
                    ? 'bg-violet-500/10 hover:bg-violet-500/15 border-l-4 border-l-violet-500 focus-within:ring-2 focus-within:ring-violet-500/40'
                    : isConfident
                    // Stronger primary tint (10/20 vs 5/10) + 4px accent border for
                    // clear contrast against the surrounding card surface. Adds a
                    // visible focus-within ring so keyboard users see the row.
                    ? 'bg-primary/10 hover:bg-primary/20 border-l-4 border-l-primary focus-within:ring-2 focus-within:ring-primary/40'
                    : isFlagged
                      ? 'bg-amber-500/10 hover:bg-amber-500/20 border-l-4 border-l-amber-500 focus-within:ring-2 focus-within:ring-amber-500/40'
                      : 'hover:bg-muted/40 border-l-4 border-l-transparent'
                }`}
              >
                {/* Visually hidden status line — keeps the announcement consistent
                    for SR users even if the visual chips reflow on narrow screens. */}
                <span className="sr-only">{matchAriaLabel}.</span>
                {outcomeStatus && (
                  // Consolidated latest routing/charging outcome, shown at the
                  // top of the row so reviewers can verify the result without
                  // opening the details view.
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <BadgeTip
                      plain={outcomeStatus.tip}
                      details={
                        outcomeWhenSource
                          ? `${outcomeWhenSource.label} ${new Date(outcomeWhenSource.when).toLocaleString()} (from ${outcomeWhenSource.field}).`
                          : 'No action has been recorded for this row yet.'
                      }
                    >
                      <Badge
                        variant="outline"
                        className={`text-[11px] font-semibold ${outcomeStatus.tone}`}
                      >
                        {outcomeStatus.label}
                      </Badge>
                    </BadgeTip>
                    <span className="text-[11px] text-muted-foreground min-w-0 truncate">
                      {outcomeStatus.detail}
                    </span>
                    {outcomeWhen && (
                      <span className="text-[10px] text-muted-foreground/80 whitespace-nowrap">
                        {new Date(outcomeWhen).toLocaleString()}
                      </span>
                    )}
                  </div>
                )}
                {isInsufficientPayout && (
                  // Unignorable banner above the row body. Explains the
                  // exact reason in plain language so reviewers can act
                  // (top up, change recipient, or skip) instead of pushing
                  // a debit that will bounce back with NEGATIVE_WALLET_BLOCKED.
                  <div
                    role="alert"
                    className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive"
                  >
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <div className="text-xs leading-snug">
                      <p className="font-semibold uppercase tracking-wide text-[11px]">
                        Insufficient funds — debit will be blocked
                      </p>
                      <p className="mt-0.5 text-destructive/90">
                        Payout of <strong>{fmtUgx(outAmount)}</strong> to{' '}
                        <strong>{topMatch?.full_name ?? 'matched user'}</strong>, but their wallet balance is only{' '}
                        <strong>{fmtUgx(topBal as number)}</strong>{' '}
                        (short by <strong>{fmtUgx(shortfall)}</strong>). Top up the wallet, pick a different recipient, or skip — do not auto-debit.
                      </p>
                    </div>
                  </div>
                )}
                {/* On phones the amount/action column drops to its own full-width
                    row underneath the details. Keeping it inline (shrink-0 with
                    non-wrapping button labels) squeezed the details column down
                    to ~120px and broke every sentence one word per line. */}
                <div className="flex flex-wrap items-start gap-x-3 gap-y-2 sm:flex-nowrap sm:justify-between sm:gap-4">
                  <div className="pt-0.5 shrink-0">
                    <Checkbox
                      checked={selectedIds.has(r.id)}
                      onCheckedChange={(v) => {
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (v) next.add(r.id); else next.delete(r.id);
                          return next;
                        });
                      }}
                      aria-label="Select email for bulk action"
                    />
                    {manualMark && (
                      <div
                        className={`mt-1 text-[9px] uppercase tracking-wide font-semibold ${
                          manualMark.mark === 'credited' ? 'text-emerald-600' : 'text-amber-600'
                        }`}
                        title={`${manualMark.mark} by ${manualMark.marked_by_name || manualMark.marked_by} at ${new Date(manualMark.created_at).toLocaleString()}${manualMark.reason ? ' — ' + manualMark.reason : ''}`}
                      >
                        {manualMark.mark === 'credited' ? '✓ marked paid in' : '↺ marked not paid in'}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 basis-[calc(100%-2.25rem)] sm:basis-auto">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate"><DialableNumber text={r.from_name || r.from_email || 'Unknown'} /></span>
                      {r.parsed ? (
                        <BadgeTip plain="We understood this email and found the money amount inside it.">
                          <Badge variant="secondary" className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/20">read OK</Badge>
                        </BadgeTip>
                      ) : (
                        <BadgeTip plain="We could not pull a money amount out of this email, so a person needs to look at it.">
                          <Badge variant="outline" className="text-[10px]">couldn't read</Badge>
                        </BadgeTip>
                      )}
                      {r.parsed && !validity.get(r.id)!.valid && (
                        <BadgeTip
                          plain="Something looks off about this email — please give it a quick look."
                          details={validity.get(r.id)!.reason}
                        >
                          <Badge
                            variant="outline"
                            className="text-[10px] bg-amber-500/10 text-amber-700 border-amber-500/30 gap-1"
                          >
                            <AlertTriangle className="h-3 w-3" /> please check
                          </Badge>
                        </BadgeTip>
                      )}
                      {(() => {
                        const resolved = ch(r);
                        if (resolved.channel === 'other') return null;
                        const inferred = !r.channel || r.channel === 'other';
                        const score = confidenceScore(resolved.confidence);
                        const tone =
                          resolved.confidence === 'authoritative' || resolved.confidence === 'high'
                            ? 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20'
                            : resolved.confidence === 'medium'
                            ? 'bg-sky-500/10 text-sky-700 border-sky-500/20'
                            : 'bg-amber-500/10 text-amber-700 border-amber-500/30';
                        // Multi-line tooltip explaining exactly which rule fired,
                        // which field on the row it inspected, and the matched
                        // fragment so reviewers can audit the inference.
                        const sourceLabel: Record<string, string> = {
                          transaction_id: 'transaction id',
                          subject: 'email subject',
                          snippet: 'email snippet',
                          from: 'sender',
                          body: 'email body',
                          parser: 'parser',
                        };
                        const lines = inferred
                          ? [
                              `Channel: ${resolved.channel.replace(/_/g, ' ')}`,
                              `Rule: ${resolved.signal}${resolved.rule ? ` (${resolved.rule})` : ''}`,
                              resolved.source ? `Matched in: ${sourceLabel[resolved.source] ?? resolved.source}` : null,
                              resolved.match ? `Match: "${resolved.match}"` : null,
                              `Confidence: ${resolved.confidence} (${score}%)`,
                            ]
                          : [
                              `Channel: ${resolved.channel.replace(/_/g, ' ')}`,
                              'Source: parser-assigned by the email importer',
                              `Confidence: ${resolved.confidence} (${score}%)`,
                            ];
                        const tip = lines.filter(Boolean).join('\n');
                        return (
                          <BadgeTip
                            plain="How we think this money was sent (the payment channel), and how sure we are."
                            details={tip}
                          >
                            <Badge
                              variant="outline"
                              className={`text-[10px] capitalize gap-1 ${tone}`}
                            >
                              {resolved.channel.replace(/_/g, ' ')}
                              {inferred && <span className="opacity-70">•</span>}
                              <span className="font-mono tabular-nums opacity-80">{score}%</span>
                            </Badge>
                          </BadgeTip>
                        );
                      })()}
                      <button
                        type="button"
                        onClick={() => setEditingRow(r)}
                        title="Fix channel & save a rule"
                        className="inline-flex items-center justify-center h-5 w-5 rounded border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/60"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      {r.direction && (
                        <BadgeTip
                          plain={
                            r.direction === 'in'
                              ? 'Money came in — a deposit or payment was received.'
                              : r.direction === 'out'
                              ? 'Money went out — a payment was sent.'
                              : 'A fee or charge, not a deposit.'
                          }
                        >
                          <Badge variant="outline" className={`text-[10px] capitalize ${
                            r.direction === 'in' ? 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20'
                            : r.direction === 'out' ? 'bg-rose-500/10 text-rose-700 border-rose-500/20'
                            : 'bg-amber-500/10 text-amber-700 border-amber-500/20'
                          }`}>{r.direction === 'in' ? 'money in' : r.direction === 'out' ? 'money out' : 'fee'}</Badge>
                        </BadgeTip>
                      )}
                      {r.transaction_id && (
                        <BadgeTip plain="The transaction / receipt code taken from this email. We use it to match the payment.">
                          <Badge variant="outline" className="text-[10px] font-mono">{r.transaction_id}</Badge>
                        </BadgeTip>
                      )}
                      {r.direction === 'in' && inviteSms[r.id] && (
                        <BadgeTip
                          plain={
                            inviteSms[r.id].status === 'sent'
                              ? 'The depositor was texted a link to sign up / log in to Welile.'
                              : 'We tried to text the depositor a sign-up / log-in link but it failed to send.'
                          }
                          details={[
                            `To: ${inviteSms[r.id].phone}`,
                            `Status: ${inviteSms[r.id].status}`,
                            `When: ${new Date(inviteSms[r.id].created_at).toLocaleString()}`,
                            inviteSms[r.id].error ? `Error: ${inviteSms[r.id].error}` : null,
                          ].filter(Boolean).join('\n')}
                        >
                          <Badge
                            variant="outline"
                            className={`text-[10px] gap-1 ${
                              inviteSms[r.id].status === 'sent'
                                ? 'bg-sky-500/10 text-sky-700 border-sky-500/30'
                                : 'bg-rose-500/10 text-rose-700 border-rose-500/30'
                            }`}
                          >
                            <Smartphone className="h-3 w-3" />
                            {inviteSms[r.id].status === 'sent' ? 'invite SMS sent' : 'invite SMS failed'}
                          </Badge>
                        </BadgeTip>
                      )}
                      {isRouted && (
                        <BadgeTip
                          plain={
                            isReversed
                              ? 'This money was sent again: the first credit was undone, then it was put in the right wallet.'
                              : 'A staff member already put this money into a user wallet.'
                          }
                          details={
                            isReversed
                              ? 'Re-routed with a reversal against the original auto-credit.'
                              : 'Manually routed by Financial Ops.'
                          }
                        >
                          <Badge
                            variant="outline"
                            className={`text-[10px] gap-1 ${
                              isReversed
                                ? 'bg-rose-500/10 text-rose-700 border-rose-500/30'
                                : 'bg-violet-500/15 text-violet-700 border-violet-500/30'
                            }`}
                          >
                            <ArrowRight className="h-3 w-3" />
                            {isReversed ? 'sent again (undone first)' : 'sent to wallet'}
                            {history.length > 1 && (
                              <span className="font-mono tabular-nums opacity-80">×{history.length}</span>
                            )}
                          </Badge>
                        </BadgeTip>
                      )}
                      {isAutoDebited && (
                        <BadgeTip
                          plain={isProxyDebit
                            ? "The user had too little balance, so this amount was automatically taken from their managed proxy agent's wallet."
                            : "The system automatically took this amount from the user's wallet."}
                          details={[
                            `Auto-debited from ${debitedName}'s withdrawable wallet${isProxyDebit ? ' (managed proxy agent)' : ''}`,
                            `Amount taken: ${fmtUgx(autoDebitEntry?.amount ?? autoImpact?.amount ?? r.amount)}`,
                            autoImpact && autoImpact.newAvail !== null
                              ? `Wallet left: ${fmtUgx(autoImpact.newAvail)}`
                              : null,
                          ].filter(Boolean).join('\n')}
                        >
                          <Badge
                            variant="outline"
                            className={`text-[10px] gap-1 ${isProxyDebit
                              ? 'bg-amber-600/15 text-amber-700 border-amber-600/40'
                              : 'bg-rose-600/15 text-rose-700 border-rose-600/40'}`}
                          >
                            <Zap className="h-3 w-3" />
                            {isProxyDebit ? 'proxy debited' : 'wallet debited'} −{fmtUgx(autoDebitEntry?.amount ?? autoImpact?.amount ?? r.amount)}
                            <span className="opacity-80">· {debitedName}{isProxyDebit ? ' (proxy)' : ''}</span>
                            {autoImpact && autoImpact.newAvail !== null && (
                              <span className="opacity-80">· left {fmtUgx(autoImpact.newAvail)}</span>
                            )}
                          </Badge>
                        </BadgeTip>
                      )}
                      {isCredited && (
                        <BadgeTip
                          plain={
                            isFullyCredited
                              ? 'The full amount has already landed in a user wallet. Do not send it again.'
                              : 'Only part of this amount has reached a wallet so far.'
                          }
                          details={[
                            `${isFullyCredited ? 'Fully credited' : 'Partially credited'} — DO NOT credit again`,
                            `Email amount: ${fmtUgx(emailAmount)}`,
                            `Total credited: ${fmtUgx(totalCredited)}`,
                            creditShortfall > 0 ? `Shortfall: ${fmtUgx(creditShortfall)}` : null,
                            ...credited.map((c, i) => [
                              `— Deposit ${i + 1}: ${c.deposit_id}`,
                              `  Recipient: ${c.user_name}${c.user_phone ? ' (' + c.user_phone + ')' : ''}`,
                              `  Amount: ${fmtUgx(c.amount)}`,
                              `  Status: ${c.status}${c.auto_approved ? ' · auto-approved' : ''}`,
                              c.deposit_purpose ? `  Purpose: ${c.deposit_purpose}` : null,
                              c.credited_at ? `  When: ${new Date(c.credited_at).toLocaleString()}` : null,
                            ].filter(Boolean).join('\n')),
                          ].filter(Boolean).join('\n')}
                        >
                          <Badge
                            variant="outline"
                            className={`text-[10px] gap-1 ${isFullyCredited ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40' : 'bg-amber-500/15 text-amber-700 border-amber-500/40'}`}
                          >
                            <CheckCircle2 className="h-3 w-3" />
                            {isFullyCredited ? 'paid into wallet' : 'partly paid in'} · {fmtUgx(totalCredited)}{creditShortfall > 0 ? ` / ${fmtUgx(emailAmount)}` : ''}
                            {credited.length > 1 && <span className="font-mono tabular-nums opacity-80">×{credited.length}</span>}
                          </Badge>
                        </BadgeTip>
                      )}
                      {/* Clear, unambiguous status: when the deposit is fully
                          credited there is nothing left to route. Highlight the
                          transaction reference (TID) when that's what matched it
                          so reviewers trust the auto-detection. */}
                      {isCredited && isFullyCredited && (
                        <BadgeTip
                          plain="This money is settled — it already reached a wallet. Do not send it again."
                          details={[
                            'Already Credited — No Routing Needed',
                            matchedByTid && matchedTid
                              ? `Matched by transaction reference (TID): ${matchedTid}`
                              : 'Matched to a credited deposit for this email.',
                          ].filter(Boolean).join('\n')}
                        >
                          <Badge
                            variant="outline"
                            className="text-[10px] gap-1 bg-emerald-600/15 text-emerald-700 border-emerald-600/50 font-semibold"
                          >
                            <ShieldCheck className="h-3 w-3" />
                            Already in a wallet — nothing to do
                            {matchedByTid && <span className="opacity-75">· via TID</span>}
                          </Badge>
                        </BadgeTip>
                      )}
                      {/* Auto-credit confidence + phone-source provenance. Shown
                          for any row auto-credited by the Gmail matcher so a
                          reviewer can instantly see whether it was a deterministic
                          counterparty-phone match (high) or the "possible user
                          ≈60%" body-phone signal (medium) that warrants a
                          spot-check. */}
                      {isCredited && autoConfidence && (
                        <BadgeTip
                          plain={
                            isBodyPhoneCredit
                              ? 'Auto-credited from the “possible user ≈60%” signal — a phone found in the email body matched exactly one user. Worth a quick spot-check.'
                              : 'Auto-credited from a deterministic match — the sender’s own phone number matched a known user.'
                          }
                          details={[
                            `Auto-credit confidence: ${autoConfidence}${autoScorePct != null ? ` (~${autoScorePct}%)` : ''}`,
                            `Phone source: ${autoPhoneSource === 'body' ? 'body (found inside the email)' : autoPhoneSource === 'counterparty' ? 'counterparty (the sender/recipient field)' : 'n/a'}`,
                            autoCredit?.auto_match_method ? `Match method: ${autoCredit.auto_match_method}` : null,
                          ].filter(Boolean).join('\n')}
                        >
                          <Badge
                            variant="outline"
                            className={`text-[10px] gap-1 font-semibold ${
                              autoConfidence === 'high'
                                ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40'
                                : autoConfidence === 'medium'
                                  ? 'bg-amber-500/15 text-amber-700 border-amber-500/40'
                                  : 'bg-orange-500/15 text-orange-700 border-orange-500/40'
                            }`}
                          >
                            {isBodyPhoneCredit ? <ShieldQuestion className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
                            {autoConfidence} confidence{autoScorePct != null ? ` · ~${autoScorePct}%` : ''}
                            <span className="opacity-75">· {autoPhoneSource === 'body' ? 'body phone' : autoPhoneSource === 'counterparty' ? 'sender phone' : autoCredit?.auto_match_method ?? 'auto'}</span>
                          </Badge>
                        </BadgeTip>
                      )}
                      {/* Incoming deposit whose money never landed in any
                          wallet (no credit + not routed). Flag it clearly and
                          explain which reference fields are missing so the
                          operator knows why it couldn't auto-map. */}
                      {r.parsed && r.direction === 'in' && !isCredited && !isRouted && !isEcho && (
                        <BadgeTip
                          plain="This money has not reached any wallet yet — it still needs to be sorted and sent to the right person."
                          details={[
                            'Not Matched Yet — this deposit has not been credited to any wallet.',
                            `MoMo TID: ${hasMomoTid ? normTidForRow : 'missing'}`,
                            `Receipt code: ${hasReceiptCode ? receiptCodeForRow : 'missing'}`,
                            `Depositing user: ${hasUserMatch ? 'matched' : 'not matched'}`,
                            'Use Redirect deposit to send it to the right wallet.',
                          ].join('\n')}
                        >
                          <Badge
                            variant="outline"
                            className="text-[10px] gap-1 bg-orange-500/20 text-orange-700 border-orange-500/50 font-semibold uppercase tracking-wide ring-1 ring-orange-500/30"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            Needs sorting
                          </Badge>
                        </BadgeTip>
                      )}
                      {/* Same clear status for incoming deposits that never even
                          parsed: still uncredited and unrouted, so they need ops
                          attention just as much. */}
                      {!r.parsed && r.direction === 'in' && !isCredited && !isRouted && !isEcho && (
                        <BadgeTip
                          plain="This money has not reached any wallet yet — it still needs to be sorted and sent to the right person."
                          details="Needs Routing — this incoming deposit email has not been credited to any wallet. Open it to route the money to the right user."
                        >
                          <Badge
                            variant="outline"
                            className="text-[10px] gap-1 bg-orange-500/20 text-orange-700 border-orange-500/50 font-semibold uppercase tracking-wide ring-1 ring-orange-500/30"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            Needs sorting
                          </Badge>
                        </BadgeTip>
                      )}
                      {/* Quick "Route Now" action — sits right next to the
                          Needs Routing badge so ops can jump straight into the
                          routing dialog without scanning across the row to the
                          amount-side CTA. Shown for any uncredited, unrouted
                          incoming deposit (parsed or not). Made very visible
                          with a large, pulsing emerald button. */}
                      {r.direction === 'in' && !isCredited && !isRouted && !isEcho && (
                        <Button
                          size="sm"
                          className="h-8 px-3 text-[11px] gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-500/30 ring-2 ring-emerald-400/60 ring-offset-1 animate-pulse"
                          title="Route this deposit now — search any user by name or number and credit it to their wallet."
                          onClick={() => navigateToRow(r, 'credit')}
                        >
                          <Wallet className="h-3.5 w-3.5" /> Credit to wallet
                        </Button>
                      )}
                      {/* Click-to-expand drilldown toggle. Opens a panel with the
                          linked proxy agent wallet change, the debit reason, and
                          the transaction references for this email. */}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[10px] gap-1 text-muted-foreground hover:text-foreground"
                        aria-expanded={expandedRows.has(r.id)}
                        title="Show wallet change, debit reason and transaction references for this email"
                        onClick={() => toggleRowExpanded(r.id)}
                      >
                        {expandedRows.has(r.id) ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        Details
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{r.subject || '(no subject)'}</p>
                    {/* Debit breakdown: when this email auto-charged a wallet,
                        spell out exactly which wallet was hit (the matched user
                        or a managed proxy agent), the charged person's name, the
                        amount, and the reason — so Financial Ops never has to
                        guess where the money came from. */}
                    {isAutoDebited && (
                      <div
                        className={`mt-1.5 rounded-md border px-2.5 py-1.5 text-[11px] ${
                          isProxyDebit
                            ? 'border-amber-500/40 bg-amber-500/10'
                            : 'border-rose-500/40 bg-rose-500/10'
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="uppercase tracking-wide font-semibold text-[9px] text-muted-foreground">
                            Debit breakdown
                          </span>
                          <Badge
                            variant="outline"
                            className={`text-[9px] px-1.5 py-0 ${
                              isProxyDebit
                                ? 'bg-amber-600/15 text-amber-700 border-amber-600/40'
                                : 'bg-rose-600/15 text-rose-700 border-rose-600/40'
                            }`}
                          >
                            {isProxyDebit ? 'Proxy agent wallet' : 'Matched user wallet'}
                          </Badge>
                          {debitIsPartial && (
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-orange-500/10 text-orange-700 border-orange-500/30">
                              partial
                            </Badge>
                          )}
                        </div>
                        <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5">
                          <p>
                            <span className="text-muted-foreground">Charged: </span>
                            <span className="font-semibold">{debitedName}</span>
                            {isProxyDebit && (
                              <span className="text-muted-foreground">
                                {' '}(proxy{debitProxyPartner ? ` for ${debitProxyPartner}` : ''})
                              </span>
                            )}
                          </p>
                          <p>
                            <span className="text-muted-foreground">Amount: </span>
                            <span className="font-semibold tabular-nums">−{fmtUgx(debitAmountValue)}</span>
                            {autoImpact && autoImpact.newAvail !== null && (
                              <span className="text-muted-foreground"> · left {fmtUgx(autoImpact.newAvail)}</span>
                            )}
                          </p>
                          {/* Linked proxy agent's live wallet balance — so
                              Financial Ops can see the charged proxy wallet
                              position right on the email without drilling in. */}
                          {isProxyDebit && (
                            <p className="sm:col-span-2">
                              <span className="text-muted-foreground">
                                Proxy wallet ({debitedName}):{' '}
                              </span>
                              <span className="font-semibold tabular-nums">
                                {debitWalletBalance === undefined
                                  ? 'loading…'
                                  : fmtUgx(debitWalletBalance)}
                              </span>
                            </p>
                          )}
                          {debitReasonText && (
                            <p className="sm:col-span-2">
                              <span className="text-muted-foreground">Reason: </span>
                              <span>{debitReasonText}</span>
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                    {/* "Not Matched Yet" details: show which reference signals
                        are present vs missing so reviewers know what to fix. */}
                    {r.parsed && r.direction === 'in' && !isCredited && !isRouted && !isEcho && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
                        <span className="uppercase tracking-wide font-semibold text-orange-600/90">Still missing:</span>
                        <span
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono ${hasMomoTid ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border-orange-500/40 bg-orange-500/10 text-orange-700'}`}
                          title={hasMomoTid ? `MoMo TID present: ${normTidForRow}` : 'No MoMo transaction ID parsed from this email'}
                        >
                          {hasMomoTid ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                          MoMo TID
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono ${hasReceiptCode ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border-orange-500/40 bg-orange-500/10 text-orange-700'}`}
                          title={hasReceiptCode ? `Receipt code present: ${receiptCodeForRow}` : 'No cash receipt code found in this email'}
                        >
                          {hasReceiptCode ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                          Receipt code
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 ${hasUserMatch ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border-orange-500/40 bg-orange-500/10 text-orange-700'}`}
                          title={hasUserMatch ? 'A depositing user was matched' : 'No depositing user matched'}
                        >
                          {hasUserMatch ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                          Who paid
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[10px] gap-1 border-orange-500/40 text-orange-700 hover:bg-orange-500/10"
                          title="Manually map this unmatched email to the correct wallet using the details above (MoMo TID, receipt code, depositing user)."
                          onClick={() => {
                            const matches = userMatches[r.id] ?? [];
                            const top = matches
                              .map((u) => ({
                                u,
                                s: u.matched_on.startsWith('reference ') ? 100
                                  : u.matched_on.startsWith('from ') ? 90
                                  : u.matched_on.startsWith('to ') ? 90
                                  : u.matched_on.startsWith('name-') ? 75
                                  : 60,
                              }))
                              .sort((a, b) => b.s - a.s)[0]?.u;
                            const matchedPhone = top?.matched_on.startsWith('from ') || top?.matched_on.startsWith('to ') || top?.matched_on.startsWith('phone ')
                              ? top.matched_on.replace(/^(from|to|phone)\s+/, '')
                              : null;
                            setRoutingSuggestedUser(top ? { id: top.id, full_name: top.full_name, phone: top.phone ?? '', matched_phone: matchedPhone } : null);
                            setRoutingMode('credit');
                            setRoutingRow(r);
                          }}
                        >
                          <Wrench className="h-3 w-3" />
                          Sort it myself
                        </Button>
                      </div>
                    )}
                    {/* "Why auto-credit was skipped" — for every incoming email
                        the poller did NOT auto-credit, show the exact gate
                        checklist it evaluated so ops can see which rule failed
                        (mirrors _tryAutoCreditOperationalFloat in the edge fn). */}
                    {r.direction === 'in' && !isCredited && !isRouted && !isEcho && (() => {
                      const gates = autoCreditGateReport({
                        amount: r.amount,
                        transactionId: r.transaction_id,
                        direction: r.direction,
                        channel: r.channel,
                        internalDate: r.internal_date,
                        hasUserMatch,
                        matchCount: matches.length,
                        isConfidentMatch: isConfident,
                      });
                      const failed = gates.filter((g) => !g.ok);
                      return (
                        <div className="mt-1.5 rounded-md border border-sky-500/30 bg-sky-500/5 px-2.5 py-1.5">
                          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-400">
                            <HelpCircle className="h-3 w-3" />
                            Why auto-credit was skipped
                            {failed.length > 0 && (
                              <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-sky-500/40 text-sky-700 dark:text-sky-400">
                                {failed.length} check{failed.length === 1 ? '' : 's'} failed
                              </Badge>
                            )}
                          </div>
                          {failed.length === 0 ? (
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              All auto-credit checks passed — if this hasn't landed in a wallet it may still be
                              processing or was reversed. Use “Send to wallet” to credit it manually.
                            </p>
                          ) : (
                            <ul className="mt-1 space-y-0.5">
                              {gates.map((g) => (
                                <li key={g.label} className="flex items-start gap-1.5 text-[11px] leading-snug">
                                  {g.ok
                                    ? <Check className="h-3 w-3 mt-0.5 shrink-0 text-emerald-600" />
                                    : <X className="h-3 w-3 mt-0.5 shrink-0 text-rose-600" />}
                                  <span className={g.ok ? 'text-muted-foreground' : 'text-foreground'}>
                                    <span className="font-medium">{g.label}</span>
                                    {!g.ok && <span className="text-rose-700 dark:text-rose-400"> — {g.reason}</span>}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })()}
                    {isCredited && (
                      <div className="mt-1.5 space-y-1">
                        {credited.map((c, i) => (
                          <p key={c.deposit_id} className={`text-[11px] inline-flex items-center gap-1.5 rounded border px-2 py-0.5 ${isFullyCredited ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border-amber-500/30 bg-amber-500/10 text-amber-700'}`}>
                            <Wallet className="h-3 w-3" />
                            <span className="font-mono opacity-70">#{i + 1}</span>
                            <strong className="font-semibold">{c.user_name}</strong>
                            {c.user_phone ? <span className="font-mono opacity-80">{c.user_phone}</span> : null}
                            <span className="opacity-70">·</span>
                            <span className="font-mono font-medium">{fmtUgx(c.amount)}</span>
                            <span className="opacity-70">·</span>
                            <span>{c.status}{c.auto_approved ? ' (auto)' : ''}</span>
                          </p>
                        ))}
                      </div>
                    )}
                    {(r.counterparty || r.fee || r.balance !== null) && (
                      <p className="text-[11px] text-muted-foreground/80 mt-0.5 flex flex-wrap gap-x-3">
                        {r.counterparty && <span>↔ <strong className="text-foreground/80"><DialableNumber text={r.counterparty} /></strong></span>}
                        {r.fee ? <span>fee {fmtUgx(r.fee)}</span> : null}
                        {r.balance !== null && r.balance !== undefined ? <span>bal {fmtUgx(r.balance)}</span> : null}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground/80 line-clamp-2 mt-1"><DialableNumber text={r.snippet} /></p>
                    {/* ── Click-to-expand drilldown ──────────────────────────
                        Surfaces the three things Financial Ops most often needs
                        when auditing an auto-debited email: the linked proxy
                        agent's wallet change, the exact debit reason, and every
                        transaction reference tied to the row. */}
                    {expandedRows.has(r.id) && (
                      <div className="mt-2 rounded-lg border border-border bg-muted/30 p-3 space-y-3 text-[11px]">
                        {/* Top-of-email credit CTA — the first thing an operator
                            sees when they open a deposit that has not reached a
                            wallet yet. Full-width and unmissable. */}
                        {r.direction === 'in' && !isCredited && !isRouted && !isEcho && (
                          <div className="rounded-lg border-2 border-emerald-500/60 bg-emerald-500/10 p-3 space-y-3">
                            <div className="flex items-start gap-2">
                              <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-800 dark:text-emerald-300 inline-flex items-center gap-1">
                                <AlertTriangle className="h-3.5 w-3.5" /> Not in any wallet yet
                              </p>
                            </div>
                            <p className="text-[11px] text-muted-foreground break-words">
                              {fmtUgx(r.amount)} received{r.counterparty ? ` from ${r.counterparty}` : ''} — search the user by phone or name and credit it.
                            </p>
                            <div className="flex flex-col sm:flex-row gap-2 items-end">
                              <div className="flex-1 min-w-0 w-full">
                                <UserSearchPicker
                                  label="Search user by phone / name"
                                  placeholder="Type phone number or name…"
                                  selectedUser={inlineRouteUsers[r.id] ?? null}
                                  onSelect={(user) => {
                                    setInlineRouteUsers((cur) => {
                                      const next = { ...cur };
                                      if (user) next[r.id] = user;
                                      else delete next[r.id];
                                      return next;
                                    });
                                  }}
                                />
                              </div>
                              <Button
                                size="lg"
                                disabled={!inlineRouteUsers[r.id]}
                                className="w-full sm:w-auto h-12 px-5 text-sm font-bold gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:animate-none text-white shadow-lg shadow-emerald-500/30 ring-2 ring-emerald-400/60 ring-offset-1 animate-pulse shrink-0"
                                title={inlineRouteUsers[r.id] ? `Credit this deposit to ${inlineRouteUsers[r.id].full_name}'s wallet` : 'Select a user first'}
                                onClick={() => {
                                  const u = inlineRouteUsers[r.id];
                                  if (!u) return;
                                  navigateToRow(r, 'credit', { id: u.id, full_name: u.full_name, phone: u.phone });
                                }}
                              >
                                <Wallet className="h-5 w-5" />
                                {inlineRouteUsers[r.id]
                                  ? `Credit ${inlineRouteUsers[r.id].full_name.split(' ')[0] || inlineRouteUsers[r.id].full_name}`
                                  : 'Credit to wallet'}
                              </Button>
                            </div>
                          </div>
                        )}
                        {/* 0) Full receipt — the complete parsed email so a phone
                            user never has to squint at truncated text. Every
                            field is stacked one-per-line on small screens. */}
                        <div className="space-y-1">
                          <p className="uppercase tracking-wide font-semibold text-[9px] text-muted-foreground inline-flex items-center gap-1">
                            <FileText className="h-3 w-3" />
                            Full receipt
                          </p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5">
                            <p><span className="text-muted-foreground">Amount: </span><span className="font-semibold tabular-nums">{fmtUgx(r.amount)}</span></p>
                            <p><span className="text-muted-foreground">Direction: </span><span className="font-semibold">{r.direction === 'in' ? 'Money in' : r.direction === 'charge' ? 'Charge' : r.direction === 'out' ? 'Money out' : '—'}</span></p>
                            {r.fee !== null && r.fee !== undefined && (
                              <p><span className="text-muted-foreground">Fee: </span><span className="tabular-nums">{fmtUgx(r.fee)}</span></p>
                            )}
                            {r.balance !== null && r.balance !== undefined && (
                              <p><span className="text-muted-foreground">Balance on receipt: </span><span className="tabular-nums">{fmtUgx(r.balance)}</span></p>
                            )}
                            <p className="break-words"><span className="text-muted-foreground">Counterparty: </span><span className="font-semibold">{r.counterparty ? <DialableNumber text={r.counterparty} /> : '—'}</span></p>
                            <p><span className="text-muted-foreground">Channel: </span>{r.channel || '—'}</p>
                            <p className="break-words sm:col-span-2"><span className="text-muted-foreground">Sender: </span>{r.from_name || '—'}{r.from_email ? ` · ${r.from_email}` : ''}</p>
                            <p className="sm:col-span-2"><span className="text-muted-foreground">Received: </span>{r.internal_date ? new Date(r.internal_date).toLocaleString('en-GB', { timeZone: tz }) : '—'}</p>
                          </div>
                          <p className="break-words"><span className="text-muted-foreground">Subject: </span>{r.subject || '(no subject)'}</p>
                          <div className="rounded border border-border bg-background p-2 whitespace-pre-wrap break-words leading-relaxed">
                            {r.snippet || 'No email body captured.'}
                          </div>
                        </div>
                        {/* 0b) Matching reasons — exactly why (or why not) this
                            email resolved to a wallet, in plain language. */}
                        <div className="space-y-1 border-t border-border/60 pt-2">
                          <p className="uppercase tracking-wide font-semibold text-[9px] text-muted-foreground inline-flex items-center gap-1">
                            <ShieldQuestion className="h-3 w-3" />
                            Matching reasons
                          </p>
                          {matches.length === 0 ? (
                            <p className="text-muted-foreground">
                              No user matched. {hasMomoTid || hasReceiptCode
                                ? 'A reference code exists, but no profile could be tied to it.'
                                : 'This email carries no MoMo transaction ID or cash receipt code, and no known phone/name was found in the body.'}
                            </p>
                          ) : (
                            <ul className="space-y-1">
                              {matches.map((u) => {
                                const mo = u.matched_on;
                                const why = mo.startsWith('reference ')
                                  ? 'Receipt code / transaction ID on the email matches this user\u2019s deposit reference (authoritative)'
                                  : mo.startsWith('from ')
                                    ? 'Phone number after "from" on the receipt matches this user\u2019s profile phone (strong)'
                                    : mo.startsWith('to ')
                                      ? 'Phone number after "to" on the receipt matches this user\u2019s profile phone (strong)'
                                      : mo.startsWith('name-to ')
                                        ? 'Name after "to" matches this user\u2019s mobile money name (medium)'
                                        : mo.startsWith('name-from ')
                                          ? 'Name after "from" matches this user\u2019s mobile money name (medium)'
                                          : 'A phone number found in the email body matches this user (weak \u2014 spot-check before crediting)';
                                return (
                                  <li key={`${u.id}-${mo}`} className="rounded border border-border bg-background px-2 py-1">
                                    <p className="font-semibold break-words">{u.full_name}{u.phone ? ` · ${u.phone}` : ''}</p>
                                    <p className="text-muted-foreground break-words">{why}</p>
                                    <p className="font-mono text-[10px] text-muted-foreground/70 break-words">signal: {mo}</p>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                          {autoConfidence && (
                            <p className="text-muted-foreground">
                              Auto-credit confidence: <span className="font-semibold">{autoConfidence}</span>
                              {autoScorePct !== null ? ` (${autoScorePct}%)` : ''}
                              {autoPhoneSource ? ` · phone signal from ${autoPhoneSource}` : ''}
                            </p>
                          )}
                        </div>
                        {/* 1) Linked proxy / matched wallet change */}
                        {isAutoDebited ? (
                          <div className="space-y-1">
                            <p className="uppercase tracking-wide font-semibold text-[9px] text-muted-foreground inline-flex items-center gap-1">
                              <Wallet className="h-3 w-3" />
                              {isProxyDebit ? 'Linked proxy agent wallet change' : 'Matched user wallet change'}
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5">
                              <p>
                                <span className="text-muted-foreground">Wallet owner: </span>
                                <span className="font-semibold">{debitedName}</span>
                                {isProxyDebit && (
                                  <span className="text-muted-foreground">
                                    {' '}(proxy{debitProxyPartner ? ` for ${debitProxyPartner}` : ''})
                                  </span>
                                )}
                              </p>
                              <p>
                                <span className="text-muted-foreground">Amount debited: </span>
                                <span className="font-semibold tabular-nums text-rose-700">−{fmtUgx(debitAmountValue)}</span>
                                {debitIsPartial && <span className="text-muted-foreground"> · partial</span>}
                              </p>
                              {autoImpact && autoImpact.newAvail !== null ? (
                                <p>
                                  <span className="text-muted-foreground">Balance before → after: </span>
                                  <span className="font-mono tabular-nums">{fmtUgx(autoImpact.newAvail + debitAmountValue)}</span>
                                  <ArrowRight className="inline h-3 w-3 mx-1 align-middle" />
                                  <span className="font-mono tabular-nums font-semibold">{fmtUgx(autoImpact.newAvail)}</span>
                                </p>
                              ) : null}
                              <p>
                                <span className="text-muted-foreground">Wallet now: </span>
                                <span className="font-semibold tabular-nums">
                                  {debitWalletBalance === undefined ? 'loading…' : fmtUgx(debitWalletBalance)}
                                </span>
                              </p>
                            </div>
                          </div>
                        ) : (
                          <p className="text-muted-foreground">No wallet was auto-debited for this email.</p>
                        )}
                        {/* 2) Debit reason */}
                        {isAutoDebited && (
                          <div className="space-y-0.5 border-t border-border/60 pt-2">
                            <p className="uppercase tracking-wide font-semibold text-[9px] text-muted-foreground inline-flex items-center gap-1">
                              <Info className="h-3 w-3" />
                              Debit reason
                            </p>
                            <p>{debitReasonText || '—'}</p>
                            {rawDebitReason && rawDebitReason !== debitReasonText && (
                              <p className="font-mono text-[10px] text-muted-foreground/80 break-words">{rawDebitReason}</p>
                            )}
                          </div>
                        )}
                        {/* 3) Transaction references */}
                        <div className="space-y-1 border-t border-border/60 pt-2">
                          <p className="uppercase tracking-wide font-semibold text-[9px] text-muted-foreground inline-flex items-center gap-1">
                            <LinkIcon className="h-3 w-3" />
                            Transaction references
                          </p>
                          <div className="flex flex-wrap gap-1.5 font-mono text-[10px]">
                            {r.transaction_id && (
                              <span className="rounded border border-border bg-background px-1.5 py-0.5">TID: {r.transaction_id}</span>
                            )}
                            {hasMomoTid && (
                              <span className="rounded border border-border bg-background px-1.5 py-0.5">MoMo: {normTidForRow}</span>
                            )}
                            {hasReceiptCode && (
                              <span className="rounded border border-border bg-background px-1.5 py-0.5">Receipt: {receiptCodeForRow}</span>
                            )}
                            <span className="rounded border border-border bg-background px-1.5 py-0.5">Msg: {r.gmail_message_id}</span>
                          </div>
                          {history.length > 0 && (
                            <div className="space-y-0.5 pt-1">
                              <p className="text-[9px] uppercase tracking-wide text-muted-foreground/80">Routing ledger entries</p>
                              {history.map((h) => (
                                <p key={h.id} className="font-mono text-[10px] text-muted-foreground/90 break-words">
                                  {format(new Date(h.created_at), 'MMM d HH:mm')} · {h.route} · {fmtUgx(h.amount)} · ref {h.id}
                                </p>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {userMatches[r.id]?.length ? (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold inline-flex items-center gap-1">
                          {userMatches[r.id].length > 1 ? <Users className="h-3 w-3" /> : null}
                          {(() => {
                            const isOut = r.direction === 'out' || r.direction === 'charge';
                            const noun = isOut ? 'recipient' : 'user';
                            return userMatches[r.id].length > 1
                              ? `${userMatches[r.id].length} possible ${noun}s:`
                              : `Possible ${noun}:`;
                          })()}
                        </span>
                        <TooltipProvider delayDuration={150}>
                          {[...userMatches[r.id]]
                            .map((u) => {
                              const isRef = u.matched_on.startsWith('reference ');
                              const isFrom = u.matched_on.startsWith('from ');
                              const isTo = u.matched_on.startsWith('to ');
                              const isName = u.matched_on.startsWith('name-');
                              const score = isRef ? 100 : isFrom || isTo ? 90 : isName ? 75 : 60;
                              return { u, score };
                            })
                            .sort((a, b) => b.score - a.score)
                            .map(({ u, score }, idx, arr) => {
                            const isRef = u.matched_on.startsWith('reference ');
                            const isFrom = u.matched_on.startsWith('from ');
                            const isTo = u.matched_on.startsWith('to ');
                            const isNameTo = u.matched_on.startsWith('name-to ');
                            const isNameFrom = u.matched_on.startsWith('name-from ');
                            const isName = isNameTo || isNameFrom;
                            const strong = isRef || isFrom || isTo || isName;
                            const matchType = isRef
                              ? 'Reference (TID)'
                              : isFrom
                                ? 'Phone after "from"'
                                : isTo
                                  ? 'Phone after "to"'
                                  : isNameTo
                                    ? 'Name after "to"'
                                    : isNameFrom
                                      ? 'Name after "from"'
                                      : 'Phone in email body';
                            const confidenceLabel = isRef
                              ? 'authoritative'
                              : isFrom || isTo
                                ? 'high'
                                : isName
                                  ? 'medium-high'
                                  : 'medium';
                            const matchedValue = u.matched_on.replace(/^(reference|from|to|phone|name-to|name-from)\s+/, '');
                            const shortLabel = isRef
                              ? 'ref'
                              : isFrom
                                ? 'from'
                                : isTo
                                  ? 'to'
                                  : isNameTo
                                    ? 'name→'
                                    : isNameFrom
                                      ? 'name←'
                                      : 'phone';
                            const isPrimary = idx === 0 && arr.length > 1;
                            // Always-visible confidence indicator: tier word + one-line
                            // "why" so ops can pick the right destination without hovering.
                            const tier = score >= 100 ? 'Certain' : score >= 90 ? 'High' : score >= 75 ? 'Likely' : 'Weak';
                            const tierClass = score >= 100
                              ? 'bg-emerald-600 text-white border-emerald-600'
                              : score >= 90
                                ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40'
                                : score >= 75
                                  ? 'bg-amber-500/15 text-amber-700 border-amber-500/40'
                                  : 'bg-muted text-muted-foreground border-border';
                            const whyText = `${matchType}: ${matchedValue}`;
                            // Visual hierarchy:
                            //  - primary (top-scoring when there are multiple matches): filled + Star
                            //  - other strong matches: filled (no star)
                            //  - weak matches: tinted outline
                            const badgeClass = isPrimary
                              ? 'bg-primary text-primary-foreground border-primary ring-2 ring-primary/50 shadow-sm'
                              : strong
                                ? 'bg-primary text-primary-foreground border-primary ring-1 ring-primary/30'
                                : 'bg-primary/10 text-primary border-primary/30';
                            return (
                              <Fragment key={u.id}>
                              <span className="inline-flex flex-col gap-0.5">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge
                                    variant="outline"
                                    className={`text-[10px] gap-1 cursor-help ${badgeClass}`}
                                  >
                                    {isPrimary
                                      ? <Star className="h-3 w-3 fill-current" />
                                      : strong
                                        ? <CheckCircle2 className="h-3 w-3" />
                                        : null}
                                    <span className="font-medium">{u.full_name}</span>
                                    <span className="opacity-70">· {shortLabel}</span>
                                    <span className="font-mono tabular-nums opacity-80">{score}%</span>
                                    <span className="font-mono tabular-nums opacity-90 border-l border-current/30 pl-1 ml-0.5 inline-flex items-center gap-0.5">
                                      <Wallet className="h-2.5 w-2.5" />
                                      {userBalances[u.id] === undefined
                                        ? '…'
                                        : Math.round(userBalances[u.id]).toLocaleString()}
                                    </span>
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-xs text-xs">
                                  <div className="space-y-0.5">
                                    <p className="font-semibold flex items-center gap-1">
                                      {isPrimary && <Star className="h-3 w-3 fill-current text-primary" />}
                                      {u.full_name}
                                      {isPrimary && <span className="text-[10px] uppercase tracking-wide text-primary font-bold">· Primary</span>}
                                    </p>
                                    <p>
                                      <span className="text-muted-foreground">Match type: </span>
                                      {matchType}
                                    </p>
                                    <p className="font-mono">
                                      <span className="text-muted-foreground font-sans">Matched value: </span>
                                      {matchedValue}
                                    </p>
                                    <p>
                                      <span className="text-muted-foreground">Confidence: </span>
                                      {confidenceLabel} ({score}%)
                                    </p>
                                    {arr.length > 1 && (
                                      <p className="text-muted-foreground pt-0.5 border-t mt-1">
                                        {isPrimary
                                          ? `Top match of ${arr.length} candidates — primary attribution.`
                                          : `Secondary match (rank ${idx + 1} of ${arr.length}). Review before attributing.`}
                                      </p>
                                    )}
                                    {u.phone && (
                                      <p className="font-mono">
                                        <span className="text-muted-foreground font-sans">Phone: </span>
                                        {u.phone}
                                      </p>
                                    )}
                                    {u.mobile_money_number && u.mobile_money_number !== u.phone && (
                                      <p className="font-mono">
                                        <span className="text-muted-foreground font-sans">MoMo: </span>
                                        {u.mobile_money_number}
                                      </p>
                                    )}
                                    <p className="font-mono pt-0.5 border-t mt-1">
                                      <span className="text-muted-foreground font-sans inline-flex items-center gap-1">
                                        <Wallet className="h-3 w-3" /> Wallet:{' '}
                                      </span>
                                      {userBalances[u.id] === undefined
                                        ? '…'
                                        : `UGX ${Math.round(userBalances[u.id]).toLocaleString()}`}
                                    </p>
                                    {(userRecentTx[u.id]?.length ?? 0) > 0 && (
                                      <div className="pt-1 mt-1 border-t">
                                        <p className="text-muted-foreground font-sans text-[10px] uppercase tracking-wider mb-0.5">
                                          Last {Math.min(3, userRecentTx[u.id].length)} wallet tx
                                        </p>
                                        <ul className="space-y-0.5">
                                          {userRecentTx[u.id].slice(0, 3).map((t) => {
                                            const isIn = t.direction === 'cash_in' || t.direction === 'credit';
                                            return (
                                              <li key={t.id} className="flex items-center justify-between gap-2 font-sans">
                                                <span className="truncate">
                                                  <span className={isIn ? 'text-emerald-600' : 'text-rose-600'}>
                                                    {isIn ? '+' : '−'}{Math.round(t.amount).toLocaleString()}
                                                  </span>{' '}
                                                  <span className="text-muted-foreground">· {t.category}</span>
                                                </span>
                                                <span className="text-muted-foreground/70 text-[10px] shrink-0">
                                                  {format(new Date(t.created_at), 'MMM d HH:mm')}
                                                </span>
                                              </li>
                                            );
                                          })}
                                        </ul>
                                      </div>
                                    )}
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                              <span className="inline-flex items-center gap-1 pl-0.5">
                                <Badge variant="outline" className={`text-[9px] px-1 py-0 leading-4 ${tierClass}`}>
                                  {tier} · {score}%
                                </Badge>
                                <span className="text-[9px] text-muted-foreground truncate max-w-[180px]" title={whyText}>
                                  {whyText}
                                </span>
                              </span>
                              </span>
                              {(r.direction === 'out' || r.direction === 'charge') && userProxies[u.id] && (
                                <ProxyDebitBreakdownDialog
                                  partner={{ id: u.id, name: u.full_name }}
                                  proxy={userProxies[u.id]}
                                  onChanged={() => setUserBalances({})}
                                >
                                  <Badge
                                    variant="outline"
                                    role="button"
                                    title={`See proxy-wallet debits charged for ${u.full_name}`}
                                    className="text-[10px] gap-1 cursor-pointer border-amber-500/50 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20"
                                  >
                                    <Users className="h-2.5 w-2.5" />
                                    <span className="font-medium">proxy: {userProxies[u.id].agentName || 'agent'}</span>
                                    <span className="font-mono tabular-nums opacity-90 border-l border-current/30 pl-1 ml-0.5 inline-flex items-center gap-0.5">
                                      <Wallet className="h-2.5 w-2.5" />
                                      {userBalances[userProxies[u.id].agentId] === undefined
                                        ? '…'
                                        : Math.round(userBalances[userProxies[u.id].agentId]).toLocaleString()}
                                    </span>
                                  </Badge>
                                </ProxyDebitBreakdownDialog>
                              )}
                              </Fragment>
                            );
                          })}
                        </TooltipProvider>
                      </div>
                    ) : null}
                    {isRouted && (
                      <div className="mt-2 rounded-md border border-violet-500/20 bg-violet-500/5 p-2">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <p className="text-[10px] uppercase tracking-wider text-violet-700 font-semibold flex items-center gap-1">
                            <History className="h-3 w-3" /> Routing history ({history.length})
                          </p>
                          <button
                            type="button"
                            onClick={() => setHistoryDrawerRow(r)}
                            className="text-[10px] font-medium text-violet-700 underline underline-offset-2 hover:text-violet-800 min-h-11 sm:min-h-0 px-1"
                          >
                            View full history
                          </button>
                        </div>
                        <ul className="space-y-1">
                          {history.slice(0, 4).map((h) => {
                            const reversal = /revers/i.test(h.reason || '');
                            const busy = !!reverseBusy[h.id];
                            const bal = userBalances[h.target_user_id];
                            return (
                              <li
                                key={h.id}
                                className="text-[11px] flex items-start gap-1.5 leading-snug"
                              >
                                <span
                                  className={`mt-[3px] h-1.5 w-1.5 rounded-full shrink-0 ${
                                    reversal ? 'bg-rose-500' : 'bg-violet-500'
                                  }`}
                                />
                                <span className="flex-1 min-w-0">
                                  <span className="font-medium text-foreground">
                                    {reversal ? 'Reversed from' : '→'} {h.target_user_name || 'Unknown user'}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {' '}· {h.route === 'operational_float' ? 'Operational Float' : 'Personal Deposit'}
                                    {' '}· UGX {Number(h.amount).toLocaleString()}
                                  </span>
                                  <span className="block text-muted-foreground/80 text-[10px]">
                                    {h.routed_by_name ? `by ${h.routed_by_name} · ` : ''}
                                    {format(new Date(h.created_at), 'MMM d, HH:mm')}
                                    {h.sms_sent ? ' · SMS sent' : ''}
                                  </span>
                                  <span className="mt-1 flex items-center gap-2 flex-wrap">
                                    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                                      <Wallet className="h-3 w-3" />
                                      Wallet now:{' '}
                                      <strong className="font-mono tabular-nums text-foreground/80">
                                        {bal === undefined ? '…' : `UGX ${Math.round(bal).toLocaleString()}`}
                                      </strong>
                                    </span>
                                    {!reversal && (
                                      <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => reverseRoutingEntry(r, h)}
                                        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-rose-300 text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-60"
                                        title="Post the opposite ledger leg against the same user/bucket"
                                      >
                                        {busy
                                          ? <Loader2 className="h-3 w-3 animate-spin" />
                                          : <Undo2 className="h-3 w-3" />}
                                        Reverse
                                      </button>
                                    )}
                                  </span>
                                </span>
                              </li>
                            );
                          })}
                          {history.length > 4 && (
                            <li className="pl-3">
                              <button
                                type="button"
                                onClick={() => setHistoryDrawerRow(r)}
                                className="text-[10px] font-medium text-violet-700 underline underline-offset-2 hover:text-violet-800"
                              >
                                + {history.length - 4} more — view full history
                              </button>
                            </li>
                          )}
                        </ul>
                      </div>
                    )}
                  </div>
                  <div className="w-full sm:w-auto shrink-0 text-left sm:text-right flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 pt-2 sm:mt-0 sm:block sm:border-0 sm:pt-0">
                    <p className={`font-mono font-semibold text-sm ${r.amount ? 'text-emerald-600' : 'text-muted-foreground'}`}>{fmtUgx(r.amount)}</p>
                    <p className="text-[10px] text-muted-foreground sm:mt-0.5">
                      {r.internal_date ? format(new Date(r.internal_date), 'MMM d, HH:mm') : '—'}
                    </p>
                    {r.amount && r.amount > 0 && r.direction !== 'out' && (
                      (() => {
                        // Money that has NOT landed in any wallet (not auto-credited
                        // and not already routed) gets a loud, filled CTA so ops can
                        // immediately search out ANY user and drop it into their
                        // wallet. Already-handled rows keep the quiet outline button.
                        const needsWallet = !isCredited && !isRouted;
                        return (
                      <Button
                        size="default"
                        variant={needsWallet ? 'default' : 'outline'}
                        className={`mt-1.5 h-10 sm:h-9 text-xs sm:text-[11px] gap-1.5 font-semibold ${
                          needsWallet
                            ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-500/30 ring-2 ring-emerald-400/60 ring-offset-1 animate-pulse'
                            : ''
                        }`}
                        title={
                          needsWallet
                            ? 'This money is not in any wallet yet. Search any user by name or number and credit it to their wallet.'
                            : isRouted && !isReversed
                              ? 'Already routed to a user. You can still route it to a different user — routing it to the same user again will be blocked.'
                              : 'Route this deposit to a user wallet'
                        }
                        onClick={() => {
                          const matches = userMatches[r.id] ?? [];
                          const top = matches
                            .map((u) => ({
                              u,
                              s: u.matched_on.startsWith('reference ') ? 100
                                : u.matched_on.startsWith('from ') ? 90
                                : u.matched_on.startsWith('to ') ? 90
                                : u.matched_on.startsWith('name-') ? 75
                                : 60,
                            }))
                            .sort((a, b) => b.s - a.s)[0]?.u;
                          const matchedPhone = top?.matched_on.startsWith('from ') || top?.matched_on.startsWith('to ') || top?.matched_on.startsWith('phone ')
                            ? top.matched_on.replace(/^(from|to|phone)\s+/, '')
                            : null;
                          setRoutingSuggestedUser(top ? { id: top.id, full_name: top.full_name, phone: top.phone ?? '', matched_phone: matchedPhone } : null);
                          setRoutingMode('credit');
                          setRoutingRow(r);
                        }}
                      >
                        {needsWallet
                          ? <><Wallet className="h-4 w-4" /> Credit to wallet</>
                          : isRouted && !isReversed
                            ? <>Route to another user <ArrowRight className="h-3.5 w-3.5" /></>
                            : <>Route to user <ArrowRight className="h-3.5 w-3.5" /></>}
                      </Button>
                        );
                      })()
                    )}
                    {r.amount && r.amount > 0 && (r.direction === 'out' || r.direction === 'charge') && (
                      (() => {
                        const wMatches = withdrawalMatches[r.id] ?? [];
                        if (wMatches.length !== 1) return null;
                        const m = wMatches[0];
                        const busy = !!autoApproving[r.id];
                        return (
                          <Button
                            size="sm"
                            variant="default"
                            className="mt-1.5 h-8 sm:h-7 text-[11px] gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                            disabled={busy}
                            title={`Match: withdrawal ${m.id.slice(0,8)}… for ${m.user_name || 'user'} (${m.mobile_money_number || m.bank_account_number || '—'}) · ${m.matched_on}`}
                            onClick={() => autoApproveWithdrawal(r, m)}
                          >
                            {busy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <CheckCircle2 className="h-3 w-3" />
                            )}
                            Auto-approve payout
                          </Button>
                        );
                      })()
                    )}
                    {r.amount && r.amount > 0 && (r.direction === 'out' || r.direction === 'charge') && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-1.5 h-8 sm:h-7 text-[11px] gap-1 border-rose-300 text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                        title={
                          isRouted && !isReversed
                            ? 'Already debited from a user. You can still debit a different user — debiting the same user again will be blocked.'
                            : 'Debit this outflow from a user wallet'
                        }
                        onClick={() => {
                          const matches = userMatches[r.id] ?? [];
                          const top = matches
                            .map((u) => ({
                              u,
                              s: u.matched_on.startsWith('reference ') ? 100
                                : u.matched_on.startsWith('to ') ? 90
                                : u.matched_on.startsWith('from ') ? 90
                                : u.matched_on.startsWith('name-') ? 75
                                : 60,
                            }))
                            .sort((a, b) => b.s - a.s)[0]?.u;
                          const matchedPhone = top?.matched_on.startsWith('to ') || top?.matched_on.startsWith('from ') || top?.matched_on.startsWith('phone ')
                            ? top.matched_on.replace(/^(to|from|phone)\s+/, '')
                            : null;
                          setRoutingSuggestedUser(top ? { id: top.id, full_name: top.full_name, phone: top.phone ?? '', matched_phone: matchedPhone } : null);
                          setRoutingMode('debit');
                          setRoutingRow(r);
                        }}
                      >
                        {isRouted && !isReversed ? <>Debit a different user <ArrowRight className="h-3 w-3" /></> : <>Debit user wallet <ArrowRight className="h-3 w-3" /></>}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
              </SwipeableEmailRow>
                );
              });
            })()}
            {/* Infinite-scroll sentinel: when this scrolls into view the list
                grows by one more page. Only rendered in infinite mode while
                there are still more rows to reveal. */}
            {paginationMode === 'infinite'
              && infiniteCount < visibleRows.length
              && (
              <div
                ref={infiniteSentinelRef}
                className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading {Math.min(pageSize, visibleRows.length - infiniteCount).toLocaleString()} more
                {' '}({(visibleRows.length - infiniteCount).toLocaleString()} left)
              </div>
            )}
          </div>
        )}
        {/* Pagination controls — only shown when there's more than one page. */}
        {!loading && rows.length > 0 && (() => {
          const meta = (typeof window !== 'undefined' ? (window as any).__emailPaginationMeta : null) as
            | { totalPages: number; safePage: number; total: number; mode?: PaginationMode; shownCount?: number }
            | null;
          if (!meta) return null;
          const { totalPages, safePage, total } = meta;
          const isInfinite = paginationMode === 'infinite';
          const shownCount = isInfinite ? Math.min(infiniteCount, total) : 0;
          const from = total === 0 ? 0 : isInfinite ? 1 : (safePage - 1) * pageSize + 1;
          const to = isInfinite ? shownCount : Math.min(safePage * pageSize, total);
          return (
            <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 text-xs">
              <div className="text-muted-foreground tabular-nums">
                Showing <span className="font-medium text-foreground">{from.toLocaleString()}–{to.toLocaleString()}</span> of{' '}
                <span className="font-medium text-foreground">{total.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 gap-1"
                  title={isInfinite ? 'Switch to paged navigation' : 'Switch to infinite scroll'}
                  onClick={() => setPaginationMode((m) => (m === 'infinite' ? 'paged' : 'infinite'))}
                >
                  {isInfinite ? 'Use pages' : 'Infinite scroll'}
                </Button>
                <label className="text-muted-foreground">Rows:</label>
                <select
                  value={pageSize}
                  onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}
                  className="h-7 rounded border border-input bg-background px-2 text-xs"
                >
                  {[25, 50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                {isInfinite ? (
                  to < total ? (
                    <Button size="sm" variant="outline" className="h-8 px-3"
                      onClick={() => setInfiniteCount((c) => Math.min(c + pageSize, total))}>
                      Load {Math.min(pageSize, total - to)} more
                    </Button>
                  ) : (
                    <span className="text-muted-foreground px-1">All loaded</span>
                  )
                ) : (
                  <>
                    <Button size="sm" variant="outline" className="h-8 px-2 hidden sm:inline-flex"
                      onClick={() => goToPage(1)} disabled={safePage <= 1}>« First</Button>
                    <Button size="sm" variant="outline" className="h-8 px-3"
                      onClick={() => goToPage(Math.max(1, safePage - 1))} disabled={safePage <= 1}>‹ Prev</Button>
                    <span className="tabular-nums text-muted-foreground px-1">Page {safePage} / {totalPages}</span>
                    <Button size="sm" variant="outline" className="h-8 px-3"
                      onClick={() => goToPage(Math.min(totalPages, safePage + 1))} disabled={safePage >= totalPages}>Next ›</Button>
                    <Button size="sm" variant="outline" className="h-8 px-2 hidden sm:inline-flex"
                      onClick={() => goToPage(totalPages)} disabled={safePage >= totalPages}>Last »</Button>
                  </>
                )}
              </div>
            </div>
          );
        })()}
          </div>
        </div>
      </div>
      )}

      {/* Action buttons on inbox tabs */}
      {(workspaceTab === 'inbox' || workspaceTab === 'needs_review' || workspaceTab === 'settled') && (
        <div className="rounded-xl border bg-card p-3 flex flex-col gap-3">

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={pollNow} disabled={polling} className="gap-2 flex-1 sm:flex-none min-w-[130px]">
            {polling ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Poll now
          </Button>
          <Button
            variant="outline"
            onClick={() => exportTotalsCsv({ rows: filteredRows, totalIn, totalOut, netAmount, channelBreakdown })}
            disabled={filteredRows.length === 0}
            className="gap-2 flex-1 sm:flex-none min-w-[120px]"
          >
            <FileDown className="h-4 w-4" /> Export CSV
          </Button>
          <Button
            variant="outline"
            onClick={() => exportTotalsPdf({ rows: filteredRows, totalIn, totalOut, netAmount, channelBreakdown })}
            disabled={filteredRows.length === 0}
            className="gap-2 flex-1 sm:flex-none min-w-[120px]"
          >
            <FileText className="h-4 w-4" /> Export PDF
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium w-full sm:w-auto sm:mr-1">More tools</span>
          <ArchivedPdfsDrawer />
          <ReconnectGmailDialog />
          <DebugPollDialog />
          <SmsSetupGuide />
          <BucketTransferLauncher />
          <BacklogSweepLauncher />
        </div>
      </div>
      )}

      {/* Mobile fast-search — sits at the very top of the page (sticky) so ops
          can find a transaction by reference / TID / amount / sender name or
          phone without scrolling past the summary cards. Bound to the same
          `searchQuery` state as the full search bar in the list card, so the
          two always stay in sync. */}
      <div className="sm:hidden sticky top-0 z-20 -mx-1 px-1 py-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b space-y-2">
        <div className="relative w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            inputMode="search"
            enterKeyHint="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
                document
                  .getElementById('email-tx-results')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
            }}
            placeholder="Search reference, TID, amount or sender…"
            aria-label="Quick search email transactions"
            className="h-11 w-full rounded-full border-2 border-input bg-background pl-10 pr-10 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent placeholder:text-muted-foreground/70"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground rounded-full p-1 hover:bg-muted"
              aria-label="Clear quick search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {searchActive && (
          <button
            type="button"
            onClick={() =>
              document
                .getElementById('email-tx-results')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
            className="w-full rounded-lg bg-primary/10 text-primary text-xs font-semibold py-2"
          >
            {filteredRows.length} match{filteredRows.length === 1 ? '' : 'es'} — tap to view results
          </button>
        )}
      </div>

      {/* Date-range selector — recomputes totals/breakdown/exports for the chosen
          period. Pinned under the quick-search bar on mobile so filters are
          always one tap away, no scrolling back up. */}
      <div className="sm:hidden sticky top-[60px] z-[19] flex items-center justify-between gap-2 -mx-1 px-1 py-1.5 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 gap-2"
          onClick={() => setMobileFiltersOpen((v) => !v)}
        >
          {mobileFiltersOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          {mobileFiltersOpen ? 'Hide filters' : 'Filters & date range'}
          {(rangeActive || searchActive) && (
            <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">active</Badge>
          )}
        </Button>
        {/* One-tap audit export of exactly what is on screen (all filters,
            search and sort applied) — one CSV line per email. */}
        <Button
          variant="secondary"
          size="sm"
          className="gap-1.5 shrink-0"
          disabled={visibleRows.length === 0}
          onClick={() => {
            try { navigator.vibrate?.(15); } catch { /* haptics optional */ }
            const count = exportFilteredRowsCsv(visibleRows, getRowStatus);
            toast({
              title: 'CSV exported',
              description: `${count} filtered transaction${count === 1 ? '' : 's'} downloaded.`,
            });
          }}
        >
          <FileDown className="h-4 w-4" />
          CSV ({visibleRows.length})
        </Button>
      </div>
      {/* ── Analytics & Breakdown Tab ── */}
      {workspaceTab === 'analytics' && (
        <div className="space-y-6 pt-2">
          <div className="rounded-xl border bg-card p-3 sm:p-4 flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-3 sm:gap-4">
            <div className="flex-1 min-w-full sm:min-w-[200px]">
              <h3 className="font-semibold text-sm">Date range & Analytics</h3>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {searchActive
                  ? `Showing ${filteredRows.length} of ${rows.length} emails — search "${searchQuery}" (date range ignored while searching) · timezone ${tz}`
                  : rangeActive
                  ? `Showing ${filteredRows.length} of ${rows.length} emails — totals recomputed for ${fromDate || '…'} → ${toDate || '…'} (${tz})`
                  : `No range selected — showing all ${rows.length} emails · timezone ${tz}`}
              </p>
            </div>
            <div className="flex flex-col flex-1 sm:flex-none min-w-[140px]">
              <label
                className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1"
                title="Date boundaries and daily buckets are interpreted in this timezone."
              >
                Timezone
              </label>
              <select
                value={tz}
                onChange={(e) => setTz(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
                {TIMEZONE_OPTIONS.includes(tz) ? null : <option value={tz}>{tz}</option>}
                {TIMEZONE_OPTIONS.map((z) => (
                  <option key={z} value={z}>{z}</option>
                ))}
                {browserTz && !TIMEZONE_OPTIONS.includes(browserTz) && (
                  <option value={browserTz}>{browserTz} (browser)</option>
                )}
              </select>
            </div>
            <div className="flex flex-col flex-1 sm:flex-none min-w-[130px]">
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">From</label>
              <input
                type="date"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => setFromDate(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            <div className="flex flex-col flex-1 sm:flex-none min-w-[130px]">
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">To</label>
              <input
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            <div className="flex flex-col flex-1 sm:flex-none min-w-[160px]">
              <label
                className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1"
                title="Warn when the absolute Net (in − out) exceeds this amount — flags potentially unusual parsing."
              >
                Net warning ≥
              </label>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground pointer-events-none">UGX</span>
                <input
                  type="number"
                  min={0}
                  step={10000}
                  value={netThreshold}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setNetThreshold(Number.isFinite(v) && v >= 0 ? v : 0);
                  }}
                  className="h-9 w-full sm:w-36 rounded-md border border-input bg-background pl-10 pr-2 text-sm tabular-nums"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2 w-full sm:w-auto">
              {[
                { label: 'Today', days: 1 },
                { label: 'Yesterday', days: 1, offset: 1 },
                { label: '7d', days: 7 },
                { label: '30d', days: 30 },
                { label: '90d', days: 90 },
              ].map((p) => (
                <Button
                  key={p.label}
                  variant="outline"
                  size="sm"
                  className="flex-1 sm:flex-none"
                  onClick={() => {
                    const todayKey = dateKeyInTz(new Date(), tz);
                    const [y, m, d] = todayKey.split('-').map(Number);
                    const offsetDays = (p as { offset?: number }).offset ?? 0;
                    const toUtc = Date.UTC(y, m - 1, d) - offsetDays * 86_400_000;
                    const fromUtc = toUtc - (p.days - 1) * 86_400_000;
                    const fmtKey = (ms: number) => {
                      const dt = new Date(ms);
                      return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
                    };
                    setFromDate(fmtKey(fromUtc));
                    setToDate(fmtKey(toUtc));
                  }}
                >
                  {p.label}
                </Button>
              ))}
              <Button
                variant="ghost"
                size="sm"
                className="flex-1 sm:flex-none"
                onClick={() => { setFromDate(''); setToDate(''); }}
                disabled={!rangeActive}
              >
                Clear
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            <StatCard
              tooltipSide={statTooltipSide}
              label="Emails captured"
              value={rows.length.toString()}
              info={<p className="text-xs leading-relaxed">How many confirmation emails we have pulled in from Gmail.</p>}
            />
            <StatCard
              tooltipSide={statTooltipSide}
              label="Parsed transactions"
              value={parsedCount.toString()}
              info={<p className="text-xs leading-relaxed">Emails we successfully read and turned into a money amount.</p>}
            />
            <StatCard
              tooltipSide={statTooltipSide}
              label="Total amount (parsed)"
              value={fmtUgx(totalAmount)}
              info={<p className="text-xs leading-relaxed">All the money values added up across every readable email.</p>}
            />
            <StatCard
              tooltipSide={statTooltipSide}
              label="Total in (received)"
              value={fmtUgx(totalIn)}
              info={<p className="text-xs leading-relaxed">Money that came IN — deposits and payments received.</p>}
              sub={<span className="text-[10px] text-emerald-600">↓ money received</span>}
            />
            <StatCard
              tooltipSide={statTooltipSide}
              label="Total out (sent + charges)"
              value={fmtUgx(totalOut)}
              info={<p className="text-xs leading-relaxed">Money that went OUT — payments sent plus provider fees.</p>}
              sub={<span className="text-[10px] text-rose-600">↑ money sent</span>}
            />
            <StatCard
              tooltipSide={statTooltipSide}
              label="Total provider fees"
              value={fmtUgx(totalFees)}
              info={<p className="text-xs leading-relaxed">Charges taken by MTN, Airtel or the banks for these transactions.</p>}
              sub={<span className="text-[10px] text-amber-600">{feeCount} row{feeCount === 1 ? '' : 's'} · MTN / Airtel / banks</span>}
            />
            <StatCard
              tooltipSide={statTooltipSide}
              label="Net (in − out)"
              value={`${netAmount < 0 ? '-' : ''}${fmtUgx(Math.abs(netAmount))}`}
              info={<p className="text-xs leading-relaxed">Net = Total in − Total out</p>}
              sub={<span className={`text-[10px] ${netAmount >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{netAmount >= 0 ? 'net inflow' : 'net outflow'}</span>}
            />
            <StatCard
              tooltipSide={statTooltipSide}
              label="Flagged (review)"
              value={flaggedCount.toString()}
              info={<p className="text-xs leading-relaxed">Rows that look unusual and are worth a quick human check. They still count toward totals.</p>}
              sub={
                flaggedCount > 0 ? (
                  <span className="inline-flex items-center gap-1 text-amber-600 text-[10px]">
                    <AlertTriangle className="h-3 w-3" /> counted, but verify
                  </span>
                ) : (
                  <span className="text-[10px] text-emerald-600">all parsed rows valid</span>
                )
              }
            />
            <StatCard
              tooltipSide={statTooltipSide}
              label="Unmatched deposits"
              value={unmatchedInCount.toString()}
              info={<p className="text-xs leading-relaxed">Incoming money not yet linked to a deposit request — may still need routing.</p>}
              sub={
                unmatchedInCount > 0 ? (
                  <span className="inline-flex items-center gap-1 text-amber-600 text-[10px]">
                    <AlertTriangle className="h-3 w-3" /> not linked to any deposit request
                  </span>
                ) : (
                  <span className="text-[10px] text-emerald-600">all deposits matched</span>
                )
              }
            />
            <StatCard
              tooltipSide={statTooltipSide}
              label="Unmatched payouts"
              value={unmatchedOutCount.toString()}
              info={<p className="text-xs leading-relaxed">Outgoing money not yet linked to a withdrawal — may still need routing.</p>}
              sub={
                unmatchedOutCount > 0 ? (
                  <span className="inline-flex items-center gap-1 text-rose-600 text-[10px]">
                    <AlertTriangle className="h-3 w-3" /> not routed or matched to withdrawal
                  </span>
                ) : (
                  <span className="text-[10px] text-emerald-600">all payouts settled</span>
                )
              }
            />
          </div>

          <EmailPeriodComparison />

          {channelBreakdown.length > 0 && (
            <div className="rounded-xl border bg-card overflow-hidden">
              <div className="p-4 border-b flex items-center justify-between">
                <h3 className="font-semibold text-sm">Breakdown by channel</h3>
                <span className="text-[11px] text-muted-foreground">parsed transactions only</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="text-left px-4 py-2 font-semibold">Channel</th>
                      <th className="text-right px-4 py-2 font-semibold">In (count)</th>
                      <th className="text-right px-4 py-2 font-semibold text-emerald-700">Total in</th>
                      <th className="text-right px-4 py-2 font-semibold">Out (count)</th>
                      <th className="text-right px-4 py-2 font-semibold text-rose-700">Total out</th>
                      <th className="text-right px-4 py-2 font-semibold">Fees (count)</th>
                      <th className="text-right px-4 py-2 font-semibold text-amber-700">Total fees</th>
                      <th className="text-right px-4 py-2 font-semibold">Net</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {channelBreakdown.map((b) => (
                      <tr key={b.channel} className="hover:bg-muted/30">
                        <td className="px-4 py-2 capitalize font-medium">{b.channel}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{b.inCount}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-mono text-emerald-700">{fmtUgx(b.inTotal)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{b.outCount}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-mono text-rose-700">{fmtUgx(b.outTotal)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{b.feeCount}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-mono text-amber-700">{fmtUgx(b.feeTotal)}</td>
                        <td className={`px-4 py-2 text-right tabular-nums font-mono font-semibold ${b.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {b.net < 0 ? '-' : ''}{fmtUgx(Math.abs(b.net))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-muted/30 font-semibold">
                    <tr>
                      <td className="px-4 py-2">Total</td>
                      <td className="px-4 py-2 text-right tabular-nums">{channelBreakdown.reduce((s, b) => s + b.inCount, 0)}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-mono text-emerald-700">{fmtUgx(totalIn)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{channelBreakdown.reduce((s, b) => s + b.outCount, 0)}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-mono text-rose-700">{fmtUgx(totalOut)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{channelBreakdown.reduce((s, b) => s + b.feeCount, 0)}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-mono text-amber-700">{fmtUgx(totalFees)}</td>
                      <td className={`px-4 py-2 text-right tabular-nums font-mono ${netAmount >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {netAmount < 0 ? '-' : ''}{fmtUgx(Math.abs(netAmount))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {dailySeries.length > 0 && (
            <div className="rounded-xl border bg-card overflow-hidden">
              <div className="p-4 border-b flex items-center justify-between">
                <h3 className="font-semibold text-sm">In vs Out — daily</h3>
                <span className="text-[11px] text-muted-foreground">{dailySeries.length} days</span>
              </div>
              <div className="p-4 h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={dailySeries} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                      tickFormatter={(v) => format(new Date(v), 'MMM d')}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                      tickFormatter={(v) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${Math.round(v / 1_000)}k` : `${v}`)}
                      width={50}
                    />
                    <RTooltip
                      contentStyle={{
                        background: 'hsl(var(--popover))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      labelFormatter={(v) => format(new Date(v as string), 'PPP')}
                      formatter={(v: number, name) => [fmtUgx(v), name]}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line type="monotone" dataKey="in" name="In" stroke="hsl(142 71% 45%)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="out" name="Out" stroke="hsl(0 72% 51%)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="net" name="Net" stroke="hsl(var(--primary))" strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          <DebitBucketAuditSearch />
        </div>
      )}

      {/* ── Needs Review Tab Operations & Banners ── */}
      {workspaceTab === 'needs_review' && (
        <div className="space-y-4 pt-2">
          <DepositNumberConflictsPanel />

          {(() => {
            // Unrouted money-out banner. Counts every payable outgoing row in the
        // active date/search window that has NOT yet been routed to a wallet.
        // The "Auto-debit" button acts on EVERY row that has a possible
        // recipient match — as soon as the system detects a possible recipient
        // (TID = 100, "to/from <phone>" = 90, name match = 75, weak match = 60),
        // the wallet is eligible for an automatic reduction.
        const AUTO_DEBIT_MIN_SCORE = 0;
        const outRows = filteredRows.filter(
          (r) => isCountable(r) && (r.direction === 'out' || r.direction === 'charge'),
        );
        const unrouted = outRows.filter((r) => !(routingHistory[r.id]?.length));
        type HighConfRow = { row: GmailTx; top: MatchedUser; score: number };
        const highConf: HighConfRow[] = [];
        for (const r of unrouted) {
          const matches = userMatches[r.id] ?? [];
          const ranked = matches
            .map((u) => ({
              u,
              s: u.matched_on.startsWith('reference ') ? 100
                : u.matched_on.startsWith('to ') ? 90
                : u.matched_on.startsWith('from ') ? 90
                : u.matched_on.startsWith('name-') ? 75
                : 60,
            }))
            .sort((a, b) => b.s - a.s);
          const top = ranked[0];
          if (top && top.s >= AUTO_DEBIT_MIN_SCORE) highConf.push({ row: r, top: top.u, score: top.s });
        }
        if (outRows.length === 0) return null;
        const unroutedAmt = unrouted.reduce((s, r) => s + (r.amount ?? 0), 0);
        const highConfAmt = highConf.reduce((s, x) => s + (x.row.amount ?? 0), 0);

        const runAutoDebit = async () => {
          if (!highConf.length) return;
          setAutoDebitBusy(true);
          setAutoDebitProgress({ done: 0, total: highConf.length, ok: 0, failed: 0 });
          let okCount = 0;
          let failCount = 0;
          let me: { id: string } | null = null;
          let routedByName: string | null = null;
          try {
            const { data: meRes } = await supabase.auth.getUser();
            if (meRes?.user?.id) {
              me = { id: meRes.user.id };
              const { data: rp } = await (supabase.from('profiles') as any)
                .select('full_name').eq('id', meRes.user.id).maybeSingle();
              routedByName = rp?.full_name ?? null;
            }
          } catch { /* ignore */ }
          for (let i = 0; i < highConf.length; i++) {
            const { row, top, score } = highConf[i];
            const amt = row.amount ?? 0;
            const matchedLabel = top.matched_on;
            const reason = `Auto-debit (score ${score}%, ${matchedLabel}) — outgoing payment email from ${row.from_name || row.from_email || 'provider'}${row.transaction_id ? ` TID ${row.transaction_id}` : ''} charged against ${top.full_name}'s wallet.`;
            try {
              // Guard: the ledger rejects amount 0. Emails with no parsed
              // amount must never be sent to cfo-direct-credit — skip cleanly.
              if (!Number.isFinite(amt) || amt <= 0) {
                failCount++;
                console.warn(`[auto-debit] skip ${row.id}: no usable amount on email (got ${amt})`);
                setAutoDebitProgress({ done: i + 1, total: highConf.length, ok: okCount, failed: failCount });
                continue;
              }
              // Pre-check strict available balance. The ledger blocks
              // negative wallets, so calling cfo-direct-credit when the
              // user has < amt withdrawable just produces a NEGATIVE_WALLET
              // 400. Skip cleanly with a clear console reason instead.
              const { data: availRaw } = await (supabase.rpc as any)(
                'get_user_available_balance',
                { p_user_id: top.id },
              );
              const avail = Number(availRaw ?? 0);
              // Nothing to take — skip cleanly.
              if (!Number.isFinite(avail) || avail <= 0) {
                failCount++;
                console.warn(
                  `[auto-debit] skip ${row.id}: ${top.full_name} has UGX ${Math.max(0, avail).toLocaleString()} available, needs UGX ${amt.toLocaleString()}`,
                );
                setAutoDebitProgress({ done: i + 1, total: highConf.length, ok: okCount, failed: failCount });
                continue;
              }
              // The ledger blocks negative wallets, so never try to debit more
              // than the strict available balance — clamp to drain to zero.
              const debitAmt = Math.min(Math.floor(amt), Math.floor(avail));
              if (!Number.isFinite(debitAmt) || debitAmt <= 0) {
                failCount++;
                console.warn(
                  `[auto-debit] skip ${row.id}: computed debit amount was UGX ${debitAmt.toLocaleString()} after clamping available balance UGX ${avail.toLocaleString()}`,
                );
                setAutoDebitProgress({ done: i + 1, total: highConf.length, ok: okCount, failed: failCount });
                continue;
              }
              const isPartial = debitAmt < amt;
              const { data: debitData, error: debitErr } = await supabase.functions.invoke('cfo-direct-credit', {
                body: {
                  target_user_id: top.id,
                  amount: debitAmt,
                  reason,
                  operation: 'debit' as const,
                  wallet_category: 'wallet_transfer',
                  platform_category: 'wallet_transfer',
                  financial_impact: 'neutral' as const,
                  category_label: 'Email charge → Withdrawable (auto)',
                  recipient_type: 'user',
                  sub_category: row.transaction_id ?? null,
                },
              });
              if (debitErr) throw new Error((debitErr as any)?.message || 'Debit failed');
              if ((debitData as any)?.error) throw new Error((debitData as any).error);
              const referenceId = (debitData as any)?.reference_id ?? null;
              if (isPartial) {
                console.warn(
                  `[auto-debit] partial ${row.id}: debited UGX ${debitAmt.toLocaleString()} of UGX ${amt.toLocaleString()} (wallet drained to zero)`,
                );
              }
              // Capture the wallet impact: re-read the strict available balance
              // after the debit so the row can show how much is left.
              let newAvail: number | null = null;
              try {
                const { data: afterRaw } = await (supabase.rpc as any)(
                  'get_user_available_balance',
                  { p_user_id: top.id },
                );
                const n = Number(afterRaw);
                newAvail = Number.isFinite(n) ? n : null;
              } catch { /* ignore — impact display is best-effort */ }
              setAutoDebitResults((prev) => ({
                ...prev,
                [row.id]: { amount: debitAmt, newAvail, userName: top.full_name },
              }));
              // Refresh the displayed wallet figure for this user immediately so
              // the panel reflects the reduced balance instead of the stale
              // pre-debit value cached in `userBalances`.
              if (newAvail !== null) {
                setUserBalances((cur) => ({ ...cur, [top.id]: newAvail as number }));
              } else {
                setUserBalances((cur) => {
                  const next = { ...cur };
                  delete next[top.id];
                  return next;
                });
              }
              // Best-effort history insert so the row immediately shows as routed.
              if (me?.id) {
                try {
                  await (supabase.from('email_routing_history') as any).insert({
                    gmail_transaction_id: row.id,
                    gmail_message_id: row.gmail_message_id ?? null,
                    transaction_id: row.transaction_id,
                    from_email: row.from_email,
                    from_name: row.from_name,
                    subject: row.subject,
                    amount: debitAmt,
                    route: 'withdrawable_debit',
                    target_user_id: top.id,
                    target_user_name: top.full_name,
                    target_user_phone: top.phone,
                    reason: `DEBIT (auto, ${matchedLabel}${isPartial ? `, partial ${debitAmt.toLocaleString()}/${amt.toLocaleString()}` : ''}): ${reason}`,
                    ledger_reference_id: referenceId,
                    routed_by: me.id,
                    routed_by_name: routedByName,
                    sms_sent: false,
                    sms_error: null,
                  });
                } catch (e) {
                  console.warn('[auto-debit] history insert failed', e);
                }
              }
              okCount++;
            } catch (e: any) {
              failCount++;
              console.error('[auto-debit] row failed', row.id, e?.message);
            }
            setAutoDebitProgress({ done: i + 1, total: highConf.length, ok: okCount, failed: failCount });
          }
          setAutoDebitBusy(false);
          // Force an authoritative re-fetch of every displayed strict balance so
          // each charged wallet visibly drops by the debited amount. Without this
          // the cache only fetches missing ids and keeps showing pre-debit values.
          setUserBalances({});
          // Stamp the refresh so the UI can show a visible "Balance refreshed"
          // confirmation that the figures on screen are now post-debit.
          setBalanceRefreshedAt(Date.now());
          toast({
            title: `Auto-debit complete`,
            description: `${okCount} succeeded, ${failCount} skipped/failed of ${highConf.length}. Skips usually mean the matched user has 0 withdrawable balance — see console for details.`,
            variant: failCount > 0 ? 'destructive' : 'default',
          });
        };

        return (
          <div className={`rounded-xl border p-3 flex flex-col gap-3 sm:flex-row sm:items-start ${unrouted.length > 0 ? 'border-rose-300 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/30' : 'border-emerald-300 bg-emerald-50/60 dark:border-emerald-900/60 dark:bg-emerald-950/30'}`}>
            <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className={`mt-0.5 h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${unrouted.length > 0 ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-200' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-200'}`}>
              {unrouted.length > 0 ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">
                {unrouted.length > 0
                  ? `${unrouted.length} money-out email${unrouted.length === 1 ? '' : 's'} not yet charged to any wallet`
                  : `All ${outRows.length} money-out email${outRows.length === 1 ? '' : 's'} routed to wallets`}
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {unrouted.length > 0 ? (
                  <>
                    Unrouted total <strong className="font-mono text-foreground/80">{fmtUgx(unroutedAmt)}</strong>
                    {' '}· {highConf.length} of them have a possible recipient
                    {highConf.length > 0 && <> ({fmtUgx(highConfAmt)})</>}.
                    {' '}Until they're routed, no user wallet is reduced for these payouts.
                  </>
                ) : (
                  <>Every outgoing email in this window has a matching wallet debit on the ledger.</>
                )}
              </p>
              {autoDebitProgress && (
                <p className="text-[11px] mt-1 font-mono">
                  Progress: {autoDebitProgress.done}/{autoDebitProgress.total}
                  {' '}· <span className="text-emerald-700">{autoDebitProgress.ok} ok</span>
                  {autoDebitProgress.failed > 0 && <> · <span className="text-rose-700">{autoDebitProgress.failed} failed</span></>}
                </p>
              )}
              {balanceRefreshedAt && !autoDebitBusy && (
                <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-200">
                  <RefreshCw className="h-3 w-3" />
                  Balances refreshed · {new Date(balanceRefreshedAt).toLocaleTimeString()}
                </span>
              )}
            </div>
            </div>
            {highConf.length > 0 && (
              <Button
                size="sm"
                variant="default"
                className="w-full sm:w-auto shrink-0 bg-rose-600 hover:bg-rose-700 text-white gap-1.5"
                disabled={autoDebitBusy}
                onClick={runAutoDebit}
                title={`Posts a withdrawable debit via CFO Direct Debit for each of the ${highConf.length} payout(s) with a possible recipient.`}
              >
                {autoDebitBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                Auto-debit {highConf.length} possible recipient{highConf.length === 1 ? '' : 's'}
              </Button>
            )}
          </div>
        );
      })()}

      {/* ── Unparsed-email queue ─────────────────────────────────────────
          Every Gmail row the parser skipped (no usable amount), each with
          the exact reason(s) it failed. Collapsed by default. */}
      {unparsedRows.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 overflow-hidden">
          <button
            type="button"
            onClick={() => setUnparsedOpen((o) => !o)}
            className="w-full flex items-center justify-between gap-2 p-4 text-left hover:bg-amber-500/10 transition-colors"
          >
            <span className="flex items-center gap-2 font-semibold text-sm text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Unparsed email queue
              <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400">
                {unparsedRows.length} skipped
              </Badge>
            </span>
            {unparsedOpen ? <ChevronUp className="h-4 w-4 text-amber-700 dark:text-amber-400" /> : <ChevronDown className="h-4 w-4 text-amber-700 dark:text-amber-400" />}
          </button>
          {unparsedOpen && (
            <div className="border-t border-amber-500/20 divide-y divide-amber-500/10">
              <p className="px-4 py-2 text-xs text-muted-foreground">
                These rows were skipped by the parser and never counted toward any total. Each shows the exact reason it could not be parsed.
              </p>
              {unparsedRows.map((r) => {
                const reasons = parseFailureReasons(r);
                const when = r.internal_date
                  ? new Date(r.internal_date).toLocaleString('en-GB', { timeZone: tz })
                  : '—';
                return (
                  <div key={r.id} className="px-4 py-3 space-y-1.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{r.subject || '(no subject)'}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {r.from_name || r.from_email || 'unknown sender'} · {when}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-[10px] shrink-0">unparsed</Badge>
                    </div>
                    {r.snippet && (
                      <p className="text-xs text-muted-foreground line-clamp-2">{r.snippet}</p>
                    )}
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {reasons.map((reason) => (
                        <Badge
                          key={reason}
                          variant="outline"
                          className="text-[10px] gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        >
                          <AlertCircle className="h-3 w-3" />
                          {reason}
                        </Badge>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Unread alert banner — first thing ops sees: how many attention-needing
          emails (needs routing / unparsed) arrived since they last acknowledged
          the queue, with one tap to jump straight to them. */}
      {unreadAlertCount > 0 && (
        <div className="rounded-xl border border-orange-500/40 bg-orange-500/10 p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex items-start gap-2 min-w-0">
            <span className="relative mt-0.5 shrink-0">
              <AlertCircle className="h-4 w-4 text-orange-700 dark:text-orange-400" />
              <span className="absolute -top-1.5 -right-1.5 h-2 w-2 rounded-full bg-orange-600 animate-pulse" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-orange-800 dark:text-orange-300">
                {unreadAlertCount} new item{unreadAlertCount === 1 ? '' : 's'} need attention
                <Badge className="ml-2 bg-orange-600 text-white hover:bg-orange-600 text-[10px] font-mono">
                  {unreadAlertCount} unread
                </Badge>
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {alertRows.length} total unresolved in this window (awaiting routing or unparsed).
              </p>
              {unreadArrivalSpan && (
                <>
                  <p className="text-[11px] text-orange-800/90 dark:text-orange-300/90 mt-1">
                    Newest arrived {formatAlertArrival(unreadArrivalSpan.newest)}
                    {unreadAlertCount > 1 && <> · oldest unread {formatAlertArrival(unreadArrivalSpan.oldest)}</>}
                  </p>
                  <ul className="mt-1.5 space-y-0.5">
                    {unreadArrivalSpan.sorted.slice(0, 3).map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => setAlertDetailsRow(r)}
                          className="w-full text-left text-[11px] text-muted-foreground flex items-center gap-1.5 min-w-0 rounded px-1 py-0.5 hover:bg-orange-500/10 hover:text-foreground transition-colors"
                          aria-label="Open alert details"
                        >
                          <Clock className="h-3 w-3 shrink-0" aria-hidden />
                          <span className="font-mono shrink-0">{formatAlertArrival(r)}</span>
                          <span className="truncate">
                            — {r.counterparty || r.from_name || r.from_email || 'Unknown sender'}
                            {r.amount ? ` · UGX ${Number(r.amount).toLocaleString()}` : ''}
                          </span>
                          <ArrowRight className="h-3 w-3 shrink-0 ml-auto" aria-hidden />
                        </button>
                      </li>
                    ))}
                    {unreadAlertCount > 3 && (
                      <li className="text-[11px] text-muted-foreground/80">
                        +{unreadAlertCount - 3} more unread…
                      </li>
                    )}
                  </ul>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => {
                setStatusFilter('needs_routing');
                document.getElementById('email-tx-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              Review now
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={bulkBusy || alertRows.length === 0}
              onClick={() => { selectAllAlertRows(); document.getElementById('email-tx-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
            >
              Select all {alertRows.length}
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={bulkBusy || alertRows.length === 0}
              onClick={() => resolveAlertRows(alertRows)}
            >
              {bulkBusy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
              Resolve all
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={!unreadArrivalSpan}
              onClick={() => unreadArrivalSpan && setAlertDetailsRow(unreadArrivalSpan.newest)}
            >
              Open details
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={markAlertsSeen}>
              Mark all seen
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setAlertSettingsOpen(true)}>
              <SlidersHorizontal className="h-3.5 w-3.5 mr-1" /> Alert settings
            </Button>
          </div>
        </div>
      )}
        </div>
      )}

      {/* ── Connection & Diagnostics Tab ── */}
      {workspaceTab === 'diagnostics' && (
        <div className="space-y-6 pt-2">
          <GmailConnectionStatus
            state={state}
            lastSuccessAt={lastSuccessAt}
            onRetry={pollNow}
            retrying={polling}
          />
          <GmailReconnectAuditPanel />
          <DepositNumberConflictsPanel />
          <DedupAuditPanel />
          <div className="rounded-xl border bg-card p-4 space-y-3">
            <h3 className="text-sm font-semibold">Diagnostic & Recovery Tools</h3>
            <div className="flex flex-wrap items-center gap-2">
              <ArchivedPdfsDrawer />
              <ReconnectGmailDialog />
              <DebugPollDialog />
              <SmsSetupGuide />
              <BucketTransferLauncher />
              <BacklogSweepLauncher />
            </div>
          </div>
        </div>
      )}

      {/* Alert notification settings — which alert types count toward badges and
          whether new arrivals raise an in-app prompt. Stored per browser. */}
      <Dialog open={alertSettingsOpen} onOpenChange={setAlertSettingsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" /> Alert notification settings
            </DialogTitle>
            <DialogDescription>
              Choose which email alert types show unread badges and trigger in-app prompts.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="flex items-start gap-3 rounded-md border p-3 cursor-pointer">
              <Checkbox
                checked={alertPrefs.needsRouting}
                onCheckedChange={(v) => updateAlertPrefs({ needsRouting: !!v })}
              />
              <span className="text-sm">
                Awaiting routing
                <span className="block text-[11px] text-muted-foreground">
                  Parsed emails not yet routed to a wallet or deposit.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-md border p-3 cursor-pointer">
              <Checkbox
                checked={alertPrefs.unparsed}
                onCheckedChange={(v) => updateAlertPrefs({ unparsed: !!v })}
              />
              <span className="text-sm">
                Unparsed emails
                <span className="block text-[11px] text-muted-foreground">
                  Messages the reader could not extract amount / TID from.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-md border p-3 cursor-pointer">
              <Checkbox
                checked={alertPrefs.toastPrompt}
                onCheckedChange={(v) => updateAlertPrefs({ toastPrompt: !!v })}
              />
              <span className="text-sm">
                In-app prompts
                <span className="block text-[11px] text-muted-foreground">
                  Pop a toast with a "Review" shortcut when new alerts arrive.
                </span>
              </span>
            </label>
            {!alertPrefs.needsRouting && !alertPrefs.unparsed && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                All alert types are off — no badges or prompts will show.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>


      <DedupAuditPanel />

      <AlertDialog open={!!pendingSwipe} onOpenChange={(o) => { if (!o) { setPendingSwipe(null); setSwipeAck(false); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingSwipe?.mode === 'credit'
                ? 'Send to wallet?'
                : pendingSwipe?.mode === 'debit'
                  ? 'Charge wallet?'
                  : 'Mark as resolved?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingSwipe?.mode === 'credit'
                ? `Route this deposit of ${fmtUgx(Number(pendingSwipe?.row.amount ?? 0))} to a user's wallet.`
                : pendingSwipe?.mode === 'debit'
                  ? `Charge ${fmtUgx(Number(pendingSwipe?.row.amount ?? 0))} to a user's wallet for this payout. This reduces their balance.`
                  : 'This writes an audit mark saying the money is accounted for. It does not move any funds.'}
              {pendingSwipe && pendingSwipe.mode !== 'resolve'
                ? " You'll confirm the recipient and details on the next screen."
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingSwipe && (
            <div className="rounded-md border bg-muted/40 p-2 text-xs space-y-1">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-semibold tabular-nums">{fmtUgx(Number(pendingSwipe.row.amount ?? 0))}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Counterparty</span>
                <span className="font-medium text-right">{pendingSwipe.row.counterparty || '—'}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Transaction ID</span>
                <span className="font-mono text-right">{pendingSwipe.row.transaction_id || '—'}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Direction</span>
                <span className="font-medium">{pendingSwipe.row.direction === 'in' ? 'Money in' : 'Money out'}</span>
              </div>
            </div>
          )}
          {pendingSwipe?.mode === 'debit' && (
            <label className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs cursor-pointer">
              <Checkbox checked={swipeAck} onCheckedChange={(v) => setSwipeAck(!!v)} className="mt-0.5" />
              <span>
                I confirm this payout of {fmtUgx(Number(pendingSwipe.row.amount ?? 0))} should be charged to a user's wallet.
              </span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pendingSwipe?.mode === 'debit' && !swipeAck}
              onClick={() => {
                if (pendingSwipe) {
                  if (pendingSwipe.mode === 'resolve') void markRowResolved(pendingSwipe.row, 'credited');
                  else swipeNavigate(pendingSwipe.row, pendingSwipe.mode);
                }
                setPendingSwipe(null);
                setSwipeAck(false);
              }}
            >
              {pendingSwipe?.mode === 'credit'
                ? 'Send to wallet'
                : pendingSwipe?.mode === 'debit'
                  ? 'Charge wallet'
                  : 'Mark resolved'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Inline alert details drawer — raw email, parsed fields and actions for a
          single attention-needing row, with prev/next through the unread queue. */}
      <Sheet open={!!alertDetailsRow} onOpenChange={(o) => { if (!o) setAlertDetailsRow(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          {alertDetailsRow && (() => {
            const r = alertDetailsRow;
            const queue = unreadArrivalSpan?.sorted ?? [];
            const idx = queue.findIndex((q) => q.id === r.id);
            const status = getRowStatus(r);
            const fields: Array<[string, ReactNode]> = [
              ['Arrived', formatAlertArrival(r)],
              ['Status', status.replace('_', ' ')],
              ['Direction', r.direction || '—'],
              ['Amount', r.amount ? `UGX ${Number(r.amount).toLocaleString()}` : '—'],
              ['Fee', r.fee != null ? `UGX ${Number(r.fee).toLocaleString()}` : '—'],
              ['Balance after', r.balance != null ? `UGX ${Number(r.balance).toLocaleString()}` : '—'],
              ['Counterparty', r.counterparty || '—'],
              ['Channel', r.channel || '—'],
              ['Transaction ID', r.transaction_id || '—'],
              ['Parsed', r.parsed ? 'yes' : 'no'],
              ['Linked deposit', r.linked_deposit_request_id || '—'],
              ['Auto matched', r.auto_matched_at ? format(new Date(r.auto_matched_at), 'dd MMM HH:mm') : '—'],
            ];
            return (
              <>
                <SheetHeader>
                  <SheetTitle className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-orange-600" /> Alert details
                  </SheetTitle>
                  <SheetDescription>
                    {r.from_name || r.from_email || 'Unknown sender'} · {formatAlertArrival(r)}
                  </SheetDescription>
                </SheetHeader>

                {queue.length > 1 && idx >= 0 && (
                  <div className="mt-3 flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
                    <span className="text-xs font-medium">Unread {idx + 1} of {queue.length}</span>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={idx <= 0}
                        onClick={() => setAlertDetailsRow(queue[idx - 1])}>Prev</Button>
                      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={idx >= queue.length - 1}
                        onClick={() => setAlertDetailsRow(queue[idx + 1])}>Next</Button>
                    </div>
                  </div>
                )}

                <div className="mt-4 space-y-4">
                  <div>
                    <p className="text-xs font-semibold mb-1">Parsed fields</p>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border p-2 text-[11px]">
                      {fields.map(([k, v]) => (
                        <Fragment key={k}>
                          <dt className="text-muted-foreground">{k}</dt>
                          <dd className="font-mono break-all">{v}</dd>
                        </Fragment>
                      ))}
                    </dl>
                  </div>

                  <div>
                    <p className="text-xs font-semibold mb-1">Raw message</p>
                    <div className="rounded-md border bg-muted/30 p-2 space-y-1">
                      <p className="text-[11px] text-muted-foreground">From: {r.from_email || '—'}</p>
                      <p className="text-xs font-medium break-words">{r.subject || '(no subject)'}</p>
                      <p className="text-[11px] whitespace-pre-wrap break-words text-muted-foreground">
                        {r.snippet || '(no body captured)'}
                      </p>
                      <p className="text-[10px] font-mono text-muted-foreground/70 pt-1">
                        msg {r.gmail_message_id}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" className="h-8 text-xs"
                      onClick={() => { setAlertDetailsRow(null); navigateToRow(r, r.direction === 'in' ? 'credit' : 'debit'); }}>
                      <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      {r.direction === 'in' ? 'Route to wallet' : 'Charge wallet'}
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-xs"
                      onClick={() => { void markRowResolved(r); }}>
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Mark resolved
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-xs"
                      onClick={() => { setAlertDetailsRow(null); setHistoryDrawerRow(r); }}>
                      <History className="h-3.5 w-3.5 mr-1" /> History
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8 text-xs"
                      onClick={() => { navigator.clipboard?.writeText(r.transaction_id || r.gmail_message_id); toast({ title: 'Copied reference' }); }}>
                      <Copy className="h-3.5 w-3.5 mr-1" /> Copy ref
                    </Button>
                  </div>
                </div>
              </>
            );
          })()}
        </SheetContent>
      </Sheet>

      <Sheet open={!!historyDrawerRow} onOpenChange={(o) => { if (!o) { setHistoryDrawerRow(null); setHistoryQueue([]); } }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <History className="h-4 w-4" /> Status history
            </SheetTitle>
            <SheetDescription>
              {historyDrawerRow
                ? `Every routing / charging transition for the email from ${historyDrawerRow.from_name || historyDrawerRow.from_email || 'Unknown'}.`
                : ''}
            </SheetDescription>
          </SheetHeader>
          {historyQueue.length > 1 && historyQueueIndex >= 0 && (
            <div className="mt-3 flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
              <span className="text-xs font-medium">
                Selected {historyQueueIndex + 1} of {historyQueue.length}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={historyQueueIndex <= 0}
                  onClick={() => setHistoryDrawerRow(historyQueue[historyQueueIndex - 1])}
                >
                  Prev
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={historyQueueIndex >= historyQueue.length - 1}
                  onClick={() => setHistoryDrawerRow(historyQueue[historyQueueIndex + 1])}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
          {(() => {
            const drawerHistory = historyDrawerRow ? (routingHistory[historyDrawerRow.id] ?? []) : [];
            if (!drawerHistory.length) {
              return <p className="mt-6 text-sm text-muted-foreground">No routing or charging transitions recorded yet.</p>;
            }
            // Classify + label each entry once, so both the filter and the
            // rendered timeline share the same route-type logic.
            const classify = (h: RoutingHistoryEntry) => {
              const reversal = /revers/i.test(h.reason || '');
              const isDebit = h.route === 'withdrawable_debit' || /^DEBIT\b/i.test(h.reason || '');
              const type: 'routed' | 'charged' | 'reversed' = reversal ? 'reversed' : isDebit ? 'charged' : 'routed';
              const routeLabel = reversal
                ? 'Reversal'
                : isDebit
                  ? 'Wallet charged'
                  : h.route === 'operational_float'
                    ? 'Routed → Operational Float'
                    : 'Routed → Personal Deposit';
              return { reversal, isDebit, type, routeLabel };
            };
            const q = historyDrawerQuery.trim().toLowerCase();
            const filtered = drawerHistory.filter((h) => {
              const { type, routeLabel } = classify(h);
              if (historyDrawerType !== 'all' && type !== historyDrawerType) return false;
              if (!q) return true;
              const haystack = [
                h.routed_by_name,
                h.target_user_name,
                h.target_user_phone,
                h.reason,
                routeLabel,
                String(h.amount ?? ''),
                format(new Date(h.created_at), 'MMM d, yyyy HH:mm'),
              ].filter(Boolean).join(' ').toLowerCase();
              return haystack.includes(q);
            });
            return (
              <>
                <div className="mt-4 space-y-2">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                    <Input
                      value={historyDrawerQuery}
                      onChange={(e) => setHistoryDrawerQuery(e.target.value)}
                      placeholder="Search actor, user, reason, time…"
                      className="pl-8 h-9 text-sm"
                    />
                    {historyDrawerQuery && (
                      <button
                        type="button"
                        onClick={() => setHistoryDrawerQuery('')}
                        aria-label="Clear search"
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(['all', 'routed', 'charged', 'reversed'] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setHistoryDrawerType(t)}
                        className={`text-xs px-2.5 py-1 rounded-full border capitalize min-h-8 ${
                          historyDrawerType === t
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-background text-muted-foreground border-border hover:bg-muted'
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Showing {filtered.length} of {drawerHistory.length} transition{drawerHistory.length === 1 ? '' : 's'}
                  </p>
                </div>
                {filtered.length === 0 ? (
                  <p className="mt-6 text-sm text-muted-foreground">No transitions match your search or filter.</p>
                ) : (
                <ol className="mt-4 relative border-l border-border pl-5 space-y-5">
                {filtered.map((h) => {
                  const { reversal, isDebit, routeLabel } = classify(h);
                  const busy = !!reverseBusy[h.id];
                  const dotClass = reversal ? 'bg-rose-500' : isDebit ? 'bg-rose-500' : 'bg-violet-500';
                  return (
                    <li key={h.id} className="relative">
                      <span className={`absolute -left-[27px] top-1 h-3 w-3 rounded-full ring-4 ring-background ${dotClass}`} />
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-foreground">{routeLabel}</p>
                        <span className="font-mono tabular-nums text-sm text-foreground">
                          UGX {Number(h.amount ?? 0).toLocaleString()}
                        </span>
                      </div>
                      <p className="mt-0.5 text-sm text-foreground">
                        {reversal ? 'Reversed from ' : 'To '}
                        <span className="font-medium">{h.target_user_name || 'Unknown user'}</span>
                        {h.target_user_phone ? <span className="text-muted-foreground"> · {h.target_user_phone}</span> : null}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {h.routed_by_name ? <>By <span className="font-medium text-foreground/80">{h.routed_by_name}</span> · </> : 'By system · '}
                        {format(new Date(h.created_at), 'MMM d, yyyy · HH:mm')}
                        {h.sms_sent ? ' · SMS sent' : ''}
                      </p>
                      {h.reason && (
                        <p className="mt-1 text-xs text-muted-foreground/90 whitespace-pre-line break-words">{h.reason}</p>
                      )}
                      {!reversal && historyDrawerRow && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => reverseRoutingEntry(historyDrawerRow, h)}
                          className="mt-2 inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-rose-300 text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-60"
                        >
                          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
                          Reverse this transition
                        </button>
                      )}
                    </li>
                  );
                })}
                </ol>
                )}
              </>
            );
          })()}
        </SheetContent>
      </Sheet>

      <RouteEmailDepositDialog
        open={!!routingRow}
        onOpenChange={(o) => {
          if (o) return;
          setRoutingRow(null);
          setRoutingSuggestedUser(null);
          // Batch mode: advance to the next selected row automatically.
          if (routeQueue.length) {
            const [nextId, ...rest] = routeQueue;
            const nextRow = rows.find((r) => r.id === nextId);
            setRouteQueue(rest);
            if (nextRow) {
              setTimeout(() => navigateToRow(nextRow, nextRow.direction === 'in' ? 'credit' : 'debit'), 200);
              sonnerToast(`Next selected row (${rest.length} left after this)`);
            }
          }
        }}
        row={routingRow as EmailRowForRouting | null}
        suggestedUser={routingSuggestedUser}
        mode={routingMode}
        onPrev={canPrevNav ? () => navigateToRow(visibleRows[navIndex - 1], routingMode) : undefined}
        onNext={canNextNav ? () => navigateToRow(visibleRows[navIndex + 1], routingMode) : undefined}
        canPrev={canPrevNav}
        canNext={canNextNav}
        currentIndex={navIndex >= 0 ? navIndex + 1 : 0}
        totalCount={visibleRows.length}
        onRouted={(rowId) => {
          setJustRoutedIds((cur) => new Set(cur).add(rowId));
          void refreshRowStatus(rowId);
        }}
      />

      <FixChannelDialog
        row={editingRow}
        onClose={() => setEditingRow(null)}
        userRules={storedUserRules}
        onSave={(channel, ruleSpec) => {
          // 1. Override the cache for this row so it sticks immediately.
          if (editingRow) {
            const key = channelCacheKey(editingRow);
            if (key) {
              channelCacheRef.current[key] = {
                channel,
                confidence: 'authoritative',
                signal: 'Manual correction',
                rule: 'user_override',
                source: 'parser',
              };
              flushChannelCache();
            }
          }
          // 2. Persist a new permanent rule (if the user opted to).
          if (ruleSpec) {
            const next: StoredUserRule[] = [
              ...storedUserRules,
              { ...ruleSpec, channel, createdAt: new Date().toISOString() },
            ];
            persistUserRules(next);
          } else {
            setRulesVersion((v) => v + 1);
          }
          toast({
            title: 'Channel updated',
            description: ruleSpec
              ? `Saved as "${channel}" and added a rule for future emails.`
              : `Saved as "${channel}" for this transaction.`,
          });
          setEditingRow(null);
        }}
        onDeleteRule={deleteUserRule}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  info,
  tooltipSide = 'bottom',
  tooltipAlign = 'center',
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  info?: ReactNode;
  /** Preferred tooltip side. Radix flips it automatically if it would clip on small screens. */
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
  /** Preferred alignment along the chosen side. */
  tooltipAlign?: 'start' | 'center' | 'end';
}) {
  // Controlled open state so the info tooltip is fully keyboard-operable:
  // Enter/Space toggles it, Escape closes it, focus opens it, blur/pointer-leave closes it.
  const [tipOpen, setTipOpen] = useState(false);
  return (
    <div className="rounded-xl border bg-card p-4 transition-colors hover:bg-muted/30">
      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
        <span className="truncate">{label}</span>
        {info && (
          <TooltipProvider delayDuration={150}>
            <Tooltip open={tipOpen} onOpenChange={setTipOpen}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`How "${label}" is calculated. Press Enter or Space to ${tipOpen ? 'hide' : 'show'} details, Escape to close.`}
                  aria-expanded={tipOpen}
                  className="inline-flex items-center justify-center text-muted-foreground/70 hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setTipOpen((o) => !o)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                      e.preventDefault();
                      setTipOpen((o) => !o);
                    } else if (e.key === 'Escape') {
                      setTipOpen(false);
                    }
                  }}
                >
                  <Info className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side={tooltipSide}
                align={tooltipAlign}
                sideOffset={6}
                avoidCollisions
                collisionPadding={12}
                className="max-w-[min(18rem,calc(100vw-1.5rem))]"
                onEscapeKeyDown={() => setTipOpen(false)}
              >
                {info}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </p>
      <p className="font-bold text-xl tracking-tight mt-1.5 tabular-nums">{value}</p>
      {sub && <div className="mt-1.5">{sub}</div>}
    </div>
  );
}


/**
 * Maps a raw poll error message into a friendly headline + description.
 * Covers the common Gmail / gateway failure modes operators encounter.
 */
function friendlyPollError(raw: string | null | undefined): { title: string; description: string; kind: 'expired' | 'scope' | 'rate' | 'network' | 'config' | 'gmail' | 'unknown' } {
  return friendlyPollErrorImpl(raw);
}



/**
 * Small wrapper that shows a plain-language explanation for a Recent emails
 * badge on hover OR keyboard focus. The trigger is a focusable span so the
 * tooltip is reachable without a mouse; the badge inside keeps its own styles.
 */
function BadgeTip({
  plain,
  details,
  children,
}: {
  plain: string;
  details?: string;
  children: ReactNode;
}) {
  // Stable id for an always-rendered, visually-hidden description. Radix only
  // mounts TooltipContent while open, so its auto aria-describedby vanishes on
  // blur. Pairing the trigger with a persistent sr-only element guarantees a
  // screen reader announces the explanation whenever the badge is focused.
  const descId = useId();
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            role="note"
            aria-describedby={descId}
            className="inline-flex cursor-help rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {children}
            <span id={descId} className="sr-only">
              {plain}{details ? ` ${details}` : ''}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
          <p className="font-medium">{plain}</p>
          {details && (
            <p className="mt-1 whitespace-pre-line text-muted-foreground">{details}</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}


function friendlyPollErrorImpl(raw: string | null | undefined): { title: string; description: string; kind: 'expired' | 'scope' | 'rate' | 'network' | 'config' | 'gmail' | 'unknown' } {
  const m = (raw || '').toLowerCase();
  if (m.includes('google_mail_api_key') || m.includes('not connected') || m.includes('not configured')) {
    return { title: 'Gmail isn\'t connected', description: 'Connect a Gmail account in Lovable Cloud → Connectors before polling.', kind: 'config' };
  }
  if (m.includes('invalid credentials') || m.includes('unauthenticated') || m.includes('[401]') || m.includes(' 401')) {
    return { title: 'Gmail session expired', description: 'The OAuth token is no longer valid. Click Reconnect Gmail to re-authenticate.', kind: 'expired' };
  }
  if (m.includes('insufficient') || m.includes('scope') || m.includes('[403]') || m.includes(' 403')) {
    return { title: 'Missing Gmail permission', description: 'The connection lacks a required scope. Reconnect Gmail and approve all requested permissions.', kind: 'scope' };
  }
  if (m.includes('429') || m.includes('rate') || m.includes('quota')) {
    return { title: 'Gmail rate limit hit', description: 'Google is throttling requests. Wait a minute, then click Retry.', kind: 'rate' };
  }
  if (m.includes('502') || m.includes('503') || m.includes('504') || m.includes('timeout') || m.includes('fetch')) {
    return { title: 'Network or gateway hiccup', description: 'A transient error reached the Gmail gateway. Click Retry to try again.', kind: 'network' };
  }
  if (m.startsWith('gmail ') || m.includes('gmail /')) {
    return { title: 'Gmail rejected the request', description: raw?.slice(0, 200) || 'Unknown Gmail API error.', kind: 'gmail' };
  }
  return { title: 'Polling failed', description: raw?.slice(0, 200) || 'Unknown error. Click Retry to try again.', kind: 'unknown' };
}

function GmailConnectionStatus({
  state,
  lastSuccessAt,
  onRetry,
  retrying,
}: {
  state: PollState | null;
  lastSuccessAt: string | null;
  onRetry?: () => void | Promise<void>;
  retrying?: boolean;
}) {
  const { toast } = useToast();
  const [verifying, setVerifying] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [copiedDetails, setCopiedDetails] = useState(false);

  const verifyNow = async (action: 'verify' | 'reconnect_initiated') => {
    setVerifying(true);
    const { data, error } = await supabase.functions.invoke('gmail-verify-connection', { body: { action } });
    setVerifying(false);
    if (error) {
      toast({ title: 'Verify failed', description: error.message, variant: 'destructive' });
      return;
    }
    const oc = (data as any)?.outcome;
    const ms = (data as any)?.latency_ms;
    if (oc === 'verified' || oc === 'skipped') {
      toast({ title: `Gmail ${oc}`, description: ms ? `${ms}ms — logged to audit.` : 'Logged to audit.' });
    } else {
      toast({
        title: `Gmail ${oc ?? 'error'}`,
        description: ((data as any)?.error || 'See audit log for details.').slice(0, 200),
        variant: 'destructive',
      });
    }
    window.dispatchEvent(new CustomEvent('gmail-reconnect-audit-refresh'));
  };

  const isError = state?.last_status === 'error';
  const isOk = state?.last_status === 'ok';
  const friendly = isError ? friendlyPollError(state?.last_error) : null;
  const isExpired = friendly?.kind === 'expired' || friendly?.kind === 'scope';

  // Try to extract an HTTP status code from the raw error (e.g. "[401]", "status 403", "HTTP 429").
  const statusCode = (() => {
    if (!state?.last_error) return null;
    const m = state.last_error.match(/\b(?:HTTP\s*|status\s*|code\s*|\[)(\d{3})\b/i);
    return m ? m[1] : null;
  })();

  const tone = isExpired
    ? 'border-destructive/40 bg-destructive/5 text-destructive'
    : isError
      ? 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400'
      : isOk
        ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400'
        : 'border-border bg-muted/30 text-muted-foreground';

  const Icon = isExpired || isError ? WifiOff : isOk ? Wifi : Wifi;
  const label = isError
    ? friendly!.title
    : isOk
      ? 'Gmail connected'
      : 'Gmail status unknown';

  const copyDetails = async () => {
    if (!state?.last_error) return;
    try {
      await navigator.clipboard.writeText(state.last_error);
      setCopiedDetails(true);
      setTimeout(() => setCopiedDetails(false), 1500);
    } catch {
      /* noop */
    }
  };

  return (
    <div className={`rounded-xl border p-3 flex flex-col gap-2 ${tone}`}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
      <div className="flex items-center gap-2.5 min-w-0">
        <Icon className="h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate flex items-center gap-2">
            {label}
            {isError && statusCode && (
              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-current/30 bg-background/40">
                HTTP {statusCode}
              </span>
            )}
          </p>
          {isError && friendly && (
            <p className="text-[11px] opacity-80 line-clamp-2">{friendly.description}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 text-[11px] sm:text-xs shrink-0">
        <span className="opacity-80">
          Last successful poll:{' '}
          <strong className="font-mono">
            {lastSuccessAt ? format(new Date(lastSuccessAt), 'MMM d, HH:mm:ss') : 'never'}
          </strong>
        </span>
        {isError && state?.last_error && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 gap-1.5 text-[11px]"
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
          >
            {showDetails ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {showDetails ? 'Hide details' : 'Show details'}
          </Button>
        )}
        {isError && onRetry && (
          <Button
            size="sm"
            variant="default"
            className="h-7 px-2 gap-1.5 text-[11px]"
            onClick={() => onRetry()}
            disabled={retrying}
          >
            {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Retry
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 gap-1.5 text-[11px]"
          onClick={() => verifyNow('verify')}
          disabled={verifying}
        >
          {verifying ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
          Verify
        </Button>
        {(isExpired || isError) && (
          <Button
            size="sm"
            variant="destructive"
            className="h-7 px-2 gap-1.5 text-[11px]"
            onClick={() => verifyNow('reconnect_initiated')}
            disabled={verifying}
          >
            <RefreshCw className="h-3 w-3" />
            Log reconnect
          </Button>
        )}
      </div>
      </div>
      {isError && showDetails && state?.last_error && (
        <div className="rounded-lg border border-current/20 bg-background/60 text-foreground p-2.5 mt-1">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
              Last poll error
              {state?.last_polled_at && (
                <span className="ml-2 font-mono normal-case tracking-normal">
                  · {format(new Date(state.last_polled_at), 'MMM d, HH:mm:ss')}
                </span>
              )}
              {statusCode && <span className="ml-2 font-mono">· HTTP {statusCode}</span>}
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 gap-1 text-[10px]"
              onClick={copyDetails}
            >
              {copiedDetails ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copiedDetails ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <pre className="text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto">
            {state.last_error}
          </pre>
        </div>
      )}
    </div>
  );
}

interface ReconnectAuditRow {
  id: string;
  action: string;
  outcome: string;
  latency_ms: number | null;
  error_message: string | null;
  initiated_by_email: string | null;
  created_at: string;
}

function GmailReconnectAuditPanel() {
  const [rows, setRows] = useState<ReconnectAuditRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const { data } = await (supabase.from('gmail_reconnect_audit') as any)
      .select('id,action,outcome,latency_ms,error_message,initiated_by_email,created_at')
      .order('created_at', { ascending: false })
      .limit(25);
    setRows((data as ReconnectAuditRow[]) ?? []);
    setLoading(false);
  };

  // Loads on mount and on the 'gmail-reconnect-audit-refresh' event the
  // reconnect flow dispatches. The old Realtime INSERT listener was on
  // gmail_reconnect_audit, which is not in the publication, so it never fired
  // (doc 147).
  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener('gmail-reconnect-audit-refresh', onRefresh);
    return () => {
      window.removeEventListener('gmail-reconnect-audit-refresh', onRefresh);
    };
  }, []);

  const outcomeBadge = (oc: string) => {
    const map: Record<string, string> = {
      verified: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20',
      skipped: 'bg-sky-500/10 text-sky-700 border-sky-500/20',
      initiated: 'bg-amber-500/10 text-amber-700 border-amber-500/20',
      failed: 'bg-rose-500/10 text-rose-700 border-rose-500/20',
      error: 'bg-destructive/10 text-destructive border-destructive/20',
    };
    return map[oc] ?? 'bg-muted text-muted-foreground';
  };

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="p-4 border-b flex items-center gap-2">
        <History className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-semibold text-sm">Gmail reconnect / verify audit log</h3>
        <span className="text-[11px] text-muted-foreground ml-auto">last 25</span>
      </div>
      {loading ? (
        <div className="p-6 flex justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          No verify or reconnect attempts recorded yet.
        </div>
      ) : (
        <div className="divide-y max-h-[320px] overflow-y-auto">
          {rows.map((r) => (
            <div key={r.id} className="p-3 text-sm flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={`text-[10px] capitalize ${outcomeBadge(r.outcome)}`}>
                    {r.outcome}
                  </Badge>
                  <Badge variant="outline" className="text-[10px] capitalize">
                    {r.action.replace('_', ' ')}
                  </Badge>
                  {r.latency_ms !== null && (
                    <span className="text-[10px] font-mono text-muted-foreground">{r.latency_ms}ms</span>
                  )}
                  {r.initiated_by_email && (
                    <span className="text-[11px] text-muted-foreground truncate">by {r.initiated_by_email}</span>
                  )}
                </div>
                {r.error_message && (
                  <p className="text-[11px] text-destructive/90 mt-1 line-clamp-2">{r.error_message}</p>
                )}
              </div>
              <span className="text-[11px] text-muted-foreground shrink-0 font-mono">
                {format(new Date(r.created_at), 'MMM d, HH:mm:ss')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SmsSetupGuide() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Smartphone className="h-4 w-4" /> SMS → Gmail setup
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Auto-forward SMS to Gmail</DialogTitle>
          <DialogDescription>
            One-time phone setup. After this, every incoming SMS is forwarded to the connected Gmail and appears here within 1 minute.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div>
            <p className="font-semibold mb-1">Android (recommended)</p>
            <ol className="list-decimal pl-5 space-y-1.5 text-muted-foreground">
              <li>Install <strong>SMS Forwarder</strong> by Hannes Petri (free, open-source) from the Play Store.</li>
              <li>Open the app → tap <strong>Add rule</strong>.</li>
              <li>Sender filter: leave blank, or restrict to shortcodes like <code className="text-xs">MTNMoMo</code>, <code className="text-xs">Airtel</code>, <code className="text-xs">Stanbic</code>.</li>
              <li>Action: <strong>Email</strong>. Set the recipient to the Gmail address connected to Welile.</li>
              <li>Subject: <code className="text-xs">SMS from {'{sender}'}</code> &nbsp;|&nbsp; Body: <code className="text-xs">{'{content}'}</code></li>
              <li>Grant SMS permission and disable battery optimisation for the app.</li>
              <li>Send a test SMS to confirm it lands in Gmail and appears in this feed.</li>
            </ol>
          </div>
          <div className="rounded-lg border bg-muted/40 p-3 text-xs">
            <p className="font-semibold mb-1">iPhone</p>
            <p className="text-muted-foreground">iOS does not allow apps to read SMS, so true auto-forwarding isn't possible. Use a dedicated Android device for the SIM, or route the SIM through a GSM gateway.</p>
          </div>
          <p className="text-xs text-muted-foreground">
            The poller already matches subjects starting with <code>SMS from…</code> and emails from any sender containing <code>smsforwarder</code>.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface DebugItem {
  id: string;
  decision: string;
  reason?: string;
  from?: string | null;
  from_name?: string | null;
  subject?: string | null;
  snippet?: string | null;
  internal_date?: string | null;
  last_cutoff?: string | null;
  extracted?: Record<string, any>;
  parser_notes?: string[];
}

function DebugPollDialog() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<DebugItem[] | null>(null);
  const [meta, setMeta] = useState<{ scanned: number; query: string; last_cutoff: string | null } | null>(null);
  const [filter, setFilter] = useState<'all' | 'parsed' | 'unparsed' | 'skipped'>('all');

  const runDebug = async () => {
    setRunning(true); setReport(null);
    const { data, error } = await supabase.functions.invoke('gmail-poll-transactions', { body: { debug: true } });
    setRunning(false);
    if (error) {
      toast({ title: 'Debug poll failed', description: error.message, variant: 'destructive' });
      return;
    }
    const d = data as any;
    setReport((d?.debug ?? []) as DebugItem[]);
    setMeta({ scanned: d?.scanned ?? 0, query: d?.query ?? '', last_cutoff: d?.last_cutoff ?? null });
  };

  const filtered = (report ?? []).filter((r) => {
    if (filter === 'all') return true;
    if (filter === 'skipped') return r.decision === 'skipped';
    if (filter === 'parsed') return r.decision === 'would_insert_parsed';
    if (filter === 'unparsed') return r.decision === 'would_insert_unparsed';
    return true;
  });

  const counts = {
    parsed: (report ?? []).filter((r) => r.decision === 'would_insert_parsed').length,
    unparsed: (report ?? []).filter((r) => r.decision === 'would_insert_unparsed').length,
    skipped: (report ?? []).filter((r) => r.decision === 'skipped').length,
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Bug className="h-4 w-4" /> Debug poll
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Gmail poll debug report</DialogTitle>
          <DialogDescription>
            Runs the poller in dry-run mode and shows why each scanned email was matched, rejected, or only partially parsed. Nothing is written to the database.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" onClick={runDebug} disabled={running} className="gap-2">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bug className="h-4 w-4" />}
            Run dry-run
          </Button>
          {report && (
            <>
              <Badge variant="outline">scanned {meta?.scanned ?? 0}</Badge>
              <Badge className="bg-emerald-500/10 text-emerald-700 border-emerald-500/20">parsed {counts.parsed}</Badge>
              <Badge className="bg-amber-500/10 text-amber-700 border-amber-500/20">unparsed {counts.unparsed}</Badge>
              <Badge variant="secondary">skipped {counts.skipped}</Badge>
              <div className="ml-auto flex gap-1">
                {(['all','parsed','unparsed','skipped'] as const).map((f) => (
                  <Button key={f} size="sm" variant={filter === f ? 'default' : 'ghost'} onClick={() => setFilter(f)} className="h-7 text-xs capitalize">{f}</Button>
                ))}
              </div>
            </>
          )}
        </div>
        {meta?.last_cutoff && (
          <p className="text-[11px] text-muted-foreground">
            Last poll cutoff: <code>{meta.last_cutoff}</code> — emails older than this are skipped.
          </p>
        )}
        <div className="max-h-[55vh] overflow-y-auto space-y-2 -mx-1 px-1">
          {!report && !running && (
            <p className="text-sm text-muted-foreground py-8 text-center">Click <strong>Run dry-run</strong> to inspect the next 50 emails Gmail returns for the query.</p>
          )}
          {running && (
            <div className="py-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          )}
          {report && filtered.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">No emails match this filter.</p>
          )}
          {filtered.map((item) => {
            const tone = item.decision === 'would_insert_parsed' ? 'border-emerald-500/30 bg-emerald-500/5'
              : item.decision === 'would_insert_unparsed' ? 'border-amber-500/30 bg-amber-500/5'
              : 'border-muted bg-muted/30';
            const label = item.decision === 'would_insert_parsed' ? 'parsed'
              : item.decision === 'would_insert_unparsed' ? 'unparsed'
              : `skipped • ${item.reason ?? ''}`;
            return (
              <div key={item.id} className={`rounded-lg border p-3 text-xs ${tone}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate">{item.from_name || item.from || 'Unknown sender'}</p>
                    <p className="text-muted-foreground truncate">{item.subject || '(no subject)'}</p>
                    {item.snippet && <p className="text-muted-foreground/80 line-clamp-2 mt-1">{item.snippet}</p>}
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[10px]">{label}</Badge>
                </div>
                {item.extracted && (
                  <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-0.5 font-mono text-[10px]">
                    {Object.entries(item.extracted).map(([k, v]) => (
                      <div key={k} className="truncate">
                        <span className="text-muted-foreground">{k}:</span> <span className={v == null ? 'text-rose-600' : 'text-foreground'}>{v == null ? '—' : String(v)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {item.parser_notes && item.parser_notes.length > 0 && (
                  <p className="mt-2 text-[10px] text-amber-700">Notes: {item.parser_notes.join(', ')}</p>
                )}
                {item.reason === 'older_than_last_poll' && item.internal_date && (
                  <p className="mt-1 text-[10px] text-muted-foreground">internal_date {item.internal_date} ≤ cutoff {item.last_cutoff}</p>
                )}
              </div>
            );
          })}
        </div>
        {meta?.query && (
          <details className="text-[10px] text-muted-foreground">
            <summary className="cursor-pointer">Gmail search query</summary>
            <pre className="mt-1 whitespace-pre-wrap break-all bg-muted p-2 rounded">{meta.query}</pre>
          </details>
        )}
      </DialogContent>
    </Dialog>
  );
}
interface DedupAuditRow {
  id: string;
  gmail_message_id: string;
  dedup_hash: string | null;
  matched_transaction_id: string | null;
  matched_row_id: string | null;
  reason: string;
  from_email: string | null;
  subject: string | null;
  snippet: string | null;
  internal_date: string | null;
  created_at: string;
}

function DedupAuditPanel() {
  const [rows, setRows] = useState<DedupAuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<'all' | 'transaction_id_match' | 'dedup_hash_match'>('all');
  const [search, setSearch] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = async () => {
    const { data } = await (supabase.from('gmail_dedup_audit') as any)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    setRows((data as DedupAuditRow[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel('gmail_dedup_audit_feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'gmail_dedup_audit' }, (payload) => {
        setRows((cur) => [payload.new as DedupAuditRow, ...cur].slice(0, 100));
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  const counts = {
    all: rows.length,
    transaction_id_match: rows.filter((r) => r.reason === 'transaction_id_match').length,
    dedup_hash_match: rows.filter((r) => r.reason === 'dedup_hash_match').length,
  };

  const filtered = rows.filter((r) => {
    if (filter !== 'all' && r.reason !== filter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const hay = [r.from_email, r.subject, r.snippet, r.matched_transaction_id, r.dedup_hash, r.gmail_message_id]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const copySnippet = async (r: DedupAuditRow) => {
    const text = [
      `From: ${r.from_email || 'Unknown'}`,
      `Subject: ${r.subject || '(no subject)'}`,
      `Reason: ${r.reason}`,
      `Matched TID: ${r.matched_transaction_id || '—'}`,
      `Hash: ${r.dedup_hash || '—'}`,
      `Gmail ID: ${r.gmail_message_id}`,
      `Date: ${r.internal_date ? format(new Date(r.internal_date), 'yyyy-MM-dd HH:mm:ss') : '—'}`,
      `---`,
      r.snippet || '',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(r.id);
      setTimeout(() => setCopiedId((cur) => (cur === r.id ? null : cur)), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full p-4 border-b flex items-center justify-between hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-600" />
          <h3 className="font-semibold text-sm">Dedup audit log</h3>
          <Badge variant="secondary" className="text-[10px]">{rows.length}</Badge>
        </div>
        <span className="text-xs text-muted-foreground">{expanded ? 'Hide' : 'Show'}</span>
      </button>
      {expanded && (
        <>
          <div className="p-3 border-b flex flex-wrap items-center gap-2 bg-muted/20">
            {([
              { id: 'all', label: 'All' },
              { id: 'transaction_id_match', label: 'TID match' },
              { id: 'dedup_hash_match', label: 'Hash match' },
            ] as const).map((f) => (
              <Button
                key={f.id}
                size="sm"
                variant={filter === f.id ? 'default' : 'outline'}
                onClick={() => setFilter(f.id)}
                className="h-7 text-xs gap-1.5"
              >
                {f.label}
                <Badge variant="secondary" className="text-[10px] h-4 px-1">{counts[f.id]}</Badge>
              </Button>
            ))}
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sender, subject, TID, hash…"
              className="ml-auto h-7 text-xs px-2 rounded border bg-background w-full sm:w-64"
            />
          </div>
          {loading ? (
            <div className="p-6 flex justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {rows.length === 0
                ? 'No deduplicated emails yet. Skipped duplicates will appear here in real time.'
                : 'No entries match the current filters.'}
            </div>
          ) : (
            <div className="divide-y max-h-[400px] overflow-y-auto">
              {filtered.map((r) => (
                <div key={r.id} className="p-3 text-xs hover:bg-muted/30">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{r.from_email || 'Unknown sender'}</p>
                      <p className="text-muted-foreground truncate">{r.subject || '(no subject)'}</p>
                    </div>
                    <Badge
                      variant="outline"
                      className={`shrink-0 text-[10px] ${
                        r.reason === 'transaction_id_match'
                          ? 'bg-rose-500/10 text-rose-700 border-rose-500/20'
                          : 'bg-amber-500/10 text-amber-700 border-amber-500/20'
                      }`}
                    >
                      {r.reason.replace('_', ' ')}
                    </Badge>
                  </div>
                  {r.snippet && (
                    <div className="mt-2 relative">
                      <pre className="p-2 rounded bg-muted/60 border border-border/50 text-[11px] text-muted-foreground whitespace-pre-wrap break-words font-mono leading-snug pr-8">
                        {r.snippet.slice(0, 200)}{r.snippet.length > 200 ? '…' : ''}
                      </pre>
                      <button
                        type="button"
                        onClick={() => copySnippet(r)}
                        className="absolute top-1.5 right-1.5 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        title="Copy to clipboard"
                      >
                        {copiedId === r.id ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                      </button>
                    </div>
                  )}
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
                    {r.matched_transaction_id && (
                      <span>matched TID: <span className="text-foreground">{r.matched_transaction_id}</span></span>
                    )}
                    {r.dedup_hash && (
                      <span title={r.dedup_hash}>hash: <span className="text-foreground">{r.dedup_hash.slice(0, 12)}…</span></span>
                    )}
                    <span>msg: {r.gmail_message_id.slice(0, 14)}…</span>
                    <span>{format(new Date(r.created_at), 'MMM d HH:mm:ss')}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

type ChannelBreakdownRow = {
  channel: string;
  inCount: number;
  inTotal: number;
  outCount: number;
  outTotal: number;
  feeCount: number;
  feeTotal: number;
  net: number;
};

type ExportPayload = {
  rows: GmailTx[];
  totalIn: number;
  totalOut: number;
  netAmount: number;
  channelBreakdown: ChannelBreakdownRow[];
};

type ZoomWindowDay = { date: string; in: number; out: number; net: number };

/**
 * One-tap audit export: dumps the CURRENTLY FILTERED rows (one line per email)
 * rather than the aggregated totals. Built for mobile ops/audit hand-offs.
 */
function exportFilteredRowsCsv(
  rows: GmailTx[],
  statusOf: (r: GmailTx) => string,
): number {
  const stamp = format(new Date(), 'yyyy-MM-dd_HHmm');
  const headers = [
    'Date (ISO)', 'Status', 'Direction', 'Channel', 'Amount (UGX)', 'Fee (UGX)',
    'Balance (UGX)', 'Transaction ID', 'Counterparty', 'Sender name', 'Sender email',
    'Subject', 'Parsed', 'Linked deposit request', 'Auto matched at', 'Gmail message ID',
  ];
  const body = rows.map((r) => [
    csvTimestamp(r.internal_date),
    statusOf(r),
    r.direction ?? '',
    r.channel ?? '',
    r.amount === null || r.amount === undefined ? '' : Math.round(Number(r.amount)),
    r.fee === null || r.fee === undefined ? '' : Math.round(Number(r.fee)),
    r.balance === null || r.balance === undefined ? '' : Math.round(Number(r.balance)),
    r.transaction_id ?? '',
    r.counterparty ?? '',
    r.from_name ?? '',
    r.from_email ?? '',
    (r.subject ?? '').replace(/\s+/g, ' ').trim(),
    r.parsed ? 'yes' : 'no',
    r.linked_deposit_request_id ?? '',
    csvTimestamp(r.auto_matched_at),
    r.gmail_message_id ?? '',
  ]);
  downloadCsv(`email-transactions-filtered_${stamp}.csv`, headers, body);
  return body.length;
}

type ZoomWindowPayload = {
  days: ZoomWindowDay[];
  totalIn: number;
  totalOut: number;
  net: number;
  zoomed: boolean;
};

/** Export the currently-selected In/Out zoom window summary to CSV. */
function exportZoomWindowCsv({ days, totalIn, totalOut, net, zoomed }: ZoomWindowPayload) {
  if (days.length === 0) return;
  const fromDay = days[0].date;
  const toDay = days[days.length - 1].date;
  const stamp = format(new Date(), 'yyyy-MM-dd_HHmm');
  const headers = ['Section', 'Key', 'Total in (UGX)', 'Total out (UGX)', 'Net (UGX)'];
  const body: (string | number)[][] = [];
  body.push(['Summary', `${zoomed ? 'Zoomed' : 'Full range'} ${fromDay} → ${toDay} (${days.length} day${days.length === 1 ? '' : 's'})`, Math.round(totalIn), Math.round(totalOut), Math.round(net)]);
  body.push(['', '', '', '', '']);
  for (const d of days) {
    body.push(['Day', d.date, Math.round(d.in), Math.round(d.out), Math.round(d.net)]);
  }
  downloadCsv(`in-vs-out-zoom_${fromDay}_to_${toDay}_${stamp}.csv`, headers, body);
}

/** Export the currently-selected In/Out zoom window summary to PDF. */
async function exportZoomWindowPdf({ days, totalIn, totalOut, net, zoomed }: ZoomWindowPayload) {
  if (days.length === 0) return;
  const [{ default: jsPDF }, autoTableModule] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const autoTable = (autoTableModule as any).default ?? (autoTableModule as any);
  const fromDay = days[0].date;
  const toDay = days[days.length - 1].date;
  const stamp = format(new Date(), 'yyyy-MM-dd HH:mm');
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text('In vs Out — Zoom Window Summary', 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Generated ${stamp}`, 14, 25);
  doc.text(`${zoomed ? 'Zoomed' : 'Full'} range: ${fromDay} → ${toDay} (${days.length} day${days.length === 1 ? '' : 's'})`, 14, 31);
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 38,
    head: [['Metric', 'Value']],
    body: [
      ['Total in (received)', `UGX ${Math.round(totalIn).toLocaleString()}`],
      ['Total out (sent + charges)', `UGX ${Math.round(totalOut).toLocaleString()}`],
      ['Net (in − out)', `UGX ${Math.round(net).toLocaleString()}`],
      ['Days in window', String(days.length)],
    ],
    styles: { fontSize: 10 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  autoTable(doc, {
    head: [['Day', 'Total in', 'Total out', 'Net']],
    body: days.map(d => [
      d.date,
      `UGX ${Math.round(d.in).toLocaleString()}`,
      `UGX ${Math.round(d.out).toLocaleString()}`,
      `UGX ${Math.round(d.net).toLocaleString()}`,
    ]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  downloadPdfMobileSafe(doc, `in-vs-out-zoom_${fromDay}_to_${toDay}_${format(new Date(), 'yyyy-MM-dd_HHmm')}.pdf`);
}

function buildPerDayBreakdown(rows: GmailTx[]) {
  const map = new Map<string, { inCount: number; inTotal: number; outCount: number; outTotal: number }>();
  for (const r of rows) {
    if (!r.parsed) continue;
    const day = r.internal_date ? format(new Date(r.internal_date), 'yyyy-MM-dd') : 'unknown';
    const cur = map.get(day) ?? { inCount: 0, inTotal: 0, outCount: 0, outTotal: 0 };
    const amt = r.amount ?? 0;
    if (r.direction === 'in') { cur.inCount += 1; cur.inTotal += amt; }
    else if (r.direction === 'out' || r.direction === 'charge') { cur.outCount += 1; cur.outTotal += amt; }
    map.set(day, cur);
  }
  return Array.from(map.entries())
    .map(([day, v]) => ({ day, ...v, net: v.inTotal - v.outTotal }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

function exportTotalsCsv({ rows, totalIn, totalOut, netAmount, channelBreakdown }: ExportPayload) {
  const perDay = buildPerDayBreakdown(rows);
  const stamp = format(new Date(), 'yyyy-MM-dd_HHmm');

  const allRows: (string | number)[][] = [];
  const totalFeesAll = rows
    .filter((r) => r.parsed && r.fee && Number(r.fee) > 0)
    .reduce((s, r) => s + Number(r.fee ?? 0), 0);
  const feeCountAll = rows.filter((r) => r.parsed && r.fee && Number(r.fee) > 0).length;
  allRows.push(['Section', 'Key', 'In count', 'Total in (UGX)', 'Out count', 'Total out (UGX)', 'Fee count', 'Total fees (UGX)', 'Net (UGX)']);
  allRows.push(['Summary', 'All parsed', rows.filter(r => r.parsed && r.direction === 'in').length, Math.round(totalIn),
    rows.filter(r => r.parsed && (r.direction === 'out' || r.direction === 'charge')).length, Math.round(totalOut),
    feeCountAll, Math.round(totalFeesAll), Math.round(netAmount)]);
  allRows.push(['', '', '', '', '', '', '', '', '']);
  for (const c of channelBreakdown) {
    allRows.push(['Channel', c.channel, c.inCount, Math.round(c.inTotal), c.outCount, Math.round(c.outTotal), c.feeCount, Math.round(c.feeTotal), Math.round(c.net)]);
  }
  allRows.push(['', '', '', '', '', '', '', '', '']);
  for (const d of perDay) {
    allRows.push(['Day', d.day, d.inCount, Math.round(d.inTotal), d.outCount, Math.round(d.outTotal), '', '', Math.round(d.net)]);
  }
  downloadCsv(`email-transactions-totals_${stamp}.csv`, allRows[0] as string[], allRows.slice(1));
}

async function exportTotalsPdf({ rows, totalIn, totalOut, netAmount, channelBreakdown }: ExportPayload) {
  const [{ default: jsPDF }, autoTableModule] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const autoTable = (autoTableModule as any).default ?? (autoTableModule as any);

  const perDay = buildPerDayBreakdown(rows);
  const stamp = format(new Date(), 'yyyy-MM-dd HH:mm');
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text('Email Transactions — Totals Report', 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Generated ${stamp}`, 14, 25);
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 32,
    head: [['Metric', 'Value']],
    body: [
      ['Total in (received)', `UGX ${Math.round(totalIn).toLocaleString()}`],
      ['Total out (sent + charges)', `UGX ${Math.round(totalOut).toLocaleString()}`],
      ['Net (in − out)', `UGX ${Math.round(netAmount).toLocaleString()}`],
      ['Parsed transactions', String(rows.filter(r => r.parsed).length)],
      ['Emails captured', String(rows.length)],
    ],
    styles: { fontSize: 10 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  if (channelBreakdown.length > 0) {
    autoTable(doc, {
      head: [['Channel', 'In #', 'Total in', 'Out #', 'Total out', 'Fee #', 'Total fees', 'Net']],
      body: channelBreakdown.map(c => [
        c.channel,
        c.inCount,
        `UGX ${Math.round(c.inTotal).toLocaleString()}`,
        c.outCount,
        `UGX ${Math.round(c.outTotal).toLocaleString()}`,
        c.feeCount,
        `UGX ${Math.round(c.feeTotal).toLocaleString()}`,
        `UGX ${Math.round(c.net).toLocaleString()}`,
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
    });
  }

  if (perDay.length > 0) {
    autoTable(doc, {
      head: [['Day', 'In #', 'Total in', 'Out #', 'Total out', 'Net']],
      body: perDay.map(d => [
        d.day,
        d.inCount,
        `UGX ${Math.round(d.inTotal).toLocaleString()}`,
        d.outCount,
        `UGX ${Math.round(d.outTotal).toLocaleString()}`,
        `UGX ${Math.round(d.net).toLocaleString()}`,
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
    });
  }

  const filename = `email-transactions-totals_${format(new Date(), 'yyyy-MM-dd_HHmm')}.pdf`;
  downloadPdfMobileSafe(doc, filename);
}

/**
 * Trigger a PDF download in a way that works on mobile Safari / Chrome.
 * `doc.save()` alone often opens a blank tab on iOS — we hand the user a
 * proper blob URL via an anchor click, and fall back to opening in a new
 * tab on iOS so they can use the share sheet.
 */
function downloadPdfMobileSafe(doc: any, filename: string) {
  try {
    const blob: Blob = doc.output('blob');
    // Archive a copy in the offline PDF vault so the record survives
    // network loss, browser cache wipes, or a cleared Downloads folder.
    archivePdfBlob(blob, {
      label: filename.replace(/\.pdf$/i, '').replace(/_/g, ' '),
      filename,
      category: 'finops-emails',
    }).catch(() => {});
    const url = URL.createObjectURL(blob);
    const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS) {
      // iOS Safari ignores the `download` attribute — opening the blob in a
      // new tab lets the user save / share via the native share sheet.
      window.open(url, '_blank');
    } else {
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.rel = 'noopener';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch {
    // Last-resort fallback to jsPDF's built-in saver.
    try { doc.save(filename); } catch {}
  }
}

function ReconnectGmailDialog() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [logging, setLogging] = useState(false);

  const logReconnectAttempt = async () => {
    setLogging(true);
    const { error } = await supabase.functions.invoke('gmail-verify-connection', {
      body: { action: 'reconnect_initiated' },
    });
    setLogging(false);
    if (error) {
      toast({ title: 'Audit log failed', description: error.message, variant: 'destructive' });
      return;
    }
    toast({
      title: 'Reconnect attempt logged',
      description: 'Now ask the AI in chat to reconnect Gmail to complete OAuth.',
    });
    window.dispatchEvent(new CustomEvent('gmail-reconnect-audit-refresh'));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <LinkIcon className="h-4 w-4" /> Reconnect Gmail
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LinkIcon className="h-5 w-5 text-primary" /> Reconnect Gmail
          </DialogTitle>
          <DialogDescription>
            Use this when polling has stopped because the Gmail connection's OAuth token has
            expired or scopes have changed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <ol className="list-decimal pl-5 space-y-2 text-muted-foreground">
            <li>
              Click <strong className="text-foreground">Log &amp; open chat</strong> below — this
              records the attempt in the audit log.
            </li>
            <li>
              In the Lovable chat, type{' '}
              <code className="px-1.5 py-0.5 rounded bg-muted text-foreground font-mono text-[11px]">
                Reconnect Gmail
              </code>{' '}
              and approve the OAuth prompt that appears.
            </li>
            <li>
              Return here and click <strong className="text-foreground">Verify</strong> on the
              status banner to confirm the new token works.
            </li>
          </ol>

          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[12px] text-amber-700 dark:text-amber-400">
            OAuth must complete in the Lovable chat surface — browsers can't initiate the
            reconnect directly from this page.
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={logReconnectAttempt} disabled={logging} className="gap-2">
            {logging ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Log &amp; open chat
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Dialog for manually correcting an inferred channel and (optionally)
 * persisting a permanent rule so future emails matching the same pattern
 * automatically classify the same way.
 *
 * The form is intentionally simple: pick the right channel, optionally
 * enter a short matching phrase (e.g. "RCT-", "FT2025"), choose which
 * field to match against, and save. The phrase is escaped and stored as
 * a case-insensitive regex.
 */
function FixChannelDialog({
  row,
  onClose,
  userRules,
  onSave,
  onDeleteRule,
}: {
  row: GmailTx | null;
  onClose: () => void;
  userRules: StoredUserRule[];
  onSave: (channel: string, ruleSpec: Omit<StoredUserRule, 'createdAt'> | null) => void;
  onDeleteRule: (id: string) => void;
}) {
  const open = !!row;
  const current = row ? deriveChannel(row) : null;
  const [channel, setChannel] = useState<string>('cash_receipt');
  const [matchText, setMatchText] = useState<string>('');
  const [source, setSource] = useState<RuleSource>('transaction_id');
  const [saveRule, setSaveRule] = useState<boolean>(true);
  const [note, setNote] = useState<string>('');

  // Re-seed the form whenever a new row opens the dialog.
  useEffect(() => {
    if (!row) return;
    setChannel(current?.channel && current.channel !== 'other' ? current.channel : 'cash_receipt');
    // Pre-fill the match text with the most distinctive thing we can find.
    const id = (row.transaction_id ?? '').trim();
    const preset = current?.match ?? (id ? id.slice(0, Math.min(id.length, 6)) : '');
    setMatchText(preset);
    setSource(id ? 'transaction_id' : 'subject');
    setSaveRule(true);
    setNote('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id]);

  const handleSave = () => {
    if (!row) return;
    const phrase = matchText.trim();
    let ruleSpec: Omit<StoredUserRule, 'createdAt'> | null = null;
    if (saveRule && phrase.length >= 2) {
      ruleSpec = {
        id: `user_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        channel,
        confidence: 'high',
        signal: `User rule: matches "${phrase}"${note ? ` — ${note}` : ''}`,
        source,
        patternSource: escapeRegex(phrase),
        patternFlags: 'i',
        note: note || undefined,
      };
    }
    onSave(channel, ruleSpec);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Fix inferred channel</DialogTitle>
          <DialogDescription>
            Reclassify this transaction and optionally save a rule so future emails
            matching the same phrase always use this channel.
          </DialogDescription>
        </DialogHeader>

        {row && (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-[10px] capitalize">
                  current: {current?.channel.replace(/_/g, ' ') ?? 'other'}
                </Badge>
                {current?.rule && (
                  <span className="text-muted-foreground">rule: {current.rule}</span>
                )}
              </div>
              <div className="truncate"><strong>Subject:</strong> {row.subject || '(none)'}</div>
              {row.transaction_id && (
                <div className="font-mono"><strong className="font-sans">Txn id:</strong> {row.transaction_id}</div>
              )}
              {row.snippet && (
                <div className="line-clamp-2 text-muted-foreground">{row.snippet}</div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Correct channel</Label>
                <Select value={channel} onValueChange={setChannel}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CHANNEL_OPTIONS.map((c) => (
                      <SelectItem key={c} value={c} className="capitalize">{c.replace(/_/g, ' ')}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Match in field</Label>
                <Select value={source} onValueChange={(v) => setSource(v as RuleSource)}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="transaction_id">Transaction id / receipt</SelectItem>
                    <SelectItem value="subject">Email subject</SelectItem>
                    <SelectItem value="snippet">Email snippet</SelectItem>
                    <SelectItem value="from">Sender</SelectItem>
                    <SelectItem value="body">Anywhere (subject + body)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Match phrase (case-insensitive)</Label>
              <Input
                value={matchText}
                onChange={(e) => setMatchText(e.target.value)}
                placeholder='e.g. "RCT-" or "FT2025"'
                className="h-9 font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                Any future email whose chosen field contains this phrase will be
                classified as <strong className="capitalize">{channel.replace(/_/g, ' ')}</strong>.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Optional note</Label>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why this rule exists"
                className="h-9 text-xs"
              />
            </div>

            <label className="flex items-center gap-2 text-xs select-none">
              <input
                type="checkbox"
                checked={saveRule}
                onChange={(e) => setSaveRule(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Save as a permanent rule for future emails
            </label>

            {userRules.length > 0 && (
              <div className="space-y-2 pt-2 border-t">
                <Label className="text-xs">Existing user rules ({userRules.length})</Label>
                <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
                  {userRules.map((u) => (
                    <div key={u.id} className="flex items-center gap-2 text-[11px] rounded border bg-muted/20 px-2 py-1">
                      <Badge variant="outline" className="text-[10px] capitalize shrink-0">{u.channel.replace(/_/g, ' ')}</Badge>
                      <span className="font-mono truncate flex-1" title={`/${u.patternSource}/${u.patternFlags} in ${u.source}`}>
                        /{u.patternSource}/ <span className="text-muted-foreground">in {u.source}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => onDeleteRule(u.id)}
                        className="text-muted-foreground hover:text-destructive"
                        title="Delete rule"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={handleSave}>Save</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
