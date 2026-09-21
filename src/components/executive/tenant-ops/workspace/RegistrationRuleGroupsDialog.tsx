import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from 'lucide-react';
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
  saving?: boolean;
  onSave: (rules: Partial<RegistrationControlRules>) => Promise<void> | void;
}

const emptyGroup = (): RegistrationRuleGroup => ({
  id: `g-${Math.random().toString(36).slice(2, 10)}`,
  label: 'New group',
  active: true,
  min_active_tenants: 20,
  max_active_tenants: null,
  required_prev_month_pct: 80,
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
      <div className="mt-1 flex flex-wrap gap-1.5">
        {values.map((v) => {
          const on = selected.some((s) => s.toLowerCase() === v.toLowerCase());
          return (
            <button key={v} type="button" onClick={() => onToggle(v)}>
              <Badge variant={on ? 'default' : 'outline'} className="cursor-pointer capitalize">
                {v.replace(/_/g, ' ')}
              </Badge>
            </button>
          );
        })}
      </div>
      {selected.length === 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">Nothing picked means every {title.toLowerCase()}.</p>
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

  const agents = useMemo(() => {
    const list = options?.agents ?? [];
    const q = agentSearch.trim().toLowerCase();
    if (!q) return list.slice(0, 12);
    return list.filter((a) => (a.full_name ?? '').toLowerCase().includes(q)).slice(0, 12);
  }, [options?.agents, agentSearch]);

  const patch = (index: number, changes: Partial<RegistrationRuleGroup>) =>
    setGroups((prev) => prev.map((g, i) => (i === index ? { ...g, ...changes } : g)));

  const toggleIn = (index: number, key: 'districts' | 'regions' | 'tiers' | 'agent_ids', value: string) =>
    setGroups((prev) =>
      prev.map((g, i) => {
        if (i !== index) return g;
        const current = g[key] ?? [];
        const has = current.some((c) => c.toLowerCase() === value.toLowerCase());
        return { ...g, [key]: has ? current.filter((c) => c.toLowerCase() !== value.toLowerCase()) : [...current, value] };
      }),
    );

  const move = (index: number, delta: number) =>
    setGroups((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Registration rules</DialogTitle>
          <DialogDescription>
            Set the percentage and who each rule applies to. An agent is checked against the first rule that matches
            them, top to bottom.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between rounded-xl border p-3">
          <div>
            <div className="text-sm font-medium">Restriction switched on</div>
            <p className="text-xs text-muted-foreground">
              Switched off, no agent is ever stopped and the report stays visible.
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="space-y-4">
          {groups.map((g, i) => (
            <div key={g.id} className="space-y-3 rounded-xl border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={g.label}
                  onChange={(e) => patch(i, { label: e.target.value })}
                  className="h-9 max-w-[16rem]"
                  placeholder="Rule name"
                />
                <Badge variant="outline">Order {i + 1}</Badge>
                <div className="ml-auto flex items-center gap-1">
                  <Switch checked={g.active} onCheckedChange={(v) => patch(i, { active: v })} />
                  <Button variant="ghost" size="icon" onClick={() => move(i, -1)} disabled={i === 0}>
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => move(i, 1)}
                    disabled={i === groups.length - 1}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
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
                    onChange={(e) => patch(i, { min_active_tenants: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Up to (blank = no limit)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={g.max_active_tenants ?? ''}
                    onChange={(e) =>
                      patch(i, { max_active_tenants: e.target.value === '' ? null : Number(e.target.value) })
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
                    onChange={(e) => patch(i, { required_prev_month_pct: Number(e.target.value) })}
                  />
                </div>
              </div>

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

              <div>
                <Label className="text-xs text-muted-foreground">Hand-picked agents</Label>
                {g.agent_ids.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {g.agent_ids.map((id) => {
                      const a = (options?.agents ?? []).find((x) => x.agent_id === id);
                      return (
                        <button key={id} type="button" onClick={() => toggleIn(i, 'agent_ids', id)}>
                          <Badge className="cursor-pointer">{a?.full_name ?? id.slice(0, 8)} ×</Badge>
                        </button>
                      );
                    })}
                  </div>
                )}
                <Input
                  value={agentSearch}
                  onChange={(e) => setAgentSearch(e.target.value)}
                  placeholder="Search an agent to add"
                  className="mt-2 h-9"
                />
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {agents.map((a) => (
                    <button key={a.agent_id} type="button" onClick={() => toggleIn(i, 'agent_ids', a.agent_id)}>
                      <Badge
                        variant={g.agent_ids.includes(a.agent_id) ? 'default' : 'outline'}
                        className="cursor-pointer"
                      >
                        {a.full_name ?? 'Unnamed'} · {a.active_tenants}
                      </Badge>
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Nothing picked means every agent that matches the rest of this rule.
                </p>
              </div>
            </div>
          ))}

          <Button variant="outline" onClick={() => setGroups((prev) => [...prev, emptyGroup()])}>
            <Plus className="mr-2 h-4 w-4" /> Add a rule
          </Button>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onSave({ enabled, groups })} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save rules
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
