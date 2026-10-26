// Atrapy API Wix dla testów. Żadne wywołanie nie wychodzi poza proces.

import { createJournal } from '../faktury/dziennik.js';
import { createProcess } from '../faktury/proces.js';
import { KONFIGURACJA_LISTOPAD_2026 } from '../faktury/konfiguracja.js';

export const MIESIAC = '2026-11';
export const APP = KONFIGURACJA_LISTOPAD_2026.appIdRezerwacji;

const money = c => ({ amount: (c / 100).toFixed(2) });
const kopia = x => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

export const cfgTest = (zmiany = {}) => ({
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
export function zamowienie({
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

export function wierszCyklu(order, { umowaId, stawka, status = 'DONE' }) {
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
export function swiat(spec) {
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

export function bazaDanych() {
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

export function fakturyWix() {
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

export function srodowisko(spec, zmianyCfg = {}) {
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
        m.set(k, [...(m.get(k) || []), o._id]);
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
export async function przygotujIZatwierdz(env) {
  const p = await env.proces.przygotuj();
  if (p.status !== 'OK') throw new Error(`PREPARE: ${p.blad}`);
  return env.proces.zatwierdz({
    wszystkie: true,
    oczekiwanaLiczba: p.doZatwierdzenia.liczba,
    oczekiwanaSuma: p.doZatwierdzenia.suma
  });
}

export async function wykonajWszystko(env, opcje = {}) {
  const wyniki = [];
  for (let i = 0; i < 50; i++) {
    const r = await env.proces.wykonaj({ maxOperacji: 2, ...opcje });
    wyniki.push(r);
    if (!r.wyniki?.length || r.zatrzymano) break;
  }
  return wyniki;
}
