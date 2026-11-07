import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  addToDesk,
  isAllDesksEntry,
  removeFromDesk,
  useDeskAccessCandidates,
  useDeskAccessList,
  type DeskAccessEntry,
} from '@/pages/desk/deskAccess';

/**
 * HR → People → Desks: who may open which ops desk.
 *
 * One card per desk with its members. HR adds people from the active
 * employees (`desk_access_candidates`) and removes them with ×. The
 * "All desks (COO, CEO)" card follows roles and is shown read-only. Until the
 * COO turns access on, the desks still open by role, and a banner says so.
 * Every server message is shown as-is.
 */

function AddPeople({ entry, onDone }: { entry: DeskAccessEntry; onDone: (msg: { ok: boolean; text: string }) => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const candidates = useDeskAccessCandidates(search, open);
  const already = useMemo(() => new Set(entry.members.map((m) => m.user_id)), [entry.members]);
  const rows = (candidates.data ?? []).filter((c) => !already.has(c.user_id));
  const label = entry.label ?? entry.desk;

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const add = async () => {
    setBusy(true);
    const r = await addToDesk(entry.desk, picked);
    setBusy(false);
    setPicked([]);
    setOpen(false);
    queryClient.invalidateQueries({ queryKey: ['desk-access'] });
    if (r.errors.length) onDone({ ok: false, text: r.errors.join(' · ') });
    else onDone({ ok: true, text: `Added ${r.added} to ${label}.` });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Add people to ${label}`}>
          <Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> Add people
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="start">
        <div className="space-y-2">
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search active employees by name, staff ID or phone"
            aria-label="Search active employees"
          />
          <div className="max-h-64 space-y-1 overflow-auto" role="listbox" aria-multiselectable="true" aria-label="Active employees">
            {candidates.isLoading && <p className="text-xs text-muted-foreground">Searching…</p>}
            {candidates.error && <p className="text-xs text-destructive">{(candidates.error as { message?: string }).message}</p>}
            {!candidates.isLoading && !candidates.error && rows.length === 0 && (
              <p className="text-xs text-muted-foreground">No active employee matches, or everyone found is already on this desk.</p>
            )}
            {rows.map((c) => {
              const on = picked.includes(c.user_id);
              return (
                <label key={c.user_id} role="option" aria-selected={on} className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted">
                  <Checkbox checked={on} onCheckedChange={() => toggle(c.user_id)} aria-label={c.name ?? c.user_id} />
                  <span className="min-w-0 text-sm">
                    <span className="block text-foreground">{c.name ?? '—'}</span>
                    <span className="block text-xs text-muted-foreground">
                      {c.staff_ref ?? 'no staff ID'}
                      {c.phone ? ` · ${c.phone}` : ''}
                      {c.desks.length ? ` · on ${c.desks.join(', ')}` : ''}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          <Button size="sm" className="w-full" disabled={picked.length === 0 || busy} onClick={add}>
            {busy ? 'Adding…' : picked.length ? `Add ${picked.length} to ${label}` : 'Choose people to add'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DeskCard({ entry }: { entry: DeskAccessEntry }) {
  const queryClient = useQueryClient();
  const readOnly = isAllDesksEntry(entry);
  const label = entry.label ?? entry.desk;
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const remove = async (userId: string, name: string | null) => {
    setBusy(userId);
    setMessage(null);
    const err = await removeFromDesk(entry.desk, userId);
    setBusy(null);
    queryClient.invalidateQueries({ queryKey: ['desk-access'] });
    setMessage(err ? { ok: false, text: err } : { ok: true, text: `Removed ${name ?? 'them'} from ${label}.` });
  };

  return (
    <Card data-desk={entry.desk} data-readonly={readOnly ? 'true' : undefined}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-base">
          {label} <span className="text-sm font-normal text-muted-foreground">· {entry.members.length}</span>
        </CardTitle>
        {!readOnly && <AddPeople entry={entry} onDone={setMessage} />}
      </CardHeader>
      <CardContent className="space-y-2">
        {readOnly && <p className="text-xs text-muted-foreground">Follows the COO and CEO roles — not edited here.</p>}
        {entry.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody on this desk yet.</p>
        ) : (
          <ul className="space-y-1">
            {entry.members.map((m) => (
              <li key={m.user_id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0">
                  <span className="text-foreground">{m.name ?? '—'}</span>
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {m.staff_ref ?? 'no staff ID'}
                    {m.active_employee === false ? ' · not an active employee' : ''}
                  </span>
                </span>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    disabled={busy === m.user_id}
                    onClick={() => remove(m.user_id, m.name)}
                    aria-label={`Remove ${m.name ?? 'this person'} from ${label}`}
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {message && (
          <p className={`text-xs ${message.ok ? 'text-muted-foreground' : 'text-destructive'}`} role={message.ok ? 'status' : 'alert'}>
            {message.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function DeskAccessManager() {
  const list = useDeskAccessList(true);

  if (list.isLoading) return <p className="text-sm text-muted-foreground">Loading desk access…</p>;
  if (list.error) return <p className="text-sm text-destructive" role="alert">{(list.error as { message?: string }).message}</p>;
  const data = list.data;
  if (!data) return null;

  return (
    <div className="space-y-4">
      {!data.enforced && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Desk access is not enforced yet — the COO turns it on
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        Who may open each ops desk. Only active employees can be added. A removal takes effect on their desk within two minutes.
      </p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.desks.map((e) => (
          <DeskCard key={e.desk} entry={e} />
        ))}
      </div>
    </div>
  );
}
