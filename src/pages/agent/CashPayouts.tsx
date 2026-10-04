import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Banknote, ReceiptText } from 'lucide-react';
import { AgentCashPayoutsTab } from '@/components/agent/AgentCashPayoutsTab';

export default function AgentCashPayoutsPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      {/* Sticky mobile app bar */}
      <header className="sticky top-0 z-20 bg-background/90 backdrop-blur-md border-b border-border">
        <div className="mx-auto w-full max-w-md px-4 py-3 flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate(-1)}
            aria-label="Go back"
            className="h-11 w-11 shrink-0 rounded-full"
          >
            <ArrowLeft className="h-6 w-6" />
          </Button>
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <Banknote className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-bold leading-tight truncate">Cash, Mobile Money &amp; Bank Payouts</h1>
              <p className="text-sm text-muted-foreground leading-tight">Claim · Pay · Confirm</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/agent/payout-receipts')}
            aria-label="Receipt history"
            className="h-11 w-11 shrink-0 rounded-full"
          >
            <ReceiptText className="h-6 w-6" />
          </Button>
        </div>
      </header>

      {/* Full-screen scrollable content */}
      <main className="flex-1 mx-auto w-full max-w-md px-4 py-4 pb-24">
        <AgentCashPayoutsTab />
      </main>
    </div>
  );
}
