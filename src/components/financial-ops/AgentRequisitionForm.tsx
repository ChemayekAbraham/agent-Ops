import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { FileText, Send, Loader2, ArrowRight } from 'lucide-react';
import { format } from 'date-fns';

const PURPOSE_OPTIONS = [
  { value: 'operations', label: 'Operations' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'research_development', label: 'R&D' },
  { value: 'salaries', label: 'Salaries' },
  { value: 'agent_advances', label: 'Agent Advances' },
  { value: 'employee_advances', label: 'Employee Advances' },
  { value: 'general', label: 'General' },
];

const statusConfig: Record<string, { label: string; className: string }> = {
  pending: { label: 'PENDING', className: 'bg-orange-500 text-white border-0' },
  approved: { label: 'APPROVED', className: 'bg-green-500 text-white border-0' },
  rejected: { label: 'DECLINED', className: 'bg-destructive text-white border-0' },
};

export function AgentRequisitionForm() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [description, setDescription] = useState('');
  const [showAll, setShowAll] = useState(false);

  const { data: history = [], isLoading: historyLoading } = useQuery({
    queryKey: ['agent-requisitions', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from('pending_wallet_operations')
        .select('*')
        .eq('user_id', user.id)
        .eq('category', 'agent_requisition')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    },
    enabled: !!user?.id,
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('Not authenticated');
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) throw new Error('Invalid amount');
      if (!purpose) throw new Error('Purpose is required');
      if (description.trim().length < 10) throw new Error('Description must be at least 10 characters');

      const { error } = await supabase.from('pending_wallet_operations').insert({
        user_id: user.id,
        amount: parsedAmount,
        category: 'agent_requisition',
        operation_type: 'agent_requisition',
        direction: 'cash_in',
        source_table: 'pending_wallet_operations',
        status: 'pending',
        description: `Fund requisition: ${PURPOSE_OPTIONS.find(p => p.value === purpose)?.label || purpose}`,
        metadata: { purpose, description: description.trim() },
      });
      if (error) throw error;

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'requisition_submitted',
        description: `Submitted fund requisition of UGX ${parsedAmount.toLocaleString()} for ${purpose}`,
        metadata: { amount: parsedAmount, purpose, description: description.trim() },
      });

      await supabase.from('notifications').insert({
        user_id: user.id,
        title: 'New Fund Requisition',
        message: `Fund requisition of UGX ${parsedAmount.toLocaleString()} submitted for ${purpose}`,
        type: 'approval_required',
        metadata: { category: 'agent_requisition', amount: parsedAmount, purpose },
      });
    },
    onSuccess: () => {
      toast.success('Requisition submitted for CFO approval');
      setAmount('');
      setPurpose('');
      setDescription('');
      queryClient.invalidateQueries({ queryKey: ['agent-requisitions'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const visibleHistory = showAll ? history : history.slice(0, 3);

  return (
    <div className="space-y-5">
      {/* Form Card */}
      <div className="rounded-2xl bg-muted/50 p-4 space-y-4">
        <div className="flex items-center gap-2.5 mb-1">
          <div className="rounded-full bg-primary/15 p-2">
            <FileText className="h-4 w-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Submit Fund Requisition</p>
            <p className="text-[10px] text-muted-foreground font-medium tracking-wide uppercase">
              Funds will be disbursed to your wallet
            </p>
          </div>
        </div>

        {/* Amount */}
        <div className="space-y-1.5">
          <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Amount (UGX)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground">UGX</span>
            <Input
              type="number"
              placeholder="0.00"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              min="1"
              className="pl-12 bg-muted border-0 rounded-xl h-12 text-base font-semibold"
            />
          </div>
        </div>

        {/* Purpose */}
        <div className="space-y-1.5">
          <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Purpose</label>
          <Select value={purpose} onValueChange={setPurpose}>
            <SelectTrigger className="bg-muted border-0 rounded-xl h-12">
              <SelectValue placeholder="Select requisition purpose" />
            </SelectTrigger>
            <SelectContent>
              {PURPOSE_OPTIONS.map(p => (
                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Description */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Description</label>
            <p className="text-[10px] text-muted-foreground">{description.trim().length} / 250</p>
          </div>
          <Textarea
            placeholder="Provide details regarding this fund request..."
            value={description}
            onChange={e => setDescription(e.target.value)}
            maxLength={250}
            rows={3}
            className="bg-muted border-0 rounded-xl text-sm"
          />
        </div>

        {/* Submit */}
        <Button
          className="w-full gap-2 bg-gradient-to-r from-purple-600 via-purple-500 to-pink-500 text-white rounded-full py-6 text-base font-semibold shadow-lg hover:opacity-90"
          onClick={() => submitMutation.mutate()}
          disabled={submitMutation.isPending || !amount || !purpose || description.trim().length < 10}
        >
          {submitMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>Submit Requisition <ArrowRight className="h-4 w-4" /></>
          )}
        </Button>
      </div>

      {/* History */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">My Requisitions</h3>
          {history.length > 3 && (
            <button
              onClick={() => setShowAll(v => !v)}
              className="text-xs font-semibold text-primary"
            >
              {showAll ? 'SHOW LESS' : 'VIEW ALL'}
            </button>
          )}
        </div>

        {historyLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : history.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">No requisitions yet</p>
        ) : (
          <div className="space-y-2.5">
            {visibleHistory.map((req: any) => {
              const meta = typeof req.metadata === 'object' ? req.metadata : {};
              const status = statusConfig[req.status] || { label: req.status, className: 'bg-muted text-muted-foreground border-0' };
              return (
                <div key={req.id} className="flex items-center gap-3 rounded-2xl bg-muted/40 p-3.5">
                  <div className="rounded-full bg-primary/15 p-2.5 shrink-0">
                    <FileText className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">
                      {PURPOSE_OPTIONS.find(p => p.value === meta.purpose)?.label || meta.purpose || 'Requisition'}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Badge className={`text-[9px] px-1.5 py-0 h-4 font-bold ${status.className}`}>
                        {status.label}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {format(new Date(req.created_at), 'MMM d, yyyy • hh:mm a')}
                      </span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-foreground">
                      {Number(req.amount).toLocaleString()}
                    </p>
                    <p className="text-[10px] text-muted-foreground font-medium">UGX</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
