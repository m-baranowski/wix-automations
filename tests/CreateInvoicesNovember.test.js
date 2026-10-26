// Testy CreateInvoicesNovember.js — wyłącznie atrapy API Wix.
// Żadne wywołanie nie wychodzi poza proces; nie powstają prawdziwe faktury.
// Uruchomienie: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { _test } from '../CreateInvoicesNovember.js';

const {
  CFG, K, S, LOCK_ID,
  grosze, kluczZgodny, normalizujZamowienie, zbudujPlan, operationId,
  polaFaktury, sprawdzFakture, strukturaFaktury, wyciagnijKontakt,
  createJournal, createProcess
} = _test;

// ======================================================
// ATRAPY
// ======================================================

const MIESIAC = '2026-11';
const APP = CFG.appIdRezerwacji;
const money = c => ({ amount: (c / 100).toFixed(2) });
const kopia = x => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

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


function srodowisko(spec) {
  const w = Array.isArray(spec) ? swiat(spec) : spec;
  const db = bazaDanych();
  const inv = fakturyWix();

  db.kolekcje.set(CFG.cykle, new Map(w.rows.map(r => [r._id, r])));

  const gateway = {
    awariaApi: {},
    wierszeCykli: () => db.find(CFG.cykle, { miesiac: MIESIAC }),
    umowy: async ids => new Map(ids.filter(id => w.umowy.has(id)).map(id => [id, kopia(w.umowy.get(id))])),
    zamowienia: async ids => new Map(ids.map(id =>
      [id, w.orders.has(id) ? { raw: kopia(w.orders.get(id)) } : { error: 'getOrder: NOT_FOUND' }])),
    indeksKluczy: async klucze => {
      if (gateway.awariaApi.indeks) return null;
      const m = new Map();
      for (const o of [...w.orders.values(), ...w.dodatkoweKlucze.values()]) {
        const k = o.channelInfo?.externalOrderId;
        if (klucze.includes(k)) m.set(k, [...(m.get(k) || []), { id: o._id, status: o.status }]);
      }
      return m;
    },
    fakturyZamowien: async ids => gateway.awariaApi.faktury ? null
      : new Map(ids.map(id => [id, kopia(w.fakturyWix.get(id) || [])])),
    transakcje: async ids => gateway.awariaApi.transakcje ? null
      : new Map(ids.map(id => [id, kopia(w.transakcje.get(id) || { payments: [], refunds: [] })])),
    kontakt: async id => {
      if (!w.kontakty.has(id)) throw new Error('contact not found');
      return kopia(w.kontakty.get(id));
    },
    utworzFakture: pola => inv.createInvoice(pola),
    pobierzFakture: id => inv.getInvoice(id),
    wyslijFakture: (id, version, email) => inv.sendInvoice({ id, version }, email)
  };

  const cicho = { log() {}, warn() {}, error() {} };
  const journal = createJournal(db);
  const proces = createProcess({ gateway, journal, log: cicho });
  return { w, db, inv, gateway, journal, proces };
}

// Opcje RUN zgodne z bieżącym PREVIEW (jak administrator).
async function opcjeZPodgladu(env, extra = {}) {
  const p = await env.proces.podglad();
  return {
    oczekiwanaLiczba: p.doZatwierdzenia.liczba,
    oczekiwanaSuma: p.doZatwierdzenia.suma,
    sprawdzilemPanelFaktur: true,
    kto: 'Administrator testowy',
    akceptujBraki: p.braki,
    maxFaktur: 5,
    etap: 'OBA',
    ...extra
  };
}

async function run(env, extra = {}) {
  return env.proces.wykonaj(await opcjeZPodgladu(env, extra));
}

async function wykonajWszystko(env, extra = {}) {
  const wyniki = [];
  for (let i = 0; i < 30; i++) {
    const r = await run(env, extra);
    wyniki.push(r);
    if (r.status !== 'OK' || !r.wyniki.length || r.zatrzymano) break;
  }
  return wyniki;
}

const zwolnijBlokade = env => env.db.remove(CFG.blokady, LOCK_ID);
const operacje = env => [...env.db.kolekcje.get(CFG.dziennik).values()].filter(x => x.rodzaj === 'FAKTURA');

const ANNA = 'c-anna';
const BEATA = 'c-beata';
const kat = (p, orderId) => p.tabela.find(w => w.orderId === orderId)?.kategoria;
const faktury = env => [...env.inv.faktury.values()];
const sumaFaktur = env => faktury(env).reduce((s, f) => s + Math.round(f.totals.total * 100), 0);
const jedenKlient = (umowy = [{ umowaId: 'u1' }]) =>
  srodowisko([{ contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy }]);

// ======================================================
// TESTY JEDNOSTKOWE
// ======================================================

test('grosze: kwoty Wix, typy, zakres', () => {
  assert.equal(grosze('160.00'), 16000);
  assert.equal(grosze('160'), 16000);
  assert.equal(grosze({ amount: '53.33' }), 5333);
  assert.equal(grosze(0.1 + 0.2), 30);
  assert.equal(grosze(undefined), 0);
  assert.equal(grosze(' 12.50 '), 1250);
  assert.throws(() => grosze('1.005'), /2 miejscami/);
  assert.throws(() => grosze(true), /Nieprawidłowa/);
  assert.throws(() => grosze('1e3'), /Nieprawidłowa/);
  assert.throws(() => grosze(1e20), /zakresem/);
});

