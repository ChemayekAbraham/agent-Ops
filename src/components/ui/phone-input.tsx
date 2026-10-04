import { forwardRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { BookUser } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

/**
 * Web Contacts API typing (Chrome Android / some PWAs).
 * Falls back gracefully when unavailable (desktop, iOS Safari).
 */
interface ContactsManager {
  select: (
    properties: Array<'name' | 'tel' | 'email'>,
    options?: { multiple?: boolean }
  ) => Promise<Array<{ name?: string[]; tel?: string[]; email?: string[] }>>;
  getProperties: () => Promise<string[]>;
}

declare global {
  interface Navigator {
    contacts?: ContactsManager;
  }
}

export interface PhoneInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: string;
  onChange: (value: string) => void;
  /** Optional callback when a contact is picked, gives access to the name too */
  onContactPicked?: (data: { phone: string; name?: string }) => void;
  /** Hide the picker button (e.g. when API obviously won't work) */
  hidePicker?: boolean;
  containerClassName?: string;
}

const normalizePhone = (raw: string) => {
  // Strip everything except digits and a leading +
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return hasPlus ? `+${digits}` : digits;
};

export const PhoneInput = forwardRef<HTMLInputElement, PhoneInputProps>(
  ({ value, onChange, onContactPicked, hidePicker, className, containerClassName, ...rest }, ref) => {
    const [picking, setPicking] = useState(false);

    const supported =
      typeof window !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      !!navigator.contacts &&
      typeof navigator.contacts.select === 'function' &&
      window.isSecureContext;

    const pickContact = async () => {
      if (!supported) {
        toast.info('Phone book not available here', {
          description: 'Open Welile on Chrome on Android to pick contacts directly.',
        });
        return;
      }
      try {
        setPicking(true);
        const results = await navigator.contacts!.select(['name', 'tel'], { multiple: false });
        if (!results || results.length === 0) return;
        const contact = results[0];
        const rawPhone = contact.tel?.[0] ?? '';
        const name = contact.name?.[0];
        const phone = normalizePhone(rawPhone);
        if (!phone) {
          toast.error('That contact has no phone number');
          return;
        }
        onChange(phone);
        onContactPicked?.({ phone, name });
      } catch (err: any) {
        // User-cancel produces an error in some browsers — quietly ignore.
        if (err?.name !== 'AbortError') {
          console.warn('[phone-input] contact picker error', err);
        }
      } finally {
        setPicking(false);
      }
    };

    return (
      <div className={cn('relative flex items-stretch gap-1', containerClassName)}>
        <Input
          ref={ref}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn('flex-1', className)}
          {...rest}
        />
        {!hidePicker && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={pickContact}
            disabled={picking}
            title={supported ? 'Pick from phone book' : 'Phone book not available on this device'}
            className="shrink-0"
          >
            <BookUser className={cn('h-4 w-4', supported ? 'text-primary' : 'text-muted-foreground')} />
          </Button>
        )}
      </div>
    );
  }
);

PhoneInput.displayName = 'PhoneInput';
