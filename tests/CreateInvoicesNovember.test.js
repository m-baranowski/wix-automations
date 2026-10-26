// Testy CreateInvoicesNovember.js — wyłącznie atrapy API Wix.
// Żadne wywołanie nie wychodzi poza proces; nie powstają prawdziwe faktury.
// Uruchomienie: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { _test } from '../CreateInvoicesNovember.js';

const {
  KONFIGURACJA_LISTOPAD_2026,
  K,
  S,
  LOCK_ID,
  GENERATOR_LOCK_ID,
  grosze,
  normalizujZamowienie,
  zbudujPlan,
  operationId,
  polaFaktury,
  sprawdzFakture,
  wyciagnijKontakt,
  createJournal,
  createProcess
} = _test;

// ======================================================
// ATRAPY
// ======================================================


const MIESIAC = '2026-11';
const APP = KONFIGURACJA_LISTOPAD_2026.appIdRezerwacji;

const money = c => ({ amount: (c / 100).toFixed(2) });
const kopia = x => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

const cfgTest = (zmiany = {}) => ({
  ...KONFIGURACJA_LISTOPAD_2026,
  minZapasMs: 0,
  ...zmiany
});

// ------------------------------------------------------
// Dane źródłowe
// ------------------------------------------------------

/**
 * Zamówienie w kształcie SDK @wix/ecom (jak z generatorUmow.js),
 * z opcjonalnymi rabatami merchantDiscount (rabat za październik).
 */
function zamowienie({
  id,
  numer,
  contactId,
  umowaId,
  usluga = 'Terapia logopedyczna',
  cena = 160,
  wizyty = 4,
  rabaty = [],
  status = 'APPROVED',
  paymentStatus = 'NOT_PAID',
  zaplacono = 0,
  externalOrderId
}) {
  const c = Math.round(cena * 100);
  const daty = ['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24', '2026-11-26'];

  const lineItems = Array.from({ length: wizyty }, (_, i) => ({
    _id: `bk-${id}-${i}`,
    productName: { original: usluga },
    quantity: 1,
    catalogReference: { appId: APP, catalogItemId: `bk-${id}-${i}` },
    price: money(c),
    totalDiscount: money(0),
    totalPriceAfterTax: money(c),
    descriptionLines: [{
      name: { original: 'Termin pierwotny / miesiąc rozliczenia' },
      plainText: { original: `${daty[i % daty.length]} 16:00 / ${MIESIAC}` }
    }]
  }));

  const subtotal = c * wizyty;
  const rab = rabaty.map((r, i) => ({
    _id: r.id || `rabat-${id}-${i}`,
    discountType: 'GLOBAL',
    merchantDiscount: {
      amount: money(Math.round(r.kwota * 100)),
      description: r.opis || 'Odwołana wizyta — październik 2026'
    }
  }));
  const discount = rabaty.reduce((s, r) => s + Math.round(r.kwota * 100), 0);
  const total = subtotal - discount;
  const paid = Math.round(zaplacono * 100);

  return {
    _id: id,
    number: String(numer),
    status,
    paymentStatus,
    currency: 'PLN',
    buyerInfo: { contactId },
    channelInfo: {
      type: 'BACKOFFICE_MERCHANT',
      externalOrderId: externalOrderId || `TOTO:${MIESIAC}:${umowaId}`
    },
    lineItems,
    appliedDiscounts: rab,
    priceSummary: {
      subtotal: money(subtotal),
      discount: money(discount),
      tax: money(0),
      shipping: money(0),
      total: money(total)
    },
    balanceSummary: {
      paid: money(paid),
      balance: money(total - paid),
      refunded: money(0)
    }
  };
}

function wierszCyklu(order, { umowaId, stawka, status = 'DONE' }) {
  return {
    _id: `um-${umowaId}`,
    title: `${MIESIAC} | ${umowaId}`,
    miesiac: MIESIAC,
    umowaId,
    klientContactId: order.buyerInfo.contactId,
    status,
    orderId: order._id,
    stawka,
    kwota: stawka * order.lineItems.length,
    stan: {
      plan: order.lineItems.map(li => ({
        status: 'BOOKED',
        bookingId: li.catalogReference.catalogItemId
      }))
    }
  };
}

/**
 * Buduje świat testowy: klienci -> umowy -> zamówienia.
 * spec: [{ contactId, nazwa, email, umowy: [{ umowaId, ...opcje zamówienia }] }]
 */
function swiat(spec) {
  const w = {
    rows: [],
    umowy: new Map(),
    orders: new Map(),
    kontakty: new Map(),
    fakturyWix: new Map(),
    transakcje: new Map(),
    dodatkoweKlucze: new Map()
  };

  let numer = 1000;

  for (const k of spec) {
    w.kontakty.set(k.contactId, {
      _id: k.contactId,
      info: {
        name: { first: k.imie || k.nazwa.split(' ')[0], last: k.nazwisko || k.nazwa.split(' ').slice(1).join(' ') },
        emails: k.email ? [{ email: k.email, primary: true }] : [],
        phones: k.telefon ? [{ phone: k.telefon, primary: true }] : []
      },
      primaryInfo: { email: k.email, phone: k.telefon }
    });

    for (const u of k.umowy) {
      const id = u.orderId || `ord-${u.umowaId}`;
      const o = zamowienie({ ...u, id, numer: ++numer, contactId: k.contactId });
      w.orders.set(id, o);
      w.umowy.set(u.umowaId, {
        _id: u.umowaId,
        klientContactId: k.contactId,
        klientNazwa: k.nazwa,
        stawka: u.cena ?? 160
      });
      w.rows.push(wierszCyklu(o, { umowaId: u.umowaId, stawka: u.cena ?? 160, status: u.statusCyklu }));

      if (u.fakturyWix) w.fakturyWix.set(id, u.fakturyWix);
      if (u.platnosci) w.transakcje.set(id, { payments: u.platnosci, refunds: [] });
    }
  }

  return w;
}

// ------------------------------------------------------
// CMS (wix-data) w pamięci
// ------------------------------------------------------

function bazaDanych() {
  const kolekcje = new Map();
  const kol = n => {
    if (!kolekcje.has(n)) kolekcje.set(n, new Map());
    return kolekcje.get(n);
  };

  const db = {
    kolekcje,
    // (operacja, kolekcja, element) => true wymusza wyjątek
    awaria: null,
    zapisy: 0,

    async get(c, id) {
      await Promise.resolve();
      return kopia(kol(c).get(id) || null);
    },

    async insert(c, item) {
      await Promise.resolve();
      if (db.awaria?.('insert', c, item)) throw new Error('awaria insert');
      if (kol(c).has(item._id)) throw new Error('WDE0074: item already exists');
      const zapis = { ...kopia(item), _createdDate: new Date().toISOString() };
      kol(c).set(item._id, zapis);
      db.zapisy++;
      return kopia(zapis);
    },

    async update(c, item) {
      await Promise.resolve();
      if (db.awaria?.('update', c, item)) throw new Error('awaria update (timeout)');
      if (!kol(c).has(item._id)) throw new Error('WDE0073: not found');
      kol(c).set(item._id, { ...kopia(item), _createdDate: kol(c).get(item._id)._createdDate });
      db.zapisy++;
      return kopia(item);
    },

    async remove(c, id) {
      await Promise.resolve();
      kol(c).delete(id);
    },

    async find(c, eq = {}) {
      await Promise.resolve();
      return [...kol(c).values()]
        .filter(x => Object.entries(eq).every(([k, v]) => x[k] === v))
        .map(kopia);
    },

    async byIds(c, ids) {
      return [...kol(c).values()].filter(x => ids.includes(x._id)).map(kopia);
    }
  };

  return db;
}

// ------------------------------------------------------
// Wix Invoices (wix-billing-backend) w pamięci
// ------------------------------------------------------

