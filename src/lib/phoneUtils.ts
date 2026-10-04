// Country codes for common East African and nearby countries
const COUNTRY_PREFIXES: Record<string, { code: string; name: string; flag: string }> = {
  // East Africa
  '256': { code: '256', name: 'Uganda', flag: '🇺🇬' },
  '254': { code: '254', name: 'Kenya', flag: '🇰🇪' },
  '255': { code: '255', name: 'Tanzania', flag: '🇹🇿' },
  '250': { code: '250', name: 'Rwanda', flag: '🇷🇼' },
  '257': { code: '257', name: 'Burundi', flag: '🇧🇮' },
  '211': { code: '211', name: 'South Sudan', flag: '🇸🇸' },
  '251': { code: '251', name: 'Ethiopia', flag: '🇪🇹' },
  '253': { code: '253', name: 'Djibouti', flag: '🇩🇯' },
  '291': { code: '291', name: 'Eritrea', flag: '🇪🇷' },
  '252': { code: '252', name: 'Somalia', flag: '🇸🇴' },
  // Central Africa
  '243': { code: '243', name: 'DR Congo', flag: '🇨🇩' },
  '242': { code: '242', name: 'Congo', flag: '🇨🇬' },
  '237': { code: '237', name: 'Cameroon', flag: '🇨🇲' },
  '236': { code: '236', name: 'Central African Rep.', flag: '🇨🇫' },
  '235': { code: '235', name: 'Chad', flag: '🇹🇩' },
  '241': { code: '241', name: 'Gabon', flag: '🇬🇦' },
  '240': { code: '240', name: 'Equatorial Guinea', flag: '🇬🇶' },
  '239': { code: '239', name: 'São Tomé & Príncipe', flag: '🇸🇹' },
  // West Africa
  '234': { code: '234', name: 'Nigeria', flag: '🇳🇬' },
  '233': { code: '233', name: 'Ghana', flag: '🇬🇭' },
  '225': { code: '225', name: "Côte d'Ivoire", flag: '🇨🇮' },
  '221': { code: '221', name: 'Senegal', flag: '🇸🇳' },
  '223': { code: '223', name: 'Mali', flag: '🇲🇱' },
  '226': { code: '226', name: 'Burkina Faso', flag: '🇧🇫' },
  '227': { code: '227', name: 'Niger', flag: '🇳🇪' },
  '224': { code: '224', name: 'Guinea', flag: '🇬🇳' },
  '245': { code: '245', name: 'Guinea-Bissau', flag: '🇬🇼' },
  '220': { code: '220', name: 'Gambia', flag: '🇬🇲' },
  '228': { code: '228', name: 'Togo', flag: '🇹🇬' },
  '229': { code: '229', name: 'Benin', flag: '🇧🇯' },
  '231': { code: '231', name: 'Liberia', flag: '🇱🇷' },
  '232': { code: '232', name: 'Sierra Leone', flag: '🇸🇱' },
  '238': { code: '238', name: 'Cape Verde', flag: '🇨🇻' },
  '222': { code: '222', name: 'Mauritania', flag: '🇲🇷' },
  // Southern Africa
  '27': { code: '27', name: 'South Africa', flag: '🇿🇦' },
  '260': { code: '260', name: 'Zambia', flag: '🇿🇲' },
  '263': { code: '263', name: 'Zimbabwe', flag: '🇿🇼' },
  '258': { code: '258', name: 'Mozambique', flag: '🇲🇿' },
  '265': { code: '265', name: 'Malawi', flag: '🇲🇼' },
  '267': { code: '267', name: 'Botswana', flag: '🇧🇼' },
  '264': { code: '264', name: 'Namibia', flag: '🇳🇦' },
  '266': { code: '266', name: 'Lesotho', flag: '🇱🇸' },
  '268': { code: '268', name: 'Eswatini', flag: '🇸🇿' },
  '244': { code: '244', name: 'Angola', flag: '🇦🇴' },
  '261': { code: '261', name: 'Madagascar', flag: '🇲🇬' },
  '230': { code: '230', name: 'Mauritius', flag: '🇲🇺' },
  '269': { code: '269', name: 'Comoros', flag: '🇰🇲' },
  '248': { code: '248', name: 'Seychelles', flag: '🇸🇨' },
  // North Africa
  '20': { code: '20', name: 'Egypt', flag: '🇪🇬' },
  '212': { code: '212', name: 'Morocco', flag: '🇲🇦' },
  '213': { code: '213', name: 'Algeria', flag: '🇩🇿' },
  '216': { code: '216', name: 'Tunisia', flag: '🇹🇳' },
  '218': { code: '218', name: 'Libya', flag: '🇱🇾' },
  '249': { code: '249', name: 'Sudan', flag: '🇸🇩' },
  // International
  '44': { code: '44', name: 'UK', flag: '🇬🇧' },
  '1': { code: '1', name: 'USA/Canada', flag: '🇺🇸' },
  '91': { code: '91', name: 'India', flag: '🇮🇳' },
};

