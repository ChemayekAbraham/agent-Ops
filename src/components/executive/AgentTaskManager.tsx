import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { ClipboardList, Plus, CheckCircle, Clock, AlertCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';

interface TaskRow {
  id: string;
  agent_id: string;
  agent_name?: string;
  title: string;
  task_type: string;
  priority: string;
  status: string;
  due_date: string | null;
  created_at: string;
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-500/10 text-amber-700',
  in_progress: 'bg-blue-500/10 text-blue-600',
  completed: 'bg-green-500/10 text-green-700',
  cancelled: 'bg-muted text-muted-foreground',
};

const PRIORITY_STYLES: Record<string, string> = {
  low: 'bg-muted text-muted-foreground',
  medium: 'bg-blue-500/10 text-blue-600',
  high: 'bg-amber-500/10 text-amber-700',
  urgent: 'bg-destructive/10 text-destructive',
};

export function AgentTaskManager() {
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [agentSearch, setAgentSearch] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [taskType, setTaskType] = useState('general');
  const [priority, setPriority] = useState('medium');
  const [dueDate, setDueDate] = useState('');
  const [creating, setCreating] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: tasks, isLoading } = useQuery({
    queryKey: ['agent-tasks-list'],
    queryFn: async () => {
      const { data } = await supabase.from('agent_tasks')
        .select('id, agent_id, title, task_type, priority, status, due_date, created_at')
        .order('created_at', { ascending: false })
        .limit(50);

      const agentIds = [...new Set((data || []).map(t => t.agent_id))];
      const { data: profiles } = await supabase.from('profiles')
        .select('id, full_name').in('id', agentIds);
      const nameMap: Record<string, string> = {};
      (profiles || []).forEach(p => { nameMap[p.id] = p.full_name; });

      return (data || []).map(t => ({ ...t, agent_name: nameMap[t.agent_id] || t.agent_id.substring(0, 8) })) as TaskRow[];
    },
    staleTime: 120000,
  });

  // Agent search for assignment
  const { data: agentResults } = useQuery({
    queryKey: ['task-agent-search', agentSearch],
    queryFn: async () => {
      if (agentSearch.length < 2) return [];
      const { data: roles } = await supabase.from('user_roles').select('user_id').eq('role', 'agent');
      const ids = (roles || []).map(r => r.user_id);
      const { data } = await supabase.from('profiles')
        .select('id, full_name, phone')
        .in('id', ids)
        .or(`full_name.ilike.%${agentSearch}%,phone.ilike.%${agentSearch}%`)
        .limit(10);
      return data || [];
    },
    enabled: agentSearch.length >= 2,
    staleTime: 30000,
  });

  const handleCreate = async () => {
    if (!title || !selectedAgentId) {
      toast({ title: 'Error', description: 'Enter a title and select an agent', variant: 'destructive' });
      return;
    }
    setCreating(true);
    try {
      const { error } = await supabase.from('agent_tasks').insert({
        agent_id: selectedAgentId,
        assigned_by: user?.id,
        title,
        description,
        task_type: taskType,
        priority,
        due_date: dueDate || null,
      });
      if (error) throw error;
      toast({ title: 'Task Created', description: `Assigned to agent successfully` });
      setCreateOpen(false);
      setTitle('');
      setDescription('');
      setSelectedAgentId('');
      setAgentSearch('');
      queryClient.invalidateQueries({ queryKey: ['agent-tasks-list'] });
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  };

  const statusCounts = {
    pending: (tasks || []).filter(t => t.status === 'pending').length,
    in_progress: (tasks || []).filter(t => t.status === 'in_progress').length,
    completed: (tasks || []).filter(t => t.status === 'completed').length,
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <ClipboardList className="h-4 w-4" />
          Agent Tasks
        </h3>
        <Button size="sm" className="h-7 text-xs" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3 w-3 mr-1" /> Assign Task
        </Button>
      </div>

      {/* Status summary */}
      <div className="flex gap-2">
        <div className="flex items-center gap-1 text-xs">
          <Clock className="h-3 w-3 text-amber-600" />
          <span className="font-medium">{statusCounts.pending}</span> pending
        </div>
        <div className="flex items-center gap-1 text-xs">
          <AlertCircle className="h-3 w-3 text-blue-600" />
          <span className="font-medium">{statusCounts.in_progress}</span> active
        </div>
        <div className="flex items-center gap-1 text-xs">
          <CheckCircle className="h-3 w-3 text-green-600" />
          <span className="font-medium">{statusCounts.completed}</span> done
        </div>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground py-4 text-center">Loading tasks...</p>
      ) : (tasks || []).length === 0 ? (
        <div className="text-center py-6 text-muted-foreground">
          <ClipboardList className="h-6 w-6 mx-auto mb-2 opacity-30" />
          <p className="text-sm">No tasks assigned yet</p>
        </div>
      ) : (
        <div className="space-y-1.5 max-h-[250px] overflow-y-auto">
          {(tasks || []).map(task => (
            <div key={task.id} className="flex items-center gap-2 p-2 rounded-xl bg-muted/30">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{task.title}</p>
                <p className="text-[10px] text-muted-foreground">→ {task.agent_name}</p>
              </div>
              <Badge className={`text-[9px] ${PRIORITY_STYLES[task.priority]}`}>{task.priority}</Badge>
              <Badge className={`text-[9px] ${STATUS_STYLES[task.status]}`}>{task.status}</Badge>
            </div>
          ))}
        </div>
      )}

      {/* Create Task Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Assign Task to Agent</DialogTitle>
            <DialogDescription>Create a task with deadline and priority for an agent</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Agent search */}
            <div className="space-y-1.5">
              <Label>Agent</Label>
              {selectedAgentId ? (
                <div className="flex items-center gap-2 p-2 rounded-lg bg-muted">
                  <span className="text-sm font-medium flex-1">
                    {agentResults?.find(a => a.id === selectedAgentId)?.full_name || selectedAgentId.substring(0, 8)}
                  </span>
                  <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => { setSelectedAgentId(''); setAgentSearch(''); }}>
                    Change
                  </Button>
                </div>
              ) : (
                <>
                  <Input
                    placeholder="Search agent by name or phone..."
                    value={agentSearch}
                    onChange={e => setAgentSearch(e.target.value)}
                  />
                  {(agentResults || []).length > 0 && (
                    <div className="border rounded-lg max-h-32 overflow-y-auto">
                      {agentResults!.map(a => (
                        <button
                          key={a.id}
                          onClick={() => setSelectedAgentId(a.id)}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-muted"
                        >
                          {a.full_name} <span className="text-muted-foreground">• {a.phone}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Task Title</Label>
              <Input placeholder="e.g. Verify tenant at Kisenyi" value={title} onChange={e => setTitle(e.target.value)} />
            </div>

            <div className="space-y-1.5">
              <Label>Description (optional)</Label>
              <Textarea placeholder="Details..." value={description} onChange={e => setDescription(e.target.value)} rows={2} />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={taskType} onValueChange={setTaskType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="general">General</SelectItem>
                    <SelectItem value="verify_tenant">Verify Tenant</SelectItem>
                    <SelectItem value="collect_receipt">Collect Receipt</SelectItem>
                    <SelectItem value="visit_property">Visit Property</SelectItem>
                    <SelectItem value="follow_up">Follow Up</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Priority</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Due Date</Label>
                <Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
              </div>
            </div>

            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button className="flex-1" onClick={handleCreate} disabled={creating || !title || !selectedAgentId}>
                {creating ? 'Creating...' : 'Assign Task'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