function fakturyWix() {
  const f = {
    faktury: new Map(),
    utworzenia: 0,
    wysylki: 0,
    licznik: 0,
    // 'przed' — wyjątek bez utworzenia; 'po' — faktura powstaje, potem wyjątek
    awariaTworzenia: null,
    awariaWysylki: null,
    odrzucUjemne: false,

    async createInvoice(pola) {
      if (f.awariaTworzenia === 'przed') throw new Error('createInvoice: 503');
      if (f.odrzucUjemne && pola.lineItems.some(l => l.price < 0)) {
        throw new Error('INVALID_ARGUMENT: price must be >= 0');
      }

      const id = `inv-${++f.licznik}`;
      const subtotal = pola.lineItems.reduce(
        (s, l) => s + Math.round(l.price * 100) * l.quantity, 0
      );
      const rabat = pola.discount ? Math.round(pola.discount.value * 100) : 0;

      f.faktury.set(id, {
        id: { id, version: 1 },
        status: 'Draft',
        title: pola.title,
        currency: pola.currency,
        customer: kopia(pola.customer),
        lineItems: kopia(pola.lineItems),
        discount: kopia(pola.discount),
        metadata: kopia(pola.metadata),
        dates: pola.dates,
        totals: { subtotal: subtotal / 100, total: (subtotal - rabat) / 100 },
        wasSent: false
      });
      f.utworzenia++;

      if (f.awariaTworzenia === 'po') {
        f.awariaTworzenia = null;
        throw new Error('createInvoice: deadline exceeded');
      }

      return { id: { id, version: 1 } };
    },

    async getInvoice(id) {
      const x = f.faktury.get(id);
      if (!x) throw new Error('NOT_FOUND');
      return kopia(x);
    },

    async sendInvoice(idAndVersion, email) {
      if (!idAndVersion || typeof idAndVersion.id !== 'string') {
        throw new Error('sendInvoice wymaga płaskiego { id, version }');
      }
      const x = f.faktury.get(idAndVersion.id);
      if (!x) throw new Error('NOT_FOUND');
      if (x.id.version !== idAndVersion.version) throw new Error('VERSION_MISMATCH');
      if (f.awariaWysylki === 'przed') throw new Error('sendInvoice: 503');

      x.wasSent = true;
      x.status = 'Sent';
      x.id.version++;
      x.email = email;
      f.wysylki++;

      if (f.awariaWysylki === 'po') {
        f.awariaWysylki = null;
        throw new Error('sendInvoice: timeout');
      }
    }
  };

  return f;
}

// ------------------------------------------------------
// Bramka + proces
// ------------------------------------------------------

function srodowisko(spec, zmianyCfg = {}) {
  const cfg = cfgTest(zmianyCfg);
  const w = Array.isArray(spec) ? swiat(spec) : spec;
  const db = bazaDanych();
  const inv = fakturyWix();
  const zdarzenia = [];

  const cykle = new Map(w.rows.map(r => [r._id, r]));
  db.kolekcje.set(cfg.kolekcje.umowyMiesiace, cykle);

  const gateway = {
    db,
    awariaApi: {},
    wierszeCykli: () => db.find(cfg.kolekcje.umowyMiesiace, { miesiac: cfg.miesiac }),
    umowy: async ids => new Map(ids.filter(id => w.umowy.has(id)).map(id => [id, kopia(w.umowy.get(id))])),
    zamowienia: async ids => new Map(ids.map(id =>
      [id, w.orders.has(id) ? { raw: kopia(w.orders.get(id)) } : { error: 'getOrder: NOT_FOUND' }]
    )),
    indeksKluczy: async klucze => {
      if (gateway.awariaApi.indeks) return null;
      const m = new Map();
      for (const o of [...w.orders.values(), ...w.dodatkoweKlucze.values()]) {
        const k = o.channelInfo.externalOrderId;
        if (!klucze.includes(k)) continue;
        m.set(k, [...(m.get(k) || []), { id: o._id, status: o.status }]);
      }
      return m;
    },
    fakturyZamowien: async ids => {
      if (gateway.awariaApi.faktury) return null;
      return new Map(ids.map(id => [id, kopia(w.fakturyWix.get(id) || [])]));
    },
    transakcje: async ids => {
      if (gateway.awariaApi.transakcje) return null;
      return new Map(ids.map(id => [id, kopia(w.transakcje.get(id) || { payments: [], refunds: [] })]));
    },
    kontakt: async id => {
      zdarzenia.push(['kontakt', id]);
      if (!w.kontakty.has(id)) throw new Error('contact not found');
      return kopia(w.kontakty.get(id));
    },
    utworzFakture: pola => {
      zdarzenia.push(['createInvoice', pola.customer.contactId]);
      return inv.createInvoice(pola);
    },
    pobierzFakture: id => inv.getInvoice(id),
    wyslijFakture: (id, version, email) => {
      zdarzenia.push(['sendInvoice', id, version]);
      return inv.sendInvoice({ id, version }, email);
    }
  };

  const cicho = { log() {}, warn() {}, error() {} };
  const journal = createJournal(db, cfg);
  const proces = createProcess({ gateway, journal, cfg, log: cicho });

  return { cfg, w, db, inv, gateway, journal, proces, zdarzenia };
}

// PREPARE + APPROVE wszystkiego, co pokazał PREVIEW.
const AUDYT = { sprawdzono: true, kto: 'Administrator testowy', zakres: 'panel Faktury, listopad 2026' };

async function przygotujIZatwierdz(env, opcje = {}) {
  const p = await env.proces.przygotuj(opcje);
  if (p.status !== 'OK') throw new Error(`PREPARE: ${p.blad}`);
  return env.proces.zatwierdz({
    wszystkie: true,
    oczekiwanaLiczba: p.doZatwierdzenia.liczba,
    oczekiwanaSuma: p.doZatwierdzenia.suma,
    audytFaktur: AUDYT,
    ...opcje
  });
}

async function wykonajWszystko(env, opcje = {}) {
  const wyniki = [];
  for (let i = 0; i < 50; i++) {
    const r = await env.proces.wykonaj({ maxOperacji: 2, ...opcje });
    wyniki.push(r);
    if (!r.wyniki?.length || r.zatrzymano) break;
  }
  return wyniki;
}

// ======================================================
// TESTY JEDNOSTKOWE — logika rozliczeń
// ======================================================

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
  const op = { _id: 'op', invoiceId: 'i', klientContactId: 'c', kwotaGrosze: 64000, rabatFaktury: 0, pozycje: [{ nazwa: 'Terapia logopedyczna', cena: 16000, ilosc: 4 }] };
  const ok = { id: { id: 'i', version: 3 }, currency: 'PLN', customer: { contactId: 'c' }, totals: { total: 640 }, lineItems: [{ name: 'Terapia logopedyczna', price: 160, quantity: 4 }], metadata: { sourceRefId: 'op' } };
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

// ======================================================
// TESTY SCENARIUSZOWE — wymagane przypadki 1–18 i zabezpieczenia
// ======================================================



const ANNA = 'c-anna';
const BEATA = 'c-beata';

const kat = (podglad, orderId) =>
  podglad.tabela.find(w => w.orderId === orderId)?.kategoria;

const faktury = env => [...env.inv.faktury.values()];

const sumaFaktur = env =>
  faktury(env).reduce((s, f) => s + Math.round(f.totals.total * 100), 0);

// ------------------------------------------------------

