import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { cacheProfile, getCachedProfile } from '@/lib/offlineDataStorage';
import { subscribeAvatarUpdates } from '@/lib/avatarSync';

interface Profile {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  avatar_url: string | null;
  verified: boolean;
  is_frozen?: boolean;
  frozen_reason?: string | null;
  territory?: string | null;
  is_seller?: boolean;
  seller_application_status?: string | null;
  // System-wide saved profile data captured during onboarding/profile
  // completion. Loaded automatically on every login / device switch so the
  // user's location, role, and occupation follow them everywhere.
  address_complete?: boolean | null;
  continent?: string | null;
  country?: string | null;
  region?: string | null;
  district?: string | null;
  city?: string | null;
  town?: string | null;
  sub_county?: string | null;
  parish?: string | null;
  village?: string | null;
  primary_persona?: string | null;
  occupation?: string | null;
}

// Single source of truth for the columns we hydrate everywhere.
const PROFILE_COLUMNS =
  'id, full_name, email, phone, avatar_url, verified, is_frozen, frozen_reason, territory, is_seller, seller_application_status, address_complete, continent, country, region, district, city, town, sub_county, parish, village, primary_persona, occupation';
// Module-level cache to deduplicate across component instances
let profileCache: { data: Profile; userId: string; timestamp: number } | null = null;
const PROFILE_CACHE_TTL = 60_000; // 1 minute
const LS_KEY_PREFIX = 'lf_profile_';

// Sync localStorage read for instant first paint
function readProfileFromLS(userId: string): Profile | null {
  try {
    const raw = localStorage.getItem(LS_KEY_PREFIX + userId);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

export function useProfile() {
  const { user } = useAuth();
  const cached = user && profileCache && profileCache.userId === user.id && (Date.now() - profileCache.timestamp < PROFILE_CACHE_TTL)
    ? profileCache.data : (user ? readProfileFromLS(user.id) : null);
  const [profile, setProfile] = useState<Profile | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [isOfflineData, setIsOfflineData] = useState(!!cached && !profileCache);

  const fetchProfile = useCallback(async () => {
    if (!user) {
      setProfile(null);
      setLoading(false);
      return;
    }
    // Check module-level cache first
    if (profileCache && profileCache.userId === user.id && (Date.now() - profileCache.timestamp < PROFILE_CACHE_TTL)) {
      setProfile(profileCache.data);
      setLoading(false);
      return;
    }

    setLoading(true);

    // Try to get cached data first for instant display
    try {
      const cached = await getCachedProfile(user.id);
      if (cached) {
        setProfile(cached);
        setIsOfflineData(true);
      }
    } catch (e) {
      console.warn('[useProfile] Failed to get cached profile:', e);
    }

    // Fetch fresh data if online
    if (navigator.onLine) {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select(PROFILE_COLUMNS)
          .eq('id', user.id)
          .maybeSingle();

        if (!error && data) {
          setProfile(data);
          setIsOfflineData(false);
          profileCache = { data, userId: user.id, timestamp: Date.now() };
          // Cache to both IndexedDB and localStorage
          try { localStorage.setItem(LS_KEY_PREFIX + user.id, JSON.stringify(data)); } catch {}
          await cacheProfile(data);
        }
      } catch (e) {
        console.warn('[useProfile] Failed to fetch profile:', e);
      }
    }
    
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const refreshProfile = useCallback(async () => {
    if (!user) return;
    
    if (!navigator.onLine) {
      return; // Don't try to refresh when offline
    }

    const { data, error } = await supabase
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', user.id)
      .maybeSingle();

    if (!error && data) {
      setProfile(data);
      setIsOfflineData(false);
      profileCache = { data, userId: user.id, timestamp: Date.now() };
      try { localStorage.setItem(LS_KEY_PREFIX + user.id, JSON.stringify(data)); } catch {}
      await cacheProfile(data);
    }
  }, [user]);

  // Re-hydrate the system-wide profile from the server when the device
  // reconnects — covers device switches and resuming after an offline gap.
  useEffect(() => {
    if (!user) return;
    const onOnline = () => { refreshProfile(); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [user, refreshProfile]);

  // A new profile picture must show up instantly, without waiting for the
  // 1-minute profile cache to expire (and in every other open tab too).
  useEffect(() => {
    if (!user) return;
    return subscribeAvatarUpdates(({ userId, avatarUrl }) => {
      if (userId !== user.id) return;
      setProfile(prev => {
        const next = prev ? { ...prev, avatar_url: avatarUrl } : prev;
        if (next) {
          profileCache = { data: next, userId: user.id, timestamp: Date.now() };
          try { localStorage.setItem(LS_KEY_PREFIX + user.id, JSON.stringify(next)); } catch {}
          void cacheProfile(next);
        }
        return next;
      });
    });
  }, [user]);

  return { profile, loading, refreshProfile, isOfflineData };
}
