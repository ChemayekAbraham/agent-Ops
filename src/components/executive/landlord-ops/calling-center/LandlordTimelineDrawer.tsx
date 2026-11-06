import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import {
  CheckCircle2,
  Clock,
  FileCheck2,
  Headphones,
  Loader2,
  MessageSquare,
  PhoneCall,
  ShieldCheck,
  Sparkles,
  User,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { useCcSubjectCallHistory } from '@/hooks/useCcSubjectCallHistory';
import { formatUGX } from '@/lib/rentCalculations';
import { CcEmptyState, CcPill, formatHumanLabel } from './ccUi';

export interface LandlordTimelineDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subjectId: string | null;
  landlordId?: string | null;
  userId?: string | null;
  landlordName?: string | null;
  phones?: string[] | null;
}

type TimelineSource = 'all' | 'calling_center' | 'awareness' | 'verification';

interface UnifiedTimelineItem {
  id: string;
  source: Exclude<TimelineSource, 'all'>;
  occurredAt: string;
  title: string;
  outcomeLabel: string;
  callerName: string | null;
  phone: string | null;
  notes: string | null;
  meta?: string | null;
  tone: 'emerald' | 'primary' | 'amber' | 'violet' | 'slate';
}

export function LandlordTimelineDrawer({
  open,
  onOpenChange,
  subjectId,
  landlordId,
  userId,
  landlordName,
  phones,
}: LandlordTimelineDrawerProps) {
  const [filter, setFilter] = useState<TimelineSource>('all');
  const effectiveLandlordId = landlordId ?? subjectId;

  // 1. Calling Center history via existing hook
  const ccHistory = useCcSubjectCallHistory('landlord', subjectId, open);

  // 2. Awareness calls & Verification calls for this landlord
  const extraHistory = useQuery({
    queryKey: ['landlord-timeline-extra', effectiveLandlordId, userId, phones],
    enabled: open && Boolean(effectiveLandlordId || userId),
    staleTime: 20_000,
    queryFn: async () => {
      let rentPlans: any[] = [];
      if (effectiveLandlordId) {
        const { data } = await supabase
          .from('rent_requests')
          .select(
            'id, rent_amount, status, landlord_called, landlord_called_at, landlord_called_by, landlord_call_notes, created_at',
          )
          .eq('landlord_id', effectiveLandlordId)
          .order('created_at', { ascending: false })
          .limit(50);
        rentPlans = data ?? [];
      }

      let landlordRec: any = null;
      if (effectiveLandlordId) {
        const { data } = await supabase
          .from('landlords')
          .select('id, name, phone, verified, verified_at, verified_by, created_at')
          .eq('id', effectiveLandlordId)
          .maybeSingle();
        landlordRec = data;
      }

      const planIds = rentPlans.map((p) => p.id).filter(Boolean);
      const awarenessMap = new Map<string, any>();

      if (planIds.length > 0) {
        const { data } = await (supabase as any)
          .from('rent_pipeline_awareness_calls')
          .select(
            'id, rent_request_id, subject_type, answered, aware_of_welile, consents_to_program, aware_payout_otp, call_summary, called_by_name, created_at, phone_called',
          )
          .eq('subject_type', 'landlord')
          .in('rent_request_id', planIds)
          .order('created_at', { ascending: false })
          .limit(50);
        for (const row of data ?? []) awarenessMap.set(row.id, row);
      }

      if (userId) {
        const { data } = await (supabase as any)
          .from('rent_pipeline_awareness_calls')
          .select(
            'id, rent_request_id, subject_type, answered, aware_of_welile, consents_to_program, aware_payout_otp, call_summary, called_by_name, created_at, phone_called',
          )
          .eq('subject_type', 'landlord')
          .eq('subject_user_id', userId)
          .order('created_at', { ascending: false })
          .limit(50);
        for (const row of data ?? []) awarenessMap.set(row.id, row);
      }

      return {
        rentPlans,
        landlordRec,
        awarenessCalls: Array.from(awarenessMap.values()),
      };
    },
  });

  const items = useMemo<UnifiedTimelineItem[]>(() => {
    const list: UnifiedTimelineItem[] = [];

    // Calling Center attempts
    for (const row of ccHistory.data ?? []) {
      const outcome = row.categoryLabel || row.outcome || 'called';
      const when = row.recordedAt || row.revealedAt;
      list.push({
        id: `cc-${row.id}`,
        source: 'calling_center',
        occurredAt: when,
        title: `Calling Center Attempt #${row.attemptNo}`,
        outcomeLabel: formatHumanLabel(outcome),
        callerName: row.officerName ?? null,
        phone: null,
        notes: row.comment || row.voidReason || null,
        meta: row.severity ? `Priority: ${formatHumanLabel(row.severity)}` : null,
        tone:
          row.outcome === 'engaged'
            ? 'emerald'
            : row.severity === 'high' || row.severity === 'critical'
              ? 'amber'
              : 'primary',
      });
    }

    // Awareness calls
    for (const aw of extraHistory.data?.awarenessCalls ?? []) {
      const outcomeParts: string[] = [];
      if (aw.answered) outcomeParts.push('Answered');
      else outcomeParts.push('Not Answered');
      if (aw.consents_to_program === 'yes') outcomeParts.push('Consented to Program');
      if (aw.aware_payout_otp === 'yes') outcomeParts.push('Confirmed Payout Security');

      list.push({
        id: `aw-${aw.id}`,
        source: 'awareness',
        occurredAt: aw.created_at,
        title: 'Rent Plan Awareness Call',
        outcomeLabel: outcomeParts.join(' · ') || 'Recorded',
        callerName: aw.called_by_name ?? null,
        phone: aw.phone_called ?? null,
        notes: aw.call_summary ?? null,
        meta: aw.aware_of_welile
          ? `Aware of Welile: ${formatHumanLabel(String(aw.aware_of_welile))}`
          : null,
        tone: aw.answered ? 'violet' : 'slate',
      });
    }

    // Verification calls on Rent Plans
    for (const rp of extraHistory.data?.rentPlans ?? []) {
      if (rp.landlord_called || rp.landlord_called_at) {
        const when = rp.landlord_called_at || rp.created_at;
        list.push({
          id: `ver-rp-${rp.id}`,
          source: 'verification',
          occurredAt: when,
          title: 'Rent Plan Verification Call',
          outcomeLabel: 'Landlord Verified on Rent Plan',
          callerName: null,
          phone: null,
          notes: rp.landlord_call_notes ?? null,
          meta: rp.rent_amount ? `Rent Plan amount: ${formatUGX(Number(rp.rent_amount))}` : null,
          tone: 'emerald',
        });
      }
    }

    // Landlord profile verification
    const lr = extraHistory.data?.landlordRec;
    if (lr?.verified && lr?.verified_at) {
      list.push({
        id: `ver-ll-${lr.id}`,
        source: 'verification',
        occurredAt: lr.verified_at,
        title: 'Landlord Registry Verification',
        outcomeLabel: 'Verified Landlord Profile',
        callerName: null,
        phone: lr.phone ?? null,
        notes: 'Landlord ownership and details verified by Landlord Ops.',
        meta: null,
        tone: 'emerald',
      });
    }

    return list.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
  }, [ccHistory.data, extraHistory.data]);

  const filteredItems = useMemo(() => {
    if (filter === 'all') return items;
    return items.filter((i) => i.source === filter);
  }, [items, filter]);

  const counts = useMemo(() => {
    return {
      all: items.length,
      calling_center: items.filter((i) => i.source === 'calling_center').length,
      awareness: items.filter((i) => i.source === 'awareness').length,
      verification: items.filter((i) => i.source === 'verification').length,
    };
  }, [items]);

  const isLoading = ccHistory.isLoading || extraHistory.isLoading;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg p-0 flex flex-col">
        <SheetHeader className="px-5 pt-5 pb-3 border-b bg-muted/20 text-left">
          <div className="flex items-center gap-2">
            <span className="h-9 w-9 rounded-xl bg-primary/12 text-primary flex items-center justify-center">
              <Clock className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <SheetTitle className="text-base truncate">
                Call Timeline — {landlordName || 'Landlord'}
              </SheetTitle>
              <SheetDescription className="text-xs">
                Unified call log across Calling Center, Awareness Calls, and Verification Calls.
              </SheetDescription>
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap pt-2">
            {(
              [
                { key: 'all', label: 'All Calls', count: counts.all },
                { key: 'calling_center', label: 'Calling Center', count: counts.calling_center },
                { key: 'awareness', label: 'Awareness', count: counts.awareness },
                { key: 'verification', label: 'Verification', count: counts.verification },
              ] as const
            ).map((tab) => (
              <Button
                key={tab.key}
                type="button"
                size="sm"
                variant={filter === tab.key ? 'default' : 'outline'}
                className="h-7 text-xs px-2.5 gap-1.5"
                onClick={() => setFilter(tab.key)}
              >
                {tab.label}
                <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                  {tab.count}
                </Badge>
              </Button>
            ))}
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 px-5 py-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-xs text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading landlord call timeline…
            </div>
          ) : filteredItems.length === 0 ? (
            <CcEmptyState
              icon={PhoneCall}
              title="No calls recorded in this view"
              description="Calls made from the Landlord Calling Center, Rent Plan awareness checks, and verification reviews will appear here chronologically."
            />
          ) : (
            <ol className="relative border-l border-border/70 ml-3 space-y-4">
              {filteredItems.map((item) => {
                const SourceIcon =
                  item.source === 'calling_center'
                    ? Headphones
                    : item.source === 'awareness'
                      ? Sparkles
                      : ShieldCheck;
                const sourceBadgeLabel =
                  item.source === 'calling_center'
                    ? 'Calling Center'
                    : item.source === 'awareness'
                      ? 'Awareness Call'
                      : 'Verification Call';

                return (
                  <li key={item.id} className="ml-4">
                    <span className="absolute -left-2.5 flex h-5 w-5 items-center justify-center rounded-full bg-background ring-2 ring-border">
                      <SourceIcon className="h-3 w-3 text-primary" />
                    </span>
                    <div className="rounded-xl border border-border/70 bg-card p-3 shadow-2xs space-y-1.5">
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-foreground">{item.title}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {format(new Date(item.occurredAt), 'dd MMM yyyy · HH:mm')} (
                            {formatDistanceToNow(new Date(item.occurredAt), { addSuffix: true })})
                          </div>
                        </div>
                        <CcPill tone={item.tone}>{sourceBadgeLabel}</CcPill>
                      </div>

                      <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                        <Badge variant="outline" className="text-[11px] gap-1">
                          <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                          {item.outcomeLabel}
                        </Badge>
                        {item.callerName && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                            <User className="h-3 w-3" /> {item.callerName}
                          </span>
                        )}
                        {item.phone && (
                          <span className="text-[11px] font-mono text-muted-foreground">
                            {item.phone}
                          </span>
                        )}
                      </div>

                      {item.notes && (
                        <div className="rounded-lg bg-muted/40 px-2.5 py-1.5 text-xs text-foreground flex items-start gap-1.5">
                          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                          <span className="whitespace-pre-wrap">{item.notes}</span>
                        </div>
                      )}

                      {item.meta && (
                        <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                          <FileCheck2 className="h-3 w-3" /> {item.meta}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
