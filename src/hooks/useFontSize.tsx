// Re-export from combined settings for backwards compatibility
export { useFontSize, fontSizeOptions } from './useCombinedSettings';
export type { FontSize } from './useCombinedSettings';

// Legacy provider - now just wraps CombinedSettingsProvider
// Components using this directly should migrate to CombinedSettingsProvider
export { CombinedSettingsProvider as FontSizeProvider } from './useCombinedSettings';