test('normalizacja: rabat merchantDiscount i uzgodnienie sum', () => {
  const o = normalizujZamowienie(zamowienie({ id: 'o1', numer: 1, contactId: 'c', umowaId: 'u', rabaty: [{ id: 'd1', kwota: 160 }] }));
  assert.equal(o.brutto, 64000);
  assert.equal(o.rabat, 16000);
  assert.equal(o.razem, 48000);
  assert.deepEqual(o.problemy, []);
});

test('normalizacja: rabat "160" rozłożony na pozycje (format z witryny)', () => {
  const raw = zamowienie({ id: 'o', numer: 1, contactId: 'c', umowaId: 'u', rabaty: [{ id: 'd', kwota: 160 }] });
  raw.appliedDiscounts[0].merchantDiscount.amount = { amount: '160' };
  raw.lineItems.forEach(l => { l.totalDiscount = { amount: '40.00' }; });
  assert.deepEqual(normalizujZamowienie(raw).problemy, []);
});

test('normalizacja: niezgodny rabat, podatek — problemy', () => {
  const a = zamowienie({ id: 'o1', numer: 1, contactId: 'c', umowaId: 'u', rabaty: [{ kwota: 160 }] });
  a.priceSummary.discount = { amount: '100.00' };
  assert.ok(normalizujZamowienie(a).problemy.some(p => /Suma rabatów/.test(p)));
  const b = zamowienie({ id: 'o1', numer: 1, contactId: 'c', umowaId: 'u' });
  b.priceSummary.tax = { amount: '10.00' };
  assert.ok(normalizujZamowienie(b).problemy.length > 0);
});

test('R3: brak ceny, subtotal, total lub pozycji — wyjątek, nie zero', () => {
  const bezCeny = zamowienie({ id: 'o', numer: 1, contactId: 'c', umowaId: 'u' });
  delete bezCeny.lineItems[0].price;
  assert.throws(() => normalizujZamowienie(bezCeny), /cena pozycji/);
  const bezTotal = zamowienie({ id: 'o', numer: 1, contactId: 'c', umowaId: 'u' });
  delete bezTotal.priceSummary.total;
  assert.throws(() => normalizujZamowienie(bezTotal), /total/);
  const bezPozycji = zamowienie({ id: 'o', numer: 1, contactId: 'c', umowaId: 'u' });
  bezPozycji.lineItems = [];
  assert.throws(() => normalizujZamowienie(bezPozycji), /bez pozycji/);
});

test('plan: przykład z zadania — 4×160 + 4×180 = 1360 zł, dwie pozycje', () => {
  const a = normalizujZamowienie(zamowienie({ id: 'a', numer: 1, contactId: 'c', umowaId: 'u1', cena: 160 }));
  const b = normalizujZamowienie(zamowienie({ id: 'b', numer: 2, contactId: 'c', umowaId: 'u2', cena: 180, usluga: 'Terapia neurologopedyczna' }));
  const p = zbudujPlan('c', [b, a]);
  assert.equal(p.razem, 136000);
  assert.deepEqual(p.pozycje.map(x => [x.nazwa, x.ilosc, x.cena]), [['Terapia logopedyczna', 4, 16000], ['Terapia neurologopedyczna', 4, 18000]]);
  assert.deepEqual(p.orderIds, ['a', 'b']);
});

test('plan: nie łączy kontaktów; identyfikator niezależny od kolejności', () => {
  const a = normalizujZamowienie(zamowienie({ id: 'a', numer: 1, contactId: 'c1', umowaId: 'u1' }));
  const b = normalizujZamowienie(zamowienie({ id: 'b', numer: 2, contactId: 'c2', umowaId: 'u2' }));
  assert.throws(() => zbudujPlan('c1', [a, b]), /innego kontaktu/);
  assert.equal(operationId(MIESIAC, 'c', ['b', 'a']), operationId(MIESIAC, 'c', ['a', 'b']));
  assert.notEqual(operationId(MIESIAC, 'c', ['a']), operationId(MIESIAC, 'c', ['a', 'b']));
});

test('pola faktury: PLN, tytuł, termin 5 dni, ujemny rabat, sourceRefId', () => {
  const a = normalizujZamowienie(zamowienie({ id: 'a', numer: 7, contactId: 'c', umowaId: 'u1', rabaty: [{ kwota: 53.33 }] }));
  const plan = zbudujPlan('c', [a]);
  const teraz = new Date('2026-12-01T09:00:00Z');
  const pola = polaFaktury(plan, { contactId: 'c', email: 'x@y.pl', fullName: 'A B', phone: '48600' }, teraz);
  assert.equal(pola.title, 'Listopad 2026');
  assert.equal(pola.currency, 'PLN');
  assert.equal(pola.customer.phone, '48600');
  assert.deepEqual(pola.lineItems.map(l => l.price), [160, -53.33]);
  assert.equal(pola.dates.dueDate.toISOString(), '2026-12-06T09:00:00.000Z');
  assert.equal(pola.metadata.sourceRefId, plan.operationId);
  assert.throws(() => polaFaktury(plan, { contactId: 'inny', email: 'x' }, teraz), /Kontakt/);
  assert.throws(() => polaFaktury(plan, { contactId: 'c', email: '' }, teraz), /e-mail/);
});

