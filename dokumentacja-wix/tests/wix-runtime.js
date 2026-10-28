// Testujemy dokładnie ten plik, który użytkownik wkleja do automatyzacji.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
const code = readFileSync(new URL('../wix/DO-WKLEJENIA.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const context = vm.createContext({
  auth: { elevate: method => method },
  extendedBookings: {}, secrets: {}, submissions: {}, createHmac
});
vm.runInContext(code, context);
export const { dateParts, prepareRequest, CONFIG } = vm.runInContext(
  '({ dateParts, prepareRequest, CONFIG })', context
);
