import { Card, CardContent } from '@/components/ui/card';
import { HandCoins } from 'lucide-react';

export function PendingInvestmentRequestsWidget() {
  return (
    <Card className="border-dashed">
      <CardContent className="py-4 text-center text-sm text-muted-foreground">
        <HandCoins className="h-6 w-6 mx-auto mb-2 opacity-50" />
        Investment requests feature is disabled
      </CardContent>
    </Card>
  );
}
