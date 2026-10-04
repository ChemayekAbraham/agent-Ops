import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { extractEdgeFunctionErrorDetails } from '@/lib/extractEdgeFunctionError';
import { formatDynamic } from '@/lib/currencyFormat';
import {
  KeyRound, Loader2, CheckCircle2, Clock, ShieldAlert, AlertTriangle, Lock,
} from 'lucide-react';

const formatCurrency = formatDynamic;

// Financial Ops may try the spoken receipt code a limited number of times
// before the entry screen locks. This is a UI-side guard layered ON TOP of
// the backend's authoritative code/expiry checks in `approve-withdrawal`.
const MAX_ATTEMPTS = 3;

interface ReceiptCodeEntryProps {
  withdrawalId: string;
  amount: number;
  recipientName?: string | null;
  recipientPhone?: string | null;
  /** Fired after the wallet has been debited and payout completed. */
  onVerified: () => void;
  onCancel: () => void;
}

type CodeRow = { id: string; code: string; status: string; expires_at: string | null };

// Stable screen states so the UI can show one clear message at a time.
type Screen =
  | { kind: 'loading' }
  | { kind: 'no_code' }
  | { kind: 'active' }
  | { kind: 'mismatch'; message: string }
  | { kind: 'transient'; message: string }
  | { kind: 'expired'; message: string }
  | { kind: 'used'; message: string }
  | { kind: 'locked' }
  | { kind: 'verifying' }
  | { kind: 'verified' };

