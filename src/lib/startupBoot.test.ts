import { describe, expect, it } from 'vitest';
import {
  BOOT_RECOVERY_COOLDOWN_MS,
  bootRecoveryAllowed,
  isProductionStartupHost,
  isRecoverableBootFailure,
} from './startupBoot';

describe('startup boot host gate', () => {
  it('reports the public hosts', () => {
    expect(isProductionStartupHost('welileapp.com')).toBe(true);
    expect(isProductionStartupHost('www.welileapp.com')).toBe(true);
    expect(isProductionStartupHost('welilereceipts.com')).toBe(true);
    expect(isProductionStartupHost('WWW.WelileReceipts.com.')).toBe(true);
  });

  it('does not report preview or local dev', () => {
    expect(isProductionStartupHost('preview--abc.lovableproject.com')).toBe(false);
    expect(isProductionStartupHost('id-preview--43e6c2e1.lovable.app')).toBe(false);
    expect(isProductionStartupHost('localhost')).toBe(false);
    expect(isProductionStartupHost('127.0.0.1')).toBe(false);
  });
});

describe('recoverable boot failures', () => {
  it('reloads once for a rotated or stalled App chunk', () => {
    expect(
      isRecoverableBootFailure(
        new TypeError('Failed to fetch dynamically imported module: https://welileapp.com/assets/App-x.js'),
      ),
    ).toBe(true);
    expect(isRecoverableBootFailure(new Error('Importing a module script failed.'))).toBe(true);
    expect(isRecoverableBootFailure(new Error('Import timeout'))).toBe(true);
    expect(isRecoverableBootFailure(new Error('error loading dynamically imported module'))).toBe(true);
  });

  it('does not reload an application exception', () => {
    expect(isRecoverableBootFailure(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(isRecoverableBootFailure(null)).toBe(false);
  });

  it('allows a second recovery only after the cooldown', () => {
    const now = 1_000_000;
    expect(bootRecoveryAllowed(0, now)).toBe(true);
    expect(bootRecoveryAllowed(now - 1_000, now)).toBe(false);
    expect(bootRecoveryAllowed(now - BOOT_RECOVERY_COOLDOWN_MS, now)).toBe(true);
  });
});
