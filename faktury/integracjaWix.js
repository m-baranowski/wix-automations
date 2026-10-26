// backend/faktury/integracjaWix.js
// Warstwa integracji z Wix — jedyny moduł importujący API Wix.
// Logika rozliczeń i dziennik dostają ten obiekt jako zależność,
// dzięki czemu testy podmieniają go na atrapy.
//
// Wykorzystane API (zweryfikowane w dokumentacji Wix):
//  - wix-data                    — CMS (Umowy, UmowyMiesiace, dziennik, blokady)
//  - @wix/ecom orders            — searchOrders (filtr id $in,
//                                  channelInfo.externalOrderId $in), getOrder
//  - @wix/ecom orderInvoices     — listInvoicesForMultipleOrders
//  - @wix/ecom orderTransactions — listTransactionsForMultipleOrders
//  - wix-crm-backend contacts    — getContact
//  - wix-billing-backend invoices — createInvoice / getInvoice / sendInvoice
//    (ten sam mechanizm, który działał w październiku)
//
// Celowo NIE używamy: createOrder, updateOrder, markAsPaid, addPayments,
// voidInvoice, deleteInvoice — skrypt nie zmienia zamówień ani płatności.

import wixData from 'wix-data';
import { invoices } from 'wix-billing-backend';
import { contacts } from 'wix-crm-backend';
import { elevate } from 'wix-auth';
import { orders, orderInvoices, orderTransactions } from '@wix/ecom';
import { auth } from '@wix/essentials';
import { idOf } from 'backend/faktury/rozliczenia';

const READ = { suppressAuth: true, suppressHooks: true, consistentRead: true };
const WRITE = { suppressAuth: true, suppressHooks: true };

const searchOrders = auth.elevate(orders.searchOrders);
const getOrder = auth.elevate(orders.getOrder);
const listInvoices = auth.elevate(orderInvoices.listInvoicesForMultipleOrders);
const listTransactions = auth.elevate(
  orderTransactions.listTransactionsForMultipleOrders
);

const createInvoice = elevate(invoices.createInvoice);
const getInvoice = elevate(invoices.getInvoice);
const sendInvoice = elevate(invoices.sendInvoice);

const msg = e => String(e?.message || e).slice(0, 500);

