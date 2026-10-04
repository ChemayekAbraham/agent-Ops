import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ChevronDown, ChevronRight, Plus, Pencil, ArrowRightLeft, Ban, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import {
  useHRPositions,
  slugifyPositionKey,
  isProtectedTitle,
  PROTECTED_TITLE_KEY,
  PROTECTED_TITLE_MESSAGE,
  MIN_REASON_LENGTH,
  type HRPositionRow,
} from '@/hooks/useHRPositions';

const UNASSIGNED = '__unassigned__';

const ReasonField = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
  <div>
    <Label>Reason (min {MIN_REASON_LENGTH} characters)</Label>
    <Textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder="Why is this change being made?"
      className="min-h-[60px]"
    />
    <p className="text-[10px] text-muted-foreground mt-1">{value.trim().length}/{MIN_REASON_LENGTH}</p>
  </div>
);


export default function HRRolesPanel() {
  const {
    positions,
    departments,
    heldBy,
    accessByPosition,
    isLoading,
    addPosition,
    renamePosition,
    movePosition,
    setPositionActive,
  } = useHRPositions();

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [addFor, setAddFor] = useState<string | null>(null);
  const [addTitle, setAddTitle] = useState('');
  const [editRole, setEditRole] = useState<HRPositionRow | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [moveRole, setMoveRole] = useState<HRPositionRow | null>(null);
  const [moveTarget, setMoveTarget] = useState<string>(UNASSIGNED);
  const [deactivateRole, setDeactivateRole] = useState<HRPositionRow | null>(null);
  const [reactivateRole, setReactivateRole] = useState<HRPositionRow | null>(null);
  const [addReason, setAddReason] = useState('');
  const [editReason, setEditReason] = useState('');
  const [moveReason, setMoveReason] = useState('');
  const [statusReason, setStatusReason] = useState('');

  const reasonOk = (value: string) => value.trim().length >= MIN_REASON_LENGTH;

  const editProtected = !!editRole && (editRole.key === PROTECTED_TITLE_KEY || isProtectedTitle(editRole.title));
  const editTargetProtected = isProtectedTitle(editTitle);
  const addTargetProtected = isProtectedTitle(addTitle);

  const grouped = useMemo(() => {
    const map: Record<string, HRPositionRow[]> = { [UNASSIGNED]: [] };
    departments.forEach(d => {
      map[d.id] = [];
    });
    positions.forEach(p => {
      const key = p.department_id || UNASSIGNED;
      map[key] = map[key] || [];
      map[key].push(p);
    });
    return map;
  }, [positions, departments]);

  const toggle = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  const submitAdd = () => {
    const departmentId = addFor === UNASSIGNED ? null : addFor;
    addPosition.mutate(
      { title: addTitle, departmentId, reason: addReason },
      {
        onSuccess: () => {
          toast.success('Role added');
          setAddFor(null);
          setAddTitle('');
          setAddReason('');
        },
        onError: (err: any) => toast.error(err.message),
      },
    );
  };

  const submitEdit = () => {
    if (!editRole) return;
    renamePosition.mutate(
      {
        id: editRole.id,
        title: editTitle,
        currentKey: editRole.key,
        currentTitle: editRole.title,
        reason: editReason,
      },
      {
        onSuccess: () => {
          toast.success('Role title updated');
          setEditRole(null);
          setEditReason('');
        },
        onError: (err: any) => toast.error(err.message),
      },
    );
  };

  const submitMove = () => {
    if (!moveRole) return;
    movePosition.mutate(
      { id: moveRole.id, departmentId: moveTarget === UNASSIGNED ? null : moveTarget, reason: moveReason },
      {
        onSuccess: () => {
          toast.success('Role moved');
          setMoveRole(null);
          setMoveReason('');
        },
        onError: (err: any) => toast.error(err.message),
      },
    );
  };

  const submitDeactivate = () => {
    if (!deactivateRole) return;
    const held = heldBy[deactivateRole.id] || 0;
    setPositionActive.mutate(
      { id: deactivateRole.id, active: false, heldBy: held, reason: statusReason },
      {
        onSuccess: () => {
          toast.success('Role deactivated');
          setDeactivateRole(null);
          setStatusReason('');
        },
        onError: (err: any) => toast.error(err.message),
      },
    );
  };

  const submitReactivate = () => {
    if (!reactivateRole) return;
    setPositionActive.mutate(
      { id: reactivateRole.id, active: true, heldBy: heldBy[reactivateRole.id] || 0, reason: statusReason },
      {
        onSuccess: () => {
          toast.success('Role reactivated');
          setReactivateRole(null);
          setStatusReason('');
        },
        onError: (err: any) => toast.error(err.message),
      },
    );
  };

  const renderRole = (role: HRPositionRow) => {
    const held = heldBy[role.id] || 0;
    const bindings = accessByPosition[role.id] || [];
    return (
      <div key={role.id} className="rounded-lg border border-border/60 p-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{role.title}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Held by {held} {held === 1 ? 'person' : 'people'}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {!role.active && (
              <Badge variant="destructive" className="text-[10px]">Inactive</Badge>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => {
                setEditRole(role);
                setEditTitle(role.title);
                setEditReason('');
              }}
            >
              <Pencil className="h-3 w-3" /> Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => {
                setMoveRole(role);
                setMoveTarget(role.department_id || UNASSIGNED);
                setMoveReason('');
              }}
            >
              <ArrowRightLeft className="h-3 w-3" /> Move
            </Button>
            {role.active ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-[11px] text-destructive"
                onClick={() => { setStatusReason(''); setDeactivateRole(role); }}
              >
                <Ban className="h-3 w-3" /> Deactivate
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-[11px] text-success"
                onClick={() => { setStatusReason(''); setReactivateRole(role); }}
              >
                <RotateCcw className="h-3 w-3" /> Reactivate
              </Button>
            )}
          </div>
        </div>
        {bindings.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Grants on assignment
            </p>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {bindings.map((b, i) => (
                <Badge key={`${role.id}-${i}`} variant="secondary" className="text-[10px] font-normal">
                  {b.dashboard_key} · {b.role}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderGroup = (groupKey: string, label: string, roles: HRPositionRow[]) => {
    const isOpen = expanded[groupKey] ?? true;
    return (
      <div key={groupKey} className="rounded-lg border border-border overflow-hidden">
        <div className="flex items-center justify-between gap-2 bg-muted/30 px-3 py-2">
          <button
            type="button"
            className="flex items-center gap-2 text-left min-w-0"
            onClick={() => toggle(groupKey)}
          >
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <span className="text-sm font-semibold text-foreground truncate">{label}</span>
            <Badge variant="secondary" className="text-[10px]">{roles.length}</Badge>
          </button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => {
              setAddFor(groupKey);
              setAddTitle('');
            }}
          >
            <Plus className="h-3 w-3" /> Add role
          </Button>
        </div>
        {isOpen && (
          <div className="p-3 space-y-2">
            {roles.length === 0 ? (
              <p className="text-xs text-muted-foreground">No roles in this group</p>
            ) : (
              roles.map(renderRole)
            )}
          </div>
        )}
      </div>
    );
  };

  const derivedKey = slugifyPositionKey(addTitle);

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-lg font-bold text-foreground">Roles</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Job titles held by staff. Expand a department to see its roles.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-12 rounded-lg bg-muted/30 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {renderGroup(UNASSIGNED, 'Unassigned roles', grouped[UNASSIGNED] || [])}
          {departments.map(d => renderGroup(d.id, d.name, grouped[d.id] || []))}
        </div>
      )}

      {/* A. Add role */}
      <Dialog open={!!addFor} onOpenChange={open => !open && setAddFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add role</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Title</Label>
              <Input value={addTitle} onChange={e => setAddTitle(e.target.value)} placeholder="e.g. Field Supervisor" />
            </div>
            {derivedKey && <p className="text-[11px] text-muted-foreground">Key: {derivedKey}</p>}
            {addTargetProtected && (
              <p className="text-xs text-destructive">{PROTECTED_TITLE_MESSAGE}</p>
            )}
            <ReasonField value={addReason} onChange={setAddReason} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddFor(null)}>Cancel</Button>
            <Button
              onClick={submitAdd}
              disabled={!addTitle.trim() || addTargetProtected || !reasonOk(addReason) || addPosition.isPending}
            >
              {addPosition.isPending ? 'Saving...' : 'Add role'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* B. Edit role */}
      <Dialog open={!!editRole} onOpenChange={open => !open && setEditRole(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit role title</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Title</Label>
              <Input value={editTitle} onChange={e => setEditTitle(e.target.value)} disabled={editProtected} />
            </div>
            {(editProtected || editTargetProtected) && (
              <p className="text-xs text-destructive">{PROTECTED_TITLE_MESSAGE}</p>
            )}
            <ReasonField value={editReason} onChange={setEditReason} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRole(null)}>Cancel</Button>
            <Button
              onClick={submitEdit}
              disabled={
                !editTitle.trim() || editProtected || editTargetProtected ||
                !reasonOk(editReason) || renamePosition.isPending
              }
            >
              {renamePosition.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* C. Move role */}
      <Dialog open={!!moveRole} onOpenChange={open => !open && setMoveRole(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move role to another department</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Department</Label>
              <Select value={moveTarget} onValueChange={setMoveTarget}>
                <SelectTrigger>
                  <SelectValue placeholder="Select department" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                  {departments.map(d => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ReasonField value={moveReason} onChange={setMoveReason} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveRole(null)}>Cancel</Button>
            <Button onClick={submitMove} disabled={!reasonOk(moveReason) || movePosition.isPending}>
              {movePosition.isPending ? 'Moving...' : 'Move role'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* D. Deactivate role */}
      <Dialog open={!!deactivateRole} onOpenChange={open => !open && setDeactivateRole(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate role</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-foreground">{deactivateRole?.title}</p>
            {deactivateRole && (heldBy[deactivateRole.id] || 0) > 0 && (
              <p className="text-xs text-destructive">
                This position is held by {heldBy[deactivateRole.id]}{' '}
                {(heldBy[deactivateRole.id] || 0) === 1 ? 'person' : 'people'}. The position must be vacated first.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Deactivating a position does not remove any access binding on it, and does not move any payroll authority bound to it.
            </p>
            {deactivateRole && (accessByPosition[deactivateRole.id] || []).length > 0 && (
              <p className="text-xs text-destructive">
                This position still grants the access listed above. Deactivating it does not remove that binding, and does not move any payroll authority bound to it.
              </p>
            )}
            <ReasonField value={statusReason} onChange={setStatusReason} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeactivateRole(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={submitDeactivate}
              disabled={
                setPositionActive.isPending || !reasonOk(statusReason) ||
                (deactivateRole ? (heldBy[deactivateRole.id] || 0) > 0 : true)
              }
            >
              {setPositionActive.isPending ? 'Saving...' : 'Deactivate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* D. Reactivate role (unconditional, still reasoned + audited) */}
      <Dialog open={!!reactivateRole} onOpenChange={open => !open && setReactivateRole(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reactivate role</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-foreground">{reactivateRole?.title}</p>
            <ReasonField value={statusReason} onChange={setStatusReason} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReactivateRole(null)}>Cancel</Button>
            <Button onClick={submitReactivate} disabled={!reasonOk(statusReason) || setPositionActive.isPending}>
              {setPositionActive.isPending ? 'Saving...' : 'Reactivate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}