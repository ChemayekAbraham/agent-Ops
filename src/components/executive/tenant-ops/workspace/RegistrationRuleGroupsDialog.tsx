import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import type {
  RegistrationControlOptions,
  RegistrationControlRules,
  RegistrationRuleGroup,
} from '@/hooks/useAgentRegistrationControl';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rules?: RegistrationControlRules;
  options?: RegistrationControlOptions;
  saving: boolean;
  onSave: (next: Partial<RegistrationControlRules>) => void;
}

const emptyGroup = (index: number): RegistrationRuleGroup => ({
  id: `group-${Date.now()}-${index}`,
  label: `Rule ${index + 1}`,
  active: true,
  min_active_tenants: 0,
  max_active_tenants: null,
  required_prev_month_pct: 0,
  districts: [],
  regions: [],
  tiers: [],
  agent_ids: [],
});

function ChipPicker({
  title,
  values,
  selected,
  onToggle,
}: {
  title: string;
  values: string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  if (values.length === 0) return null;
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{title}</Label>
      <div className="mt-1 flex flex-wrap gap-1">
        {values.map((v) => {
          const on = selected.includes(v);
          return (
            <Badge
              key={v}
              variant={on ? 'default' : 'outline'}
              className="max-w-full cursor-pointer whitespace-normal break-words text-left"
              onClick={() => onToggle(v)}
            >
              {v}
            </Badge>
          );
        })}
      </div>
      {selected.length === 0 && (
        <p className="mt-1 text-xs text-muted-foreground">Nothing picked means every {title.toLowerCase()}.</p>
      )}
    </div>
  );
}

export default function RegistrationRuleGroupsDialog({
  open,
  onOpenChange,
  rules,
  options,
  saving,
  onSave,
}: Props) {
  const [enabled, setEnabled] = useState(true);
  const [groups, setGroups] = useState<RegistrationRuleGroup[]>([]);
  const [agentSearch, setAgentSearch] = useState('');

  useEffect(() => {
    if (!open) return;
    setEnabled(rules?.enabled ?? true);
    setGroups(
      (rules?.groups ?? []).map((g) => ({
        ...g,
        districts: g.districts ?? [],
        regions: g.regions ?? [],
        tiers: g.tiers ?? [],
        agent_ids: g.agent_ids ?? [],
      })),
    );
    setAgentSearch('');
  }, [open, rules]);

  const agentMatches = useMemo(() => {
    const term = agentSearch.trim().toLowerCase();
    const all = options?.agents ?? [];
    if (!term) return all.slice(0, 12);
    return all.filter((a) => (a.full_name ?? '').toLowerCase().includes(term)).slice(0, 12);
  }, [agentSearch, options?.agents]);

  const patch = (index: number, changes: Partial<RegistrationRuleGroup>) =>
    setGroups((prev) => prev.map((g, i) => (i === index ? { ...g, ...changes } : g)));

  const toggleIn = (index: number, key: 'districts' | 'regions' | 'tiers' | 'agent_ids', value: string) =>
    setGroups((prev) =>
      prev.map((g, i) => {
        if (i !== index) return g;
        const list = g[key] ?? [];
        return { ...g, [key]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value] };
      }),
    );

  const move = (index: number, dir: -1 | 1) =>
    setGroups((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] max-w-3xl flex-col overflow-hidden p-4 sm:max-h-[calc(100dvh-2rem)] sm:p-6">
        <DialogHeader>
          <DialogTitle>Registration rules</DialogTitle>
          <DialogDescription>
            Set your own required percentage and tenant numbers, and choose exactly which agents each rule
            covers. An agent is judged by the first active rule that matches them.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">Restriction switched on</div>
            <div className="text-xs text-muted-foreground">
              Turn this off and no agent is ever stopped from registering.
            </div>
          </div>
          <Switch className="shrink-0" checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <ScrollArea className="min-h-0 flex-1 pr-2 sm:pr-3">
          <div className="space-y-4">
            {groups.map((g, i) => (
              <div key={g.id} className="space-y-3 rounded-xl border p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    value={g.label}
                    onChange={(e) => patch(i, { label: e.target.value })}
                    className="w-full sm:max-w-[16rem]"
                    placeholder="Rule name"
                  />
                  <div className="flex w-full flex-wrap items-center justify-between gap-1 sm:ml-auto sm:w-auto sm:flex-nowrap sm:justify-start">
                    <Switch checked={g.active} onCheckedChange={(v) => patch(i, { active: v })} />
                    <span className="mr-auto text-xs text-muted-foreground sm:mr-2">{g.active ? 'Active' : 'Paused'}</span>
                    <Button size="icon" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0}>
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => move(i, 1)}
                      disabled={i === groups.length - 1}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setGroups((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">From this many tenants</Label>
                    <Input
                      type="number"
                      min={0}
                      value={g.min_active_tenants}
                      onChange={(e) => patch(i, { min_active_tenants: Number(e.target.value) || 0 })}
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Up to (blank = no limit)</Label>
                    <Input
                      type="number"
                      min={0}
                      value={g.max_active_tenants ?? ''}
                      onChange={(e) =>
                        patch(i, {
                          max_active_tenants: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Required last month (%)</Label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={g.required_prev_month_pct}
                      onChange={(e) => patch(i, { required_prev_month_pct: Number(e.target.value) || 0 })}
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <ChipPicker
                    title="Regions"
                    values={options?.regions ?? []}
                    selected={g.regions}
                    onToggle={(v) => toggleIn(i, 'regions', v)}
                  />
                  <ChipPicker
                    title="Districts"
                    values={options?.districts ?? []}
                    selected={g.districts}
                    onToggle={(v) => toggleIn(i, 'districts', v)}
                  />
                  <ChipPicker
                    title="Agent levels"
                    values={options?.tiers ?? []}
                    selected={g.tiers}
                    onToggle={(v) => toggleIn(i, 'tiers', v)}
                  />
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground">Named agents only (optional)</Label>
                  <Input
                    value={agentSearch}
                    onChange={(e) => setAgentSearch(e.target.value)}
                    placeholder="Search an agent by name"
                    className="mt-1 w-full sm:max-w-sm"
                  />
                  <div className="mt-2 flex flex-wrap gap-1">
                    {agentMatches.map((a) => {
                      const on = g.agent_ids.includes(a.id);
                      return (
                        <Badge
                          key={a.id}
                          variant={on ? 'default' : 'outline'}
                          className="max-w-full cursor-pointer whitespace-normal break-words text-left"
                          onClick={() => toggleIn(i, 'agent_ids', a.id)}
                        >
                          {a.full_name ?? 'Unnamed agent'}
                        </Badge>
                      );
                    })}
                  </div>
                  {g.agent_ids.length > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {g.agent_ids.length} agent(s) picked — the rule covers only them.
                    </p>
                  )}
                </div>
              </div>
            ))}

            {groups.length === 0 && (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                No rules yet. Add one to start restricting registrations.
              </p>
            )}
          </div>
        </ScrollArea>

        <Button
          variant="outline"
          size="sm"
          className="w-full shrink-0 sm:w-auto sm:self-start"
          onClick={() => setGroups((prev) => [...prev, emptyGroup(prev.length)])}
        >
          <Plus className="mr-2 h-4 w-4" /> Add a rule
        </Button>

        <DialogFooter className="shrink-0 flex-col-reverse gap-2 sm:flex-row">
          <Button variant="ghost" className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="w-full sm:w-auto" onClick={() => onSave({ enabled, groups })} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save rules
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
