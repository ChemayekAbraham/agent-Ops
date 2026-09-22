/**
 * Summaries — what was actually said, per queue.
 *
 * A call log answers "did we reach them". This answers "and what did they
 * say", which is the only part of a call that survives the day it happened.
 *
 * Only calls carrying a written summary appear. That filter is applied in the
 * database (`p_with_summary_only`) rather than here, because the alternative is
 * fetching two thousand rows to display four — today 4 of 398 calls have been
 * written up.
 *
 * STRUCTURE ONLY. The markup is deliberately plain; styling and layout are
 * Gemini's. The data contract (`useSectionSummaries`) is the part that should
 * not change.
 */
import { useMemo, useState } from 'react';
import { Search, FileText } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useSectionSummaries } from '@/hooks/useCrmCallCentre';
import {
  CALL_SECTION_LABEL,
  formatCallStamp,
  formatTalkTime,
  type CallSection,
} from '@/lib/callCentre';

interface CallCentreSummariesProps {
  section: CallSection;
}

export function CallCentreSummaries({ section }: CallCentreSummariesProps) {
  const { summaries, isLoading, error } = useSectionSummaries(section);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return summaries;
    return summaries.filter(
      (r) =>
        r.calleeName.toLowerCase().includes(q) ||
        (r.summary ?? '').toLowerCase().includes(q) ||
        (r.staffName ?? '').toLowerCase().includes(q),
    );
  }, [summaries, query]);

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load summaries: {error instanceof Error ? error.message : 'unknown error'}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {CALL_SECTION_LABEL[section]} — Call Summaries
          </h2>
          <p className="text-xs text-muted-foreground">
            {isLoading ? 'Loading…' : `${filtered.length} written up in the last 90 days`}
          </p>
        </div>
        <div className="relative w-64 max-w-[50%]">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, staff or text"
            className="pl-8"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <FileText className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No summaries yet</p>
          <p className="text-xs text-muted-foreground">
            {query
              ? 'Nothing matches that search.'
              : 'A summary appears here once staff write one up after a call.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {filtered.map((r) => (
            <li key={r.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.calleeName}</span>
                <Badge variant="outline">{r.calleePhone}</Badge>
                {r.durationSeconds ? (
                  <Badge variant="secondary">{formatTalkTime(r.durationSeconds)}</Badge>
                ) : null}
                <span className="ml-auto text-xs text-muted-foreground">
                  {formatCallStamp(r.calledAt)}
                  {r.staffName ? ` · ${r.staffName}` : ''}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                {r.summary}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default CallCentreSummaries;
