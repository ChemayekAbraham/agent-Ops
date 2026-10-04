/**
 * /transactions — full customer transaction history.
 * 15 rows per fetch, keyset "Load more" (one query per page, no N+1).
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import TransactionsFeed from "@/components/transactions/TransactionsFeed";
import { fetchTxFeedPage, txLabel, txMethodLabel } from "@/lib/transactionsFeed";

export default function Transactions() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (!user?.id) {
      toast.error("Please sign in first");
      return;
    }
    setDownloading(true);
    try {
      // Pull up to 20 keyset pages (≈300 rows) for the statement.
      const filters = { date: "all", service: "all", method: "all" } as const;
      const rows: Awaited<ReturnType<typeof fetchTxFeedPage>>["rows"] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i += 1) {
        const page = await fetchTxFeedPage(user.id, filters, cursor);
        rows.push(...page.rows);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("full_name, phone")
        .eq("id", user.id)
        .maybeSingle();

      const { generateTransactionStatementPdf } = await import("@/lib/transactionStatementPdf");
      const blob = await generateTransactionStatementPdf({
        ownerName: profile?.full_name || user.email || "Welile customer",
        ownerPhone: profile?.phone ?? null,
        periodLabel: `All recorded activity · ${rows.length} transaction${rows.length === 1 ? "" : "s"}`,
        rows: rows.map((r) => ({
          date: r.transaction_date,
          category: txLabel(r),
          method: txMethodLabel(r),
          amount: Number(r.amount),
          direction: r.direction as "cash_in" | "cash_out",
        })),
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `welile-transaction-statement-${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Statement downloaded");
    } catch (e: any) {
      toast.error(e?.message || "Failed to generate statement");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="sticky top-0 z-30 bg-background">
        <div className="flex items-center gap-2 sm:gap-3 px-4 py-3 sm:py-4">
          <button
            type="button"
            onClick={() => navigate(-1)}
            aria-label="Go back"
            className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full transition-transform active:scale-90"
          >
            <ArrowLeft className="h-5 w-5 sm:h-6 sm:w-6" />
          </button>
          <h1 className="flex-1 text-lg font-bold sm:text-xl md:text-2xl tracking-tight">Transaction History</h1>
          <Button
            size="icon"
            aria-label="Download statement PDF"
            className="h-8 w-8 sm:h-9 sm:w-9 shrink-0 rounded-full"
            disabled={downloading}
            onClick={handleDownload}
          >
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          </Button>
        </div>
      </header>

      <main className="px-4 py-5 pb-24">
        <TransactionsFeed userId={user?.id} />
      </main>
    </div>
  );
}
