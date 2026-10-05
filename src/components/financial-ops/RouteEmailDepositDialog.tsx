import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Loader2, Wallet, Banknote, ArrowRight, ArrowLeftRight, AlertTriangle, UserCog, ChevronLeft, ChevronRight, ArrowDownLeft, ArrowUpRight, Receipt, WifiOff, Wifi, History, Copy, Check } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { UserSearchPicker } from '@/components/cfo/UserSearchPicker';
import { formatUGX } from '@/lib/rentCalculations';
import { SOLVENCY_BYPASS_REASONS, type SolvencyBypassReasonCode } from '@/lib/solvencyBypassReasons';
import { validateTransactionReference } from '@/lib/transactionReferenceValidator';
import {
  extractReferenceWithConfidence,
  confidenceMeta,
  buildHighlightSegments,
  type ReferenceExtraction,
} from '@/lib/referenceExtractionConfidence';

/**
 * Reads the REAL error out of a `supabase.functions.invoke()` result.
 *
 * On a non-2xx response supabase-js (2.89) throws a `FunctionsHttpError`
 * whose `.message` is always the generic
 * "Edge Function returned a non-2xx status code" — the JSON body our
 * functions return (`{ error: "INSUFFICIENT_FUNDS", message: "...",
 * available, requested }`) lives on `.context`, which is the raw Response.
 * Returns `null` when the call actually succeeded.
 */
async function edgeErrorMessage(
  res: { data: any; error: any } | null | undefined,
  fallback = 'Request failed',
): Promise<string | null> {
  const err: any = res?.error;
  const data: any = res?.data;
  let body: any = null;

  if (err) {
    const ctx: any = err.context;
    try {
      if (ctx && typeof ctx.json === 'function') {
        const src = typeof ctx.clone === 'function' ? ctx.clone() : ctx;
        body = await src.json();
      } else if (ctx?.body) {
        body = typeof ctx.body === 'string' ? JSON.parse(ctx.body) : ctx.body;
      }
    } catch { body = null; }
    if (!body && ctx && typeof ctx.text === 'function') {
      try { body = JSON.parse(await ctx.text()); } catch { body = null; }
    }
  } else if (data?.error) {
    body = data;
  } else {
    return null;
  }

  if (!body) return err?.message || fallback;

  const code = typeof body.error === 'string' ? body.error : null;
  const detail = typeof body.message === 'string' ? body.message : null;
  // Some guards (e.g. INSUFFICIENT_FUNDS) also return the numbers — show
  // them so the operator sees available vs requested instead of guessing.
  const amounts =
    !detail && typeof body.available === 'number' && typeof body.requested === 'number'
      ? ` (available ${formatUGX(body.available)}, requested ${formatUGX(body.requested)})`
      : '';

  // Keep the machine code in the string: downstream branches match on it
  // (e.g. NEGATIVE_WALLET_BLOCKED) to offer bucket-switch / forced-reversal.
  if (code && detail) return `${code}: ${detail}`;
  return (code || detail || err?.message || fallback) + amounts;
}

/**
 * Fetches current wallet bucket balances (cache view) for a user so the
 * confirmation step can render before → after deltas.
 */
function useWalletBuckets(userId: string | null | undefined) {
  return useQuery({
    queryKey: ['route-email-wallet-buckets', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await (supabase.from('wallets') as any)
        .select('withdrawable_balance, float_balance')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      return {
        withdrawable: Number(data?.withdrawable_balance ?? 0),
        float: Number(data?.float_balance ?? 0),
      };
    },
    staleTime: 5_000,
  });
}

/**
 * Automatic wallet matching: inspects a user's historical wallet-scope
 * deposits (money-in legs) and works out which bucket they most often
 * receive money into — so Financial Ops can pre-select the most likely
 * "Route as" choice instead of guessing on every inbound email.
 *
 * Signal: last 50 user-facing `cash_in` wallet ledger legs grouped by
 * `wallet_bucket`. Respects the user-facing ledger filter (no
 * admin_correction / system_balance_correction). Returns null when the
 * user has no deposit history to learn from.
 */
function useSuggestedWallet(userId: string | null | undefined) {
  return useQuery({
    queryKey: ['route-email-suggested-wallet', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await (supabase.from('general_ledger') as any)
        .select('wallet_bucket, amount, created_at')
        .eq('user_id', userId)
        .eq('ledger_scope', 'wallet')
        .eq('direction', 'cash_in')
        .in('wallet_bucket', ['withdrawable', 'float'])
        .neq('classification', 'admin_correction')
        .neq('category', 'system_balance_correction')
        .gt('amount', 0)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      const rows = (data ?? []) as Array<{ wallet_bucket: 'withdrawable' | 'float' }>;
      if (!rows.length) return null;
      let withdrawableCount = 0;
      let floatCount = 0;
      for (const r of rows) {
        if (r.wallet_bucket === 'float') floatCount += 1;
        else withdrawableCount += 1;
      }
      const suggested: Route = floatCount > withdrawableCount ? 'operational_float' : 'personal_deposit';
      const dominant = Math.max(withdrawableCount, floatCount);
      const confidence = Math.round((dominant / rows.length) * 100);
      return { suggested, withdrawableCount, floatCount, total: rows.length, confidence };
    },
    staleTime: 30_000,
  });
}

function BucketDelta({ label, before, after, sign }: { label: string; before: number; after: number; sign: '+' | '−' }) {
  const tone = sign === '+' ? 'text-emerald-600' : 'text-destructive';
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">
        {formatUGX(before)}
        <span className="mx-1 text-muted-foreground">→</span>
        <span className={`font-semibold ${tone}`}>{formatUGX(after)}</span>
      </span>
    </div>
  );
}

