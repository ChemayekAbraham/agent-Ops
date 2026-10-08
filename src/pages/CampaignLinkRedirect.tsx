import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import NotFound from './NotFound';
import ScreenLoader from '@/components/common/ScreenLoader';

const CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;
const GPS_WAIT_MS = 8000;
// One logged click per page load, even if the effect runs twice.
const started = new Set<string>();

type GpsResult = { status: 'granted' | 'denied' | 'unavailable' | 'timeout' | 'unsupported'; gps?: { lat: number; lng: number; accuracy: number } };

function askGps(): Promise<GpsResult> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve({ status: 'unsupported' });
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve({ status: 'timeout' }), GPS_WAIT_MS);
    navigator.geolocation.getCurrentPosition(
      (p) => { window.clearTimeout(timer); resolve({ status: 'granted', gps: { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy } }); },
      (e) => { window.clearTimeout(timer); resolve({ status: e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable' }); },
      { enableHighAccuracy: true, timeout: GPS_WAIT_MS - 500, maximumAge: 60000 },
    );
  });
}

/** Tenant campaign short link: welileapp.com/n/{code}. Logs the click (device, IP, GPS if allowed), then opens the form. */
export default function CampaignLinkRedirect() {
  const { code = '' } = useParams();
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!CODE_RE.test(code)) { setMissing(true); return; }
    if (started.has(code)) return;
    started.add(code);
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.functions.invoke('tenant-campaign-click', {
        body: { code, referrer: document.referrer || null },
      });
      if (error || !data?.destination) { setMissing(true); return; }
      const gps = await askGps();
      if (data.click_id) {
        await supabase.functions.invoke('tenant-campaign-click', {
          body: { code, phase: 'gps', click_id: data.click_id, gps_status: gps.status, gps: gps.gps ?? null },
        }).catch(() => null);
      }
      window.location.replace(data.destination);
    })();
  }, [code]);

  if (missing) return <NotFound />;
  return <ScreenLoader />;
}
