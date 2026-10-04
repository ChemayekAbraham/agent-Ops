/** String.prototype.replaceAll (ES2021) — used by input-otp (OTP/PIN inputs). */
/* eslint-disable no-extend-native, @typescript-eslint/no-explicit-any */
if (typeof (String.prototype as any).replaceAll !== 'function') {
  (String.prototype as any).replaceAll = function (search: any, replacement: any) {
    if (Object.prototype.toString.call(search) === '[object RegExp]') {
      if (!search.global) {
        throw new TypeError('replaceAll must be called with a global RegExp');
      }
      return this.replace(search, replacement);
    }
    if (typeof replacement === 'function') {
      return this.split(String(search)).reduce((acc: string, part: string, i: number) =>
        i === 0 ? part : acc + String(replacement(String(search))) + part, '');
    }
    return this.split(String(search)).join(String(replacement));
  };
}
export {};
