import { useState, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

// Extract last 9 digits for Uganda phone comparison
const getLocal9 = (phone: string): string | null => {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 9) return null;
  return digits.slice(-9);
};

interface DuplicateCheckResult {
  isDuplicate: boolean;
  isChecking: boolean;
  duplicateMessage: string | null;
}

// Hard cap so a slow/hung request can never leave sign-up stuck on "Checking".
const CHECK_TIMEOUT_MS = 3000;

/**
 * Pre-check only (fails open). The server-side duplicate-phone trigger is the
 * real enforcement. Uses the SECURITY DEFINER `is_phone_available` RPC because
 * signed-out visitors cannot read `profiles` directly.
 */
export function usePhoneDuplicateCheck(phone: string, debounceMs: number = 500): DuplicateCheckResult {
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [duplicateMessage, setDuplicateMessage] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const local9 = getLocal9(phone);
    const seq = ++seqRef.current;

    if (!local9) {
      setIsDuplicate(false);
      setDuplicateMessage(null);
      setIsChecking(false);
      return;
    }

    const timeoutId = setTimeout(async () => {
      setIsChecking(true);
      try {
        const rpc = supabase.rpc('is_phone_available' as any, { p_phone: `0${local9}` } as any);
        const timeout = new Promise<{ data: null; error: Error }>((resolve) =>
          setTimeout(() => resolve({ data: null, error: new Error('timeout') }), CHECK_TIMEOUT_MS),
        );
        const { data, error } = (await Promise.race([rpc, timeout])) as { data: unknown; error: unknown };
        if (seq !== seqRef.current) return;
        if (!error && data === false) {
          setIsDuplicate(true);
          setDuplicateMessage('This number is already registered. Please sign in instead.');
        } else {
          if (error) console.warn('Phone check skipped:', error);
          setIsDuplicate(false);
          setDuplicateMessage(null);
        }
      } catch (err) {
        console.warn('Phone check skipped:', err);
        if (seq === seqRef.current) {
          setIsDuplicate(false);
          setDuplicateMessage(null);
        }
      } finally {
        if (seq === seqRef.current) setIsChecking(false);
      }
    }, debounceMs);

    return () => clearTimeout(timeoutId);
  }, [phone, debounceMs]);

  return { isDuplicate, isChecking, duplicateMessage };
}
