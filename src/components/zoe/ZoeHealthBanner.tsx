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
type ModelDriftAnswer = {
  drift_detected?: unknown;
  checked_count?: unknown;
  mismatched_count?: unknown;
  configured_model_fast?: unknown;
  configured_model_deep?: unknown;
  dominant_gateway_model?: unknown;
  warning_message?: unknown;
};

type HealthAnswer = {
  database_status?: unknown;
  missing_db_objects?: unknown;
  model_drift?: ModelDriftAnswer | null;
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
        const notices: string[] = [];

        if (status && status !== 'ok') {
          const missing = Array.isArray(answer.missing_db_objects)
            ? answer.missing_db_objects.filter((item): item is string => typeof item === 'string')
            : [];
          notices.push(
            missing.length
              ? `The assistant's server reports "${status}" and is missing: ${missing.join(', ')}.`
              : `The assistant's server reports "${status}".`,
          );
        }

        const drift = answer.model_drift;
        if (drift && drift.drift_detected === true) {
          const driftWarning =
            typeof drift.warning_message === 'string' && drift.warning_message.trim()
              ? drift.warning_message.trim()
              : `Model drift detected: live gateway replies (${String(drift.dominant_gateway_model ?? 'unknown')}) do not match staff_assistant_config (${String(drift.configured_model_fast ?? '')} / ${String(drift.configured_model_deep ?? '')}).`;
          notices.push(driftWarning);
        }

        if (notices.length === 0) return;
        setNotice(notices.join(' '));
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
