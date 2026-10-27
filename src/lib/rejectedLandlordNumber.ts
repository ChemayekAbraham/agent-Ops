/** Agent correction forms never submit a landlord-number change after rejection. */
export function withoutRejectedLandlordNumber<T extends Record<string, unknown>>(patch: T) {
  const { phone: _phone, landlord_phone: _landlordPhone, mobile_money_number: _mobile,
    verified_mobile_money_number: _approved, ...rest } = patch;
  return rest;
}