function kawalki(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// ======================================================
// CMS
// ======================================================

export const db = {
  async get(collection, id) {
    const r = await wixData
      .query(collection)
      .eq('_id', id)
      .limit(1)
      .find(READ);
    return r.items[0] || null;
  },

  insert: (collection, item) =>
    wixData.insert(collection, JSON.parse(JSON.stringify(item)), WRITE),

  update: (collection, item) =>
    wixData.update(collection, JSON.parse(JSON.stringify(item)), WRITE),

  remove: (collection, id) => wixData.remove(collection, id, WRITE),

  async find(collection, eq = {}) {
    const out = [];

    for (let offset = 0; ; offset += 100) {
      let q = wixData.query(collection);
      for (const [k, v] of Object.entries(eq)) q = q.eq(k, v);

      const page = await q
        .ascending('_id')
        .skip(offset)
        .limit(100)
        .find(READ);

      out.push(...page.items);
      if (page.items.length < 100) return out;
    }
  },

  async byIds(collection, ids) {
    const out = [];

    for (const part of kawalki(ids, 100)) {
      const r = await wixData
        .query(collection)
        .hasSome('_id', part)
        .limit(100)
        .find(READ);
      out.push(...r.items);
    }

    return out;
  }
};

// ======================================================
// eCommerce
// ======================================================

/**
 * Zamówienia po ID. Search Orders nie zwraca statusów PENDING,
 * REJECTED i INITIALIZED — brakujące pobieramy przez getOrder.
 * @returns {Map<string, {raw?: Object, error?: string}>}
 */
async function zamowienia(ids) {
  const out = new Map();
  const unikalne = [...new Set(ids)];

  for (const part of kawalki(unikalne, 100)) {
    try {
      const r = await searchOrders({
        filter: { id: { $in: part } },
        cursorPaging: { limit: 100 }
      });

      // Zamówienie spoza listy = filtr nie zadziałał; nie ufamy odpowiedzi.
      if ((r.orders || []).some(o => !part.includes(idOf(o)))) {
        console.warn('FAKTURY_SEARCH_ORDERS', 'Filtr id zignorowany — getOrder.');
        break;
      }

      for (const o of r.orders || []) out.set(idOf(o), { raw: o });
    } catch (e) {
      console.warn('FAKTURY_SEARCH_ORDERS', msg(e));
      break;
    }
  }

  const brak = unikalne.filter(id => !out.has(id));

  for (const part of kawalki(brak, 5)) {
    await Promise.all(part.map(async id => {
      try {
        const o = await getOrder(id);
        out.set(id, idOf(o) === id ? { raw: o } : { error: 'getOrder: inne ID.' });
      } catch (e) {
        out.set(id, { error: `getOrder: ${msg(e)}` });
      }
    }));
  }

  return out;
}

/**
 * Indeks externalOrderId -> [orderId] (wykrywa dodatkowe zamówienia
 * tej samej umowy i miesiąca). null = nie udało się sprawdzić.
 */
async function indeksKluczy(klucze) {
  const map = new Map();

  try {
    for (const part of kawalki([...new Set(klucze)], 100)) {
      let cursor;
      let strony = 0;

      do {
        const r = await searchOrders(
          cursor
            ? { cursorPaging: { limit: 100, cursor } }
            : {
                filter: { 'channelInfo.externalOrderId': { $in: part } },
                cursorPaging: { limit: 100 }
              }
        );

        if (++strony > 20) throw new Error('Zbyt wiele stron wyników.');

        for (const o of r.orders || []) {
          const k = o.channelInfo?.externalOrderId;
          // Zamówienie spoza listy = filtr nie zadziałał.
          if (!part.includes(k)) throw new Error('Filtr externalOrderId zignorowany.');
          const list = map.get(k) || [];
          if (!list.includes(idOf(o))) list.push(idOf(o));
          map.set(k, list);
        }

        const next = r.metadata?.cursors?.next;
        if (next && next === cursor) throw new Error('Powtórzony kursor.');
        cursor = r.metadata?.hasNext === false ? null : next;
      } while (cursor);
    }

    return map;
  } catch (e) {
    console.warn('FAKTURY_INDEKS_KLUCZY', msg(e));
    return null;
  }
}

// Faktury powiązane z zamówieniami w eCommerce. null = nieznane.
async function fakturyZamowien(ids) {
  const map = new Map();

  try {
    for (const part of kawalki(ids, 100)) {
      const r = await listInvoices(part);

      for (const x of r.invoicesForOrder || []) {
        map.set(x.orderId, x.invoicesInfo || []);
      }

      for (const id of part) {
        if (!map.has(id)) {
          throw new Error(`Brak odpowiedzi dla zamówienia ${id}.`);
        }
      }
    }

    return map;
  } catch (e) {
    console.warn('FAKTURY_ORDER_INVOICES', msg(e));
    return null;
  }
}

// Płatności i zwroty zamówień. null = nieznane.
async function transakcje(ids) {
  const map = new Map();

  try {
    for (const part of kawalki(ids, 100)) {
      const r = await listTransactions(part);

      for (const x of r.orderTransactions || []) {
        map.set(x.orderId, {
          payments: x.payments || [],
          refunds: x.refunds || []
        });
      }

      // Zamówienia niedostępne dla wywołującego są pomijane w odpowiedzi.
      for (const id of part) {
        if (!map.has(id)) {
          throw new Error(`Brak transakcji dla zamówienia ${id}.`);
        }
      }
    }

    return map;
  } catch (e) {
    console.warn('FAKTURY_TRANSACTIONS', msg(e));
    return null;
  }
}

// ======================================================
// Bramka używana przez proces
// ======================================================

export function createGateway(cfg) {
  const k = cfg.kolekcje;

  return {
    db,

    wierszeCykli: () => db.find(k.umowyMiesiace, { miesiac: cfg.miesiac }),

    async umowy(ids) {
      const rows = await db.byIds(k.umowy, ids);
      return new Map(rows.map(r => [r._id, r]));
    },

    zamowienia,
    indeksKluczy,
    fakturyZamowien,
    transakcje,

    kontakt: contactId =>
      contacts.getContact(contactId, { suppressAuth: true }),

    // createInvoice zwraca { id: { id, version } }.
    utworzFakture: pola => createInvoice(pola),

    // Zwraca m.in. id {id, version}, status, totals, metadata, wasSent.
    pobierzFakture: invoiceId => getInvoice(invoiceId),

    // sendInvoice wymaga płaskiego { id, version }.
    wyslijFakture: (id, version, email) =>
      sendInvoice({ id, version }, email)
  };
}
