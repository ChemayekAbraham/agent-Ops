/**
 * FormContract System — Schema-Driven, Fintech-Grade Validation
 * 
 * Every form field is backed by a contract that mirrors the database schema.
 * Values ≠ Labels. No silent coercion. Hard failure with explicit errors.
 */

export type FieldType = 'integer' | 'uuid' | 'text' | 'boolean' | 'date' | 'numeric' | 'timestamp';

export interface FieldContract {
  type: FieldType;
  required: boolean;
  /** If true, field is computed from other fields and must never be user-editable */
  derived?: boolean;
  /** Allowed values for enum-like fields */
  allowedValues?: (number | string | boolean)[];
  /** Minimum value for numeric fields */
  min?: number;
  /** Maximum value for numeric fields */
  max?: number;
  /** Minimum length for text fields */
  minLength?: number;
  /** Maximum length for text fields */
  maxLength?: number;
  /** Regex pattern for text fields */
  pattern?: RegExp;
  /** Human-readable label for error messages */
  label?: string;
  /** Custom validator */
  validate?: (value: unknown, allFields: Record<string, unknown>) => string | null;
}

export type FormContract = Record<string, FieldContract>;

export interface ValidationError {
  field: string;
  message: string;
  expected?: string;
  received?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}
