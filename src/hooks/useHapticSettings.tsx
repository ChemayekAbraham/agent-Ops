// Re-export from combined settings for backwards compatibility
export { 
  useHapticSettings, 
  hapticIntensityOptions, 
  getIntensityMultiplier,
  getStoredHapticIntensity
} from './useCombinedSettings';
export type { HapticIntensity } from './useCombinedSettings';

// Legacy provider - now just wraps CombinedSettingsProvider
// Components using this directly should migrate to CombinedSettingsProvider
export { CombinedSettingsProvider as HapticSettingsProvider } from './useCombinedSettings';
