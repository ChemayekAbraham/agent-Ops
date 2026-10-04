import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { TrendingUp, Loader2, CheckCircle2, Calendar, Users, PauseCircle } from 'lucide-react';
import { useFeatureFlags } from '@/contexts/FeatureFlagsContext';
import { format } from 'date-fns';
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

interface ProcessingResults {
  processed: number;
  credited: number;
  totalAmount: number;
  errors: string[];
}

export function SupporterROITrigger() {
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastResults, setLastResults] = useState<ProcessingResults | null>(null);
  const [lastProcessedAt, setLastProcessedAt] = useState<string | null>(null);
  const { flags } = useFeatureFlags();
  const isPaused = !flags.enablePartnerAutoPayout;

  const handleProcessROI = async () => {
    setLoading(true);
    setConfirmOpen(false);

    try {
      const { data, error } = await supabase.functions.invoke('process-supporter-roi', {
        body: {},
      });

      if (error) throw error;

      if (data.success) {
        setLastResults(data.results);
        setLastProcessedAt(new Date().toISOString());
        toast.success('Supporter ROI processed successfully!', {
          description: `Credited ${data.results.credited} supporters, total: UGX ${data.results.totalAmount.toLocaleString()}`,
        });
      } else {
        throw new Error(data.error || 'Unknown error');
      }
    } catch (error: any) {
      console.error('Error processing ROI:', error);
      toast.error('Failed to process supporter ROI', {
        description: error.message,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Card className="border-emerald-500/20 bg-gradient-to-br from-emerald-500/5 to-transparent">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-5 w-5 text-emerald-500" />
              Supporter ROI Processing
            </CardTitle>
            <Badge variant="outline" className="text-xs">
              <Calendar className="h-3 w-3 mr-1" />
              15% Monthly
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            ROI is <strong>automatically paid daily at 6:00 AM</strong> to supporter wallets via the platform ledger. Use the button below to manually trigger processing if needed.
          </p>
          {isPaused ? (
            <Badge variant="destructive" className="text-xs gap-1">
              <PauseCircle className="h-3 w-3" />
              Auto-payout PAUSED by administrator
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-xs gap-1">
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
              Auto-pay enabled — runs daily at 6:00 AM UTC
            </Badge>
          )}
          
          <div className="flex flex-wrap gap-2 text-xs">
            <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-600">
              💰 15% ROI per month
            </div>
            <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-blue-500/10 text-blue-600">
              📅 Every 30 days
            </div>
            <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-purple-500/10 text-purple-600">
              🔄 Auto-credited to wallet
            </div>
          </div>

          {lastResults && lastProcessedAt && (
            <div className="space-y-2 text-sm bg-success/10 p-3 rounded-lg">
              <div className="flex items-center gap-2 text-success font-medium">
                <CheckCircle2 className="h-4 w-4" />
                Last processed: {format(new Date(lastProcessedAt), 'MMM d, yyyy h:mm a')}
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="text-center p-2 bg-background/50 rounded">
                  <div className="font-bold text-foreground">{lastResults.processed}</div>
                  <div className="text-muted-foreground">Checked</div>
                </div>
                <div className="text-center p-2 bg-background/50 rounded">
                  <div className="font-bold text-success">{lastResults.credited}</div>
                  <div className="text-muted-foreground">Credited</div>
                </div>
                <div className="text-center p-2 bg-background/50 rounded">
                  <div className="font-bold text-primary">UGX {lastResults.totalAmount.toLocaleString()}</div>
                  <div className="text-muted-foreground">Total</div>
                </div>
              </div>
              {lastResults.errors.length > 0 && (
                <div className="text-xs text-destructive mt-2">
                  {lastResults.errors.length} error(s) occurred
                </div>
              )}
            </div>
          )}

          <Button 
            onClick={() => setConfirmOpen(true)} 
            disabled={loading || isPaused}
            className="w-full gap-2"
            variant={isPaused ? "outline" : "default"}
          >
            {isPaused ? (
              <>
                <PauseCircle className="h-4 w-4" />
                Payout Paused
              </>
            ) : loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Processing...
              </>
            ) : (
              <>
                <TrendingUp className="h-4 w-4" />
                Process Supporter ROI
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-emerald-500" />
              Process Supporter ROI?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will process monthly ROI payments for all eligible supporters.
              <br /><br />
              <strong>How it works:</strong>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>Checks all verified payment proofs due for ROI</li>
                <li>Credits 15% of rent amount to supporter wallets</li>
                <li>Sends notifications to credited supporters</li>
                <li>Sets next ROI due date (30 days later)</li>
              </ul>
              <br />
              <span className="text-muted-foreground text-xs flex items-center gap-1">
                <Users className="h-3 w-3" />
                Only payments due for ROI will be processed
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleProcessROI}>
              Process ROI
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
