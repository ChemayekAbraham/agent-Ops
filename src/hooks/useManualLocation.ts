import { useCallback, useEffect, useState } from 'react';
import type { UgandaLocation } from '@/lib/ugandaLocations';

const STORAGE_KEY = 'welile-manual-location';

export interface ManualLocation {
  name: string;
  region: string;
  latitude: number;
  longitude: number;
}

function read(): ManualLocation | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.latitude === 'number' && typeof parsed?.longitude === 'number') {
      return parsed as ManualLocation;
    }
  } catch {
    // ignore corrupt value
  }
  return null;
}

/** Persisted manually-chosen location used as a fallback when GPS is unavailable. */
export function useManualLocation() {
  const [manual, setManual] = useState<ManualLocation | null>(() => read());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setManual(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const choose = useCallback((loc: UgandaLocation) => {
    const value: ManualLocation = {
      name: loc.name,
      region: loc.region,
      latitude: loc.latitude,
      longitude: loc.longitude,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      // ignore quota errors
    }
    setManual(value);
  }, []);

  const clear = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setManual(null);
  }, []);

  return { manual, choose, clear };
}