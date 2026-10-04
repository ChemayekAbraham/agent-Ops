import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Phone, Ban, X, Users, TrendingDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { hapticTap } from '@/lib/haptics';
import { useAgentDeadTenants, type DeadTenant } from '@/hooks/useAgentDeadTenants';
import { RentPaymentStatusSheet } from './RentPaymentStatusSheet';

const DISMISS_DAYS = 2;
const PAGE_SIZE = 10;

function dismissKey(agentId: string) {
  return `agent-dead-tenants-dismissed:${agentId}`;
}

function isDismissed(agentId: string): boolean {
  try {
    const raw = localStorage.getItem(dismissKey(agentId));
    if (!raw) return false;
    const until = Number(raw);
    if (!Number.isFinite(until)) return false;
    return Date.now() < until;
  } catch {
    return false;
  }
}

function setDismissed(agentId: string) {
  try {
    localStorage.setItem(
      dismissKey(agentId),
      String(Date.now() + DISMISS_DAYS * 24 * 60 * 60 * 1000),
    );
  } catch {
    /* ignore */
  }
}

interface Props {
  agentId: string;
}

/**
 * Overlay banner on the agent Tenants tab warning about "dead"/inactive tenants
 * (funded, owing, and badly overdue). These drag down agent performance.
 * - Shows the top 3 by amount owed (amount in red).
 * - "View all" opens an infinite-scroll list (10/scroll) with Call + Deactivate.
 * - "Ignore" dismisses the banner for 2 days.
 * Deactivating notifies Tenant Ops and requires a reason (handled by the shared
 * RentPaymentStatusSheet → notify-tenant-inactive).
 */
export function AgentDeadTenantsBanner({ agentId }: Props) {
  const { data: deadTenants = [] } = useAgentDeadTenants(agentId);
  const [dismissed, setDismissedState] = useState(() => isDismissed(agentId));
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => {
    setDismissedState(isDismissed(agentId));
  }, [agentId]);

  if (dismissed || deadTenants.length === 0) return null;

  const top3 = deadTenants.slice(0, 3);
  const count = deadTenants.length;

  const handleIgnore = () => {
    hapticTap();
    setDismissed(agentId);
    setDismissedState(true);
  };

  return (
    <>
      <div className="relative rounded-2xl border-2 border-destructive/40 bg-destructive/5 p-4 overflow-hidden animate-fade-in">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-xl bg-destructive/15 shrink-0">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-destructive flex items-center flex-wrap gap-2">
              {count} inactive tenant{count > 1 ? 's' : ''}
              <Badge variant="destructive" className="h-5 gap-1">
                <TrendingDown className="h-3 w-3" /> Hurts performance
              </Badge>
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              These tenants are funded but haven't been paying. Inactive tenants pull
              down your 7-day performance grade until you clean up your book.
            </p>
          </div>
        </div>

        <ul className="mt-3 space-y-1.5">
          {top3.map((t) => (
            <li
              key={t.rent_request_id}
              className="flex items-center justify-between gap-3 rounded-lg bg-card/60 border border-destructive/15 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{t.tenant_name}</p>
                <p className="text-[11px] text-muted-foreground">{t.days_overdue}d overdue</p>
              </div>
              <p className="text-sm font-bold text-destructive shrink-0">{formatUGX(t.outstanding)}</p>
            </li>
          ))}
        </ul>

        <div className="mt-3 flex items-center gap-2">
          <Button
            className="flex-1 h-10 gap-1.5"
            onClick={() => { hapticTap(); setListOpen(true); }}
          >
            <Users className="h-4 w-4" /> View all{count > 3 ? ` (${count})` : ''}
          </Button>
          <Button variant="outline" className="h-10 gap-1.5" onClick={handleIgnore}>
            <X className="h-4 w-4" /> Ignore
          </Button>
        </div>
      </div>

      <DeadTenantsListSheet
        open={listOpen}
        onOpenChange={setListOpen}
        agentId={agentId}
        tenants={deadTenants}
      />
    </>
  );
}

function DeadTenantsListSheet({
  open,
  onOpenChange,
  agentId,
  tenants,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  agentId: string;
  tenants: DeadTenant[];
}) {
  const qc = useQueryClient();
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [deactivateTarget, setDeactivateTarget] = useState<DeadTenant | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) setVisible(PAGE_SIZE);
  }, [open]);

  const shown = useMemo(() => tenants.slice(0, visible), [tenants, visible]);
  const hasMore = visible < tenants.length;

  const loadMore = useCallback(() => {
    setVisible((v) => Math.min(v + PAGE_SIZE, tenants.length));
  }, [tenants.length]);

  useEffect(() => {
    if (!open || !hasMore) return;
    const node = sentinelRef.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: '120px' },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [open, hasMore, loadMore, shown.length]);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="h-[85vh] rounded-t-2xl p-0 flex flex-col">
          <SheetHeader className="p-4 pb-2 border-b border-border/40 text-left">
            <SheetTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Inactive tenants
            </SheetTitle>
            <SheetDescription>
              {tenants.length} funded tenant{tenants.length > 1 ? 's' : ''} not paying. Call them,
              or deactivate (this notifies Tenant Ops and removes them from your daily target).
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {shown.map((t) => (
              <div
                key={t.rent_request_id}
                className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 space-y-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm truncate">{t.tenant_name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {t.days_overdue}d overdue · Daily {formatUGX(t.daily_repayment)}
                    </p>
                  </div>
                  <p className="font-bold text-sm text-destructive shrink-0">{formatUGX(t.outstanding)}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  {t.tenant_phone && (
                    <a href={`tel:${t.tenant_phone}`} className="flex-1">
                      <Button size="sm" variant="outline" className="w-full h-9 text-xs gap-1">
                        <Phone className="h-3 w-3" /> Call
                      </Button>
                    </a>
                  )}
                  <Button
                    size="sm"
                    variant="destructive"
                    className={cn('h-9 text-xs gap-1', t.tenant_phone ? 'flex-1' : 'w-full')}
                    onClick={() => { hapticTap(); setDeactivateTarget(t); }}
                  >
                    <Ban className="h-3 w-3" /> Deactivate
                  </Button>
                </div>
              </div>
            ))}

            {tenants.length === 0 && (
              <div className="text-center py-12 text-success font-semibold">
                🎉 No inactive tenants — your book is clean!
              </div>
            )}

            {hasMore && <div ref={sentinelRef} className="h-8" />}
          </div>
        </SheetContent>
      </Sheet>

      <RentPaymentStatusSheet
        open={!!deactivateTarget}
        onOpenChange={(v) => {
          if (!v) setDeactivateTarget(null);
        }}
        rentRequestId={deactivateTarget?.rent_request_id ?? null}
        tenantName={deactivateTarget?.tenant_name}
        currentStatus="paying"
        agentId={agentId}
      />
    </>
  );
}

export default AgentDeadTenantsBanner;