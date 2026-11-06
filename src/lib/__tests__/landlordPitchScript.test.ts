// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LANDLORD_PITCH_PERIOD_MONTHS,
  LANDLORD_SIGNUP_COPY,
  NEW_LANDLORD_AUTOCALL_TEMPLATE,
  NEW_LANDLORD_CALLING_STEPS,
  NEW_LANDLORD_HOW_PAYMENT_WORKS_SCRIPT,
  NEW_LANDLORD_PHONE_OPENING_SCRIPT,
  calculateLandlordPeriodRent,
  formatLandlordPeriodOffer,
} from '../landlordPitchScript';
import { checkScript } from '../voiceAutocall';

describe('landlordPitchScript & LandlordSignup — Prompt 2 verification', () => {
  describe('(1) Calculator maths parity (rent * units * months) and bounded offer formatting', () => {
    it('supports 3, 6, and 12 month periods and matches rent * units * months', () => {
      expect(LANDLORD_PITCH_PERIOD_MONTHS).toEqual([3, 6, 12]);

      // 1 unit at UGX 500,000/month
      expect(calculateLandlordPeriodRent(500_000, 1, 3)).toBe(1_500_000);
      expect(calculateLandlordPeriodRent(500_000, 1, 6)).toBe(3_000_000);
      expect(calculateLandlordPeriodRent(500_000, 1, 12)).toBe(6_000_000);

      // 5 units at UGX 500,000/month — 12 months matches the old r * u * 12 formula (30,000,000)
      expect(calculateLandlordPeriodRent(500_000, 5, 3)).toBe(7_500_000);
      expect(calculateLandlordPeriodRent(500_000, 5, 6)).toBe(15_000_000);
      expect(calculateLandlordPeriodRent(500_000, 5, 12)).toBe(500_000 * 5 * 12);

      // Handles zero/negative/empty inputs safely
      expect(calculateLandlordPeriodRent(0, 5, 3)).toBe(0);
      expect(calculateLandlordPeriodRent(-100, 2, 6)).toBe(0);
    });

    it('formats the bounded offer as "UGX [amount] for [period]"', () => {
      expect(formatLandlordPeriodOffer(500_000, 1, 3)).toBe('UGX 1,500,000 for 3 months');
      expect(formatLandlordPeriodOffer(500_000, 1, 6)).toBe('UGX 3,000,000 for 6 months');
      expect(formatLandlordPeriodOffer(500_000, 1, 12)).toBe('UGX 6,000,000 for 12 months');
      expect(formatLandlordPeriodOffer(500_000, 5, 12)).toBe('UGX 30,000,000 for 12 months');
      expect(formatLandlordPeriodOffer(0, 1, 3)).toBe('UGX 0 for 3 months');
    });
  });

  describe('(2) Regulatory terminology, no unconditional guarantee claims, and calling script validation', () => {
    it('uses Rent Plan terminology and never uses loan, lender, ROI, interest, or unconditional guarantee claims', () => {
      const allCopy = [
        LANDLORD_SIGNUP_COPY.pageTitle,
        LANDLORD_SIGNUP_COPY.metaDescription,
        LANDLORD_SIGNUP_COPY.heroEyebrow,
        LANDLORD_SIGNUP_COPY.heroTitle,
        LANDLORD_SIGNUP_COPY.heroWhatWeDo,
        LANDLORD_SIGNUP_COPY.calculatorTitle,
        LANDLORD_SIGNUP_COPY.calculatorPeriodLabel,
        LANDLORD_SIGNUP_COPY.calculatorResultEyebrow(3),
        LANDLORD_SIGNUP_COPY.calculatorResultEyebrow(6),
        LANDLORD_SIGNUP_COPY.calculatorResultEyebrow(12),
        LANDLORD_SIGNUP_COPY.howMoneyMovesNote,
        LANDLORD_SIGNUP_COPY.formHeading,
        LANDLORD_SIGNUP_COPY.consentLabel,
        LANDLORD_SIGNUP_COPY.submitButtonLabel,
        LANDLORD_SIGNUP_COPY.submittedTitle,
        LANDLORD_SIGNUP_COPY.submittedLead,
        LANDLORD_SIGNUP_COPY.submittedSubtext,
        LANDLORD_SIGNUP_COPY.shareLinkMessage('https://welileapp.com/landlord-signup'),
        NEW_LANDLORD_PHONE_OPENING_SCRIPT,
        NEW_LANDLORD_HOW_PAYMENT_WORKS_SCRIPT,
        ...NEW_LANDLORD_CALLING_STEPS.flatMap((s) => [s.title, s.spokenText, s.coachingNote]),
      ].join(' ');

      expect(allCopy).toContain('Rent Plan');
      expect(allCopy).not.toMatch(/\b(loans?|lenders?|ROI|interest)\b/i);
      expect(allCopy).not.toMatch(/\bguaranteed income\b/i);
      expect(allCopy).not.toMatch(/\brent guarantee\b/i);
    });

    it('leads the phone opening script by asking about a tenant behind on rent or an empty unit', () => {
      expect(NEW_LANDLORD_PHONE_OPENING_SCRIPT).toMatch(/tenant.*behind on rent/i);
      expect(NEW_LANDLORD_PHONE_OPENING_SCRIPT).toMatch(/empty/i);
      expect(NEW_LANDLORD_PHONE_OPENING_SCRIPT).toMatch(/3,\s*6,\s*or\s*(up to\s*)?12\s*months/i);
    });

    it('provides a valid AutocallScripts template with zero checkScript issues', () => {
      const issues = checkScript(NEW_LANDLORD_AUTOCALL_TEMPLATE.steps);
      expect(issues).toEqual([]);
    });
  });

  describe('(3) LandlordSignup.tsx layout & landlord_leads submission contract', () => {
    it('keeps the landlord_leads insert payload unchanged and enforces mobile-first 44px tap targets', () => {
      const pageSource = readFileSync(
        resolve(process.cwd(), 'src/pages/LandlordSignup.tsx'),
        'utf8',
      );

      // Preserves exact landlord_leads insert fields
      expect(pageSource).toContain("supabase.from('landlord_leads').insert({");
      expect(pageSource).toContain('full_name: nameCheck.fullName,');
      expect(pageSource).toContain('phone: form.phone.trim(),');
      expect(pageSource).toContain('property_location: form.location.trim(),');
      expect(pageSource).toContain('number_of_units: Number(form.units),');
      expect(pageSource).toContain('rent_per_unit: Number(form.rentPerUnit),');
      expect(pageSource).toContain('referrer_agent_id: agentId,');
      expect(pageSource).toContain('campaign,');
      expect(pageSource).toContain("status: 'new_lead',");

      // Preserves canonical tag and mobile-first 44px tap targets
      expect(pageSource).toContain('href="https://welileapp.com/landlord-signup"');
      expect(pageSource).toContain('min-h-[44px]');
      expect(pageSource).not.toMatch(/Your 12-Month Guaranteed Income/i);
    });
  });
});
