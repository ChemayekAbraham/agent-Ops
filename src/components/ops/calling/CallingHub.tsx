import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { PhoneCall } from 'lucide-react';
import { toast } from 'sonner';
import { useCcCallingHub, type CcRow, type CcSubjectType } from '@/hooks/useCcCallingHub';
import { CALLING_TABS, type CallingTabKey } from './callingHubColumns';
import { CallingHubTable } from './CallingHubTable';
import { OpenAttemptQueue } from './OpenAttemptQueue';
import { RecordOutcomeDialog } from './RecordOutcomeDialog';
import { CycleControls } from './CycleControls';
import { FollowupsDuePanel } from './FollowupsDuePanel';

const TITLE: Record<CcSubjectType, string> = {
  tenant: 'Tenant Calling Hub',
  landlord: 'Landlord Calling Hub',
  agent: 'Agent Calling Hub',
};

/**
 * One component for all three subject types. Do not fork it per docket.
 */
export function CallingHub({ subjectType }: { subjectType: CcSubjectType }) {
  const hub = useCcCallingHub(subjectType);
  const [tab, setTab] = useState<CallingTabKey>('to_call');
  const [search, setSearch] = useState('');
  const [revealed, setRevealed] = useState<Record<string, string | null>>({});
  const [formAttempt, setFormAttempt] = useState<{ id: string; cycle_row_id: string; name: string } | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return hub.rows.filter(
      (r) => r.state === tab && (!q || r.name.toLowerCase().includes(q) || (r.district ?? '').toLowerCase().includes(q)),
    );
  }, [hub.rows, tab, search]);

  const handleReveal = (row: CcRow) => {
    hub.reveal.mutate(
      { id: row.id, subject_id: row.subject_id },
      {
        onSuccess: ({ phone }) => {
          setRevealed((r) => ({ ...r, [row.id]: phone }));
          toast.success(phone ? `Number revealed: ${phone}` : 'Attempt opened, but no number is on file.');
        },
        onError: (e) => toast.error((e as Error).message),
      },
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <PhoneCall className="h-4 w-4 text-primary" />
          {TITLE[subjectType]}
        </h2>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or district"
          className="h-8 w-full max-w-xs text-xs"
        />
      </div>

      <CycleControls hub={hub} />

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-1 space-y-3">
          <OpenAttemptQueue hub={hub} onOpenForm={setFormAttempt} />
          <FollowupsDuePanel hub={hub} />
        </div>

        <Card className="rounded-2xl border-border/60 p-2 sm:p-3 lg:col-span-2">
          {!hub.cycle ? (
            <p className="p-6 text-center text-xs text-muted-foreground">
              No open calling cycle for {subjectType}s. Open one from the cycle controls.
            </p>
          ) : (
            <Tabs value={tab} onValueChange={(v) => setTab(v as CallingTabKey)}>
              <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-transparent p-0">
                {CALLING_TABS.map((t) => (
                  <TabsTrigger key={t.key} value={t.key} className="h-8 gap-1.5 text-xs data-[state=active]:bg-muted">
                    {t.label}
                    <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                      {hub.counts[t.key]}
                    </Badge>
                  </TabsTrigger>
                ))}
              </TabsList>

              {CALLING_TABS.map((t) => (
                <TabsContent key={t.key} value={t.key} className="mt-2">
                  {hub.isLoading ? (
                    <div className="space-y-2 p-2">
                      <Skeleton className="h-6 w-full" />
                      <Skeleton className="h-6 w-full" />
                      <Skeleton className="h-6 w-full" />
                    </div>
                  ) : (
                    <CallingHubTable
                      columns={t.columns}
                      rows={filtered}
                      revealed={revealed}
                      revealing={hub.reveal.isPending}
                      wipBlocked={hub.wipBlocked}
                      onReveal={handleReveal}
                    />
                  )}
                </TabsContent>
              ))}
            </Tabs>
          )}
        </Card>
      </div>

      <RecordOutcomeDialog hub={hub} attempt={formAttempt} onClose={() => setFormAttempt(null)} />
    </div>
  );
}

export default CallingHub;