test('kontakt: e-mail, telefon, fullName', () => {
  const k = wyciagnijKontakt({ _id: 'c', info: { name: { first: 'Anna', last: 'Nowak' }, emails: { items: [{ email: 'a@x.pl' }] }, phones: { items: [{ phone: '48600' }] } } });
  assert.deepEqual(k, { contactId: 'c', firstName: 'Anna', lastName: 'Nowak', fullName: 'Anna Nowak', email: 'a@x.pl', phone: '48600' });
});

test('klucze zamówień z witryny: znane formaty tak, obce nie', () => {
  for (const ok of ['TOTO:2026-11:u1', '2026-11/u1', 'TOTO:2026-11:u1:repair1', 'TOTO:2026-11:u1/restore2', '', undefined]) {
    assert.equal(kluczZgodny(ok, MIESIAC, 'u1'), true, String(ok));
  }
  for (const zle of ['TOTO:2026-10:u1', 'TOTO:2026-11:u2', '2026-11/u2', 'TOTO:2026-11:u1:repairX', 'TOTO:2026-11:u1x']) {
    assert.equal(kluczZgodny(zle, MIESIAC, 'u1'), false, zle);
  }
});

// R2: kontrola treści faktury przed wysyłką
const opPlan = {
  _id: 'op', invoiceId: 'i', klientContactId: 'c', kwotaGrosze: 48000, rabatFaktury: 0,
  pozycje: [{ nazwa: 'Terapia logopedyczna', cena: 16000, ilosc: 4 }, { nazwa: 'Rabat', cena: -16000, ilosc: 1 }]
};
const fakturaZgodna = () => ({
  id: { id: 'i', version: 2 }, currency: 'PLN', customer: { contactId: 'c' },
  metadata: { sourceRefId: 'op' }, totals: { total: 480 },
  lineItems: [{ name: 'Terapia logopedyczna', price: 160, quantity: 4 }, { name: 'Rabat', price: -160, quantity: 1 }]
});

test('R2: zgodna faktura przechodzi; zmiany treści przy tej samej sumie — nie', () => {
  assert.deepEqual(sprawdzFakture(fakturaZgodna(), opPlan), []);

  const rabat = fakturaZgodna();
  rabat.lineItems = [{ name: 'Terapia logopedyczna', price: 160, quantity: 3 }, { name: 'Rabat', price: 0, quantity: 1 }];
  assert.ok(sprawdzFakture(rabat, opPlan).some(x => /ilość/.test(x)));

  const usluga = fakturaZgodna();
  usluga.lineItems[0] = { name: 'Inna usługa', price: 640, quantity: 1 };
  assert.ok(sprawdzFakture(usluga, opPlan).some(x => /nazwa/.test(x)));
});

test('R2: brak waluty, sourceRefId, inny kontakt, rabat faktury — odrzucone', () => {
  const f1 = fakturaZgodna(); delete f1.currency;
  const f2 = fakturaZgodna(); delete f2.metadata;
  const f3 = fakturaZgodna(); f3.customer.contactId = 'x';
  const f4 = fakturaZgodna(); f4.discount = { value: 10, type: 'Fixed' };
  const f5 = fakturaZgodna(); f5.totals.total = 400;
  for (const f of [f1, f2, f3, f4, f5]) assert.ok(sprawdzFakture(f, opPlan).length > 0);
});

test('PROBE: struktura bez danych osobowych', () => {
  const s = strukturaFaktury({ id: { id: 'x', version: 2 }, lineItems: [{ name: 'A', price: 1, quantity: 1 }], totals: { total: 1 } });
  assert.deepEqual(s.brakujaceDlaKontroli.sort(), ['currency', 'customer.contactId', 'metadata.sourceRefId', 'wasSent']);
});

// ======================================================
// SCENARIUSZE 1–18
// ======================================================

test('1. jedno zamówienie bez rabatu', async () => {
  const env = jedenKlient([{ umowaId: 'u1', cena: 160, wizyty: 4 }]);
  const p = await env.proces.podglad();
  assert.equal(p.proponowaneFaktury[0].razem, '640.00');
  assert.equal(p.kontroleOk, true);

  await wykonajWszystko(env);
  const [f] = faktury(env);
  assert.equal(f.title, 'Listopad 2026');
  assert.equal(f.currency, 'PLN');
  assert.equal(f.totals.total, 640);
  assert.deepEqual([f.lineItems[0].quantity, f.lineItems[0].price], [4, 160]);
  assert.equal(f.wasSent, true);
  assert.equal(new Date(f.dates.dueDate) - new Date(f.dates.issueDate), 5 * 86400000);
});

test('2. dwa zamówienia jednego klienta — jedna faktura, dwie pozycje, pełne powiązanie', async () => {
  const env = srodowisko([{ contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', telefon: '48600100200', umowy: [
    { umowaId: 'u1', cena: 160 }, { umowaId: 'u2', usluga: 'Terapia neurologopedyczna', cena: 180 }] }]);
  await wykonajWszystko(env);
  const all = faktury(env);
  assert.equal(all.length, 1);
  assert.equal(all[0].lineItems.length, 2);
  assert.equal(all[0].totals.total, 1360);
  assert.equal(all[0].customer.phone, '48600100200');
  const [op] = operacje(env);
  assert.deepEqual(op.orderIds, ['ord-u1', 'ord-u2']);
  assert.equal(op.status, S.SENT);
  assert.equal(op.invoiceId, all[0].id.id);
  assert.ok(op.invoiceVersion >= 1);
});

