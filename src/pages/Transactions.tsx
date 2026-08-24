/**
 * /transactions — full customer transaction history.
 * 15 rows per fetch, keyset "Load more" (one query per page, no N+1).
 */
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import TransactionsFeed from "@/components/transactions/TransactionsFeed";

export default function Transactions() {
  const navigate = useNavigate();
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="sticky top-0 z-30 bg-background">
        <div className="flex items-center gap-3 px-4 py-4">
          <button
            type="button"
            onClick={() => navigate(-1)}
            aria-label="Go back"
            className="flex h-9 w-9 items-center justify-center rounded-full transition-transform active:scale-90"
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="flex-1 text-2xl font-bold tracking-tight">Transaction History</h1>
        </div>
      </header>

      <main className="px-4 py-5 pb-24">
        <TransactionsFeed userId={user?.id} />
      </main>
    </div>
  );
}
