/** Integer bounds for integer listing columns; never send fractional/invalid values. */
export function houseIntegerFilter(value: number | undefined, bound: 'min' | 'max'): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return bound === 'min' ? Math.ceil(value) : Math.floor(value);
}