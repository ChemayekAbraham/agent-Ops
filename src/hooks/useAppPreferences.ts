import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { fetchServerRoutingPrefs, saveServerRoutingPrefs } from '@/lib/routingPrefsServer';

export type DefaultRolePreference = 'auto' | 'tenant' | 'agent' | 'landlord' | 'supporter' | 'manager' | 'ceo' | 'coo' | 'cfo' | 'cto' | 'cmo' | 'crm' | 'employee' | 'operations' | 'super_admin';

export interface AppPreferences {
  notificationSounds: boolean;
  notificationSoundType: 'ding' | 'pop' | 'chime';
  opportunitySoundType: 'ding' | 'pop' | 'chime' | 'opportunity';
  rememberLogin: boolean;
  skipSplash: boolean;
  defaultRole: DefaultRolePreference;
  unlockAllRoles: boolean;
  disableAgentAutoDefault: boolean;
  /** Which sign-in method the login screen opens with by default. */
  preferredLoginMethod: 'otp' | 'password';
}

const DEFAULT_PREFERENCES: AppPreferences = {
  notificationSounds: true,
  notificationSoundType: 'ding',
  opportunitySoundType: 'opportunity',
  rememberLogin: true,
  skipSplash: false,
  defaultRole: 'auto',
  unlockAllRoles: false,
  disableAgentAutoDefault: false,
  preferredLoginMethod: 'otp',
};

const STORAGE_KEY = 'welile_app_preferences';

export function useAppPreferences() {
  const [preferences, setPreferences] = useState<AppPreferences>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return { ...DEFAULT_PREFERENCES, ...JSON.parse(stored) };
      }
      // Check for legacy skip splash preference
      const legacySkipSplash = localStorage.getItem('welile_skip_splash') === 'true';
      if (legacySkipSplash) {
        return { ...DEFAULT_PREFERENCES, skipSplash: true };
      }
    } catch (e) {
      console.error('Failed to load preferences:', e);
    }
    return DEFAULT_PREFERENCES;
  });

  // Persist preferences to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
      // Also update legacy key for splash screen
      if (preferences.skipSplash) {
        localStorage.setItem('welile_skip_splash', 'true');
      } else {
        localStorage.removeItem('welile_skip_splash');
      }
    } catch (e) {
      console.error('Failed to save preferences:', e);
    }
  }, [preferences]);

  const updatePreference = useCallback(<K extends keyof AppPreferences>(
    key: K,
    value: AppPreferences[K]
  ) => {
    setPreferences(prev => ({ ...prev, [key]: value }));
    // Mirror routing-relevant prefs to the user's profile so cleared
    // localStorage on another device still gets the same default.
    if (key === 'defaultRole' || key === 'disableAgentAutoDefault') {
      supabase.auth.getUser().then(({ data }) => {
        const uid = data?.user?.id;
        if (!uid) return;
        saveServerRoutingPrefs(uid, { [key]: value } as any);
      }).catch(() => {});
    }
  }, []);

  const resetPreferences = useCallback(() => {
    setPreferences(DEFAULT_PREFERENCES);
  }, []);

  // On mount, hydrate routing prefs from the server. Server wins ONLY for
  // routing-related keys, and ONLY if localStorage didn't already have an
  // explicit non-default value (so a fresh wipe on a new device still
  // recovers the user's choice).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.auth.getUser();
        const uid = data?.user?.id;
        if (!uid) return;
        const server = await fetchServerRoutingPrefs(uid);
        if (!server || cancelled) return;
        setPreferences(prev => {
          let local: Partial<AppPreferences> = {};
          try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) local = JSON.parse(stored);
          } catch {}
          const next = { ...prev };
          // Apply server value only if local has no explicit override.
          if (server.defaultRole && !('defaultRole' in local)) {
            next.defaultRole = server.defaultRole;
          }
          if (typeof server.disableAgentAutoDefault === 'boolean'
              && !('disableAgentAutoDefault' in local)) {
            next.disableAgentAutoDefault = server.disableAgentAutoDefault;
          }
          return next;
        });
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  return {
    preferences,
    updatePreference,
    resetPreferences,
  };
}

// Standalone function to check if notification sounds are enabled
export function areNotificationSoundsEnabled(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const prefs = JSON.parse(stored);
      return prefs.notificationSounds !== false;
    }
  } catch (e) {}
  return true;
}

// Standalone function to get notification sound type
export function getNotificationSoundType(): 'ding' | 'pop' | 'chime' {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const prefs = JSON.parse(stored);
      return prefs.notificationSoundType || 'ding';
    }
  } catch (e) {}
  return 'ding';
}

// Standalone function to get opportunity sound type
export function getOpportunitySoundType(): 'ding' | 'pop' | 'chime' | 'opportunity' {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const prefs = JSON.parse(stored);
      return prefs.opportunitySoundType || 'opportunity';
    }
  } catch (e) {}
  return 'opportunity';
}

// Standalone function to check if remember login is enabled
export function isRememberLoginEnabled(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const prefs = JSON.parse(stored);
      return prefs.rememberLogin !== false;
    }
  } catch (e) {}
  return true;
}

// Standalone function to get the user's preferred default role
export function getPreferredDefaultRole(): DefaultRolePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const prefs = JSON.parse(stored);
      return prefs.defaultRole || 'auto';
    }
  } catch (e) {}
  return 'auto';
}

// Standalone function to check if user has unlocked all roles for navigation
export function areAllRolesUnlocked(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const prefs = JSON.parse(stored);
      return prefs.unlockAllRoles === true;
    }
  } catch (e) {}
  return false;
}

// Standalone: whether the user opted out of the "agent if you ever posted
// a rent request" auto-default rule in DashboardRedirect.
export function isAgentAutoDefaultDisabled(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const prefs = JSON.parse(stored);
      return prefs.disableAgentAutoDefault === true;
    }
  } catch (e) {}
  return false;
}

// Standalone: which sign-in method the login screen should open with.
// Defaults to OTP-first; password remains available as a backup.
export function getPreferredLoginMethod(): 'otp' | 'password' {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const prefs = JSON.parse(stored);
      return prefs.preferredLoginMethod === 'password' ? 'password' : 'otp';
    }
  } catch (e) {}
  return 'otp';
}
