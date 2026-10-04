import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface TenantDuplicateMatch {
  id: string;
  full_name: string | null;
  phone: string | null;
  national_id: string | null;
  avatar_url: string | null;
}

export interface TenantDuplicateState {
  /** A profile whose full name matches the typed name. */
  nameMatch: TenantDuplicateMatch | null;
  /** A profile whose phone matches the typed phone. */
  phoneMatch: TenantDuplicateMatch | null;
  /** A profile whose national ID matches the typed ID. */
  nationalIdMatch: TenantDuplicateMatch | null;
  /** True while a name lookup is in flight. */
  checkingName: boolean;
  /** True while a phone lookup is in flight. */
  checkingPhone: boolean;
  /** True while a national ID lookup is in flight. */
  checkingNationalId: boolean;
}

const DEBOUNCE_MS = 450;
const MIN_CHARS = 4;

/** Extract the last 9 digits for Uganda phone comparison. */
const getLocal9 = (phone: string): string | null => {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length < 9) return null;
  return digits.slice(-9);
};

/** Normalize a name for comparison: lower-case, letters only. */
const normalizeName = (name: string): string => {
  return name.toLowerCase().replace(/[^a-z]/g, '');
};

/** Normalize a national ID: upper-case, alphanumeric only. */
const normalizeNationalId = (id: string): string => {
  return id.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
};

/**
 * Live duplicate-tenant guard used while an agent types a new tenant's details.
 * Checks name, phone and national ID against existing profiles and reveals the
 * registered owner so the agent cannot create a fraudulent duplicate.
 *
 * Debounced lookup only starts once a field reaches 4 characters so we don't
 * fire queries on every keystroke for short inputs.
 */
export function useTenantDuplicateCheck(
  name: string,
  phone: string,
  nationalId: string
): TenantDuplicateState {
  const [nameMatch, setNameMatch] = useState<TenantDuplicateMatch | null>(null);
  const [phoneMatch, setPhoneMatch] = useState<TenantDuplicateMatch | null>(null);
  const [nationalIdMatch, setNationalIdMatch] = useState<TenantDuplicateMatch | null>(null);
  const [checkingName, setCheckingName] = useState(false);
  const [checkingPhone, setCheckingPhone] = useState(false);
  const [checkingNationalId, setCheckingNationalId] = useState(false);

  const lookupPhone = useCallback(async (phoneNumber: string) => {
    const local9 = getLocal9(phoneNumber);
    if (!local9) {
      setPhoneMatch(null);
      setCheckingPhone(false);
      return;
    }
    setCheckingPhone(true);
    try {
      const phoneFormats = [local9, `0${local9}`, `256${local9}`, `+256${local9}`];
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone, national_id, avatar_url')
        .in('phone', phoneFormats)
        .limit(1);
      if (error) throw error;
      setPhoneMatch(data && data.length > 0 ? (data[0] as TenantDuplicateMatch) : null);
    } catch (err) {
      console.warn('[useTenantDuplicateCheck] phone lookup failed', err);
      setPhoneMatch(null);
    } finally {
      setCheckingPhone(false);
    }
  }, []);

  const lookupName = useCallback(async (nameValue: string) => {
    const trimmed = nameValue.trim();
    if (trimmed.length < MIN_CHARS) {
      setNameMatch(null);
      setCheckingName(false);
      return;
    }
    const targetKey = normalizeName(trimmed);
    if (!targetKey) {
      setNameMatch(null);
      setCheckingName(false);
      return;
    }
    setCheckingName(true);
    try {
      // Use a substring match so spacing differences ("John  Mukasa" vs "John Mukasa")
      // still surface, then filter to exact normalized equality client-side.
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone, national_id, avatar_url')
        .ilike('full_name', `%${trimmed}%`)
        .limit(10);
      if (error) throw error;
      const match = (data || []).find((p) => {
        if (!p.full_name) return false;
        return normalizeName(p.full_name) === targetKey;
      });
      setNameMatch(match || null);
    } catch (err) {
      console.warn('[useTenantDuplicateCheck] name lookup failed', err);
      setNameMatch(null);
    } finally {
      setCheckingName(false);
    }
  }, []);

  const lookupNationalId = useCallback(async (idValue: string) => {
    const cleaned = normalizeNationalId(idValue);
    if (cleaned.length < MIN_CHARS) {
      setNationalIdMatch(null);
      setCheckingNationalId(false);
      return;
    }
    const spaced = cleaned.replace(/(.{4})/g, '$1 ').trim();
    setCheckingNationalId(true);
    try {
      // Query both cleaned and common spaced formats so we hit records regardless
      // of how the ID was originally entered. Uses the national_id btree/prefix indexes.
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone, national_id, avatar_url')
        .or(`national_id.ilike.${cleaned}%,national_id.ilike.${spaced}%`)
        .limit(10);
      if (error) throw error;
      const match = (data || []).find((p) => {
        if (!p.national_id) return false;
        return normalizeNationalId(p.national_id) === cleaned;
      });
      setNationalIdMatch(match || null);
    } catch (err) {
      console.warn('[useTenantDuplicateCheck] national ID lookup failed', err);
      setNationalIdMatch(null);
    } finally {
      setCheckingNationalId(false);
    }
  }, []);

  useEffect(() => {
    if (name.trim().length < MIN_CHARS) {
      setNameMatch(null);
      setCheckingName(false);
      return;
    }
    const t = setTimeout(() => lookupName(name), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [name, lookupName]);

  useEffect(() => {
    if (phone.replace(/\D/g, '').length < MIN_CHARS) {
      setPhoneMatch(null);
      setCheckingPhone(false);
      return;
    }
    const t = setTimeout(() => lookupPhone(phone), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [phone, lookupPhone]);

  useEffect(() => {
    if (normalizeNationalId(nationalId).length < MIN_CHARS) {
      setNationalIdMatch(null);
      setCheckingNationalId(false);
      return;
    }
    const t = setTimeout(() => lookupNationalId(nationalId), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [nationalId, lookupNationalId]);

  return {
    nameMatch,
    phoneMatch,
    nationalIdMatch,
    checkingName,
    checkingPhone,
    checkingNationalId,
  };
}
