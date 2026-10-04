import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HandCoins } from 'lucide-react';

export function ManagerInvestmentRequestsSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HandCoins className="h-5 w-5" />
          Investment Requests
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-center py-8 text-muted-foreground">
          Investment requests feature is currently disabled.
        </div>
      </CardContent>
    </Card>
  );
}
