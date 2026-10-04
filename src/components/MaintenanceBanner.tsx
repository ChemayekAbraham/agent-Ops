import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface ControlRow {
  control_key: string;
  enabled: boolean;
  value: string | null;
}

function formatRemaining(until: Date): string {
  const ms = until.getTime() - Date.now();
  if (ms <= 0) return 'shortly';
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    return `${h}h ${mins % 60}m`;
  }
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export default function MaintenanceBanner() {
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState('');
  const [until, setUntil] = useState<Date | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const { data } = await supabase
        .from('treasury_controls')
        .select('control_key, enabled, value')
        .in('control_key', ['maintenance_mode', 'maintenance_until', 'maintenance_message']);

      if (cancelled || !data) return;

      const rows = data as ControlRow[];
      const mode = rows.find((r) => r.control_key === 'maintenance_mode');
      const untilRow = rows.find((r) => r.control_key === 'maintenance_until');
      const msgRow = rows.find((r) => r.control_key === 'maintenance_message');

      const untilDate = untilRow?.value ? new Date(untilRow.value) : null;
      const isActive =
        !!mode?.enabled && (!untilDate || untilDate.getTime() > Date.now());

      setActive(isActive);
      setUntil(untilDate);
      setMessage(
        msgRow?.value ??
          'Welile is under scheduled maintenance. Service resumes shortly.',
      );
    };

    load();
    const refetch = setInterval(load, 60_000);
    const tick = setInterval(() => force((n) => n + 1), 1000);

    return () => {
      cancelled = true;
      clearInterval(refetch);
      clearInterval(tick);
    };
  }, []);

  if (!active) return null;

  return (
    <div
      role="alert"
      className="fixed top-0 left-0 right-0 z-[200] w-full bg-purple-700 text-white px-4 py-2.5 text-center text-sm font-medium shadow-lg flex items-center justify-center gap-2"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 animate-pulse" />
      <span className="truncate">
        <strong className="uppercase tracking-wider mr-2">Maintenance:</strong>
        {message}
        {until && (
          <span className="ml-2 opacity-90">
            (resumes in <strong>{formatRemaining(until)}</strong>)
          </span>
        )}
      </span>
    </div>
  );
}
