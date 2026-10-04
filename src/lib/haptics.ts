/**
 * Haptic feedback utilities for mobile devices
 * Uses the Vibration API when available
 * Respects user's haptic intensity preferences
 */

import { getStoredHapticIntensity, getIntensityMultiplier } from '@/hooks/useHapticSettings';

type HapticPattern = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' | 'selection';

const basePatterns: Record<HapticPattern, number | number[]> = {
  light: 10,
  medium: 25,
  heavy: 50,
  success: [10, 50, 20],
  warning: [30, 50, 30],
  error: [50, 100, 50],
  selection: 5,
};

/**
 * Apply intensity multiplier to a pattern
 */
function applyIntensity(pattern: number | number[], multiplier: number): number | number[] {
  if (multiplier === 0) return 0;
  
  if (typeof pattern === 'number') {
    return Math.round(pattern * multiplier);
  }
  
  return pattern.map(v => Math.round(v * multiplier));
}

/**
 * Check if haptic feedback is supported
 */
export function isHapticSupported(): boolean {
  return typeof navigator !== 'undefined' && 'vibrate' in navigator;
}

/**
 * Check if haptic feedback is enabled
 */
export function isHapticEnabled(): boolean {
  const intensity = getStoredHapticIntensity();
  return intensity !== 'off';
}

/**
 * Trigger haptic feedback with intensity adjustment
 * @param pattern - The type of haptic feedback to trigger
 */
export function haptic(pattern: HapticPattern = 'light'): void {
  if (!isHapticSupported()) return;
  
  const intensity = getStoredHapticIntensity();
  if (intensity === 'off') return;
  
  const multiplier = getIntensityMultiplier(intensity);
  const adjustedPattern = applyIntensity(basePatterns[pattern], multiplier);
  
  try {
    navigator.vibrate(adjustedPattern);
  } catch {
    // Silently fail if vibration is not allowed
  }
}

/**
 * Trigger a light tap feedback
 */
export function hapticTap(): void {
  haptic('light');
}

/**
 * Trigger a medium impact feedback
 */
export function hapticImpact(): void {
  haptic('medium');
}

/**
 * Trigger a heavy impact feedback
 */
export function hapticHeavy(): void {
  haptic('heavy');
}

/**
 * Trigger a success feedback pattern
 */
export function hapticSuccess(): void {
  haptic('success');
}

/**
 * Trigger a warning feedback pattern
 */
export function hapticWarning(): void {
  haptic('warning');
}

/**
 * Trigger an error feedback pattern
 */
export function hapticError(): void {
  haptic('error');
}

/**
 * Trigger a selection change feedback
 */
export function hapticSelection(): void {
  haptic('selection');
}
