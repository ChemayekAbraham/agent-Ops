export interface PrincipalComponents {
  total_repayment: number | string;
  principal: number | string;
  returns: number | string;
  agent_commission: number | string;
  platform_fee: number | string;
  access_fee: number | string;
  registration_fee: number | string;
}

/** Gross collected fees and their allocation are two views, not additive pools. */
export function summarizePrincipalComponents(rows: PrincipalComponents[]) {
  return rows.reduce((sum, row) => ({
    principal: sum.principal + Number(row.principal),
    platformMoney: sum.platformMoney + Number(row.total_repayment) - Number(row.principal),
    returns: sum.returns + Number(row.returns),
    commission: sum.commission + Number(row.agent_commission),
    platformFee: sum.platformFee + Number(row.platform_fee),
    accessFee: sum.accessFee + Number(row.access_fee),
    registrationFee: sum.registrationFee + Number(row.registration_fee),
  }), { principal: 0, platformMoney: 0, returns: 0, commission: 0, platformFee: 0, accessFee: 0, registrationFee: 0 });
}