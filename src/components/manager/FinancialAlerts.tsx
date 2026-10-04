import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Bell, BellRing } from 'lucide-react';

export function FinancialAlerts() {
  return (
    <Card className="glass-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <BellRing className="h-5 w-5" />
          Financial Alerts
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-center py-8 text-muted-foreground">
          <Bell className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">Financial alerts feature is currently disabled</p>
          <p className="text-xs mt-1">This feature will be available in a future update</p>
        </div>
      </CardContent>
    </Card>
  );
}
