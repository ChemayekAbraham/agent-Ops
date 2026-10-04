import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Send, Wallet, CheckCircle2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
import { UserSearchPicker } from '@/components/cfo/UserSearchPicker';

export function CFOAgentOpsFloatSender() {
  const qc = useQueryClient();
  const [pickedAgent, setPickedAgent] = useState<any>(null);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [lastResult, setLastResult] = useState<any>(null);

  const sendMutation = useMutation({
    mutationFn: async () => {
      const amt = parseFloat(amount);
      if (!pickedAgent) throw new Error('Select an agent');
      if (!amt || amt <= 0) throw new Error('Enter a valid amount');

      const { data, error } = await supabase.functions.invoke('assign-agent-float', {
        body: {
          agent_id: pickedAgent.id,
          amount: amt,
          description: description.trim() || `Operations float from CFO to ${pickedAgent.full_name}`,
        },
      });

      if (error) {
        const msg = typeof error === 'object' && 'message' in error ? (error as any).message : 'Transfer failed';
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      setLastResult(data);
      toast.success(`Operations float sent to ${pickedAgent?.full_name} from Welile Finance`);
      qc.invalidateQueries({ queryKey: ['agent-float-balances'] });
      setAmount('');
      setDescription('');
      setPickedAgent(null);
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Card className="rounded-2xl border-2 border-primary/20">
      <CardContent className="p-5 space-y-4">
        <div>
          <h3 className="text-base font-bold flex items-center gap-2">
            <Wallet className="h-5 w-5 text-primary" />
            Send Operations Float to Agent
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Credit an agent's operations float so they can pay tenant rent directly in the field.
          </p>
        </div>

        {lastResult && (
          <div className="flex items-center gap-2 bg-success/10 border border-success/20 rounded-xl p-3">
            <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
            <p className="text-xs text-success font-medium">
              {formatUGX(lastResult.amount)} sent to {lastResult.agent}
            </p>
          </div>
        )}

        <div className="space-y-3">
          <UserSearchPicker
            label="Search Agent"
            placeholder="Search by name or phone..."
            selectedUser={pickedAgent}
            onSelect={setPickedAgent}
            roleFilter="agent"
          />

          <div>
            <Label className="text-xs">Amount (UGX)</Label>
            <Input
              type="number"
              placeholder="e.g. 500000"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="h-11"
            />
            <div className="flex flex-wrap gap-1.5 mt-2">
              {[100000, 200000, 500000, 1000000, 2000000].map(v => (
                <Button key={v} size="sm" variant="outline" className="text-xs h-7" onClick={() => setAmount(String(v))}>
                  {(v / 1000).toFixed(0)}K
                </Button>
              ))}
            </div>
          </div>

          <div>
            <Label className="text-xs">Description (optional)</Label>
            <Textarea
              placeholder="e.g. Weekly operations float top-up"
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
            />
          </div>

          <Button
            onClick={() => sendMutation.mutate()}
            disabled={sendMutation.isPending || !pickedAgent || !amount || parseFloat(amount) <= 0}
            className="w-full h-12 text-base font-bold gap-2"
          >
            {sendMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-5 w-5" />}
            Send {formatUGX(parseFloat(amount || '0'))} Operations Float
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
