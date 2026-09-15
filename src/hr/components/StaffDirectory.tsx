import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { AlertTriangle, ChevronDown, ChevronRight, Copy, Download, Loader2, MoreHorizontal, Plus, Trash2, UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import {
  createDepartment,
  createPosition,
  addAssignment,
  changeDepartment,
  transferPosition,
  endAssignment,
  enrollStaff,
  exitStaff,
  reinstateStaff,
  getActiveAssignmentsByStaff,
  getDepartments,
  getPositions,
  getStaffDirectory,
  searchUnenrolledStaff,
  type ActiveAssignment,
  type Position,
  type UnenrolledStaffCandidate,
} from '@/hr/api';
import type { Department, Employee } from '@/hr/types';

const NONE = '__none__';

/** Turns any thrown value into something a person can read. */
function readableError(e: unknown, action: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/hr_assign_one_primary/i.test(raw)) {
    return 'This person already has a primary position. Untick the primary box, or try again — the existing primary must be cleared first.';
  }
  if (/hr_assign_no_dup_position/i.test(raw)) {
    return 'This person already holds that position. Choose a different position.';
  }
  if (/row-level security|permission denied|not authorized|violates row/i.test(raw)) {
    return `${action} was refused by the database. This requires the hr or super_admin role.`;
  }
  return `${action} failed: ${raw}`;
}