test('3. dwa zamówienia z osobnymi rabatami — każdy rabat raz', async () => {
  const env = jedenKlient([{ umowaId: 'u1', cena: 160, rabaty: [{ id: 'r1', kwota: 160 }] }, { umowaId: 'u2', cena: 180, rabaty: [{ id: 'r2', kwota: 180 }] }]);
  const p = await env.proces.podglad();
  assert.deepEqual([p.sumy.brutto, p.sumy.rabaty, p.sumy.netto], ['1360.00', '340.00', '1020.00']);
  assert.deepEqual(p.proponowaneFaktury[0].pozycje.filter(x => Number(x.cena) < 0).map(x => x.cena).sort(), ['-160.00', '-180.00']);
  await wykonajWszystko(env);
  assert.equal(faktury(env)[0].totals.total, 1020);
});

test('4. rabat równy cenie wizyty — liczba wizyt bez zmian', async () => {
  const [plan] = (await jedenKlient([{ umowaId: 'u1', rabaty: [{ kwota: 160 }] }]).proces.podglad()).proponowaneFaktury;
  assert.equal(plan.pozycje[0].ilosc, 4);
  assert.equal(plan.pozycje[1].cena, '-160.00');
  assert.equal(plan.razem, '480.00');
});

test('5. rabat niepodzielny przez cenę wizyty', async () => {
  const env = jedenKlient([{ umowaId: 'u1', rabaty: [{ kwota: 53.33 }] }]);
  await wykonajWszystko(env);
  assert.equal(faktury(env)[0].totals.total, 586.67);
});

test('6. jedno zamówienie opłacone z fakturą, drugie nie', async () => {
  const env = jedenKlient([
    { umowaId: 'u1', paymentStatus: 'PAID', zaplacono: 640, fakturyWix: [{ id: 'old', appId: 'x' }], platnosci: [{ _id: 'p1' }] },
    { umowaId: 'u2', cena: 180 }]);
  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.ROZLICZONE);
  assert.deepEqual([p.sumy.juzRozliczone, p.sumy.doNowychFaktur], ['640.00', '720.00']);
  assert.deepEqual(p.proponowaneFaktury[0].orderIds, ['ord-u2']);
});

test('7. PAID bez potwierdzonej faktury — ręczna decyzja', async () => {
  const p = await jedenKlient([{ umowaId: 'u1', paymentStatus: 'PAID', zaplacono: 640 }, { umowaId: 'u2' }]).proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.equal(p.sumy.doSprawdzenia, '640.00');
  assert.deepEqual(p.proponowaneFaktury[0].orderIds, ['ord-u2']);
});

test('8. zafakturowane, ale NOT_PAID — bez drugiej faktury (Wix i dziennik)', async () => {
  const p = await jedenKlient([{ umowaId: 'u1', fakturyWix: [{ id: 'inv-old' }] }]).proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.ROZLICZONE);
  assert.equal(p.proponowaneFaktury.length, 0);

  const env = jedenKlient();
  await wykonajWszystko(env);
  const p2 = await env.proces.podglad();
  assert.equal(kat(p2, 'ord-u1'), K.ROZLICZONE);
  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 1);
});

test('9. częściowo opłacone — ręczna decyzja', async () => {
  const p = await jedenKlient([{ umowaId: 'u1', paymentStatus: 'PARTIALLY_PAID', zaplacono: 320, platnosci: [{}] }]).proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.match(p.doRecznejDecyzji[0].powod, /Częściowo/);
});

test('10. zamówienie i cykl anulowane — wykluczone, kwota widoczna', async () => {
  const p = await jedenKlient([{ umowaId: 'u1', status: 'CANCELED', statusCyklu: 'CANCELED' }]).proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.ANULOWANE);
  assert.equal(p.sumy.anulowane, '640.00');
  assert.equal(p.kontrole.rozbicieZgodne, true);
});

test('10b. cykl DONE z anulowanym zamówieniem — do sprawdzenia', async () => {
  const p = await jedenKlient([{ umowaId: 'u1', status: 'CANCELED' }]).proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.equal(p.sumy.doSprawdzenia, '640.00');
});

test('11. różne kontakty o tym samym nazwisku i e-mailu — osobne faktury', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'n@x.pl', umowy: [{ umowaId: 'u1' }] },
    { contactId: 'c-anna-2', nazwa: 'Anna Nowak', email: 'n@x.pl', umowy: [{ umowaId: 'u2' }] }]);
  const p = await env.proces.podglad();
  assert.equal(p.proponowaneFaktury.length, 2);
  assert.ok(p.ostrzezenia.some(o => /różnych kontaktów/.test(o)));
  assert.ok(p.ostrzezenia.some(o => /E-mail/.test(o)));
  await wykonajWszystko(env);
  assert.deepEqual(faktury(env).map(f => f.customer.contactId).sort(), [ANNA, 'c-anna-2']);
});

