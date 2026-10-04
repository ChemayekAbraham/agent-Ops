import { Card, CardContent } from '@/components/ui/card';
import { PiggyBank } from 'lucide-react';

interface UserInvestmentsSectionProps {
  userId: string;
  userName?: string;
  userPhone?: string;
}

export default function UserInvestmentsSection({ userId, userName, userPhone }: UserInvestmentsSectionProps) {
  return (
    <div className="space-y-4">
      <Card className="p-6">
        <CardContent className="text-center py-6">
          <PiggyBank className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
          <p className="text-muted-foreground text-sm">Investment accounts feature is currently disabled</p>
          <p className="text-xs text-muted-foreground mt-1">This feature will be available in a future update</p>
        </CardContent>
      </Card>
    </div>
  );
}
