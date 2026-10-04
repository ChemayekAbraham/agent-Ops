import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { UserPlus, Send, Wallet, DollarSign, Loader2, Trash2 } from 'lucide-react';
import { UserSearchPicker } from './UserSearchPicker';

const EXPENSE_CATEGORIES = [
  { value: 'operations', label: '⚙️ Operations' },
  { value: 'marketing', label: '📢 Marketing' },
  { value: 'research_and_development', label: '🔬 R&D' },
  { value: 'salaries', label: '💰 Salaries' },
  { value: 'agent_advances', label: '🏃 Agent Advances' },
  { value: 'employee_advances', label: '👤 Employee Advances' },
  { value: 'general', label: '📋 General' },
];

export function FinancialAgentsPanel() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showAssign, setShowAssign] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<any>(null);
  const [pickedUser, setPickedUser] = useState<any>(null);
  const [category, setCategory] = useState('operations');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');

  const { data: financialAgents = [], isLoading } = useQuery({
    queryKey: ['financial-agents'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('financial_agents')
        .select('*, profiles:agent_id(id, full_name, phone)')
        .eq('is_active', true)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  const { data: recentTransfers = [] } = useQuery({
    queryKey: ['expense-transfers'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('platform_expense_transfers')
        .select('*, profiles:agent_id(full_name)')
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data || [];
    },
  });

  const assignMutation = useMutation({
    mutationFn: async () => {
      if (!pickedUser) throw new Error('Please select an agent');
      const { error } = await supabase.from('financial_agents').insert({
        agent_id: pickedUser.id,
        assigned_by: user!.id,
        expense_category: category as any,
        label: label || `${EXPENSE_CATEGORIES.find(c => c.value === category)?.label} Agent`,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: '✅ Financial Agent assigned' });
      qc.invalidateQueries({ queryKey: ['financial-agents'] });
      setShowAssign(false);
      setPickedUser(null);
      setLabel('');
    },
    onError: (e: any) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const transferMutation = useMutation({
    mutationFn: async () => {
      const amt = parseFloat(amount);
      if (!amt || amt <= 0) throw new Error('Invalid amount');
      if (!description || description.length < 5) throw new Error('Description must be at least 5 characters');
      const { data, error } = await supabase.functions.invoke('platform-expense-transfer', {
        body: {
          action: 'transfer',
          financial_agent_id: selectedAgent.id,
          amount: amt,
          description,
          expense_category: selectedAgent.expense_category,
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast({ title: '✅ Transfer sent', description: data?.message });
      qc.invalidateQueries({ queryKey: ['expense-transfers'] });
      setShowTransfer(false);
      setAmount('');
      setDescription('');
    },
    onError: (e: any) => toast({ title: 'Transfer failed', description: e.message, variant: 'destructive' }),
  });

  const deactivateMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('financial_agents').update({ is_active: false }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: 'Agent deactivated' });
      qc.invalidateQueries({ queryKey: ['financial-agents'] });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <DollarSign className="h-5 w-5 text-primary" />
          Financial Agents
        </h2>
        <Dialog open={showAssign} onOpenChange={v => { setShowAssign(v); if (!v) setPickedUser(null); }}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5"><UserPlus className="h-4 w-4" /> Assign Agent</Button>
          </DialogTrigger>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Assign Financial Agent</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <UserSearchPicker
                label="Search Agent"
                placeholder="Search by name or phone..."
                selectedUser={pickedUser}
                onSelect={setPickedUser}
                roleFilter="agent"
              />
              <div>
                <Label>Expense Category</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {EXPENSE_CATEGORIES.map(c => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Label (optional)</Label>
                <Input placeholder="e.g. Operations Finance Lead" value={label} onChange={e => setLabel(e.target.value)} />
              </div>
              <Button className="w-full" onClick={() => assignMutation.mutate()} disabled={assignMutation.isPending || !pickedUser}>
                {assignMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Assign
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : financialAgents.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground">No financial agents assigned yet</CardContent></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {financialAgents.map((fa: any) => (
            <Card key={fa.id} className="border-l-4 border-l-primary">
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-sm">{fa.profiles?.full_name || 'Unknown'}</p>
                    <p className="text-xs text-muted-foreground">{fa.profiles?.phone}</p>
                  </div>
                  <Badge variant="secondary" className="text-[10px]">
                    {EXPENSE_CATEGORIES.find(c => c.value === fa.expense_category)?.label || fa.expense_category}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">{fa.label}</p>
                <div className="flex gap-2">
                  <Button size="sm" className="flex-1 gap-1" onClick={() => { setSelectedAgent(fa); setShowTransfer(true); }}>
                    <Send className="h-3.5 w-3.5" /> Transfer
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => deactivateMutation.mutate(fa.id)}>
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Transfer Dialog */}
      <Dialog open={showTransfer} onOpenChange={setShowTransfer}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5 text-primary" />
              Platform → {selectedAgent?.profiles?.full_name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Badge>{EXPENSE_CATEGORIES.find(c => c.value === selectedAgent?.expense_category)?.label}</Badge>
            <div>
              <Label>Amount (UGX)</Label>
              <Input type="number" placeholder="50000" value={amount} onChange={e => setAmount(e.target.value)} />
              <div className="flex flex-wrap gap-1.5 mt-2">
                {[50000, 100000, 200000, 500000, 1000000].map(v => (
                  <Button key={v} size="sm" variant="outline" className="text-xs h-7" onClick={() => setAmount(String(v))}>
                    {(v / 1000).toFixed(0)}K
                  </Button>
                ))}
              </div>
            </div>
            <div>
              <Label>Description (what is this for?)</Label>
              <Textarea placeholder="Office supplies, transport, marketing materials..." value={description} onChange={e => setDescription(e.target.value)} rows={2} />
            </div>
            <Button className="w-full" onClick={() => transferMutation.mutate()} disabled={transferMutation.isPending || !amount || !description}>
              {transferMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
              Send UGX {parseFloat(amount || '0').toLocaleString()}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {recentTransfers.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Recent Expense Transfers</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 max-h-60 overflow-y-auto">
            {recentTransfers.map((t: any) => (
              <div key={t.id} className="flex items-center justify-between text-xs border-b pb-2">
                <div>
                  <p className="font-medium">{t.profiles?.full_name}</p>
                  <p className="text-muted-foreground truncate max-w-[180px]">{t.description}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-primary">UGX {Number(t.amount).toLocaleString()}</p>
                  <Badge variant="outline" className="text-[9px]">{t.expense_category}</Badge>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
