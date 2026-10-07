import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { count } from '@/lib/awarenessMonitoringLabels';

export const PAGE_SIZE = 25;

/** "knew / heard / did not know" written compactly: "3 / 2 / 1". */
export const triple = (a: number | null | undefined, b: number | null | undefined, c: number | null | undefined) =>
  `${count(a)} / ${count(b)} / ${count(c)}`;

export function Pager({
  page, total, pageSize = PAGE_SIZE, onPage, noun = 'rows',
}: { page: number; total: number; pageSize?: number; onPage: (p: number) => void; noun?: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{count(from)} to {count(to)} of {count(total)} {noun}</span>
      <div className="flex items-center gap-1.5">
        <Button type="button" variant="outline" size="sm" className="h-9 w-9 p-0" aria-label="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="tabular-nums">Page {page + 1} of {pages}</span>
        <Button type="button" variant="outline" size="sm" className="h-9 w-9 p-0" aria-label="Next page" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
