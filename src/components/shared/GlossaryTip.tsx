import { useQuery } from '@tanstack/react-query';
import { BookOpen, Info } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

interface GlossaryTipProps {
  /** Exact term names (case-insensitive) to surface as tappable chips. */
  terms: string[];
  /** Optional one-liner above the chips. */
  intro?: string;
  className?: string;
}

interface GlossaryRow {
  term: string;
  short: string;
  example: string | null;
}

/**
 * Inline, always-visible glossary chip strip.
 * Shows the requested glossary terms as compact chips that reveal the
 * plain-English definition + example in a popover when tapped.
 *
 * Pulls live from the same `glossary_terms` table the GlossaryButton uses,
 * so any edit Ops makes flows here automatically — no redeploy needed.
 */
export function GlossaryTip({ terms, intro, className }: GlossaryTipProps) {
  const lowered = terms.map((t) => t.toLowerCase());

  const { data = [] } = useQuery({
    queryKey: ['glossary-tip', lowered.join('|')],
    queryFn: async (): Promise<GlossaryRow[]> => {
      const { data, error } = await supabase
        .from('glossary_terms')
        .select('term, short, example')
        .eq('is_active', true);
      if (error) throw error;
      // Filter + order to match the requested list.
      const map = new Map(
        (data || []).map((r) => [r.term.toLowerCase(), r as GlossaryRow]),
      );
      return lowered
        .map((l) => map.get(l))
        .filter((r): r is GlossaryRow => !!r);
    },
    staleTime: 5 * 60_000,
  });

  if (data.length === 0) return null;

  return (
    <div
      className={cn(
        'rounded-xl border border-primary/20 bg-primary/5 p-3 space-y-2',
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
        <BookOpen className="h-3 w-3" />
        Quick glossary
      </div>
      {intro && <p className="text-xs text-muted-foreground">{intro}</p>}
      <div className="flex flex-wrap gap-1.5">
        {data.map((t) => (
          <Popover key={t.term}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-medium hover:bg-accent hover:text-accent-foreground transition"
              >
                <Info className="h-3 w-3 text-primary" />
                {t.term}
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              className="w-72 text-sm space-y-1.5"
            >
              <div className="font-semibold">{t.term}</div>
              <p className="text-muted-foreground leading-relaxed">{t.short}</p>
              {t.example && (
                <p className="text-xs pl-2 border-l-2 border-primary/40">
                  <span className="font-semibold">Example:</span> {t.example}
                </p>
              )}
            </PopoverContent>
          </Popover>
        ))}
      </div>
    </div>
  );
}
