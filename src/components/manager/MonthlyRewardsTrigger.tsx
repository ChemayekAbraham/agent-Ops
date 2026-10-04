import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Trophy, Loader2, CheckCircle2, Calendar } from 'lucide-react';
import { format, subMonths } from 'date-fns';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export function MonthlyRewardsTrigger() {
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastProcessed, setLastProcessed] = useState<string | null>(null);

  const handleProcessRewards = async () => {
    setLoading(true);
    setConfirmOpen(false);

    try {
      const { data, error } = await supabase.functions.invoke('process-monthly-rewards', {
        body: {},
      });

      if (error) throw error;

      if (data.success) {
        setLastProcessed(data.processed_at);
        toast.success('Monthly rewards processed successfully!', {
          description: `Processed at ${format(new Date(data.processed_at), 'MMM d, yyyy h:mm a')}`,
        });
      }
    } catch (error) {
      console.error('Error processing rewards:', error);
      toast.error('Failed to process monthly rewards');
    } finally {
      setLoading(false);
    }
  };

  const rewardMonth = format(subMonths(new Date(), 1), 'MMMM yyyy');

  return (
    <>
      <Card className="border-yellow-500/20 bg-gradient-to-br from-yellow-500/5 to-transparent">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Trophy className="h-5 w-5 text-yellow-500" />
              Monthly Referral Rewards
            </CardTitle>
            <Badge variant="outline" className="text-xs">
              <Calendar className="h-3 w-3 mr-1" />
              {rewardMonth}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Process monthly rewards for top referrers. This will credit wallets and send notifications to the top 3 referrers from {rewardMonth}.
          </p>
          
          <div className="flex flex-wrap gap-2 text-xs">
            <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-yellow-500/10 text-yellow-600">
              🥇 1st: UGX 5,000
            </div>
            <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-gray-400/10 text-muted-foreground">
              🥈 2nd: UGX 3,000
            </div>
            <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-amber-600/10 text-amber-600">
              🥉 3rd: UGX 1,000
            </div>
          </div>

          {lastProcessed && (
            <div className="flex items-center gap-2 text-sm text-success bg-success/10 p-2 rounded-lg">
              <CheckCircle2 className="h-4 w-4" />
              Last processed: {format(new Date(lastProcessed), 'MMM d, yyyy h:mm a')}
            </div>
          )}

          <Button 
            onClick={() => setConfirmOpen(true)} 
            disabled={loading}
            className="w-full gap-2"
            variant="default"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Processing...
              </>
            ) : (
              <>
                <Trophy className="h-4 w-4" />
                Process Monthly Rewards
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trophy className="h-5 w-5 text-yellow-500" />
              Process Monthly Rewards?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will process rewards for top referrers from <strong>{rewardMonth}</strong>.
              <br /><br />
              <strong>Rewards will be distributed:</strong>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>1st place: UGX 5,000</li>
                <li>2nd place: UGX 3,000</li>
                <li>3rd place: UGX 1,000</li>
              </ul>
              <br />
              Users who already received rewards for this month will not be processed again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleProcessRewards}>
              Process Rewards
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
