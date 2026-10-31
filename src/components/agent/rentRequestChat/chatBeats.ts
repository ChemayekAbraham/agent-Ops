/**
 * Question order for the agent rent-request chat.
 * Standard beats mirror the live wizard (rent, tenant, property, officials, review).
 * Outstanding beats mirror the live outstanding form, plus the photo and
 * passport checks the submit gate already requires.
 */
export const STANDARD_BEATS = [
  'type',
  'rent',
  'noPhone',
  'tenantName',
  'tenantPhone',
  'nationalId',
  'language',
  'category',
  'landlord',
  'place',
  'gps',
  'housePhotos',
  'passport',
  'lcLetter',
  'lc1',
  'placeMeta',
  'review',
] as const;

export const OUTSTANDING_BEATS = [
  'type',
  'osLandlord',
  'osTenantName',
  'osTenantPhone',
  'osNationalId',
  'osLanguage',
  'osRentAmount',
  'osDuration',
  'osBalance',
  'osDays',
  'osCategory',
  'osPhotos',
  'osPassport',
  'osReview',
] as const;

export type ChatBeatId =
  | (typeof STANDARD_BEATS)[number]
  | (typeof OUTSTANDING_BEATS)[number];

export const BEAT_PROMPT: Record<ChatBeatId, string> = {
  type: 'How does this tenant pay rent?',
  rent: 'What is the rent, and how long will they repay?',
  noPhone: 'Does this tenant have a smartphone?',
  tenantName: "What is the tenant's full name, as it is on their ID?",
  tenantPhone: 'What phone number do they answer?',
  nationalId: "What is the tenant's National ID? 10 to 14 letters or numbers.",
  language: 'Which language does the tenant speak?',
  category: 'What kind of house is it?',
  landlord: 'Who owns the house? Search for the landlord, or register a new one.',
  place: 'Which village is the house in?',
  gps: 'Stand at the house and attach the GPS pin.',
  housePhotos: 'Attach all 4 outside photos: front, back, left and right.',
  passport: "Attach a passport photo of the tenant's face.",
  lcLetter: 'Attach the LC letter if you have it. You can skip this.',
  lc1: 'Who is the LC1 chairperson for that village?',
  placeMeta: 'Confirm the town, district, and the day Welile pays the landlord.',
  review: 'Check the details, accept guarantor responsibility, then submit.',
  osLandlord: 'Who is the landlord for this outstanding balance?',
  osTenantName: "What is the tenant's full name?",
  osTenantPhone: "What is the tenant's phone number?",
  osNationalId: 'National ID if you have it. You can skip this for an outstanding balance.',
  osLanguage: 'Which language does the tenant speak?',
  osRentAmount: 'What is the monthly rent?',
  osDuration: 'How many days will they repay?',
  osBalance: 'What outstanding balance do they still owe?',
  osDays: 'How many days are left on the current rent period?',
  osCategory: 'What kind of house is it? You can skip this.',
  osPhotos: 'Attach all 4 outside photos of the house. Posting needs these photos.',
  osPassport: "Attach the tenant's passport photo.",
  osReview: 'Review the outstanding balance, accept guarantor responsibility, then submit.',
};

export const BEAT_LABEL: Record<ChatBeatId, string> = {
  type: 'Type',
  rent: 'Rent',
  noPhone: 'Phone',
  tenantName: 'Name',
  tenantPhone: 'Phone',
  nationalId: 'ID',
  language: 'Language',
  category: 'House',
  landlord: 'Landlord',
  place: 'Village',
  gps: 'GPS',
  housePhotos: 'Photos',
  passport: 'Passport',
  lcLetter: 'LC letter',
  lc1: 'LC1',
  placeMeta: 'Place',
  review: 'Review',
  osLandlord: 'Landlord',
  osTenantName: 'Name',
  osTenantPhone: 'Phone',
  osNationalId: 'ID',
  osLanguage: 'Language',
  osRentAmount: 'Rent',
  osDuration: 'Duration',
  osBalance: 'Balance',
  osDays: 'Days left',
  osCategory: 'House',
  osPhotos: 'Photos',
  osPassport: 'Passport',
  osReview: 'Review',
};

const TENANT_BEATS = new Set<string>([
  'noPhone', 'tenantName', 'tenantPhone', 'nationalId', 'language',
]);
const PROPERTY_BEATS = new Set<string>([
  'category', 'landlord', 'place', 'gps', 'housePhotos', 'passport',
]);
const OFFICIAL_BEATS = new Set<string>(['lcLetter', 'lc1', 'placeMeta']);

export function beatsFor(incomeType: string | null): readonly ChatBeatId[] {
  return incomeType === 'outstanding' ? OUTSTANDING_BEATS : STANDARD_BEATS;
}

export function isTenantBeat(id: string): boolean {
  return TENANT_BEATS.has(id);
}
export function isPropertyBeat(id: string): boolean {
  return PROPERTY_BEATS.has(id);
}
export function isOfficialBeat(id: string): boolean {
  return OFFICIAL_BEATS.has(id);
}

export function isSkippableBeat(id: string): boolean {
  return id === 'lcLetter' || id === 'osNationalId' || id === 'osCategory';
}

export function isReviewBeat(id: string): boolean {
  return id === 'review' || id === 'osReview';
}

/** Wizard step the classic dialog uses, so draft restore and error jumps stay aligned. */
export function detailStepForBeat(id: string): number {
  if (['rent', 'osRentAmount', 'osDuration', 'osBalance', 'osDays'].includes(id)) return 0;
  if ([
    'noPhone', 'tenantName', 'tenantPhone', 'nationalId', 'language',
    'osTenantName', 'osTenantPhone', 'osNationalId', 'osLanguage',
  ].includes(id)) return 1;
  if ([
    'category', 'landlord', 'place', 'gps', 'housePhotos', 'passport',
    'osLandlord', 'osCategory', 'osPhotos', 'osPassport',
  ].includes(id)) return 2;
  if (['lcLetter', 'lc1', 'placeMeta'].includes(id)) return 3;
  return 4;
}
