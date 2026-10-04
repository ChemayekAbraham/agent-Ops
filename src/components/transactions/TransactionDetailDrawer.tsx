/**
 * TransactionDetailDrawer — receipt-style bottom sheet for a single feed row.
 * Slides up with a spring-ish transition (vaul) and staggers its content in.
 */
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, Copy, Download, FileSpreadsheet, Undo2, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { welileItemImage } from "@/lib/welileItemImages";
import { useState } from "react";
import { useProfile } from "@/hooks/useProfile";
import {
  downloadTransferReceiptPdf,
  downloadTransferReceiptXlsx,
  type TransferReceiptData,
} from "@/lib/transferReceiptExport";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatUGX } from "@/lib/rentCalculations";
import { UserAvatar } from "@/components/UserAvatar";
import {
  txCounterparty,
  txIcon,
  txLabel,
  txMethodLabel,
  txServiceLabel,
  txTone,
  type TxFeedRow,
} from "@/lib/transactionsFeed";

interface Props {
  row: TxFeedRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function DetailRow({
  label,
  children,
  last,
}: {
  label: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 py-3",
        !last && "border-b border-border/60",
      )}
    >
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <div className="text-right text-sm font-semibold text-foreground">{children}</div>
    </div>
  );
}

export function TransactionDetailDrawer({ row, open, onOpenChange }: Props) {
  const isIn = row?.direction === "cash_in";
  const tone = row ? txTone(row) : null;
  const Icon = row ? txIcon(row) : null;
  // Person-to-person transfer: the person on the other side (photo + name).
  const peer =
    row && row.category === "wallet_transfer" && row.peer_name
      ? { name: row.peer_name, avatar: row.peer_avatar_url ?? null }
      : null;

  // Real market photo of the item this transfer paid for.
  const itemPhoto = welileItemImage(row?.description);

  const { profile } = useProfile();
  const [busy, setBusy] = useState<"pdf" | "xlsx" | null>(null);
  const [confirmReverse, setConfirmReverse] = useState(false);
  const [reversing, setReversing] = useState(false);
  const queryClient = useQueryClient();

  // Sender-side reversal of a person-to-person transfer (allowed until the
  // recipient withdraws). The server decides eligibility and amount.
  const reversalRef =
    row && row.category === "wallet_transfer" && row.direction === "cash_out" &&
    row.reference_id && !row.reference_id.endsWith("-REV")
      ? row.reference_id
      : null;
  const reversalStatus = useQuery({
    queryKey: ["wallet-transfer-reversal-status", reversalRef],
    enabled: open && !!reversalRef,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("wallet_transfer_reversal_status", {
        p_reference: reversalRef as string,
      });
      if (error) throw error;
      return data as { can_reverse: boolean; reason?: string; sent?: number; reversible?: number };
    },
  });

  const handleReverse = async () => {
    if (!reversalRef) return;
    setReversing(true);
    try {
      const { data, error } = await supabase.rpc("reverse_wallet_transfer", { p_reference: reversalRef });
      if (error) throw error;
      const res = data as { amount: number; sent: number };
      toast.success(
        res.amount < res.sent
          ? `${formatUGX(res.amount)} of ${formatUGX(res.sent)} returned to your wallet`
          : `${formatUGX(res.amount)} returned to your wallet`,
      );
      setConfirmReverse(false);
      queryClient.invalidateQueries();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message || "Could not reverse this transfer.");
      reversalStatus.refetch();
    } finally {
      setReversing(false);
    }
  };

  const me = profile?.full_name?.trim() || "Me";
  const other = peer?.name ?? (row ? txCounterparty(row) : null) ?? "—";

  const handleDownload = async (kind: "pdf" | "xlsx") => {
    if (!row) return;
    const data: TransferReceiptData = {
      item: row.description?.trim() || txLabel(row),
      amount: Number(row.amount),
      date: new Date(row.transaction_date),
      sender: isIn ? other : me,
      receiver: isIn ? me : other,
      reference: row.reference_id ?? row.id,
      method: txMethodLabel(row),
    };
    setBusy(kind);
    try {
      if (kind === "pdf") await downloadTransferReceiptPdf(data);
      else await downloadTransferReceiptXlsx(data);
      toast.success("Receipt downloaded");
    } catch {
      toast.error("Could not prepare the receipt. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[92vh] rounded-t-3xl px-5 pb-8 pt-2 data-[state=open]:duration-500">
        <div className="mx-auto mb-2 h-1.5 w-12 shrink-0 rounded-full bg-muted" />
        {row && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 overflow-y-auto">
            <div className="relative flex flex-col items-center pt-2 text-center">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="Dismiss receipt"
                className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center rounded-full bg-muted text-muted-foreground transition-transform active:scale-90"
              >
                <X className="h-4 w-4" />
              </button>
              {peer ? (
                <UserAvatar
                  avatarUrl={peer.avatar}
                  fullName={peer.name}
                  size="lg"
                  className="h-16 w-16"
                />
              ) : (
                <div
                  className={cn(
                    "flex h-16 w-16 items-center justify-center rounded-full",
                    tone?.bubble,
                  )}
                >
                  {Icon && <Icon className={cn("h-7 w-7", tone?.icon)} />}
                </div>
              )}
              {peer && (
                <div className="mt-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    {isIn ? "Received from" : "Sent to"}
                  </p>
                  <p className="text-base font-extrabold leading-tight text-foreground">{peer.name}</p>
                </div>
              )}
              {itemPhoto && (
                <div className="relative mt-3 w-full overflow-hidden rounded-2xl">
                  <img
                    src={itemPhoto}
                    alt={row.description?.trim() || txLabel(row)}
                    loading="lazy"
                    width={512}
                    height={512}
                    className="h-36 w-full object-cover"
                  />
                  <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent p-2.5">
                    <UserAvatar
                      avatarUrl={isIn ? peer?.avatar ?? null : profile?.avatar_url ?? null}
                      fullName={isIn ? peer?.name ?? other : me}
                      size="sm"
                      className="h-8 w-8 border-2 border-white/80"
                    />
                    <span className="text-[11px] font-bold text-white">
                      {isIn ? peer?.name ?? other : me}
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-white/80" />
                    <UserAvatar
                      avatarUrl={isIn ? profile?.avatar_url ?? null : peer?.avatar ?? null}
                      fullName={isIn ? me : peer?.name ?? other}
                      size="sm"
                      className="h-8 w-8 border-2 border-white/80"
                    />
                    <span className="truncate text-[11px] font-bold text-white">
                      {isIn ? me : peer?.name ?? other}
                    </span>
                  </div>
                </div>
              )}
              <h2 className="mt-3 text-xl font-bold text-foreground">{txLabel(row)}</h2>
              <div className="mt-1 flex items-center gap-1.5">
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px] font-bold uppercase tracking-wider",
                    isIn
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
                      : "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/30",
                  )}
                >
                  {isIn ? "Money In · Credit" : "Money Out · Debit"}
                </Badge>
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {txServiceLabel(row)}
                </span>
              </div>
              <p
                className={cn("mt-3 text-3xl font-extrabold tabular-nums", tone?.amount)}
              >
                {isIn ? "+" : "−"}
                {formatUGX(Number(row.amount))}
              </p>

            </div>

            <div className="mt-5 rounded-2xl bg-muted/50 px-4 py-1">
              <DetailRow label="Status">
                <Badge className="badge-success border">COMPLETED</Badge>
              </DetailRow>
              <DetailRow label="Transaction Date">
                {format(new Date(row.transaction_date), "dd MMM yyyy, HH:mm")}
              </DetailRow>
              <DetailRow label="Type">
                <Badge variant="secondary" className={cn("font-semibold", isIn ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive")}>
                  {isIn ? "Money In" : "Money Out"}
                </Badge>
              </DetailRow>
              <DetailRow label="Reference ID">
                <span className="inline-flex items-center gap-2">
                  <span className="max-w-[190px] truncate font-mono text-xs">
                    {row.reference_id ?? row.id}
                  </span>
                  <button
                    type="button"
                    aria-label="Copy reference"
                    onClick={() => {
                      navigator.clipboard.writeText(row.reference_id ?? row.id);
                      toast.success("Reference copied");
                    }}
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-background transition-transform active:scale-90"
                  >
                    <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </span>
              </DetailRow>
              <DetailRow label="Payment Channel">
                <Badge variant="secondary" className="font-semibold">
                  {txMethodLabel(row)}
                </Badge>
              </DetailRow>
              {row.balanceAfter != null && (
                <DetailRow label="Balance After">
                  <span className={cn("font-bold tabular-nums", isIn ? "text-success" : "text-foreground")}>
                    {formatUGX(Number(row.balanceAfter))}
                  </span>
                </DetailRow>
              )}
              <DetailRow label={peer ? (isIn ? "Sender" : "Recipient") : "Beneficiary / Source"} last={!row.description}>
                {peer?.name ?? txCounterparty(row) ?? "—"}
              </DetailRow>
              {row.description && (
                <DetailRow label="Details" last>
                  <span className="block max-w-[220px] text-xs font-normal text-muted-foreground">
                    {row.description}
                  </span>
                </DetailRow>
              )}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="h-12 rounded-2xl text-sm font-bold"
                disabled={busy !== null}
                onClick={() => handleDownload("pdf")}
              >
                <Download className="mr-1.5 h-4 w-4" />
                {busy === "pdf" ? "Preparing…" : "PDF receipt"}
              </Button>
              <Button
                variant="outline"
                className="h-12 rounded-2xl text-sm font-bold"
                disabled={busy !== null}
                onClick={() => handleDownload("xlsx")}
              >
                <FileSpreadsheet className="mr-1.5 h-4 w-4" />
                {busy === "xlsx" ? "Preparing…" : "Excel receipt"}
              </Button>
            </div>

            {reversalRef && reversalStatus.data && (
              reversalStatus.data.can_reverse ? (
                confirmReverse ? (
                  <div className="mt-3 rounded-2xl border border-destructive/40 bg-destructive/5 p-3">
                    <p className="text-sm font-medium text-foreground">
                      {Number(reversalStatus.data.reversible) < Number(reversalStatus.data.sent)
                        ? `Only ${formatUGX(Number(reversalStatus.data.reversible))} of ${formatUGX(Number(reversalStatus.data.sent))} is still in their wallet. That amount will come back to you.`
                        : `${formatUGX(Number(reversalStatus.data.reversible))} will come back to your wallet.`}
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button variant="outline" className="h-11 rounded-xl" disabled={reversing} onClick={() => setConfirmReverse(false)}>
                        Keep transfer
                      </Button>
                      <Button variant="destructive" className="h-11 rounded-xl" disabled={reversing} onClick={handleReverse}>
                        {reversing ? "Reversing…" : "Yes, reverse"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="mt-3 h-12 w-full rounded-2xl text-sm font-bold text-destructive"
                    onClick={() => setConfirmReverse(true)}
                  >
                    <Undo2 className="mr-1.5 h-4 w-4" />
                    Reverse transfer
                  </Button>
                )
              ) : (
                <p className="mt-3 text-center text-xs text-muted-foreground">{reversalStatus.data.reason}</p>
              )
            )}

            <Button
              className="mt-2 h-14 w-full rounded-2xl text-base font-bold"
              onClick={() => onOpenChange(false)}
            >
              Dismiss Receipt
            </Button>
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}

export default TransactionDetailDrawer;