test('12. ponowny RUN po utworzeniu części faktur', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] },
    { contactId: BEATA, nazwa: 'Beata Kowal', email: 'b@x.pl', umowy: [{ umowaId: 'u2' }] },
    { contactId: 'c-c', nazwa: 'Cezary Lis', email: 'c@x.pl', umowy: [{ umowaId: 'u3' }] }]);
  const r1 = await run(env, { maxFaktur: 1, etap: 'UTWORZ' });
  assert.equal(r1.wyniki[0].status, S.CREATED);
  assert.equal(r1.pozostaloDoUtworzenia, 2);
  assert.equal(r1.pozostaloDoWyslania, 1);
  await wykonajWszystko(env);
  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 3);
  assert.equal(env.inv.wysylki, 3);
  assert.deepEqual((await env.proces.status()).statusy, { SENT: 3 });
});

test('13. awaria po createInvoice() — bez drugiej faktury, ręczne przypięcie', async () => {
  const env = jedenKlient();
  env.db.awaria = (op, c, item) => op === 'update' && item.status === S.CREATED;
  await assert.rejects(run(env), /Niepotwierdzony zapis/);
  env.db.awaria = null;
  assert.equal(env.inv.utworzenia, 1);
  await zwolnijBlokade(env);

  const r = await run(env);
  assert.ok(r.uporzadkowane[0].endsWith(S.NEEDS_REVIEW));
  assert.equal(env.inv.utworzenia, 1);
  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 1);
  assert.equal(kat(await env.proces.podglad(), 'ord-u1'), K.DO_SPRAWDZENIA);

  // Ręcznie w CMS: faktura jest → invoiceId + CREATED; RUN sprawdza treść i wysyła.
  const [op] = operacje(env);
  Object.assign(op, { invoiceId: 'inv-1', status: S.CREATED });
  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 1);
  assert.equal(env.inv.wysylki, 1);
});

test('13b. createInvoice odrzucony — NEEDS_REVIEW, partia zatrzymana; ręcznie APPROVED → ponowienie', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] },
    { contactId: BEATA, nazwa: 'Beata Kowal', email: 'b@x.pl', umowy: [{ umowaId: 'u2' }] }]);
  env.inv.awariaTworzenia = 'przed';
  const r = await run(env);
  assert.match(r.zatrzymano, /CREATE_UNCERTAIN/);
  assert.equal(r.wyniki.length, 1);
  env.inv.awariaTworzenia = null;

  operacje(env).find(o => o.status === S.NEEDS_REVIEW).status = S.APPROVED;
  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 2);
  assert.equal(env.inv.wysylki, 2);
});

test('14. awaria po sendInvoice() — bez ponownej wysyłki (jeden SMS)', async () => {
  const env = jedenKlient();
  env.db.awaria = (op, c, item) => op === 'update' && item.status === S.SENT;
  await assert.rejects(run(env), /Niepotwierdzony zapis/);
  env.db.awaria = null;
  await zwolnijBlokade(env);
  const r = await run(env);
  assert.ok(r.uporzadkowane[0].endsWith(S.SENT));
  assert.equal(env.inv.wysylki, 1);
});

test('14b. sendInvoice błąd i wasSent = false — NEEDS_REVIEW, bez ponowienia', async () => {
  const env = jedenKlient();
  env.inv.awariaWysylki = 'przed';
  const r = await run(env);
  assert.equal(r.wyniki[0].powod, 'SEND_UNCERTAIN');
  env.inv.awariaWysylki = null;
  await wykonajWszystko(env);
  assert.equal(env.inv.wysylki, 0);
  operacje(env)[0].status = S.CREATED; // ręcznie: nie dotarła
  await wykonajWszystko(env);
  assert.equal(env.inv.wysylki, 1);
});

test('15. dwa równoległe uruchomienia — jedno BUSY, bez duplikatów', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] },
    { contactId: BEATA, nazwa: 'Beata Kowal', email: 'b@x.pl', umowy: [{ umowaId: 'u2' }] }]);
  const o = await opcjeZPodgladu(env);
  const [a, b] = await Promise.all([env.proces.wykonaj(o), env.proces.wykonaj(o)]);
  assert.equal([a, b].filter(r => r.status === 'BUSY').length, 1);
  assert.equal(env.inv.utworzenia, 2);
  assert.equal(env.inv.wysylki, 2);
});

test('15b. stara blokada — BUSY z instrukcją, bez przejęcia', async () => {
  const env = jedenKlient();
  await env.db.insert(CFG.blokady, { _id: LOCK_ID, token: 'x' });
  env.db.kolekcje.get(CFG.blokady).get(LOCK_ID)._createdDate = '2026-01-01T00:00:00Z';
  const r = await run(env);
  assert.equal(r.status, 'BUSY');
  assert.match(r.blad, /starsza niż 5 min/);
  assert.equal(env.inv.utworzenia, 0);
});

test('16. rabat obniżający zamówienie do zera', async () => {
  const p = await jedenKlient([{ umowaId: 'u1', wizyty: 1, rabaty: [{ kwota: 160 }] }, { umowaId: 'u2', cena: 180 }]).proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.ZEROWE);
  assert.equal(p.sumy.rabaty, '160.00');
  assert.deepEqual(p.proponowaneFaktury[0].orderIds, ['ord-u2']);
  assert.equal(p.kontroleOk, true);
});

