import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Plus, Edit2, Building2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import HRRolesPanel from '@/components/hr/HRRolesPanel';

interface Department {
  id: string;
  key: string;
  name: string;
  active: boolean;
  created_at: string;
}

const slugifyKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

export default function HRDepartments() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');

  const {
    data: departments,
    isLoading,
    error: departmentsError,
  } = useQuery({
    queryKey: ['hr-departments'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('hr_departments')
        .select('id, key, name, active, created_at')
        .order('name');
      if (error) throw error;
      return (data || []) as Department[];
    },
  });

  // EMPLOYEES = distinct staff_id in hr_assignments for that department_id,
  // is_primary = true, ended_on is null. No hr_positions join.
  const {
    data: deptEmployeeCounts,
    isLoading: countsLoading,
    error: countsError,
  } = useQuery({
    queryKey: ['hr-department-primary-assignment-counts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('hr_assignments')
        .select('staff_id, department_id')
        .eq('is_primary', true)
        .is('ended_on', null);
      if (error) throw error;
      const distinct: Record<string, Set<string>> = {};
      (data || []).forEach((row: any) => {
        if (!row.department_id || !row.staff_id) return;
        if (!distinct[row.department_id]) distinct[row.department_id] = new Set<string>();
        distinct[row.department_id].add(row.staff_id);
      });
      const counts: Record<string, number> = {};
      Object.entries(distinct).forEach(([deptId, staff]) => {
        counts[deptId] = staff.size;
      });
      return counts;
    },
  });

  const employeeCountFor = (deptId: string) => deptEmployeeCounts?.[deptId] ?? 0;

  const refetchAll = async () => {
    await Promise.all([
      queryClient.refetchQueries({ queryKey: ['hr-departments'] }),
      queryClient.refetchQueries({ queryKey: ['hr-department-primary-assignment-counts'] }),
    ]);
  };

  const logAudit = async (payload: any) => {
    // Audit logging must never block or undo the write it describes.
    try {
      await supabase.from('audit_logs').insert(payload);
    } catch (auditError) {
      console.error('[HRDepartments] audit log insert failed', auditError);
    }
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error('Name is required');
      if (!user) throw new Error('Not authenticated');

      if (editId) {
        const { error } = await supabase
          .from('hr_departments')
          .update({ name: name.trim() })
          .eq('id', editId);
        if (error) throw error;
        await logAudit({
          user_id: user.id, action_type: 'hr_department_updated', table_name: 'hr_departments', record_id: editId,
          metadata: { name: name.trim(), reason: 'HR department update' },
        });
      } else {
        const key = slugifyKey(name);
        if (!key) throw new Error('Name must contain letters or numbers to derive a key');
        const { error } = await supabase
          .from('hr_departments')
          .insert({ name: name.trim(), key });
        if (error) {
          if ((error as any).code === '23505') {
            throw new Error(`a department with this key already exists: ${key}`);
          }
          throw error;
        }
        await logAudit({
          user_id: user.id, action_type: 'hr_department_created', table_name: 'hr_departments', record_id: name.trim(),
          metadata: { name: name.trim(), reason: 'HR department creation' },
        });
      }
    },
    onSuccess: async () => {
      toast.success(editId ? 'Department updated' : 'Department created');
      closeDialog();
      await refetchAll();
    },
    onError: (err: any) => toast.error(err.message),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      if (!user) throw new Error('Not authenticated');
      if (!active) {
        if (countsLoading) throw new Error('Employee counts are still loading — try again in a moment');
        if (countsError) throw new Error('Employee counts could not be loaded, so deactivation is blocked');
        const employees = employeeCountFor(id);
        if (employees > 0) {
          throw new Error(`Cannot deactivate: this department still has ${employees} employee${employees === 1 ? '' : 's'} assigned`);
        }
      }
      const { error } = await supabase.from('hr_departments').update({ active }).eq('id', id);
      if (error) throw error;
      await logAudit({
        user_id: user.id, action_type: active ? 'hr_department_activated' : 'hr_department_deactivated',
        table_name: 'hr_departments', record_id: id,
        metadata: { reason: `Department ${active ? 'activated' : 'deactivated'} by HR` },
      });
    },
    onSuccess: async () => {
      toast.success('Department status updated');
      await refetchAll();
    },
    onError: (err: any) => toast.error(err.message),
  });

  const closeDialog = () => {
    setDialogOpen(false);
    setEditId(null);
    setName('');
  };

  const openEdit = (dept: Department) => {
    setEditId(dept.id);
    setName(dept.name);
    setDialogOpen(true);
  };

  const rows = departments ?? [];
  const filtered = rows.filter(d => {
    const matchesSearch = !search || d.name.toLowerCase().includes(search.toLowerCase());
    const matchesStatus =
      statusFilter === 'all' ? true :
      statusFilter === 'active' ? d.active :
      !d.active;
    return matchesSearch && matchesStatus;
  });

  const tileValue = (compute: () => number) => {
    if (departmentsError) return '—';
    if (isLoading || !departments) return '…';
    return compute();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">Departments</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Manage organizational departments</p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => { setEditId(null); setName(''); setDialogOpen(true); }}>
          <Plus className="h-3.5 w-3.5" /> Add Department
        </Button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Card className="border-border/40">
          <CardContent className="p-4">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Total</p>
            <p className="text-2xl font-bold text-foreground mt-0.5">{tileValue(() => rows.length)}</p>
          </CardContent>
        </Card>
        <Card className="border-border/40">
          <CardContent className="p-4">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Active</p>
            <p className="text-2xl font-bold text-success mt-0.5">{tileValue(() => rows.filter(d => d.active).length)}</p>
          </CardContent>
        </Card>
        <Card className="border-border/40">
          <CardContent className="p-4">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Inactive</p>
            <p className="text-2xl font-bold text-destructive mt-0.5">{tileValue(() => rows.filter(d => !d.active).length)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Search and status filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <Input placeholder="Search departments..." value={search} onChange={e => setSearch(e.target.value)} className="h-9 flex-1" />
        <div className="inline-flex rounded-lg border border-border bg-muted/30 p-0.5">
          {(['all', 'active', 'inactive'] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setStatusFilter(key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                statusFilter === key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
            >
              {key === 'all' ? 'All' : key === 'active' ? 'Active' : 'Inactive'}
            </button>
          ))}
        </div>
      </div>

      {departmentsError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-destructive">Could not load departments</p>
          <p className="text-xs text-destructive/80 mt-1">{(departmentsError as any)?.message || String(departmentsError)}</p>
        </div>
      ) : isLoading ? (
        <div className="space-y-2">{[1,2,3].map(i => <div key={i} className="h-12 rounded-lg bg-muted/30 animate-pulse" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <Building2 className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No departments found</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="text-xs font-semibold uppercase tracking-wider">Name</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-center">Employees</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider">Status</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(dept => (
                <TableRow key={dept.id}>
                  <TableCell className="font-medium text-sm">{dept.name}</TableCell>
                  <TableCell className="text-center">
                    {countsError ? (
                      <span className="text-xs text-destructive" title={(countsError as any)?.message || String(countsError)}>error</span>
                    ) : countsLoading || !deptEmployeeCounts ? (
                      <span className="inline-block h-4 w-8 rounded bg-muted/50 animate-pulse align-middle" />
                    ) : (
                      <Badge variant="secondary" className="text-xs">{employeeCountFor(dept.id)}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={dept.active ? 'default' : 'destructive'} className="text-[10px]">
                      {dept.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => openEdit(dept)}>
                        <Edit2 className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost" size="sm" className="h-7 w-7 p-0"
                        onClick={() => toggleMutation.mutate({ id: dept.id, active: !dept.active })}
                      >
                        {dept.active ? <Trash2 className="h-3.5 w-3.5 text-destructive" /> : <Building2 className="h-3.5 w-3.5 text-success" />}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={() => closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editId ? 'Edit Department' : 'Create Department'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Department Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Engineering, Marketing..." />
              {!editId && name.trim() && (
                <p className="text-[10px] text-muted-foreground mt-1">Key: {slugifyKey(name) || '—'}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>Cancel</Button>
            <Button onClick={() => saveMutation.mutate()} disabled={!name.trim() || saveMutation.isPending}>
              {saveMutation.isPending ? 'Saving...' : editId ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Roles (job titles) */}
      <HRRolesPanel />
    </div>
  );
}