function StatusPill({ children, tone }: { children: React.ReactNode; tone: 'success' | 'warning' | 'danger' | 'neutral' }) {
  const map = {
    success: 'bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
    warning: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
    danger: 'bg-destructive/15 text-destructive border-destructive/30 dark:bg-destructive/20',
    neutral: 'bg-muted text-muted-foreground border-border',
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${map[tone]}`}>
      {children}
    </span>
  );
}

/**
 * Inline preview: last 5 wallet-scope ledger entries for a user filtered to
 * a specific bucket. Helps Financial Ops sanity-check what's currently in
 * the wallet before initiating a transfer. Respects the user-facing ledger
 * filter (no admin_correction / system_balance_correction).
 */
function MiniLedger({ userId, bucket, title }: { userId: string | null | undefined; bucket: 'withdrawable' | 'float'; title: string }) {
  const q = useQuery({
    queryKey: ['route-email-mini-ledger', userId, bucket],
    enabled: !!userId,
    queryFn: async () => {
      // Strictly user-facing wallet rows only:
      //   • ledger_scope = 'wallet'           (no platform/bridge legs)
      //   • wallet_bucket = <exact bucket>    (NOT NULL via eq)
      //   • classification ≠ 'admin_correction'
      //   • category ≠ 'system_balance_correction'
      // See mem://constraints/user-facing-ledger-filter — these two
      // exclusions are mandatory on every end-user ledger surface.
      const { data, error } = await (supabase.from('general_ledger') as any)
        .select('id, amount, direction, category, description, transaction_date, created_at, wallet_bucket, ledger_scope, classification')
        .eq('user_id', userId)
        .eq('ledger_scope', 'wallet')
        .eq('wallet_bucket', bucket)
        .neq('classification', 'admin_correction')
        .neq('category', 'system_balance_correction')
        .gt('amount', 0)
        .order('transaction_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(5);
      if (error) throw error;
      return (data ?? []) as Array<{ id: string; amount: number; direction: 'cash_in' | 'cash_out'; category: string; description: string | null; transaction_date: string; created_at: string }>;
    },
    staleTime: 10_000,
  });
  return (
    <div className="rounded-lg border bg-muted/20 p-2 text-[11px] space-y-1">
      <div className="flex items-center justify-between">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground">{bucket === 'withdrawable' ? 'Personal Deposits' : 'Float'}</span>
      </div>
      {!userId ? (
        <p className="text-muted-foreground">No user selected.</p>
      ) : q.isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !q.data?.length ? (
        <p className="text-muted-foreground">No recent {bucket === 'withdrawable' ? 'personal deposits' : 'float'} activity.</p>
      ) : (
        <ul className="space-y-0.5">
          {q.data.map((tx) => (
            <li key={tx.id} className="flex items-center justify-between gap-2">
              <span className="truncate text-muted-foreground">
                {new Date(tx.transaction_date).toLocaleDateString()} · {tx.description || tx.category}
              </span>
              <span className={tx.direction === 'cash_in' ? 'text-emerald-600 font-medium shrink-0' : 'text-destructive font-medium shrink-0'}>
                {tx.direction === 'cash_in' ? '+' : '−'}{formatUGX(Number(tx.amount) || 0)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Full-width, high-contrast preview of the last 5 wallet transactions.
 * Designed for debit mode so low-vision operators can quickly scan
 * dates, amounts, and direction before confirming a deduction.
 */
function DebitHistoryPreview({ userId, bucket, userName }: { userId: string | null | undefined; bucket: 'withdrawable' | 'float'; userName: string }) {
  const q = useQuery({
    queryKey: ['route-email-debit-history-preview', userId, bucket],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await (supabase.from('general_ledger') as any)
        .select('id, amount, direction, category, description, transaction_date, created_at, wallet_bucket, ledger_scope, classification')
        .eq('user_id', userId)
        .eq('ledger_scope', 'wallet')
        .eq('wallet_bucket', bucket)
        .neq('classification', 'admin_correction')
        .neq('category', 'system_balance_correction')
        .gt('amount', 0)
        .order('transaction_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(5);
      if (error) throw error;
      return (data ?? []) as Array<{ id: string; amount: number; direction: 'cash_in' | 'cash_out'; category: string; description: string | null; transaction_date: string; created_at: string }>;
    },
    staleTime: 10_000,
  });

  if (!userId) return null;

  return (
    <div className="rounded-xl border-2 border-foreground/10 bg-foreground text-background overflow-hidden">
      <div className="px-3 py-2.5 border-b border-background/10 bg-background/10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Receipt className="h-4 w-4 shrink-0" />
          <span className="text-sm font-semibold">Recent wallet activity · {userName}</span>
        </div>
        <span className="text-[10px] uppercase tracking-wider bg-background/20 px-2 py-0.5 rounded-full font-medium">
          {bucket === 'float' ? 'Operational Float' : 'Personal Deposits'}
        </span>
      </div>
      {q.isLoading ? (
        <div className="px-3 py-4 text-center text-sm text-background/70">Loading transactions…</div>
      ) : !q.data?.length ? (
        <div className="px-3 py-4 text-center text-sm text-background/70">No recent transactions.</div>
      ) : (
        <div className="divide-y divide-background/10">
          {q.data.map((tx) => {
            const isCashIn = tx.direction === 'cash_in';
            const date = new Date(tx.transaction_date);
            const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
            return (
              <div key={tx.id} className="px-3 py-2.5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${isCashIn ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}`}>
                    {isCashIn ? <ArrowDownLeft className="h-3.5 w-3.5" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{tx.description || tx.category}</p>
                    <p className="text-xs text-background/60">{dateStr} · {timeStr}</p>
                  </div>
                </div>
                <span className={`text-sm font-bold font-mono shrink-0 ${isCashIn ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {isCashIn ? '+' : '−'}{formatUGX(Number(tx.amount) || 0)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Mobile-first transfer summary card.
 * Shows from-bucket, available UGX, destination, and a clear status
 * so Financial Ops can route money quickly on phones.
 */
function TransferSummaryCard({
  mode,
  amount,
  fromUser,
  fromBucket,
  toUser,
  toBucket,
  proxyInfo,
  debitRoute,
  lowData,
  sourceBuckets,
  destBuckets,
  onSwitchBucket,
  transactionReference,
  gmailTransactionId,
}: {
  mode: RouteDialogMode;
  amount: number;
  fromUser: PrefilledUser | null;
  fromBucket: 'withdrawable' | 'float';
  toUser: PrefilledUser | null;
  toBucket: 'withdrawable' | 'float';
  proxyInfo: { agentName: string } | null;
  debitRoute: DebitRoute;
  lowData: boolean;
  sourceBuckets: { withdrawable: number; float: number } | undefined;
  destBuckets: { withdrawable: number; float: number } | undefined;
  onSwitchBucket?: () => void;
  transactionReference?: string | null;
  gmailTransactionId?: string | null;
}) {
  if (!toUser || amount <= 0) return null;

  const isTransfer = mode === 'credit' && !!fromUser;
  const isDebit = mode === 'debit';

  // Resolve effective buckets and balances
  const fromLabel = isTransfer
    ? fromBucket === 'float' ? 'Float' : 'Withdrawable'
    : isDebit
      ? debitRoute === 'landlord_float' ? 'Landlord-Payout Float' : debitRoute === 'proxy_agent_wallet' ? 'Proxy Agent' : 'Withdrawable'
      : toBucket === 'float' ? 'Operational Float' : 'Personal Deposit';

  const fromBalance = isTransfer
    ? (fromBucket === 'float' ? sourceBuckets?.float : sourceBuckets?.withdrawable) ?? 0
    : isDebit
      ? (debitRoute === 'landlord_float' ? destBuckets?.float : destBuckets?.withdrawable) ?? 0
      : undefined;

  const toLabel = isTransfer
    ? toBucket === 'float' ? 'Float' : 'Withdrawable'
    : isDebit
      ? 'Outgoing payment'
      : toBucket === 'float' ? 'Operational Float' : 'Personal Deposit';

  const short = isTransfer
    ? (fromBalance !== undefined && fromBalance < amount)
    : isDebit
      ? (fromBalance !== undefined && fromBalance < amount)
      : false;

  const otherAvailable = isTransfer && sourceBuckets
    ? (fromBucket === 'float' ? sourceBuckets.withdrawable : sourceBuckets.float)
    : isDebit && destBuckets
      ? (debitRoute === 'landlord_float' ? destBuckets.withdrawable : destBuckets.float)
      : undefined;

  const canSwitch = short && otherAvailable !== undefined && otherAvailable >= amount;
  const tone: 'success' | 'warning' | 'danger' = short ? (canSwitch ? 'warning' : 'danger') : 'success';
  const statusText = short
    ? (canSwitch ? 'Short — switch available' : 'Blocked — insufficient funds')
    : 'Ready to route';

  const switchToLabel = isTransfer
    ? (fromBucket === 'float' ? 'Withdrawable' : 'Float')
    : isDebit
      ? (debitRoute === 'landlord_float' ? 'Withdrawable' : 'Float')
      : '';

  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    const ref = transactionReference ?? gmailTransactionId ?? '—';
    const lines = [
      `From: ${isTransfer ? fromUser?.full_name : isDebit ? toUser?.full_name : 'Inbound email'} (${fromLabel})`,
      `To: ${isDebit ? 'Outgoing payment' : toUser?.full_name} (${toLabel})`,
      `Amount: ${formatUGX(amount)}`,
      `Reference: ${ref}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className={`rounded-xl border-2 overflow-hidden ${lowData ? 'border-foreground/15' : 'border-primary/20'}`}>
      {/* Header */}
      <div className={`px-3 py-2.5 flex items-center justify-between ${lowData ? 'bg-foreground/5' : 'bg-primary/5'}`}>
        <span className={`font-semibold ${lowData ? 'text-sm' : 'text-xs uppercase tracking-wide text-muted-foreground'}`}>
          Transfer summary
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className={`inline-flex items-center gap-1 rounded-md border bg-background/80 px-2 py-1 font-medium hover:bg-background ${lowData ? 'text-sm' : 'text-[11px]'}`}
            title="Copy transfer summary"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <StatusPill tone={tone}>{statusText}</StatusPill>
        </div>
      </div>

      {/* Body */}
      <div className={`px-3 ${lowData ? 'py-4 space-y-4' : 'py-3 space-y-3'}`}>
        {/* FROM */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className={`text-muted-foreground ${lowData ? 'text-xs' : 'text-[11px]'}`}>From</p>
            <p className={`font-semibold truncate ${lowData ? 'text-base' : 'text-sm'}`}>
              {isTransfer ? fromUser!.full_name : isDebit ? toUser.full_name : 'Inbound email'}
            </p>
            <p className={`inline-flex items-center gap-1 ${lowData ? 'text-sm' : 'text-[11px]'}`}>
              {fromLabel === 'Float' || fromLabel === 'Landlord-Payout Float' || fromLabel === 'Operational Float' ? (
                <Wallet className={`shrink-0 ${lowData ? 'h-4 w-4' : 'h-3 w-3'} text-primary`} />
              ) : fromLabel === 'Proxy Agent' ? (
                <UserCog className={`shrink-0 ${lowData ? 'h-4 w-4' : 'h-3 w-3'} text-violet-600`} />
              ) : (
                <Banknote className={`shrink-0 ${lowData ? 'h-4 w-4' : 'h-3 w-3'} text-emerald-600`} />
              )}
              <span className="text-muted-foreground">{fromLabel}</span>
            </p>
          </div>
          {fromBalance !== undefined && (
            <div className="text-right shrink-0">
              <p className={`text-muted-foreground ${lowData ? 'text-xs' : 'text-[11px]'}`}>Available</p>
              <p className={`font-mono font-semibold ${short ? 'text-destructive' : 'text-foreground'} ${lowData ? 'text-lg' : 'text-sm'}`}>
                {formatUGX(fromBalance)}
              </p>
            </div>
          )}
        </div>

        {/* Arrow */}
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <div className={`shrink-0 rounded-full border bg-background flex items-center justify-center ${lowData ? 'w-10 h-10' : 'w-8 h-8'}`}>
            <ArrowDownLeft className={`${lowData ? 'h-5 w-5' : 'h-4 w-4'} text-muted-foreground`} />
          </div>
          <div className="h-px flex-1 bg-border" />
        </div>

        {/* TO */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className={`text-muted-foreground ${lowData ? 'text-xs' : 'text-[11px]'}`}>To</p>
            <p className={`font-semibold truncate ${lowData ? 'text-base' : 'text-sm'}`}>
              {isDebit ? 'Outgoing payment' : toUser.full_name}
            </p>
            <p className={`inline-flex items-center gap-1 ${lowData ? 'text-sm' : 'text-[11px]'}`}>
              {toLabel === 'Operational Float' || toLabel === 'Float' ? (
                <Wallet className={`shrink-0 ${lowData ? 'h-4 w-4' : 'h-3 w-3'} text-primary`} />
              ) : toLabel === 'Outgoing payment' ? (
                <ArrowUpRight className={`shrink-0 ${lowData ? 'h-4 w-4' : 'h-3 w-3'} text-rose-500`} />
              ) : (
                <Banknote className={`shrink-0 ${lowData ? 'h-4 w-4' : 'h-3 w-3'} text-emerald-600`} />
              )}
              <span className="text-muted-foreground">{toLabel}</span>
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className={`text-muted-foreground ${lowData ? 'text-xs' : 'text-[11px]'}`}>Amount</p>
            <p className={`font-mono font-bold ${lowData ? 'text-xl' : 'text-lg'} text-foreground`}>
              {formatUGX(amount)}
            </p>
          </div>
        </div>

        {/* Proxy note */}
        {proxyInfo && isDebit && (
          <div className={`rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-violet-900 dark:bg-violet-950/30 dark:border-violet-800 dark:text-violet-200 ${lowData ? 'text-sm' : 'text-[11px]'}`}>
            Proxy agent: <span className="font-semibold">{proxyInfo.agentName}</span>
          </div>
        )}

        {/* Short warning with one-tap switch action */}
        {short && (
          <div className={`rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 space-y-1.5 ${lowData ? 'text-sm' : 'text-[11px]'}`}>
            <p className="font-semibold text-destructive">
              {canSwitch
                ? `${fromLabel} short by ${formatUGX(amount - (fromBalance ?? 0))}`
                : `${fromLabel} has only ${formatUGX(fromBalance ?? 0)}`}
            </p>
            {canSwitch && otherAvailable !== undefined && (
              <p className="text-muted-foreground">
                {switchToLabel} has {formatUGX(otherAvailable)} available.
              </p>
            )}
            {canSwitch && onSwitchBucket && (
              <button
                type="button"
                onClick={onSwitchBucket}
                className={`w-full rounded-md border border-primary/50 bg-primary/15 font-semibold text-primary hover:bg-primary/25 flex items-center justify-center gap-1.5 ${lowData ? 'px-3 py-2.5 text-sm' : 'px-2.5 py-2 text-[11px]'}`}
              >
                <ArrowRight className={`shrink-0 ${lowData ? 'h-4 w-4' : 'h-3.5 w-3.5'}`} />
                {isTransfer ? `Switch to ${switchToLabel}` : `Confirm & retry with ${switchToLabel}`}
              </button>
            )}
            {!canSwitch && (
              <p className="text-muted-foreground">Lower the amount or pick a different user.</p>
            )}
          </div>
        )}

        {/* Audit log peek — open the latest bucket-attempt row for this transfer reference */}
        {(transactionReference || gmailTransactionId) && (
          <TransferAuditLogLink
            transactionReference={transactionReference ?? null}
            gmailTransactionId={gmailTransactionId ?? null}
            lowData={lowData}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Inline link rendered on the TransferSummaryCard that fetches and shows
 * the latest `wallet_debit_bucket_attempts` row for the current transfer's
 * reference (TID) or Gmail transaction ID. Lets Financial Ops see prior
 * attempts (insufficient/switched/succeeded) without leaving the dialog.
 */
function TransferAuditLogLink({
  transactionReference,
  gmailTransactionId,
  lowData,
}: {
  transactionReference: string | null;
  gmailTransactionId: string | null;
  lowData: boolean;
}) {
  const [open, setOpen] = useState(false);

  const q = useQuery({
    queryKey: ['transfer-audit-latest', transactionReference, gmailTransactionId],
    enabled: open && !!(transactionReference || gmailTransactionId),
    queryFn: async () => {
      const filters: string[] = [];
      if (transactionReference) filters.push(`transaction_reference.eq.${transactionReference}`);
      if (gmailTransactionId) filters.push(`gmail_transaction_id.eq.${gmailTransactionId}`);
      const { data, error } = await (supabase.from('wallet_debit_bucket_attempts') as any)
        .select('id, target_user_name, attempted_bucket, amount, available_at_attempt, outcome, switched_to_bucket, failure_reason, transaction_reference, gmail_transaction_id, created_by_name, created_at')
        .or(filters.join(','))
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      return (data?.[0] ?? null) as null | {
        id: string;
        target_user_name: string | null;
        attempted_bucket: string;
        amount: number;
        available_at_attempt: number;
        outcome: 'insufficient_funds_blocked' | 'switched' | 'succeeded' | 'failed_other';
        switched_to_bucket: string | null;
        failure_reason: string | null;
        transaction_reference: string | null;
        gmail_transaction_id: string | null;
        created_by_name: string | null;
        created_at: string;
      };
    },
    staleTime: 5_000,
  });

  const outcomeMap: Record<string, { cls: string; label: string }> = {
    succeeded: { cls: 'bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300', label: 'Succeeded' },
    switched: { cls: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300', label: 'Switched' },
    insufficient_funds_blocked: { cls: 'bg-destructive/15 text-destructive border-destructive/30', label: 'Blocked' },
    failed_other: { cls: 'bg-muted text-muted-foreground border-border', label: 'Failed' },
  };

  return (
    <div className="pt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 font-semibold text-primary hover:underline ${lowData ? 'text-sm' : 'text-[11px]'}`}
      >
        <History className={`${lowData ? 'h-4 w-4' : 'h-3.5 w-3.5'}`} />
        {open ? 'Hide transfer audit log' : 'View transfer audit log'}
      </button>

      {open && (
        <div className={`mt-2 rounded-md border bg-background px-2.5 py-2 ${lowData ? 'text-sm' : 'text-[11px]'}`}>
          {q.isLoading ? (
            <p className="text-muted-foreground inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading latest attempt…
            </p>
          ) : q.error ? (
            <p className="text-destructive">Failed to load: {(q.error as any)?.message ?? 'unknown error'}</p>
          ) : !q.data ? (
            <p className="text-muted-foreground">
              No prior attempts recorded for{' '}
              <span className="font-mono">{transactionReference ?? gmailTransactionId}</span>.
            </p>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${outcomeMap[q.data.outcome]?.cls ?? ''}`}>
                  {outcomeMap[q.data.outcome]?.label ?? q.data.outcome}
                </span>
                <span className="text-muted-foreground tabular-nums text-[10px]">
                  {new Date(q.data.created_at).toLocaleString()}
                </span>
              </div>
              <p className="font-semibold truncate">{q.data.target_user_name ?? '—'}</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-muted-foreground text-[10px]">Attempted</p>
                  <p className="font-medium capitalize">{q.data.attempted_bucket.replace('_', ' ')}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-[10px]">Available</p>
                  <p className={`font-mono ${Number(q.data.available_at_attempt) < Number(q.data.amount) ? 'text-destructive' : ''}`}>
                    {formatUGX(Number(q.data.available_at_attempt) || 0)}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground text-[10px]">Amount</p>
                  <p className="font-mono font-semibold">{formatUGX(Number(q.data.amount) || 0)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-[10px]">Switched to</p>
                  <p className="font-medium capitalize">{q.data.switched_to_bucket?.replace('_', ' ') ?? '—'}</p>
                </div>
              </div>
              {q.data.failure_reason && (
                <p className="text-muted-foreground bg-muted/50 rounded px-2 py-1 text-[10px]">
                  {q.data.failure_reason}
                </p>
              )}
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>By {q.data.created_by_name ?? '—'}</span>
                {q.data.transaction_reference && (
                  <span className="font-mono">TID {q.data.transaction_reference}</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type Route = 'personal_deposit' | 'operational_float';
type DebitRoute = 'withdrawable' | 'landlord_float' | 'proxy_agent_wallet';
export type RouteDialogMode = 'credit' | 'debit';

export interface EmailRowForRouting {
  id: string;
  gmail_message_id?: string | null;
  amount: number | null;
  transaction_id: string | null;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  /** Recipient / counterparty extracted by the email parser. Used by the
   *  debit flow to compose a reason that names who actually received the
   *  money rather than the bank/MNO that sent the confirmation email. */
  counterparty?: string | null;
  /** Payer's real name. Distinct from `counterparty`: once a till/merchant
   *  row is phone-enriched from a duplicate MTN receipt (gmail-poll-
   *  transactions' enrich-on-duplicate step), `counterparty` holds the
   *  resolved phone number instead of the name, and this field is the only
   *  place the name still lives. Name-learning below must read this, not
   *  `counterparty`, or it teaches the matcher the phone digits as a "name". */
  counterparty_name?: string | null;
  /** Raw email body / preview text. Used to auto-extract a MoMo / bank
   *  transaction reference when the email carries no parsed transaction_id
   *  of its own, so operators don't have to retype it manually. */
  snippet?: string | null;
}

export interface PrefilledUser {
  id: string;
  full_name: string;
  phone: string;
  /** Phone number actually seen in the email body (e.g. after "to …").
   *  Optional — when present, surfaced in the auto-filled reason so the
   *  audit trail records the matched contact, not just the user's stored
   *  account phone. */
  matched_phone?: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: EmailRowForRouting | null;
  suggestedUser?: PrefilledUser | null;
  /**
   * 'credit' (default) — inbound money-in email routed to a user's wallet.
   * 'debit'  — outbound money-out email charged against a user's wallet,
   *            never against Welile's operational float. Auto-redirects to
   *            the proxy agent's wallet when the picked user is a partner
   *            with an active managed-proxy assignment.
   */
  mode?: RouteDialogMode;
  /** Prev / Next navigation so Financial Ops can walk emails without closing the dialog. */
  onPrev?: () => void;
  onNext?: () => void;
  canPrev?: boolean;
  canNext?: boolean;
  currentIndex?: number;
  totalCount?: number;
  /**
   * Fired after a routing/charging action completes successfully, with the
   * gmail transaction id of the affected row. Lets the parent list refetch
   * that row's routing history so the status pill updates without a reload.
   */
  onRouted?: (rowId: string) => void;
}

/**
 * Financial-Ops tool to redirect a confirmed inbound transaction email to a
 * specific user — either as a Personal Deposit (Withdrawable) or as
 * Operational Float. Routes through the `cfo-direct-credit` edge function so
 * the existing Wallet Routing v2 + ledger rules apply.
 */
export function RouteEmailDepositDialog({ open, onOpenChange, row, suggestedUser, mode = 'credit', onPrev, onNext, canPrev, canNext, currentIndex, totalCount, onRouted }: Props) {
  const { toast } = useToast();
  const [user, setUser] = useState<PrefilledUser | null>(null);
  const [amount, setAmount] = useState('');
  const [route, setRoute] = useState<Route>('personal_deposit');
  const [debitRoute, setDebitRoute] = useState<DebitRoute>('withdrawable');
  const [reason, setReason] = useState('');
  // Optional "wallet-to-wallet transfer" source user. When set in credit
  // mode, we first debit this user's withdrawable balance, then credit
  // the picked recipient. Used by Financial Ops on the Recent Emails page
  // to move money from one user's wallet to another's.
  const [sourceUser, setSourceUser] = useState<PrefilledUser | null>(null);
  const [transferFromUser, setTransferFromUser] = useState(false);
  // Manually-chosen proxy agent (debit mode). Lets Financial Ops charge ANY
  // proxy agent's wallet — not just the one auto-assigned to the picked
  // partner. When set, it overrides the auto-detected assignment as the
  // wallet that gets debited under the "Proxy agent wallet" route.
  const [manualProxyAgent, setManualProxyAgent] = useState<PrefilledUser | null>(null);
  // Manual transaction reference supplied by the operator when the inbound
  // email carried no MoMo / bank reference of its own. The backend refuses
  // to credit a reference-less email (REFERENCE_MISSING) because it cannot
  // reconcile or de-duplicate it — so we let Financial Ops type the physical
  // receipt / TID number and forward it as the idempotency key.
  const [manualReference, setManualReference] = useState('');
  // True when `manualReference` was auto-extracted from the email body
  // (subject + snippet) rather than typed by the operator. Drives the
  // "auto-detected" hint and is cleared the moment the operator edits it.
  const [autoExtractedRef, setAutoExtractedRef] = useState(false);
  // Confidence + match-span metadata for an auto-extracted reference, plus
  // the normalised source text it was pulled from. Lets the UI render a
  // confidence meter and highlight exactly which characters of the email
  // body produced the reference so operators can verify it at a glance.
  const [refExtraction, setRefExtraction] = useState<ReferenceExtraction | null>(null);
  const [refSourceText, setRefSourceText] = useState('');
  // Which bucket of the source user to debit when transferring.
  // 'withdrawable' = personal balance, 'float' = operational/landlord-payout float.
  const [transferFromBucket, setTransferFromBucket] = useState<'withdrawable' | 'float'>('withdrawable');
  // Forced-reversal confirmation state. When the reversal step trips
  // NEGATIVE_WALLET_BLOCKED (original user already spent the auto-credit),
  // we surface a confirm panel; clicking "Force reverse & route" retries
  // the same mutation with allow_overdraw: true so the reversal posts as
  // a recoverable obligation (auto_recover=true).
  const [forcePending, setForcePending] = useState<null | { amount: number; name: string }>(null);
  const forceReversalRef = useRef(false);
  // Managed-proxy debit fallback. When a partner has a managed proxy agent
  // the debit normally redirects to the proxy agent's wallet. If that wallet
  // is empty but the partner themselves holds the funds, we flip this ref so
  // the retry debits the partner directly instead of the empty proxy wallet.
  const debitPartnerDirectlyRef = useRef(false);
  // Structured reason code stamped on every forced-reversal leg so the
  // solvency-guard bypass is audit-grade. Required by both the DB trigger
  // and the cfo-direct-credit edge function whenever allow_overdraw=true.
  const [solvencyBypassReason, setSolvencyBypassReason] = useState<SolvencyBypassReasonCode | ''>('');
  const solvencyBypassReasonRef = useRef<SolvencyBypassReasonCode | ''>('');
  // Two-step confirmation gate. When the operator clicks the action button
  // the first time we flip this on, surface the source/destination preview +
  // before/after balances, and require a second click ("Confirm & route") to
  // actually invoke the mutation.
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  // One-tap "Confirm & retry with {bucket}" — when set, the next render
  // where debitRoute matches and the pre-flight gate is clear will auto-fire
  // the mutation. Cleared after firing, on close, or on any further edit.
  const [pendingAutoSubmit, setPendingAutoSubmit] = useState<DebitRoute | null>(null);

  // Per-transfer audit logger — writes one row to
  // `wallet_debit_bucket_attempts` for every meaningful step of the debit
  // flow (blocked-by-insufficient-funds, bucket switched, succeeded,
  // failed-other). Dedupes identical "blocked" entries within a single
  // dialog session so the table is not spammed on every re-render.
  const loggedBlockKeys = useRef<Set<string>>(new Set());
  async function logBucketAttempt(args: {
    targetUserId: string;
    targetUserName?: string | null;
    attemptedBucket: 'withdrawable' | 'float' | 'proxy_withdrawable';
    amount: number;
    availableAtAttempt: number;
    outcome: 'insufficient_funds_blocked' | 'switched' | 'succeeded' | 'failed_other';
    switchedToBucket?: 'withdrawable' | 'float' | 'proxy_withdrawable' | null;
    failureReason?: string | null;
    gmailTransactionId?: string | null;
    transactionReference?: string | null;
  }) {
    try {
      if (args.outcome === 'insufficient_funds_blocked') {
        const key = `${args.targetUserId}|${args.attemptedBucket}|${args.amount}`;
        if (loggedBlockKeys.current.has(key)) return;
        loggedBlockKeys.current.add(key);
      }
      const { data: me } = await supabase.auth.getUser();
      const createdBy = me?.user?.id ?? null;
      if (!createdBy) return;
      let createdByName: string | null = null;
      try {
        const { data: prof } = await (supabase.from('profiles') as any)
          .select('full_name')
          .eq('id', createdBy)
          .maybeSingle();
        createdByName = prof?.full_name ?? null;
      } catch { /* ignore */ }
      await (supabase.from('wallet_debit_bucket_attempts') as any).insert({
        target_user_id: args.targetUserId,
        target_user_name: args.targetUserName ?? null,
        attempted_bucket: args.attemptedBucket,
        amount: args.amount,
        available_at_attempt: args.availableAtAttempt,
        outcome: args.outcome,
        switched_to_bucket: args.switchedToBucket ?? null,
        failure_reason: args.failureReason ?? null,
        gmail_transaction_id: args.gmailTransactionId ?? null,
        transaction_reference: args.transactionReference ?? null,
        created_by: createdBy,
        created_by_name: createdByName,
      });
    } catch (e) {
      console.warn('[RouteEmailDeposit] bucket-attempt log failed', e);
    }
  }

  // Low-data / weak-connection mode: hides helper text & wallet-history
  // queries, enlarges tap targets, and reduces wrapping. Persisted per
  // operator so it survives page reloads on bad networks.
  const [lowData, setLowData] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return window.localStorage.getItem('welile.routeEmail.lowData') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('welile.routeEmail.lowData', lowData ? '1' : '0');
      }
    } catch { /* ignore */ }
  }, [lowData]);
  // Reusable class fragments — applied throughout the dialog body so a
  // single toggle reshapes the whole surface without per-element state.
  const radioCardCls = lowData ? 'p-4 min-h-[64px]' : 'p-3';
  const helperTextCls = lowData ? 'hidden' : 'text-[11px] text-muted-foreground';
  const helperTextSmCls = lowData ? 'hidden' : 'text-[11px]';

  const recipientBucket: 'withdrawable' | 'float' = route === 'operational_float' ? 'float' : 'withdrawable';
  const sourceBuckets = useWalletBuckets(transferFromUser ? sourceUser?.id : null);
  const destBuckets = useWalletBuckets(user?.id);
  const amtNum = Number(amount) || 0;

  // Automatic wallet matching: suggest the most likely "Route as" bucket for
  // the picked recipient based on their historical deposits. Pre-selects the
  // suggestion once per user (in credit mode only) without overriding a
  // manual change the operator makes afterwards.
  const suggestedWallet = useSuggestedWallet(mode === 'credit' ? user?.id : null);
  const autoRoutePickedFor = useRef<string | null>(null);
  useEffect(() => {
    if (mode !== 'credit' || !user?.id) {
      autoRoutePickedFor.current = null;
      return;
    }
    const s = suggestedWallet.data;
    if (!s) return;
    if (autoRoutePickedFor.current === user.id) return;
    autoRoutePickedFor.current = user.id;
    setRoute(s.suggested);
  }, [mode, user?.id, suggestedWallet.data]);

  // Smart-pick the source bucket so Financial Ops doesn't have to guess.
  // When the operator selects a source user (or changes the amount), choose
  // whichever bucket actually has enough funds to cover the transfer. This
  // is the single biggest reason a wallet→wallet move trips
  // NEGATIVE_WALLET_BLOCKED — the wrong bucket was selected even though the
  // money is sitting in the other one.
  const autoBucketPicked = useRef(false);
  useEffect(() => {
    if (!transferFromUser || !sourceUser?.id) {
      autoBucketPicked.current = false;
      return;
    }
    const b = sourceBuckets.data;
    if (!b) return;
    const need = amtNum;
    const wOk = b.withdrawable >= need && need > 0;
    const fOk = b.float >= need && need > 0;
    // Only auto-switch the first time the operator picks a source user, OR
    // when the currently selected bucket clearly can't cover the amount but
    // the other one can. Never overwrite a manual choice silently otherwise.
    if (!autoBucketPicked.current) {
      if (!wOk && fOk) setTransferFromBucket('float');
      else if (wOk && !fOk) setTransferFromBucket('withdrawable');
      else if (b.withdrawable === 0 && b.float > 0) setTransferFromBucket('float');
      autoBucketPicked.current = true;
      return;
    }
    if (transferFromBucket === 'withdrawable' && !wOk && fOk) {
      setTransferFromBucket('float');
    } else if (transferFromBucket === 'float' && !fOk && wOk) {
      setTransferFromBucket('withdrawable');
    }
  }, [transferFromUser, sourceUser?.id, sourceBuckets.data, amtNum, transferFromBucket]);

  useEffect(() => {
    if (open && row) {
      setUser(suggestedUser ?? null);
      setAmount(row.amount ? String(Math.round(row.amount)) : '');
      setRoute('personal_deposit');
      setDebitRoute('withdrawable');
      setForcePending(null);
      forceReversalRef.current = false;
      debitPartnerDirectlyRef.current = false;
      solvencyBypassReasonRef.current = '';
      setSolvencyBypassReason('');
      setSourceUser(null);
      setTransferFromUser(false);
      setTransferFromBucket('withdrawable');
      setManualProxyAgent(null);
      // Auto-extract a reference from the email body when the email itself
      // carries no parsed transaction_id, so operators don't have to type it.
      if (!row.transaction_id) {
        const sourceText = `${row.subject ?? ''} ${row.snippet ?? ''}`;
        const extraction = extractReferenceWithConfidence(sourceText);
        const auto = extraction.reference.trim();
        setRefSourceText(sourceText.replace(/\s+/g, ' ').trim());
        setRefExtraction(extraction.reference ? extraction : null);
        setManualReference(auto);
        setAutoExtractedRef(auto.length >= 4);
      } else {
        setManualReference('');
        setAutoExtractedRef(false);
        setRefExtraction(null);
        setRefSourceText('');
      }
      setAwaitingConfirm(false);
      setPendingAutoSubmit(null);
      const tid = row.transaction_id ? ` TID ${row.transaction_id}` : '';
      const from = row.from_name || row.from_email || 'email';
      // Outgoing emails (MTN/Airtel/bank send confirmations) carry the
      // beneficiary in `counterparty` — surface it so the auto-filled
      // reason names who actually received the money. Phone preference:
      // matched-in-body phone first, then the user's stored account phone.
      const recipientName = row.counterparty || (suggestedUser?.full_name ?? '');
      const recipientPhone = suggestedUser?.matched_phone || suggestedUser?.phone || '';
      const toClause = recipientName || recipientPhone
        ? ` to ${[recipientName, recipientPhone].filter(Boolean).join(' ')}`
        : '';
      setReason(mode === 'debit'
        ? `Charged outgoing payment email from ${from}${tid}${toClause} against user wallet.`
        : `Routed inbound deposit email from ${from}${tid}.`);
    }
  }, [open, row, suggestedUser, mode]);

  // ── Detect proxy-agent assignment for the picked user ────────────
  // Returns the most recent active+approved proxy assignment (managed OR
  // unmanaged). When `is_managed_account=true`, debits auto-redirect to
  // the proxy agent (the partner wallet must not be touched). When the
  // assignment is unmanaged, the operator can still manually choose to
  // debit the proxy agent's wallet via the "Proxy agent wallet" route.
  const proxy = useQuery({
    queryKey: ['route-email-proxy', user?.id, mode],
    enabled: open && !!user?.id,
    queryFn: async () => {
      if (!user?.id) return null;
      const { data: assignment } = await (supabase.from('proxy_agent_assignments') as any)
        .select('id, agent_id, is_managed_account')
        .eq('beneficiary_id', user.id)
        .eq('is_active', true)
        .eq('approval_status', 'approved')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!assignment?.agent_id) return null;
      const { data: prof } = await (supabase.from('profiles') as any)
        .select('id, full_name, phone')
        .eq('id', assignment.agent_id)
        .maybeSingle();
      return {
        assignmentId: assignment.id as string,
        agentId: assignment.agent_id as string,
        isManaged: !!assignment.is_managed_account,
        agentName: (prof?.full_name as string) ?? 'Proxy agent',
        agentPhone: (prof?.phone as string) ?? '',
      };
    },
  });

  // ── Effective proxy agent to charge (debit mode) ────────────────────
  // Priority:
  //   1. Operator's manual pick — ANY proxy agent's wallet can be charged,
  //      regardless of which partner the email was matched to. A manual
  //      pick is always an explicit, non-managed choice.
  //   2. The auto-detected proxy assignment for the picked partner.
  // This is the single source of truth for whose wallet the proxy route
  // debits, and which balances/history previews are shown.
  const effectiveProxyAgent = useMemo(() => {
    if (manualProxyAgent) {
      return {
        agentId: manualProxyAgent.id,
        agentName: manualProxyAgent.full_name,
        agentPhone: manualProxyAgent.phone,
        isManaged: false,
        manual: true,
      };
    }
    if (proxy.data) {
      return {
        agentId: proxy.data.agentId,
        agentName: proxy.data.agentName,
        agentPhone: proxy.data.agentPhone,
        isManaged: proxy.data.isManaged,
        manual: false,
      };
    }
    return null;
  }, [manualProxyAgent, proxy.data]);

  // ── Detect any prior auto-credit linked to this email ──────────────
  // gmail-poll-transactions stamps `auto_match_audit.gmail_message_id`
  // and `gmail_transactions.linked_deposit_request_id` when it auto-
  // credits a matched user's Operational Float. We must reverse it
  // before crediting the newly chosen user, or both wallets end up
  // holding the same money.
  const existing = useQuery({
    queryKey: ['route-email-existing-credit', row?.id, row?.gmail_message_id],
    enabled: open && mode === 'credit' && !!row,
    queryFn: async () => {
      if (!row) return null;
      // 1) Find via gmail_transactions.linked_deposit_request_id (fast path)
      const { data: gmailRow } = await (supabase.from('gmail_transactions') as any)
        .select('linked_deposit_request_id')
        .eq('id', row.id)
        .maybeSingle();
      let depId: string | null = gmailRow?.linked_deposit_request_id ?? null;

      // 2) Fallback: search by auto_match_audit.gmail_message_id
      if (!depId && row.gmail_message_id) {
        const { data: depByAudit } = await (supabase.from('deposit_requests') as any)
          .select('id')
          .eq('auto_match_audit->>gmail_message_id', row.gmail_message_id)
          .not('status', 'in', '(rejected,cancelled,failed)')
          .limit(1)
          .maybeSingle();
        depId = depByAudit?.id ?? null;
      }
      if (!depId) return null;

      const { data: dep } = await (supabase.from('deposit_requests') as any)
        .select('id, user_id, amount, deposit_purpose, status, auto_approved, auto_match_audit')
        .eq('id', depId)
        .maybeSingle();
      if (!dep) return null;
      const terminalReversed = ['rejected', 'cancelled', 'failed', 'reversed'];
      if (terminalReversed.includes(dep.status)) return null;

      const audit = (dep.auto_match_audit ?? {}) as {
        pending_claim?: boolean;
        claim_state?: string;
        payer_name?: string | null;
        park_phone_last9?: string | null;
        needs_finops_confirm_before_invite?: boolean;
        unclaimed_expires_at?: string | null;
      };
      const isPendingClaim = audit.pending_claim === true && audit.claim_state !== 'claimed';

      // Pull the original user's identity for display + SMS (may be null for park).
      let prof: { full_name?: string | null; phone?: string | null } | null = null;
      if (dep.user_id) {
        const { data: p } = await (supabase.from('profiles') as any)
          .select('id, full_name, phone')
          .eq('id', dep.user_id)
          .maybeSingle();
        prof = p;
      }
      return {
        deposit_id: dep.id as string,
        original_user_id: (dep.user_id as string | null) ?? null,
        original_user_name: (prof?.full_name as string)
          ?? (isPendingClaim ? 'Pending claim (unmatched MoMo)' : 'Unknown user'),
        original_user_phone: (prof?.phone as string) ?? (audit.park_phone_last9 ? `…${audit.park_phone_last9}` : ''),
        original_amount: Number(dep.amount) || 0,
        deposit_purpose: (dep.deposit_purpose as string) ?? 'operational_float',
        pending_claim: isPendingClaim,
        claim_state: audit.claim_state ?? null,
        payer_name: audit.payer_name ?? null,
        needs_finops_confirm_before_invite: !!audit.needs_finops_confirm_before_invite,
        unclaimed_expires_at: audit.unclaimed_expires_at ?? null,
      };
    },
  });

  // ── Detect prior auto-debit for this outgoing email (debit mode) ──
  // If the platform already posted a wallet-scope cash_out leg whose
  // `sub_category` matches this email's transaction_id, the wallet has
  // ALREADY been reduced automatically — operator should not debit again
  // unless they confirm. Surfaces wallet owner, bucket, amount and date
  // so the operator can decide whether a manual action is still needed.
  const existingDebit = useQuery({
    queryKey: ['route-email-existing-debit', row?.transaction_id, row?.id],
    enabled: open && mode === 'debit' && !!row?.transaction_id,
    queryFn: async () => {
      if (!row?.transaction_id) return null;
      const { data, error } = await (supabase.from('general_ledger') as any)
        .select('id, user_id, amount, wallet_bucket, transaction_date, category, description, ledger_scope, classification')
        .eq('ledger_scope', 'wallet')
        .eq('direction', 'cash_out')
        .eq('sub_category', row.transaction_id)
        .neq('classification', 'admin_correction')
        .neq('category', 'system_balance_correction')
        .order('transaction_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data?.user_id) return null;
      const { data: prof } = await (supabase.from('profiles') as any)
        .select('id, full_name, phone')
        .eq('id', data.user_id)
        .maybeSingle();
      return {
        ledger_id: data.id as string,
        debited_user_id: data.user_id as string,
        debited_user_name: (prof?.full_name as string) ?? 'Unknown user',
        debited_user_phone: (prof?.phone as string) ?? '',
        amount: Number(data.amount) || 0,
        wallet_bucket: (data.wallet_bucket as 'withdrawable' | 'float' | null) ?? null,
        transaction_date: data.transaction_date as string,
        category: data.category as string,
      };
    },
  });

  // ── Same-user bucket move detection ────────────────────────────────
  // If this email was ALREADY auto-credited to the *same* user but in the
  // other bucket (e.g. auto-approved into Operational Float), then choosing
  // the other bucket here must MOVE the money between buckets — never credit
  // a second time. We surface this in the UI and route through the dedicated
  // `ops-bucket-transfer` function in the mutation.
  const priorAutoCredit = existing.data;
  const priorAutoCreditWasFloat =
    (priorAutoCredit?.deposit_purpose ?? 'operational_float') === 'operational_float';
  const isSameUserBucketMove =
    mode === 'credit' &&
    !transferFromUser &&
    !!priorAutoCredit &&
    !!user &&
    priorAutoCredit.original_user_id === user.id &&
    priorAutoCreditWasFloat !== (route === 'operational_float');

  const send = useMutation({
    mutationFn: async () => {
      if (!row) throw new Error('No email row');
      if (!user) throw new Error('Pick a recipient user');
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error('Enter a valid amount');
      if (reason.trim().length < 10) throw new Error('Reason must be at least 10 characters');

      // Separation of duties: the backend guard
      // (WALLET_CORRECTION_SELF_BLOCKED) refuses any wallet movement whose
      // author is also its target. Catch it here so the operator gets a plain
      // instruction instead of a raw 403 from the edge function.
      const { data: authData } = await supabase.auth.getUser();
      const selfId = authData?.user?.id ?? null;
      if (selfId) {
        const selfTargets = [
          user.id,
          transferFromUser ? sourceUser?.id : null,
          manualProxyAgent?.id,
        ].filter(Boolean) as string[];
        if (selfTargets.includes(selfId)) {
          // Some accounts are explicitly allowlisted to route to their own wallet.
          const { data: selfAllowed } = await supabase.rpc('wallet_self_route_allowed', {
            p_user_id: selfId,
          });
          if (selfAllowed !== true) {
            throw new Error(
              'You cannot route this transaction to or from your own account. Ask another CFO / Financial Ops colleague to record it.',
            );
          }
        }
      }



      // ─── DEBIT MODE (money-out) ────────────────────────────────
      if (mode === 'debit') {
        // `proxyInfo` is the effective proxy agent — either the operator's
        // manual pick (ANY agent) or the auto-detected assignment.
        const proxyInfo = effectiveProxyAgent;
        // Routing rules:
        // 1. Managed-proxy partner → ALWAYS debits proxy agent wallet
        //    (mirrors managed-proxy payout routing; partner wallet untouched).
        // 2. Operator explicitly picked "Proxy agent wallet" → debit the
        //    chosen proxy agent's withdrawable (manual pick OR assignment).
        // 3. Otherwise → debit the picked user as normal.
        const useProxyAgent =
          ((proxyInfo?.isManaged === true) && !debitPartnerDirectlyRef.current) ||
          (debitRoute === 'proxy_agent_wallet' && !!proxyInfo);
        if (debitRoute === 'proxy_agent_wallet' && !proxyInfo) {
          throw new Error('Pick a proxy agent to charge');
        }
        const debitTargetId = useProxyAgent ? proxyInfo!.agentId : user.id;
        const debitTargetName = useProxyAgent ? proxyInfo!.agentName : user.full_name;
        const debitTargetPhone = useProxyAgent ? proxyInfo!.agentPhone : user.phone;
        // Proxy-agent route always lands on the agent's withdrawable bucket.
        const isFloat = debitRoute === 'landlord_float' && !useProxyAgent;
        const isProxyAgentRoute = useProxyAgent;
        const debitBody = {
          target_user_id: debitTargetId,
          amount: amt,
          reason: useProxyAgent
            ? `Outgoing email charged to proxy agent wallet (on behalf of partner ${user.full_name}): ${reason.trim()}`
            : reason.trim(),
          operation: 'debit' as const,
          // Float bucket: agent_float_deposit (locked to float in cfo-direct-credit).
          // Withdrawable bucket: wallet_transfer (user-owned, allowed for user recipient).
          wallet_category: isFloat ? 'agent_float_deposit' : 'wallet_transfer',
          platform_category: isFloat ? 'agent_float_deposit' : 'wallet_transfer',
          financial_impact: 'neutral' as const,
          category_label: isFloat
            ? 'Email charge → Landlord-Payout Float'
            : isProxyAgentRoute
              ? `Email charge → Proxy agent wallet (for ${user.full_name})`
              : 'Email charge → Withdrawable',
          recipient_type: isFloat ? 'operational_wallet' : 'user',
          sub_category: row.transaction_id ?? null,
          allow_overdraw: forceReversalRef.current,
          solvency_bypass_reason: forceReversalRef.current
            ? (solvencyBypassReasonRef.current || undefined)
            : undefined,
        };
        const debitRes = await supabase.functions.invoke('cfo-direct-credit', { body: debitBody });
        const debitData = debitRes.data;
        const debitErrMsg = await edgeErrorMessage(debitRes, 'Debit failed');
        if (debitErrMsg) {
          // Same fallback the transfer leg uses: prefer a one-tap bucket
          // switch when the OTHER bucket of the same (non-proxy) wallet
          // can cover the amount; otherwise prompt for forced reversal
          // (recoverable obligation).
          if (!forceReversalRef.current && String(debitErrMsg).includes('NEGATIVE_WALLET_BLOCKED')) {
            // Managed-proxy redirect landed on an EMPTY proxy agent wallet,
            // but the partner themselves holds enough money → offer a one-tap
            // switch to debit the partner's own wallet instead of the proxy.
            if (useProxyAgent && proxyInfo?.isManaged && !debitPartnerDirectlyRef.current) {
              const pb = destBuckets.data; // partner's own buckets (picked user)
              if (pb) {
                const partnerRoute: DebitRoute | null =
                  pb.withdrawable >= amt ? 'withdrawable'
                    : pb.float >= amt ? 'landlord_float'
                      : null;
                if (partnerRoute) {
                  debitPartnerDirectlyRef.current = true;
                  setDebitRoute(partnerRoute);
                  setPendingAutoSubmit(partnerRoute);
                  const have = partnerRoute === 'landlord_float' ? pb.float : pb.withdrawable;
                  throw new Error(`Proxy agent ${proxyInfo.agentName} has no funds. ${user.full_name} has ${formatUGX(have)} in their own ${partnerRoute === 'landlord_float' ? 'Landlord-Payout Float' : 'Withdrawable'} — switched to debit the partner directly. Tap "Confirm & route" again to retry.`);
                }
              }
            }
            if (!useProxyAgent) {
              const b = destBuckets.data;
              if (b) {
                const otherRoute: DebitRoute = isFloat ? 'withdrawable' : 'landlord_float';
                const otherAvail = isFloat ? b.withdrawable : b.float;
                if (otherAvail >= amt) {
                  setDebitRoute(otherRoute);
                  throw new Error(`${debitTargetName} has ${formatUGX(otherAvail)} in ${otherRoute === 'landlord_float' ? 'Landlord-Payout Float' : 'Withdrawable'} — switched. Tap "Confirm & route" again to retry.`);
                }
              }
            }
            setForcePending({ amount: amt, name: debitTargetName });
            throw new Error('FORCE_REVERSAL_CONFIRMATION_REQUIRED');
          }
          throw new Error(debitErrMsg);
        }
        const referenceId = (debitData as any)?.reference_id ?? null;

        // Best-effort routing history insert + SMS to the wallet owner.
        let smsSent = false;
        let smsError: string | null = null;
        try {
          const fromLabel = row.from_name || row.from_email || null;
          const { data: smsRes, error: smsErr } = await supabase.functions.invoke('notify-email-routing', {
            body: {
              phone: debitTargetPhone,
              target_user_name: debitTargetName,
              amount: amt,
              route: isFloat
                ? 'landlord_float_debit'
                : isProxyAgentRoute
                  ? 'proxy_agent_wallet_debit'
                  : 'withdrawable_debit',
              reference_id: referenceId,
              from_label: fromLabel,
              transaction_id: row.transaction_id,
              debit: true,
              on_behalf_of_partner: useProxyAgent ? user.full_name : null,
            },
          });
          if (smsErr) smsError = (await edgeErrorMessage({ data: smsRes, error: smsErr }, 'SMS dispatch failed')) || 'SMS dispatch failed';
          else if ((smsRes as any)?.success) smsSent = true;
          else smsError = (smsRes as any)?.error || 'SMS not delivered';
        } catch (e: any) {
          smsError = e?.message || 'SMS dispatch threw';
        }

        try {
          const { data: me } = await supabase.auth.getUser();
          if (me?.user?.id) {
            let routedByName: string | null = null;
            try {
              const { data: rp } = await (supabase.from('profiles') as any)
                .select('full_name').eq('id', me.user.id).maybeSingle();
              routedByName = rp?.full_name ?? null;
            } catch { /* ignore */ }
            await (supabase.from('email_routing_history') as any).insert({
              gmail_transaction_id: row.id,
              gmail_message_id: row.gmail_message_id ?? null,
              transaction_id: row.transaction_id,
              from_email: row.from_email,
              from_name: row.from_name,
              subject: row.subject,
              amount: amt,
              route: isFloat
                ? 'landlord_float_debit'
                : isProxyAgentRoute
                  ? 'proxy_agent_wallet_debit'
                  : 'withdrawable_debit',
              target_user_id: debitTargetId,
              target_user_name: debitTargetName,
              target_user_phone: debitTargetPhone,
              reason: useProxyAgent
                ? `DEBIT (proxy${proxyInfo?.isManaged ? ' redirect' : ' route'} from partner ${user.full_name}): ${reason.trim()}`
                : `DEBIT: ${reason.trim()}`,
              ledger_reference_id: referenceId,
              routed_by: me.user.id,
              routed_by_name: routedByName,
              sms_sent: smsSent,
              sms_error: smsError,
            });

            // ── Dedicated DEBIT audit log ─────────────────────────────
            // Immutable record of who performed the debit, the exact wallet
            // charged (including the selected proxy agent), the amount, and
            // every linked transaction reference — for compliance/audit.
            try {
              const debitRouteName = isFloat
                ? 'landlord_float'
                : isProxyAgentRoute
                  ? 'proxy_agent_wallet'
                  : 'withdrawable';
              await (supabase.from('proxy_debit_audit_log') as any).insert({
                performed_by: me.user.id,
                performed_by_name: routedByName,
                debited_user_id: debitTargetId,
                debited_user_name: debitTargetName,
                debited_user_phone: debitTargetPhone,
                debit_route: debitRouteName,
                is_proxy_debit: useProxyAgent,
                proxy_manual_pick: useProxyAgent && !!proxyInfo?.manual,
                proxy_managed: !!proxyInfo?.isManaged,
                partner_user_id: useProxyAgent ? user.id : null,
                partner_user_name: useProxyAgent ? user.full_name : null,
                amount: amt,
                transaction_id: row.transaction_id ?? (manualReference.trim() || null),
                gmail_transaction_id: row.id,
                gmail_message_id: row.gmail_message_id ?? null,
                ledger_reference_id: referenceId,
                transaction_references: {
                  transaction_id: row.transaction_id ?? null,
                  manual_reference: manualReference.trim() || null,
                  gmail_transaction_id: row.id,
                  gmail_message_id: row.gmail_message_id ?? null,
                  ledger_reference_id: referenceId,
                  sub_category: row.transaction_id ?? null,
                  from_email: row.from_email ?? null,
                  from_name: row.from_name ?? null,
                  subject: row.subject ?? null,
                  counterparty: row.counterparty ?? null,
                },
                reason: useProxyAgent
                  ? `DEBIT (proxy${proxyInfo?.isManaged ? ' redirect' : proxyInfo?.manual ? ' manual pick' : ' route'} from partner ${user.full_name}): ${reason.trim()}`
                  : `DEBIT: ${reason.trim()}`,
              });
            } catch (e) {
              console.warn('[RouteEmailDeposit] debit audit log insert failed', e);
            }
          }
        } catch (e) { console.warn('[RouteEmailDeposit] debit history insert failed', e); }

        return { ...(debitData as any), smsSent, smsError, debit: true, proxyRedirected: useProxyAgent, proxyManaged: !!proxyInfo?.isManaged, debitTargetName };
      }

      const isFloat = route === 'operational_float';

      // ── Same-user bucket MOVE (Float ↔ Personal) ─────────────────────
      // The email was already auto-credited to THIS user in the other
      // bucket. Re-routing to the same user must MOVE the funds between
      // their own buckets (no second credit, no double money). Routed
      // through the dedicated ops-bucket-transfer correction function.
      if (isSameUserBucketMove && existing.data) {
        const prior = existing.data;
        const moveAmount = Math.min(prior.original_amount || amt, amt);
        const direction = isFloat ? 'withdrawable_to_float' : 'float_to_withdrawable';
        const moveReason =
          `Re-routed auto-credited deposit ${isFloat ? 'Personal→Float' : 'Float→Personal'} (same user ${user.full_name}): ${reason.trim()}`.slice(0, 480);
        const moveRes = await supabase.functions.invoke('ops-bucket-transfer', {
          body: {
            target_user_id: user.id,
            amount: moveAmount,
            direction,
            reason: moveReason,
          },
        });
        const moveData = moveRes.data;
        const moveErrMsg = await edgeErrorMessage(moveRes, 'Bucket move failed');
        if (moveErrMsg) throw new Error(`Bucket move failed: ${moveErrMsg}`);

        // Keep the deposit's recorded purpose in sync so future detection
        // reflects the new bucket.
        try {
          await (supabase.from('deposit_requests') as any)
            .update({ deposit_purpose: isFloat ? 'operational_float' : 'personal_deposit' })
            .eq('id', prior.deposit_id);
        } catch { /* ignore */ }

        // Best-effort routing-history + SMS so the move is auditable.
        try {
          const { data: me } = await supabase.auth.getUser();
          if (me?.user?.id) {
            await (supabase.from('email_routing_history') as any).insert({
              gmail_transaction_id: row.id,
              gmail_message_id: row.gmail_message_id ?? null,
              transaction_id: row.transaction_id,
              from_email: row.from_email,
              from_name: row.from_name,
              subject: row.subject,
              amount: moveAmount,
              route: isFloat ? 'operational_float' : 'personal_deposit',
              target_user_id: user.id,
              target_user_name: user.full_name,
              target_user_phone: user.phone,
              reason: `BUCKET MOVE (${isFloat ? 'Personal→Float' : 'Float→Personal'}): ${reason.trim()}`,
              ledger_reference_id: (moveData as any)?.transaction_group_id ?? null,
              routed_by: me.user.id,
              routed_by_name: null,
              sms_sent: false,
              sms_error: null,
            });
          }
        } catch (e) { console.warn('[RouteEmailDeposit] bucket-move history insert failed', e); }

        return { bucketMoved: true, movedToFloat: isFloat, moveAmount };
      }

      // ── 0a) Wallet-to-wallet transfer leg ─────────────────────────
      // When the operator picked a source user, debit that user's
      // withdrawable balance for the same amount before crediting the
      // chosen recipient. This makes the Recent Emails dialog a true
      // user→user transfer tool.
      if (transferFromUser) {
        if (!sourceUser) throw new Error('Pick the source user to debit');
        // ── Same-person bucket MOVE (Float ↔ Personal Deposit) ───────────
        // When the operator picks the SAME user as both source and
        // recipient, this is not a user→user transfer — it's a move between
        // that single user's own buckets (e.g. Operational Float → Personal
        // Deposit). Route it through the dedicated `ops-bucket-transfer`
        // correction function so no second credit is ever posted.
        if (sourceUser.id === user.id) {
          const fromFloat = transferFromBucket === 'float';
          const toFloat = route === 'operational_float';
          if (fromFloat === toFloat) {
            throw new Error(
              `Source and destination buckets are the same (${fromFloat ? 'Float' : 'Personal Deposit'}). Pick a different destination to move funds.`,
            );
          }
          const direction = fromFloat ? 'float_to_withdrawable' : 'withdrawable_to_float';
          const moveReason =
            `Same-user bucket move (${fromFloat ? 'Float→Personal Deposit' : 'Personal Deposit→Float'}) for ${user.full_name}: ${reason.trim()}`.slice(0, 480);
          const moveRes = await supabase.functions.invoke('ops-bucket-transfer', {
            body: {
              target_user_id: user.id,
              amount: amt,
              direction,
              reason: moveReason,
            },
          });
          const moveData = moveRes.data;
          const moveErrMsg = await edgeErrorMessage(moveRes, 'Bucket move failed');
          if (moveErrMsg) throw new Error(`Bucket move failed: ${moveErrMsg}`);

          // Best-effort routing-history so the move is auditable.
          try {
            const { data: me } = await supabase.auth.getUser();
            if (me?.user?.id) {
              await (supabase.from('email_routing_history') as any).insert({
                gmail_transaction_id: row.id,
                gmail_message_id: row.gmail_message_id ?? null,
                transaction_id: row.transaction_id,
                from_email: row.from_email,
                from_name: row.from_name,
                subject: row.subject,
                amount: amt,
                route: toFloat ? 'operational_float' : 'personal_deposit',
                target_user_id: user.id,
                target_user_name: user.full_name,
                target_user_phone: user.phone,
                reason: `BUCKET MOVE (${fromFloat ? 'Float→Personal Deposit' : 'Personal Deposit→Float'}): ${reason.trim()}`,
                ledger_reference_id: (moveData as any)?.transaction_group_id ?? null,
                routed_by: me.user.id,
                routed_by_name: null,
                sms_sent: false,
                sms_error: null,
              });
            }
          } catch (e) { console.warn('[RouteEmailDeposit] same-user bucket-move history insert failed', e); }

          return { bucketMoved: true, movedToFloat: toFloat, moveAmount: amt };
        }
        const fromFloat = transferFromBucket === 'float';
        const transferDebitBody = {
          target_user_id: sourceUser.id,
          amount: amt,
          reason: `Transfer ${fromFloat ? '(from float) ' : ''}to ${user.full_name}: ${reason.trim()}`,
          operation: 'debit' as const,
          wallet_category: fromFloat ? 'agent_float_deposit' : 'wallet_transfer',
          platform_category: fromFloat ? 'agent_float_deposit' : 'wallet_transfer',
          financial_impact: 'neutral' as const,
          category_label: `${fromFloat ? 'Float' : 'Wallet'} transfer → ${user.full_name}`,
          recipient_type: fromFloat ? 'operational_wallet' : 'user',
          sub_category: row.transaction_id ?? null,
          allow_overdraw: forceReversalRef.current,
          solvency_bypass_reason: forceReversalRef.current
            ? (solvencyBypassReasonRef.current || undefined)
            : undefined,
        };
        const tdRes = await supabase.functions.invoke('cfo-direct-credit', { body: transferDebitBody });
        const tdData = tdRes.data;
        const tdErrMsg = await edgeErrorMessage(tdRes, 'Transfer debit failed');
        if (tdErrMsg) {
          if (!forceReversalRef.current && String(tdErrMsg).includes('NEGATIVE_WALLET_BLOCKED')) {
            // Prefer a one-tap bucket switch over forcing an overdraw when the
            // funds actually exist in the OTHER bucket of the same source user.
            const b = sourceBuckets.data;
            if (b) {
              const otherBucket: 'withdrawable' | 'float' = fromFloat ? 'withdrawable' : 'float';
              const otherAvail = otherBucket === 'withdrawable' ? b.withdrawable : b.float;
              if (otherAvail >= amt) {
                setTransferFromBucket(otherBucket);
                throw new Error(`${sourceUser.full_name} has ${formatUGX(otherAvail)} in ${otherBucket === 'withdrawable' ? 'Withdrawable' : 'Float'} — switched. Tap "Confirm & route" again to retry.`);
              }
            }
            setForcePending({ amount: amt, name: sourceUser.full_name });
            throw new Error('FORCE_REVERSAL_CONFIRMATION_REQUIRED');
          }
          throw new Error(`Source debit failed: ${tdErrMsg}`);
        }
        // Best-effort SMS + history for the debited source user.
        try {
          if (sourceUser.phone) {
            await supabase.functions.invoke('notify-email-routing', {
              body: {
                phone: sourceUser.phone,
                target_user_name: sourceUser.full_name,
                amount: amt,
                route: fromFloat ? 'landlord_float_debit' : 'withdrawable_debit',
                reference_id: (tdData as any)?.reference_id ?? null,
                from_label: row.from_name || row.from_email || null,
                transaction_id: row.transaction_id,
                debit: true,
                on_behalf_of_partner: user.full_name,
              },
            });
          }
        } catch (e) { console.warn('[RouteEmailDeposit] transfer source SMS failed', e); }
        try {
          const { data: me } = await supabase.auth.getUser();
          if (me?.user?.id) {
            await (supabase.from('email_routing_history') as any).insert({
              gmail_transaction_id: row.id,
              gmail_message_id: row.gmail_message_id ?? null,
              transaction_id: row.transaction_id,
              from_email: row.from_email,
              from_name: row.from_name,
              subject: row.subject,
              amount: amt,
              route: fromFloat ? 'landlord_float_debit' : 'withdrawable_debit',
              target_user_id: sourceUser.id,
              target_user_name: sourceUser.full_name,
              target_user_phone: sourceUser.phone,
              reason: `TRANSFER OUT (${fromFloat ? 'float' : 'withdrawable'}) → ${user.full_name}. ${reason.trim()}`,
              ledger_reference_id: (tdData as any)?.reference_id ?? null,
              routed_by: me.user.id,
              routed_by_name: null,
              sms_sent: false,
              sms_error: null,
            });
          }
        } catch (e) { console.warn('[RouteEmailDeposit] transfer history insert failed', e); }
      }

      // ── 0) Reversal leg (only when prior auto-credit exists) ────────
      const prior = existing.data;
      // PR A: parked pending_claim has no wallet credit — block route entirely.
      if (prior && (prior as any).pending_claim) {
        throw new Error(
          'PENDING_CLAIM: this email is linked to a parked unmatched MoMo deposit awaiting OTP claim. '
          + 'Do not route/credit. Cancel the park in FinOps first, or wait for the payer to claim (PR C).',
        );
      }
      const mustReverse = !!prior && !!prior.original_user_id && prior.original_user_id !== user.id;
      if (mustReverse && prior) {
        const wasFloat = (prior.deposit_purpose ?? 'operational_float') === 'operational_float';
        const debitBody = {
          target_user_id: prior.original_user_id,
          amount: Math.min(prior.original_amount || amt, amt),
          reason: `Reversed auto-credit (re-routed to ${user.full_name}): ${reason.trim()}`,
          operation: 'debit' as const,
          wallet_category: wasFloat ? 'agent_float_deposit' : 'wallet_deposit',
          platform_category: wasFloat ? 'agent_float_deposit' : 'wallet_deposit',
          financial_impact: 'neutral' as const,
          category_label: wasFloat ? 'Reverse auto-credit (Float)' : 'Reverse auto-credit (Wallet)',
          recipient_type: wasFloat ? 'operational_wallet' : 'user',
          sub_category: row.transaction_id ?? null,
          allow_overdraw: forceReversalRef.current,
        };
        const revRes = await supabase.functions.invoke('cfo-direct-credit', { body: debitBody });
        const revData = revRes.data;
        const revErrMsg = await edgeErrorMessage(revRes, 'Reversal failed');
        if (revErrMsg) {
          if (!forceReversalRef.current && String(revErrMsg).includes('NEGATIVE_WALLET_BLOCKED')) {
            setForcePending({ amount: debitBody.amount, name: prior.original_user_name || 'the original user' });
            throw new Error('FORCE_REVERSAL_CONFIRMATION_REQUIRED');
          }
          throw new Error(`Reversal failed: ${revErrMsg}`);
        }
        const reversalRef = (revData as any)?.reference_id ?? null;

        // Mark the original deposit as reversed (best-effort; ignore if column rejects value).
        try {
          await (supabase.from('deposit_requests') as any)
            .update({ status: 'reversed', notes: `Reversed by Financial Ops — re-routed to ${user.full_name}.` })
            .eq('id', prior.deposit_id);
        } catch { /* ignore */ }

        // Log the reversal in routing history (best-effort).
        try {
          const { data: me } = await supabase.auth.getUser();
          if (me?.user?.id) {
            await (supabase.from('email_routing_history') as any).insert({
              gmail_transaction_id: row.id,
              gmail_message_id: row.gmail_message_id ?? null,
              transaction_id: row.transaction_id,
              from_email: row.from_email,
              from_name: row.from_name,
              subject: row.subject,
              amount: debitBody.amount,
              route: wasFloat ? 'operational_float' : 'personal_deposit',
              target_user_id: prior.original_user_id,
              target_user_name: prior.original_user_name,
              target_user_phone: prior.original_user_phone,
              reason: `REVERSAL → re-routed to ${user.full_name}. ${reason.trim()}`,
              ledger_reference_id: reversalRef,
              routed_by: me.user.id,
              routed_by_name: null,
              sms_sent: false,
              sms_error: null,
            });
          }
        } catch (e) { console.warn('[RouteEmailDeposit] reversal history insert failed', e); }

        // Notify the original user their auto-credit was reversed.
        if (prior.original_user_phone) {
          try {
            await supabase.functions.invoke('notify-email-routing', {
              body: {
                phone: prior.original_user_phone,
                target_user_name: prior.original_user_name,
                amount: debitBody.amount,
                route: wasFloat ? 'operational_float' : 'personal_deposit',
                reference_id: reversalRef,
                from_label: row.from_name || row.from_email || null,
                transaction_id: row.transaction_id,
                reversal: true,
              },
            });
          } catch (e) { console.warn('[RouteEmailDeposit] reversal SMS failed', e); }
        }
      }

      // The reference the backend reconciles against: the email's own TID
      // when present, otherwise the manual reference the operator typed in.
      const effectiveReference = (row.transaction_id?.trim() || manualReference.trim()) || null;
      // Phone number the money actually came from, so the backend can learn it
      // for this user and auto-credit their next deposit from the same number.
      // Preference: the phone matched in the email body, else the single
      // Ugandan number visible in counterparty / subject / snippet.
      const sourcePhone = (() => {
        if (user.matched_phone) return user.matched_phone;
        const hay = `${row.counterparty ?? ''}\n${row.subject ?? ''}\n${row.snippet ?? ''}`;
        const found = new Set(
          (hay.match(/(?:\+?256|0)?7\d{8}/g) ?? []).map((t) => t.replace(/\D/g, '').slice(-9)),
        );
        return found.size === 1 ? Array.from(found)[0] : null;
      })();
      // Payer name for the name-learning path. `counterparty_name` is the
      // authoritative field once a row has been phone-enriched (see the type
      // doc above); `counterparty` is only a valid name source when it isn't
      // itself phone-shaped (older / non-enriched name-only receipts still
      // carry the name there).
      const phoneShapeRe = /^(?:\+?256|0)\d{9}$/;
      const sourceName = row.counterparty_name
        || (row.counterparty && !phoneShapeRe.test(row.counterparty.trim()) ? row.counterparty : null);
      const body = {
        target_user_id: user.id,
        amount: amt,
        reason: reason.trim(),
        operation: 'credit' as const,
        wallet_category: isFloat ? 'agent_float_deposit' : 'wallet_deposit',
        platform_category: isFloat ? 'agent_float_deposit' : 'wallet_deposit',
        financial_impact: 'neutral' as const,
        category_label: isFloat ? 'Operational Float (from email)' : 'Personal Deposit (from email)',
        recipient_type: isFloat ? 'operational_wallet' : 'user',
        sub_category: effectiveReference,
        // Forwarded so the edge function's server-side idempotency guard can
        // reject a duplicate credit for the same email / TID even if the
        // client-side verify call was bypassed or stale.
        gmail_transaction_id: row.id ?? null,
        gmail_message_id: row.gmail_message_id ?? null,
        email_tid: effectiveReference,
        source_phone: sourcePhone,
        // Payer name as MTN/Airtel reported it (till receipts carry only a
        // name, never a phone) — lets the backend learn "this name pays on
        // behalf of this user" so the next receipt from the same name
        // auto-credits instead of returning to this manual queue.
        source_name: sourceName,
      };
      // ── Authoritative backend pre-flight ──────────────────────────
      // Re-checks credited status from the DB (not React Query cache)
      // so a stale frontend cannot cause a double-credit. Refuses to
      // proceed if `verify-email-credit-status` returns safe_to_credit=false
      // for any blocking reason other than the "different user, reversal
      // already handled above" case.
      try {
        const { data: verify } = await supabase.functions.invoke('verify-email-credit-status', {
          body: {
            gmail_transaction_id: row.id,
            gmail_message_id: row.gmail_message_id ?? null,
            target_user_id: user.id,
            proposed_amount: amt,
            proposed_reference: effectiveReference,
          },
        });
        const v = verify as any;
        if (v && v.safe_to_credit === false) {
          const blocking = ['DUPLICATE_DEPOSIT', 'DUPLICATE_LEDGER_LEG', 'AMOUNT_MISMATCH', 'REFERENCE_MISSING', 'EMAIL_NOT_FOUND'];
          if (blocking.includes(v.reason)) {
            throw new Error(`Backend blocked credit (${v.reason}): ${v.message}`);
          }
        }
      } catch (verr: any) {
        // Only re-throw our deliberate blocks; network errors must not
        // silently bypass the gate, so surface them too.
        throw new Error(verr?.message || 'Pre-credit verification failed');
      }
      const creditRes = await supabase.functions.invoke('cfo-direct-credit', { body });
      const data = creditRes.data;
      const creditErrMsg = await edgeErrorMessage(creditRes, 'Routing failed');
      if (creditErrMsg) throw new Error(creditErrMsg);
      const referenceId = (data as any)?.reference_id ?? null;

      // 2) Fire SMS notification to the routed user (best-effort).
      let smsSent = false;
      let smsError: string | null = null;
      try {
        const fromLabel = row.from_name || row.from_email || null;
        const { data: smsRes, error: smsErr } = await supabase.functions.invoke('notify-email-routing', {
          body: {
            phone: user.phone,
            target_user_name: user.full_name,
            amount: amt,
            route,
            reference_id: referenceId,
            from_label: fromLabel,
            transaction_id: row.transaction_id,
          },
        });
        if (smsErr) smsError = (await edgeErrorMessage({ data: smsRes, error: smsErr }, 'SMS dispatch failed')) || 'SMS dispatch failed';
        else if ((smsRes as any)?.success) smsSent = true;
        else smsError = (smsRes as any)?.error || 'SMS not delivered';
      } catch (e: any) {
        smsError = e?.message || 'SMS dispatch threw';
      }

      // 3) Record routing history (best-effort — never block the credit).
      try {
        const { data: me } = await supabase.auth.getUser();
        const routedBy = me?.user?.id;
        if (routedBy) {
          let routedByName: string | null = null;
          try {
            const { data: rp } = await (supabase.from('profiles') as any)
              .select('full_name')
              .eq('id', routedBy)
              .maybeSingle();
            routedByName = rp?.full_name ?? null;
          } catch { /* ignore */ }

          await (supabase.from('email_routing_history') as any).insert({
            gmail_transaction_id: row.id,
            gmail_message_id: row.gmail_message_id ?? null,
            transaction_id: row.transaction_id,
            from_email: row.from_email,
            from_name: row.from_name,
            subject: row.subject,
            amount: amt,
            route,
            target_user_id: user.id,
            target_user_name: user.full_name,
            target_user_phone: user.phone,
            reason: reason.trim(),
            ledger_reference_id: referenceId,
            routed_by: routedBy,
            routed_by_name: routedByName,
            sms_sent: smsSent,
            sms_error: smsError,
          });
        }
      } catch (e) {
        console.warn('[RouteEmailDeposit] history insert failed', e);
      }

      return { ...(data as any), smsSent, smsError, reversed: mustReverse, forcedReversal: forceReversalRef.current, transferredFrom: transferFromUser ? sourceUser?.full_name ?? null : null };
    },
    onSuccess: (res: any) => {
      // Notify the parent list so it can refetch this row's routing history
      // and update the status pill immediately (no reload needed).
      if (row?.id) onRouted?.(row.id);
      if (mode === 'debit') {
        if (user) {
          const attempted = debitRoute === 'landlord_float' ? 'float' : debitRoute === 'proxy_agent_wallet' ? 'proxy_withdrawable' : 'withdrawable';
          const avail = destBuckets.data
            ? (attempted === 'float' ? destBuckets.data.float : destBuckets.data.withdrawable)
            : 0;
          logBucketAttempt({
            targetUserId: res?.debitTargetUserId ?? user.id,
            targetUserName: res?.debitTargetName ?? user.full_name,
            attemptedBucket: attempted as any,
            amount: amtNum,
            availableAtAttempt: avail,
            outcome: 'succeeded',
            gmailTransactionId: row?.id ?? null,
            transactionReference: row?.transaction_id ?? null,
          });
        }
        const routeLabel = debitRoute === 'landlord_float' ? 'Landlord-Payout Float' : 'Withdrawable';
        const proxyNote = res?.proxyRedirected ? ` (redirected to proxy agent ${res.debitTargetName})` : '';
        toast({
          title: 'Wallet debited',
          description: `${formatUGX(Number(amount))} debited from ${res?.debitTargetName ?? user?.full_name}${proxyNote} as ${routeLabel}.${res?.smsSent ? ' SMS sent.' : ''}`,
        });
        onOpenChange(false);
        return;
      }
      if (res?.bucketMoved) {
        toast({
          title: 'Moved between buckets',
          description: `${formatUGX(Number(res.moveAmount) || Number(amount))} moved to ${res.movedToFloat ? 'Operational Float' : 'Personal Deposit'} for ${user?.full_name} (no new credit — funds switched buckets).`,
        });
        onOpenChange(false);
        return;
      }
      const routeLabel = route === 'operational_float' ? 'Operational Float' : 'Personal Deposit';
      const reversedPart = res?.forcedReversal
        ? ' Original auto-credit force-reversed; recoverable obligation recorded.'
        : res?.reversed ? ' Original auto-credit reversed.' : '';
      const transferPart = res?.transferredFrom ? ` Debited from ${res.transferredFrom}.` : '';
      toast({
        title: 'Deposit routed',
        description: res?.smsSent
          ? `${formatUGX(Number(amount))} credited to ${user?.full_name} as ${routeLabel}. SMS sent.${reversedPart}${transferPart}`
          : `${formatUGX(Number(amount))} credited to ${user?.full_name} as ${routeLabel}. SMS could not be sent${res?.smsError ? ` (${res.smsError})` : ''}.${reversedPart}${transferPart}`,
      });
      onOpenChange(false);
    },
    onError: (e: any) => {
      if (e.message === 'FORCE_REVERSAL_CONFIRMATION_REQUIRED') return;
      // Translate raw backend errors into plain-English reasons an
      // ordinary operator can act on. Falls back to the original message
      // for anything we don't recognise.
      const raw = String(e?.message ?? '');
      const targetName = (mode === 'debit' ? user?.full_name : (transferFromUser ? sourceUser?.full_name : user?.full_name)) || 'this wallet';
      const amountLabel = amtNum > 0 ? formatUGX(amtNum) : 'the requested amount';
      let friendly = raw;
      const negMatch = raw.match(/NEGATIVE_WALLET_BLOCKED.*?strict available balance is (\d+)/i);
      if (negMatch) {
        const avail = Number(negMatch[1] ?? 0);
        friendly = `${targetName} doesn't have enough money in the selected wallet bucket. Their available balance is ${formatUGX(avail)}, but you tried to take out ${amountLabel}. Either pick a different bucket that has the funds, lower the amount, or use "Force reverse & route" to record what's missing as a recoverable obligation that will be paid back from their next incoming credit.`;
      } else if (/INVALID_ROUTING/i.test(raw)) {
        friendly = `Wrong wallet bucket for this kind of money. ${raw.replace(/^INVALID_ROUTING:\s*/i, '')}`;
      } else if (/RECIPIENT_TYPE_REQUIRED/i.test(raw)) {
        friendly = 'You must choose whether this goes to the user (Withdrawable) or the Operational Wallet (Float).';
      } else if (/Unauthorized/i.test(raw)) {
        friendly = 'Your session is no longer signed in. Please refresh the page and sign in again.';
      } else if (/Insufficient permissions/i.test(raw)) {
        friendly = 'Your current role is not allowed to move money. Switch to CFO, Manager, or Super Admin and try again.';
      } else if (/Reason must be at least 10/i.test(raw)) {
        friendly = 'The reason needs to be at least 10 characters so it makes sense in the audit log.';
      } else if (/Invalid amount/i.test(raw)) {
        friendly = 'The amount is not valid. Enter a positive number up to UGX 500,000,000.';
      } else if (/Target user not found/i.test(raw)) {
        friendly = 'We could not find the recipient profile. They may have been removed.';
      } else if (/treasury|maintenance/i.test(raw)) {
        friendly = 'Money movement is temporarily paused for maintenance. Try again in a few minutes.';
      } else if (/SMS/i.test(raw)) {
        friendly = `${raw} (The money movement may have still succeeded — please check the wallet before retrying.)`;
      }

      if (mode === 'debit' && user) {
        const attempted = debitRoute === 'landlord_float' ? 'float' : debitRoute === 'proxy_agent_wallet' ? 'proxy_withdrawable' : 'withdrawable';
        const avail = destBuckets.data
          ? (attempted === 'float' ? destBuckets.data.float : destBuckets.data.withdrawable)
          : 0;
        const isInsufficient = /NEGATIVE_WALLET_BLOCKED|strict available balance|insufficient/i.test(raw);
        logBucketAttempt({
          targetUserId: user.id,
          targetUserName: user.full_name,
          attemptedBucket: attempted as any,
          amount: amtNum,
          availableAtAttempt: avail,
          outcome: isInsufficient ? 'insufficient_funds_blocked' : 'failed_other',
          failureReason: raw.slice(0, 500),
          gmailTransactionId: row?.id ?? null,
          transactionReference: row?.transaction_id ?? null,
        });
      }
      toast({ title: mode === 'debit' ? 'Could not debit wallet' : 'Could not route deposit', description: friendly, variant: 'destructive' });
    },
  });

  // One-tap "Confirm & retry with {bucket}" effect.
  // When the operator taps the auto-switch button we set both
  // `debitRoute` and `pendingAutoSubmit` to the covering route. On the
  // next render where the route has updated and the destination bucket
  // (now re-evaluated against fresh `destBuckets.data`) actually covers
  // the amount, we fire `send.mutate()` exactly once and clear the flag.
  // Any operator edit (amount/user/route change away from the queued
  // route) cancels the pending submit so we never silently send the
  // wrong thing.
  useEffect(() => {
    if (!pendingAutoSubmit) return;
    if (debitRoute !== pendingAutoSubmit) {
      setPendingAutoSubmit(null);
      return;
    }
    if (send.isPending) return;
    if (!user || amtNum <= 0 || reason.trim().length < 10) return;
    if (!destBuckets.data) return;
    const covers =
      pendingAutoSubmit === 'landlord_float'
        ? destBuckets.data.float >= amtNum
        : pendingAutoSubmit === 'withdrawable'
          ? destBuckets.data.withdrawable >= amtNum
          : false;
    if (!covers) {
      setPendingAutoSubmit(null);
      return;
    }
    setPendingAutoSubmit(null);
    send.mutate();
  }, [pendingAutoSubmit, debitRoute, destBuckets.data, amtNum, user, reason, send]);

  // ── Pre-flight balance gates ─────────────────────────────────────
  // Debit mode: check the destination user's selected bucket.
  const bucketShort = (() => {
    if (mode !== 'debit' || !user || !destBuckets.data || amtNum <= 0 || debitRoute === 'proxy_agent_wallet') return null;
    const w = destBuckets.data.withdrawable;
    const f = destBuckets.data.float;
    if (debitRoute === 'withdrawable' && w < amtNum) {
      return { have: w, otherLabel: (f >= amtNum ? 'Float' : null) as 'Float' | null, otherHave: f, otherRoute: (f >= amtNum ? 'landlord_float' : null) as DebitRoute | null };
    }
    if (debitRoute === 'landlord_float' && f < amtNum) {
      return { have: f, otherLabel: (w >= amtNum ? 'Withdrawable' : null) as 'Withdrawable' | null, otherHave: w, otherRoute: (w >= amtNum ? 'withdrawable' : null) as DebitRoute | null };
    }
    return null;
  })();

  // Credit mode wallet-to-wallet transfer: check the source user's selected bucket.
  const sourceBucketShort = (() => {
    if (mode !== 'credit' || !transferFromUser || !sourceUser || !sourceBuckets.data || amtNum <= 0) return null;
    const cur = transferFromBucket === 'withdrawable' ? sourceBuckets.data.withdrawable : sourceBuckets.data.float;
    const other = transferFromBucket === 'withdrawable' ? sourceBuckets.data.float : sourceBuckets.data.withdrawable;
    if (cur < amtNum) {
      return {
        have: cur,
        otherLabel: (transferFromBucket === 'withdrawable' ? 'Float' : 'Withdrawable') as 'Float' | 'Withdrawable',
        otherHave: other,
        otherBucket: (transferFromBucket === 'withdrawable' ? 'float' : 'withdrawable') as 'withdrawable' | 'float',
      };
    }
    return null;
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md sm:max-w-lg p-0 gap-0 max-h-[100dvh] sm:max-h-[90vh] h-[100dvh] sm:h-auto flex flex-col"
      >
        <DialogHeader className="px-4 pt-4 pb-3 border-b shrink-0">
          <div className="flex items-start justify-between gap-2">
            <DialogTitle className="text-base sm:text-lg truncate">
              {lowData
                ? (mode === 'debit' ? 'Debit wallet' : 'Route deposit')
                : (mode === 'debit' ? 'Charge outgoing payment to user wallet' : 'Redirect deposit to user')}
            </DialogTitle>
            <button
              type="button"
              onClick={() => setLowData((v) => !v)}
              className={`shrink-0 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
                lowData
                  ? 'border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200'
                  : 'border-border bg-muted text-muted-foreground hover:bg-muted/70'
              }`}
              aria-pressed={lowData}
              aria-label={lowData ? 'Low-data mode is on. Tap to turn off.' : 'Turn on low-data mode for weak connections'}
              title={lowData ? 'Low-data mode ON — hiding history & helper text' : 'Low-data mode OFF'}
            >
              {lowData ? <WifiOff className="h-3.5 w-3.5" /> : <Wifi className="h-3.5 w-3.5" />}
              {lowData ? 'Low-data' : 'Low-data'}
            </button>
          </div>
          {!lowData && (
            <DialogDescription className="text-xs sm:text-sm">
              {mode === 'debit'
                ? 'Debits this outbound transaction from a user\'s wallet (never from Welile operational float). Auto-redirects to the proxy agent\'s wallet when the picked user is a partner with a managed-proxy assignment.'
                : 'Credit this inbound transaction to a specific user as Personal Deposit (withdrawable) or Operational Float.'}
            </DialogDescription>
          )}
        </DialogHeader>

        {/* Prev / Next navigation bar — sticky, thumb-friendly for phones */}
        {(canPrev || canNext) && (
          <div className="shrink-0 border-b bg-muted/30 px-3 py-2.5 flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-10 px-3 gap-1 text-xs flex-1"
              disabled={!canPrev}
              onClick={onPrev}
            >
              <ChevronLeft className="h-4 w-4" />
              Prev email
            </Button>
            <span className="text-[11px] text-muted-foreground tabular-nums px-1">
              {currentIndex ?? 0} / {totalCount ?? 0}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-10 px-3 gap-1 text-xs flex-1"
              disabled={!canNext}
              onClick={onNext}
            >
              Next email
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {row && (
          <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1">
            <p><span className="text-muted-foreground">From:</span> <span className="font-medium">{row.from_name || row.from_email || '—'}</span></p>
            {!lowData && row.transaction_id && (
              <p className="font-mono text-sm break-all"><span className="text-muted-foreground font-sans">TID:</span> {row.transaction_id}</p>
            )}
            {!lowData && (
              <p className="line-clamp-2"><span className="text-muted-foreground">Subject:</span> {row.subject || '—'}</p>
            )}
          </div>
        )}

        {mode === 'credit' && existing.data && (existing.data as any).pending_claim && (
          <div className="rounded-lg border border-violet-300 bg-violet-50 p-3 text-xs flex gap-2 dark:bg-violet-950/30 dark:border-violet-800">
            <AlertTriangle className="h-4 w-4 text-violet-600 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <p className="font-medium text-violet-900 dark:text-violet-200">Parked unmatched MoMo — awaiting OTP claim</p>
              {!lowData && (
                <p className="text-violet-800 dark:text-violet-300">
                  Deposit <span className="font-mono">{(existing.data as any).deposit_id}</span> is linked
                  with pending_claim / claim_state=awaiting_otp. Wallet credit is blocked until claim (PR C).
                  Route is disabled to prevent double credit.
                  {(existing.data as any).payer_name ? <> Payer on receipt: <span className="font-semibold">{(existing.data as any).payer_name}</span>.</> : null}
                  {(existing.data as any).needs_finops_confirm_before_invite
                    ? <> Amount &gt; UGX 500,000 — FinOps confirm required before invite (PR B).</>
                    : null}
                </p>
              )}
            </div>
          </div>
        )}
        {mode === 'credit' && existing.data && user && existing.data.original_user_id && existing.data.original_user_id !== user.id && !(existing.data as any).pending_claim && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs flex gap-2 dark:bg-amber-950/30 dark:border-amber-800">
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <p className="font-medium text-amber-900 dark:text-amber-200">Will reverse prior auto-credit</p>
              {!lowData && (
                <p className="text-amber-800 dark:text-amber-300">
                  {formatUGX(existing.data.original_amount)} was auto-credited to <span className="font-semibold">{existing.data.original_user_name}</span>. Routing now will debit them and credit the chosen user. Both users will be SMS-notified.
                </p>
              )}
            </div>
          </div>
        )}
        {forcePending && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs space-y-3">
            <div className="flex gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-semibold text-destructive">Original user has UGX 0 available</p>
                <p className="text-muted-foreground">
                  Force reverse {formatUGX(forcePending.amount)} from {forcePending.name}; the system will record a recoverable obligation and clear it from future incoming credits.
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => setForcePending(null)} disabled={send.isPending}>Cancel</Button>
              <Button type="button" variant="destructive" size="sm" className="flex-1" onClick={() => { forceReversalRef.current = true; setForcePending(null); send.mutate(); }} disabled={send.isPending}>
                {send.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Force reverse & route'}
              </Button>
            </div>
          </div>
        )}
        {mode === 'credit' && existing.data && user && existing.data.original_user_id === user.id && !(existing.data as any).pending_claim && (
          <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
            This deposit was already auto-credited to {existing.data.original_user_name}. Routing will add another credit — confirm this is intentional.
          </div>
        )}

        {mode === 'debit' && proxy.data?.isManaged && (
          <div className="rounded-lg border border-violet-300 bg-violet-50 p-3 text-xs flex gap-2 dark:bg-violet-950/30 dark:border-violet-800">
            <UserCog className="h-4 w-4 text-violet-600 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <p className="font-medium text-violet-900 dark:text-violet-200">Managed-proxy partner detected</p>
              {!lowData && (
                <p className="text-violet-800 dark:text-violet-300">
                  <span className="font-semibold">{user?.full_name}</span> is managed by proxy agent <span className="font-semibold">{proxy.data.agentName}</span>. The debit will hit the <span className="font-semibold">proxy agent's wallet</span> first — the partner's wallet is not touched. If the proxy agent has no funds but the partner does, we'll offer to debit the partner directly instead.
                </p>
              )}
            </div>
          </div>
        )}

        {mode === 'debit' && existingDebit.data && (
          <div className="rounded-lg border-2 border-amber-400 bg-amber-50 p-3 text-xs flex gap-2 dark:bg-amber-950/30 dark:border-amber-700">
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-amber-900 dark:text-amber-200 uppercase tracking-wide">
                Wallet already auto-debited
              </p>
              {!lowData && (
              <p className="text-amber-800 dark:text-amber-300">
                {formatUGX(existingDebit.data.amount)} was already deducted from{' '}
                <span className="font-semibold">{existingDebit.data.debited_user_name}</span>
                {' '}({existingDebit.data.wallet_bucket === 'float' ? 'Operational Float' : 'Personal Deposits'})
                {' '}on {new Date(existingDebit.data.transaction_date).toLocaleDateString()} for this same TID.
                {' '}<span className="font-semibold">No further manual debit is needed</span> unless you intend to charge an additional party.
              </p>
              )}
            </div>
          </div>
        )}

        {!lowData && mode === 'debit' && proxy.data && !proxy.data.isManaged && (
          <div className="rounded-lg border bg-muted/30 p-3 text-xs flex gap-2">
            <UserCog className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <p className="font-medium">Proxy agent available</p>
              <p className="text-muted-foreground">
                <span className="font-semibold text-foreground">{user?.full_name}</span> has proxy agent <span className="font-semibold text-foreground">{proxy.data.agentName}</span>. Pick <span className="font-semibold">"Proxy agent wallet"</span> below to debit the agent instead of the partner.
              </p>
            </div>
          </div>
        )}

        <div className="space-y-3">
          {mode === 'credit' && (
            <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={transferFromUser}
                  onChange={(e) => {
                    setTransferFromUser(e.target.checked);
                    if (!e.target.checked) setSourceUser(null);
                  }}
                />
                <div className="text-xs">
                  <p className="font-medium">Move money from a wallet (same or another user)</p>
                  {!lowData && (
                    <p className="text-muted-foreground">Debits the chosen source user's bucket and credits the recipient below. Pick the <span className="font-medium">same user</span> as source and recipient to move their own Operational Float → Personal Deposit (or vice-versa) — no second credit is posted.</p>
                  )}
                </div>
              </label>
              {transferFromUser && (
                <div className="space-y-2">
                  <UserSearchPicker
                    label="Debit wallet of (source user)"
                    placeholder="Search source user by name or phone…"
                    selectedUser={sourceUser}
                    onSelect={setSourceUser}
                  />
                  <div>
                    <Label className="text-xs">Debit from bucket</Label>
                    <RadioGroup
                      value={transferFromBucket}
                      onValueChange={(v) => setTransferFromBucket(v as 'withdrawable' | 'float')}
                      className="mt-1 grid grid-cols-2 gap-2"
                    >
                      <label className={`flex items-start gap-2 rounded-lg border p-2 cursor-pointer hover:bg-muted/40 ${transferFromBucket === 'withdrawable' ? 'border-primary bg-primary/5' : ''}`}>
                        <RadioGroupItem value="withdrawable" id="src-bucket-w" className="mt-0.5" />
                        <div className="text-[11px]">
                          <div className="flex items-center gap-1 font-medium"><Banknote className="h-3 w-3 text-primary" /> Withdrawable</div>
                          <p className="text-muted-foreground">Personal balance</p>
                          {sourceBuckets.data && (
                            <p className={`mt-0.5 font-mono ${amtNum > 0 && sourceBuckets.data.withdrawable < amtNum ? 'text-destructive' : 'text-foreground'}`}>
                              {formatUGX(sourceBuckets.data.withdrawable)}
                              {amtNum > 0 && sourceBuckets.data.withdrawable < amtNum && (
                                <span className="ml-1 text-destructive">· short</span>
                              )}
                            </p>
                          )}
                        </div>
                      </label>
                      <label className={`flex items-start gap-2 rounded-lg border p-2 cursor-pointer hover:bg-muted/40 ${transferFromBucket === 'float' ? 'border-primary bg-primary/5' : ''}`}>
                        <RadioGroupItem value="float" id="src-bucket-f" className="mt-0.5" />
                        <div className="text-[11px]">
                          <div className="flex items-center gap-1 font-medium"><Wallet className="h-3 w-3 text-primary" /> Float</div>
                          <p className="text-muted-foreground">Landlord-payout float</p>
                          {sourceBuckets.data && (
                            <p className={`mt-0.5 font-mono ${amtNum > 0 && sourceBuckets.data.float < amtNum ? 'text-destructive' : 'text-foreground'}`}>
                              {formatUGX(sourceBuckets.data.float)}
                              {amtNum > 0 && sourceBuckets.data.float < amtNum && (
                                <span className="ml-1 text-destructive">· short</span>
                              )}
                            </p>
                          )}
                        </div>
                      </label>
                    </RadioGroup>
                    {/* One-tap "Switch to <other bucket>" hint when the selected bucket can't cover the amount but the other one can */}
                    {sourceBuckets.data && amtNum > 0 && (() => {
                      const cur = transferFromBucket === 'withdrawable' ? sourceBuckets.data.withdrawable : sourceBuckets.data.float;
                      const other = transferFromBucket === 'withdrawable' ? sourceBuckets.data.float : sourceBuckets.data.withdrawable;
                      const otherLabel = transferFromBucket === 'withdrawable' ? 'Float' : 'Withdrawable';
                      if (cur >= amtNum) return null;
                      if (other < amtNum) return (
                        <p className="mt-1 text-[11px] text-destructive">
                          Neither bucket has {formatUGX(amtNum)}. Lower the amount or use Force-reverse if this is a recovery.
                        </p>
                      );
                      return (
                        <button
                          type="button"
                          onClick={() => setTransferFromBucket(transferFromBucket === 'withdrawable' ? 'float' : 'withdrawable')}
                          className="mt-1 w-full rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/20"
                        >
                          Switch to {otherLabel} — has {formatUGX(other)} available
                        </button>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>
          )}

          <UserSearchPicker
            label={mode === 'debit'
              ? 'Charge wallet of user'
              : existing.data
                ? `Route to user — ${formatUGX(existing.data.original_amount)} auto-credited`
                : 'Route to user'
            }
            placeholder="Search by name or phone…"
            selectedUser={user}
            onSelect={setUser}
          />

          {!lowData && mode === 'credit' && (user || (transferFromUser && sourceUser)) && (
            <div className={transferFromUser && sourceUser ? 'grid grid-cols-1 sm:grid-cols-2 gap-2' : ''}>
              {transferFromUser && sourceUser && (
                <MiniLedger
                  userId={sourceUser.id}
                  bucket={transferFromBucket}
                  title={`From · ${sourceUser.full_name} (last 5)`}
                />
              )}
              {user && (
                <MiniLedger
                  userId={user.id}
                  bucket={route === 'operational_float' ? 'float' : 'withdrawable'}
                  title={`To · ${user.full_name} (last 5)`}
                />
              )}
            </div>
          )}

          {mode === 'debit' && user && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-muted-foreground">Wallet type:</span>
                {debitRoute === 'landlord_float' ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-semibold text-primary">
                    <Wallet className="h-3 w-3" /> Operational Float
                  </span>
                ) : debitRoute === 'proxy_agent_wallet' ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 font-semibold text-violet-800 dark:bg-violet-950/40 dark:text-violet-300">
                    <UserCog className="h-3 w-3" /> Proxy Agent · Personal
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                    <Banknote className="h-3 w-3" /> Personal Deposits
                  </span>
                )}
              </div>
              {!lowData && (
                <DebitHistoryPreview
                  userId={debitRoute === 'proxy_agent_wallet' && effectiveProxyAgent ? effectiveProxyAgent.agentId : user.id}
                  bucket={debitRoute === 'landlord_float' ? 'float' : 'withdrawable'}
                  userName={debitRoute === 'proxy_agent_wallet' && effectiveProxyAgent ? effectiveProxyAgent.agentName : user.full_name}
                />
              )}
            </div>
          )}

          {user && proxy.data && (
            <div className="flex items-center gap-2 -mt-1 text-xs text-muted-foreground">
              <UserCog className="h-3.5 w-3.5 text-violet-600" />
              <span>
                Proxy agent:{' '}
                <span className="font-semibold text-foreground">{proxy.data.agentName}</span>
                {proxy.data.agentPhone ? ` · ${proxy.data.agentPhone}` : ''}
                {proxy.data.isManaged && (
                  <span className="ml-1 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-800 dark:bg-violet-950/40 dark:text-violet-300">
                    managed
                  </span>
                )}
              </span>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs">Amount (UGX)</Label>
              {(() => {
                const isFloat =
                  mode === 'credit'
                    ? route === 'operational_float'
                    : debitRoute === 'landlord_float';
                const verb = mode === 'credit' ? 'Crediting' : 'Debiting';
                return (
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
                      isFloat
                        ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200'
                        : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200'
                    }`}
                    aria-label={`${verb} ${isFloat ? 'Operational Float' : 'Personal Deposit'} wallet`}
                  >
                    {isFloat ? <Wallet className="h-3.5 w-3.5" /> : <Banknote className="h-3.5 w-3.5" />}
                    {verb} · {isFloat ? 'Operational Float' : 'Personal Deposit'}
                  </span>
                );
              })()}
            </div>
            <Input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-12 text-lg font-semibold"
              inputMode="numeric"
              autoComplete="off"
            />
            {amount && Number(amount) > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">{formatUGX(Number(amount))}</p>
            )}
          </div>

          {mode === 'credit' && !row?.transaction_id && (
            <div>
              <Label className="text-xs flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                Transaction reference (required)
              </Label>
              <Input
                value={manualReference}
                onChange={(e) => { setManualReference(e.target.value); setAutoExtractedRef(false); }}
                placeholder="MoMo / bank reference or receipt no."
                className="h-11 mt-1 font-mono"
                autoComplete="off"
              />
              {(() => {
                const refCheck = validateTransactionReference(manualReference);
                if (manualReference.trim() && !refCheck.valid) {
                  return (
                    <p className="mt-1 text-[11px] text-destructive flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      {refCheck.message}
                    </p>
                  );
                }
                if (autoExtractedRef && refCheck.valid) {
                  return (
                    <div className="mt-1.5 space-y-2">
                      <p className="text-[11px] text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
                        <Check className="h-3.5 w-3.5 shrink-0" />
                        Auto-detected from the email body — confirm it matches the physical receipt, or edit if wrong.
                      </p>
                      {refExtraction && (() => {
                        const meta = confidenceMeta(refExtraction.confidence);
                        const barTone =
                          meta.tone === 'success' ? 'bg-emerald-500'
                            : meta.tone === 'warning' ? 'bg-amber-500'
                              : meta.tone === 'danger' ? 'bg-destructive'
                                : 'bg-muted-foreground/40';
                        const textTone =
                          meta.tone === 'success' ? 'text-emerald-700 dark:text-emerald-300'
                            : meta.tone === 'warning' ? 'text-amber-700 dark:text-amber-300'
                              : meta.tone === 'danger' ? 'text-destructive'
                                : 'text-muted-foreground';
                        const segments = buildHighlightSegments(
                          refSourceText,
                          refExtraction.matchIndex,
                          refExtraction.matchLength,
                          refExtraction.reference,
                        );
                        return (
                          <div className="rounded-lg border bg-muted/20 p-2 space-y-1.5">
                            {/* Confidence meter */}
                            <div className="flex items-center justify-between gap-2">
                              <span className={`text-[11px] font-semibold ${textTone}`}>{meta.label}</span>
                              <span className="text-[10px] text-muted-foreground">{refExtraction.detail}</span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                              <div className={`h-full rounded-full ${barTone}`} style={{ width: `${meta.percent}%` }} />
                            </div>
                            {/* Highlighted source text */}
                            {segments.length > 0 && (
                              <p className="text-[11px] leading-relaxed text-muted-foreground break-words">
                                {segments.map((seg, i) =>
                                  seg.match ? (
                                    <mark
                                      key={i}
                                      className="rounded bg-amber-200 px-0.5 font-mono font-semibold text-amber-950 dark:bg-amber-400/30 dark:text-amber-200"
                                    >
                                      {seg.text}
                                    </mark>
                                  ) : (
                                    <span key={i}>{seg.text}</span>
                                  ),
                                )}
                              </p>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  );
                }
                if (!lowData) {
                  return (
                    <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                      This email has no reference of its own, so it can't be reconciled or de-duplicated automatically. Enter the physical MoMo / bank reference from the payment before crediting.
                    </p>
                  );
                }
                return null;
              })()}
            </div>
          )}

          {mode === 'credit' && (
          <div>
            <Label className="text-xs">Route as</Label>
            {suggestedWallet.data && user && (
              <div className="mt-1 rounded-md border border-primary/30 bg-primary/5 p-2 text-[11px] flex items-start gap-1.5">
                <History className="h-3.5 w-3.5 shrink-0 mt-0.5 text-primary" />
                <div className="flex-1">
                  <p>
                    Suggested:{' '}
                    <span className="font-semibold">
                      {suggestedWallet.data.suggested === 'operational_float' ? 'Operational Float' : 'Personal Deposit'}
                    </span>{' '}
                    <span className="text-muted-foreground">
                      — {suggestedWallet.data.suggested === 'operational_float'
                        ? suggestedWallet.data.floatCount
                        : suggestedWallet.data.withdrawableCount}
                      /{suggestedWallet.data.total} past deposits ({suggestedWallet.data.confidence}%)
                    </span>
                  </p>
                  {route !== suggestedWallet.data.suggested && (
                    <button
                      type="button"
                      onClick={() => setRoute(suggestedWallet.data!.suggested)}
                      className="mt-0.5 font-medium text-primary underline underline-offset-2"
                    >
                      Use suggestion
                    </button>
                  )}
                </div>
              </div>
            )}
            <RadioGroup value={route} onValueChange={(v) => setRoute(v as Route)} className="mt-1 space-y-2">
              <label className={`flex items-start gap-2 rounded-lg border cursor-pointer hover:bg-muted/40 ${radioCardCls}`}>
                <RadioGroupItem value="personal_deposit" id="route-personal" className="mt-0.5" />
                <div className="flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <Banknote className="h-3.5 w-3.5 text-primary" /> Personal Deposit
                  </div>
                  {!lowData && <p className="text-[11px] text-muted-foreground">Lands in the user's withdrawable balance.</p>}
                </div>
              </label>
              <label className={`flex items-start gap-2 rounded-lg border cursor-pointer hover:bg-muted/40 ${radioCardCls}`}>
                <RadioGroupItem value="operational_float" id="route-float" className="mt-0.5" />
                <div className="flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <Wallet className="h-3.5 w-3.5 text-primary" /> Operational Float
                  </div>
                  {!lowData && <p className="text-[11px] text-muted-foreground">Lands in float balance (cannot be withdrawn; for rent collection).</p>}
                </div>
              </label>
            </RadioGroup>
            {isSameUserBucketMove && user && (
              <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 flex items-start gap-1.5">
                <ArrowLeftRight className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>
                  This deposit was already credited to <span className="font-medium">{user.full_name}</span> as{' '}
                  <span className="font-medium">{priorAutoCreditWasFloat ? 'Operational Float' : 'Personal Deposit'}</span>.
                  Confirming will <span className="font-semibold">move</span> the funds to{' '}
                  <span className="font-medium">{route === 'operational_float' ? 'Operational Float' : 'Personal Deposit'}</span>{' '}
                  on the same wallet — no second credit is created.
                </span>
              </div>
            )}
            {transferFromUser && sourceUser && user && (
              <div className="mt-2 rounded-md border border-primary/30 bg-primary/5 p-2 text-[11px] flex items-center gap-1.5">
                <ArrowRight className="h-3 w-3 text-primary shrink-0" />
                <span>
                  <span className="font-medium">{sourceUser.full_name}</span>
                  <span className="text-muted-foreground"> ({transferFromBucket === 'float' ? 'Float' : 'Withdrawable'})</span>
                  {' → '}
                  <span className="font-medium">{user.full_name}</span>
                  <span className="text-muted-foreground"> ({route === 'operational_float' ? 'Float' : 'Withdrawable'})</span>
                </span>
              </div>
            )}
          </div>
          )}

          {mode === 'debit' && (
          <div>
            <Label className="text-xs">Deduct from</Label>
            <RadioGroup value={debitRoute} onValueChange={(v) => setDebitRoute(v as DebitRoute)} className="mt-1 space-y-2">
              <label className={`flex items-start gap-2 rounded-lg border cursor-pointer hover:bg-muted/40 ${radioCardCls}`}>
                <RadioGroupItem value="withdrawable" id="debit-withdrawable" className="mt-0.5" />
                <div className="flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <Banknote className="h-3.5 w-3.5 text-primary" /> Withdrawable balance
                  </div>
                  {!lowData && <p className="text-[11px] text-muted-foreground">Reduces the user's withdrawable wallet. Use when the payment was for personal money the user owns.</p>}
                </div>
              </label>
              <label className={`flex items-start gap-2 rounded-lg border cursor-pointer hover:bg-muted/40 ${radioCardCls}`}>
                <RadioGroupItem value="landlord_float" id="debit-landlord-float" className="mt-0.5" />
                <div className="flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <Wallet className="h-3.5 w-3.5 text-primary" /> Landlord-Payout Float
                  </div>
                  {!lowData && <p className="text-[11px] text-muted-foreground">Reduces the agent's float balance. Use when a landlord was paid out of the agent's collected rent float.</p>}
                </div>
              </label>
              {/* Proxy agent wallet — always available so Financial Ops can
                  charge ANY proxy agent's wallet, not just the one auto-assigned
                  to the picked partner. */}
              <label className={`flex items-start gap-2 rounded-lg border cursor-pointer hover:bg-muted/40 ${radioCardCls}`}>
                <RadioGroupItem value="proxy_agent_wallet" id="debit-proxy-agent" className="mt-0.5" />
                <div className="flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <UserCog className="h-3.5 w-3.5 text-primary" /> Proxy agent wallet
                    {effectiveProxyAgent && (
                      <span className="ml-1 text-[10px] text-muted-foreground font-normal">
                        ({effectiveProxyAgent.agentName}{effectiveProxyAgent.manual ? ' · chosen' : ''})
                      </span>
                    )}
                  </div>
                  {!lowData && <p className="text-[11px] text-muted-foreground">Reduces a proxy agent's withdrawable balance instead of the partner's. Pick any proxy agent below.</p>}
                </div>
              </label>
              {/* Manual proxy-agent picker — lets the operator search and charge
                  any proxy agent's wallet for this debit. Defaults to the
                  auto-detected assignment when one exists. */}
              {debitRoute === 'proxy_agent_wallet' && (
                <div className="ml-1 space-y-1.5">
                  <UserSearchPicker
                    label="Proxy agent to charge"
                    placeholder="Search any proxy agent by name or phone…"
                    selectedUser={manualProxyAgent}
                    onSelect={setManualProxyAgent}
                  />
                  {!manualProxyAgent && proxy.data && (
                    <p className="text-[11px] text-muted-foreground">
                      Using auto-detected proxy <span className="font-medium text-foreground">{proxy.data.agentName}</span>. Search above to charge a different agent.
                    </p>
                  )}
                  {manualProxyAgent && (
                    <button
                      type="button"
                      onClick={() => setManualProxyAgent(null)}
                      className="text-[11px] font-medium text-primary hover:underline"
                    >
                      {proxy.data ? `Reset to auto-detected (${proxy.data.agentName})` : 'Clear selection'}
                    </button>
                  )}
                  {!manualProxyAgent && !proxy.data && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-400">
                      No proxy agent auto-detected for this user — search and pick one to charge.
                    </p>
                  )}
                </div>
              )}
            </RadioGroup>
          </div>
          )}

          {/* Mobile-first transfer summary — visible as soon as user + amount are set */}
          <TransferSummaryCard
            mode={mode}
            amount={amtNum}
            fromUser={transferFromUser ? sourceUser : null}
            fromBucket={transferFromBucket}
            toUser={user}
            toBucket={recipientBucket}
            proxyInfo={effectiveProxyAgent ? { agentName: effectiveProxyAgent.agentName } : null}
            debitRoute={debitRoute}
            lowData={lowData}
            sourceBuckets={sourceBuckets.data}
            destBuckets={destBuckets.data}
            transactionReference={row?.transaction_id ?? null}
            gmailTransactionId={row?.id ?? null}
            onSwitchBucket={(() => {
              if (mode === 'debit' && bucketShort?.otherRoute) {
                return () => {
                  if (user) {
                    const fromBucketName = debitRoute === 'landlord_float' ? 'float' : 'withdrawable';
                    const toBucketName = bucketShort.otherRoute === 'landlord_float' ? 'float' : 'withdrawable';
                    logBucketAttempt({
                      targetUserId: user.id,
                      targetUserName: user.full_name,
                      attemptedBucket: fromBucketName as any,
                      amount: amtNum,
                      availableAtAttempt: bucketShort.have,
                      outcome: 'switched',
                      switchedToBucket: toBucketName as any,
                      failureReason: `TransferSummaryCard one-tap: ${fromBucketName}=${bucketShort.have} → ${toBucketName}=${bucketShort.otherHave}`,
                      gmailTransactionId: row?.id ?? null,
                      transactionReference: row?.transaction_id ?? null,
                    });
                  }
                  setPendingAutoSubmit(bucketShort.otherRoute!);
                  setDebitRoute(bucketShort.otherRoute!);
                };
              }
              if (mode === 'credit' && transferFromUser && sourceBucketShort && sourceBucketShort.otherHave >= amtNum) {
                return () => setTransferFromBucket(sourceBucketShort.otherBucket);
              }
              return undefined;
            })()}
          />

          <div>
            <Label className="text-xs">Reason (min 10 chars)</Label>
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="text-sm" />
          </div>

          {awaitingConfirm && mode === 'credit' && user && (
            <div className="rounded-lg border-2 border-primary/40 bg-primary/5 p-3 space-y-3">
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <AlertTriangle className="h-4 w-4 text-primary" /> Confirm transfer
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {transferFromUser && sourceUser && (
                  <MiniLedger
                    userId={sourceUser.id}
                    bucket={transferFromBucket}
                    title={`From · ${sourceUser.full_name} (last 5)`}
                  />
                )}
                <MiniLedger
                  userId={user.id}
                  bucket={recipientBucket}
                  title={`To · ${user.full_name} (last 5)`}
                />
              </div>
              <div className="rounded-md border bg-background p-2 space-y-1">
                {transferFromUser && sourceUser && sourceBuckets.data && (
                  <BucketDelta
                    label={`${sourceUser.full_name} · ${transferFromBucket === 'withdrawable' ? 'Personal Deposits' : 'Float'}`}
                    before={transferFromBucket === 'withdrawable' ? sourceBuckets.data.withdrawable : sourceBuckets.data.float}
                    after={(transferFromBucket === 'withdrawable' ? sourceBuckets.data.withdrawable : sourceBuckets.data.float) - amtNum}
                    sign="−"
                  />
                )}
                {destBuckets.data && (
                  <BucketDelta
                    label={`${user.full_name} · ${recipientBucket === 'withdrawable' ? 'Personal Deposits' : 'Float'}`}
                    before={recipientBucket === 'withdrawable' ? destBuckets.data.withdrawable : destBuckets.data.float}
                    after={(recipientBucket === 'withdrawable' ? destBuckets.data.withdrawable : destBuckets.data.float) + amtNum}
                    sign="+"
                  />
                )}
                {(sourceBuckets.isLoading || destBuckets.isLoading) && (
                  <p className="text-[11px] text-muted-foreground">Loading current balances…</p>
                )}
              </div>
              {sourceBucketShort && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] space-y-1.5">
                  {sourceBucketShort.otherHave < amtNum && (
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                      <span className="font-semibold text-destructive">Blocked — insufficient funds</span>
                    </div>
                  )}
                  <p className="text-destructive font-semibold">
                    {sourceUser?.full_name} · {transferFromBucket === 'withdrawable' ? 'Withdrawable' : 'Float'} has only {formatUGX(sourceBucketShort.have)}
                  </p>
                  {sourceBucketShort.otherHave >= amtNum ? (
                    <button
                      type="button"
                      onClick={() => setTransferFromBucket(sourceBucketShort.otherBucket)}
                      className="w-full rounded-md border border-primary/50 bg-primary/15 px-3 py-2.5 text-[13px] font-semibold text-primary hover:bg-primary/25 flex items-center justify-center gap-1.5"
                    >
                      <ArrowRight className="h-4 w-4" />
                      Switch to {sourceBucketShort.otherLabel} — has {formatUGX(sourceBucketShort.otherHave)}
                    </button>
                  ) : (
                    <p className="text-muted-foreground">Other bucket also short. Lower the amount or pick a different source user.</p>
                  )}
                </div>
              )}
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="flex-1 h-11" onClick={() => setAwaitingConfirm(false)} disabled={send.isPending}>
                  Back to edit
                </Button>
                <Button
                  type="button"
                  className={`flex-1 h-11 gap-2 text-sm font-bold shadow-lg ${
                    mode === 'credit'
                      ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-500/30 ring-2 ring-emerald-400/60 ring-offset-2 animate-pulse'
                      : ''
                  }`}
                  onClick={() => send.mutate()}
                  disabled={send.isPending || !!sourceBucketShort}
                >
                  {send.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wallet className="h-5 w-5" />}
                  {mode === 'credit' ? 'Credit wallet' : 'Confirm & route'} {amount ? formatUGX(amtNum) : ''}
                </Button>
              </div>
            </div>
          )}
        </div>
        </div>

        {!awaitingConfirm && (
          <div className="border-t bg-background px-4 py-3 shrink-0">
            {(() => {
              const isFloat =
                mode === 'credit'
                  ? route === 'operational_float'
                  : debitRoute === 'landlord_float';
              const walletLabel = isFloat ? 'Operational Float' : 'Personal Deposit';
              const verb = mode === 'credit' ? 'Credit' : 'Debit';
              const missing: string[] = [];
              if (!user) missing.push('pick recipient');
              if (transferFromUser && !sourceUser) missing.push('pick source user');
              if (!amount || Number(amount) <= 0) missing.push('enter amount');
              if (reason.trim().length < 10) missing.push(`reason (${reason.trim().length}/10)`);
              if (mode === 'debit' && debitRoute === 'proxy_agent_wallet' && !effectiveProxyAgent) {
                missing.push('pick proxy agent');
              }
              if (mode === 'credit' && !row?.transaction_id) {
                const refCheck = validateTransactionReference(manualReference);
                if (!refCheck.valid) {
                  missing.push(autoExtractedRef ? 'verify auto-detected reference' : 'enter valid transaction reference');
                }
              }
              if (bucketShort) missing.push(`insufficient ${debitRoute === 'landlord_float' ? 'Float' : 'Withdrawable'}`);
              if (sourceBucketShort) missing.push(`source ${transferFromBucket === 'withdrawable' ? 'Withdrawable' : 'Float'} short`);
              // PR A: block one-tap route when linked parked pending_claim exists.
              if (mode === 'credit' && existing.data && (existing.data as any).pending_claim) {
                missing.push('parked pending claim — do not route');
              }
              const ready = missing.length === 0 && !send.isPending;
              return (
                <div className="space-y-2">
                  {bucketShort && user && (() => {
                    const attempted = debitRoute === 'landlord_float' ? 'float' : 'withdrawable';
                    // Fire-and-forget; deduped inside logBucketAttempt by user+bucket+amount.
                    logBucketAttempt({
                      targetUserId: user.id,
                      targetUserName: user.full_name,
                      attemptedBucket: attempted as any,
                      amount: amtNum,
                      availableAtAttempt: bucketShort!.have,
                      outcome: 'insufficient_funds_blocked',
                      failureReason: `Pre-flight: ${attempted} has ${bucketShort!.have} < ${amtNum}`,
                      gmailTransactionId: row?.id ?? null,
                      transactionReference: row?.transaction_id ?? null,
                    });
                    return null;
                  })()}
                  {bucketShort && (
                    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] space-y-1.5">
                      {!bucketShort.otherRoute && (
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                          <span className="font-semibold text-destructive">Blocked — insufficient funds</span>
                        </div>
                      )}
                      <p className="text-destructive font-semibold">
                        {user?.full_name} · {debitRoute === 'landlord_float' ? 'Float' : 'Withdrawable'} has only {formatUGX(bucketShort.have)}
                      </p>
                      {bucketShort.otherRoute ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (user) {
                              const fromBucket = debitRoute === 'landlord_float' ? 'float' : 'withdrawable';
                              const toBucket = bucketShort!.otherRoute === 'landlord_float' ? 'float' : 'withdrawable';
                              logBucketAttempt({
                                targetUserId: user.id,
                                targetUserName: user.full_name,
                                attemptedBucket: fromBucket as any,
                                amount: amtNum,
                                availableAtAttempt: bucketShort!.have,
                                outcome: 'switched',
                                switchedToBucket: toBucket as any,
                                failureReason: `One-tap confirm-and-retry: ${fromBucket}=${bucketShort!.have} → ${toBucket}=${bucketShort!.otherHave}`,
                                gmailTransactionId: row?.id ?? null,
                                transactionReference: row?.transaction_id ?? null,
                              });
                            }
                            // One-tap: switch bucket AND queue the submit.
                            // An effect below fires send.mutate() on the next
                            // render where debitRoute matches and pre-flight
                            // is clear, so the operator completes the action
                            // in a single click.
                            setPendingAutoSubmit(bucketShort!.otherRoute!);
                            setDebitRoute(bucketShort!.otherRoute!);
                          }}
                          className="w-full rounded-md border border-primary/50 bg-primary/15 px-3 py-2.5 text-[13px] font-semibold text-primary hover:bg-primary/25 flex items-center justify-center gap-1.5"
                        >
                          <ArrowRight className="h-4 w-4" />
                          Confirm &amp; retry with {bucketShort.otherLabel} ({formatUGX(bucketShort.otherHave)})
                        </button>
                      ) : (
                        <p className="text-muted-foreground">Other bucket also short. Lower the amount or pick a different user.</p>
                      )}
                    </div>
                  )}
                  {sourceBucketShort && (
                    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] space-y-1.5">
                      {sourceBucketShort.otherHave < amtNum && (
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                          <span className="font-semibold text-destructive">Blocked — insufficient funds</span>
                        </div>
                      )}
                      <p className="text-destructive font-semibold">
                        {sourceUser?.full_name} · {transferFromBucket === 'withdrawable' ? 'Withdrawable' : 'Float'} has only {formatUGX(sourceBucketShort.have)}
                      </p>
                      {sourceBucketShort.otherHave >= amtNum ? (
                        <button
                          type="button"
                          onClick={() => setTransferFromBucket(sourceBucketShort.otherBucket)}
                          className="w-full rounded-md border border-primary/50 bg-primary/15 px-3 py-2.5 text-[13px] font-semibold text-primary hover:bg-primary/25 flex items-center justify-center gap-1.5"
                        >
                          <ArrowRight className="h-4 w-4" />
                          Switch to {sourceBucketShort.otherLabel} — has {formatUGX(sourceBucketShort.otherHave)}
                        </button>
                      ) : (
                        <p className="text-muted-foreground">Other bucket also short. Lower the amount or pick a different source user.</p>
                      )}
                    </div>
                  )}
                  <Button
                    type="button"
                    onClick={() => send.mutate()}
                    disabled={!ready}
                    className={`w-full h-16 gap-2 text-base font-bold shadow-xl ${
                      mode === 'credit' && ready
                        ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-500/30 ring-2 ring-emerald-400/60 ring-offset-2 animate-pulse'
                        : mode === 'debit'
                          ? 'bg-destructive hover:bg-destructive/90'
                          : ''
                    }`}
                    variant={mode === 'debit' ? 'destructive' : 'default'}
                    aria-label={
                      ready
                        ? `One-tap confirm: ${verb} ${formatUGX(amtNum)} ${mode === 'credit' ? 'to' : 'from'} ${user?.full_name} (${walletLabel})`
                        : `Cannot confirm: ${missing.join(', ')}`
                    }
                  >
                    {send.isPending ? <Loader2 className="h-6 w-6 animate-spin" /> : <Wallet className="h-6 w-6" />}
                    {ready ? (
                      <span className="flex flex-col items-center leading-tight">
                        <span>{verb} {formatUGX(amtNum)} to wallet</span>
                        <span className="text-[11px] font-medium opacity-90">
                          {mode === 'credit' ? '→ ' : '← '}{user?.full_name} · {walletLabel}
                        </span>
                      </span>
                    ) : (
                      <span>Complete: {missing.join(', ')}</span>
                    )}
                  </Button>
                  {mode === 'credit' && ready && (
                    <button
                      type="button"
                      onClick={() => setAwaitingConfirm(true)}
                      className="w-full text-center text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      Preview balances before confirming
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}