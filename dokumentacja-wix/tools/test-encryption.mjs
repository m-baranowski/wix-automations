// Opcjonalny test prawdziwej biblioteki, bez konta Google.
// Zależności testowe: npm install --prefix .test-runtime --no-save zgapdfsigner@2.8.0
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../.test-runtime/runtime.cjs', import.meta.url));
const Zga = require('zgapdfsigner');
const { PDFDocument } = require('pdf-lib');
const doc = await PDFDocument.create();
doc.addPage([200, 200]);
const raw = await doc.save();
const context = vm.createContext({
  pdfkit: { loadZga: target => { target.Zga = Zga; } },
  Utilities: {
    getUuid: randomUUID,
    base64Encode: bytes => Buffer.from(bytes.map(value => value & 255)).toString('base64'),
    newBlob: bytes => Buffer.from(bytes.map(value => value & 255))
  },
  SETTINGS: { maxPdfBytes: 9 * 1024 * 1024 },
  fail_: code => { throw Error(code); }
});
vm.runInContext(readFileSync(new URL('../google/owner/Code.gs', import.meta.url), 'utf8'), context);
const encrypted = await context.encrypt_({ getBytes: () => [...raw] }, '23012020');
writeFileSync(new URL('../.test-runtime/encrypted.pdf', import.meta.url), encrypted);
console.log('Encrypted PDF generated with the Apps Script adapter and zgapdfsigner.');
