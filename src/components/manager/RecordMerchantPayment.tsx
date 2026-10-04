import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Receipt } from 'lucide-react';

interface RecordMerchantPaymentProps {
  onBack?: () => void;
}

export function RecordMerchantPayment({ onBack }: RecordMerchantPaymentProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Receipt className="h-5 w-5" />
          Record Merchant Payment
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-center py-8 text-muted-foreground">
          Merchant payment recording feature is currently disabled.
        </div>
      </CardContent>
    </Card>
  );
}
