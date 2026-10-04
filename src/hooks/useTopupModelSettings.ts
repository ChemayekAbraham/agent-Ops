import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_TOPUP_SETTINGS,
  type TopupModelSettings,
} from '@/lib/topupBacktest';

const STORAGE_KEY = 'welile-topup-model-settings';

export const TOPUP_SETTING_LIMITS = {
  lookback: { min: 2, max: 24 },
  trendDamping: { min: 0, max: 1 },
  minHistory: { min: 2, max: 24 },
};

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Keeps the values inside the same bounds the database function enforces. */
export function normalizeTopupSettings(input: Partial<TopupModelSettings>): TopupModelSettings {
  return {
    lookback: Math.round(
      clamp(
        Number(input.lookback ?? DEFAULT_TOPUP_SETTINGS.lookback),
        TOPUP_SETTING_LIMITS.lookback.min,
        TOPUP_SETTING_LIMITS.lookback.max,
      ),
    ),
    trendDamping: clamp(
      Number(input.trendDamping ?? DEFAULT_TOPUP_SETTINGS.trendDamping),
      TOPUP_SETTING_LIMITS.trendDamping.min,
      TOPUP_SETTING_LIMITS.trendDamping.max,
    ),
    minHistory: Math.round(
      clamp(
        Number(input.minHistory ?? DEFAULT_TOPUP_SETTINGS.minHistory),
        TOPUP_SETTING_LIMITS.minHistory.min,
        TOPUP_SETTING_LIMITS.minHistory.max,
      ),
    ),
  };
}

/**
 * CFO-tunable top-up prediction settings, remembered on this device. The
 * database function clamps the same ranges, so a stale stored value can never
 * produce a nonsense forecast.
 */
export function useTopupModelSettings() {
  const [settings, setSettings] = useState<TopupModelSettings>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalizeTopupSettings(JSON.parse(raw));
    } catch {
      /* ignore unreadable storage */
    }
    return DEFAULT_TOPUP_SETTINGS;
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable — settings still apply for this session */
    }
  }, [settings]);

  const update = useCallback((patch: Partial<TopupModelSettings>) => {
    setSettings((prev) => normalizeTopupSettings({ ...prev, ...patch }));
  }, []);

  const reset = useCallback(() => setSettings(DEFAULT_TOPUP_SETTINGS), []);

  const isDefault =
    settings.lookback === DEFAULT_TOPUP_SETTINGS.lookback &&
    settings.trendDamping === DEFAULT_TOPUP_SETTINGS.trendDamping &&
    settings.minHistory === DEFAULT_TOPUP_SETTINGS.minHistory;

  return { settings, update, reset, isDefault };
}
