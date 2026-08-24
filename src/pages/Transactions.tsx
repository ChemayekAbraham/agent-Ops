/**
 * /transactions — full customer transaction history.
 * 15 rows per fetch, keyset "Load more" (one query per page, no N+1).
 */
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import TransactionsFeed from "@/components/transactions/TransactionsFeed";

export default function Transactions() {
  const navigate = useNavigate();
  const { user } = useAuth();

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
            aria-label="Download statement"
            className="h-8 w-8 sm:h-9 sm:w-9 shrink-0 rounded-full"
            onClick={() => navigate("/financial-statement")}
          >
            <Download className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <main className="px-4 py-5 pb-24">
        <TransactionsFeed userId={user?.id} />
      </main>
    </div>
  );
}
