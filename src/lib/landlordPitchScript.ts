import type { ScriptSteps } from './voiceAutocall';

export const LANDLORD_PITCH_PERIOD_MONTHS = [3, 6, 12] as const;
export type LandlordPitchPeriodMonths = (typeof LANDLORD_PITCH_PERIOD_MONTHS)[number];

export function formatUGX(amount: number): string {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0;
  return `UGX ${safeAmount.toLocaleString('en-UG')}`;
}

/**
 * Pure calculator maths: monthly rent per unit * number of units * agreed months (3, 6, or 12).
 * Uses the exact same formula (`rent * units * months`) as the previous 12-month calculator.
 */
export function calculateLandlordPeriodRent(
  rentPerUnit: number,
  units: number,
  months: LandlordPitchPeriodMonths,
): number {
  const r = Number(rentPerUnit) > 0 ? Number(rentPerUnit) : 0;
  const u = Number(units) > 0 ? Number(units) : 0;
  return r * u * months;
}

/**
 * Formats the bounded calculator offer: "UGX [amount] for [period]".
 */
export function formatLandlordPeriodOffer(
  rentPerUnit: number,
  units: number,
  months: LandlordPitchPeriodMonths,
): string {
  const total = calculateLandlordPeriodRent(rentPerUnit, units, months);
  return `${formatUGX(total)} for ${months} months`;
}

/**
 * Reframed copy for `/landlord-signup` so the pitch leads with what Welile actually does
 * and a bounded 3, 6, or 12-month offer tied to a tenant's Rent Plan.
 */
export const LANDLORD_SIGNUP_COPY = {
  pageTitle: 'Rent Paid on Time for Your Tenant’s Rent Plan | Welile',
  metaDescription:
    'Welile pays a landlord their tenant’s rent on time for an agreed 3, 6, or 12-month period while the tenant repays Welile over time through a Rent Plan.',
  heroEyebrow: 'Welile Technologies · Landlord Rent Plan Partner',
  heroTitle: 'On-Time Rent for the Tenant You Already Have',
  heroWhatWeDo:
    'Welile pays a landlord their tenant’s rent, on time, for an agreed period of 3, 6, or 12 months, while the tenant repays Welile over time through a Rent Plan.',
  calculatorTitle: 'Estimate Rent Covered for Your Agreed Period',
  calculatorPeriodLabel: 'Choose Rent Plan Period',
  calculatorResultEyebrow: (months: LandlordPitchPeriodMonths) =>
    `Estimated Rent Covered (${months}-Month Rent Plan)`,
  howMoneyMovesNote:
    'How payment works: Payouts are tied to a signed-up, verified tenant’s active Rent Plan and released in agreed stages after tenant and property verification — never an unconditional lump sum on signup.',
  formHeading: 'Register Your Property for a Tenant Rent Plan',
  consentLabel:
    'I agree to register my property with Welile so eligible tenants can apply for a 3, 6, or 12-month Rent Plan, with rent paid on time according to each verified Rent Plan schedule.',
  submitButtonLabel: 'Register My Property with Welile',
  submittedTitle: 'Property Registration Received',
  submittedLead:
    'Thank you for registering with Welile. A Landlord Operations officer or field agent will contact you to verify your property and match your tenant’s Rent Plan.',
  submittedSubtext:
    'Once your tenant’s Rent Plan is verified and approved, rent is paid directly to your confirmed payout number on the agreed schedule.',
  shareLinkMessage: (link: string) =>
    `Have a tenant behind on rent or an empty unit? Welile pays a landlord their tenant's rent on time for an agreed 3, 6, or 12-month Rent Plan while the tenant repays Welile over time. Register your property here: ${link}`,
} as const;

export interface LandlordPhoneScriptStep {
  stepNumber: number;
  title: string;
  spokenText: string;
  coachingNote: string;
}

/**
 * Short, reusable phone-opening script for Jane, Winnie, and Hanisha when pitching
 * a new or prospective landlord. Leads with a concrete question about a tenant behind
 * on rent or an empty unit, then offers to cover that specific tenant's rent for a stated
 * number of months (3, 6, or up to 12 months) through a Rent Plan.
 */
