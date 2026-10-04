import { Card, CardContent } from '@/components/ui/card';
import { Banknote } from 'lucide-react';

export function WelileHomesWithdrawalsManager() {
  return (
    <Card className="p-6">
      <CardContent className="text-center py-6">
        <Banknote className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
        <p className="text-muted-foreground text-sm">Welile Homes withdrawals feature is currently disabled</p>
        <p className="text-xs text-muted-foreground mt-1">This feature will be available in a future update</p>
      </CardContent>
    </Card>
  );
}
