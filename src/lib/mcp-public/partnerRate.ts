import { limiterClient } from "./rateLimit";
import { parsePublicPolicy } from "../partnerReturnPolicy";

// What a NEW Supporter earns per month right now: the public partner Returns policy
// (get_partner_return_policy, readable before login). One request per tool call.
// Any failure gives null, and the tool then states no figure: never a fallback rate.
export async function newPartnerReturnRate(): Promise<number | null> {
  try {
    const client = limiterClient();
    if (!client) return null;
    const { data, error } = await client.rpc("get_partner_return_policy" as never);
    if (error) return null;
    return parsePublicPolicy(data)?.newContractRate ?? null;
  } catch {
    return null;
  }
}
