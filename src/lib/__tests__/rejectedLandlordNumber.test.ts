import { describe, expect, it } from 'vitest';
import { withoutRejectedLandlordNumber } from '../rejectedLandlordNumber';

describe('agent corrections after landlord rejection', () => {
  it('cannot submit a changed landlord phone or payout number', () => {
    const patch = withoutRejectedLandlordNumber({
      phone: '0793805335', landlord_phone: '0793805335',
      mobile_money_number: '0793805335', verified_mobile_money_number: '0793805335',
      name: 'Mukama Michael', tenant_phone: '0772000001',
    });
    expect(patch).toEqual({ name: 'Mukama Michael', tenant_phone: '0772000001' });
  });
});