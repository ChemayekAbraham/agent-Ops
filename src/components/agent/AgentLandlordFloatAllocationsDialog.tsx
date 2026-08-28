import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useLandlordFloatAllocations,
  describeInflightPayout,
  type LandlordFloatAllocation,
} from '@/hooks/useLandlordFloatAllocations';
import { Loader2, Landmark, ArrowRight, Inbox, User, Search, Lock, Clock3 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectAllocation: (allocation: LandlordFloatAllocation) => void;
}

/** Per-landlord withdrawal cooldown: one tap, then locked for 10 minutes. */
const WITHDRAW_LOCK_MS = 10 * 60 * 1000;

const lockStorageKey = (agentId?: string | null) => `welile-ll-withdraw-lock:${agentId ?? 'anon'}`;
const allocationLockKey = (a: LandlordFloatAllocation) => a.landlord_id || a.id;

function maskLandlordPhone(phone?: string | null): string {
  if (!phone) return '';
  const clean = phone.trim();
  if (clean.startsWith('+256')) {
    const rest = clean.slice(4).replace(/\s+/g, '');
    if (rest.length >= 7) {
      return `+256 ${rest.slice(0, 3)} ${rest.charAt(3)}•• •••`;
    }
  }
  const digits = clean.replace(/\D/g, '');
  if (digits.startsWith('256') && digits.length === 12) {
    const nat = digits.slice(3);
    return `+256 ${nat.slice(0, 3)} ${nat.charAt(3)}•• •••`;
  }
  if (digits.startsWith('0') && digits.length === 10) {
    return `${digits.slice(0, 4)} ${digits.charAt(4)}•• •••`;
  }
  if (digits.length === 9) {
    return `0${digits.slice(0, 3)} ${digits.charAt(3)}•• •••`;
  }
  return phone;
}

