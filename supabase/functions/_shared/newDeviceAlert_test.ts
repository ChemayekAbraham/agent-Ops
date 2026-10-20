import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyDevice } from "./deviceClass.ts";
import { deviceIconKey, sessionIdFromJwt } from "./newDeviceAlert.ts";

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 13; TECNO KI7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
};

Deno.test("each device family gets its own icon", () => {
  assertEquals(deviceIconKey(classifyDevice(UA.iphone).os), "iphone");
  assertEquals(deviceIconKey(classifyDevice(UA.android).os), "android");
  assertEquals(deviceIconKey(classifyDevice(UA.windows).os), "windows");
  assertEquals(deviceIconKey(classifyDevice(UA.mac).os), "mac");
  assertEquals(deviceIconKey(classifyDevice(UA.linux).os), "linux");
  assertEquals(deviceIconKey(classifyDevice("").os), "unknown");
  assertEquals(deviceIconKey("iPadOS"), "iphone");
});

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

Deno.test("reads the auth session id from an access token", () => {
  const sid = "7f3c2a1e-4b5d-4c6e-8f90-1a2b3c4d5e6f";
  assertEquals(sessionIdFromJwt(`${b64url({ alg: "HS256" })}.${b64url({ session_id: sid })}.sig`), sid);
  assertEquals(sessionIdFromJwt(`${b64url({})}.${b64url({ session_id: "nope" })}.sig`), null);
  assertEquals(sessionIdFromJwt("not-a-jwt"), null);
});
