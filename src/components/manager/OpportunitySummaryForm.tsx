import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FileText, Send, ArrowLeft, Loader2, CheckCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useOpportunitySummary } from '@/hooks/useOpportunitySummary';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';

export function OpportunitySummaryForm({ onClose }: { onClose?: () => void }) {
  const { user } = useAuth();
  const { summary, loading: loadingSummary, refetch } = useOpportunitySummary();
  const [totalRentRequested, setTotalRentRequested] = useState('');
  const [totalRequests, setTotalRequests] = useState('');
  const [totalLandlords, setTotalLandlords] = useState('');
  const [totalAgents, setTotalAgents] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Pre-fill from existing summary
  useEffect(() => {
    if (summary) {
      setTotalRentRequested(String(summary.total_rent_requested));
      setTotalRequests(String(summary.total_requests));
      setTotalLandlords(String(summary.total_landlords));
      setTotalAgents(String(summary.total_agents));
      setNotes(summary.notes || '');
    }
  }, [summary]);

  const handleSubmit = async () => {
    if (!user) return;
    setSubmitting(true);
    try {
      const payload = {
        total_rent_requested: Number(totalRentRequested) || 0,
        total_requests: Number(totalRequests) || 0,
        total_landlords: Number(totalLandlords) || 0,
        total_agents: Number(totalAgents) || 0,
        notes: notes.trim() || null,
        posted_by: user.id,
      };

      if (summary) {
        // Update existing
        const { error } = await supabase
          .from('opportunity_summaries')
          .update(payload)
          .eq('id', summary.id);
        if (error) throw error;
        toast.success('Opportunity summary updated!');
      } else {
        // Insert new
        const { error } = await supabase
          .from('opportunity_summaries')
          .insert(payload);
        if (error) throw error;
        toast.success('Opportunity summary posted!');
      }
      await refetch();
    } catch (err: any) {
      console.error('Failed to save summary:', err);
      toast.error(err?.message || 'Failed to save summary');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          {onClose && (
            <button
              onClick={onClose}
              className="p-2 -ml-1 rounded-lg hover:bg-muted active:scale-95 transition-all touch-manipulation min-h-[40px] min-w-[40px] flex items-center justify-center"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <div className="flex-1">
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileText className="h-5 w-5 text-primary" />
              Post Opportunity Summary
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              This data will be visible to all supporters on their dashboard
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Current live summary preview */}
        {summary && (
          <div className="rounded-xl bg-primary/10 p-3 space-y-1">
            <p className="text-xs font-semibold text-primary flex items-center gap-1">
              <CheckCircle className="h-3 w-3" /> Currently Live
            </p>
            <p className="text-sm font-bold">{formatUGX(Number(summary.total_rent_requested))}</p>
            <p className="text-xs text-muted-foreground">
              {summary.total_requests} requests · {summary.total_landlords} landlords · {summary.total_agents} agents
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Total Rent Requested (UGX)</Label>
            <Input
              type="number"
              placeholder="e.g. 5000000"
              value={totalRentRequested}
              onChange={(e) => setTotalRentRequested(e.target.value)}
              className="h-10"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Total Requests</Label>
            <Input
              type="number"
              placeholder="e.g. 25"
              value={totalRequests}
              onChange={(e) => setTotalRequests(e.target.value)}
              className="h-10"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Total Landlords</Label>
            <Input
              type="number"
              placeholder="e.g. 15"
              value={totalLandlords}
              onChange={(e) => setTotalLandlords(e.target.value)}
              className="h-10"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Total Agents</Label>
            <Input
              type="number"
              placeholder="e.g. 8"
              value={totalAgents}
              onChange={(e) => setTotalAgents(e.target.value)}
              className="h-10"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Notes (optional)</Label>
          <Textarea
            placeholder="Any additional info for supporters..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="min-h-[80px] resize-none"
            maxLength={500}
          />
        </div>

        <Button
          onClick={handleSubmit}
          disabled={submitting || !totalRentRequested}
          className="w-full gap-2 h-12 text-base font-bold"
        >
          {submitting ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Send className="h-5 w-5" />
          )}
          {summary ? 'Update Summary' : 'Post Summary'}
        </Button>
      </CardContent>
    </Card>
  );
}
