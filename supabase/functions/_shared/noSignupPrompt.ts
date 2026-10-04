// Side-effect import: opts this edge function out of the platform-wide SMS
// sign-up prompt. Used by authentication / OTP senders.
import { suppressSignupPrompt } from "./smsSignupPrompt.ts";

suppressSignupPrompt();
