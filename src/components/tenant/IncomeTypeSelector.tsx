import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Calculator, Calendar, Wallet } from 'lucide-react';

export type IncomeType = 'daily' | 'weekly-monthly';

interface IncomeTypeSelectorProps {
  onSelect: (type: IncomeType) => void;
}

export default function IncomeTypeSelector({ onSelect }: IncomeTypeSelectorProps) {
  return (
    <Card className="glass-card glow-primary">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calculator className="h-5 w-5 text-primary" />
          Choose Your Income Type
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Select your income type to see the best repayment plan for you.
        </p>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Button
            variant="outline"
            className="h-auto p-6 flex flex-col items-center gap-3 hover:border-primary hover:bg-primary/5 transition-all"
            onClick={() => onSelect('daily')}
          >
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Wallet className="h-6 w-6 text-primary" />
            </div>
            <div className="text-center">
              <p className="font-semibold">I'm a Daily Income Earner</p>
              <p className="text-xs text-muted-foreground mt-1">
                Pay back in daily installments over 30, 60, or 90 days
              </p>
            </div>
          </Button>
          
          <Button
            variant="outline"
            className="h-auto p-6 flex flex-col items-center gap-3 hover:border-primary hover:bg-primary/5 transition-all"
            onClick={() => onSelect('weekly-monthly')}
          >
            <div className="h-12 w-12 rounded-full bg-success/10 flex items-center justify-center">
              <Calendar className="h-6 w-6 text-success" />
            </div>
            <div className="text-center">
              <p className="font-semibold">I'm a Weekly or Monthly Earner</p>
              <p className="text-xs text-muted-foreground mt-1">
                Pay back weekly, after 2-3 weeks, or after 4 months
              </p>
            </div>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
