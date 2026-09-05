/**
 * Phonebook (Contact Picker API) helper.
 * Available on Chrome/Edge for Android over HTTPS. Falls back gracefully.
 * https://developer.mozilla.org/en-US/docs/Web/API/Contact_Picker_API
 */

type ContactsManager = {
  select: (
    properties: string[],
    options?: { multiple?: boolean }
  ) => Promise<Array<{ name?: string[]; tel?: string[]; email?: string[] }>>;
  getProperties?: () => Promise<string[]>;
};

export function isContactPickerSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  const contacts = (navigator as unknown as { contacts?: ContactsManager }).contacts;
  return !!contacts && typeof contacts.select === 'function';
}

export interface PickedContact {
  name: string;
  phone: string;
  email?: string;
}


/**
 * Normalise a phone number to Ugandan 10-digit format starting with 0
 * (e.g. "+256 783 123 456" -> "0783123456"). Returns trimmed digits if no match.
 */
export function normaliseUgPhone(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.startsWith('256') && digits.length >= 12) return '0' + digits.slice(3);
  if (digits.startsWith('0') && digits.length === 10) return digits;
  if (digits.length === 9) return '0' + digits;
  return digits;
}

/**
 * Open the OS contact picker and return the first chosen name, phone and email.
 * On Android Chrome the picker surfaces the phone's contacts, which include
 * Google-account contacts (so a Gmail address can be picked straight from it).
 * Throws if unsupported.
 */
export async function pickContact(): Promise<PickedContact | null> {
  const contacts = (navigator as unknown as { contacts?: ContactsManager }).contacts;
  if (!contacts) throw new Error('Contact picker not supported on this device');
  let props = ['name', 'tel', 'email'];
  try {
    const supported = (await contacts.getProperties?.()) || props;
    props = props.filter((p) => supported.includes(p));
    if (props.length === 0) props = ['name', 'tel'];
  } catch {
    /* fall back to the default property list */
  }
  const result = await contacts.select(props, { multiple: false });
  if (!result || result.length === 0) return null;
  const c = result[0];
  const name = (c.name && c.name[0]) || '';
  const tel = (c.tel && c.tel[0]) || '';
  const email = (c.email && c.email[0]) || '';
  return { name: name.trim(), phone: normaliseUgPhone(tel), email: email.trim() || undefined };
}
