import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { PartnerOpsScoreboard } from './PartnerOpsScoreboard';

/**
 * Data-driven supervision tree. To add a new executive function or a new
 * nested area, append an entry below — no new components required.
 */
interface SupervisionArea {
  id: string;
  title: string;
  /** Key used to look up the red-lead count in the metrics map. */
  metricKey?: string;
  render: () => JSX.Element;
}

interface SupervisionFunction {
  id: string;
  title: string;
  areas: SupervisionArea[];
}

const SUPERVISION_TREE: SupervisionFunction[] = [
  {
    id: 'coo',
    title: 'Chief Operating Officer',
    areas: [
      {
        id: 'partnership-operations',
        title: 'Partnership Operations',
        metricKey: 'partner_ops',
        render: () => <PartnerOpsScoreboard hideTargetEditor />,
      },
    ],
  },
];

const monthStart = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

function useRedCounts() {
  return useQuery({
    queryKey: ['supervision-red-counts', monthStart()],
    queryFn: async () => {
      const counts: Record<string, number> = { partner_ops: 0 };
      const { data, error } = await supabase.rpc('partner_ops_scoreboard', { p_month: monthStart() });
      if (error) throw error;
      counts.partner_ops = ((data || []) as { state: string }[]).filter((r) => r.state === 'red').length;
      return counts;
    },
    staleTime: 120000,
  });
}

const RedBadge = ({ count }: { count: number }) => (
  <span
    className={cn(
      'ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
      count > 0 ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
    )}
  >
    {count} red
  </span>
);

function SectionHeader({ title, count, open }: { title: string; count: number; open: boolean }) {
  return (
    <div
      className={cn(
        'flex w-full items-center gap-2 rounded-xl border border-border bg-card px-3 py-3 text-left',
        count > 0 && 'border-l-4 border-l-destructive',
      )}
    >
      <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      <span className="truncate text-sm font-semibold text-foreground">{title}</span>
      <RedBadge count={count} />
    </div>
  );
}

function AreaBlock({ area, count }: { area: SupervisionArea; count: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full">
        <SectionHeader title={area.title} count={count} open={open} />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">{area.render()}</CollapsibleContent>
    </Collapsible>
  );
}

function FunctionBlock({ fn, counts }: { fn: SupervisionFunction; counts: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  const total = fn.areas.reduce((s, a) => s + (a.metricKey ? counts[a.metricKey] || 0 : 0), 0);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full">
        <SectionHeader title={fn.title} count={total} open={open} />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pl-3 pt-3">
        {fn.areas.map((area) => (
          <AreaBlock key={area.id} area={area} count={area.metricKey ? counts[area.metricKey] || 0 : 0} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SupervisionSections() {
  const { roles } = useAuth();
  const { data: counts } = useRedCounts();
  const allowed = (roles || []).some((r) => r === 'ceo' || r === 'super_admin');
  if (!allowed) return null;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Supervision</h3>
      {SUPERVISION_TREE.map((fn) => (
        <FunctionBlock key={fn.id} fn={fn} counts={counts || {}} />
      ))}
    </div>
  );
}

export default SupervisionSections;