test('1. jedno zamówienie bez rabatu', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4 }] }
  ]);

  const p = await env.proces.podglad();
  assert.equal(p.proponowaneFaktury.length, 1);
  assert.equal(p.proponowaneFaktury[0].razem, '640.00');
  assert.equal(p.kontroleOk, true);

  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);

  const [f] = faktury(env);
  assert.equal(f.title, 'Listopad 2026');
  assert.equal(f.currency, 'PLN');
  assert.equal(f.totals.total, 640);
  assert.equal(f.lineItems.length, 1);
  assert.equal(f.lineItems[0].quantity, 4);
  assert.equal(f.lineItems[0].price, 160);
  assert.equal(f.wasSent, true);
  assert.equal(env.inv.wysylki, 1);

  const due = new Date(f.dates.dueDate) - new Date(f.dates.issueDate);
  assert.equal(due, 5 * 24 * 3600 * 1000);
});

test('2. dwa zamówienia jednego klienta bez rabatów — jedna faktura, dwie pozycje', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', telefon: '48600100200',
      umowy: [
        { umowaId: 'u1', usluga: 'Terapia logopedyczna', cena: 160, wizyty: 4 },
        { umowaId: 'u2', usluga: 'Terapia neurologopedyczna', cena: 180, wizyty: 4 }
      ]
    }
  ]);

  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);

  const all = faktury(env);
  assert.equal(all.length, 1);
  assert.equal(all[0].lineItems.length, 2);
  assert.equal(all[0].totals.total, 1360);
  assert.equal(all[0].customer.phone, '48600100200');
  assert.equal(all[0].customer.fullName, 'Anna Nowak');

  const op = (await env.proces.status()).operacje[0];
  assert.deepEqual(op.orderIds, ['ord-u1', 'ord-u2']);
  assert.equal(op.status, S.SENT);
  assert.equal(op.invoiceId, all[0].id.id);
  assert.ok(op.invoiceVersion >= 1);
});

test('3. dwa zamówienia z osobnymi rabatami — każdy rabat dokładnie raz', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [
        { umowaId: 'u1', cena: 160, wizyty: 4, rabaty: [{ id: 'r1', kwota: 160 }] },
        { umowaId: 'u2', usluga: 'Terapia neurologopedyczna', cena: 180, wizyty: 4, rabaty: [{ id: 'r2', kwota: 180 }] }
      ]
    }
  ]);

  const p = await env.proces.podglad();
  assert.equal(p.sumy.brutto, '1360.00');
  assert.equal(p.sumy.rabaty, '340.00');
  assert.equal(p.sumy.netto, '1020.00');

  const plan = p.proponowaneFaktury[0];
  const ujemne = plan.pozycje.filter(x => Number(x.cena) < 0);
  assert.equal(ujemne.length, 2);
  assert.deepEqual(ujemne.map(x => x.cena).sort(), ['-160.00', '-180.00']);
  assert.equal(plan.razem, '1020.00');

  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);
  assert.equal(faktury(env)[0].totals.total, 1020);
});

test('4. rabat równy cenie jednej wizyty', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4, rabaty: [{ kwota: 160 }] }] }
  ]);

  const plan = (await env.proces.podglad()).proponowaneFaktury[0];
  // Liczba wizyt pozostaje 4 — rabat jest osobną pozycją, nie zmniejsza ilości.
  assert.equal(plan.pozycje[0].ilosc, 4);
  assert.equal(plan.pozycje[1].cena, '-160.00');
  assert.equal(plan.razem, '480.00');
});

test('5. rabat niepodzielny przez cenę wizyty', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4, rabaty: [{ kwota: 53.33 }] }] }
  ]);

  const p = await env.proces.podglad();
  assert.equal(p.proponowaneFaktury[0].razem, '586.67');
  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);
  assert.equal(faktury(env)[0].totals.total, 586.67);
});

test('6. jedno zamówienie wcześniej opłacone (z fakturą), drugie nie', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [
        { umowaId: 'u1', cena: 160, wizyty: 4, paymentStatus: 'PAID', zaplacono: 640, fakturyWix: [{ id: 'old-inv', appId: 'x' }], platnosci: [{ _id: 'p1' }] },
        { umowaId: 'u2', cena: 180, wizyty: 4 }
      ]
    }
  ]);

  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.ROZLICZONE);
  assert.equal(kat(p, 'ord-u2'), K.DO_FAKTURY);
  assert.equal(p.sumy.juzRozliczone, '640.00');
  assert.equal(p.sumy.doNowychFaktur, '720.00');
  assert.deepEqual(p.proponowaneFaktury[0].orderIds, ['ord-u2']);
});

test('7. zamówienie PAID bez potwierdzonej faktury — ręczna decyzja', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [
        { umowaId: 'u1', cena: 160, wizyty: 4, paymentStatus: 'PAID', zaplacono: 640, platnosci: [{ _id: 'p1' }] },
        { umowaId: 'u2', cena: 160, wizyty: 4 }
      ]
    }
  ]);

  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.equal(p.sumy.doSprawdzenia, '640.00');
  assert.equal(p.proponowaneFaktury.length, 1);
  assert.deepEqual(p.proponowaneFaktury[0].orderIds, ['ord-u2']);

  // Opcja: wstrzymanie całego klienta.
  const env2 = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [
        { umowaId: 'u1', cena: 160, wizyty: 4, paymentStatus: 'PAID', zaplacono: 640 },
        { umowaId: 'u2', cena: 160, wizyty: 4 }
      ]
    }
  ], { wstrzymajKlientaPrzyPrzegladzie: true });
  const p2 = await env2.proces.podglad();
  assert.equal(p2.proponowaneFaktury.length, 0);
  assert.equal(p2.sumy.doSprawdzenia, '1280.00');
});

test('8. zamówienie zafakturowane, ale nadal NOT_PAID — bez drugiej faktury', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4, fakturyWix: [{ id: 'inv-old', appId: 'x' }] }]
    }
  ]);

  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.ROZLICZONE);
  assert.equal(p.proponowaneFaktury.length, 0);

  // Ten sam przypadek, gdy faktura jest tylko w naszym dzienniku.
  const env2 = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4 }] }
  ]);
  await przygotujIZatwierdz(env2);
  await wykonajWszystko(env2);
  const p2 = await env2.proces.podglad();
  assert.equal(kat(p2, 'ord-u1'), K.ROZLICZONE);
  assert.equal(p2.proponowaneFaktury.length, 0);
  await przygotujIZatwierdz(env2).catch(() => {});
  await wykonajWszystko(env2);
  assert.equal(env2.inv.utworzenia, 1);
});

test('9. zamówienie częściowo opłacone — ręczna decyzja', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4, paymentStatus: 'PARTIALLY_PAID', zaplacono: 320, platnosci: [{ _id: 'p' }] }] }
  ]);

  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.match(p.doRecznejDecyzji[0].powod, /częściowo/);
  assert.equal(p.proponowaneFaktury.length, 0);
});

test('10. zamówienie anulowane — wykluczone, należność widoczna w sumach', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4, status: 'CANCELED', statusCyklu: 'CANCELED' }] }
  ]);

  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.ANULOWANE);
  assert.equal(p.sumy.anulowane, '640.00');
  assert.equal(p.kontroleSum.rozbicieZgodne, true);
  assert.equal(p.proponowaneFaktury.length, 0);
});

test('11. dwa różne kontakty o tym samym nazwisku — osobne faktury', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'nowak@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4 }] },
    { contactId: 'c-anna-2', nazwa: 'Anna Nowak', email: 'nowak@x.pl', umowy: [{ umowaId: 'u2', cena: 160, wizyty: 4 }] }
  ]);

  const p = await env.proces.podglad();
  assert.equal(p.proponowaneFaktury.length, 2);
  assert.ok(p.ostrzezenia.some(o => /różnych kontaktów/.test(o)));
  assert.ok(p.ostrzezenia.some(o => /Ten sam e-mail/.test(o)));

  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);
  const ids = faktury(env).map(f => f.customer.contactId).sort();
  assert.deepEqual(ids, [ANNA, 'c-anna-2']);
});

