import { describe, it, expect } from 'vitest';
import {
  NO_PAYMENT_PRESETS, daysPlus, isValidNoPaymentDays, noPaymentBands, noPaymentDaysError, noPaymentFileStem,
  noPaymentTitle, parseNoPaymentDays, withoutPaymentText,
} from './noPaymentDays';

describe('parseNoPaymentDays', () => {
  it('reads a whole number from 1 to 365 and falls back to 20 for anything else', () => {
    expect(parseNoPaymentDays('30')).toBe(30);
    expect(parseNoPaymentDays('1')).toBe(1);
    expect(parseNoPaymentDays('365')).toBe(365);
    expect(parseNoPaymentDays(null)).toBe(20);
    expect(parseNoPaymentDays(undefined)).toBe(20);
    for (const bad of ['', '0', '366', '-5', '12.5', 'abc', '1e2', '0030x', '9999']) expect(parseNoPaymentDays(bad)).toBe(20);
  });
});

describe('thresholds and wording', () => {
  it('has the agreed presets', () => {
    expect([...NO_PAYMENT_PRESETS]).toEqual([7, 14, 20, 30, 45, 60]);
  });
  it('bands are N, N+10 and N+20 (20 / 30 / 40 at the default)', () => {
    expect(noPaymentBands(20)).toEqual([20, 30, 40]);
    expect(noPaymentBands(45)).toEqual([45, 55, 65]);
  });
  it('titles say N+ days', () => {
    expect(noPaymentTitle(30)).toBe('30+ Days No Payment');
    expect(withoutPaymentText(14)).toBe('14+ days without payment');
    expect(daysPlus(60)).toBe('60+ days');
    expect(noPaymentFileStem(45)).toBe('45_Plus_Days_No_Payment');
  });
  it('validates typed values', () => {
    expect(isValidNoPaymentDays(1)).toBe(true);
    expect(isValidNoPaymentDays(0)).toBe(false);
    expect(isValidNoPaymentDays(366)).toBe(false);
    expect(isValidNoPaymentDays(2.5)).toBe(false);
    expect(noPaymentDaysError('30')).toBeNull();
    expect(noPaymentDaysError('0')).toMatch(/1 to 365/);
    expect(noPaymentDaysError('366')).toMatch(/1 to 365/);
    expect(noPaymentDaysError('abc')).toMatch(/1 to 365/);
    expect(noPaymentDaysError('')).toMatch(/1 to 365/);
  });
});