test('17. różne usługi, identyczna cena — osobne pozycje', async () => {
  const env = jedenKlient([{ umowaId: 'u1', usluga: 'Terapia logopedyczna' }, { umowaId: 'u2', usluga: 'Terapia integracji sensorycznej', wizyty: 3 }]);
  await wykonajWszystko(env);
  assert.deepEqual(faktury(env)[0].lineItems.map(l => [l.name, l.quantity, l.price]),
    [['Terapia logopedyczna', 4, 160], ['Terapia integracji sensorycznej', 3, 160]]);
});

test('18. suma nowych faktur = rozliczenie zamówień źródłowych', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', rabaty: [{ kwota: 160 }] }, { umowaId: 'u2', cena: 180, wizyty: 5, rabaty: [{ kwota: 90.5 }] }] },
    { contactId: BEATA, nazwa: 'Beata Kowal', email: 'b@x.pl', umowy: [{ umowaId: 'u3', cena: 150, wizyty: 3 }] },
    { contactId: 'c-c', nazwa: 'Cezary Lis', email: 'c@x.pl', umowy: [{ umowaId: 'u4', paymentStatus: 'PAID', zaplacono: 640 }] },
    { contactId: 'c-d', nazwa: 'Dorota Lis', email: 'd@x.pl', umowy: [{ umowaId: 'u5', status: 'CANCELED', statusCyklu: 'CANCELED' }] },
    { contactId: 'c-e', nazwa: 'Ewa Lis', email: 'e@x.pl', umowy: [{ umowaId: 'u6', fakturyWix: [{ id: 'i' }] }] }]);
  const p = await env.proces.podglad();
  assert.equal(p.kontroleOk, true);
  assert.deepEqual([p.sumy.brutto, p.sumy.rabaty, p.sumy.netto], ['3910.00', '250.50', '3659.50']);
  assert.deepEqual([p.sumy.doNowychFaktur, p.sumy.doSprawdzenia, p.sumy.anulowane, p.sumy.juzRozliczone], ['1739.50', '640.00', '640.00', '640.00']);
  assert.deepEqual(p.doZatwierdzenia, { liczba: 2, suma: '1739.50' });

  await wykonajWszystko(env);
  assert.equal(sumaFaktur(env), 173950);
  const po = await env.proces.podglad();
  assert.deepEqual([po.sumy.juzRozliczone, po.sumy.doNowychFaktur, po.sumy.netto], ['2379.50', '0.00', p.sumy.netto]);
  assert.deepEqual(po.doZatwierdzenia, p.doZatwierdzenia, 'liczba i suma stałe między RUN');
});

// ======================================================
// BRAMKA RUN, ZMIANY DANYCH, KOMPLETNOŚĆ (R1, R4)
// ======================================================

test('PREVIEW nie zapisuje niczego i nie tworzy faktur', async () => {
  const env = jedenKlient([{ umowaId: 'u1' }, { umowaId: 'u2' }]);
  const przed = env.db.zapisy;
  await env.proces.podglad();
  assert.equal(env.db.zapisy, przed);
  assert.equal(env.inv.utworzenia, 0);
});

test('R1/bramka: RUN wymaga zgodnej liczby, sumy i potwierdzenia panelu Faktury', async () => {
  const env = jedenKlient();
  const ok = await opcjeZPodgladu(env);
  for (const zle of [
    { oczekiwanaSuma: '600.00' },
    { oczekiwanaLiczba: 2 },
    { sprawdzilemPanelFaktur: false },
    { kto: ' ' }
  ]) {
    const r = await env.proces.wykonaj({ ...ok, ...zle });
    assert.equal(r.status, 'ODMOWA', JSON.stringify(zle));
  }
  assert.equal(env.inv.utworzenia, 0);
  assert.equal(operacje(env).length, 0);
  await env.proces.wykonaj(ok);
  assert.equal(operacje(env)[0].audyt.kto, 'Administrator testowy');
});

test('R1: wpis dziennika za listopad spoza modelu — klient do sprawdzenia; bez kontaktu — brak', async () => {
  const env = jedenKlient();
  await env.db.insert(CFG.dziennik, { _id: 'legacy-1', miesiac: MIESIAC, klientContactId: ANNA, status: 'WYSLANA' });
  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.match(p.doRecznejDecyzji[0].powod, /legacy-1/);

  const env2 = jedenKlient();
  await env2.db.insert(CFG.dziennik, { _id: 'legacy-2', miesiac: MIESIAC, status: 'TWORZENIE' });
  const p2 = await env2.proces.podglad();
  assert.deepEqual(p2.braki, ['legacy-2']);
  assert.equal(p2.kontroleOk, false);
  assert.equal((await run(env2, { akceptujBraki: [] })).status, 'ODMOWA');
  assert.equal((await run(env2)).status, 'OK');
});

test('R4: duplikat orderId liczony raz, cykl bez zamówienia, nieznana kwota — braki wymagają akceptacji', async () => {
  const env = jedenKlient([{ umowaId: 'u1' }, { umowaId: 'u2' }, { umowaId: 'u3' }, { umowaId: 'u4' }]);
  const cykle = env.db.kolekcje.get(CFG.cykle);
  cykle.set('dup', { ...cykle.get('um-u1'), _id: 'dup', umowaId: 'u1-dup' });
  Object.assign(cykle.get('um-u2'), { orderId: '', status: 'RUNNING' });
  env.w.orders.delete('ord-u3');
  cykle.get('um-u3').kwota = 0;

  const p = await env.proces.podglad();
  assert.deepEqual(p.braki, ['ord-u1', 'ord-u3', 'u2']);
  assert.equal(p.sumy.nieznanychKwot, 1);
  assert.equal(p.tabela.find(x => x.orderId === 'ord-u3').netto, 'NIEZNANA');
  assert.equal(p.arytmetykaOk, true);
  assert.equal(p.kontroleOk, false);
  assert.equal((await run(env, { akceptujBraki: ['ord-u3'] })).status, 'ODMOWA');

  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 1, 'tylko jasne zamówienie u4');
  assert.equal(faktury(env)[0].totals.total, 640);
});

