import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { KeyRound, RefreshCw, UserPlus, Loader2, Search, ShieldX } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  useDashboardAccess,
  useDashboardAccessSearch,
  type DashboardAccessGrant,
  type DashboardAccessPerson,
} from '@/hooks/useDashboardAccess';
import { cn } from '@/lib/utils';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : (e as { message?: string })?.message) || 'Something went wrong';
const roleLabel = (r: string) => r.replace(/_/g, ' ');
const fmtDate = (d: string | null) => {
  if (!d) return '—';
  try { return format(new Date(d), 'd MMM yyyy'); } catch { return '—'; }
};

function RoleBadges({ roles }: { roles: string[] }) {
  if (!roles.length) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <Badge key={r} variant="secondary" className="capitalize">{roleLabel(r)}</Badge>
      ))}
    </div>
  );
}

export default function DashboardAccessView() {
  const { toast } = useToast();
  const { canManage, loading, error, byDashboard, totals, grant, revoke, refresh } = useDashboardAccess();
  const [selectedKey, setSelectedKey] = useState<string>(byDashboard[0]?.key ?? '');
  const [revokeTarget, setRevokeTarget] = useState<DashboardAccessGrant | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [pendingGrantId, setPendingGrantId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    if (!selectedKey && byDashboard[0]) setSelectedKey(byDashboard[0].key);
  }, [byDashboard, selectedKey]);

  const selected = byDashboard.find((d) => d.key === selectedKey) ?? byDashboard[0];

  if (!loading && !canManage) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
          <ShieldX className="h-5 w-5" />
          You don't have permission to manage dashboard access.
        </CardContent>
      </Card>
    );
  }

  const doGrant = async (userId: string, reason: string) => {
    if (!selected) return false;
    setPendingGrantId(userId);
    try {
      const res = await grant.mutateAsync({ userId, dashboard: selected.key, reason });
      toast({ title: res?.already_granted ? 'Already on the list' : 'Access granted', description: selected.label });
      return true;
    } catch (e) {
      toast({ title: 'Could not grant access', description: errMsg(e), variant: 'destructive' });
      return false;
    } finally {
      setPendingGrantId(null);
    }
  };

  const doRevoke = async () => {
    if (!revokeTarget || !selected) return;
    try {
      await revoke.mutateAsync({ userId: revokeTarget.userId, dashboard: selected.key, reason: revokeReason });
      toast({ title: 'Access removed', description: `${revokeTarget.fullName ?? 'Person'} · ${selected.label}` });
      setRevokeTarget(null);
      setRevokeReason('');
    } catch (e) {
      toast({ title: 'Could not remove access', description: errMsg(e), variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <KeyRound className="h-5 w-5 text-primary" /> Dashboard Access
            </h2>
            <p className="text-sm text-muted-foreground">
              Staff can open a staff dashboard only if they are on its list. super_admin and CTO see everything.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="px-3 py-1">On lists: {totals.grants}</Badge>
            <Badge
              variant="outline"
              className={cn('px-3 py-1', totals.lockedOut > 0 && 'border-warning text-warning')}
            >
              Locked out: {totals.lockedOut}
            </Badge>
            <Button variant="outline" size="sm" onClick={() => refresh()} disabled={loading}>
              <RefreshCw className={cn('mr-1 h-4 w-4', loading && 'animate-spin')} /> Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive">
          <CardContent className="flex items-center justify-between gap-3 p-4 text-sm">
            <span className="text-destructive">{errMsg(error)}</span>
            <Button size="sm" variant="outline" onClick={() => refresh()}>Try again</Button>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-[260px_1fr]">
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-[260px_1fr]">
          {/* Picker: select on phone, list on desktop */}
          <div className="md:hidden">
            <Select value={selected?.key} onValueChange={setSelectedKey}>
              <SelectTrigger><SelectValue placeholder="Choose a dashboard" /></SelectTrigger>
              <SelectContent>
                {byDashboard.map((d) => (
                  <SelectItem key={d.key} value={d.key}>
                    {d.label} · {d.grants.length}{d.missing.length > 0 ? ` · ${d.missing.length} locked out` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Card className="hidden md:block">
            <CardContent className="p-2">
              <nav className="flex flex-col gap-1">
                {byDashboard.map((d) => (
                  <button
                    key={d.key}
                    onClick={() => setSelectedKey(d.key)}
                    className={cn(
                      'flex items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted',
                      selected?.key === d.key && 'bg-muted font-medium',
                    )}
                  >
                    <span className="truncate">{d.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      <Badge variant="secondary">{d.grants.length}</Badge>
                      {d.missing.length > 0 && (
                        <Badge variant="outline" className="border-warning text-warning">{d.missing.length}</Badge>
                      )}
                    </span>
                  </button>
                ))}
              </nav>
            </CardContent>
          </Card>

          {selected && (
            <div className="min-w-0 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold">{selected.label}</h3>
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <UserPlus className="mr-1 h-4 w-4" /> Add person
                </Button>
              </div>

              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">Has access ({selected.grants.length})</CardTitle></CardHeader>
                <CardContent className="overflow-x-auto p-0">
                  {selected.grants.length === 0 ? (
                    <p className="p-4 text-sm text-muted-foreground">Nobody is on this list yet.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Phone</TableHead>
                          <TableHead>Granted by</TableHead>
                          <TableHead>Granted</TableHead>
                          <TableHead className="text-right" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selected.grants.map((g) => (
                          <TableRow key={g.grantId}>
                            <TableCell className="font-medium">{g.fullName ?? 'Unnamed'}</TableCell>
                            <TableCell className="whitespace-nowrap">{g.phone ?? '—'}</TableCell>
                            <TableCell>{g.grantedByName ?? '—'}</TableCell>
                            <TableCell className="whitespace-nowrap">{fmtDate(g.grantedAt)}</TableCell>
                            <TableCell className="text-right">
                              <Button size="sm" variant="outline" onClick={() => { setRevokeTarget(g); setRevokeReason(''); }}>
                                Revoke
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">Holds the role but locked out ({selected.missing.length})</CardTitle></CardHeader>
                <CardContent className="overflow-x-auto p-0">
                  {selected.missing.length === 0 ? (
                    <p className="p-4 text-sm text-muted-foreground">Everyone with this role has access.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Phone</TableHead>
                          <TableHead>Roles</TableHead>
                          <TableHead className="text-right" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selected.missing.map((m) => (
                          <TableRow key={m.userId}>
                            <TableCell className="font-medium">{m.fullName ?? 'Unnamed'}</TableCell>
                            <TableCell className="whitespace-nowrap">{m.phone ?? '—'}</TableCell>
                            <TableCell><RoleBadges roles={m.roles} /></TableCell>
                            <TableCell className="text-right">
                              <Button
                                size="sm"
                                disabled={grant.isPending}
                                onClick={() => doGrant(m.userId, 'Granted from Dashboard Access')}
                              >
                                {pendingGrantId === m.userId && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                                Grant access
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}

      {/* Revoke confirm */}
      <Dialog open={!!revokeTarget} onOpenChange={(o) => { if (!o && !revoke.isPending) setRevokeTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove access?</DialogTitle>
            <DialogDescription>
              {revokeTarget?.fullName ?? 'This person'} will no longer be able to open {selected?.label}.
            </DialogDescription>
          </DialogHeader>
          <Textarea placeholder="Reason (optional)" value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)} disabled={revoke.isPending}>Cancel</Button>
            <Button variant="destructive" onClick={doRevoke} disabled={revoke.isPending}>
              {revoke.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {selected && (
        <AddPersonDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          dashboardLabel={selected.label}
          pending={grant.isPending}
          onGrant={(id, reason) => doGrant(id, reason)}
        />
      )}
    </div>
  );
}

function AddPersonDialog({
  open, onOpenChange, dashboardLabel, pending, onGrant,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dashboardLabel: string;
  pending: boolean;
  onGrant: (userId: string, reason: string) => Promise<boolean>;
}) {
  const [term, setTerm] = useState('');
  const [reason, setReason] = useState('');
  const [picked, setPicked] = useState<DashboardAccessPerson | null>(null);
  const debounced = useDebouncedValue(term, 300);
  const search = useDashboardAccessSearch(debounced);

  useEffect(() => {
    if (!open) { setTerm(''); setReason(''); setPicked(null); }
  }, [open]);

  const results = search.data ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add person to {dashboardLabel}</DialogTitle>
          <DialogDescription>Search by name, phone or email.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Type at least 2 characters" value={term} onChange={(e) => setTerm(e.target.value)} autoFocus />
        </div>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {debounced.trim().length < 2 ? null : search.isLoading ? (
            <p className="p-2 text-sm text-muted-foreground">Searching…</p>
          ) : search.error ? (
            <p className="p-2 text-sm text-destructive">{errMsg(search.error)}</p>
          ) : results.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">No one found.</p>
          ) : (
            results.map((p) => (
              <button
                key={p.id}
                onClick={() => setPicked(p)}
                className={cn(
                  'w-full rounded-md border p-2 text-left text-sm transition-colors hover:bg-muted',
                  picked?.id === p.id && 'border-primary bg-muted',
                )}
              >
                <div className="font-medium">{p.fullName ?? 'Unnamed'}</div>
                <div className="text-xs text-muted-foreground">{[p.phone, p.email].filter(Boolean).join(' · ') || '—'}</div>
                <div className="mt-1"><RoleBadges roles={p.roles} /></div>
              </button>
            ))
          )}
        </div>
        <Textarea placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button
            disabled={!picked || pending}
            onClick={async () => {
              if (!picked) return;
              const ok = await onGrant(picked.id, reason);
              if (ok) onOpenChange(false);
            }}
          >
            {pending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Grant
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