test('12. ponowny RUN po utworzeniu części faktur', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] },
    { contactId: BEATA, nazwa: 'Beata Kowal', email: 'b@x.pl', umowy: [{ umowaId: 'u2' }] },
    { contactId: 'c-cezary', nazwa: 'Cezary Lis', email: 'c@x.pl', umowy: [{ umowaId: 'u3' }] }
  ]);

  await przygotujIZatwierdz(env);
  const r1 = await env.proces.wykonaj({ maxOperacji: 1 });
  assert.equal(r1.wyniki.length, 1);
  assert.equal(env.inv.utworzenia, 1);

  // Tylko tworzenie, bez wysyłki.
  const r2 = await env.proces.wykonaj({ maxOperacji: 1, etap: 'UTWORZ' });
  assert.equal(r2.wyniki[0].status, S.CREATED);

  await wykonajWszystko(env);
  await wykonajWszystko(env);

  assert.equal(env.inv.utworzenia, 3);
  assert.equal(env.inv.wysylki, 3);
  const st = await env.proces.status();
  assert.deepEqual(st.statusy, { SENT: 3 });
});

test('13. awaria bezpośrednio po createInvoice() — bez ponownego tworzenia', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  await przygotujIZatwierdz(env);

  // Faktura powstaje, ale zapis CREATED do dziennika nie dochodzi.
  env.db.awaria = (op, c, item) => op === 'update' && item.status === S.CREATED;
  await assert.rejects(env.proces.wykonaj({ maxOperacji: 1 }), /Niepotwierdzony zapis/);
  env.db.awaria = null;
  assert.equal(env.inv.utworzenia, 1);

  // Blokada wygasa dopiero po 5 min — symulujemy jej zwolnienie przez administratora.
  await env.db.remove(env.cfg.kolekcje.blokady, (await env.db.find(env.cfg.kolekcje.blokady))[0]?._id);

  const r = await env.proces.wykonaj({ maxOperacji: 1 });
  assert.equal(r.uporzadkowaneNiepewne[0].powodPrzegladu, 'CREATE_UNCERTAIN');
  assert.equal(env.inv.utworzenia, 1, 'nie wolno utworzyć drugiej faktury');

  // Kolejne RUN-y nadal nic nie tworzą.
  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 1);

  // PREVIEW pokazuje należność jako wymagającą sprawdzenia.
  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.equal(p.proponowaneFaktury.length, 0);

  // Administrator znajduje fakturę w panelu i przypina ją do operacji.
  const op = r.uporzadkowaneNiepewne[0].operationId;
  const zly = await env.proces.rozstrzygnij({ operationId: op, decyzja: 'FAKTURY_BRAK' });
  assert.equal(zly.status, 'ODMOWA');

  const ok = await env.proces.rozstrzygnij({ operationId: op, decyzja: 'FAKTURA_ISTNIEJE', invoiceId: 'inv-1' });
  assert.equal(ok.status, 'OK');
  assert.equal(ok.operacja.status, S.CREATED);

  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 1);
  assert.equal(env.inv.wysylki, 1);
});

test('13b. createInvoice zwraca błąd (timeout po utworzeniu) — NEEDS_REVIEW, RUN zatrzymany', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] },
    { contactId: BEATA, nazwa: 'Beata Kowal', email: 'b@x.pl', umowy: [{ umowaId: 'u2' }] }
  ]);
  await przygotujIZatwierdz(env);
  env.inv.awariaTworzenia = 'po';

  const r = await env.proces.wykonaj({ maxOperacji: 2 });
  assert.match(r.zatrzymano, /CREATE_UNCERTAIN/);
  assert.equal(r.wyniki.length, 1);
  assert.equal(env.inv.utworzenia, 1);

  // Administrator stwierdza brak faktury? Tu faktura istnieje — przypina ją.
  const op = r.doRecznejDecyzji[0].operationId;
  const res = await env.proces.rozstrzygnij({ operationId: op, decyzja: 'FAKTURA_ISTNIEJE', invoiceId: 'inv-1' });
  assert.equal(res.status, 'OK');
  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 2);
  assert.equal(env.inv.wysylki, 2);
});

test('13c. createInvoice odrzucony przed utworzeniem — FAKTURY_BRAK pozwala ponowić', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  await przygotujIZatwierdz(env);
  env.inv.awariaTworzenia = 'przed';
  const r = await env.proces.wykonaj({ maxOperacji: 1 });
  const op = r.doRecznejDecyzji[0].operationId;
  env.inv.awariaTworzenia = null;

  const res = await env.proces.rozstrzygnij({ operationId: op, decyzja: 'FAKTURY_BRAK', potwierdzam: true });
  assert.equal(res.operacja.status, S.APPROVED);
  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 1);
  assert.equal(env.inv.wysylki, 1);
});

test('14. awaria bezpośrednio po sendInvoice() — bez ponownej wysyłki', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  await przygotujIZatwierdz(env);

  // Wysyłka się udała, ale zapis SENT nie dochodzi do dziennika.
  env.db.awaria = (op, c, item) => op === 'update' && item.status === S.SENT;
  await assert.rejects(env.proces.wykonaj({ maxOperacji: 1 }), /Niepotwierdzony zapis/);
  env.db.awaria = null;
  await env.db.remove(env.cfg.kolekcje.blokady, (await env.db.find(env.cfg.kolekcje.blokady))[0]?._id);

  const r = await env.proces.wykonaj({ maxOperacji: 1 });
  assert.equal(r.uporzadkowaneNiepewne[0].status, S.SENT);
  assert.equal(env.inv.wysylki, 1, 'faktura wysłana dokładnie raz (jeden SMS)');
});

test('14b. sendInvoice zwraca błąd, a wasSent = false — NEEDS_REVIEW, bez ponowienia', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  await przygotujIZatwierdz(env);
  env.inv.awariaWysylki = 'przed';

  const r = await env.proces.wykonaj({ maxOperacji: 1 });
  assert.equal(r.wyniki[0].powodPrzegladu, 'SEND_UNCERTAIN');
  env.inv.awariaWysylki = null;

  await wykonajWszystko(env);
  assert.equal(env.inv.wysylki, 0);

  const op = r.wyniki[0].operationId;
  const odm = await env.proces.rozstrzygnij({ operationId: op, decyzja: 'WYSLIJ_PONOWNIE' });
  assert.equal(odm.status, 'ODMOWA');
  await env.proces.rozstrzygnij({ operationId: op, decyzja: 'WYSLIJ_PONOWNIE', potwierdzam: true });
  await wykonajWszystko(env);
  assert.equal(env.inv.wysylki, 1);
});

test('14c. sendInvoice timeout po wysłaniu — rozstrzygnięcie WYSLANA', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  await przygotujIZatwierdz(env);
  env.inv.awariaWysylki = 'po';
  const r = await env.proces.wykonaj({ maxOperacji: 1 });
  const op = r.wyniki[0].operationId;
  assert.equal(r.wyniki[0].status, S.NEEDS_REVIEW);

  const res = await env.proces.rozstrzygnij({ operationId: op, decyzja: 'WYSLANA' });
  assert.equal(res.operacja.status, S.SENT);
  assert.equal(env.inv.wysylki, 1);
});

test('15. dwa równoległe uruchomienia — jedno BUSY, faktury bez duplikatów', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] },
    { contactId: BEATA, nazwa: 'Beata Kowal', email: 'b@x.pl', umowy: [{ umowaId: 'u2' }] }
  ]);
  await przygotujIZatwierdz(env);

  const [a, b] = await Promise.all([
    env.proces.wykonaj({ maxOperacji: 5 }),
    env.proces.wykonaj({ maxOperacji: 5 })
  ]);

  assert.equal([a, b].filter(r => r.status === 'BUSY').length, 1);
  assert.equal(env.inv.utworzenia, 2);
  assert.equal(env.inv.wysylki, 2);

  // Równoległe PREPARE też się wykluczają, a przypisania są unikalne.
  const env2 = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  const [x, y] = await Promise.all([env2.proces.przygotuj(), env2.proces.przygotuj()]);
  assert.equal([x, y].filter(r => r.status === 'BUSY').length, 1);
});