export const NEW_LANDLORD_PHONE_OPENING_SCRIPT =
  'Hello [Landlord Name], I am calling from Welile Landlord Operations. Do you currently have a tenant who is behind on rent, or a unit sitting empty? Instead of you chasing rent, Welile can enroll that tenant on a Rent Plan and pay their rent to you on time for an agreed 3, 6, or up to 12 months while the tenant repays Welile in smaller instalments.';

export const NEW_LANDLORD_HOW_PAYMENT_WORKS_SCRIPT =
  'Once your tenant signs up on a Welile Rent Plan and our team verifies the tenancy and your Mobile Money payout number, Welile pays that tenant’s rent directly to you for the agreed months. When we pay you, you receive an SMS from WELILE with a 6-digit payment code valid for 1 hour to share only with the agent paying you.';

export const NEW_LANDLORD_CALLING_STEPS: readonly LandlordPhoneScriptStep[] = [
  {
    stepNumber: 1,
    title: 'Ask about one real tenant or empty unit first',
    spokenText:
      'Hello [Landlord Name], I am calling from Welile Landlord Operations. Do you currently have one tenant who is behind on rent, or an empty house you want occupied?',
    coachingNote:
      'Start with a real problem the landlord already has today. Never open with an abstract annual million-shilling figure.',
  },
  {
    stepNumber: 2,
    title: 'Offer a specific 3, 6, or 12-month Rent Plan for that unit',
    spokenText:
      'For that specific tenant, Welile can set up a 3-month, 6-month, or 12-month Rent Plan. We pay you the agreed rent on time, and the tenant repays Welile gradually over time.',
    coachingNote:
      'Quote the exact rent for 1 unit over 3 months first (for example, UGX 500,000 x 1 unit x 3 months = UGX 1,500,000 for 3 months).',
  },
  {
    stepNumber: 3,
    title: 'Explain clearly how and when the money moves',
    spokenText:
      'Payment is tied to your signed-up tenant’s approved Rent Plan and paid in agreed stages after our team verifies the tenant and your payout number — not an unverified lump sum.',
    coachingNote:
      'Be transparent that payouts follow a verified tenant Rent Plan and use the 6-digit WELILE SMS code at payout.',
  },
] as const;

/**
 * Ready-to-use AutocallScript steps template so `AutocallScripts` can also seed
 * a new-landlord outreach script using the exact same opening.
 */
export const NEW_LANDLORD_AUTOCALL_TEMPLATE: {
  name: string;
  occasion: string;
  description: string;
  steps: ScriptSteps;
} = {
  name: 'New Landlord Rent Plan Opening Pitch',
  occasion: 'landlord_rent_plan_pitch',
  description:
    'Asks whether the landlord has a tenant behind on rent or an empty unit and offers a 3, 6, or 12-month Rent Plan.',
  steps: {
    voice: 'woman',
    start: 'greeting',
    steps: {
      greeting: {
        type: 'say',
        say: 'Hello {first_name}. This is Welile Landlord Operations. Do you currently have a tenant behind on rent, or an empty unit? Welile can place that tenant on a Rent Plan and pay their rent to you on time for 3, 6, or 12 months while the tenant repays Welile over time.',
        next: 'how_it_works',
      },
      how_it_works: {
        type: 'menu',
        say: 'Payouts are tied to a verified tenant Rent Plan and released in agreed stages to your confirmed number. Press 1 to speak with our Landlord Operations team about a tenant. Press 2 if you want an agent to call you back. Press 9 to stop automated calls.',
        options: {
          '1': { next: 'connect_team', outcome: 'transfer_requested' },
          '2': { next: 'finish', outcome: 'agent_callback' },
          '9': { next: 'finish', outcome: 'opted_out', action: 'opt_out' },
        },
        no_input: { next: 'finish', outcome: 'no_choice' },
      },
      connect_team: {
        type: 'transfer',
        fallback_next: 'finish',
      },
      finish: {
        type: 'hangup',
      },
    },
  },
};
