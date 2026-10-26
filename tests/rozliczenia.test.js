// Testy jednostkowe czystej logiki rozliczeń.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  grosze,
  normalizujZamowienie,
  zbudujPlan,
  operationId,
  polaFaktury,
  sprawdzFakture,
  wyciagnijKontakt
} from '../faktury/rozliczenia.js';
import { cfgTest, zamowienie } from './atrapy.js';

const cfg = cfgTest();

test('grosze: kwoty Wix bez błędów zmiennoprzecinkowych', () => {
  assert.equal(grosze('160.00'), 16000);
  assert.equal(grosze({ amount: '53.33' }), 5333);
  assert.equal(grosze(0.1 + 0.2), 30);
  assert.equal(grosze(undefined), 0);
  assert.throws(() => grosze('1.005'), /2 miejscami/);
  assert.throws(() => grosze('abc'), /Nieprawidłowa/);
});

test('normalizacja: rabat merchantDiscount i uzgodnienie sum', () => {
  const o = normalizujZamowienie(
    zamowienie({ id: 'o1', numer: 1, contactId: 'c', umowaId: 'u', rabaty: [{ id: 'd1', kwota: 160 }] })
  );
  assert.equal(o.brutto, 64000);
  assert.equal(o.rabat, 16000);
  assert.equal(o.razem, 48000);
  assert.deepEqual(o.rabaty.map(r => [r.discountId, r.kwota]), [['d1', 16000]]);
  assert.deepEqual(o.problemy, []);
});

test('normalizacja: niezgodny rabat zgłaszany jako problem', () => {
  const raw = zamowienie({ id: 'o1', numer: 1, contactId: 'c', umowaId: 'u', rabaty: [{ kwota: 160 }] });
  raw.priceSummary.discount = { amount: '100.00' };
  raw.priceSummary.total = { amount: '540.00' };
  const o = normalizujZamowienie(raw);
  assert.ok(o.problemy.some(p => /Suma rabatów/.test(p)));
});

test('normalizacja: podatek lub opłaty blokują automat', () => {
  const raw = zamowienie({ id: 'o1', numer: 1, contactId: 'c', umowaId: 'u' });
  raw.priceSummary.tax = { amount: '10.00' };
  assert.ok(normalizujZamowienie(raw).problemy.length > 0);
});

test('plan: nie łączy zamówień różnych kontaktów', () => {
  const a = normalizujZamowienie(zamowienie({ id: 'a', numer: 1, contactId: 'c1', umowaId: 'u1' }));
  const b = normalizujZamowienie(zamowienie({ id: 'b', numer: 2, contactId: 'c2', umowaId: 'u2' }));
  assert.throws(() => zbudujPlan('c1', [a, b], cfg), /innego kontaktu/);
});

test('plan: identyfikator operacji deterministyczny i niezależny od kolejności', () => {
  assert.equal(operationId('2026-11', 'c', ['b', 'a']), operationId('2026-11', 'c', ['a', 'b']));
  assert.notEqual(operationId('2026-11', 'c', ['a']), operationId('2026-11', 'c', ['a', 'b']));
  assert.notEqual(operationId('2026-11', 'c', ['a']), operationId('2026-12', 'c', ['a']));
});

test('plan: przykład z zadania — 4×160 + 4×180 = 1360 zł, dwie pozycje', () => {
  const a = normalizujZamowienie(zamowienie({ id: 'a', numer: 1, contactId: 'c', umowaId: 'u1', cena: 160 }));
  const b = normalizujZamowienie(zamowienie({ id: 'b', numer: 2, contactId: 'c', umowaId: 'u2', cena: 180, usluga: 'Terapia neurologopedyczna' }));
  const p = zbudujPlan('c', [b, a], cfg);
  assert.equal(p.razem, 136000);
  assert.deepEqual(p.pozycje.map(x => [x.nazwa, x.ilosc, x.cena]), [
    ['Terapia logopedyczna', 4, 16000],
    ['Terapia neurologopedyczna', 4, 18000]
  ]);
  assert.deepEqual(p.orderIds, ['a', 'b']);
});

test('pola faktury: kształt wix-billing-backend, PLN, tytuł, termin 5 dni', () => {
  const a = normalizujZamowienie(zamowienie({ id: 'a', numer: 7, contactId: 'c', umowaId: 'u1', rabaty: [{ kwota: 53.33 }] }));
  const plan = zbudujPlan('c', [a], cfg);
  const teraz = new Date('2026-12-01T09:00:00Z');
  const pola = polaFaktury(plan, { contactId: 'c', email: 'x@y.pl', firstName: 'A', lastName: 'B', fullName: 'A B', phone: '48600' }, cfg, teraz);

  assert.equal(pola.title, 'Listopad 2026');
  assert.equal(pola.currency, 'PLN');
  assert.equal(pola.customer.phone, '48600');
  assert.deepEqual(pola.lineItems.map(l => l.price), [160, -53.33]);
  assert.equal(pola.dates.dueDate.toISOString(), '2026-12-06T09:00:00.000Z');
  assert.equal(pola.metadata.sourceRefId, plan.operationId);
  assert.throws(() => polaFaktury(plan, { contactId: 'inny', email: 'x' }, cfg, teraz), /inny|≠/);
  assert.throws(() => polaFaktury(plan, { contactId: 'c', email: '' }, cfg, teraz), /e-mail/);
});

test('kontrola faktury przed wysyłką wykrywa rozbieżność kwot i kontaktu', () => {
  const op = { _id: 'op', invoiceId: 'i', klientContactId: 'c', kwotaGrosze: 64000, pozycje: [{}] };
  const ok = { id: { id: 'i', version: 3 }, customer: { contactId: 'c' }, totals: { total: 640 }, lineItems: [{}], metadata: { sourceRefId: 'op' } };
  assert.deepEqual(sprawdzFakture(ok, op), []);
  assert.equal(sprawdzFakture({ ...ok, totals: { total: 480 } }, op).length, 1);
  assert.equal(sprawdzFakture({ ...ok, customer: { contactId: 'x' } }, op).length, 1);
  assert.equal(sprawdzFakture({ ...ok, metadata: { sourceRefId: 'inna' } }, op).length, 1);
});

test('kontakt: e-mail, telefon, fullName z różnych kształtów odpowiedzi', () => {
  const k = wyciagnijKontakt({
    _id: 'c',
    info: { name: { first: 'Anna', last: 'Nowak' }, emails: { items: [{ email: 'a@x.pl' }] }, phones: { items: [{ phone: '48600' }] } }
  });
  assert.deepEqual(k, { contactId: 'c', firstName: 'Anna', lastName: 'Nowak', fullName: 'Anna Nowak', email: 'a@x.pl', phone: '48600' });
});
