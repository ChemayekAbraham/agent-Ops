import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, CheckCircle2, AlertTriangle, ShieldCheck, Clock, Receipt } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ReceiptNumberCheckDialog } from "@/components/agent/ReceiptNumberCheckDialog";
import { formatUGX } from "@/lib/rentCalculations";
import { cn } from "@/lib/utils";

interface PayoutRow {
  id: string;
  status: "otp_verified" | "disbursing" | "pending_finops_disbursement" | "pending_merchant_payout" | "awaiting_agent_receipt" | "completed" | "failed" | "escalated";
  amount: number;
  attempts: number;
  last_error: string | null;
  external_reference: string | null;
  disbursed_at: string | null;
  escalated_reason: string | null;
  otp_verified_at: string;
  sla_deadline: string;
}

interface Props {
  payoutId: string;
  landlordName: string;
  onDone?: (status: PayoutRow["status"]) => void;
}

export function LandlordPayoutProgress({ payoutId, landlordName, onDone }: Props) {
  const [payout, setPayout] = useState<PayoutRow | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(300);
  const [checkOpen, setCheckOpen] = useState(false);

  // Realtime subscription + initial fetch
  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase
        .from("landlord_payouts")
        .select("id, status, amount, attempts, last_error, external_reference, disbursed_at, escalated_reason, otp_verified_at, sla_deadline")
        .eq("id", payoutId)
        .maybeSingle();
      if (active && data) setPayout(data as PayoutRow);
    })();

    // Also fire onDone for initial terminal states
    // (handled by separate effect below via payout.status)

    const channel = supabase
      .channel(`landlord_payout_${payoutId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "landlord_payouts", filter: `id=eq.${payoutId}` },
        (p) => {
          const next = p.new as PayoutRow;
          setPayout(next);
          if (["completed", "failed", "escalated", "pending_finops_disbursement", "pending_merchant_payout", "awaiting_agent_receipt"].includes(next.status)) {
            onDone?.(next.status);
          }
        },
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [payoutId, onDone]);

  // Countdown
  useEffect(() => {
    if (!payout) return;
    const tick = () => {
      const remaining = Math.max(0, Math.floor((new Date(payout.sla_deadline).getTime() - Date.now()) / 1000));
      setSecondsLeft(remaining);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [payout]);

  // Fire onDone if initial fetch lands in a terminal state
  useEffect(() => {
    if (payout && ["completed", "failed", "escalated", "pending_finops_disbursement", "pending_merchant_payout", "awaiting_agent_receipt"].includes(payout.status)) {
      onDone?.(payout.status);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payout?.status]);

  // Auto-surface the receipt-number dialog once the landlord payout is confirmed paid
  useEffect(() => {
    if (payout?.status === "completed" && !autoPrompted) {
      setAutoPrompted(true);
      setCheckOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payout?.status]);


  if (!payout) {
    return (
      <div className="py-12 text-center">
        <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
        <p className="text-xs text-muted-foreground mt-2">Loading payout status…</p>
      </div>
    );
  }

  const mins = Math.floor(secondsLeft / 60).toString().padStart(2, "0");
  const secs = (secondsLeft % 60).toString().padStart(2, "0");
  const slaProgress = Math.min(100, ((300 - secondsLeft) / 300) * 100);

  const isDone = payout.status === "completed";
  const isPendingFinops =
    payout.status === "pending_finops_disbursement" ||
    payout.status === "pending_merchant_payout" ||
    payout.status === "awaiting_agent_receipt";
  const isEscalated = payout.status === "escalated" || payout.status === "failed";
  const inFlight = payout.status === "otp_verified" || payout.status === "disbursing";

  return (
    <div className="py-6 space-y-5">
      {/* SLA countdown */}
      {inFlight && (
        <div className="rounded-2xl border-2 border-primary/30 bg-primary/5 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" /> SLA Countdown
            </span>
            <span className={cn(
              "font-mono text-lg font-bold",
              secondsLeft < 60 ? "text-destructive" : "text-primary",
            )}>
              {mins}:{secs}
            </span>
          </div>
          <Progress value={slaProgress} className="h-1.5" />
          <p className="text-[11px] text-muted-foreground">
            Auto-disbursement must complete within 5 minutes of OTP verification.
          </p>
        </div>
      )}

      {/* Status block */}
      <div className="text-center space-y-3">
        {isDone || isPendingFinops ? (
          <CheckCircle2 className="h-16 w-16 mx-auto text-emerald-500" />
        ) : isEscalated ? (
          <AlertTriangle className="h-16 w-16 mx-auto text-destructive" />
        ) : (
          <div className="relative w-16 h-16 mx-auto">
            <div className="absolute inset-0 rounded-full border-4 border-primary/20" />
            <div className="absolute inset-0 rounded-full border-4 border-primary border-t-transparent animate-spin" />
            <ShieldCheck className="absolute inset-0 m-auto h-7 w-7 text-primary" />
          </div>
        )}

        <div>
          <h3 className="text-xl font-bold">
            {isDone
              ? "Payment Sent ✓"
              : isPendingFinops
                ? (payout.status === "pending_merchant_payout"
                    ? "Sent to Merchant Payout Queue ✓"
                    : "Payment in Progress ✓")
                : isEscalated
                  ? "Escalated to Financial Ops"
                  : payout.status === "otp_verified"
                    ? "OTP Verified — Starting Disbursement"
                    : `Disbursing (attempt ${payout.attempts}/3)…`}
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            {formatUGX(payout.amount)} → <span className="font-medium text-foreground">{landlordName}</span>
          </p>
          {isPendingFinops && (
            <p className="text-xs text-muted-foreground mt-2 max-w-xs mx-auto">
              {payout.status === "pending_merchant_payout"
                ? "Float deducted. A merchant agent will pay the landlord from the Cash, Mobile Money & Bank payout queue — you'll be notified."
                : "Float deducted. The money will be released to the landlord shortly — you'll be notified."}
            </p>
          )}
        </div>

        {payout.external_reference && (
          <Badge variant="outline" className="font-mono text-[10px]">
            Ref: {payout.external_reference}
          </Badge>
        )}

        {payout.last_error && inFlight && (
          <p className="text-xs text-muted-foreground italic">
            Retrying — last error: {payout.last_error}
          </p>
        )}

        {isEscalated && (
          <div className="rounded-xl bg-destructive/10 border border-destructive/30 p-3 text-left">
            <p className="text-xs font-semibold text-destructive mb-1">
              Auto-disbursement failed after 3 retries
            </p>
            <p className="text-xs text-muted-foreground">
              {payout.escalated_reason ?? payout.last_error ?? "Unknown error"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Your float has been refunded. Financial Ops has been notified.
            </p>
          </div>
        )}

        <div className="pt-1">
          <Button variant="outline" size="sm" onClick={() => setCheckOpen(true)}>
            <Receipt className="h-3.5 w-3.5 mr-1.5" />
            Check a receipt number
          </Button>
        </div>
      </div>

      <ReceiptNumberCheckDialog open={checkOpen} onOpenChange={setCheckOpen} />
    </div>
  );
}