test('15b. generator cykli pracuje — fakturowanie czeka', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  await env.db.insert(env.cfg.kolekcje.blokady, { _id: GENERATOR_LOCK_ID, token: 't' });
  const r = await env.proces.przygotuj();
  assert.equal(r.status, 'BUSY');
});

test('16. rabat obniżający wartość zamówienia do zera', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [
        { umowaId: 'u1', cena: 160, wizyty: 1, rabaty: [{ kwota: 160 }] },
        { umowaId: 'u2', cena: 180, wizyty: 4 }
      ]
    }
  ]);

  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.ZEROWE);
  assert.equal(p.sumy.rabaty, '160.00');
  assert.equal(p.sumy.zerowe, '0.00');
  assert.deepEqual(p.proponowaneFaktury[0].orderIds, ['ord-u2']);
  assert.equal(p.kontroleOk, true);
});

test('17. dwa zamówienia z różnymi usługami i identyczną ceną — osobne pozycje', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [
        { umowaId: 'u1', usluga: 'Terapia logopedyczna', cena: 160, wizyty: 4 },
        { umowaId: 'u2', usluga: 'Terapia integracji sensorycznej', cena: 160, wizyty: 3 }
      ]
    }
  ]);

  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);
  const [f] = faktury(env);
  assert.equal(f.lineItems.length, 2);
  assert.deepEqual(
    f.lineItems.map(l => [l.name, l.quantity, l.price]),
    [['Terapia logopedyczna', 4, 160], ['Terapia integracji sensorycznej', 3, 160]]
  );
  assert.equal(f.totals.total, 1120);
});

test('18. suma nowych faktur = rozliczenie zamówień źródłowych', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [
        { umowaId: 'u1', cena: 160, wizyty: 4, rabaty: [{ kwota: 160 }] },
        { umowaId: 'u2', cena: 180, wizyty: 5, rabaty: [{ kwota: 90.5 }] }
      ]
    },
    { contactId: BEATA, nazwa: 'Beata Kowal', email: 'b@x.pl', umowy: [{ umowaId: 'u3', cena: 150, wizyty: 3 }] },
    { contactId: 'c-c', nazwa: 'Cezary Lis', email: 'c@x.pl', umowy: [{ umowaId: 'u4', paymentStatus: 'PAID', zaplacono: 640 }] },
    { contactId: 'c-d', nazwa: 'Dorota Lis', email: 'd@x.pl', umowy: [{ umowaId: 'u5', status: 'CANCELED', statusCyklu: 'CANCELED' }] },
    { contactId: 'c-e', nazwa: 'Ewa Lis', email: 'e@x.pl', umowy: [{ umowaId: 'u6', fakturyWix: [{ id: 'i' }] }] }
  ]);

  const p = await env.proces.podglad();
  assert.equal(p.kontroleOk, true);
  // 640 + 900 + 450 + 640 + 640 + 640 = 3910 brutto; rabaty 250.50
  assert.equal(p.sumy.brutto, '3910.00');
  assert.equal(p.sumy.rabaty, '250.50');
  assert.equal(p.sumy.netto, '3659.50');
  assert.equal(p.sumy.doNowychFaktur, '1739.50');
  assert.equal(p.sumy.doSprawdzenia, '640.00');
  assert.equal(p.sumy.anulowane, '640.00');
  assert.equal(p.sumy.juzRozliczone, '640.00');

  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);

  assert.equal(sumaFaktur(env), 173950);
  assert.equal(env.inv.utworzenia, 2);

  // Po RUN: nowe należności przeszły do „już rozliczone”, nic nie zniknęło.
  const po = await env.proces.podglad();
  assert.equal(po.sumy.juzRozliczone, '2379.50');
  assert.equal(po.sumy.doNowychFaktur, '0.00');
  assert.equal(po.sumy.netto, p.sumy.netto);
  assert.equal(po.kontroleOk, true);
});

// ------------------------------------------------------
// Dodatkowe zabezpieczenia
// ------------------------------------------------------

test('PREVIEW nie zapisuje niczego i nie wywołuje Wix Invoices', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }, { umowaId: 'u2' }] }
  ]);
  const przed = env.db.zapisy;
  await env.proces.podglad();
  await env.proces.podglad();
  assert.equal(env.db.zapisy, przed);
  assert.equal(env.zdarzenia.filter(z => z[0] !== 'kontakt').length, 0);
});

test('drugie zamówienie klienta po wystawieniu pierwszej faktury — druga faktura tylko na resztę', async () => {
  const w = swiat([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4 }] }
  ]);
  const env = srodowisko(w);
  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);

  // Później pojawia się drugi, rozliczony cykl tego samego klienta.
  const o2 = zamowienie({ id: 'ord-u2', numer: 2000, contactId: ANNA, umowaId: 'u2', cena: 180, wizyty: 4, rabaty: [{ kwota: 180 }] });
  w.orders.set('ord-u2', o2);
  w.umowy.set('u2', { _id: 'u2', klientContactId: ANNA, klientNazwa: 'Anna Nowak' });
  const row = wierszCyklu(o2, { umowaId: 'u2', stawka: 180 });
  env.db.kolekcje.get(env.cfg.kolekcje.umowyMiesiace).set(row._id, row);

  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.ROZLICZONE);
  assert.deepEqual(p.proponowaneFaktury[0].orderIds, ['ord-u2']);
  assert.equal(p.proponowaneFaktury[0].razem, '540.00');

  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 2);
  assert.deepEqual(faktury(env).map(f => f.totals.total), [640, 540]);
});

test('zmiana zamówienia po zatwierdzeniu — NEEDS_REVIEW zamiast faktury', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4 }] }
  ]);
  await przygotujIZatwierdz(env);

  // Klient zapłacił między zatwierdzeniem a RUN.
  const o = env.w.orders.get('ord-u1');
  o.paymentStatus = 'PAID';
  o.balanceSummary.paid = { amount: '640.00' };

  const r = await env.proces.wykonaj({ maxOperacji: 1 });
  assert.equal(r.wyniki[0].status, S.NEEDS_REVIEW);
  assert.equal(r.wyniki[0].powodPrzegladu, 'ZMIANA_DANYCH');
  assert.equal(env.inv.utworzenia, 0);

  // Operację, która nie doszła do createInvoice, można anulować.
  const a = await env.proces.rozstrzygnij({ operationId: r.wyniki[0].operationId, decyzja: 'ANULUJ', uwagi: 'opłacone gotówką' });
  assert.equal(a.operacja.status, S.CANCELLED);
});

test('APPROVE wymaga zgodnej liczby i sumy', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  await env.proces.przygotuj();
  const zle = await env.proces.zatwierdz({ wszystkie: true, oczekiwanaLiczba: 1, oczekiwanaSuma: '600.00', audytFaktur: AUDYT });
  assert.equal(zle.status, 'ODMOWA');
  const r = await env.proces.wykonaj();
  assert.equal(r.wyniki.length, 0, 'bez zatwierdzenia RUN nic nie robi');
  const ok = await env.proces.zatwierdz({ wszystkie: true, oczekiwanaLiczba: 1, oczekiwanaSuma: '640.00', audytFaktur: AUDYT });
  assert.equal(ok.status, 'OK');
});

test('niepotwierdzone API faktur zamówień blokuje PREPARE', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  env.gateway.awariaApi.faktury = true;
  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.equal(p.gotoweDoPrzygotowania, false);
  const r = await env.proces.przygotuj();
  assert.equal(r.status, 'ODMOWA');
});

