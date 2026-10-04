/**
 * ENGREP window toggle — a three-segment tab strip.
 *
 * Selecting a tab changes which engrep_windows row is loaded, by granularity.
 * Each state holds its own record: a locked day does not lock the week.
 */
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { EngrepGranularity } from '@/hr/engrep/types';

interface WindowToggleProps {
  value: EngrepGranularity;
  onChange: (value: EngrepGranularity) => void;
}

const TABS: Array<{ value: EngrepGranularity; label: string }> = [
  { value: 'day', label: 'DAILY' },
  { value: 'week', label: 'WEEKLY' },
  { value: 'month', label: 'MONTHLY' },
];

export function WindowToggle({ value, onChange }: WindowToggleProps) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as EngrepGranularity)}>
      <TabsList className="grid w-full max-w-md grid-cols-3">
        {TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value} className="text-xs tracking-wide">
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

export default WindowToggle;
