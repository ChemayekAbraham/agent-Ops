import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface ControlRow {
  control_key: string;
  enabled: boolean;
  value: string | null;
}

export default function MaintenanceLockScreen() {
  const [active, setActive] = useState(false);
  const [bypass, setBypass] = useState(false);
  const [queryBypass, setQueryBypass] = useState(false);
  const [message, setMessage] = useState(
    'Welile is currently under scheduled maintenance. All services are temporarily unavailable as we complete system improvements and reconciliation. Normal operations will resume shortly.',
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from('treasury_controls')
        .select('control_key, enabled, value')
        .in('control_key', ['maintenance_mode', 'maintenance_message']);
      if (cancelled || !data) return;
      const rows = data as ControlRow[];
      const mode = rows.find((r) => r.control_key === 'maintenance_mode');
      const msg = rows.find((r) => r.control_key === 'maintenance_message');
      setActive(!!mode?.enabled);
      if (msg?.value) setMessage(msg.value);
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Query-string bypass: ?admin=c10 reveals the underlying page (typically
  // /auth) so a privileged operator can sign in even while maintenance mode
  // is on. Persisted to sessionStorage so the bypass survives navigations
  // within the same tab.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('admin') === 'c10') {
        sessionStorage.setItem('welile.maintenance.bypass', '1');
        setQueryBypass(true);
        return;
      }
      if (sessionStorage.getItem('welile.maintenance.bypass') === '1') {
        setQueryBypass(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // CTO (and super_admin) bypass — they need access during maintenance to
  // diagnose and resolve the very issue that triggered the lock.
  useEffect(() => {
    let cancelled = false;
    const checkBypass = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        if (!cancelled) setBypass(false);
        return;
      }
      const { data } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .in('role', ['cto', 'super_admin']);
      if (!cancelled) setBypass(!!data && data.length > 0);
    };
    checkBypass();
    const t = setInterval(checkBypass, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (!active || bypass || queryBypass) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-purple-700 text-white px-6 py-10 overflow-auto"
    >
      <div className="max-w-lg w-full text-center space-y-6">
        <div className="mx-auto h-20 w-20 rounded-full bg-white/15 flex items-center justify-center backdrop-blur">
          <Lock className="h-10 w-10" />
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
          Welile is under maintenance
        </h1>
        <p className="text-base sm:text-lg text-white/90 leading-relaxed">
          {message}
        </p>
        <div className="text-sm sm:text-base text-white/95 leading-relaxed space-y-2 bg-white/10 rounded-xl p-4 backdrop-blur">
          <p className="font-semibold uppercase tracking-wider text-xs text-white/80">
            For assistance or urgent inquiries
          </p>
          <p>
            <span className="font-semibold">Agents:</span> Contact Grace Paul at{' '}
            <a href="tel:+256700212384" className="underline font-semibold">
              +256 700 212384
            </a>
          </p>
          <p>
            <span className="font-semibold">Partners &amp; Funders:</span> Contact Joseph at{' '}
            <a href="tel:+256751424629" className="underline font-semibold">
              +256 751 424629
            </a>
          </p>
        </div>
        <p className="text-sm text-white/80 italic">
          Thank you for your patience and understanding.
        </p>
        <div className="text-xs uppercase tracking-[0.25em] text-white/70">
          All dashboards · sign-ins · sign-ups · transactions are locked
        </div>
      </div>
    </div>
  );
}