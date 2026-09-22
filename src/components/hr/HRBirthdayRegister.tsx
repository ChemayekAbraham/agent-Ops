import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type BirthdayRow = {
  staff_id: string;
  staff_ref: string | null;
  full_name: string | null;
  birth_date: string | null;
  birth_day_month: string | null;
  turning_age: number | null;
  next_birthday: string | null;
  days_until: number | null;
};

const isNotPermitted = (message: string | null | undefined) =>
  !!message && message.toLowerCase().includes('not permitted');

function formatDate(value: string | null) {
  if (!value) return '—';
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function HRBirthdayRegister() {
  const { roles } = useAuth();
  const [rows, setRows] = useState<BirthdayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState<BirthdayRow | null>(null);

  // Write capability is known up front, so read-only viewers never see controls
  // that would fail on click. The post-failure readOnly flag stays as a backstop.
  const canWrite = useMemo(
    () => (roles ?? []).some((r) => (r as string) === 'hr'),
    [roles],
  );
  const showActions = canWrite && !readOnly;

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('hr_list_staff_birthdays' as never);
    if (error) {
      if (isNotPermitted(error.message)) {
        setBlocked(true);
      } else {
        toast.error(error.message);
      }
      setLoading(false);
      return;
    }
    setRows(((data ?? []) as unknown as BirthdayRow[]));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(() => {
    const withDate = rows.filter((r) => !!r.birth_date);
    const withoutDate = rows.filter((r) => !r.birth_date);
    withDate.sort((a, b) => (a.days_until ?? 9999) - (b.days_until ?? 9999));
    withoutDate.sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? ''));
    return [...withDate, ...withoutDate];
  }, [rows]);

  const missing = rows.filter((r) => !r.birth_date).length;

  const save = async (row: BirthdayRow) => {
    const value = drafts[row.staff_id] ?? row.birth_date ?? '';
    if (!value) {
      toast.error('Pick a date of birth first.');
      return;
    }
    setSavingId(row.staff_id);
    const { error } = await supabase.rpc('hr_set_staff_birth_date' as never, {
      p_staff_id: row.staff_id,
      p_birth_date: value,
    } as never);
    setSavingId(null);
    if (error) {
      toast.error(error.message);
      if (isNotPermitted(error.message)) setReadOnly(true);
      return;
    }
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[row.staff_id];
      return next;
    });
    toast.success('Date of birth saved.');
    void load();
  };

  const clear = async (row: BirthdayRow) => {
    setSavingId(row.staff_id);
    const { error } = await supabase.rpc('hr_clear_staff_birth_date' as never, {
      p_staff_id: row.staff_id,
    } as never);
    setSavingId(null);
    setConfirmClear(null);
    if (error) {
      toast.error(error.message);
      if (isNotPermitted(error.message)) setReadOnly(true);
      return;
    }
    toast.success('Date of birth cleared.');
    void load();
  };

  if (blocked) return null;
  if (loading) {
    return <p className="text-xs text-muted-foreground">Loading birthday register…</p>;
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-base font-semibold text-foreground">Birthday register</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {missing} of {rows.length} staff have no date of birth recorded
        </p>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee</TableHead>
              <TableHead>Date of birth</TableHead>
              <TableHead>Turning</TableHead>
              <TableHead>Next birthday</TableHead>
              <TableHead>Days until</TableHead>
              {showActions && <TableHead className="text-right">Action</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => {
              const notSet = !row.birth_date;
              return (
                <TableRow key={row.staff_id} className={notSet ? 'text-muted-foreground' : undefined}>
                  <TableCell>
                    <span className="font-medium text-foreground">{row.full_name ?? 'Unnamed'}</span>
                    {row.staff_ref && (
                      <span className="ml-2 text-xs text-muted-foreground">{row.staff_ref}</span>
                    )}
                  </TableCell>
                  <TableCell className={notSet ? 'italic' : undefined}>
                    {notSet ? 'Not set' : formatDate(row.birth_date)}
                  </TableCell>
                  <TableCell>{row.turning_age ?? '—'}</TableCell>
                  <TableCell>{notSet ? '—' : formatDate(row.next_birthday)}</TableCell>
                  <TableCell>{notSet ? '—' : (row.days_until ?? '—')}</TableCell>
                  {showActions && (
                    <TableCell>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Input
                          type="date"
                          className="h-9 w-[150px]"
                          value={drafts[row.staff_id] ?? row.birth_date ?? ''}
                          onChange={(e) =>
                            setDrafts((prev) => ({ ...prev, [row.staff_id]: e.target.value }))
                          }
                        />
                        <Button
                          size="sm"
                          onClick={() => void save(row)}
                          disabled={savingId === row.staff_id}
                        >
                          Save
                        </Button>
                        {!notSet && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setConfirmClear(row)}
                            disabled={savingId === row.staff_id}
                          >
                            Clear
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!confirmClear} onOpenChange={(open) => !open && setConfirmClear(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear this date of birth?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmClear?.full_name ?? 'This staff member'} will have no date of birth on record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmClear && void clear(confirmClear)}>
              Clear date
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
