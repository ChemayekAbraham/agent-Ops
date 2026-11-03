import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Reports only what the assistant's own server says about itself.
 *
 * The `staff-assistant` function answers with a `database_status` field. When
 * that answer is anything other than healthy we surface a short notice; when
 * the function does not answer, or answers healthily, nothing is rendered.
 * Nothing here is estimated, inferred, or filled in locally.
 */
type HealthAnswer = {
  database_status?: unknown;
  missing_db_objects?: unknown;
};

export function ZoeHealthBanner() {
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('staff-assistant', {
          body: { action: 'health' },
        });
        if (cancelled || error) return;

        const answer = (data ?? {}) as HealthAnswer;
        const status = typeof answer.database_status === 'string' ? answer.database_status : '';
        if (!status || status === 'ok') return;

        const missing = Array.isArray(answer.missing_db_objects)
          ? answer.missing_db_objects.filter((item): item is string => typeof item === 'string')
          : [];

        setNotice(
          missing.length
            ? `The assistant's server reports "${status}" and is missing: ${missing.join(', ')}.`
            : `The assistant's server reports "${status}".`,
        );
      } catch {
        // No answer from the server: say nothing rather than guess.
      }
    })();

    return () => { cancelled = true; };
  }, []);

  if (!notice) return null;

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{notice}</span>
    </div>
  );
}

export default ZoeHealthBanner;
