import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

const DEVICE_ID_KEY = 'welile_device_id';
const DEVICE_LABEL_KEY = 'welile_device_label';
// A device is considered "active" if seen within this window
const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
// Heartbeat interval — keep lean for scale
const HEARTBEAT_MS = 2 * 60 * 1000; // 2 minutes
const MAX_DEVICE_LABEL_LENGTH = 40;

export interface DeviceSession {
  id: string;
  device_id: string;
  device_label: string | null;
  user_agent: string | null;
  last_seen_at: string;
  isCurrent: boolean;
  isActive: boolean;
}

/** Stable per-device id persisted in localStorage. */
function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = (crypto?.randomUUID?.() ?? `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return `dev-${Date.now()}`;
  }
}

/** Best-effort human-friendly device label from the user agent. */
function getDeviceLabel(): string {
  // A user-chosen name always wins over the auto-detected one.
  try {
    const custom = localStorage.getItem(DEVICE_LABEL_KEY);
    if (custom && custom.trim()) return custom.trim();
  } catch {
    /* ignore */
  }
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  let os = 'Unknown device';
  if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iPhone/iPad';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'Mac';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = '';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';

  return browser ? `${os} · ${browser}` : os;
}

/**
 * Tracks the current device and reports how many devices the account is
 * currently signed in on. Registers a heartbeat so other devices show up.
 */
export function useDeviceSessions(userId: string | undefined) {
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [loading, setLoading] = useState(true);
  const deviceIdRef = useRef<string>(getDeviceId());

  const mapRows = useCallback((rows: any[] | null): DeviceSession[] => {
    const now = Date.now();
    const currentId = deviceIdRef.current;
    return (rows ?? []).map((r) => ({
      id: r.id,
      device_id: r.device_id,
      device_label: r.device_label,
      user_agent: r.user_agent,
      last_seen_at: r.last_seen_at,
      isCurrent: r.device_id === currentId,
      isActive: now - new Date(r.last_seen_at).getTime() <= ACTIVE_WINDOW_MS,
    }));
  }, []);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const { data, error } = await supabase
      .from('user_device_sessions')
      .select('id, device_id, device_label, user_agent, last_seen_at')
      .eq('user_id', userId)
      .order('last_seen_at', { ascending: false });
    if (!error) setSessions(mapRows(data));
    setLoading(false);
  }, [userId, mapRows]);

  const heartbeat = useCallback(async () => {
    if (!userId) return;
    await supabase
      .from('user_device_sessions')
      .upsert(
        {
          user_id: userId,
          device_id: deviceIdRef.current,
          device_label: getDeviceLabel(),
          user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 300) : null,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,device_id' },
      );
  }, [userId]);

  const signOutDevice = useCallback(
    async (deviceId: string) => {
      if (!userId) return;
      await supabase
        .from('user_device_sessions')
        .delete()
        .eq('user_id', userId)
        .eq('device_id', deviceId);
      await refresh();
    },
    [userId, refresh],
  );

  const renameDevice = useCallback(
    async (deviceId: string, label: string) => {
      if (!userId) return;
      const trimmed = label.trim();
      if (!trimmed || trimmed.length > MAX_DEVICE_LABEL_LENGTH) return;
      // If renaming the current device, persist locally so heartbeats keep the name.
      if (deviceId === deviceIdRef.current) {
        try {
          localStorage.setItem(DEVICE_LABEL_KEY, trimmed);
        } catch {
          /* ignore */
        }
      }
      await supabase
        .from('user_device_sessions')
        .update({ device_label: trimmed })
        .eq('user_id', userId)
        .eq('device_id', deviceId);
      await refresh();
    },
    [userId, refresh],
  );

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const run = async () => {
      await heartbeat();
      if (!cancelled) await refresh();
    };
    run();
    const interval = setInterval(run, HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [userId, heartbeat, refresh]);

  const activeSessions = sessions.filter((s) => s.isActive);

  return {
    sessions,
    activeSessions,
    activeCount: activeSessions.length,
    isMultiDevice: activeSessions.length > 1,
    loading,
    currentDeviceId: deviceIdRef.current,
    refresh,
    signOutDevice,
    renameDevice,
  };
}