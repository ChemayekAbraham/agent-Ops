/**
 * TransactionDetailDrawer — receipt-style bottom sheet for a single feed row.
 * Slides up with a spring-ish transition (vaul) and staggers its content in.
 */
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Copy, Wallet, X } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatUGX } from "@/lib/rentCalculations";
import {
  txCounterparty,
  txLabel,
  txMethodLabel,
  txServiceLabel,
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
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                <Wallet className="h-7 w-7 text-primary" />
              </div>
              <h2 className="mt-3 text-xl font-bold text-primary">{txLabel(row)}</h2>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {txServiceLabel(row)} / {isIn ? "Credit" : "Debit"}
              </p>
              <p
                className={cn(
                  "mt-3 text-3xl font-extrabold tabular-nums",
                  isIn ? "text-success" : "text-foreground",
                )}
              >
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
              <DetailRow label="Beneficiary / Source" last={!row.description}>
                {txCounterparty(row) ?? "—"}
              </DetailRow>
              {row.description && (
                <DetailRow label="Details" last>
                  <span className="block max-w-[220px] text-xs font-normal text-muted-foreground">
                    {row.description}
                  </span>
                </DetailRow>
              )}
            </div>

            <Button
              className="mt-5 h-14 w-full rounded-2xl text-base font-bold"
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
