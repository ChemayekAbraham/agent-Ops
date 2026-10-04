/**
 * WELILE Employee ID Generator
 * Format: Wel-{Initials}{RandomNumber}
 * Example: Wel-SP12043
 */

export function generateEmployeeId(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const initials = parts.map(p => p[0].toUpperCase()).join('').slice(0, 2);
  const rand = Math.floor(10000 + Math.random() * 90000); // 5-digit
  return `Wel-${initials}${rand}`;
}

export function isValidEmployeeId(id: string): boolean {
  return /^Wel-[A-Z]{1,4}\d{4,6}$/i.test(id.trim());
}