function loadLocks(agentId?: string | null): Record<string, number> {
  try {
    const raw = localStorage.getItem(lockStorageKey(agentId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    const now = Date.now();
    // Drop expired entries on read so storage stays small.
    return Object.fromEntries(Object.entries(parsed).filter(([, exp]) => exp > now));
  } catch {
    return {};
  }
}

/**
 * Phase 1 — Per-tenant allocations browser.
 * Shows the agent which tenants currently have ring-fenced float ready to be paid
 * to a landlord. Tapping an allocation hands off to the existing payout wizard.
 */
export function AgentLandlordFloatAllocationsDialog({ open, onOpenChange, onSelectAllocation }: Props) {
  const { user } = useAuth();
  const { data: allocations = [], isLoading } = useLandlordFloatAllocations({ onlyOpen: true });

  const [search, setSearch] = useState('');
  const [locks, setLocks] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());

  // Hydrate locks whenever the dialog opens (catches locks set on other screens/sessions).
  useEffect(() => {
    if (open) setLocks(loadLocks(user?.id));
  }, [open, user?.id]);

  // Tick every second while there is at least one active lock so countdowns update.
  const hasActiveLock = useMemo(
    () => Object.values(locks).some((exp) => exp > now),
    [locks, now],
  );
  useEffect(() => {
    if (!open || !hasActiveLock) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open, hasActiveLock]);

  const handleSelect = (a: LandlordFloatAllocation) => {
    const key = allocationLockKey(a);
    const expiry = locks[key];
    if (expiry && expiry > Date.now()) return; // still locked — ignore the tap
    // A payout the agent already submitted is still working through the
    // merchant queue. Opening the wizard here would show a payment form pinned
    // at "Available to pay: UGX 0" (the float is held for that payout), which
    // reads as the app having eaten their money. Let the wizard open so it can
    // show the payout's progress, but do NOT burn a withdrawal lock on it.
    if (a.inflight_payout) {
      onSelectAllocation(a);
      return;
    }
    const next = { ...loadLocks(user?.id), [key]: Date.now() + WITHDRAW_LOCK_MS };
    setLocks(next);
    setNow(Date.now());
    try {
      localStorage.setItem(lockStorageKey(user?.id), JSON.stringify(next));
    } catch {
      /* ignore storage failures */
    }
    onSelectAllocation(a);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allocations;
    return allocations.filter((a) =>
      (a.landlord_name || '').toLowerCase().includes(q) ||
      (a.tenant_name || '').toLowerCase().includes(q) ||
      (a.landlord_phone || '').toLowerCase().includes(q),
    );
  }, [allocations, search]);

  // Split the header total so "ring-fenced" only counts what the agent can
  // still act on. Lumping already-submitted payouts in here is what made the
  // total look spendable while the payout wizard sat at "Available to pay: 0".
  const totalPayable = filtered
    .filter((a) => !a.inflight_payout)
    .reduce((sum, a) => sum + a.remaining_amount, 0);
  const totalInflight = filtered.reduce(
    (sum, a) => sum + (a.inflight_payout?.amount ?? 0),
    0,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md h-[85dvh] max-h-[85dvh] min-h-0 flex flex-col overflow-hidden p-0 gap-0">
        <DialogHeader className="shrink-0 p-4 pr-10 border-b">
          <DialogTitle className="flex items-center gap-2">
            <Landmark className="h-5 w-5 text-[#9234EA]" />
            Pick a Tenant to Pay Their Landlord
          </DialogTitle>
          <DialogDescription className="text-xs">
            {allocations.length > 0
              ? <>Your float is ring-fenced per tenant. Tap a row to start the landlord payout.</>
              : <>No open allocations. Float is credited automatically when CFO disburses a rent request.</>}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex flex-1 min-h-0 justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : allocations.length === 0 ? (
          <div className="flex flex-1 min-h-0 flex-col items-center justify-center py-10 px-6 text-center text-muted-foreground">
            <Inbox className="h-10 w-10 mb-2 opacity-50" />
            <p className="text-sm font-medium text-foreground">No tenants pending payout</p>
            <p className="text-xs mt-1">Once a rent request is fully approved and CFO disburses, it will appear here.</p>
          </div>
        ) : (
          <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
            <div className="shrink-0 px-4 py-3 bg-muted/30 border-b space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Ready to pay</span>
                <span className="font-bold text-foreground">{formatUGX(totalPayable)}</span>
              </div>
              {totalInflight > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-amber-600 dark:text-amber-500">
                    Already sent — waiting for a merchant
                  </span>
                  <span className="text-xs font-semibold text-amber-600 dark:text-amber-500">
                    {formatUGX(totalInflight)}
                  </span>
                </div>
              )}
            </div>
            <div className="shrink-0 px-3 py-2 border-b">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by tenant, landlord or phone…"
                  // Search now also matches the tenant so agents can find a
                  // payout by the tenant it belongs to (landlord names can be
                  // renamed/merged after disbursement).
                  className="pl-9 h-10"
                  autoFocus={false}
                />
              </div>
            </div>
            <ScrollArea className="min-h-0 flex-1 overflow-y-auto">
              <div className="p-3 space-y-2">
                {filtered.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 px-6 text-center text-muted-foreground">
                    <Search className="h-8 w-8 mb-2 opacity-50" />
                    <p className="text-sm font-medium text-foreground">No landlord matches “{search}”</p>
                    <p className="text-xs mt-1">Try a different name or clear the search.</p>
                  </div>
                ) : filtered.map((a) => {
                  const lockExpiry = locks[allocationLockKey(a)] ?? 0;
                  const remainingMs = Math.max(0, lockExpiry - now);
                  const isLocked = remainingMs > 0;
                  const mins = Math.floor(remainingMs / 60000).toString().padStart(2, '0');
                  const secs = Math.floor((remainingMs % 60000) / 1000).toString().padStart(2, '0');
                  // Already submitted and still moving through the merchant
                  // queue — this row is not work to do, it is work to track.
                  const inflight = a.inflight_payout
                    ? describeInflightPayout(a.inflight_payout)
                    : null;
                  return (
                  <button
                    key={a.id}
                    onClick={() => handleSelect(a)}
                    disabled={isLocked}
                    aria-disabled={isLocked}
                    className={`w-full text-left p-3.5 rounded-xl border-2 transition-all touch-manipulation ${
                      isLocked
                        ? 'border-border/60 bg-muted/30 opacity-70 cursor-not-allowed'
                        : inflight
                          ? 'border-amber-500/40 bg-amber-500/5 hover:border-amber-500/60'
                          : 'border-border/80 bg-card hover:border-[#9234EA]/50 hover:bg-[#9234EA]/5 active:scale-[0.99] shadow-sm'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex-1 min-w-0">
                        {a.tenant_name && (
                          <div className="flex items-center gap-1.5 text-sm font-bold text-foreground truncate">
                            <User className="h-3.5 w-3.5 shrink-0 text-[#9234EA]" />
                            {a.tenant_name}
                          </div>
                        )}
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground truncate mt-0.5">
                          <span>{a.landlord_name}</span>
                          {a.landlord_phone && (
                            <>
                              <span>·</span>
                              <span className="font-mono">{maskLandlordPhone(a.landlord_phone)}</span>
                            </>
                          )}
                        </div>
                      </div>
                      {inflight && (
                        <Badge className="text-[10px] uppercase font-semibold shrink-0 bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/15">
                          merchant
                        </Badge>
                      )}
                      {!inflight && a.status === 'partially_paid' && (
                        <Badge variant="secondary" className="text-[9px] shrink-0">Partial</Badge>
                      )}
                      {a.source === 'legacy_backfill' && (
                        <Badge variant="outline" className="text-[9px] shrink-0">Legacy</Badge>
                      )}
                    </div>
                    <div className="flex items-end justify-between gap-2 mt-2 pt-1">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          {inflight ? 'Sent' : 'Remaining'}
                        </div>
                        <div className={`font-bold text-base ${inflight ? 'text-amber-600 dark:text-amber-500' : 'text-[#9234EA]'}`}>
                          {formatUGX(inflight ? a.inflight_payout!.amount : a.remaining_amount)}
                        </div>
                        {!inflight && a.paid_out_amount > 0 && (
                          <div className="text-[10px] text-muted-foreground">
                            Paid: {formatUGX(a.paid_out_amount)} / {formatUGX(a.allocated_amount)}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {isLocked ? (
                          <div className="flex items-center gap-1.5 text-xs font-mono font-medium text-amber-600 dark:text-amber-400 bg-amber-500/10 px-2 py-1 rounded-md border border-amber-500/20">
                            <Lock className="h-3 w-3" />
                            <span>{mins}:{secs}</span>
                            <span className="text-[10px] text-muted-foreground">locked</span>
                          </div>
                        ) : inflight ? (
                          <span className="flex items-center gap-1 text-xs font-semibold text-amber-600 dark:text-amber-500">
                            <Clock3 className="h-3.5 w-3.5" />
                            Track
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs font-semibold text-[#9234EA]">
                            Withdraw
                            <ArrowRight className="h-3.5 w-3.5" />
                          </span>
                        )}
                      </div>
                    </div>
                    {inflight && (
                      <p className="mt-2 text-[11px] leading-snug text-muted-foreground border-t border-amber-500/20 pt-2">
                        {inflight.detail}
                      </p>
                    )}
                  </button>
                  );
                })}
              </div>
            </ScrollArea>
          </div>
        )}

        <div className="shrink-0 border-t p-3">
          <Button variant="outline" className="w-full" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
