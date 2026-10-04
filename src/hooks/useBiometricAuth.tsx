import { useState, useEffect, createContext, useContext, ReactNode } from 'react';

interface BiometricAuthContextType {
  isBiometricAvailable: boolean;
  isBiometricEnabled: boolean;
  biometricType: 'fingerprint' | 'face' | 'unknown' | null;
  enableBiometric: () => Promise<boolean>;
  disableBiometric: () => void;
  authenticateWithBiometric: () => Promise<boolean>;
  isAuthenticating: boolean;
}

const BiometricAuthContext = createContext<BiometricAuthContextType | undefined>(undefined);

const BIOMETRIC_ENABLED_KEY = 'welile_biometric_enabled';
const BIOMETRIC_CREDENTIAL_KEY = 'welile_biometric_credential';

export function BiometricAuthProvider({ children }: { children: ReactNode }) {
  const [isBiometricAvailable, setIsBiometricAvailable] = useState(false);
  const [isBiometricEnabled, setIsBiometricEnabled] = useState(false);
  const [biometricType, setBiometricType] = useState<'fingerprint' | 'face' | 'unknown' | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  useEffect(() => {
    checkBiometricAvailability();
    checkBiometricEnabled();
  }, []);

  const checkBiometricAvailability = async () => {
    try {
      // Check if WebAuthn is available
      if (!window.PublicKeyCredential) {
        console.log('WebAuthn not supported');
        return;
      }

      // Check if platform authenticator is available (fingerprint/face)
      const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      setIsBiometricAvailable(available);

      if (available) {
        // Try to detect biometric type based on platform
        const userAgent = navigator.userAgent.toLowerCase();
        if (userAgent.includes('iphone') || userAgent.includes('ipad') || userAgent.includes('mac')) {
          setBiometricType('face'); // Face ID on Apple devices
        } else if (userAgent.includes('android')) {
          setBiometricType('fingerprint'); // Most Android devices use fingerprint
        } else {
          setBiometricType('unknown');
        }
      }
    } catch (error) {
      console.error('Error checking biometric availability:', error);
    }
  };

  const checkBiometricEnabled = () => {
    const enabled = localStorage.getItem(BIOMETRIC_ENABLED_KEY) === 'true';
    const hasCredential = !!localStorage.getItem(BIOMETRIC_CREDENTIAL_KEY);
    setIsBiometricEnabled(enabled && hasCredential);
  };

  const generateChallenge = (): Uint8Array => {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return array;
  };

  const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  };

  const enableBiometric = async (): Promise<boolean> => {
    if (!isBiometricAvailable) {
      console.log('Biometric not available');
      return false;
    }

    try {
      setIsAuthenticating(true);

      // Generate a user ID (use a random ID for local-only auth)
      const userId = new Uint8Array(16);
      crypto.getRandomValues(userId);
      
      const publicKeyCredentialCreationOptions: PublicKeyCredentialCreationOptions = {
        challenge: new Uint8Array(generateChallenge()) as BufferSource,
        rp: {
          name: 'Welile',
          id: window.location.hostname,
        },
        user: {
          id: userId as BufferSource,
          name: 'welile-user',
          displayName: 'Welile User',
        },
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' },   // ES256
          { alg: -257, type: 'public-key' }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: 60000,
        attestation: 'none',
      };

      const credential = await navigator.credentials.create({
        publicKey: publicKeyCredentialCreationOptions,
      }) as PublicKeyCredential;

      if (credential) {
        // Store the credential ID for later authentication
        const credentialId = arrayBufferToBase64(credential.rawId);
        localStorage.setItem(BIOMETRIC_CREDENTIAL_KEY, credentialId);
        localStorage.setItem(BIOMETRIC_ENABLED_KEY, 'true');
        setIsBiometricEnabled(true);
        return true;
      }

      return false;
    } catch (error: any) {
      console.error('Error enabling biometric:', error);
      // User cancelled or error occurred
      return false;
    } finally {
      setIsAuthenticating(false);
    }
  };

  const disableBiometric = () => {
    localStorage.removeItem(BIOMETRIC_ENABLED_KEY);
    localStorage.removeItem(BIOMETRIC_CREDENTIAL_KEY);
    setIsBiometricEnabled(false);
  };

  const authenticateWithBiometric = async (): Promise<boolean> => {
    if (!isBiometricEnabled) {
      console.log('Biometric not enabled');
      return false;
    }

    const storedCredentialId = localStorage.getItem(BIOMETRIC_CREDENTIAL_KEY);
    if (!storedCredentialId) {
      console.log('No stored credential');
      return false;
    }

    try {
      setIsAuthenticating(true);

      const publicKeyCredentialRequestOptions: PublicKeyCredentialRequestOptions = {
        challenge: new Uint8Array(generateChallenge()) as BufferSource,
        rpId: window.location.hostname,
        allowCredentials: [
          {
            id: base64ToArrayBuffer(storedCredentialId),
            type: 'public-key',
            transports: ['internal'],
          },
        ],
        userVerification: 'required',
        timeout: 60000,
      };

      const assertion = await navigator.credentials.get({
        publicKey: publicKeyCredentialRequestOptions,
      });

      return !!assertion;
    } catch (error: any) {
      console.error('Biometric authentication failed:', error);
      return false;
    } finally {
      setIsAuthenticating(false);
    }
  };

  return (
    <BiometricAuthContext.Provider value={{
      isBiometricAvailable,
      isBiometricEnabled,
      biometricType,
      enableBiometric,
      disableBiometric,
      authenticateWithBiometric,
      isAuthenticating,
    }}>
      {children}
    </BiometricAuthContext.Provider>
  );
}

export function useBiometricAuth() {
  const context = useContext(BiometricAuthContext);
  if (context === undefined) {
    throw new Error('useBiometricAuth must be used within a BiometricAuthProvider');
  }
  return context;
}