function formatRemaining(ms: number): string {
  if (ms <= 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function ReceiptCodeEntry({
  withdrawalId,
  amount,
  recipientName,
  recipientPhone,
  onVerified,
  onCancel,
}: ReceiptCodeEntryProps) {
  const [code, setCode] = useState('');
  const [attemptsUsed, setAttemptsUsed] = useState(0);
  const [codeRow, setCodeRow] = useState<CodeRow | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [now, setNow] = useState(() => Date.now());

  const attemptsRemaining = Math.max(0, MAX_ATTEMPTS - attemptsUsed);

  // Tick every second to drive the live expiry countdown.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const expiresMs = codeRow?.expires_at ? new Date(codeRow.expires_at).getTime() : 0;
  const remainingMs = expiresMs ? Math.max(0, expiresMs - now) : 0;
  const isExpiredByClock = !!expiresMs && remainingMs <= 0;

  // Pull the canonical code row up-front so the operator immediately sees the
  // expiry countdown and any terminal state (already paid / expired) before
  // typing anything.
  const loadCode = useCallback(async () => {
    setScreen({ kind: 'loading' });
    const { data, error } = await supabase
      .from('payout_codes')
      .select('id, code, status, expires_at')
      .eq('withdrawal_request_id', withdrawalId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      setScreen({ kind: 'transient', message: 'Could not load the receipt code. Retry in a moment.' });
      return;
    }
    const row = (data?.[0] as CodeRow | undefined) ?? null;
    setCodeRow(row);
    if (!row) {
      setScreen({ kind: 'no_code' });
      return;
    }
    if (row.status === 'paid') {
      setScreen({ kind: 'used', message: 'This receipt code was already paid out. The same code cannot release a second payout.' });
      return;
    }
    if (row.status === 'expired') {
      setScreen({ kind: 'expired', message: 'This receipt code has expired. Ask the user to resubmit so a fresh code is issued.' });
      return;
    }
    setScreen({ kind: 'active' });
  }, [withdrawalId]);

  useEffect(() => { void loadCode(); }, [loadCode]);

  // Reflect a clock-side expiry without needing a backend round-trip.
  useEffect(() => {
    if (isExpiredByClock && (screen.kind === 'active' || screen.kind === 'mismatch')) {
      setScreen({ kind: 'expired', message: 'This receipt code has just expired. Ask the user to resubmit so a fresh code is issued.' });
    }
  }, [isExpiredByClock, screen.kind]);

  const codeRef = useRef(code);
  codeRef.current = code;

  const handleVerify = useCallback(async () => {
    const entered = codeRef.current.trim();
    if (!/^\d{4}$/.test(entered)) return;
    if (attemptsRemaining <= 0) {
      setScreen({ kind: 'locked' });
      return;
    }
    setScreen({ kind: 'verifying' });
    const res = await supabase.functions.invoke('approve-withdrawal', {
      body: {
        withdrawal_id: withdrawalId,
        reference: entered,
        payment_method: 'cash',
        payout_code: entered,
      },
    });
    if (!res.error && !res.data?.error) {
      setScreen({ kind: 'verified' });
      // Brief success beat so the operator sees confirmation before close.
      setTimeout(() => onVerified(), 900);
      return;
    }

    const details = await extractEdgeFunctionErrorDetails(res);
    const errCode = (details.errorCode || '').toLowerCase();

    if (errCode === 'cash_code_mismatch') {
      const used = attemptsUsed + 1;
      setAttemptsUsed(used);
      if (MAX_ATTEMPTS - used <= 0) {
        setScreen({ kind: 'locked' });
      } else {
        setScreen({
          kind: 'mismatch',
          message: `That code doesn't match the one issued for this withdrawal.`,
        });
      }
      return;
    }
    if (errCode === 'cash_code_expired') {
      setScreen({ kind: 'expired', message: details.message || 'This receipt code has expired. Ask the user to resubmit.' });
      return;
    }
    if (errCode === 'cash_code_already_used') {
      setScreen({ kind: 'used', message: details.message || 'This receipt code was already paid out.' });
      return;
    }
    if (errCode === 'cash_code_not_found') {
      setScreen({ kind: 'no_code' });
      return;
    }
    // Lookup failure / network / anything else — retryable, doesn't burn an attempt.
    setScreen({ kind: 'transient', message: details.message || 'Verification failed. Please try again.' });
  }, [attemptsRemaining, attemptsUsed, onVerified, withdrawalId]);

  const terminal = useMemo(
    () => ['no_code', 'expired', 'used', 'locked'].includes(screen.kind),
    [screen.kind],
  );
  const inputDisabled = screen.kind === 'verifying' || screen.kind === 'verified' || terminal;
  const canVerify =
    /^\d{4}$/.test(code.trim()) &&
    !inputDisabled &&
    attemptsRemaining > 0 &&
    !isExpiredByClock;

  return (
    <div className="space-y-3">
      {/* Recipient + amount summary */}
      <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Releasing to</span>
          <span className="font-semibold text-foreground">
            {recipientName || 'User'}{recipientPhone ? ` · ${recipientPhone}` : ''}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Amount</span>
          <span className="font-black text-foreground">{formatCurrency(amount)}</span>
        </div>
      </div>

      {/* Expiry countdown */}
      {codeRow?.expires_at && screen.kind !== 'verified' && (
        <div
          className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs ${
            isExpiredByClock
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : remainingMs < 5 * 60 * 1000
                ? 'border-warning/40 bg-warning/10 text-warning'
                : 'border-border bg-muted/30 text-muted-foreground'
          }`}
        >
          <span className="flex items-center gap-1.5 font-medium">
            <Clock className="h-3.5 w-3.5" />
            {isExpiredByClock ? 'Code expired' : 'Code expires in'}
          </span>
          <span className="font-mono font-bold tabular-nums">
            {isExpiredByClock ? '00:00' : formatRemaining(remainingMs)}
          </span>
        </div>
      )}

      {/* Loading */}
      {screen.kind === 'loading' && (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading receipt code…
        </div>
      )}

      {/* Success */}
      {screen.kind === 'verified' && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-success/40 bg-success/10 py-6 text-success">
          <CheckCircle2 className="h-8 w-8" />
          <p className="text-sm font-semibold">Code verified — wallet debited</p>
          <p className="text-xs text-success/80">{formatCurrency(amount)} released to {recipientName || 'the user'}.</p>
        </div>
      )}

      {/* Terminal: no code issued / not found */}
      {screen.kind === 'no_code' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm space-y-1">
          <p className="flex items-center gap-1.5 font-semibold text-destructive">
            <ShieldAlert className="h-4 w-4" /> No receipt code on file
          </p>
          <p className="text-xs text-muted-foreground">
            No pickup code exists for this cash request. Reject it and ask the user to resubmit so a fresh code is issued.
          </p>
        </div>
      )}

      {/* Terminal: expired */}
      {screen.kind === 'expired' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm space-y-1">
          <p className="flex items-center gap-1.5 font-semibold text-destructive">
            <Clock className="h-4 w-4" /> Receipt code expired
          </p>
          <p className="text-xs text-muted-foreground">{screen.message}</p>
        </div>
      )}

      {/* Terminal: already used */}
      {screen.kind === 'used' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm space-y-1">
          <p className="flex items-center gap-1.5 font-semibold text-destructive">
            <ShieldAlert className="h-4 w-4" /> Code already used
          </p>
          <p className="text-xs text-muted-foreground">{screen.message}</p>
        </div>
      )}

      {/* Terminal: locked out */}
      {screen.kind === 'locked' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm space-y-1">
          <p className="flex items-center gap-1.5 font-semibold text-destructive">
            <Lock className="h-4 w-4" /> Entry locked
          </p>
          <p className="text-xs text-muted-foreground">
            Too many incorrect attempts ({MAX_ATTEMPTS}). For security, confirm the code with the user and reopen this screen, or reject the request.
          </p>
        </div>
      )}

      {/* Code entry — active / mismatch / transient / verifying */}
      {(screen.kind === 'active' ||
        screen.kind === 'mismatch' ||
        screen.kind === 'transient' ||
        screen.kind === 'verifying') && (
        <div className="space-y-2">
          <div className="space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 p-3">
            <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <KeyRound className="h-4 w-4 text-primary" />
              Enter the code the user read to you
            </label>
            <Input
              autoFocus
              placeholder="e.g. 0428"
              value={code}
              disabled={inputDisabled}
              onChange={(e) => {
                const digitsOnly = e.target.value.replace(/\D/g, '').slice(0, 4);
                setCode(digitsOnly);
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' && canVerify) void handleVerify(); }}
              className="font-mono uppercase tracking-wider text-center text-lg"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
            />
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">Attempts remaining</span>
              <Badge variant={attemptsRemaining <= 1 ? 'destructive' : 'secondary'} className="tabular-nums">
                {attemptsRemaining} / {MAX_ATTEMPTS}
              </Badge>
            </div>
          </div>

          {/* Inline error states */}
          {screen.kind === 'mismatch' && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {screen.message}{' '}
                {attemptsRemaining > 0 && (
                  <span className="font-semibold">
                    {attemptsRemaining} attempt{attemptsRemaining === 1 ? '' : 's'} left before lockout.
                  </span>
                )}
              </span>
            </div>
          )}
          {screen.kind === 'transient' && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{screen.message}</span>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <Button variant="outline" onClick={onCancel} className="flex-1">
          {terminal || screen.kind === 'verified' ? 'Close' : 'Cancel'}
        </Button>
        {screen.kind === 'transient' && (
          <Button variant="secondary" onClick={() => void loadCode()} className="flex-1">
            Retry
          </Button>
        )}
        {!terminal && screen.kind !== 'verified' && (
          <Button
            onClick={() => void handleVerify()}
            disabled={!canVerify}
            className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {screen.kind === 'verifying'
              ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Verifying…</>)
              : 'Verify & release'}
          </Button>
        )}
      </div>
    </div>
  );
}