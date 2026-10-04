import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type CarriedOutcome = 'done' | 'partly_done' | 'not_done';

export interface CarriedActionRow {
  id: string;
  item_text: string;
  owner: string;
  due_date: string;
  /** True when this item was already recorded not done in the period before the prior one. */
  repeatNotDone: boolean;
}

export interface CarriedCloseOut {
  outcome: CarriedOutcome | null;
  result: string;
}

export function carriedCloseOutComplete(closeOut: CarriedCloseOut | undefined): boolean {
  if (!closeOut) return false;
  return Boolean(closeOut.outcome) && closeOut.result.trim().length > 0;
}

const OUTCOME_LABEL: Record<CarriedOutcome, string> = {
  done: 'Done',
  partly_done: 'Partly done',
  not_done: 'Not done',
};

interface CarriedActionsProps {
  submitted: boolean;
  rows: CarriedActionRow[];
  closeOuts: Record<string, CarriedCloseOut>;
  onChange: (id: string, patch: Partial<CarriedCloseOut>) => void;
}

export function CarriedActions({ submitted, rows, closeOuts, onChange }: CarriedActionsProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Carried actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No actions were carried from the previous period.
          </p>
        ) : (
          rows.map((row) => {
            const closeOut = closeOuts[row.id] ?? { outcome: null, result: '' };
            const flagRepeat =
              row.repeatNotDone ||
              (closeOut.outcome === 'not_done' && row.repeatNotDone === true);
            return (
              <div key={row.id} className="space-y-2 rounded-md border border-border p-3 shadow-sm sm:shadow-none">
                <p className="break-words text-sm text-foreground">{row.item_text}</p>
                <p className="text-xs text-muted-foreground">
                  {row.owner} · due {row.due_date}
                </p>
                {flagRepeat && closeOut.outcome === 'not_done' && (
                  <p className="text-xs font-medium text-amber-600 dark:text-amber-500">
                    Not done in two consecutive periods — due for reviewer attention.
                  </p>
                )}
                {submitted ? (
                  <p className="break-words text-sm text-foreground">
                    {closeOut.outcome ? OUTCOME_LABEL[closeOut.outcome] : '—'}
                    {closeOut.result ? ` · ${closeOut.result}` : ''}
                  </p>
                ) : (
                  <div className="grid gap-2 md:grid-cols-2">
                    <Select
                      value={closeOut.outcome ?? ''}
                      onValueChange={(value) =>
                        onChange(row.id, { outcome: value as CarriedOutcome })
                      }
                    >
                      <SelectTrigger className="h-11 w-full sm:h-10">
                        <SelectValue placeholder="Outcome" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="done">Done</SelectItem>
                        <SelectItem value="partly_done">Partly done</SelectItem>
                        <SelectItem value="not_done">Not done</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      value={closeOut.result}
                      onChange={(e) => onChange(row.id, { result: e.target.value })}
                      placeholder="Result, one line"
                      className="h-11 w-full sm:h-10"
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
