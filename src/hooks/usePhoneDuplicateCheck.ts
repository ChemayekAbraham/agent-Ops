import { useState, useEffect, useCallback } from 'react';
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

export function usePhoneDuplicateCheck(phone: string, debounceMs: number = 500): DuplicateCheckResult {
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [duplicateMessage, setDuplicateMessage] = useState<string | null>(null);

  const checkDuplicate = useCallback(async (phoneNumber: string) => {
    const local9 = getLocal9(phoneNumber);
    if (!local9) {
      setIsDuplicate(false);
      setDuplicateMessage(null);
      return;
    }

    setIsChecking(true);
    try {
      // OPTIMIZED: Use exact-match IN query instead of ILIKE full-table scan
      // This uses btree indexes and scales to 7M+ users
      const phoneFormats = [local9, `0${local9}`, `256${local9}`, `+256${local9}`];
      
      // Run both checks in parallel for speed
      const [profileResult, inviteResult] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, phone, full_name')
          .in('phone', phoneFormats)
          .limit(1),
        supabase
          .from('supporter_invites')
          .select('id, phone, full_name')
          .eq('status', 'pending')
          .in('phone', phoneFormats)
          .limit(1)
      ]);

      if (profileResult.data && profileResult.data.length > 0) {
        setIsDuplicate(true);
        setDuplicateMessage(`This number is already registered to ${profileResult.data[0].full_name || 'another user'}`);
        setIsChecking(false);
        return;
      }

      if (inviteResult.data && inviteResult.data.length > 0) {
        setIsDuplicate(true);
        setDuplicateMessage(`A pending invite already exists for ${inviteResult.data[0].full_name || 'this number'}`);
        setIsChecking(false);
        return;
      }

      setIsDuplicate(false);
      setDuplicateMessage(null);
    } catch (error) {
      console.error('Error checking phone duplicate:', error);
      setIsDuplicate(false);
      setDuplicateMessage(null);
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    const cleanedPhone = phone.replace(/\D/g, '');
    
    if (cleanedPhone.length < 9) {
      setIsDuplicate(false);
      setDuplicateMessage(null);
      return;
    }

    const timeoutId = setTimeout(() => {
      checkDuplicate(phone);
    }, debounceMs);

    return () => clearTimeout(timeoutId);
  }, [phone, debounceMs, checkDuplicate]);

  return { isDuplicate, isChecking, duplicateMessage };
}
