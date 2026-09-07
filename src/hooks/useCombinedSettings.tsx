import { createContext, useContext, useState, useEffect, ReactNode, useMemo } from 'react';

// ============= Font Size =============
export type FontSize = 'small' | 'medium' | 'large' | 'extra-large';

const fontSizePixels: Record<FontSize, string> = {
  'small': '14px',
  'medium': '16px',
  'large': '18px',
  'extra-large': '20px'
};

const fontSizeClasses: Record<FontSize, string> = {
  'small': 'text-sm',
  'medium': 'text-base',
  'large': 'text-lg',
  'extra-large': 'text-xl'
};

export const fontSizeOptions: { value: FontSize; label: string; description: string }[] = [
  { value: 'small', label: 'Small', description: '14px' },
  { value: 'medium', label: 'Medium', description: '16px' },
  { value: 'large', label: 'Large', description: '18px (Default)' },
  { value: 'extra-large', label: 'Extra Large', description: '20px' },
];

// ============= Haptic Settings =============
export type HapticIntensity = 'off' | 'light' | 'medium' | 'strong';

export const hapticIntensityOptions = [
  { value: 'off' as const, label: 'Off', description: 'No vibration feedback' },
  { value: 'light' as const, label: 'Light', description: 'Subtle vibration' },
  { value: 'medium' as const, label: 'Medium', description: 'Balanced feedback' },
  { value: 'strong' as const, label: 'Strong', description: 'Maximum intensity' },
];

export function getIntensityMultiplier(intensity: HapticIntensity): number {
  switch (intensity) {
    case 'off': return 0;
    case 'light': return 0.5;
    case 'medium': return 1;
    case 'strong': return 1.5;
    default: return 1;
  }
}

// ============= Reduced Motion =============
export type ReducedMotion = 'system' | 'reduce' | 'no-preference';

export const reducedMotionOptions = [
  { value: 'system' as const, label: 'Follow system', description: 'Match your device settings' },
  { value: 'reduce' as const, label: 'Reduce motion', description: 'Disable animations' },
  { value: 'no-preference' as const, label: 'Allow motion', description: 'Enable animations' },
];

function getSystemPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function resolvePrefersReducedMotion(setting: ReducedMotion): boolean {
  if (setting === 'reduce') return true;
  if (setting === 'no-preference') return false;
  return getSystemPrefersReducedMotion();
}

// ============= Combined Context =============
interface CombinedSettingsContextType {
  // Font Size
  fontSize: FontSize;
  setFontSize: (size: FontSize) => void;
  fontSizeClass: string;
  // High Contrast
  highContrast: boolean;
  toggleHighContrast: () => void;
  setHighContrast: (enabled: boolean) => void;
  // Haptic Settings
  hapticIntensity: HapticIntensity;
  setHapticIntensity: (intensity: HapticIntensity) => void;
  isHapticEnabled: boolean;
  // Reduced Motion
  reducedMotion: ReducedMotion;
  setReducedMotion: (value: ReducedMotion) => void;
  prefersReducedMotion: boolean;
}

const CombinedSettingsContext = createContext<CombinedSettingsContextType | undefined>(undefined);

// Storage keys
const FONT_SIZE_KEY = 'welile-font-size';
const HIGH_CONTRAST_KEY = 'welile_high_contrast';
const HAPTIC_KEY = 'haptic-intensity';
const REDUCED_MOTION_KEY = 'welile-reduced-motion';

