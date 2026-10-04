import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { toast } from 'sonner';
import { Check, CheckCheck, ChevronsUpDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DisciplinaryRecord {
  id: string;
  employee_id: string;
  action_type: string;
  severity: string;
  description: string;
  status: string;
  effective_date: string;
  created_at: string;
  issued_by: string;
  expiry_date: string | null;
  resolution_note: string | null;
}

interface EmployeeOption {
  id: string;
  full_name: string;
  email: string | null;
  department: string | null;
}

const actionTypeOptions = [
  { value: 'verbal_warning', label: 'Verbal Warning' },
  { value: 'written_warning', label: 'Written Warning' },
  { value: 'suspension', label: 'Suspension' },
  { value: 'probation', label: 'Probation' },
  { value: 'termination', label: 'Termination' },
];

const severityOptions = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

const getDisplayName = (fullName: string | null | undefined, email: string | null | undefined, fallbackId?: string) => {
  if (fullName?.trim()) return fullName;
  if (email?.trim()) return email.split('@')[0];
  return fallbackId || 'Unnamed employee';
};

export default function HRDisciplinary() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [employeePopoverOpen, setEmployeePopoverOpen] = useState(false);
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const [resolvingRecordId, setResolvingRecordId] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [form, setForm] = useState({
    employee_id: '',
    action_type: 'verbal_warning',
    severity: 'low',
    description: '',
  });

  const resetForm = () => {
    setEditingRecordId(null);
    setEmployeePopoverOpen(false);
    setForm({ employee_id: '', action_type: 'verbal_warning', severity: 'low', description: '' });
  };

  const { data: records = [], isLoading: recordsLoading } = useQuery({
    queryKey: ['hr-disciplinary'],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('disciplinary_records')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (data || []) as DisciplinaryRecord[];
    },
  });

  const { data: staffList = [], isLoading: staffLoading } = useQuery({
    queryKey: ['hr-staff-list-searchable'],
    enabled: !!user,
    queryFn: async () => {
      const { data: staffProfiles, error: staffError } = await supabase
        .from('staff_profiles')
        .select('user_id, department');

      if (staffError) throw staffError;

      const ids = Array.from(new Set((staffProfiles || []).map((row) => row.user_id).filter(Boolean)));
      if (ids.length === 0) return [] as EmployeeOption[];

      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', ids);

      if (profilesError) throw profilesError;

      const profileMap = new Map((profiles || []).map((profile) => [profile.id, profile]));

      return ids
        .map((id) => {
          const profile = profileMap.get(id);
          const staffProfile = (staffProfiles || []).find((row) => row.user_id === id);

          return {
            id,
            full_name: getDisplayName(profile?.full_name, profile?.email, id),
            email: profile?.email || null,
            department: staffProfile?.department || null,
          };
        })
        .sort((a, b) => a.full_name.localeCompare(b.full_name));
    },
  });

  const employeesById = useMemo(() => new Map(staffList.map((employee) => [employee.id, employee])), [staffList]);
  const selectedEmployee = form.employee_id ? employeesById.get(form.employee_id) : null;
  const resolvingRecord = resolvingRecordId ? records.find((record) => record.id === resolvingRecordId) : null;

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error('Not authenticated');
      if (!form.employee_id) throw new Error('Select an employee');
      if (form.description.trim().length < 10) throw new Error('Description must be at least 10 characters');

      const actionType = form.action_type as Database["public"]["Enums"]["disciplinary_action_type"];

      if (editingRecordId) {
        const { error } = await supabase
          .from('disciplinary_records')
          .update({
            employee_id: form.employee_id,
            action_type: actionType,
            severity: form.severity,
            description: form.description.trim(),
          })
          .eq('id', editingRecordId);

        if (error) {
          console.error('Disciplinary update error:', error.message, error.details, error.hint, error.code);
          throw new Error(error.message);
        }
      } else {
        const insertPayload = {
          employee_id: form.employee_id,
          action_type: actionType,
          severity: form.severity,
          description: form.description.trim(),
          issued_by: user.id,
        };
        console.log('Inserting disciplinary record:', insertPayload);
        const { data, error } = await supabase.from('disciplinary_records').insert(insertPayload).select();

        if (error) {
          console.error('Disciplinary insert error:', error.message, error.details, error.hint, error.code);
          throw new Error(error.message);
        }
        console.log('Insert success:', data);
      }
    },
    onSuccess: () => {
      toast.success(editingRecordId ? 'Disciplinary record updated' : 'Disciplinary record created');
      setFormOpen(false);
      resetForm();
      queryClient.invalidateQueries({ queryKey: ['hr-disciplinary'] });
      queryClient.refetchQueries({ queryKey: ['hr-disciplinary'] });
    },
    onError: (err: any) => {
      console.error('Save mutation error:', err);
      toast.error(err.message || 'Unable to save disciplinary record');
    },
  });

  const resolveMutation = useMutation({
    mutationFn: async () => {
      if (!resolvingRecordId) throw new Error('No record selected');
      if (resolutionNote.trim().length < 10) throw new Error('Resolution note must be at least 10 characters');

      const { error } = await supabase
        .from('disciplinary_records')
        .update({
          status: 'resolved',
          resolution_note: resolutionNote.trim(),
        })
        .eq('id', resolvingRecordId);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Disciplinary record resolved');
      setResolveOpen(false);
      setResolvingRecordId(null);
      setResolutionNote('');
      queryClient.invalidateQueries({ queryKey: ['hr-disciplinary'] });
    },
    onError: (err: any) => toast.error(err.message || 'Unable to resolve disciplinary record'),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('disciplinary_records')
        .delete()
        .eq('id', id);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Disciplinary record deleted');
      queryClient.invalidateQueries({ queryKey: ['hr-disciplinary'] });
    },
    onError: (err: any) => toast.error(err.message || 'Unable to delete disciplinary record'),
  });

  const openCreateDialog = () => {
    resetForm();
    setFormOpen(true);
  };

  const openEditDialog = (record: DisciplinaryRecord) => {
    setEditingRecordId(record.id);
    setForm({
      employee_id: record.employee_id,
      action_type: record.action_type,
      severity: record.severity,
      description: record.description,
    });
    setFormOpen(true);
  };

  const openResolveDialog = (record: DisciplinaryRecord) => {
    setResolvingRecordId(record.id);
    setResolutionNote(record.resolution_note || '');
    setResolveOpen(true);
  };

  const handleDelete = (recordId: string) => {
    const confirmed = window.confirm('Delete this disciplinary record? This action cannot be undone.');
    if (!confirmed) return;
    deleteMutation.mutate(recordId);
  };

  const severityColors: Record<string, string> = {
    low: 'bg-muted text-muted-foreground border-transparent',
    medium: 'bg-warning/15 text-warning border-transparent',
    high: 'bg-destructive/10 text-destructive border-transparent',
    critical: 'bg-destructive text-destructive-foreground border-transparent',
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">Disciplinary Records</h2>
          <p className="text-sm text-muted-foreground">Search employees properly, issue actions, and manage records in one table.</p>
        </div>

        <Dialog
          open={formOpen}
          onOpenChange={(open) => {
            setFormOpen(open);
            if (!open) resetForm();
          }}
        >
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1" onClick={openCreateDialog}>
              <Plus className="h-3 w-3" /> New Record
            </Button>
          </DialogTrigger>
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>{editingRecordId ? 'Edit Disciplinary Action' : 'Issue Disciplinary Action'}</DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs">Employee</Label>
                <Popover open={employeePopoverOpen} onOpenChange={setEmployeePopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={employeePopoverOpen}
                      className="w-full justify-between font-normal"
                      disabled={staffLoading || staffList.length === 0}
                    >
                      {selectedEmployee
                        ? selectedEmployee.full_name
                        : staffLoading
                          ? 'Loading employees...'
                          : 'Search and select employee'}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search employee by name, email, or department..." />
                      <CommandList>
                        <CommandEmpty>No employees found.</CommandEmpty>
                        <CommandGroup>
                          {staffList.map((employee) => (
                            <CommandItem
                              key={employee.id}
                              value={`${employee.full_name} ${employee.email || ''} ${employee.department || ''}`}
                              onSelect={() => {
                                setForm((current) => ({ ...current, employee_id: employee.id }));
                                setEmployeePopoverOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  'mr-2 h-4 w-4',
                                  form.employee_id === employee.id ? 'opacity-100' : 'opacity-0',
                                )}
                              />
                              <div className="flex flex-col">
                                <span className="font-medium">{employee.full_name}</span>
                                <span className="text-xs text-muted-foreground">
                                  {employee.email || 'No email'}
                                  {employee.department ? ` • ${employee.department}` : ''}
                                </span>
                              </div>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-xs">Action Type</Label>
                  <Select value={form.action_type} onValueChange={(value) => setForm((current) => ({ ...current, action_type: value }))}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {actionTypeOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs">Severity</Label>
                  <Select value={form.severity} onValueChange={(value) => setForm((current) => ({ ...current, severity: value }))}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {severityOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Description (min 10 chars)</Label>
                <Textarea
                  value={form.description}
                  onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                  placeholder="Describe the incident and action taken..."
                  className={cn("min-h-[100px]", form.description.trim().length > 0 && form.description.trim().length < 10 && "border-destructive")}
                />
                {form.description.trim().length > 0 && form.description.trim().length < 10 && (
                  <p className="text-xs text-destructive">{form.description.trim().length}/10 characters — need at least 10</p>
                )}
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setFormOpen(false);
                    resetForm();
                  }}
                >
                  Cancel
                </Button>
                <Button type="button" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? 'Saving...' : editingRecordId ? 'Update Record' : 'Issue Action'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="border-border/50">
        <CardContent className="p-0">
          {recordsLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading disciplinary records...</p>
          ) : records.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No disciplinary records yet.</p>
          ) : (
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((record) => {
                  const employee = employeesById.get(record.employee_id);
                  const employeeName = employee?.full_name || record.employee_id;
                  const actionLabel = actionTypeOptions.find((option) => option.value === record.action_type)?.label || record.action_type;

                  return (
                    <TableRow key={record.id}>
                      <TableCell>
                        <div className="space-y-1">
                          <p className="font-medium text-foreground">{employeeName}</p>
                          <p className="text-xs text-muted-foreground">{employee?.email || 'No email available'}</p>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{actionLabel}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={severityColors[record.severity] || ''}>
                          {record.severity}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={record.status === 'resolved' ? 'secondary' : 'default'}>
                          {record.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(record.effective_date).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="max-w-[320px] whitespace-normal text-sm text-muted-foreground">
                        <div className="space-y-1">
                          <p>{record.description}</p>
                          {record.resolution_note ? (
                            <p className="text-xs text-foreground">Resolution: {record.resolution_note}</p>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => openEditDialog(record)}
                            title="Edit record"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => openResolveDialog(record)}
                            title="Resolve record"
                            disabled={record.status === 'resolved'}
                          >
                            <CheckCheck className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => handleDelete(record.id)}
                            title="Delete record"
                            disabled={deleteMutation.isPending}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={resolveOpen}
        onOpenChange={(open) => {
          setResolveOpen(open);
          if (!open) {
            setResolvingRecordId(null);
            setResolutionNote('');
          }
        }}
      >
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Resolve Disciplinary Action</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
              <p className="text-sm font-medium text-foreground">{resolvingRecord ? employeesById.get(resolvingRecord.employee_id)?.full_name || resolvingRecord.employee_id : 'Selected employee'}</p>
              <p className="text-xs text-muted-foreground">
                Add a clear resolution note before marking this action as resolved.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Resolution note (min 10 chars)</Label>
              <Textarea
                value={resolutionNote}
                onChange={(event) => setResolutionNote(event.target.value)}
                placeholder="Describe how this disciplinary issue was resolved..."
                className="min-h-[120px]"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setResolveOpen(false);
                  setResolvingRecordId(null);
                  setResolutionNote('');
                }}
              >
                Cancel
              </Button>
              <Button onClick={() => resolveMutation.mutate()} disabled={resolveMutation.isPending}>
                {resolveMutation.isPending ? 'Resolving...' : 'Mark as Resolved'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