export interface PhoneInfo {
  original: string;
  formatted: string;
  whatsappLink: string;
  countryCode: string;
  countryName: string;
  countryFlag: string;
  isUgandan: boolean;
}

/**
 * Parse and format a phone number for WhatsApp
 * Assumes Ugandan numbers if no country code is provided
 */
export function parsePhoneNumber(phone: string | null | undefined): PhoneInfo {
  // Guard against missing phone numbers (e.g. email-only imported accounts).
  const safePhone = typeof phone === 'string' ? phone : '';
  // Remove all non-digit characters except +
  let cleaned = safePhone.replace(/[^\d+]/g, '');
  
  // Remove leading + if present
  if (cleaned.startsWith('+')) {
    cleaned = cleaned.substring(1);
  }
  
  // Default to Uganda
  let countryCode = '256';
  let countryName = 'Uganda';
  let countryFlag = '🇺🇬';
  let isUgandan = true;
  let nationalNumber = cleaned;
  
  // Check if number starts with a known country code
  for (const [prefix, info] of Object.entries(COUNTRY_PREFIXES)) {
    if (cleaned.startsWith(prefix)) {
      countryCode = info.code;
      countryName = info.name;
      countryFlag = info.flag;
      isUgandan = prefix === '256';
      nationalNumber = cleaned.substring(prefix.length);
      break;
    }
  }
  
  // If number starts with 0, it's likely a local Ugandan number
  if (cleaned.startsWith('0')) {
    nationalNumber = cleaned.substring(1);
    countryCode = '256';
    countryName = 'Uganda';
    countryFlag = '🇺🇬';
    isUgandan = true;
  }
  
  // If number is 9-10 digits and doesn't start with a country code, assume Uganda
  if (cleaned.length >= 9 && cleaned.length <= 10 && !Object.keys(COUNTRY_PREFIXES).some(p => cleaned.startsWith(p))) {
    nationalNumber = cleaned.startsWith('0') ? cleaned.substring(1) : cleaned;
    countryCode = '256';
    countryName = 'Uganda';
    countryFlag = '🇺🇬';
    isUgandan = true;
  }
  
  // Build the full international number
  const fullNumber = countryCode + nationalNumber;
  
  // Format for display
  const formatted = `+${countryCode} ${nationalNumber}`;
  
  // WhatsApp link
  const whatsappLink = `https://wa.me/${fullNumber}`;
  
  return {
    original: safePhone,
    formatted,
    whatsappLink,
    countryCode,
    countryName,
    countryFlag,
    isUgandan
  };
}

/**
 * Get WhatsApp link for a phone number
 */
export function getWhatsAppLink(phone: string): string {
  return parsePhoneNumber(phone).whatsappLink;
}

/**
 * Normalize a phone number by removing all non-digit characters
 */
