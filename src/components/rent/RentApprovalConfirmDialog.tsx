import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, CheckCircle2, AlertTriangle, Calculator } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: {
    id: string;
    rent_amount: number;
    duration_days: number;
    access_fee: number;
    request_fee: number;
    total_repayment: number;
    daily_repayment: number;
    tenant_name?: string | null;
  } | null;
  onConfirm: () => Promise<void> | void;
  loading?: boolean;
}

interface Canonical {
  access_fee: number;
  request_fee: number;
  total_repayment: number;
  daily_repayment: number;
}

/**
 * Shows the canonical fee breakdown (computed server-side via
 * `compute_rent_repayment`) before the manager confirms approval.
 * Highlights any drift between the stored values and the canonical formula.
 */
export function RentApprovalConfirmDialog({
  open,
  onOpenChange,
  request,
  onConfirm,
  loading,
}: Props) {
  const [canon, setCanon] = useState<Canonical | null>(null);
  const [computing, setComputing] = useState(false);

  useEffect(() => {
    if (!open || !request) {
      setCanon(null);
      return;
    }
    let cancelled = false;
    setComputing(true);
    supabase
      .rpc('compute_rent_repayment', {
        p_rent_amount: request.rent_amount,
        p_duration_days: request.duration_days,
      })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (!error && Array.isArray(data) && data.length > 0) {
          const r = data[0] as Record<string, unknown>;
          setCanon({
            access_fee: Number(r.access_fee) || 0,
            request_fee: Number(r.request_fee) || 0,
            total_repayment: Number(r.total_repayment) || 0,
            daily_repayment: Number(r.daily_repayment) || 0,
          });
        }
        setComputing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, request]);

  if (!request) return null;

  const display = canon ?? {
    access_fee: request.access_fee,
    request_fee: request.request_fee,
    total_repayment: request.total_repayment,
    daily_repayment: request.daily_repayment,
  };

  const drift =
    canon &&
    (Math.abs(canon.total_repayment - request.total_repayment) > 1 ||
      Math.abs(canon.daily_repayment - request.daily_repayment) > 1 ||
      Math.abs(canon.access_fee - request.access_fee) > 1 ||
      Math.abs(canon.request_fee - request.request_fee) > 1);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calculator className="h-5 w-5 text-primary" />
            Confirm Rent Plan Approval
          </DialogTitle>
          <DialogDescription>
            Review the canonical breakdown before approving
            {request.tenant_name ? ` ${request.tenant_name}'s` : ''} request.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Hero — total + daily */}
          <div className="rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20 p-4 text-center">
            <p className="text-xs text-muted-foreground">Total Repayment</p>
            <p className="text-3xl font-bold text-primary font-mono mt-1">
              {formatUGX(display.total_repayment)}
            </p>
            <p className="text-[11px] text-muted-foreground mt-2">
              {formatUGX(display.daily_repayment)} / day &middot; {request.duration_days} days
            </p>
          </div>

          {/* Breakdown */}
          <div className="rounded-xl border bg-muted/30 divide-y">
            {(() => {
              const total = display.total_repayment || 0;
              const principal = request.rent_amount || 0;
              const partner = Math.round(principal * 0.15);
              const agent = Math.round(total * 0.1);
              const platform = Math.max(0, total - principal - partner - agent);
              const pct = (v: number) =>
                total > 0 ? `${((v / total) * 100).toFixed(2)}%` : '0.00%';
              return (
                <>
                  <Row label={`Principal — ${pct(principal)}`} value={formatUGX(principal)} />
                  <Row label={`Supporter Returns — ${pct(partner)}`} value={formatUGX(partner)} />
                  <Row label={`Agent Commission — ${pct(agent)}`} value={formatUGX(agent)} />
                  <Row label={`Platform Fee — ${pct(platform)}`} value={formatUGX(platform)} />
                </>
              );
            })()}
            <Row
              label="Total Repayment — 100.00%"
              value={formatUGX(display.total_repayment)}
              bold
            />
            <Row
              label="Daily Payment"
              value={formatUGX(display.daily_repayment)}
              bold
            />
          </div>

          {/* Drift / status badges */}
          {computing ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Verifying against canonical formula…
            </div>
          ) : canon && !drift ? (
            <Badge
              variant="outline"
              className="gap-1 border-emerald-500/40 text-emerald-600 bg-emerald-500/10"
            >
              <CheckCircle2 className="h-3 w-3" />
              Matches canonical formula
            </Badge>
          ) : drift ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" />
                Stored values diverge from canonical formula
              </div>
              <p className="text-muted-foreground">
                Stored total: {formatUGX(request.total_repayment)} &middot; Canonical:{' '}
                {formatUGX(display.total_repayment)}. The DB trigger will correct
                this on save.
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={loading || computing}>
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Approving…
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Confirm Approval
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${bold ? 'font-bold text-foreground' : ''}`}>
        {value}
      </span>
    </div>
  );
}