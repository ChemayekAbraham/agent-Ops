import { useState, useEffect, createContext, useContext, ReactNode, useCallback } from 'react';

interface PinAuthContextType {
  isPinEnabled: boolean;
  isPinLocked: boolean;
  pinAttempts: number;
  maxAttempts: number;
  setupPin: (pin: string) => Promise<boolean>;
  verifyPin: (pin: string) => Promise<boolean>;
  disablePin: () => void;
  lockApp: () => void;
  unlockApp: () => void;
  resetPinAttempts: () => void;
}

const PinAuthContext = createContext<PinAuthContextType | undefined>(undefined);

const PIN_HASH_KEY = 'welile_pin_hash_v2';
const PIN_SALT_KEY = 'welile_pin_salt_v2';
const PIN_ENABLED_KEY = 'welile_pin_enabled';
const PIN_ATTEMPTS_KEY = 'welile_pin_attempts';
const PIN_LOCKED_UNTIL_KEY = 'welile_pin_locked_until';
const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 5 * 60 * 1000; // 5 minutes
const PBKDF2_ITERATIONS = 100000; // OWASP recommended minimum

/**
 * Cryptographically secure PIN hashing using Web Crypto API with PBKDF2
 * This is significantly stronger than the previous bit-shifting approach
 */
async function hashPinSecure(pin: string, existingSalt?: Uint8Array): Promise<{ hash: string; salt: string }> {
  const encoder = new TextEncoder();
  const pinData = encoder.encode(pin);
  
  // Generate random salt or use existing
  const salt = existingSalt || crypto.getRandomValues(new Uint8Array(16));
  
  // Import PIN as key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    pinData,
    'PBKDF2',
    false,
    ['deriveBits']
  );
  
  // Derive key using PBKDF2
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    256 // 256 bits = 32 bytes
  );
  
  // Convert to base64 for storage
  const hashArray = new Uint8Array(derivedBits);
  const hashBase64 = btoa(String.fromCharCode.apply(null, Array.from(hashArray)));
  const saltBase64 = btoa(String.fromCharCode.apply(null, Array.from(salt)));
  
  return { hash: hashBase64, salt: saltBase64 };
}

/**
 * Verify PIN against stored hash
 */
async function verifyPinSecure(pin: string, storedHash: string, storedSalt: string): Promise<boolean> {
  try {
    // Convert salt from base64
    const saltArray = Uint8Array.from(atob(storedSalt), c => c.charCodeAt(0));
    
    // Hash the input PIN with the same salt
    const { hash } = await hashPinSecure(pin, saltArray);
    
    // Constant-time comparison to prevent timing attacks
    if (hash.length !== storedHash.length) return false;
    
    let result = 0;
    for (let i = 0; i < hash.length; i++) {
      result |= hash.charCodeAt(i) ^ storedHash.charCodeAt(i);
    }
    
    return result === 0;
  } catch (error) {
    console.error('[PinAuth] Verification error:', error);
    return false;
  }
}