test('dodatkowe zamówienie z tym samym kluczem umowy — do sprawdzenia', async () => {
  const w = swiat([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  w.dodatkoweKlucze.set('dup', zamowienie({ id: 'ord-dup', numer: 9, contactId: ANNA, umowaId: 'u1' }));
  const env = srodowisko(w);
  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.match(p.doRecznejDecyzji[0].powod, /ord-dup/);
});

test('zamówienie innego kontaktu niż umowa — nie trafia na fakturę', async () => {
  const w = swiat([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  w.orders.get('ord-u1').buyerInfo.contactId = BEATA;
  const env = srodowisko(w);
  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.equal(p.proponowaneFaktury.length, 0);
});

test('tryb INVOICE_DISCOUNT — rabat faktury zamiast ujemnych pozycji', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [
        { umowaId: 'u1', cena: 160, wizyty: 4, rabaty: [{ kwota: 160 }] },
        { umowaId: 'u2', cena: 180, wizyty: 4, rabaty: [{ kwota: 180 }] }
      ]
    }
  ], { trybRabatu: 'INVOICE_DISCOUNT' });
  env.inv.odrzucUjemne = true;

  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);
  const [f] = faktury(env);
  assert.equal(f.lineItems.length, 2);
  assert.deepEqual(f.discount, { value: 340, type: 'Fixed' });
  assert.equal(f.totals.total, 1020);
});

test('Wix odrzuca ujemne pozycje — NEEDS_REVIEW i zatrzymanie partii', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', rabaty: [{ kwota: 160 }] }] },
    { contactId: BEATA, nazwa: 'Beata Kowal', email: 'b@x.pl', umowy: [{ umowaId: 'u2', rabaty: [{ kwota: 160 }] }] }
  ]);
  env.inv.odrzucUjemne = true;
  await przygotujIZatwierdz(env);
  const r = await env.proces.wykonaj({ maxOperacji: 2 });
  assert.equal(r.wyniki.length, 1);
  assert.ok(r.zatrzymano);
  assert.equal(env.inv.utworzenia, 0);
});

test('stara blokada wymaga decyzji administratora', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  await env.db.insert(env.cfg.kolekcje.blokady, { _id: LOCK_ID, token: 'x' });
  env.db.kolekcje.get(env.cfg.kolekcje.blokady).get(LOCK_ID)._createdDate = '2026-01-01T00:00:00Z';

  const r = await env.proces.wykonaj();
  assert.equal(r.status, 'LOCK_REVIEW');
  assert.equal((await env.proces.zwolnijBlokade()).status, 'ODMOWA');
  assert.equal((await env.proces.zwolnijBlokade({ potwierdzam: true })).status, 'ZWOLNIONA');
  assert.notEqual((await env.proces.wykonaj()).status, 'LOCK_REVIEW');
});

// ======================================================
// REGRESJA PRZEGLĄDU reviews/november-944a44c.md (R1–R4)
// ======================================================

const DZIENNIK = KONFIGURACJA_LISTOPAD_2026.kolekcje.dziennik;
const CYKLE = KONFIGURACJA_LISTOPAD_2026.kolekcje.umowyMiesiace;

const jedenKlient = (umowy = [{ umowaId: 'u1' }]) => srodowisko([
  { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy }
]);

// ---------------- R1 ----------------

test('R1: faktura standalone poza dziennikiem jest niewidoczna dla API — APPROVE wymaga audytu', async () => {
  const env = jedenKlient();
  // Order Invoices puste, brak transakcji: API nie odróżni tego od braku faktury.
  const p = await env.proces.przygotuj();
  const bez = await env.proces.zatwierdz({ wszystkie: true, oczekiwanaLiczba: 1, oczekiwanaSuma: '640.00' });
  assert.equal(bez.status, 'ODMOWA');
  assert.match(bez.blad, /audytFaktur/);

  const niepelny = await env.proces.zatwierdz({
    wszystkie: true, oczekiwanaLiczba: 1, oczekiwanaSuma: '640.00',
    audytFaktur: { sprawdzono: true, kto: '', zakres: 'x' }
  });
  assert.equal(niepelny.status, 'ODMOWA');

  const r = await env.proces.wykonaj({ maxOperacji: 5 });
  assert.equal(r.wyniki.length, 0);
  assert.equal(env.inv.utworzenia, 0);
  assert.equal(p.doZatwierdzenia.liczba, 1);
});

test('R1: audyt zapisany trwale z miesiącem, kontaktem, orderIds i fingerprintem', async () => {
  const env = jedenKlient([{ umowaId: 'u1' }, { umowaId: 'u2', cena: 180 }]);
  await przygotujIZatwierdz(env);
  const [op] = await env.db.find(DZIENNIK, { rodzaj: 'FAKTURA' });
  assert.equal(op.audytFaktur.kto, AUDYT.kto);
  assert.equal(op.audytFaktur.miesiac, '2026-11');
  assert.equal(op.audytFaktur.contactId, ANNA);
  assert.deepEqual(op.audytFaktur.orderIds, ['ord-u1', 'ord-u2']);
  assert.equal(op.audytFaktur.fingerprint, op.fingerprint);
});

test('R1: nieaktualny audyt (inna wersja danych) — brak faktury, NEEDS_REVIEW/BRAK_AUDYTU', async () => {
  const env = jedenKlient();
  await przygotujIZatwierdz(env);
  const kol = env.db.kolekcje.get(DZIENNIK);
  const op = [...kol.values()].find(x => x.rodzaj === 'FAKTURA');
  op.audytFaktur.fingerprint = 'inna-wersja';

  const r = await env.proces.wykonaj({ maxOperacji: 1 });
  assert.equal(r.wyniki[0].status, S.NEEDS_REVIEW);
  assert.equal(r.wyniki[0].powodPrzegladu, 'BRAK_AUDYTU');
  assert.equal(env.inv.utworzenia, 0);
});

test('R1: brak audytu w operacji APPROVED (np. edycja ręczna) — brak faktury', async () => {
  const env = jedenKlient();
  await przygotujIZatwierdz(env);
  const op = [...env.db.kolekcje.get(DZIENNIK).values()].find(x => x.rodzaj === 'FAKTURA');
  delete op.audytFaktur;
  const r = await env.proces.wykonaj({ maxOperacji: 1 });
  assert.equal(r.wyniki[0].powodPrzegladu, 'BRAK_AUDYTU');
  assert.equal(env.inv.utworzenia, 0);
});

test('R1: wpis listopada w starym formacie (bez rodzaj) — klient do sprawdzenia', async () => {
  const env = jedenKlient();
  await env.db.insert(DZIENNIK, {
    _id: 'legacy-1', miesiac: '2026-11', klientContactId: ANNA,
    status: 'WYSLANA', invoiceId: 'inv-reczna', orderIds: []
  });
  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.match(p.doRecznejDecyzji[0].powod, /legacy-1/);
  assert.equal(p.proponowaneFaktury.length, 0);
});

test('R1: stary wpis bez kontaktu — brak kompletności, PREPARE wymaga jawnej akceptacji', async () => {
  const env = jedenKlient();
  await env.db.insert(DZIENNIK, { _id: 'legacy-2', miesiac: '2026-11', status: 'TWORZENIE' });
  const p = await env.proces.podglad();
  assert.equal(p.kontroleOk, false);
  assert.deepEqual(p.braki.wpisyDziennika, ['legacy-2']);
  assert.equal((await env.proces.przygotuj()).status, 'ODMOWA');
  const ok = await env.proces.przygotuj({ akceptujNiekompletne: { orderIds: [], umowaIds: [], wpisyDziennika: ['legacy-2'] } });
  assert.equal(ok.status, 'OK');
});

// ---------------- R2 ----------------

