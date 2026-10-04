import { auth, defineMcp } from "@lovable.dev/mcp-js";
import getMyProfile from "./tools/get-my-profile";
import getMyWallet from "./tools/get-my-wallet";
import listMyTransactions from "./tools/list-my-transactions";
import getMyWalletStatement from "./tools/get-my-wallet-statement";
import exportMyWalletStatement from "./tools/export-my-wallet-statement";

// The OAuth issuer MUST be the direct Supabase host, built from the project
// ref (never SUPABASE_URL, which is the .lovable.cloud proxy on Cloud apps).
// VITE_SUPABASE_PROJECT_ID is inlined as a literal at build time, keeping this
// entry import-safe. The fallback keeps the issuer well-formed during the
// throwaway manifest-extract eval.
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "welile-mcp",
  title: "Welile Receipts MCP",
  version: "0.1.0",
  instructions:
    "Tools for a signed-in Welile Receipts user. Use `get_my_profile` for account details, `get_my_wallet` for the UGX wallet balance, and `list_my_transactions` for recent wallet activity. Use `get_my_wallet_statement` for a full statement over an optional YYYY-MM-DD date range (entries plus money-in / money-out totals, net movement and current withdrawable balance), and `export_my_wallet_statement` to generate that statement as a PDF, Excel (.xlsx) or CSV file and return a private download link valid for 7 days. All amounts are in UGX and scoped to the authenticated user.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [getMyProfile, getMyWallet, listMyTransactions, getMyWalletStatement, exportMyWalletStatement],
});