export default function StaffDirectory() {
  const navigate = useNavigate();
  const [staff, setStaff] = useState<Employee[]>([]);
  const [query, setQuery] = useState('');
  const [positions, setPositions] = useState<Position[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [assignments, setAssignments] = useState<Record<string, ActiveAssignment[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [addFor, setAddFor] = useState<Employee | null>(null);
  const [transferFor, setTransferFor] = useState<Employee | null>(null);
  const [deptChangeFor, setDeptChangeFor] = useState<Employee | null>(null);
  const [removeFor, setRemoveFor] = useState<Employee | null>(null);
  const [exitFor, setExitFor] = useState<Employee | null>(null);
  const [reinstateFor, setReinstateFor] = useState<Employee | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'people' | 'exited' | 'unenrolled'>('people');
  const [departmentFilter, setDepartmentFilter] = useState<string>('__all__');
  const [unenrolled, setUnenrolled] = useState<UnenrolledStaffCandidate[]>([]);
  const [unenrolledLoading, setUnenrolledLoading] = useState(false);
  const [unenrolledError, setUnenrolledError] = useState<string | null>(null);
  const [enrollCandidate, setEnrollCandidate] = useState<UnenrolledStaffCandidate | null>(null);
  const [filterNoAssignment, setFilterNoAssignment] = useState(false);


  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [directory, positionRows, departmentRows, assignmentRows] = await Promise.all([
        getStaffDirectory(),
        getPositions(),
        getDepartments(),
        getActiveAssignmentsByStaff(),
      ]);
      setStaff(directory);
      setPositions(positionRows);
      setDepartments(departmentRows);
      setAssignments(assignmentRows);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load staff');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    setUnenrolledLoading(true);
    setUnenrolledError(null);
    searchUnenrolledStaff(query)
      .then((rows) => {
        if (!cancelled) setUnenrolled(rows);
      })
      .catch((e) => {
        if (!cancelled) {
          setUnenrolledError(e instanceof Error ? e.message : 'Failed to load candidates');
        }
      })
      .finally(() => {
        if (!cancelled) setUnenrolledLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, query]);

  const positionTitleById = useMemo(
    () => Object.fromEntries(positions.map((p) => [p.id, p.title])) as Record<string, string>,
    [positions],
  );

  const departmentOptions = useMemo(() => {
    const names = new Set<string>();
    staff.forEach((s) => {
      const name = s.current_assignment?.department_name;
      if (name) names.add(name);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [staff]);

  const activeCount = useMemo(() => staff.filter((s) => s.status === 'active').length, [staff]);
  const exitedCount = useMemo(() => staff.filter((s) => s.status !== 'active').length, [staff]);

  const peopleBase = useMemo(() => {
    const q = query.trim().toLowerCase();
    return staff.filter((s) => {
      if (s.status !== 'active') return false;
      if (
        departmentFilter !== '__all__' &&
        (s.current_assignment?.department_name ?? '') !== departmentFilter
      ) {
        return false;
      }
      if (!q) return true;
      return [s.full_name, s.staff_number, s.phone, s.email]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [staff, query, departmentFilter]);

  const exitedBase = useMemo(() => {
    const q = query.trim().toLowerCase();
    return staff.filter((s) => {
      if (s.status === 'active') return false;
      if (
        departmentFilter !== '__all__' &&
        (s.current_assignment?.department_name ?? '') !== departmentFilter
      ) {
        return false;
      }
      if (!q) return true;
      return [s.full_name, s.staff_number, s.phone, s.email]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [staff, query, departmentFilter]);

  const noAssignmentCount = useMemo(
    () => peopleBase.filter((s) => !(assignments[s.id]?.length)).length,
    [peopleBase, assignments]
  );

  const departmentCount = useMemo(
    () => departments.length,
    [departments]
  );

  const positionCount = useMemo(() => positions.length, [positions]);

  const visibleStaff = useMemo(() => {
    if (tab === 'unenrolled') return [];
    const base = tab === 'people' ? peopleBase : exitedBase;
    if (tab === 'people' && filterNoAssignment) {
      return base.filter((s) => !(assignments[s.id]?.length));
    }
    return base;
  }, [tab, peopleBase, exitedBase, filterNoAssignment, assignments]);

  const exportCsv = useCallback(() => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const hasExited = visibleStaff.some((s) => s.ended_on);
    const headers = [
      'Staff ref',
      'Name',
      'Position',
      'Department',
      'Reports to',
      'Email',
      'Phone',
      ...(hasExited ? ['Exited on'] : []),
    ];
    const lines = [headers.map(esc).join(',')];
    for (const s of visibleStaff) {
      const rows = assignments[s.id] ?? [];
      const primary = rows.find((a) => a.is_primary) ?? rows[0];
      const reportsTo = s.current_assignment?.manager_employee_id
        ? positionTitleById[s.current_assignment.manager_employee_id] ?? ''
        : '';
      lines.push(
        [
          s.staff_number,
          s.full_name,
          primary?.position_title ?? '',
          primary?.department_name ?? '',
          reportsTo,
          s.email,
          s.phone,
          ...(hasExited
            ? [
                s.ended_on
                  ? new Date(s.ended_on).toLocaleDateString('en-GB', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                    })
                  : '',
              ]
            : []),
        ].map(esc).join(','),
      );
    }
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const filename = `staff-directory-${new Date().toISOString().slice(0, 10)}.csv`;
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // Bulk export of the entire staff directory -- emails, phones, org
    // structure -- not logged before this. Plain client-side insert so the
    // audit_logs IP-capture trigger sees the real browser IP directly.
    // Never blocks the actual download.
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        await supabase.from('audit_logs').insert({
          user_id: user?.id ?? null,
          action_type: 'csv_exported',
          table_name: 'export',
          record_id: null,
          metadata: { filename, staff_count: visibleStaff.length },
        });
      } catch (e) {
        console.warn('[StaffDirectory] audit log insert failed:', e);
      }
    })();
  }, [visibleStaff, assignments, positionTitleById]);


  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-6 text-sm">
        <button
          type="button"
          onClick={() => setFilterNoAssignment((v) => !v)}
          className={`leading-tight text-left ${
            filterNoAssignment ? 'font-semibold underline' : ''
          } ${noAssignmentCount > 0 ? 'text-warning' : 'text-muted-foreground'}`}
        >
          <div className="text-base font-semibold tabular-nums">{noAssignmentCount}</div>
          <div className="text-xs">No assignment</div>
        </button>
        <div className={`leading-tight ${departmentCount === 0 ? 'text-muted-foreground' : ''}`}>
          <div className="text-base font-semibold tabular-nums">{departmentCount}</div>
          <div className="text-xs text-muted-foreground">Departments</div>
        </div>
        <div className={`leading-tight ${positionCount === 0 ? 'text-muted-foreground' : ''}`}>
          <div className="text-base font-semibold tabular-nums">{positionCount}</div>
          <div className="text-xs text-muted-foreground">Positions</div>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>

        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="people">People ({activeCount})</TabsTrigger>
          <TabsTrigger value="exited">Exited ({exitedCount})</TabsTrigger>
          <TabsTrigger value="unenrolled">
            Not enrolled ({unenrolledLoading ? '—' : unenrolled.length})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, staff ref, phone or email"
          className="h-9 w-full sm:max-w-xs"
        />
        <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
          <SelectTrigger className="h-9 w-full sm:w-52">
            <SelectValue placeholder="All departments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All departments</SelectItem>
            {departmentOptions.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" className="sm:ml-auto" onClick={() => setOpen(true)}>
          <UserPlus className="h-4 w-4 mr-2" />
          Enroll staff member
        </Button>
        <Button size="sm" variant="outline" onClick={exportCsv}>
          <Download className="h-4 w-4 mr-2" />
          Export CSV
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {tab === 'unenrolled' ? (
            unenrolledLoading ? (
              <div className="p-6 text-sm text-muted-foreground">Loading</div>
            ) : unenrolledError ? (
              <div className="p-6 text-sm text-destructive flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                {unenrolledError}
              </div>
            ) : unenrolled.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">
                Everyone with staff access is enrolled.
              </div>
            ) : (
              <div className="divide-y">
                {unenrolled.map((c) => (
                  <div key={c.user_id} className="flex items-center justify-between p-4">
                    <div>
                      <div className="font-medium">{c.display_name}</div>
                      <div className="text-sm text-muted-foreground">{c.staff_roles}</div>
                    </div>
                    <Button size="sm" onClick={() => setEnrollCandidate(c)}>
                      Enroll
                    </Button>
                  </div>
                ))}
              </div>
            )
          ) : loading ? (
            <div className="p-4 space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : loadError ? (
            <div className="p-6 text-sm text-destructive flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              {loadError}
            </div>
          ) : staff.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No one is enrolled in performance tracking yet.
            </div>
          ) : visibleStaff.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No staff match that search.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead className="whitespace-nowrap">
                      Person{' '}
                      <span className="text-[10px] font-normal text-muted-foreground tabular-nums">
                        ({visibleStaff.length})
                      </span>
                    </TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Reports to</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleStaff.map((s) => {
                    const rows = assignments[s.id] ?? [];
                    const isOpen = expanded[s.id] === true;
                    return (
                      <Fragment key={s.id}>
                        <TableRow>
                          <TableCell className="pr-0">
                            <button
                              type="button"
                              aria-label={isOpen ? 'Hide positions' : 'Show positions'}
                              aria-expanded={isOpen}
                              onClick={() =>
                                setExpanded((prev) => ({ ...prev, [s.id]: !prev[s.id] }))
                              }
                              className="text-muted-foreground hover:text-foreground"
                            >
                              {isOpen ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </button>
                          </TableCell>
                          <TableCell>
                            <div className="font-medium">{s.full_name || '—'}</div>
                            <div className="font-mono text-xs text-muted-foreground">
                              {s.staff_number || '—'}
                            </div>
                            {s.ended_on && (
                              <div className="text-xs text-destructive mt-0.5">
                                Exited on{' '}
                                {new Date(s.ended_on).toLocaleDateString('en-GB', {
                                  day: '2-digit',
                                  month: 'short',
                                  year: 'numeric',
                                })}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <div>{rows.find((a) => a.is_primary)?.position_title || rows[0]?.position_title || '—'}</div>
                            <div className="text-xs text-muted-foreground">
                              {rows.find((a) => a.is_primary)?.department_name || rows[0]?.department_name || '—'}
                              {rows.length > 1 && (
                                <span className="ml-1">+{rows.length - 1}</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            {s.current_assignment?.manager_employee_id
                              ? positionTitleById[s.current_assignment.manager_employee_id] ?? '—'
                              : '—'}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className="text-xs break-all">
                                {s.email || '—'}
                              </span>
                              {s.phone ? (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 shrink-0"
                                  title="Copy phone"
                                  onClick={() => {
                                    void navigator.clipboard.writeText(s.phone);
                                    toast.success('Phone copied');
                                  }}
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </Button>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Row actions">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  disabled={!(s as unknown as { user_id?: string }).user_id}
                                  onClick={() => {
                                    const uid = (s as unknown as { user_id?: string }).user_id;
                                    if (uid) navigate(`/hr/profiles/${uid}`);
                                  }}
                                >
                                  Open profile
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setAddFor(s)}>
                                  <Plus className="h-3.5 w-3.5 mr-2" />
                                  Add position
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => navigate('/platform-users')}>
                                  Manage access
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setTransferFor(s)}>
                                  Transfer position
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setDeptChangeFor(s)}>
                                  Change department
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  disabled={rows.length === 0}
                                  onClick={() => setRemoveFor(s)}
                                >
                                  <Trash2 className="h-3.5 w-3.5 mr-2" />
                                  Remove position / department
                                </DropdownMenuItem>
                                {s.status === 'active' ? (
                                  <DropdownMenuItem
                                    className="text-destructive focus:text-destructive"
                                    onClick={() => setExitFor(s)}
                                  >
                                    <AlertTriangle className="h-3.5 w-3.5 mr-2" />
                                    Exit staff member
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem onClick={() => setReinstateFor(s)}>
                                    <UserPlus className="h-3.5 w-3.5 mr-2" />
                                    Reinstate staff member
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell />
                            <TableCell colSpan={5} className="py-3">
                              {rows.length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                  No active positions for this person yet.
                                </p>
                              ) : (
                                <div className="overflow-x-auto">
                                  <table className="w-full text-sm">
                                    <thead>
                                      <tr className="text-xs uppercase text-muted-foreground">
                                        <th className="text-left font-medium py-1 pr-4">Position</th>
                                        <th className="text-left font-medium py-1 pr-4">Department</th>
                                        <th className="text-left font-medium py-1 pr-4">Reports to</th>
                                        <th className="text-left font-medium py-1 pr-4">Started on</th>
                                        <th className="text-left font-medium py-1">Primary</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {rows.map((a) => (
                                        <tr key={a.id} className="border-t border-border/40">
                                          <td className="py-1.5 pr-4">{a.position_title || '—'}</td>
                                          <td className="py-1.5 pr-4">{a.department_name || '—'}</td>
                                          <td className="py-1.5 pr-4">{a.reports_to_title || '—'}</td>
                                          <td className="py-1.5 pr-4">{a.started_on}</td>
                                          <td className="py-1.5">
                                            {a.is_primary ? (
                                              <Badge>Primary</Badge>
                                            ) : (
                                              <span className="text-muted-foreground">—</span>
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <EnrollDialog
        open={open || enrollCandidate !== null}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setEnrollCandidate(null);
        }}
        onEnrolled={() => void load()}
        initialCandidate={enrollCandidate ?? undefined}
      />

      <AddAssignmentDialog
        staff={addFor}
        onOpenChange={(v) => {
          if (!v) setAddFor(null);
        }}
        onAdded={() => void load()}
      />

      <TransferPositionDialog
        staff={transferFor}
        assignments={transferFor ? (assignments[transferFor.id] ?? []) : []}
        allStaff={staff}
        onOpenChange={(v) => {
          if (!v) setTransferFor(null);
        }}
        onDone={() => void load()}
      />

      <ChangeDepartmentDialog
        staff={deptChangeFor}
        assignments={deptChangeFor ? (assignments[deptChangeFor.id] ?? []) : []}
        departments={departments}
        onOpenChange={(v) => {
          if (!v) setDeptChangeFor(null);
        }}
        onDone={() => void load()}
      />

      <RemoveAssignmentDialog
        staff={removeFor}
        assignments={removeFor ? (assignments[removeFor.id] ?? []) : []}
        onOpenChange={(v) => {
          if (!v) setRemoveFor(null);
        }}
        onDone={() => void load()}
      />

      <ExitStaffDialog
        staff={exitFor}
        onOpenChange={(v) => {
          if (!v) setExitFor(null);
        }}
        onDone={() => void load()}
      />

      <ReinstateStaffDialog
        staff={reinstateFor}
        onOpenChange={(v) => {
          if (!v) setReinstateFor(null);
        }}
        onDone={() => void load()}
      />
    </div>
  );
}

/**
 * Exits a staff member from HR. Exiting removes them from all future payroll
 * runs, so the dialog warns that any period they worked must be settled
 * before their final run is calculated.
 */
function ExitStaffDialog({
  staff,
  onOpenChange,
  onDone,
}: {
  staff: Employee | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const open = staff !== null;
  const [endedOn, setEndedOn] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEndedOn(new Date().toISOString().slice(0, 10));
    setReason('');
    setError(null);
  }, [open, staff?.id]);

  const handleConfirm = async () => {
    if (!staff) return;
    if (reason.trim().length < 10) return;
    setSaving(true);
    setError(null);
    try {
      await exitStaff({ staffId: staff.id, endedOn, reason });
      toast.success('Staff member exited');
      onOpenChange(false);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Exit failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Exit staff member</DialogTitle>
          <DialogDescription>
            Exiting removes this staff member from all future payroll runs. Any period
            they worked must be settled before their final run is calculated.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="exit-ended-on">Last working day</Label>
            <Input
              id="exit-ended-on"
              type="date"
              value={endedOn}
              onChange={(e) => setEndedOn(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exit-reason">Reason (at least 10 characters)</Label>
            <Textarea
              id="exit-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this staff member exiting?"
              rows={3}
            />
          </div>
          {error && (
            <div className="text-sm text-destructive flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void handleConfirm()}
            disabled={saving || reason.trim().length < 10}
          >
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Confirm exit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Reinstates an exited staff member, under the same 10-character reason rule. */
function ReinstateStaffDialog({
  staff,
  onOpenChange,
  onDone,
}: {
  staff: Employee | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const open = staff !== null;
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setReason('');
    setError(null);
  }, [open, staff?.id]);

  const handleConfirm = async () => {
    if (!staff) return;
    if (reason.trim().length < 10) return;
    setSaving(true);
    setError(null);
    try {
      await reinstateStaff({ staffId: staff.id, reason });
      toast.success('Staff member reinstated');
      onOpenChange(false);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reinstatement failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reinstate staff member</DialogTitle>
          <DialogDescription>
            Reinstating returns this staff member to the active directory.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="reinstate-reason">Reason (at least 10 characters)</Label>
            <Textarea
              id="reinstate-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this staff member being reinstated?"
              rows={3}
            />
          </div>
          {error && (
            <div className="text-sm text-destructive flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleConfirm()}
            disabled={saving || reason.trim().length < 10}
          >
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Confirm reinstatement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Removes one existing position (and with it, that department placement) from
 * a staff member. The assignment row is closed, not deleted, so payroll and
 * historical reporting for past periods stay intact.
 */
function RemoveAssignmentDialog({
  staff,
  assignments,
  onOpenChange,
  onDone,
}: {
  staff: Employee | null;
  assignments: ActiveAssignment[];
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const open = staff !== null;
  const [assignmentId, setAssignmentId] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAssignmentId(assignments.length === 1 ? assignments[0].id : '');
    setReason('');
    setError(null);
  }, [open, assignments]);

  const selected = assignments.find((a) => a.id === assignmentId) ?? null;
  const reasonOk = reason.trim().length >= 10;

  async function submit() {
    if (!assignmentId || !reasonOk) return;
    setSaving(true);
    setError(null);
    try {
      await endAssignment({ assignmentId, reason: reason.trim() });
      toast.success('Position and department removed');
      onOpenChange(false);
      onDone();
    } catch (e) {
      setError(readableError(e, 'Removing the position'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove position / department</DialogTitle>
          <DialogDescription>
            {staff?.full_name
              ? `Closes one of ${staff.full_name}'s active positions. The record is kept for history — it is not deleted.`
              : 'Closes one active position. The record is kept for history.'}
          </DialogDescription>
        </DialogHeader>

        {assignments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This person has no active position to remove.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Position to remove</Label>
              <Select value={assignmentId} onValueChange={setAssignmentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a position" />
                </SelectTrigger>
                <SelectContent>
                  {assignments.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.position_title || 'Untitled'} — {a.department_name || 'No department'}
                      {a.is_primary ? ' (primary)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selected?.is_primary && assignments.length > 1 && (
              <p className="text-xs text-muted-foreground">
                This is the primary position. After removing it, set another position as primary.
              </p>
            )}
            {selected && assignments.length === 1 && (
              <p className="text-xs text-muted-foreground">
                This is their only position, so they will be left with no role or department until a
                new one is added.
              </p>
            )}

            <div className="space-y-2">
              <Label>Reason (at least 10 characters)</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this position being removed?"
                rows={3}
              />
            </div>

            {error && (
              <p className="text-sm text-destructive flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void submit()}
            disabled={saving || !assignmentId || !reasonOk}
          >
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TransferPositionDialog({
  staff,
  assignments,
  allStaff,
  onOpenChange,
  onDone,
}: {
  staff: Employee | null;
  assignments: ActiveAssignment[];
  allStaff: Employee[];
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const open = staff !== null;
  const [assignmentId, setAssignmentId] = useState('');
  const [toStaffId, setToStaffId] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAssignmentId(assignments.length === 1 ? assignments[0].id : '');
    setToStaffId('');
    setReason('');
    setError(null);
  }, [open, staff?.id]);

  const destinations = allStaff.filter((s) => s.id !== staff?.id && s.status === 'active');
  const canSave = !!assignmentId && !!toStaffId && reason.trim().length >= 10 && !saving;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await transferPosition({
        fromAssignmentId: assignmentId,
        toStaffId,
        reason: reason.trim(),
      });
      toast.success('Position transferred');
      onOpenChange(false);
      onDone();
    } catch (e) {
      // Show the database message verbatim — one of them explains that the
      // destination position already has an open holder.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Transfer position</DialogTitle>
          <DialogDescription>
            Hands one of {staff?.full_name || 'this person'}&apos;s open positions to another
            enrolled staff member.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Position to transfer</Label>
            {assignments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This person has no open positions to transfer.
              </p>
            ) : (
              <Select value={assignmentId} onValueChange={setAssignmentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a position" />
                </SelectTrigger>
                <SelectContent>
                  {assignments.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {(a.position_title || 'Untitled position') +
                        (a.department_name ? ` · ${a.department_name}` : '')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Transfer to</Label>
            <Select value={toStaffId} onValueChange={setToStaffId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a staff member" />
              </SelectTrigger>
              <SelectContent>
                {destinations.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.full_name || s.staff_number || s.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Reason</Label>
            <Textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this position moving? At least 10 characters."
            />
            <p className="text-[11px] text-muted-foreground">{reason.trim().length}/10</p>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          {error && <p className="w-full text-xs text-destructive whitespace-pre-wrap">{error}</p>}
          <Button className="w-full" disabled={!canSave} onClick={() => void submit()}>
            {saving ? 'Transferring…' : 'Transfer position'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChangeDepartmentDialog({
  staff,
  assignments,
  departments,
  onOpenChange,
  onDone,
}: {
  staff: Employee | null;
  assignments: ActiveAssignment[];
  departments: Department[];
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const open = staff !== null;
  /**
   * Encoded choice, because the box lists two different kinds of thing:
   *   `assign:<assignmentId>`  — a position this person already holds; moving it
   *                              re-parents the existing assignment (history kept).
   *   `pos:<positionId>`       — any other active position in the system; picking
   *                              it opens a NEW assignment in the chosen department.
   * Previously only held assignments were listed, so a person enrolled with a
   * single position saw exactly one option and the rest of the catalogue was
   * invisible here.
   */
  const [choice, setChoice] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackDepartments, setFallbackDepartments] = useState<Department[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setChoice(assignments.length === 1 ? `assign:${assignments[0].id}` : '');
    setDepartmentId('');
    setReason('');
    setError(null);
  }, [open, staff?.id]);

  useEffect(() => {
    if (!open || departments.length > 0) return;
    getDepartments()
      .then(setFallbackDepartments)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [open, departments.length]);

  // Every active position in the system, so the box is never limited to what
  // this person happens to hold today.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPositionsLoading(true);
    getPositions()
      .then((rows) => { if (!cancelled) setPositions(rows); })
      .catch((e) => { if (!cancelled) setError(readableError(e, 'Loading positions')); })
      .finally(() => { if (!cancelled) setPositionsLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const departmentOptions = departments.length > 0 ? departments : fallbackDepartments;
  const heldPositionIds = useMemo(
    () => new Set(assignments.map((a) => a.position_title)),
    [assignments],
  );
  /** Catalogue positions this person does not already hold. */
  const otherPositions = useMemo(
    () => positions.filter((p) => !heldPositionIds.has(p.title)),
    [positions, heldPositionIds],
  );
  const isNewAssignment = choice.startsWith('pos:');
  const canSave = !!choice && !!departmentId && reason.trim().length >= 10 && !saving;

  const submit = async () => {
    if (!canSave || !staff) return;
    setSaving(true);
    setError(null);
    try {
      if (isNewAssignment) {
        await addAssignment({
          staffId: staff.id,
          departmentId,
          positionId: choice.slice('pos:'.length),
          makePrimary: assignments.length === 0,
        });
        toast.success('Position added in the chosen department');
      } else {
        await changeDepartment({
          assignmentId: choice.slice('assign:'.length),
          departmentId,
          reason: reason.trim(),
        });
        toast.success('Department changed');
      }
      onOpenChange(false);
      onDone();
    } catch (e) {
      setError(readableError(e, isNewAssignment ? 'Adding the position' : 'Changing the department'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Change department</DialogTitle>
          <DialogDescription>
            Moves one of {staff?.full_name || 'this person'}&apos;s open positions to another
            department — or opens one of the other positions in the system for them in the
            department you pick.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Position</Label>
            <Select value={choice} onValueChange={setChoice}>
              <SelectTrigger>
                <SelectValue
                  placeholder={positionsLoading ? 'Loading positions…' : 'Select a position'}
                />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {assignments.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Positions they hold now</SelectLabel>
                    {assignments.map((a) => (
                      <SelectItem key={a.id} value={`assign:${a.id}`}>
                        {(a.position_title || 'Untitled position') +
                          (a.department_name ? ` · ${a.department_name}` : '')}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {otherPositions.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Other positions in the system</SelectLabel>
                    {otherPositions.map((p) => (
                      <SelectItem key={p.id} value={`pos:${p.id}`}>
                        {p.title}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {!positionsLoading && assignments.length === 0 && otherPositions.length === 0 && (
                  <div className="px-2 py-3 text-sm text-muted-foreground">
                    No positions exist yet. Add one from the Enroll or Add position screen first.
                  </div>
                )}
              </SelectContent>
            </Select>
            {isNewAssignment && (
              <p className="text-[11px] text-muted-foreground">
                They do not hold this position yet — saving opens it for them, starting today.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">New department</Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a department" />
              </SelectTrigger>
              <SelectContent>
                {departmentOptions.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Reason</Label>
            <Textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this position changing department? At least 10 characters."
            />
            <p className="text-[11px] text-muted-foreground">{reason.trim().length}/10</p>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          {error && <p className="w-full text-xs text-destructive whitespace-pre-wrap">{error}</p>}
          <Button className="w-full" disabled={!canSave} onClick={() => void submit()}>
            {saving ? 'Saving…' : isNewAssignment ? 'Add position in this department' : 'Change department'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddAssignmentDialog({
  staff,
  onOpenChange,
  onAdded,
}: {
  staff: Employee | null;
  onOpenChange: (v: boolean) => void;
  onAdded: () => void;
}) {
  const open = staff !== null;
  const [departments, setDepartments] = useState<Department[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [departmentId, setDepartmentId] = useState('');
  const [positionId, setPositionId] = useState('');
  const [reportsTo, setReportsTo] = useState<string>(NONE);
  const [makePrimary, setMakePrimary] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDepartmentId('');
    setPositionId('');
    setReportsTo(NONE);
    setMakePrimary(false);
    setError(null);
    Promise.all([getDepartments(), getPositions()])
      .then(([d, p]) => {
        setDepartments(d);
        setPositions(p);
      })
      .catch((e) => setError(readableError(e, 'Loading departments and positions')));
  }, [open]);

  const canSave = Boolean(departmentId && positionId) && !saving;

  const handleSave = async () => {
    if (!staff) return;
    setSaving(true);
    setError(null);
    try {
      await addAssignment({
        staffId: staff.id,
        departmentId,
        positionId,
        reportsToPositionId: reportsTo === NONE ? null : reportsTo,
        makePrimary,
      });
      toast.success('Position added');
      onOpenChange(false);
      onAdded();
    } catch (e) {
      setError(readableError(e, 'Adding the position'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add position</DialogTitle>
          <DialogDescription>
            Gives {staff?.full_name || 'this person'} a further active position, starting today.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Department</Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger>
                <SelectValue placeholder="Select department" />
              </SelectTrigger>
              <SelectContent>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Position</Label>
            <Select value={positionId} onValueChange={setPositionId}>
              <SelectTrigger>
                <SelectValue placeholder="Select position" />
              </SelectTrigger>
              <SelectContent>
                {positions.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Reports to (optional)</Label>
            <Select value={reportsTo} onValueChange={setReportsTo}>
              <SelectTrigger>
                <SelectValue placeholder="No manager" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No manager</SelectItem>
                {positions.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Any active position can be the reporting line, including one in another department.
            </p>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="make-primary"
              checked={makePrimary}
              onCheckedChange={(v) => setMakePrimary(v === true)}
            />
            <div>
              <Label htmlFor="make-primary" className="cursor-pointer">
                Make this their primary position
              </Label>
              <p className="text-xs text-muted-foreground">
                The primary position decides which department their metrics roll up to.
              </p>
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive flex gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Add position
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EnrollDialog({
  open,
  onOpenChange,
  onEnrolled,
  initialCandidate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onEnrolled: () => void;
  initialCandidate?: UnenrolledStaffCandidate;
}) {
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<UnenrolledStaffCandidate[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [userId, setUserId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [positionId, setPositionId] = useState('');
  const [reportsTo, setReportsTo] = useState<string>(NONE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addPositionOpen, setAddPositionOpen] = useState(false);
  const [addDepartmentOpen, setAddDepartmentOpen] = useState(false);

  const loadDepartments = useCallback(async () => {
    try {
      setDepartments(await getDepartments());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load departments');
    }
  }, []);

  const loadPositions = useCallback(async () => {
    try {
      setPositions(await getPositions());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load positions');
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    getDepartments()
      .then(setDepartments)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load departments'));
    void loadPositions();
  }, [open, loadPositions]);

  useEffect(() => {
    if (!open || !initialCandidate) return;
    setUsers([initialCandidate]);
    setUserId(initialCandidate.user_id);
    setSearchError(null);
  }, [open, initialCandidate]);

  useEffect(() => {
    if (!open) return;
    const term = search.trim();
    setSearchError(null);
    if (term.length < 2) {
      setUsers([]);
      setUsersLoading(false);
      return;
    }
    let cancelled = false;
    setUsersLoading(true);
    const t = setTimeout(() => {
      searchUnenrolledStaff(term)
        .then((rows) => {
          if (!cancelled) setUsers(rows);
        })
        .catch((e) => {
          if (!cancelled) {
            setUsers([]);
            setSearchError(e instanceof Error ? e.message : 'Search failed');
          }
        })
        .finally(() => {
          if (!cancelled) setUsersLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, search]);

  const reset = () => {
    setSearch('');
    setUsers([]);
    setSearchError(null);
    setUserId('');
    setDepartmentId('');
    setPositionId('');
    setReportsTo(NONE);
    setError(null);
  };

  const selectedUser = users.find((u) => u.user_id === userId);
  const missing: string[] = [];
  if (!userId) missing.push('a platform user');
  if (!departmentId) missing.push('a department');
  if (!positionId) missing.push('a position');
  const canSave = missing.length === 0 && !saving;
  const disabledReason =
    missing.length === 0
      ? null
      : `Select ${
          missing.length === 1
            ? missing[0]
            : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`
        } to continue.`;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await enrollStaff({
        userId,
        departmentId,
        positionId,
        reportsToPositionId: reportsTo === NONE ? null : reportsTo,
        startedOn: new Date().toISOString().slice(0, 10),
      });
      toast.success('Staff member enrolled');
      reset();
      onOpenChange(false);
      onEnrolled();
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const denied =
        /row-level security|permission denied|not authorized|violates row/i.test(raw);
      setError(
        denied
          ? 'Enrollment was refused by the database. Enrolling staff requires the hr or super_admin role.'
          : `Enrollment failed: ${raw}`,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Enroll staff member</DialogTitle>
          <DialogDescription>
            Adds one staff record and an opening assignment starting today.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Platform user</Label>
            <Input
              placeholder="Search by name, email or phone"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="border rounded-md max-h-52 overflow-y-auto divide-y">
              {searchError ? (
                <div className="p-3 text-sm text-destructive flex gap-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{searchError}</span>
                </div>
              ) : search.trim().length < 2 ? (
                <div className="p-3 text-sm text-muted-foreground">
                  Type at least 2 characters to search.
                </div>
              ) : usersLoading ? (
                <div className="p-3 text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Searching...
                </div>
              ) : users.length === 0 ? (
                <div className="p-3 text-sm text-muted-foreground">
                  No unenrolled users match this search.
                </div>
              ) : (
                users.map((u) => (
                  <button
                    key={u.user_id}
                    type="button"
                    onClick={() => setUserId(u.user_id)}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-muted ${
                      userId === u.user_id ? 'bg-muted' : ''
                    }`}
                  >
                    <div className="font-medium">{u.display_name}</div>
                    <div className="text-xs text-muted-foreground">{u.staff_roles || '—'}</div>
                  </button>
                ))
              )}
            </div>
            {selectedUser && (
              <p className="text-xs text-muted-foreground">Selected: {selectedUser.display_name}</p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Department</Label>
              <button
                type="button"
                onClick={() => setAddDepartmentOpen(true)}
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
              >
                <Plus className="h-3 w-3" /> Add department
              </button>
            </div>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger>
                <SelectValue placeholder="Select department" />
              </SelectTrigger>
              <SelectContent>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Position</Label>
              <button
                type="button"
                onClick={() => setAddPositionOpen(true)}
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
              >
                <Plus className="h-3 w-3" /> Add position
              </button>
            </div>
            <Select value={positionId} onValueChange={setPositionId}>
              <SelectTrigger>
                <SelectValue placeholder="Select position" />
              </SelectTrigger>
              <SelectContent>
                {positions.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Reports to (optional)</Label>
            <Select value={reportsTo} onValueChange={setReportsTo}>
              <SelectTrigger>
                <SelectValue placeholder="No manager" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No manager</SelectItem>
                {positions.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive flex gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="space-y-2">
          {disabledReason && (
            <p className="text-xs text-muted-foreground text-right">{disabledReason}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={!canSave}
              aria-disabled={!canSave}
              title={disabledReason ?? undefined}
              className={!canSave ? 'opacity-50 cursor-not-allowed pointer-events-none' : undefined}
            >
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Enroll
            </Button>
          </DialogFooter>
        </div>

        <AddPositionDialog
          open={addPositionOpen}
          onOpenChange={setAddPositionOpen}
          departments={departments}
          onCreated={async (created) => {
            await loadPositions();
            setPositionId(created.id);
          }}
        />

        <AddDepartmentDialog
          open={addDepartmentOpen}
          onOpenChange={setAddDepartmentOpen}
          onCreated={async (created) => {
            await loadDepartments();
            setDepartmentId(created.id);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function AddDepartmentDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (created: Department) => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'output' | 'time'>('output');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName('');
    setMode('output');
    setError(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const created = await createDepartment({ name: name.trim(), measurementMode: mode });
      toast.success('Department added');
      await onCreated(created);
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add department');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add department</DialogTitle>
          <DialogDescription>
            Departments group postings and set how work is measured.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              placeholder="e.g. Field Operations"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Measured by</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as 'output' | 'time')}>
              <SelectTrigger>
                <SelectValue placeholder="Select measurement" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="output">Output — tasks and deliverables</SelectItem>
                <SelectItem value="time">Time — hours, shifts and attendance</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive flex gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={name.trim().length < 2 || saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddPositionDialog({
  open,
  onOpenChange,
  departments,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  departments: Department[];
  onCreated: (created: Position) => void | Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [departmentId, setDepartmentId] = useState<string>(NONE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle('');
    setDepartmentId(NONE);
    setError(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const created = await createPosition({
        title: title.trim(),
        departmentId: departmentId === NONE ? null : departmentId,
      });
      toast.success('Position added');
      await onCreated(created);
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add position');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add position</DialogTitle>
          <DialogDescription>Positions carry reporting lines, not people.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Title</Label>
            <Input
              placeholder="e.g. Field Operations Officer"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Department (optional)</Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger>
                <SelectValue placeholder="No department" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No department</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive flex gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={title.trim().length < 2 || saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