export function CombinedSettingsProvider({ children }: { children: ReactNode }) {
  // Font Size State
  const [fontSize, setFontSizeState] = useState<FontSize>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(FONT_SIZE_KEY);
      if (saved && ['small', 'medium', 'large', 'extra-large'].includes(saved)) {
        return saved as FontSize;
      }
    }
    return 'large';
  });

  // High Contrast State
  const [highContrast, setHighContrastState] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(HIGH_CONTRAST_KEY) === 'true';
    }
    return false;
  });

  // Haptic Settings State
  const [hapticIntensity, setHapticIntensityState] = useState<HapticIntensity>(() => {
    if (typeof window === 'undefined') return 'medium';
    const stored = localStorage.getItem(HAPTIC_KEY);
    return (stored as HapticIntensity) || 'medium';
  });

  // Reduced Motion State
  const [reducedMotion, setReducedMotionState] = useState<ReducedMotion>(() => {
    if (typeof window === 'undefined') return 'system';
    const stored = localStorage.getItem(REDUCED_MOTION_KEY);
    if (stored && ['system', 'reduce', 'no-preference'].includes(stored)) {
      return stored as ReducedMotion;
    }
    return 'system';
  });

  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    resolvePrefersReducedMotion(reducedMotion)
  );

  // Font Size Effects
  useEffect(() => {
    document.documentElement.style.fontSize = fontSizePixels[fontSize];
    document.documentElement.setAttribute('data-font-size', fontSize);
    localStorage.setItem(FONT_SIZE_KEY, fontSize);
  }, [fontSize]);

  // High Contrast Effects
  useEffect(() => {
    const root = document.documentElement;
    if (highContrast) {
      root.classList.add('high-contrast');
    } else {
      root.classList.remove('high-contrast');
    }
    localStorage.setItem(HIGH_CONTRAST_KEY, String(highContrast));
  }, [highContrast]);

  // Haptic Effects
  useEffect(() => {
    localStorage.setItem(HAPTIC_KEY, hapticIntensity);
  }, [hapticIntensity]);

  // Reduced Motion Effects
  useEffect(() => {
    localStorage.setItem(REDUCED_MOTION_KEY, reducedMotion);
    setPrefersReducedMotion(resolvePrefersReducedMotion(reducedMotion));
  }, [reducedMotion]);

  // Reflect the resolved motion preference on <html> so global CSS (and any
  // component that cannot read the context) can honour an in-app "Reduce
  // motion" choice, not just the OS-level setting.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('reduce-motion', prefersReducedMotion);
  }, [prefersReducedMotion]);

  // Listen to system preference changes when in "system" mode
  useEffect(() => {
    if (typeof window === 'undefined' || reducedMotion !== 'system') return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [reducedMotion]);

  // Memoized context value
  const value = useMemo(() => ({
    // Font Size
    fontSize,
    setFontSize: (size: FontSize) => setFontSizeState(size),
    fontSizeClass: fontSizeClasses[fontSize],
    // High Contrast
    highContrast,
    toggleHighContrast: () => setHighContrastState(prev => !prev),
    setHighContrast: (enabled: boolean) => setHighContrastState(enabled),
    // Haptic Settings
    hapticIntensity,
    setHapticIntensity: (intensity: HapticIntensity) => setHapticIntensityState(intensity),
    isHapticEnabled: hapticIntensity !== 'off',
    // Reduced Motion
    reducedMotion,
    setReducedMotion: (value: ReducedMotion) => setReducedMotionState(value),
    prefersReducedMotion,
  }), [fontSize, highContrast, hapticIntensity, reducedMotion, prefersReducedMotion]);

  return (
    <CombinedSettingsContext.Provider value={value}>
      {children}
    </CombinedSettingsContext.Provider>
  );
}

// Default values for when context is not available (prevents white screen)
const defaultContextValue: CombinedSettingsContextType = {
  fontSize: 'large',
  setFontSize: () => {},
  fontSizeClass: 'text-lg',
  highContrast: false,
  toggleHighContrast: () => {},
  setHighContrast: () => {},
  hapticIntensity: 'medium',
  setHapticIntensity: () => {},
  isHapticEnabled: true,
  reducedMotion: 'system',
  setReducedMotion: () => {},
  prefersReducedMotion: false,
};

export function useCombinedSettings() {
  const context = useContext(CombinedSettingsContext);
  // Return defaults if context not available (prevents crash during initialization)
  if (context === undefined) {
    return defaultContextValue;
  }
  return context;
}

// ============= Standalone Getters (for use outside React) =============
export function getStoredHapticIntensity(): HapticIntensity {
  if (typeof window === 'undefined') return 'medium';
  const stored = localStorage.getItem(HAPTIC_KEY);
  return (stored as HapticIntensity) || 'medium';
}

// ============= Legacy Hook Wrappers (for backwards compatibility) =============
export function useFontSize() {
  const { fontSize, setFontSize, fontSizeClass } = useCombinedSettings();
  return { fontSize, setFontSize, fontSizeClass };
}

export function useHighContrast() {
  const { highContrast, toggleHighContrast, setHighContrast } = useCombinedSettings();
  return { highContrast, toggleHighContrast, setHighContrast };
}

export function useHapticSettings() {
  const { hapticIntensity, setHapticIntensity, isHapticEnabled } = useCombinedSettings();
  return { 
    intensity: hapticIntensity, 
    setIntensity: setHapticIntensity, 
    isEnabled: isHapticEnabled 
  };
}

export function useReducedMotion() {
  const { reducedMotion, setReducedMotion, prefersReducedMotion } = useCombinedSettings();
  return { reducedMotion, setReducedMotion, prefersReducedMotion };
}
