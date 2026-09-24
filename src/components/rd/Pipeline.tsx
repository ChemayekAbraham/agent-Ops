import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, ChevronDown, ChevronRight } from 'lucide-react';
import { DOMAINS, HORIZONS, STAGES, STAGE_LABEL, labelize, useCurrentUserId, useMissions, usePeopleMap, useRdMe, useRdPeople } from './useRd';
import { MissionCard } from './MissionCard';
import { NewMissionDialog } from './NewMissionDialog';

const EMPTY: Record<string, string> = {
  intake: 'No missions in Intake. Contributors add one with "New mission".',
  frame: 'No missions in Frame. Owners advance from Intake once the problem is framed.',
  build: 'No missions in Build. The lead promotes from Frame.',
  prove: 'No missions in Prove. Owners advance from Build when there is something to measure.',
  ship: 'No missions in Ship. Advance from Prove once the exit metric is met.',
  adopt: 'No missions in Adopt. Advance from Ship once it is live.',
  kill: 'No killed missions.',
};

export function Pipeline() {
  const { data: missions = [], isLoading } = useMissions();
  const { data: me } = useRdMe();
  const { data: uid } = useCurrentUserId();
  const { data: people = [] } = useRdPeople();
  const name = usePeopleMap();
  const [horizon, setHorizon] = useState('all');
  const [domain, setDomain] = useState('all');
  const [owner, setOwner] = useState('all');
  const [mine, setMine] = useState(false);
  const [showKilled, setShowKilled] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  const filtered = useMemo(() => missions.filter((m) =>
    (horizon === 'all' || m.horizon === horizon) &&
    (domain === 'all' || (m.domains ?? []).includes(domain)) &&
    (owner === 'all' || m.owner_id === owner) &&
    (!mine || m.owner_id === uid || m.deputy_id === uid || m.created_by === uid)
  ), [missions, horizon, domain, owner, mine, uid]);

  const killed = filtered.filter((m) => m.stage === 'kill');

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={horizon} onValueChange={setHorizon}>
          <SelectTrigger className="h-9 w-[120px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All horizons</SelectItem>
            {HORIZONS.map((h) => <SelectItem key={h} value={h}>{labelize(h)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={domain} onValueChange={setDomain}>
          <SelectTrigger className="h-9 w-[130px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All domains</SelectItem>
            {DOMAINS.map((d) => <SelectItem key={d} value={d}>{labelize(d)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={owner} onValueChange={setOwner}>
          <SelectTrigger className="h-9 w-[140px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All owners</SelectItem>
            {people.map((p) => <SelectItem key={p.user_id} value={p.user_id}>{p.full_name || 'Unknown staff'}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="sm" variant={mine ? 'default' : 'outline'} onClick={() => setMine(!mine)}>Mine</Button>
        {me?.is_contributor && (
          <Button size="sm" className="ml-auto gap-1" onClick={() => setNewOpen(true)}><Plus className="h-4 w-4" />New mission</Button>
        )}
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading missions…</p> : (
        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-3">
          {STAGES.map((s) => {
            const col = filtered.filter((m) => m.stage === s);
            return (
              <div key={s} className="w-[78vw] max-w-[280px] shrink-0 snap-start rounded-lg border border-border bg-muted/30 p-2">
                <div className="mb-2 flex items-center justify-between px-1">
                  <h3 className="text-sm font-semibold text-foreground">{STAGE_LABEL[s]}</h3>
                  <span className="text-xs text-muted-foreground">{col.length}</span>
                </div>
                <div className="space-y-2">
                  {col.length === 0
                    ? <p className="px-1 py-4 text-xs text-muted-foreground">{EMPTY[s]}</p>
                    : col.map((m) => <MissionCard key={m.id} m={m} ownerName={name(m.owner_id)} />)}
                </div>
              </div>
            );
          })}
          <div className={`shrink-0 snap-start rounded-lg border border-border bg-muted/20 p-2 ${showKilled ? 'w-[78vw] max-w-[280px]' : 'w-auto'}`}>
            <button className="flex w-full items-center gap-1 px-1 text-sm font-semibold text-muted-foreground" onClick={() => setShowKilled(!showKilled)}>
              {showKilled ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              Killed ({killed.length})
            </button>
            {showKilled && (
              <div className="mt-2 space-y-2">
                {killed.length === 0 ? <p className="px-1 py-4 text-xs text-muted-foreground">{EMPTY.kill}</p>
                  : killed.map((m) => <MissionCard key={m.id} m={m} ownerName={name(m.owner_id)} />)}
              </div>
            )}
          </div>
        </div>
      )}
      <NewMissionDialog open={newOpen} onOpenChange={setNewOpen} />
    </section>
  );
}