test('zmiana zamówienia po zaplanowaniu — operacja anulowana przed createInvoice', async () => {
  const env = jedenKlient();
  const o = await opcjeZPodgladu(env, { maxFaktur: 1 });
  // Awaria po zapisaniu PREPARED/APPROVED, przed createInvoice.
  env.inv.awariaTworzenia = 'przed';
  env.db.awaria = (op, c, item) => op === 'update' && item.status === S.CREATING;
  await assert.rejects(env.proces.wykonaj(o));
  env.db.awaria = null;
  env.inv.awariaTworzenia = null;
  await zwolnijBlokade(env);
  assert.equal(operacje(env)[0].status, S.APPROVED);

  // Klient zapłacił w międzyczasie.
  const z = env.w.orders.get('ord-u1');
  z.paymentStatus = 'PAID';
  z.balanceSummary.paid = { amount: '640.00' };

  const r = await env.proces.wykonaj({ ...o, akceptujBraki: [] });
  assert.equal(r.wyniki[0].status, S.CANCELLED);
  assert.equal(env.inv.utworzenia, 0);
  assert.equal(kat(await env.proces.podglad(), 'ord-u1'), K.DO_SPRAWDZENIA);
});

test('awaria między PREPARED a przypisaniami — kolejny RUN kończy przygotowanie bez duplikatu', async () => {
  const env = srodowisko([{ contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }, { umowaId: 'u2' }] }]);
  let wstawienia = 0;
  env.db.awaria = (op, c, item) => op === 'insert' && item.rodzaj === 'ZAMOWIENIE' && ++wstawienia === 2;
  await assert.rejects(run(env));
  env.db.awaria = null;
  await zwolnijBlokade(env);
  assert.equal(operacje(env)[0].status, S.PREPARED);

  const p = await env.proces.podglad();
  assert.deepEqual(p.doZatwierdzenia.liczba, 1, 'PREPARED nie jest liczona podwójnie');
  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 1);
  assert.equal(faktury(env)[0].totals.total, 1280);
});

test('niepotwierdzone API faktur zamówień — RUN odmawia', async () => {
  const env = jedenKlient();
  env.gateway.awariaApi.faktury = true;
  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.equal((await run(env)).status, 'ODMOWA');
});

test('R2: faktura zmieniona między utworzeniem a wysyłką — bez wysyłki', async () => {
  const env = jedenKlient();
  await run(env, { etap: 'UTWORZ' });
  env.inv.faktury.get('inv-1').lineItems[0].name = 'Inna usługa';
  const r = await run(env, { etap: 'WYSLIJ' });
  assert.equal(r.wyniki[0].powod, 'INVOICE_MISMATCH');
  assert.equal(env.inv.wysylki, 0);
});

test('tryb RABAT_FAKTURY — rabat kwotowy zamiast ujemnych pozycji', async () => {
  CFG.rabatJako = 'RABAT_FAKTURY';
  try {
    const env = jedenKlient([{ umowaId: 'u1', rabaty: [{ kwota: 160 }] }, { umowaId: 'u2', cena: 180, rabaty: [{ kwota: 180 }] }]);
    env.inv.odrzucUjemne = true;
    await wykonajWszystko(env);
    const [f] = faktury(env);
    assert.equal(f.lineItems.length, 2);
    assert.deepEqual(f.discount, { value: 340, type: 'Fixed' });
    assert.equal(f.totals.total, 1020);
    assert.equal(env.inv.wysylki, 1);
  } finally {
    CFG.rabatJako = 'POZYCJA';
  }
});

test('Wix odrzuca ujemne pozycje — NEEDS_REVIEW i zatrzymanie', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', rabaty: [{ kwota: 160 }] }] },
    { contactId: BEATA, nazwa: 'Beata Kowal', email: 'b@x.pl', umowy: [{ umowaId: 'u2', rabaty: [{ kwota: 160 }] }] }]);
  env.inv.odrzucUjemne = true;
  const r = await run(env);
  assert.equal(r.wyniki.length, 1);
  assert.ok(r.zatrzymano);
  assert.equal(env.inv.utworzenia, 0);
});

// ======================================================
// REGUŁY Z ODCZYTU DANYCH WITRYNY
// ======================================================

