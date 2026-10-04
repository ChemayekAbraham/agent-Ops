import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import NotFound from './NotFound';
import ScreenLoader from '@/components/common/ScreenLoader';

const CODE_RE = /^[A-Za-z0-9]{4,8}$/;

export default function TrackedRedirect() {
  const { code } = useParams<{ code: string }>();
  const [notFound, setNotFound] = useState(false);
  const isValidCode = !!code && CODE_RE.test(code);

  useEffect(() => {
    if (!isValidCode || !code) return;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .rpc('resolve_short_link', { p_code: code })
        .maybeSingle();

      if (cancelled) return;

      if (error || !data) {
        setNotFound(true);
        return;
      }

      // Fire-and-forget click tracking — don't block the redirect
      try {
        await supabase.rpc('record_short_link_click', {
          p_code: code,
          p_user_agent: navigator.userAgent ?? null,
          p_referrer: document.referrer ?? null,
        });
      } catch {
        // ignore tracking errors
      }

      const params = new URLSearchParams();
      const tp = (data.target_params ?? {}) as Record<string, string>;
      Object.entries(tp).forEach(([k, v]) => params.set(k, String(v)));
      const qs = params.toString();
      const fullUrl = qs ? `${data.target_path}?${qs}` : data.target_path;
      window.location.replace(`${window.location.origin}${fullUrl}`);
    })();

    return () => {
      cancelled = true;
    };
  }, [code, isValidCode]);

  if (!isValidCode || notFound) return <NotFound />;

  return (
    <ScreenLoader />
  );
}
