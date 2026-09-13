/**
 * TransactionDetailDrawer — receipt-style bottom sheet for a single feed row.
 * Slides up with a spring-ish transition (vaul) and staggers its content in.
 */
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Copy, Download, FileSpreadsheet, X } from "lucide-react";
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

  const { profile } = useProfile();
  const [busy, setBusy] = useState<"pdf" | "xlsx" | null>(null);

  const me = profile?.full_name?.trim() || "Me";
  const other = peer?.name ?? txCounterparty(row!) ?? "—";

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