test('dane: klucz m/umowa i brak klucza — do faktury przy zgodnych wizytach', async () => {
  const w = swiat([{ contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', externalOrderId: '2026-11/u1' }, { umowaId: 'u2', cena: 180 }] }]);
  w.orders.get('ord-u2').channelInfo = {};
  const p = await srodowisko(w).proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_FAKTURY);
  assert.equal(kat(p, 'ord-u2'), K.DO_FAKTURY);
  assert.equal(p.tabela.find(x => x.orderId === 'ord-u2').klucz, '(brak)');

  const w2 = swiat([{ contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }]);
  w2.orders.get('ord-u1').channelInfo = {};
  w2.orders.get('ord-u1').lineItems[0].catalogReference.catalogItemId = 'obca';
  assert.equal(kat(await srodowisko(w2).proces.podglad(), 'ord-u1'), K.DO_SPRAWDZENIA);
});

test('dane: naprawa z anulowanym poprzednikiem — do faktury; aktywne drugie zamówienie — kontrola', async () => {
  const w = swiat([{ contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', externalOrderId: 'TOTO:2026-11:u1:repair1' }] }]);
  w.dodatkoweKlucze.set('stare', zamowienie({ id: 'ord-stare', numer: 1, contactId: ANNA, umowaId: 'u1', status: 'CANCELED' }));
  const env = srodowisko(w);
  assert.equal(kat(await env.proces.podglad(), 'ord-u1'), K.DO_FAKTURY);
  w.dodatkoweKlucze.set('akt', zamowienie({ id: 'ord-akt', numer: 2, contactId: ANNA, umowaId: 'u1', externalOrderId: '2026-11/u1' }));
  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.match(p.doRecznejDecyzji[0].powod, /ord-akt/);
});

test('dane: daty w opisie tylko, gdy odczytane ze wszystkich pozycji', async () => {
  const w = swiat([{ contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }, { umowaId: 'u2', cena: 180 }] }]);
  w.orders.get('ord-u2').lineItems[0].descriptionLines = [{ plainText: { original: 'Nov 3, 2026, 3:00 PM' } }];
  const [plan] = (await srodowisko(w).proces.podglad()).proponowaneFaktury;
  assert.match(plan.pozycje[0].opis, /\(03\.11, 10\.11, 17\.11, 24\.11\)/);
  assert.doesNotMatch(plan.pozycje[1].opis, /\(/);
});

test('dane: PAID na 0 zł (stawka 0) — ZEROWE', async () => {
  assert.equal(kat(await jedenKlient([{ umowaId: 'u1', cena: 0, paymentStatus: 'PAID' }]).proces.podglad(), 'ord-u1'), K.ZEROWE);
});

test('PROBE w procesie: ostatnia faktura z dziennika, bez zapisów i danych osobowych', async () => {
  const env = jedenKlient();
  await wykonajWszystko(env);
  const przed = env.db.zapisy;
  const r = await env.proces.sonda();
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.brakujaceDlaKontroli, []);
  assert.ok(!JSON.stringify(r).includes('a@x.pl'));
  assert.equal(env.db.zapisy, przed);
});

test('REVIEW: cancelled plan can be prepared again for unchanged order set', async()=>{
 const env=jedenKlient();
 env.db.awaria=(op,c,item)=>op==='update' && item.status===S.CREATING;
 await assert.rejects(run(env)); env.db.awaria=null;
 const z=env.w.orders.get('ord-u1');
 z.appliedDiscounts=[{_id:'d',merchantDiscount:{amount:{amount:'160'}}}];
 z.priceSummary.discount={amount:'160'};z.priceSummary.total={amount:'480'};z.balanceSummary.balance={amount:'480'};
 await run(env);assert.equal(operacje(env)[0].status,S.CANCELLED);
 assert.equal((await env.proces.podglad()).proponowaneFaktury.length,1);
 await run(env);
 assert.equal(env.inv.utworzenia,1,'New valid plan is silently excluded because CANCELLED operation has same ID');
});
test('REVIEW: next order must be read again before create in same batch', async()=>{
 const env=srodowisko([
 {contactId:ANNA,nazwa:'Anna Nowak',email:'a@x.pl',umowy:[{umowaId:'u1'}]},
 {contactId:BEATA,nazwa:'Beata Kowal',email:'b@x.pl',umowy:[{umowaId:'u2'}]}]);
 const original=env.gateway.utworzFakture;
 env.gateway.utworzFakture=async p=>{
 const result=await original(p);
 const z=env.w.orders.get('ord-u2');z.paymentStatus='PAID';z.balanceSummary.paid={amount:'640'};
 return result;
 };
 await run(env,{maxFaktur:2,etap:'UTWORZ'});
 assert.equal(env.inv.utworzenia,1,'Created invoice for an order that changed to PAID during batch');
});

test('faktura do zamówienia — pomijane zawsze, także przy rozbieżnościach i anulowaniu', async () => {
  const w = swiat([{ contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [
    { umowaId: 'u1', fakturyWix: [{ id: 'f1' }], externalOrderId: 'OBCY' },
    { umowaId: 'u2', fakturyWix: [{ id: 'f2' }], status: 'CANCELED' },
    { umowaId: 'u3', fakturyWix: [{ id: 'f3' }], paymentStatus: 'PARTIALLY_PAID', zaplacono: 100 },
    { umowaId: 'u4' }] }]);
  const env = srodowisko(w);
  const p = await env.proces.podglad();
  for (const id of ['ord-u1', 'ord-u2', 'ord-u3']) assert.equal(kat(p, id), K.ROZLICZONE, id);
  assert.deepEqual(p.proponowaneFaktury[0].orderIds, ['ord-u4']);
  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 1);
  assert.equal(faktury(env)[0].totals.total, 640);
});
