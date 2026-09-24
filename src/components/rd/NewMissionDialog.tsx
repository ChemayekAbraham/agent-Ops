import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { db, DOMAINS, labelize, useCurrentUserId, useRdMutation, useRdPeople } from './useRd';

export function NewMissionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data: uid } = useCurrentUserId();
  const { data: people = [] } = useRdPeople();
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState('');
  const [domains, setDomains] = useState<string[]>([]);
  const [owner, setOwner] = useState<string>('');

  useEffect(() => {
    if (open) { setTitle(''); setProblem(''); setDomains([]); setOwner(uid ?? ''); }
  }, [open, uid]);

  const create = useRdMutation(async () =>
    db.from('rd_missions').insert({
      title, problem, domains, owner_id: owner || null, stage: 'intake', created_by: uid,
    }), 'Mission created');

  const ownerOptions = people.some((p) => p.user_id === uid) ? people : [...people, ...(uid ? [{ user_id: uid, full_name: 'Me' } as any] : [])];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>New mission</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Title</Label>
            <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
            <p className="mt-1 text-right text-[11px] text-muted-foreground">{title.length}/80</p>
          </div>
          <div>
            <Label>Problem</Label>
            <Textarea value={problem} onChange={(e) => setProblem(e.target.value)} rows={4} />
          </div>
          <div>
            <Label>Domains</Label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {DOMAINS.map((d) => {
                const on = domains.includes(d);
                return (
                  <Badge key={d} variant={on ? 'default' : 'outline'} className="cursor-pointer select-none py-1"
                    onClick={() => setDomains(on ? domains.filter((x) => x !== d) : [...domains, d])}>
                    {labelize(d)}
                  </Badge>
                );
              })}
            </div>
          </div>
          <div>
            <Label>Owner</Label>
            <Select value={owner} onValueChange={setOwner}>
              <SelectTrigger><SelectValue placeholder="Choose owner" /></SelectTrigger>
              <SelectContent>
                {ownerOptions.map((p: any) => (
                  <SelectItem key={p.user_id} value={p.user_id}>{p.full_name || 'Unknown staff'}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={create.isPending} onClick={() => create.mutate(undefined, { onSuccess: () => onOpenChange(false) })}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