export function cleanPhoneNumber(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Strict canonical normalization — the single source of truth shared by the
 * client, the `self-update-phone` edge function, and the database trigger
 * `public.normalize_e164_phone`. Returns a valid E.164 string (e.g.
 * `+256771234567`) or `null` when the input cannot be coerced to a valid
 * number, so malformed entries (like the 11-digit local `07827277378`) are
 * rejected instead of being silently mangled into a broken `+256…` value.
 */
export function normalizeE164OrNull(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const hadPlus = s.startsWith('+');
  const d = s.replace(/\D/g, '');
  if (!d) return null;

  // Ugandan local form: leading 0, no country code (e.g. 0771234567)
  if (!hadPlus && d.startsWith('0')) {
    const national = d.slice(1).replace(/^0+/, '');
    return national.length === 9 ? `+256${national}` : null;
  }
  // Uganda country code, with or without + (e.g. 256771234567)
  if (d.startsWith('256')) {
    const national = d.slice(3).replace(/^0+/, '');
    return national.length === 9 ? `+256${national}` : null;
  }
  // Bare 9-digit Ugandan number without any prefix (e.g. 771234567)
  if (!hadPlus && d.length === 9) return `+256${d}`;
  // Explicit international number: + followed by 9-15 digits
  if (hadPlus && d.length >= 9 && d.length <= 15) return `+${d}`;
  return null;
}

/**
 * Generate all possible email variants for a phone number
 * This helps users who may have registered with different formats
 * Returns objects with email and display format
 */
export function generatePhoneEmailVariantsWithDisplay(phone: string): { email: string; display: string }[] {
  const cleaned = cleanPhoneNumber(phone);
  const variants: { email: string; display: string }[] = [];
  const seen = new Set<string>();
  
  const addVariant = (num: string, suffix: string) => {
    const email = `${num}@welile.${suffix}`;
    if (!seen.has(email)) {
      seen.add(email);
      // Format display nicely
      let display = num;
      if (num.startsWith('256') && num.length >= 12) {
        display = `+256 ${num.slice(3)}`;
      } else if (num.startsWith('0')) {
        display = num;
      } else if (num.length === 9) {
        display = `0${num}`;
      }
      variants.push({ email, display: `${display} (${suffix})` });
    }
  };
  
  // Original cleaned version
  addVariant(cleaned, 'user');
  
  // If starts with country code (256 for Uganda), also try without
  if (cleaned.startsWith('256') && cleaned.length > 9) {
    const withoutCountryCode = cleaned.slice(3);
    addVariant(withoutCountryCode, 'user');
    addVariant(`0${withoutCountryCode}`, 'user');
  }
  
  // If starts with 0, also try without the 0
  if (cleaned.startsWith('0') && cleaned.length >= 10) {
    const withoutLeadingZero = cleaned.slice(1);
    addVariant(withoutLeadingZero, 'user');
    addVariant(`256${withoutLeadingZero}`, 'user');
  }
  
  // If doesn't start with 0 or 256, try adding them
  if (!cleaned.startsWith('0') && !cleaned.startsWith('256') && cleaned.length >= 9) {
    addVariant(`0${cleaned}`, 'user');
    addVariant(`256${cleaned}`, 'user');
  }
  
  // Also check for agent emails
  addVariant(cleaned, 'agent');
  if (cleaned.startsWith('0')) {
    addVariant(cleaned.slice(1), 'agent');
    addVariant(`256${cleaned.slice(1)}`, 'agent');
  }
  
  return variants;
}

/**
 * Get display-friendly list of phone formats being tried
 */
export function getTriedPhoneFormats(phone: string): string[] {
  const variants = generatePhoneEmailVariantsWithDisplay(phone);
  // Return unique display formats (without the email suffix)
  const formats = new Set<string>();
  for (const v of variants) {
    const displayWithoutSuffix = v.display.replace(/ \(user\)| \(agent\)/g, '');
    formats.add(displayWithoutSuffix);
  }
  return [...formats];
}

/**
 * Generate all possible email variants for a phone number (string array version)
 */
export function generatePhoneEmailVariants(phone: string): string[] {
  return generatePhoneEmailVariantsWithDisplay(phone).map(v => v.email);
}

/**
 * Validate if phone number looks valid
 */
export function isValidPhoneNumber(phone: string): boolean {
  const cleaned = cleanPhoneNumber(phone);
  // Accept 9-12 digits (local or with country code)
  return cleaned.length >= 9 && cleaned.length <= 12;
}

/**
 * Validate any global phone number.
 * Accepts numbers with country codes, or bare local numbers (9+ digits).
 * Detects fake numbers like sequential/repeated digits.
 */
export function isValidPhoneNumberGlobal(phone: string): {
  valid: boolean;
  reason?: string;
} {
  const cleaned = cleanPhoneNumber(phone);

  // Must be 7+ digits (some countries have short numbers)
  if (cleaned.length < 7) {
    return { valid: false, reason: 'Phone number must have at least 7 digits' };
  }

  if (cleaned.length > 15) {
    return { valid: false, reason: 'Phone number is too long' };
  }

  // Reject all-same digits (e.g. 0000000000, 1111111111)
  const lastDigits = cleaned.slice(-7);
  if (/^(\d)\1{6,}$/.test(lastDigits)) {
    return { valid: false, reason: 'Phone number looks invalid (repeated digits)' };
  }

  // Reject sequential ascending/descending (1234567, 7654321)
  const isSequential = (s: string) => {
    let asc = true, desc = true;
    for (let i = 1; i < s.length; i++) {
      if (parseInt(s[i]) !== parseInt(s[i-1]) + 1) asc = false;
      if (parseInt(s[i]) !== parseInt(s[i-1]) - 1) desc = false;
    }
    return asc || desc;
  };
  if (isSequential(lastDigits)) {
    return { valid: false, reason: 'Phone number looks invalid (sequential digits)' };
  }

  return { valid: true };
}

/**
 * @deprecated Use isValidPhoneNumberGlobal instead. Kept for backward compatibility.
 */
export function isValidUgandanPhoneNumber(phone: string): {
  valid: boolean;
  reason?: string;
} {
  return isValidPhoneNumberGlobal(phone);
}

/**
 * Auto-format a phone number AS the user types.
 * Supports:
 *   • Local Ugandan: 07XX XXX XXX   (when the input starts with 0)
 *   • International: +256 XXX XXX XXX (when the input starts with +256 or 256)
 *   • Other E.164:   +CCX XXX XXX XXX (when the input starts with a different + country code)
 * Strips non-digits, caps the national part at 9 digits for Uganda, and inserts
 * spaces for readability. Returns empty string for empty input.
 */
export function formatUgandaPhone(raw: string): string {
  const trimmed = raw.trimStart();
  const allDigits = trimmed.replace(/\D/g, '');

  // Explicit international with a leading "+". Detect the actual country code
  // so we don't force non-Ugandan numbers (e.g. +257 79...) into a +256 mask.
  if (trimmed.startsWith('+')) {
    if (allDigits.length === 0) return '+';

    // Find the longest matching country prefix (longest first to avoid 1 matching before 257)
    let matchedPrefix = '';
    for (const prefix of Object.keys(COUNTRY_PREFIXES).sort((a, b) => b.length - a.length)) {
      if (allDigits.startsWith(prefix)) {
        matchedPrefix = prefix;
        break;
      }
    }

    if (matchedPrefix === '256') {
      const national = allDigits.slice(3).slice(0, 9);
      if (national.length === 0) return '+256';
      if (national.length <= 3) return `+256 ${national}`;
      if (national.length <= 6) return `+256 ${national.slice(0, 3)} ${national.slice(3)}`;
      return `+256 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
    }

    if (matchedPrefix) {
      // Generic international formatting: +CC <rest grouped in 3s>
      const rest = allDigits.slice(matchedPrefix.length);
      const chunks: string[] = [];
      for (let i = 0; i < rest.length; i += 3) {
        chunks.push(rest.slice(i, i + 3));
      }
      return chunks.length ? `+${matchedPrefix} ${chunks.join(' ')}` : `+${matchedPrefix}`;
    }

    // Unknown + prefix: just return the digits after +
    return `+${allDigits}`;
  }

  // International format without leading "+": user typed "256..."
  if (allDigits.startsWith('256')) {
    const national = allDigits.slice(3).slice(0, 9);
    if (national.length === 0) return '256';
    if (national.length <= 3) return `256 ${national}`;
    if (national.length <= 6) return `256 ${national.slice(0, 3)} ${national.slice(3)}`;
    return `256 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
  }

  // Local format: 07XX XXX XXX
  const digits = allDigits.slice(0, 10);
  if (digits.length === 0) return '';
  if (digits.length <= 4) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 4)} ${digits.slice(4)}`;
  return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
}

/**
 * Reduce any Ugandan phone input (local, +256, 256, or bare 9-digit) to its
 * canonical local digit string: 0XXXXXXXXX. Useful for validation + storage so
 * both "07…" and "+256…" inputs resolve to the same value. Incomplete input is
 * returned as plain digits so live validation can fail gracefully.
 */
export function toUgandaLocalDigits(phone: string): string {
  let d = phone.replace(/\D/g, '');
  if (d.startsWith('256') && d.length === 12) d = `0${d.slice(3)}`;
  else if (!d.startsWith('0') && d.length === 9) d = `0${d}`;
  return d;
}

/**
 * Normalize a Ugandan phone number to the +256 international format.
 * Converts 0-prefixed local numbers (e.g. 0771234567) to +256771234567.
 * Leaves already-formatted +256 numbers and non-Ugandan numbers untouched.
 */
export function normalizeUgandaPhone(phone: string): string {
  const trimmed = phone.trim();
  const cleaned = cleanPhoneNumber(trimmed);

  // Already in +256 format
  if (trimmed.startsWith('+256') && cleaned.length === 12) {
    return trimmed;
  }

  // 0-prefixed local number: 0771234567 → +256771234567
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return `+256${cleaned.slice(1)}`;
  }

  // Bare 9-digit number without prefix: 771234567 → +256771234567
  if (!cleaned.startsWith('0') && !cleaned.startsWith('256') && cleaned.length === 9) {
    return `+256${cleaned}`;
  }

  // 256-prefixed without +: 256771234567 → +256771234567
  if (cleaned.startsWith('256') && cleaned.length === 12 && !trimmed.startsWith('+')) {
    return `+${cleaned}`;
  }

  return trimmed;
}

/**
 * Normalize AND format for display: 0771234567 → "+256 771 234 567".
 * Returns the original string if it can't be parsed as a Ugandan number.
 */
export function displayNormalizeUgandaPhone(phone: string): string {
  const normalized = normalizeUgandaPhone(phone);
  if (!normalized.startsWith('+256')) return phone;
  const national = normalized.slice(4); // drop +256
  if (national.length !== 9) return normalized;
  return `+256 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
}
