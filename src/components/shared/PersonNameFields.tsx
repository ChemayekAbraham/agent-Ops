import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import FieldError from '@/components/shared/FieldError';
import type { PersonNameParts } from '@/lib/authValidation';

export interface PersonNameFieldsErrors {
  firstName?: string | null;
  otherNames?: string | null;
  lastName?: string | null;
}

export interface PersonNameFieldsProps {
  value: PersonNameParts;
  onChange: (next: PersonNameParts) => void;
  disabled?: boolean;
  required?: boolean;
  idPrefix: string;
  className?: string;
  errors?: PersonNameFieldsErrors;
}

/**
 * Presentational, fully controlled person-name capture.
 * Holds no state, does no submission, and touches no backend.
 */
export default function PersonNameFields({
  value,
  onChange,
  disabled = false,
  required = true,
  idPrefix,
  className,
  errors,
}: PersonNameFieldsProps) {
  const firstId = `${idPrefix}-first-name`;
  const lastId = `${idPrefix}-last-name`;
  const otherId = `${idPrefix}-other-names`;

  const set = (key: keyof PersonNameParts) => (next: string) =>
    onChange({ ...value, [key]: next });

  return (
    <div className={cn('space-y-3', className)}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={firstId}>
            First name{required ? ' *' : ''}
          </Label>
          <Input
            id={firstId}
            name="firstName"
            autoComplete="given-name"
            autoCapitalize="words"
            placeholder="e.g. Alice"
            value={value.firstName}
            onChange={(e) => set('firstName')(e.target.value)}
            disabled={disabled}
            required={required}
            aria-required={required || undefined}
            aria-invalid={errors?.firstName ? true : undefined}
          />
          <FieldError message={errors?.firstName} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={lastId}>
            Last name{required ? ' *' : ''}
          </Label>
          <Input
            id={lastId}
            name="lastName"
            autoComplete="family-name"
            autoCapitalize="words"
            placeholder="e.g. Nakato"
            value={value.lastName}
            onChange={(e) => set('lastName')(e.target.value)}
            disabled={disabled}
            required={required}
            aria-required={required || undefined}
            aria-invalid={errors?.lastName ? true : undefined}
          />
          <FieldError message={errors?.lastName} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={otherId}>Other names (optional)</Label>
        <Input
          id={otherId}
          name="otherNames"
          autoComplete="additional-name"
          autoCapitalize="words"
          placeholder="Middle or other names"
          value={value.otherNames}
          onChange={(e) => set('otherNames')(e.target.value)}
          disabled={disabled}
          aria-invalid={errors?.otherNames ? true : undefined}
        />
        <FieldError message={errors?.otherNames} />
      </div>
    </div>
  );
}