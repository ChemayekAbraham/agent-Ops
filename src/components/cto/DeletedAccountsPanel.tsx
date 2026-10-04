import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Trash2, RotateCcw, Search, ShieldAlert } from 'lucide-react';

type RegisterStatus = 'soft_deleted' | 'purged' | 'restored';

interface DeletedAccountRow {
  id: string;
  user_id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  national_id: string | null;
  roles: unknown;
  status: string;
  reason: string;
  deleted_at: string;
  purged_at: string | null;
  purge_reason: string | null;
  restored_at: string | null;
  restore_reason: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  soft_deleted: 'Deleted (recoverable)',
  purged: 'Permanently removed',
  restored: 'Restored',
};

function rolesToList(roles: unknown): string[] {
  if (!Array.isArray(roles)) return [];
  return roles
    .map((entry) => (entry && typeof entry === 'object' ? String((entry as { role?: string }).role ?? '') : String(entry)))
    .filter(Boolean);
}

export function DeletedAccountsPanel() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RegisterStatus>('soft_deleted');
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<DeletedAccountRow | null>(null);
  const [action, setAction] = useState<'purge' | 'restore' | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['cto-deleted-accounts', status],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('deleted_accounts')
        .select('id,user_id,full_name,email,phone,national_id,roles,status,reason,deleted_at,purged_at,purge_reason,restored_at,restore_reason')
        .eq('status', status)
        .order('deleted_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as DeletedAccountRow[];
    },
    staleTime: 30_000,
  });

  const term = search.trim().toLowerCase();
  const filtered = term
    ? rows.filter((row) =>
        [row.full_name, row.email, row.phone, row.national_id, row.user_id]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(term)),
      )
    : rows;

  const openAction = (row: DeletedAccountRow, next: 'purge' | 'restore') => {
    setTarget(row);
    setAction(next);
    setReason('');
  };

  const closeDialog = () => {
    if (submitting) return;
    setTarget(null);
    setAction(null);
    setReason('');
  };

  const submit = async () => {
    if (!target || !action) return;
    const trimmed = reason.trim();
    if (trimmed.length < 10) {
      toast.error('Please give a reason of at least 10 characters');
      return;
    }
    setSubmitting(true);
    try {
      if (action === 'purge') {
        const { data, error } = await supabase.functions.invoke('delete-user', {
          body: { user_id: target.user_id, reason: trimmed, mode: 'permanent' },
        });
        if (error) throw error;
        if (data && typeof data === 'object' && 'error' in data && data.error) {
          throw new Error(String((data as { error: string }).error));
        }
        toast.success('Account permanently removed');
      } else {
        const { error } = await supabase.rpc('admin_restore_soft_deleted_account', {
          p_user_id: target.user_id,
          p_reason: trimmed,
        });
        if (error) throw error;
        // Also undo the login tombstone (placeholder email + sign-in block).
        const { data: authData, error: authErr } = await supabase.functions.invoke('delete-user', {
          body: { user_id: target.user_id, reason: trimmed, mode: 'restore_auth' },
        });
        const authMsg = authErr?.message
          ?? (authData && typeof authData === 'object' && 'error' in authData ? String((authData as { error: string }).error) : null);
        if (authMsg) {
          toast.error(`Account restored, but login could not be restored: ${authMsg}`);
        } else {
          toast.success('Account restored');
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['cto-deleted-accounts'] });
      setTarget(null);
      setAction(null);
      setReason('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-4 w-4 text-muted-foreground" />
            Deleted Accounts
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Deleting an account keeps all its history but releases the email, phone and national ID so the same person can
            register again. Accounts stay here until they are permanently removed or restored.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Tabs value={status} onValueChange={(value) => setStatus(value as RegisterStatus)}>
              <TabsList>
                <TabsTrigger value="soft_deleted">Recoverable</TabsTrigger>
                <TabsTrigger value="purged">Permanently removed</TabsTrigger>
                <TabsTrigger value="restored">Restored</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="relative sm:w-72">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search name, email, phone or ID"
                className="pl-9"
              />
            </div>
          </div>

          {isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No accounts in this list.</p>
          ) : (
            <div className="space-y-2">
              {filtered.map((row) => {
                const roles = rolesToList(row.roles);
                return (
                  <div
                    key={row.id}
                    className="flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{row.full_name || 'Unnamed account'}</span>
                        <Badge variant="outline" className="text-xs">
                          {STATUS_LABEL[row.status] ?? row.status}
                        </Badge>
                        {roles.map((role) => (
                          <Badge key={role} variant="secondary" className="text-xs">
                            {role.replace(/_/g, ' ')}
                          </Badge>
                        ))}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {row.email || 'no email'} · {row.phone || 'no phone'} · ID {row.national_id || 'n/a'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Deleted {format(new Date(row.deleted_at), 'dd MMM yyyy HH:mm')} — {row.reason}
                      </p>
                      {row.purged_at && (
                        <p className="text-xs text-muted-foreground">
                          Permanently removed {format(new Date(row.purged_at), 'dd MMM yyyy HH:mm')} — {row.purge_reason}
                        </p>
                      )}
                      {row.restored_at && (
                        <p className="text-xs text-muted-foreground">
                          Restored {format(new Date(row.restored_at), 'dd MMM yyyy HH:mm')} — {row.restore_reason}
                        </p>
                      )}
                    </div>
                    {row.status === 'soft_deleted' && (
                      <div className="flex shrink-0 gap-2">
                        <Button size="sm" variant="outline" onClick={() => openAction(row, 'restore')}>
                          <RotateCcw className="mr-1 h-3.5 w-3.5" />
                          Restore
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => openAction(row, 'purge')}>
                          <Trash2 className="mr-1 h-3.5 w-3.5" />
                          Delete permanently
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!target && !!action} onOpenChange={(open) => (!open ? closeDialog() : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action === 'purge' ? 'Delete permanently' : 'Restore account'}
            </DialogTitle>
            <DialogDescription>
              {action === 'purge'
                ? 'This removes the account and its remaining records for good. This cannot be undone.'
                : 'This puts the account back with its previous details and roles. Details already taken by another account will be left out.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm font-medium">{target?.full_name || target?.user_id}</p>
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Reason (at least 10 characters)"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={submitting}>
              Cancel
            </Button>
            <Button
              variant={action === 'purge' ? 'destructive' : 'default'}
              onClick={submit}
              disabled={submitting || reason.trim().length < 10}
            >
              {submitting ? 'Working…' : action === 'purge' ? 'Delete permanently' : 'Restore'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default DeletedAccountsPanel;
