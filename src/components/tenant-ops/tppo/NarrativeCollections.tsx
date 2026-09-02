import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { TppoGranularity } from './PeriodToggle';

export const MIN_NOTE_CHARS = 80;

export interface DraftAction {
  key: string;
  item_text: string;
  owner_staff_id: string | null;
  owner_label: string;
  due_date: string;
}

export function collapse(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function noteLength(value: string): number {
  return value.trim().length;
}

export function noteMatchesPrior(value: string, priorNote: string | null): boolean {
  if (!priorNote) return false;
  return collapse(value).toLowerCase() === collapse(priorNote).toLowerCase();
}

export function actionIsComplete(action: DraftAction): boolean {
  const hasOwner = Boolean(action.owner_staff_id) || collapse(action.owner_label).length > 0;
  return collapse(action.item_text).length > 0 && hasOwner && Boolean(action.due_date);
}

const ACTION_HEADING: Record<TppoGranularity, string> = {
  day: 'Actions for tomorrow',
  week: 'Actions for next week',
  month: 'Actions for next month',
};

interface StaffOption {
  id: string;
  label: string;
}

function useStaffOptions() {
  return useQuery({
    queryKey: ['tppo-staff-picker'],
    queryFn: async (): Promise<StaffOption[]> => {
      const { data: staff, error: staffError } = await supabase
        .from('hr_staff')
        .select('id, staff_ref, user_id')
        .eq('active', true)
        .order('staff_ref', { ascending: true });
      if (staffError) throw staffError;
      const rows = staff ?? [];
      const userIds = rows.map((r) => r.user_id).filter((id): id is string => Boolean(id));
      const names = new Map<string, string>();
      if (userIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', userIds);
        (profiles ?? []).forEach((p) => {
          if (p.full_name) names.set(p.id, p.full_name);
        });
      }
      return rows.map((r) => ({
        id: r.id,
        label: r.user_id ? (names.get(r.user_id) ?? r.staff_ref) : r.staff_ref,
      }));
    },
    staleTime: 5 * 60 * 1000,
  });
}

interface NarrativeCollectionsProps {
  granularity: TppoGranularity;
  submitted: boolean;
  note: string;
  onNoteChange: (value: string) => void;
  priorNote: string | null;
  submittedNote: string | null;
  actions: DraftAction[];
  onActionsChange: (actions: DraftAction[]) => void;
  submittedActions: Array<{ item_text: string; owner: string; due_date: string }>;
}

export function NarrativeCollections({
  granularity,
  submitted,
  note,
  onNoteChange,
  priorNote,
  submittedNote,
  actions,
  onActionsChange,
  submittedActions,
}: NarrativeCollectionsProps) {
  const staffQuery = useStaffOptions();
  const length = noteLength(note);
  const duplicate = useMemo(() => noteMatchesPrior(note, priorNote), [note, priorNote]);

  if (submitted) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Why these numbers</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-foreground">
              {submittedNote ?? '—'}
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              This report is submitted. Corrections are made by dated addendum.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{ACTION_HEADING[granularity]}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {submittedActions.length === 0 ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : (
              submittedActions.map((a, i) => (
                <div key={i} className="rounded-md border border-border p-3 text-sm">
                  <p className="text-foreground">{a.item_text}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.owner} · due {a.due_date}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const updateAction = (key: string, patch: Partial<DraftAction>) => {
    onActionsChange(actions.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Why these numbers</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            rows={5}
            className="min-h-[180px] w-full sm:min-h-0"
            placeholder="Explain what drove the collected figure in this period."
          />
          <p className="text-xs text-muted-foreground">
            {length} characters (minimum {MIN_NOTE_CHARS} after trimming)
          </p>
          {duplicate && (
            <p className="text-xs text-destructive">
              This is identical to the previous period's note for this granularity, after trimming
              and collapsing whitespace. Write an explanation for this period.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">{ACTION_HEADING[granularity]}</CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onActionsChange([
                ...actions,
                {
                  key: `${Date.now()}-${actions.length}`,
                  item_text: '',
                  owner_staff_id: null,
                  owner_label: '',
                  due_date: '',
                },
              ])
            }
          >
            Add action
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {actions.length === 0 && (
            <p className="text-sm text-muted-foreground">
              At least one action is required before this report can be submitted.
            </p>
          )}
          {actions.map((action) => (
            <div key={action.key} className="space-y-2 rounded-md border border-border p-3">
              <Input
                value={action.item_text}
                onChange={(e) => updateAction(action.key, { item_text: e.target.value })}
                placeholder="What will be done"
                className="h-11 w-full sm:h-10"
              />
              <div className="grid gap-2 md:grid-cols-2">
                <Select
                  value={action.owner_staff_id ?? 'free-text'}
                  onValueChange={(value) =>
                    updateAction(action.key, {
                      owner_staff_id: value === 'free-text' ? null : value,
                    })
                  }
                >
                  <SelectTrigger className="h-11 w-full sm:h-10">
                    <SelectValue placeholder="Owner" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="free-text">Owner not on staff (type below)</SelectItem>
                    {(staffQuery.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="date"
                  value={action.due_date}
                  onChange={(e) => updateAction(action.key, { due_date: e.target.value })}
                  className="h-11 w-full sm:h-10"
                />
              </div>
              {!action.owner_staff_id && (
                <Input
                  value={action.owner_label}
                  onChange={(e) => updateAction(action.key, { owner_label: e.target.value })}
                  placeholder="Owner name"
                  className="h-11 w-full sm:h-10"
                />
              )}
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onActionsChange(actions.filter((a) => a.key !== action.key))}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
