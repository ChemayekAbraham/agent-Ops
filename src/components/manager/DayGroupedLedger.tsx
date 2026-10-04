import { useState, useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChevronDown, Calendar, ArrowDownLeft, ArrowUpRight, Trash2 } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableFooter } from '@/components/ui/table';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

interface LedgerEntry {
  id: string;
  date: string;
  description: string;
  category: string;
  debit: number;
  credit: number;
  reference: string;
  party: string;
}

interface DayGroup {
  dateKey: string;
  dateLabel: string;
  entries: LedgerEntry[];
  totalDebit: number;
  totalCredit: number;
}

interface DayGroupedLedgerProps {
  entries: LedgerEntry[];
  page: number;
  onRemoveEntry?: (entry: LedgerEntry) => void;
}

const PAGE_SIZE = 50;

export function DayGroupedLedger({ entries, page, onRemoveEntry }: DayGroupedLedgerProps) {
  const [openDays, setOpenDays] = useState<Set<string>>(new Set());

  const dayGroups = useMemo(() => {
    const groups: Record<string, LedgerEntry[]> = {};
    entries.forEach(entry => {
      const dateKey = format(new Date(entry.date), 'yyyy-MM-dd');
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(entry);
    });

    return Object.entries(groups)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([dateKey, dayEntries]): DayGroup => ({
        dateKey,
        dateLabel: format(new Date(dateKey), 'EEEE, dd MMM yyyy'),
        entries: dayEntries,
        totalDebit: dayEntries.reduce((s, e) => s + e.debit, 0),
        totalCredit: dayEntries.reduce((s, e) => s + e.credit, 0),
      }));
  }, [entries]);

  // Initialize: first day open by default
  useState(() => {
    if (dayGroups.length > 0) {
      setOpenDays(new Set([dayGroups[0].dateKey]));
    }
  });

  const toggleDay = (dateKey: string) => {
    setOpenDays(prev => {
      const next = new Set(prev);
      if (next.has(dateKey)) next.delete(dateKey);
      else next.add(dateKey);
      return next;
    });
  };

  const toggleAll = () => {
    if (openDays.size === dayGroups.length) {
      setOpenDays(new Set());
    } else {
      setOpenDays(new Set(dayGroups.map(g => g.dateKey)));
    }
  };

  let runningIndex = page * PAGE_SIZE;

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <button
          onClick={toggleAll}
          className="text-xs text-primary hover:underline"
        >
          {openDays.size === dayGroups.length ? 'Collapse All' : 'Expand All'}
        </button>
      </div>

      {dayGroups.map((group) => {
        const startIndex = runningIndex;
        runningIndex += group.entries.length;
        const isOpen = openDays.has(group.dateKey);

        return (
          <Collapsible
            key={group.dateKey}
            open={isOpen}
            onOpenChange={() => toggleDay(group.dateKey)}
          >
            <Card className="overflow-hidden">
              <CollapsibleTrigger className="w-full">
                <div className="flex items-center justify-between p-3 hover:bg-muted/50 transition-colors cursor-pointer">
                  <div className="flex items-center gap-3">
                    <Calendar className="h-4 w-4 text-primary" />
                    <span className="font-semibold text-sm">{group.dateLabel}</span>
                    <Badge variant="secondary" className="text-[10px]">
                      {group.entries.length} {group.entries.length === 1 ? 'entry' : 'entries'}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-1">
                      <ArrowUpRight className="h-3 w-3 text-destructive" />
                      <span className="text-xs font-medium text-destructive">{formatUGX(group.totalDebit)}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <ArrowDownLeft className="h-3 w-3 text-success" />
                      <span className="text-xs font-medium text-success">{formatUGX(group.totalCredit)}</span>
                    </div>
                    <ChevronDown className={cn(
                      "h-4 w-4 text-muted-foreground transition-transform duration-200",
                      isOpen && "rotate-180"
                    )} />
                  </div>
                </div>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="overflow-x-auto border-t">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead>Time</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead>Ref</TableHead>
                        <TableHead className="text-right">Debit</TableHead>
                        <TableHead className="text-right">Credit</TableHead>
                        {onRemoveEntry && <TableHead className="w-10"></TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.entries.map((entry, i) => (
                        <TableRow key={entry.id}>
                          <TableCell className="text-xs text-muted-foreground">{startIndex + i + 1}</TableCell>
                          <TableCell className="text-xs whitespace-nowrap">
                            {format(new Date(entry.date), 'HH:mm')}
                          </TableCell>
                          <TableCell className="text-xs max-w-[150px] truncate">{entry.description}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-[10px]">{entry.category}</Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{entry.reference}</TableCell>
                          <TableCell className="text-right text-xs font-medium text-destructive">
                            {entry.debit > 0 ? formatUGX(entry.debit) : '-'}
                          </TableCell>
                          <TableCell className="text-right text-xs font-medium text-success">
                            {entry.credit > 0 ? formatUGX(entry.credit) : '-'}
                          </TableCell>
                          {onRemoveEntry && (
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-destructive/60 hover:text-destructive hover:bg-destructive/10"
                                onClick={() => onRemoveEntry(entry)}
                                title="Remove this entry"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                    <TableFooter>
                      <TableRow>
                        <TableCell colSpan={5} className="font-bold text-xs">DAY TOTAL</TableCell>
                        <TableCell className="text-right font-bold text-destructive text-xs">
                          {formatUGX(group.totalDebit)}
                        </TableCell>
                        <TableCell className="text-right font-bold text-success text-xs">
                          {formatUGX(group.totalCredit)}
                        </TableCell>
                        <TableCell className="text-right font-bold text-muted-foreground text-xs">—</TableCell>
                      </TableRow>
                    </TableFooter>
                  </Table>
                </div>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        );
      })}
    </div>
  );
}
