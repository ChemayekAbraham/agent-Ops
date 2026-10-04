import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface ExistingTenantMatch {
  id: string;
  full_name: string | null;
  phone: string | null;
  national_id: string | null;
  avatar_url: string | null;
}

interface ExistingTenantLookup {
  /** The first profile already on the platform that owns this phone, or null. */
  match: ExistingTenantMatch | null;
  /** True while a lookup is in flight. */
  checking: boolean;
}

/** Extract the last 9 digits for Uganda phone comparison. */
const getLocal9 = (phone: string): string | null => {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length < 9) return null;
  return digits.slice(-9);
};

/**
 * Live "is this number already in the system?" check used while an agent types a
 * tenant's phone number. Reveals the registered owner's name so the agent can
 * see an existing tenant (and never register the same number twice / create a
 * fraudulent duplicate). Uses exact-match IN queries against indexed phone
 * formats so it scales to millions of users.
 */
export function useExistingTenantByPhone(phone: string, debounceMs = 450): ExistingTenantLookup {
  const [match, setMatch] = useState<ExistingTenantMatch | null>(null);
  const [checking, setChecking] = useState(false);

  const lookup = useCallback(async (phoneNumber: string) => {
    const local9 = getLocal9(phoneNumber);
    if (!local9) {
      setMatch(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    try {
      const phoneFormats = [local9, `0${local9}`, `256${local9}`, `+256${local9}`];
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone, national_id, avatar_url')
        .in('phone', phoneFormats)
        .limit(1);
      if (error) throw error;
      setMatch(data && data.length > 0 ? (data[0] as ExistingTenantMatch) : null);
    } catch (err) {
      console.warn('[useExistingTenantByPhone] lookup failed', err);
      setMatch(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!getLocal9(phone)) {
      setMatch(null);
      setChecking(false);
      return;
    }
    const t = setTimeout(() => lookup(phone), debounceMs);
    return () => clearTimeout(t);
  }, [phone, debounceMs, lookup]);

  return { match, checking };
}
