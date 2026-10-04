/** String.prototype.matchAll (ES2020). */
/* eslint-disable no-extend-native, @typescript-eslint/no-explicit-any */
if (typeof (String.prototype as any).matchAll !== 'function') {
  (String.prototype as any).matchAll = function (regexp: any) {
    const str = String(this);
    const flags = regexp && regexp.flags != null ? regexp.flags : 'g';
    const re = new RegExp(regexp.source, flags.indexOf('g') >= 0 ? flags : flags + 'g');
    const matches: any[] = [];
    let m: any;
    while ((m = re.exec(str)) !== null) {
      matches.push(m);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return matches[Symbol.iterator]();
  };
}
export {};
