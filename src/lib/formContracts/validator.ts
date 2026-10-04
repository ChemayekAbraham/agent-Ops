/**
 * Global Pre-Submit Validator — Fintech Grade
 * 
 * ❌ No silent fixes
 * ❌ No coercion
 * ✅ Hard failure with explicit error
 */

import { FormContract, FieldContract, ValidationResult, ValidationError } from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateField(
  fieldName: string,
  contract: FieldContract,
  value: unknown,
  allFields: Record<string, unknown>
): ValidationError | null {
  const label = contract.label || fieldName;

  // Required check
  if (contract.required && (value === undefined || value === null || value === '')) {
    return { field: fieldName, message: `${label} is required`, expected: contract.type, received: 'empty' };
  }

  // Allow null/undefined for optional fields
  if (value === undefined || value === null || value === '') {
    return null;
  }

  // Type validation — NO COERCION
  switch (contract.type) {
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return {
          field: fieldName,
          message: `${label} must be a whole number`,
          expected: 'integer',
          received: `${typeof value}: ${String(value)}`,
        };
      }
      break;
    }
    case 'numeric': {
      if (typeof value !== 'number' || isNaN(value)) {
        return {
          field: fieldName,
          message: `${label} must be a number`,
          expected: 'numeric',
          received: `${typeof value}: ${String(value)}`,
        };
      }
      break;
    }
    case 'text': {
      if (typeof value !== 'string') {
        return {
          field: fieldName,
          message: `${label} must be text`,
          expected: 'text',
          received: typeof value,
        };
      }
      break;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        return {
          field: fieldName,
          message: `${label} must be true or false`,
          expected: 'boolean',
          received: `${typeof value}: ${String(value)}`,
        };
      }
      break;
    }
    case 'uuid': {
      if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
        return {
          field: fieldName,
          message: `${label} must be a valid UUID`,
          expected: 'uuid',
          received: String(value),
        };
      }
      break;
    }
    case 'date':
    case 'timestamp': {
      if (typeof value === 'string') {
        if (isNaN(Date.parse(value))) {
          return {
            field: fieldName,
            message: `${label} must be a valid date`,
            expected: contract.type,
            received: String(value),
          };
        }
      } else if (!(value instanceof Date) || isNaN(value.getTime())) {
        return {
          field: fieldName,
          message: `${label} must be a valid date`,
          expected: contract.type,
          received: typeof value,
        };
      }
      break;
    }
  }

  // Allowed values check
  if (contract.allowedValues && !contract.allowedValues.includes(value as number | string | boolean)) {
    return {
      field: fieldName,
      message: `${label} must be one of: ${contract.allowedValues.join(', ')}`,
      expected: `one of [${contract.allowedValues.join(', ')}]`,
      received: String(value),
    };
  }

  // Numeric range checks
  if ((contract.type === 'integer' || contract.type === 'numeric') && typeof value === 'number') {
    if (contract.min !== undefined && value < contract.min) {
      return {
        field: fieldName,
        message: `${label} must be at least ${contract.min}`,
        expected: `>= ${contract.min}`,
        received: String(value),
      };
    }
    if (contract.max !== undefined && value > contract.max) {
      return {
        field: fieldName,
        message: `${label} must be at most ${contract.max}`,
        expected: `<= ${contract.max}`,
        received: String(value),
      };
    }
  }

  // Text length checks
  if (contract.type === 'text' && typeof value === 'string') {
    if (contract.minLength !== undefined && value.length < contract.minLength) {
      return {
        field: fieldName,
        message: `${label} must be at least ${contract.minLength} characters`,
        expected: `>= ${contract.minLength} chars`,
        received: `${value.length} chars`,
      };
    }
    if (contract.maxLength !== undefined && value.length > contract.maxLength) {
      return {
        field: fieldName,
        message: `${label} must be at most ${contract.maxLength} characters`,
        expected: `<= ${contract.maxLength} chars`,
        received: `${value.length} chars`,
      };
    }
    if (contract.pattern && !contract.pattern.test(value)) {
      return {
        field: fieldName,
        message: `${label} format is invalid`,
        expected: `pattern: ${contract.pattern}`,
        received: value,
      };
    }
  }

  // Custom validator
  if (contract.validate) {
    const customError = contract.validate(value, allFields);
    if (customError) {
      return { field: fieldName, message: customError };
    }
  }

  return null;
}

/**
 * Validates a payload against a FormContract.
 * Returns { valid: true } or { valid: false, errors: [...] }
 * 
 * ❌ Never coerces types
 * ❌ Never silently fixes values
 * ✅ Hard failure with explicit field-level errors
 */
export function validateFormPayload(
  contract: FormContract,
  payload: Record<string, unknown>
): ValidationResult {
  const errors: ValidationError[] = [];

  // Check for string-encoded numbers (forbidden)
  for (const [key, value] of Object.entries(payload)) {
    const fieldContract = contract[key];
    if (!fieldContract) continue;

    if (
      (fieldContract.type === 'integer' || fieldContract.type === 'numeric') &&
      typeof value === 'string'
    ) {
      // Detect formatted values like "UGX 100,000" or "100,000"
      if (/[,\s]/.test(value) || /^[A-Z]{2,}/.test(value)) {
        errors.push({
          field: key,
          message: `${fieldContract.label || key} contains a formatted string. Raw numbers only.`,
          expected: fieldContract.type,
          received: `formatted string: "${value}"`,
        });
        continue;
      }
    }
  }

  // Validate each field in contract
  for (const [fieldName, fieldContract] of Object.entries(contract)) {
    // Skip derived fields in incoming payload validation — they should be computed
    if (fieldContract.derived) continue;

    const value = payload[fieldName];
    const error = validateField(fieldName, fieldContract, value, payload);
    if (error) errors.push(error);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates and throws if invalid. Use as a pre-submit guard.
 */
export function assertValid(contract: FormContract, payload: Record<string, unknown>): void {
  const result = validateFormPayload(contract, payload);
  if (!result.valid) {
    const messages = result.errors.map(e => e.message).join('; ');
    throw new Error(`Validation failed: ${messages}`);
  }
}