const opPlan = {
  _id: 'op', invoiceId: 'i', klientContactId: 'c', kwotaGrosze: 48000, rabatFaktury: 0,
  pozycje: [
    { nazwa: 'Terapia logopedyczna', cena: 16000, ilosc: 4 },
    { nazwa: 'Rabat', cena: -16000, ilosc: 1 }
  ]
};
const fakturaZgodna = () => ({
  id: { id: 'i', version: 2 }, currency: 'PLN', customer: { contactId: 'c' },
  metadata: { sourceRefId: 'op' }, totals: { total: 480 },
  lineItems: [
    { name: 'Terapia logopedyczna', price: 160, quantity: 4 },
    { name: 'Rabat', price: -160, quantity: 1 }
  ]
});

test('R2: zgodna faktura przechodzi kontrolę', () => {
  assert.deepEqual(sprawdzFakture(fakturaZgodna(), opPlan), []);
});

test('R2: zmieniony rabat przy zachowanej sumie końcowej — odrzucone', () => {
  const f = fakturaZgodna();
  f.lineItems = [
    { name: 'Terapia logopedyczna', price: 160, quantity: 3 },
    { name: 'Rabat', price: 0, quantity: 1 }
  ];
  const p = sprawdzFakture(f, opPlan);
  assert.ok(p.some(x => /ilość/.test(x)));
  assert.ok(p.some(x => /cena/.test(x)));
});

test('R2: zmieniona usługa, ilość i cena przy tej samej liczbie pozycji i sumie — odrzucone', () => {
  const f = fakturaZgodna();
  f.lineItems[0] = { name: 'Inna usługa', price: 640, quantity: 1 };
  f.lineItems[1] = { name: 'Rabat', price: -160, quantity: 1 };
  assert.ok(sprawdzFakture(f, opPlan).some(x => /nazwa/.test(x)));
});

test('R2: brak waluty, brak sourceRefId, inny rabat faktury — odrzucone', () => {
  const bezWaluty = fakturaZgodna();
  delete bezWaluty.currency;
  assert.ok(sprawdzFakture(bezWaluty, opPlan).some(x => /Waluta/.test(x)));

  const bezRef = fakturaZgodna();
  delete bezRef.metadata;
  assert.ok(sprawdzFakture(bezRef, opPlan).some(x => /sourceRefId/.test(x)));
  // Wyjątek jawny: tylko przy decyzji administratora (potwierdzam).
  assert.deepEqual(sprawdzFakture(bezRef, opPlan, { bezRef: true }), []);

  const innyRef = fakturaZgodna();
  innyRef.metadata.sourceRefId = 'cudza';
  assert.ok(sprawdzFakture(innyRef, opPlan, { bezRef: true }).length > 0);

  const rabat = fakturaZgodna();
  rabat.discount = { value: 10, type: 'Fixed' };
  assert.ok(sprawdzFakture(rabat, opPlan).some(x => /Rabat faktury/.test(x)));
});

test('R2: faktura zmieniona między utworzeniem a wysyłką — bez wysyłki', async () => {
  const env = jedenKlient();
  await przygotujIZatwierdz(env);
  await env.proces.wykonaj({ maxOperacji: 1, etap: 'UTWORZ' });
  const f = env.inv.faktury.get('inv-1');
  f.lineItems[0].name = 'Inna usługa';
  const r = await env.proces.wykonaj({ maxOperacji: 1, etap: 'WYSLIJ' });
  assert.equal(r.wyniki[0].powodPrzegladu, 'INVOICE_MISMATCH');
  assert.equal(env.inv.wysylki, 0);
});

test('R2: RESOLVE FAKTURA_ISTNIEJE nie przypnie innej faktury o tej samej kwocie', async () => {
  const env = jedenKlient();
  await przygotujIZatwierdz(env);
  env.inv.awariaTworzenia = 'przed';
  const r = await env.proces.wykonaj({ maxOperacji: 1 });
  const op = r.doRecznejDecyzji[0].operationId;
  env.inv.awariaTworzenia = null;

  // Ręcznie wystawiona faktura: ta sama kwota i kontakt, inna treść, bez sourceRefId.
  await env.inv.createInvoice({
    title: 'Listopad 2026', currency: 'PLN', customer: { contactId: ANNA },
    lineItems: [{ id: '1', name: 'Konsultacja', price: 640, quantity: 1 }]
  });
  const res = await env.proces.rozstrzygnij({ operationId: op, decyzja: 'FAKTURA_ISTNIEJE', invoiceId: 'inv-1', potwierdzam: true });
  assert.equal(res.status, 'ODMOWA');
  assert.match(res.blad, /nazwa|ilość/);
});

// ---------------- R3 ----------------

test('R3: brak ceny, subtotal lub total — kwota nieznana, nie zero', () => {
  const raw = zamowienie({ id: 'o', numer: 1, contactId: 'c', umowaId: 'u' });
  delete raw.lineItems[0].price;
  assert.throws(() => normalizujZamowienie(raw), /cena pozycji/);

  const bezTotal = zamowienie({ id: 'o', numer: 1, contactId: 'c', umowaId: 'u' });
  delete bezTotal.priceSummary.total;
  assert.throws(() => normalizujZamowienie(bezTotal), /total/);

  const bezPozycji = zamowienie({ id: 'o', numer: 1, contactId: 'c', umowaId: 'u' });
  bezPozycji.lineItems = [];
  assert.throws(() => normalizujZamowienie(bezPozycji), /bez pozycji/);
});

test('R3: nieprawidłowe typy kwot odrzucane', () => {
  assert.throws(() => grosze(true), /Nieprawidłowa/);
  assert.throws(() => grosze('1e3'), /Nieprawidłowa/);
  assert.throws(() => grosze({ amount: [] }), /Nieprawidłowa/);
  assert.throws(() => grosze(1e20), /zakresem/);
  assert.equal(grosze(' 12.50 '), 1250);
});

test('R3: zamówienie bez kwot w procesie — DO_SPRAWDZENIA z kwotą NIEZNANA', async () => {
  const env = jedenKlient();
  const o = env.w.orders.get('ord-u1');
  delete o.lineItems[0].price;
  env.db.kolekcje.get(CYKLE).get('um-u1').kwota = undefined;
  const p = await env.proces.podglad();
  const w = p.tabela.find(x => x.orderId === 'ord-u1');
  assert.equal(w.kategoria, K.DO_SPRAWDZENIA);
  assert.equal(w.netto, 'NIEZNANA');
  assert.equal(p.sumy.nieznanychKwot, 1);
  assert.equal(p.kontroleOk, false);
  assert.equal(p.proponowaneFaktury.length, 0);
});

// ---------------- R4 ----------------

test('R4: ten sam orderId w dwóch cyklach — liczony raz, brak kompletności', async () => {
  const env = jedenKlient();
  const kopiaWiersza = { ...env.db.kolekcje.get(CYKLE).get('um-u1'), _id: 'um-u1-dup', umowaId: 'u1-dup' };
  env.db.kolekcje.get(CYKLE).set(kopiaWiersza._id, kopiaWiersza);
  const p = await env.proces.podglad();
  assert.equal(p.sumy.netto, '640.00');
  assert.deepEqual(p.kompletnosc.zdublowaneOrderId, ['ord-u1']);
  assert.equal(p.arytmetykaOk, true);
  assert.equal(p.kompletne, false);
  assert.equal(p.kontroleOk, false);
  assert.equal(p.proponowaneFaktury.length, 0);
});

