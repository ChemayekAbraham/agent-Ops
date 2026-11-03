import { describe, it, expect } from 'vitest';
import { parseAssetQuantity, MAX_ASSET_QUANTITY } from '@/components/cfo/assets/AssetFormDialog';

describe('asset quantity', () => {
  it('accepts whole numbers 1..max', () => {
    expect(parseAssetQuantity('1')).toBe(1);
    expect(parseAssetQuantity(' 25 ')).toBe(25);
    expect(parseAssetQuantity(String(MAX_ASSET_QUANTITY))).toBe(MAX_ASSET_QUANTITY);
  });
  it('rejects zero, decimals, blanks and over max', () => {
    for (const v of ['0', '2.5', '', '-3', String(MAX_ASSET_QUANTITY + 1)]) expect(parseAssetQuantity(v)).toBeNull();
  });
});