export function PinAuthProvider({ children }: { children: ReactNode }) {
  const [isPinEnabled, setIsPinEnabled] = useState(false);
  const [isPinLocked, setIsPinLocked] = useState(false);
  const [pinAttempts, setPinAttempts] = useState(0);

  const resetPinAttempts = useCallback(() => {
    setPinAttempts(0);
    localStorage.setItem(PIN_ATTEMPTS_KEY, '0');
  }, []);

  useEffect(() => {
    // Check if PIN is enabled (check both v2 and legacy)
    const pinEnabled = localStorage.getItem(PIN_ENABLED_KEY) === 'true';
    const pinHash = localStorage.getItem(PIN_HASH_KEY) || localStorage.getItem('welile_pin_hash');
    setIsPinEnabled(pinEnabled && !!pinHash);

    // Check stored attempts
    const storedAttempts = parseInt(localStorage.getItem(PIN_ATTEMPTS_KEY) || '0', 10);
    setPinAttempts(storedAttempts);

    // Check if locked out
    const lockedUntil = localStorage.getItem(PIN_LOCKED_UNTIL_KEY);
    if (lockedUntil) {
      const lockTime = parseInt(lockedUntil, 10);
      if (Date.now() < lockTime) {
        setIsPinLocked(true);
        // Set timeout to unlock
        const timeout = setTimeout(() => {
          setIsPinLocked(false);
          localStorage.removeItem(PIN_LOCKED_UNTIL_KEY);
          resetPinAttempts();
        }, lockTime - Date.now());
        return () => clearTimeout(timeout);
      } else {
        // Lockout expired
        localStorage.removeItem(PIN_LOCKED_UNTIL_KEY);
        resetPinAttempts();
      }
    }
  }, [resetPinAttempts]);

  const setupPin = async (pin: string): Promise<boolean> => {
    if (pin.length !== 4) return false;
    
    try {
      const { hash, salt } = await hashPinSecure(pin);
      
      // Clear any legacy PIN data
      localStorage.removeItem('welile_pin_hash');
      
      // Store new secure hash and salt
      localStorage.setItem(PIN_HASH_KEY, hash);
      localStorage.setItem(PIN_SALT_KEY, salt);
      localStorage.setItem(PIN_ENABLED_KEY, 'true');
      
      setIsPinEnabled(true);
      resetPinAttempts();
      return true;
    } catch (error) {
      console.error('[PinAuth] Setup error:', error);
      return false;
    }
  };

  const verifyPin = async (pin: string): Promise<boolean> => {
    const storedHash = localStorage.getItem(PIN_HASH_KEY);
    const storedSalt = localStorage.getItem(PIN_SALT_KEY);
    
    // Check for legacy PIN (migrate on successful verify)
    const legacyHash = localStorage.getItem('welile_pin_hash');
    
    let isValid = false;
    
    if (storedHash && storedSalt) {
      // Use secure verification
      isValid = await verifyPinSecure(pin, storedHash, storedSalt);
    } else if (legacyHash) {
      // Legacy verification for migration
      const legacyHashPin = (p: string): string => {
        let hash = 0;
        for (let i = 0; i < p.length; i++) {
          const char = p.charCodeAt(i);
          hash = ((hash << 5) - hash) + char;
          hash = hash & hash;
        }
        const salted = `welile_${hash}_pin`;
        let finalHash = 0;
        for (let i = 0; i < salted.length; i++) {
          const char = salted.charCodeAt(i);
          finalHash = ((finalHash << 5) - finalHash) + char;
          finalHash = finalHash & finalHash;
        }
        return finalHash.toString(36);
      };
      
      isValid = legacyHashPin(pin) === legacyHash;
      
      // Migrate to secure hash on successful verification
      if (isValid) {
        try {
          const { hash, salt } = await hashPinSecure(pin);
          localStorage.setItem(PIN_HASH_KEY, hash);
          localStorage.setItem(PIN_SALT_KEY, salt);
          localStorage.removeItem('welile_pin_hash'); // Remove legacy
          console.log('[PinAuth] Migrated to secure PIN hash');
        } catch (e) {
          console.error('[PinAuth] Migration error:', e);
        }
      }
    }

    if (isValid) {
      resetPinAttempts();
      setIsPinLocked(false);
      return true;
    } else {
      const newAttempts = pinAttempts + 1;
      setPinAttempts(newAttempts);
      localStorage.setItem(PIN_ATTEMPTS_KEY, newAttempts.toString());

      if (newAttempts >= MAX_PIN_ATTEMPTS) {
        const lockUntil = Date.now() + LOCKOUT_DURATION;
        localStorage.setItem(PIN_LOCKED_UNTIL_KEY, lockUntil.toString());
        setIsPinLocked(true);
        
        // Auto unlock after duration
        setTimeout(() => {
          setIsPinLocked(false);
          localStorage.removeItem(PIN_LOCKED_UNTIL_KEY);
          resetPinAttempts();
        }, LOCKOUT_DURATION);
      }
      return false;
    }
  };

  const disablePin = () => {
    localStorage.removeItem(PIN_HASH_KEY);
    localStorage.removeItem(PIN_SALT_KEY);
    localStorage.removeItem('welile_pin_hash'); // Legacy
    localStorage.removeItem(PIN_ENABLED_KEY);
    localStorage.removeItem(PIN_ATTEMPTS_KEY);
    localStorage.removeItem(PIN_LOCKED_UNTIL_KEY);
    setIsPinEnabled(false);
    setIsPinLocked(false);
    resetPinAttempts();
  };

  const lockApp = () => {
    if (isPinEnabled) {
      setIsPinLocked(true);
    }
  };

  const unlockApp = () => {
    setIsPinLocked(false);
  };

  return (
    <PinAuthContext.Provider value={{
      isPinEnabled,
      isPinLocked,
      pinAttempts,
      maxAttempts: MAX_PIN_ATTEMPTS,
      setupPin,
      verifyPin,
      disablePin,
      lockApp,
      unlockApp,
      resetPinAttempts
    }}>
      {children}
    </PinAuthContext.Provider>
  );
}

export function usePinAuth() {
  const context = useContext(PinAuthContext);
  if (context === undefined) {
    throw new Error('usePinAuth must be used within a PinAuthProvider');
  }
  return context;
}