test('R4: cykl bez orderId i nieodczytane zamówienie bez kwoty — jawne braki', async () => {
  const env = jedenKlient([{ umowaId: 'u1' }, { umowaId: 'u2' }, { umowaId: 'u3' }]);
  const cykle = env.db.kolekcje.get(CYKLE);
  Object.assign(cykle.get('um-u2'), { orderId: '', status: 'RUNNING' });
  env.w.orders.delete('ord-u3');
  cykle.get('um-u3').kwota = 0;

  const p = await env.proces.podglad();
  assert.deepEqual(p.braki.umowaIds, ['u2']);
  assert.deepEqual(p.braki.orderIds, ['ord-u3']);
  assert.deepEqual(p.kompletnosc.bezKwoty, ['ord-u3']);
  assert.equal(p.kontroleOk, false);
  assert.equal(p.gotoweDoPrzygotowania, false);

  // Częściowa akceptacja nie wystarcza.
  const czesc = await env.proces.przygotuj({ akceptujNiekompletne: { orderIds: ['ord-u3'], umowaIds: [], wpisyDziennika: [] } });
  assert.equal(czesc.status, 'ODMOWA');

  // Dokładna akceptacja: faktura tylko dla zamówienia, które jest jasne.
  const akc = { orderIds: ['ord-u3'], umowaIds: ['u2'], wpisyDziennika: [] };
  await przygotujIZatwierdz(env, { akceptujNiekompletne: akc });
  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 1);
  assert.equal([...env.inv.faktury.values()][0].totals.total, 640);
  const [op] = await env.db.find(DZIENNIK, { rodzaj: 'FAKTURA' });
  assert.deepEqual(op.audytFaktur.akceptowaneBraki, akc);
});

// ======================================================
// REGUŁY Z ODCZYTU DANYCH WITRYNY (2026-10-26)
// ======================================================

const { kluczZgodny, strukturaFaktury } = _test;

test('Dane: znane formaty externalOrderId są akceptowane, obce — nie', () => {
  const m = '2026-11';
  assert.equal(kluczZgodny('TOTO:2026-11:u1', m, 'u1'), true);
  assert.equal(kluczZgodny('2026-11/u1', m, 'u1'), true);
  assert.equal(kluczZgodny('TOTO:2026-11:u1:repair1', m, 'u1'), true);
  assert.equal(kluczZgodny('TOTO:2026-11:u1/restore2', m, 'u1'), true);
  assert.equal(kluczZgodny('', m, 'u1'), true);
  assert.equal(kluczZgodny(undefined, m, 'u1'), true);
  assert.equal(kluczZgodny('TOTO:2026-10:u1', m, 'u1'), false);
  assert.equal(kluczZgodny('TOTO:2026-11:u2', m, 'u1'), false);
  assert.equal(kluczZgodny('2026-11/u2', m, 'u1'), false);
  assert.equal(kluczZgodny('TOTO:2026-11:u1:repairX', m, 'u1'), false);
  assert.equal(kluczZgodny('TOTO:2026-11:u1x', m, 'u1'), false);
});

test('Dane: zamówienie bez externalOrderId i z formatem m/umowa — do faktury, gdy wizyty i kontakt się zgadzają', async () => {
  const w = swiat([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', externalOrderId: '2026-11/u1' }, { umowaId: 'u2', cena: 180 }] }
  ]);
  w.orders.get('ord-u2').channelInfo = { type: 'BACKOFFICE_MERCHANT' };
  const env = srodowisko(w);
  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_FAKTURY);
  assert.equal(kat(p, 'ord-u2'), K.DO_FAKTURY);
  assert.equal(p.tabela.find(x => x.orderId === 'ord-u2').kluczZamowienia, '(brak)');
  assert.equal(p.proponowaneFaktury[0].razem, '1360.00');
});

test('Dane: zamówienie bez klucza, ale z wizytami spoza cyklu — do sprawdzenia', async () => {
  const w = swiat([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  const o = w.orders.get('ord-u1');
  o.channelInfo = {};
  o.lineItems[0].catalogReference.catalogItemId = 'obca-wizyta';
  const env = srodowisko(w);
  assert.equal(kat(await env.proces.podglad(), 'ord-u1'), K.DO_SPRAWDZENIA);
});

test('Dane: naprawione zamówienie (repair) z anulowanym poprzednikiem — do faktury', async () => {
  const w = swiat([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', externalOrderId: 'TOTO:2026-11:u1:repair1' }] }
  ]);
  w.dodatkoweKlucze.set('stare', zamowienie({ id: 'ord-stare', numer: 1, contactId: ANNA, umowaId: 'u1', status: 'CANCELED' }));
  const env = srodowisko(w);
  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_FAKTURY);

  // Aktywne drugie zamówienie tej umowy (format m/umowa) nadal blokuje.
  w.dodatkoweKlucze.set('aktywne', zamowienie({ id: 'ord-akt', numer: 2, contactId: ANNA, umowaId: 'u1', externalOrderId: '2026-11/u1' }));
  const p2 = await env.proces.podglad();
  assert.equal(kat(p2, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.match(p2.doRecznejDecyzji[0].powod, /ord-akt/);
});

test('Dane: cykl DONE z anulowanym zamówieniem — do sprawdzenia, nie ciche wykluczenie', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', status: 'CANCELED' }] }
  ]);
  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.match(p.doRecznejDecyzji[0].powod, /DONE/);
  assert.equal(p.sumy.anulowane, '0.00');
  assert.equal(p.sumy.doSprawdzenia, '640.00');
});

test('Dane: daty w opisie tylko, gdy odczytane ze wszystkich pozycji', async () => {
  const w = swiat([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }, { umowaId: 'u2', cena: 180 }] }
  ]);
  w.orders.get('ord-u2').lineItems[0].descriptionLines = [{ plainText: { original: 'Nov 3, 2026, 3:00 PM / 50 min' } }];
  const env = srodowisko(w);
  const [plan] = (await env.proces.podglad()).proponowaneFaktury;
  assert.match(plan.pozycje[0].opis, /\(03\.11, 10\.11, 17\.11, 24\.11\)/);
  assert.doesNotMatch(plan.pozycje[1].opis, /\(/);
});

test('Dane: zamówienie PAID na 0 zł (stawka 0) — ZEROWE, nie do sprawdzenia', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 0, paymentStatus: 'PAID' }] }
  ]);
  assert.equal(kat(await env.proces.podglad(), 'ord-u1'), K.ZEROWE);
});

test('Dane: rabat merchantDiscount bez groszy ("160") rozłożony na pozycje', () => {
  const raw = zamowienie({ id: 'o', numer: 1, contactId: 'c', umowaId: 'u', rabaty: [{ id: 'd', kwota: 160 }] });
  raw.appliedDiscounts[0].merchantDiscount.amount = { amount: '160' };
  raw.appliedDiscounts[0].lineItemDiscounts = raw.lineItems.map(l => ({ id: l._id, totalDiscount: { amount: '40.00' } }));
  raw.lineItems.forEach(l => { l.totalDiscount = { amount: '40.00' }; });
  const o = normalizujZamowienie(raw);
  assert.deepEqual(o.problemy, []);
  assert.equal(o.rabat, 16000);
  assert.equal(o.razem, 48000);
});

test('PROBE: struktura faktury bez danych osobowych i bez zapisów', async () => {
  const env = jedenKlient();
  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);
  const przed = env.db.zapisy;
  const r = await env.proces.sonda();
  assert.equal(r.status, 'OK');
  assert.equal(r.zrodlo, 'dziennik 2026-11');
  assert.deepEqual(r.brakujaceDlaKontroli, []);
  assert.ok(r.customerKlucze.includes('email'));
  assert.ok(!JSON.stringify(r).includes('a@x.pl'), 'brak danych osobowych');
  assert.equal(env.db.zapisy, przed);

  const s = strukturaFaktury({ id: { id: 'x', version: 2 }, lineItems: [{ name: 'A', price: 1, quantity: 1 }], totals: { total: 1 } });
  assert.deepEqual(s.brakujaceDlaKontroli.sort(), ['currency', 'customer.contactId', 'metadata.sourceRefId', 'wasSent']);
});
