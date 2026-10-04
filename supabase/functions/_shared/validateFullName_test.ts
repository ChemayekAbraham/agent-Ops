import {
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  FULL_NAME_ERROR,
  FULL_NAME_TOO_LONG_ERROR,
  MAX_FULL_NAME_LENGTH,
  mapProfileFullNameDbError,
  validateFullName,
} from "./validateFullName.ts";

Deno.test("validateFullName rejects non-string inputs", () => {
  for (const raw of [null, undefined, 42, {}, [], true]) {
    const result = validateFullName(raw as unknown);
    assertEquals(result.valid, false, `expected invalid for ${String(raw)}`);
    assertEquals(result.error, FULL_NAME_ERROR);
    assertEquals(result.trimmed, "");
  }
});

Deno.test("validateFullName rejects empty / whitespace-only strings", () => {
  for (const raw of ["", " ", "   ", "\t", "\n", " \t\n "]) {
    const result = validateFullName(raw);
    assertEquals(result.valid, false, `expected invalid for "${raw}"`);
    assertEquals(result.error, FULL_NAME_ERROR);
  }
});

Deno.test("validateFullName rejects names shorter than 2 visible chars", () => {
  const result = validateFullName(" a ");
  assertEquals(result.valid, false);
  assertEquals(result.error, FULL_NAME_ERROR);
  assertEquals(result.trimmed, "a");
});

Deno.test("validateFullName accepts and trims valid names", () => {
  const result = validateFullName("  John  Doe  ");
  assertEquals(result.valid, true);
  assertEquals(result.trimmed, "John Doe");
  assertStrictEquals(result.error, null);
});

Deno.test("validateFullName collapses internal whitespace", () => {
  const result = validateFullName("Mary\t\tJane   Watson");
  assertEquals(result.valid, true);
  assertEquals(result.trimmed, "Mary Jane Watson");
});

Deno.test("validateFullName accepts exactly 2-character names", () => {
  const result = validateFullName("Al");
  assertEquals(result.valid, true);
  assertEquals(result.trimmed, "Al");
});

Deno.test("validateFullName rejects names exceeding max length", () => {
  const tooLong = "A".repeat(MAX_FULL_NAME_LENGTH + 1);
  const result = validateFullName(tooLong);
  assertEquals(result.valid, false);
  assertEquals(result.error, FULL_NAME_TOO_LONG_ERROR);
});

Deno.test("validateFullName accepts names at the max length boundary", () => {
  const result = validateFullName("A".repeat(MAX_FULL_NAME_LENGTH));
  assertEquals(result.valid, true);
});

Deno.test("mapProfileFullNameDbError maps trigger error to friendly message", () => {
  const mapped = mapProfileFullNameDbError({
    code: "23514",
    message: "Full name is required (minimum 2 characters)",
  });
  assertEquals(mapped, FULL_NAME_ERROR);
});

Deno.test("mapProfileFullNameDbError preserves unrelated DB errors", () => {
  const mapped = mapProfileFullNameDbError({
    code: "23505",
    message: "duplicate key value violates unique constraint",
  });
  assertEquals(mapped, "duplicate key value violates unique constraint");
});

Deno.test("mapProfileFullNameDbError returns null for null input", () => {
  assertStrictEquals(mapProfileFullNameDbError(null), null);
  assertStrictEquals(mapProfileFullNameDbError(undefined), null);
});