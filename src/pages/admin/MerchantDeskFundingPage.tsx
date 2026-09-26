import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MerchantDeskFundingTracker } from '@/components/financial-ops/MerchantDeskFundingTracker';

export default function MerchantDeskFundingPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background w-full overflow-x-hidden">
      {/* Sticky top navigation bar */}
      <div className="sticky top-0 z-40 bg-background/95 backdrop-blur border-b border-border shadow-xs">
        <div className="w-full px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/admin/financial-ops')}
            className="gap-2 text-xs sm:text-sm font-medium -ml-2 text-muted-foreground hover:text-foreground"
            aria-label="Back to Financial Ops"
          >
            <ArrowLeft className="h-4 w-4 shrink-0" />
            <span>Financial Ops</span>
          </Button>
        </div>
      </div>

      {/* Full width content area without center-column max-width */}
      <div className="w-full px-4 sm:px-6 py-4 sm:py-6">
        <MerchantDeskFundingTracker />
      </div>
    </div>
  );
}
