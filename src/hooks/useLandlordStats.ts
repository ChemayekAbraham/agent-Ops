import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface LandlordStats {
  totalProperties: number;
  emptyHouses: number;
  totalRentReceivable: number;
}

const CACHE_KEY_PREFIX = 'lf_landlord_stats_';

function readCache(userId: string): LandlordStats | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY_PREFIX + userId);
    if (raw) return JSON.parse(raw).data;
  } catch {}
  return null;
}

function writeCache(userId: string, stats: LandlordStats): void {
  try {
    localStorage.setItem(CACHE_KEY_PREFIX + userId, JSON.stringify({ data: stats, timestamp: Date.now() }));
  } catch {}
}

export function useLandlordStats(userId: string | undefined) {
  // Initialize from cache instantly
  const [stats, setStats] = useState<LandlordStats>(() => {
    if (userId) {
      const cached = readCache(userId);
      if (cached) return cached;
    }
    return { totalProperties: 0, emptyHouses: 0, totalRentReceivable: 0 };
  });
  const [loading, setLoading] = useState(() => {
    if (userId) return !readCache(userId);
    return true;
  });

  const fetchStats = useCallback(async () => {
    if (!userId) return;
    try {
      const { data, error } = await supabase
        .from('landlords')
        .select('id, tenant_id, monthly_rent, desired_rent_from_welile, verified, is_occupied')
        .eq('registered_by', userId);

      if (error) {
        console.error('Error fetching landlord stats:', error);
        return;
      }

      const properties = data || [];
      const totalProperties = properties.length;
      const emptyHouses = properties.filter(p => !p.tenant_id && !(p as any).is_occupied).length;
      const totalRentReceivable = properties.reduce((sum, p) => {
        const rent = p.desired_rent_from_welile || p.monthly_rent || 0;
        return sum + rent;
      }, 0);

      const newStats = { totalProperties, emptyHouses, totalRentReceivable };
      setStats(newStats);
      writeCache(userId, newStats);
    } catch (err) {
      console.error('Error fetching landlord stats:', err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    // Background fetch — never blocks UI if cache exists
    if (navigator.onLine) {
      fetchStats();
    } else {
      setLoading(false);
    }
  }, [fetchStats, userId]);

  return { stats, loading, refreshStats: fetchStats };
}
