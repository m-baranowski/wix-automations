// backend/faktury/rozliczenia.js
// Logika rozliczeń — czyste funkcje, bez importów Wix.
//
// Źródłem rozliczenia są zamówienia eCommerce wskazane przez
// UmowyMiesiace (orderId), a nie terminy w kalendarzu.
// Wszystkie kwoty liczone w groszach (liczby całkowite).

import { createHash } from 'crypto';

// ======================================================
// STAŁE
// ======================================================

// Kategoria pojedynczego zamówienia w rozliczeniu miesiąca.
export const K = Object.freeze({
  DO_FAKTURY: 'DO_FAKTURY',
  W_PRZYGOTOWANIU: 'W_PRZYGOTOWANIU',
  ROZLICZONE: 'ROZLICZONE',
  DO_SPRAWDZENIA: 'DO_SPRAWDZENIA',
  ANULOWANE: 'ANULOWANE',
  ZEROWE: 'ZEROWE'
});

// Statusy operacji (faktury) w dzienniku FakturyMiesieczne.
export const S = Object.freeze({
  PREPARED: 'PREPARED',
  APPROVED: 'APPROVED',
  CREATING: 'CREATING',
  CREATED: 'CREATED',
  SENDING: 'SENDING',
  SENT: 'SENT',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  CANCELLED: 'CANCELLED',
  CLOSED_MANUALLY: 'CLOSED_MANUALLY'
});

// Faktura istnieje (lub istniała) w Wix — należność zafakturowana.
export const STATUSY_ZAFAKTUROWANE = [
  S.CREATED,
  S.SENDING,
  S.SENT,
  S.CLOSED_MANUALLY
];

export const STATUSY_PLANOWANE = [S.PREPARED, S.APPROVED];

export const STATUSY_NIEPEWNE = [S.CREATING, S.NEEDS_REVIEW];

// ======================================================
// POMOCNICZE
// ======================================================

export const idOf = x => x?._id || x?.id;

export const copy = x => JSON.parse(JSON.stringify(x));

export const norm = v =>
  String(v || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

export function stableId(text) {
  const h = createHash('sha256').update(text).digest('hex');

  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}-` +
    `5${h.slice(13, 16)}-a${h.slice(17, 20)}-` +
    `${h.slice(20, 32)}`
  );
}

export function hash(value) {
  return createHash('sha256')
    .update(JSON.stringify(canon(value)))
    .digest('hex');
}

export function canon(x) {
  if (Array.isArray(x)) return x.map(canon);

  if (x && typeof x === 'object') {
    return Object.fromEntries(
      Object.keys(x)
        .sort()
        .map(k => [k, canon(x[k])])
    );
  }

  return x;
}

// Kwota Wix (string "160.00", liczba albo obiekt Price) -> grosze.
// Odrzuca wartości z więcej niż 2 miejscami po przecinku.
export function grosze(value) {
  const raw =
    value && typeof value === 'object' ? value.amount : value;

  if (raw === undefined || raw === null || raw === '') return 0;

  const n = Number(raw);

  if (!Number.isFinite(n)) {
    throw new Error(`Nieprawidłowa kwota: ${JSON.stringify(raw)}`);
  }

  const c = Math.round(n * 100);

  if (Math.abs(n * 100 - c) > 1e-6) {
    throw new Error(`Kwota z więcej niż 2 miejscami: ${raw}`);
  }

  return c;
}

export const zl = c => (c / 100).toFixed(2);

const suma = (list, f) => list.reduce((s, x) => s + f(x), 0);

export const operationId = (month, contactId, orderIds) =>
  stableId(
    `toto/invoice/v2/${month}/${contactId}/` +
    [...orderIds].sort().join(',')
  );

export const claimId = orderId =>
  stableId(`toto/invoice-order/v2/${orderId}`);

// Klucz zamówienia nadawany przez generatorUmow.js.
export const orderKey = (month, umowaId) =>
  `TOTO:${month}:${umowaId}`;

// ======================================================
// ZAMÓWIENIE -> POSTAĆ ZNORMALIZOWANA
// ======================================================

function kwotaRabatu(d) {
  const zrodlo =
    d.merchantDiscount?.amount ??
    d.coupon?.amount ??
    d.discountRule?.amount;

  if (zrodlo !== undefined && zrodlo !== null) {
    return grosze(zrodlo);
  }

  if (Array.isArray(d.lineItemDiscounts) && d.lineItemDiscounts.length) {
    return suma(d.lineItemDiscounts, x => grosze(x.totalDiscount));
  }

  return null;
}

function opisRabatu(d) {
  return (
    d.merchantDiscount?.description ||
    d.coupon?.name ||
    d.discountRule?.name?.original ||
    d.discountRule?.name ||
    'Rabat'
  );
}

function dataWizyty(line) {
  for (const d of line.descriptionLines || []) {
    const t =
      d?.plainText?.original ||
      d?.plainText ||
      d?.lineValue?.original ||
      '';
    const m = String(t).match(/(\d{4}-\d{2}-\d{2})/);
    if (m) return { data: m[1], tekst: String(t) };
  }
  return null;
}

/**
 * Normalizuje zamówienie eCommerce (kształt SDK @wix/ecom).
 * Zwraca kwoty w groszach i listę problemów uzgodnienia.
 */
export function normalizujZamowienie(raw) {
  const problemy = [];
  const p = raw.priceSummary || {};

  const linie = (raw.lineItems || []).map(li => {
    const cena = grosze(li.price);
    const ilosc = Number(li.quantity);

    if (!Number.isInteger(ilosc) || ilosc <= 0) {
      problemy.push(`Pozycja ${idOf(li)}: nieprawidłowa ilość.`);
    }

    const wizyta = dataWizyty(li);

    return {
      lineItemId: idOf(li),
      appId: li.catalogReference?.appId || '',
      catalogItemId: li.catalogReference?.catalogItemId || '',
      nazwa: li.productName?.original || li.productName || '',
      cena,
      ilosc,
      brutto: cena * ilosc,
      rabatPozycji: grosze(li.totalDiscount),
      dataWizyty: wizyta?.data || null,
      opisWizyty: wizyta?.tekst || ''
    };
  });

  const rabaty = [];

  for (const d of raw.appliedDiscounts || []) {
    const kwota = kwotaRabatu(d);

    if (kwota === null) {
      problemy.push(`Rabat ${idOf(d)}: nie można ustalić kwoty.`);
      continue;
    }

    if (kwota < 0) {
      problemy.push(`Rabat ${idOf(d)}: ujemna kwota.`);
    }

    if (d.discountType === 'SHIPPING') {
      problemy.push(`Rabat ${idOf(d)}: rabat na wysyłkę — nieobsługiwany.`);
    }

    rabaty.push({
      discountId: idOf(d) || `idx-${rabaty.length}`,
      kwota,
      opis: opisRabatu(d),
      zrodlo: d.merchantDiscount
        ? 'MERCHANT'
        : d.coupon
          ? 'COUPON'
          : d.discountRule
            ? 'RULE'
            : 'INNE'
    });
  }

  const brutto = suma(linie, x => x.brutto);
  const subtotal = grosze(p.subtotal);
  const rabat = grosze(p.discount);
  const podatek = grosze(p.tax);
  const wysylka = grosze(p.shipping);
  const oplaty = grosze(p.totalAdditionalFees);
  const razem = grosze(p.total);
  const sumaRabatow = suma(rabaty, x => x.kwota);
  const sumaRabatowPozycji = suma(linie, x => x.rabatPozycji);

  if (subtotal !== brutto) {
    problemy.push(
      `Suma pozycji ${zl(brutto)} ≠ subtotal ${zl(subtotal)}.`
    );
  }

  if (sumaRabatow !== rabat) {
    problemy.push(
      `Suma rabatów ${zl(sumaRabatow)} ≠ priceSummary.discount ${zl(rabat)}.`
    );
  }

  if (sumaRabatowPozycji !== 0 && sumaRabatowPozycji !== rabat) {
    problemy.push(
      `Rabaty pozycji ${zl(sumaRabatowPozycji)} ≠ rabat zamówienia ${zl(rabat)}.`
    );
  }

  if (podatek || wysylka || oplaty) {
    problemy.push('Zamówienie ma podatek, wysyłkę lub opłaty dodatkowe.');
  }

  if (razem !== subtotal - rabat + podatek + wysylka + oplaty) {
    problemy.push(
      `Total ${zl(razem)} ≠ subtotal − rabat (${zl(subtotal - rabat)}).`
    );
  }

  if (rabat > brutto) problemy.push('Rabat większy niż wartość zamówienia.');
  if (razem < 0) problemy.push('Ujemna wartość zamówienia.');

  const b = raw.balanceSummary || {};

  return {
    orderId: idOf(raw),
    numer: raw.number ? String(raw.number) : '',
    contactId: raw.buyerInfo?.contactId || '',
    externalOrderId: raw.channelInfo?.externalOrderId || '',
    status: raw.status || '',
    paymentStatus: raw.paymentStatus || '',
    waluta: raw.currency || '',
    linie,
    rabaty,
    brutto,
    rabat,
    razem,
    zaplacono: grosze(b.paid),
    saldo: b.balance === undefined ? null : grosze(b.balance),
    zwroty: grosze(b.refunded),
    problemy
  };
}

// ======================================================
// WERYFIKACJA POWIĄZANIA: miesiąc + klient + umowa + plan
// ======================================================

export function sprawdzPowiazanie(o, row, umowa, cfg) {
  const problemy = [];
  const month = cfg.miesiac;

  if (o.orderId !== row.orderId) {
    problemy.push('Zamówienie ma inne ID niż wpis UmowyMiesiace.');
  }

  if (!row.klientContactId || o.contactId !== row.klientContactId) {
    problemy.push('Kontakt zamówienia ≠ kontakt w UmowyMiesiace.');
  }

  if (!umowa) {
    problemy.push(`Brak umowy ${row.umowaId} w CMS Umowy.`);
  } else if (umowa.klientContactId !== row.klientContactId) {
    problemy.push('Kontakt umowy ≠ kontakt w UmowyMiesiace.');
  }

  if (o.externalOrderId !== orderKey(month, row.umowaId)) {
    problemy.push(
      `externalOrderId "${o.externalOrderId}" ≠ ` +
      `"${orderKey(month, row.umowaId)}".`
    );
  }

  if (o.waluta !== cfg.waluta) {
    problemy.push(`Waluta ${o.waluta || '?'} ≠ ${cfg.waluta}.`);
  }

  const plan = (row.stan?.plan || []).filter(p => p.status === 'BOOKED');
  const bookingi = new Set(plan.map(p => p.bookingId));
  const wZamowieniu = o.linie.map(l => l.catalogItemId);

  if (
    bookingi.size !== wZamowieniu.length ||
    new Set(wZamowieniu).size !== wZamowieniu.length ||
    wZamowieniu.some(id => !bookingi.has(id))
  ) {
    problemy.push(
      'Pozycje zamówienia nie odpowiadają wizytom BOOKED z dziennika cyklu.'
    );
  }

  for (const l of o.linie) {
    if (l.appId !== cfg.appIdRezerwacji) {
      problemy.push(`Pozycja ${l.lineItemId} nie jest rezerwacją Bookings.`);
    }

    if (typeof row.stawka === 'number' && l.cena !== grosze(row.stawka)) {
      problemy.push(
        `Pozycja ${l.lineItemId}: cena ${zl(l.cena)} ≠ stawka ${row.stawka}.`
      );
    }

    if (l.dataWizyty && !l.dataWizyty.startsWith(month + '-')) {
      // Wizyta przeniesiona poza miesiąc nadal należy do rozliczenia
      // miesiąca, jeśli opis pozycji wskazuje ten miesiąc.
      if (!l.opisWizyty.includes(`/ ${month}`)) {
        problemy.push(
          `Pozycja ${l.lineItemId}: wizyta ${l.dataWizyty} poza miesiącem ${month}.`
        );
      }
    }
  }

  return problemy;
}

// ======================================================
// KLASYFIKACJA ZAMÓWIENIA
// ======================================================

// Kategoria bazowa — bez uwzględnienia przypisania w dzienniku.
// Używana też przy ponownej weryfikacji przed utworzeniem faktury.
export function klasyfikujBazowo(w, cfg) {
  const powody = [];
  const o = w.zamowienie;

  if (!o) {
    return {
      kategoria: K.DO_SPRAWDZENIA,
      powody: [w.bladZamowienia || 'Nie odczytano zamówienia.']
    };
  }

  const problemy = [...o.problemy, ...w.problemyPowiazania];

  if (w.row.status !== 'DONE') {
    problemy.push(
      `Cykl w UmowyMiesiace ma status ${w.row.status}, oczekiwano DONE.`
    );
  }

  if (w.inneZamowienia === null) {
    problemy.push('Nie sprawdzono innych zamówień tej umowy i miesiąca.');
  } else if (w.inneZamowienia.length) {
    problemy.push(
      'Istnieją inne zamówienia z tym samym kluczem umowy/miesiąca: ' +
      w.inneZamowienia.join(', ')
    );
  }

  if (o.status === 'CANCELED') {
    if (w.fakturyWix?.length) {
      return {
        kategoria: K.DO_SPRAWDZENIA,
        powody: ['Zamówienie anulowane, ale ma powiązaną fakturę Wix.']
      };
    }
    return { kategoria: K.ANULOWANE, powody: ['Zamówienie anulowane.'] };
  }

  if (problemy.length) {
    return { kategoria: K.DO_SPRAWDZENIA, powody: problemy };
  }

  if (w.fakturyWix === null) {
    return {
      kategoria: K.DO_SPRAWDZENIA,
      powody: ['Nie potwierdzono listy faktur zamówienia (API).']
    };
  }

  if (w.fakturyWix.length) {
    return {
      kategoria: K.ROZLICZONE,
      powody: [
        'Zamówienie ma fakturę Wix: ' +
        w.fakturyWix.map(x => idOf(x)).join(', ')
      ]
    };
  }

  if (o.status !== 'APPROVED') {
    return {
      kategoria: K.DO_SPRAWDZENIA,
      powody: [`Status zamówienia ${o.status}, oczekiwano APPROVED.`]
    };
  }

  if (o.razem === 0) {
    return {
      kategoria: cfg.pomijajZerowe ? K.ZEROWE : K.DO_SPRAWDZENIA,
      powody: ['Wartość zamówienia po rabatach wynosi 0 zł.']
    };
  }

  if (w.transakcje === null) {
    return {
      kategoria: K.DO_SPRAWDZENIA,
      powody: ['Nie potwierdzono transakcji zamówienia (API).']
    };
  }

  const platnosci = w.transakcje.payments || [];
  const zwroty = w.transakcje.refunds || [];

  switch (o.paymentStatus) {
    case 'NOT_PAID':
      if (platnosci.length || zwroty.length || o.zaplacono || o.zwroty) {
        powody.push('NOT_PAID, ale zamówienie ma transakcje lub wpłaty.');
      }
      if (o.saldo !== null && o.saldo !== o.razem) {
        powody.push(
          `Saldo ${zl(o.saldo)} ≠ wartość zamówienia ${zl(o.razem)}.`
        );
      }
      break;

    case 'PAID':
      powody.push(
        'Zamówienie opłacone, brak potwierdzonej faktury — decyzja ręczna.'
      );
      break;

    case 'PARTIALLY_PAID':
      powody.push(
        `Zamówienie częściowo opłacone (${zl(o.zaplacono)} z ${zl(o.razem)}).`
      );
      break;

    default:
      powody.push(`Status płatności ${o.paymentStatus || 'brak'}.`);
  }

  if (powody.length) {
    return { kategoria: K.DO_SPRAWDZENIA, powody };
  }

  return { kategoria: K.DO_FAKTURY, powody: [] };
}

// Kategoria końcowa — z uwzględnieniem przypisania w dzienniku.
export function klasyfikuj(w, cfg) {
  const baza = klasyfikujBazowo(w, cfg);

  if (!w.przypisanie) return { ...baza, baza };

  const op = w.operacja;
  const opis = op
    ? `operacja ${op._id} (${op.status})`
    : `operacja ${w.przypisanie.operationId} (brak w dzienniku)`;

  if (!op) {
    return {
      kategoria: K.DO_SPRAWDZENIA,
      powody: [`Przypisanie do nieistniejącej operacji: ${opis}.`],
      baza
    };
  }

  if (STATUSY_ZAFAKTUROWANE.includes(op.status)) {
    if (w.fakturyWix?.length) {
      return {
        kategoria: K.DO_SPRAWDZENIA,
        powody: [
          `Zamówienie ma fakturę z dziennika (${opis}) ORAZ fakturę Wix.`
        ],
        baza
      };
    }
    return {
      kategoria: K.ROZLICZONE,
      powody: [`Zafakturowane: ${opis}, faktura ${op.invoiceId || '?'}.`],
      baza
    };
  }

  if (STATUSY_PLANOWANE.includes(op.status)) {
    return {
      kategoria: K.W_PRZYGOTOWANIU,
      powody: [`Zaplanowane: ${opis}.`],
      baza
    };
  }

  return {
    kategoria: K.DO_SPRAWDZENIA,
    powody: [`Stan wymaga decyzji: ${opis}. ${op.blad || ''}`.trim()],
    baza
  };
}

// ======================================================
// PLAN FAKTURY DLA GRUPY ZAMÓWIEŃ JEDNEGO KONTAKTU
// ======================================================

function opisDat(daty) {
  const d = daty
    .filter(Boolean)
    .sort()
    .map(x => `${x.slice(8, 10)}.${x.slice(5, 7)}`);

  return d.length && d.length <= 8 ? ` (${d.join(', ')})` : '';
}

const wizyt = n =>
  n === 1 ? 'wizyta' : n % 10 >= 2 && n % 10 <= 4 &&
    (n % 100 < 10 || n % 100 >= 20) ? 'wizyty' : 'wizyt';

/**
 * Buduje plan jednej faktury: pozycje usług z cenami z zamówień
 * oraz osobną ujemną pozycję dla każdego rabatu (każdy dokładnie raz).
 * @param {string} contactId
 * @param {Array} zamowienia znormalizowane zamówienia (razem > 0)
 */
export function zbudujPlan(contactId, zamowienia, cfg) {
  if (!zamowienia.length) throw new Error('Pusta grupa zamówień.');

  for (const o of zamowienia) {
    if (o.contactId !== contactId) {
      throw new Error(
        `Zamówienie ${o.orderId} należy do innego kontaktu — nie łączymy.`
      );
    }
  }

  const ids = zamowienia.map(o => o.orderId);

  if (new Set(ids).size !== ids.length) {
    throw new Error('Zduplikowane zamówienie w grupie.');
  }

  const posortowane = [...zamowienia].sort((a, b) =>
    (Number(a.numer) || 0) - (Number(b.numer) || 0) ||
    a.orderId.localeCompare(b.orderId)
  );

  const pozycje = [];
  const rabaty = [];
  const tytul = cfg.tytulFaktury;

  for (const o of posortowane) {
    const nr = o.numer ? `#${o.numer}` : o.orderId.slice(0, 8);
    const grupy = new Map();

    for (const l of o.linie) {
      const k = `${l.nazwa}|${l.cena}`;
      const g = grupy.get(k) || { nazwa: l.nazwa, cena: l.cena, ilosc: 0, daty: [] };
      g.ilosc += l.ilosc;
      g.daty.push(l.dataWizyty);
      grupy.set(k, g);
    }

    for (const g of grupy.values()) {
      pozycje.push({
        orderId: o.orderId,
        rodzaj: 'USLUGA',
        nazwa: g.nazwa,
        opis:
          `${tytul}: ${g.ilosc} ${wizyt(g.ilosc)}` +
          `${opisDat(g.daty)} — zamówienie ${nr}`,
        cena: g.cena,
        ilosc: g.ilosc
      });
    }

    for (const r of o.rabaty) {
      if (!r.kwota) continue;

      const klucz = `${o.orderId}/${r.discountId}`;

      if (rabaty.some(x => x.klucz === klucz)) {
        throw new Error(`Rabat ${klucz} wystąpił dwukrotnie.`);
      }

      rabaty.push({ klucz, orderId: o.orderId, kwota: r.kwota, opis: r.opis });

      if (cfg.trybRabatu === 'NEGATIVE_LINE') {
        pozycje.push({
          orderId: o.orderId,
          rodzaj: 'RABAT',
          nazwa: 'Rabat',
          opis: `${r.opis} — zamówienie ${nr}`,
          cena: -r.kwota,
          ilosc: 1
        });
      }
    }
  }

  const brutto = suma(posortowane, o => o.brutto);
  const sumaRabatow = suma(rabaty, r => r.kwota);
  const razem = suma(posortowane, o => o.razem);

  const rabatFaktury =
    cfg.trybRabatu === 'INVOICE_DISCOUNT' ? sumaRabatow : 0;

  const zPozycji =
    suma(pozycje, p => p.cena * p.ilosc) - rabatFaktury;

  // Kontrole: rabat ujęty dokładnie raz, kwoty zgodne z zamówieniami.
  if (sumaRabatow !== suma(posortowane, o => o.rabat)) {
    throw new Error('Suma rabatów na fakturze ≠ suma rabatów zamówień.');
  }

  if (zPozycji !== razem || brutto - sumaRabatow !== razem) {
    throw new Error(
      `Niezgodność kwot faktury: pozycje ${zl(zPozycji)}, ` +
      `zamówienia ${zl(razem)}.`
    );
  }

  if (razem <= 0) throw new Error('Faktura z kwotą ≤ 0 zł.');

  if (!['NEGATIVE_LINE', 'INVOICE_DISCOUNT'].includes(cfg.trybRabatu)) {
    throw new Error(`Nieznany trybRabatu: ${cfg.trybRabatu}.`);
  }

  const orderIds = [...ids].sort();

  const plan = {
    operationId: operationId(cfg.miesiac, contactId, orderIds),
    miesiac: cfg.miesiac,
    contactId,
    orderIds,
    numeryZamowien: posortowane.map(o => o.numer),
    pozycje,
    rabaty,
    rabatFaktury,
    brutto,
    sumaRabatow,
    razem,
    trybRabatu: cfg.trybRabatu
  };

  plan.fingerprint = hash({
    miesiac: plan.miesiac,
    contactId,
    orderIds,
    pozycje,
    rabaty,
    rabatFaktury,
    razem,
    zamowienia: posortowane.map(o => ({
      orderId: o.orderId,
      brutto: o.brutto,
      rabat: o.rabat,
      razem: o.razem,
      paymentStatus: o.paymentStatus
    }))
  });

  return plan;
}

// ======================================================
// DANE KONTAKTU I POLA FAKTURY (wix-billing-backend)
// ======================================================

export function wyciagnijKontakt(raw) {
  const c = raw?.contact || raw;
  const first = c?.info?.name?.first || c?.name?.first || '';
  const last = c?.info?.name?.last || c?.name?.last || '';
  const emails = c?.info?.emails?.items || c?.info?.emails || [];
  const phones = c?.info?.phones?.items || c?.info?.phones || [];

  return {
    contactId: idOf(c) || '',
    firstName: first,
    lastName: last,
    fullName: [first, last].filter(Boolean).join(' '),
    email:
      c?.primaryInfo?.email ||
      (Array.isArray(emails) &&
        (emails.find(e => e.primary)?.email || emails[0]?.email)) ||
      '',
    phone:
      c?.primaryInfo?.phone ||
      (Array.isArray(phones) &&
        (phones.find(p => p.primary)?.phone || phones[0]?.phone)) ||
      ''
  };
}

export function terminPlatnosci(teraz, dni) {
  return new Date(teraz.getTime() + dni * 24 * 60 * 60 * 1000);
}

/**
 * Pola dla invoices.createInvoice() z wix-billing-backend.
 * Kształt zgodny z działającym skryptem październikowym
 * oraz dokumentacją createInvoice (customer, lineItems, discount,
 * dates, metadata).
 */
export function polaFaktury(plan, kontakt, cfg, teraz) {
  if (kontakt.contactId !== plan.contactId) {
    throw new Error('Kontakt faktury ≠ kontakt planu.');
  }

  if (!kontakt.email) {
    throw new Error(`Kontakt ${plan.contactId} nie ma adresu e-mail.`);
  }

  const pola = {
    title: cfg.tytulFaktury,
    customer: {
      contactId: plan.contactId,
      email: kontakt.email,
      ...(kontakt.firstName ? { firstName: kontakt.firstName } : {}),
      ...(kontakt.lastName ? { lastName: kontakt.lastName } : {}),
      ...(kontakt.fullName ? { fullName: kontakt.fullName } : {}),
      ...(kontakt.phone ? { phone: kontakt.phone } : {})
    },
    currency: cfg.waluta,
    lineItems: plan.pozycje.map((p, i) => ({
      id: `poz-${String(i + 1).padStart(2, '0')}`,
      name: p.nazwa,
      description: p.opis,
      price: p.cena / 100,
      quantity: p.ilosc
    })),
    dates: {
      issueDate: teraz,
      dueDate: terminPlatnosci(teraz, cfg.dniNaPlatnosc)
    },
    metadata: {
      notes:
        `Zamówienia: ${plan.numeryZamowien.map(n => '#' + n).join(', ')}`,
      source: 'toto-faktury-v2',
      sourceRefId: plan.operationId
    }
  };

  if (plan.rabatFaktury) {
    pola.discount = { value: plan.rabatFaktury / 100, type: 'Fixed' };
  }

  return pola;
}

// Kontrola faktury odczytanej przez getInvoice() przed wysyłką.
export function sprawdzFakture(faktura, op) {
  const problemy = [];

  if (!faktura) return ['Nie odczytano faktury.'];

  if (faktura.id?.id !== op.invoiceId) {
    problemy.push('Odczytana faktura ma inne ID.');
  }

  if (faktura.customer?.contactId !== op.klientContactId) {
    problemy.push('Faktura wystawiona na inny kontakt.');
  }

  if (faktura.currency && faktura.currency !== 'PLN') {
    problemy.push(`Waluta faktury ${faktura.currency}.`);
  }

  const ref = faktura.metadata?.sourceRefId;

  if (ref && ref !== op._id) {
    problemy.push(`Faktura należy do innej operacji (${ref}).`);
  }

  try {
    const total = grosze(faktura.totals?.total);

    if (total !== op.kwotaGrosze) {
      problemy.push(
        `Suma faktury ${zl(total)} ≠ oczekiwana ${zl(op.kwotaGrosze)}.`
      );
    }
  } catch (e) {
    problemy.push(`Nieczytelna suma faktury: ${e.message}`);
  }

  if (
    Array.isArray(faktura.lineItems) &&
    Array.isArray(op.pozycje) &&
    faktura.lineItems.length !== op.pozycje.length
  ) {
    problemy.push('Liczba pozycji faktury ≠ liczba pozycji planu.');
  }

  return problemy;
}

// ======================================================
// ANALIZA MIESIĄCA
// ======================================================

/**
 * @param {Object} stan dane odczytane z Wix i dziennika
 * @param {Object} cfg konfiguracja miesiąca
 */
export function analizuj(stan, cfg) {
  const ostrzezenia = [...(stan.ostrzezenia || [])];
  const zamowienia = [];
  const cykleBezZamowien = [];
  const wgOrderId = new Map();
  const wgUmowy = new Map();

  for (const row of stan.rows) {
    const list = wgUmowy.get(row.umowaId) || [];
    list.push(row);
    wgUmowy.set(row.umowaId, list);
  }

  for (const row of stan.rows) {
    const umowa = stan.umowy.get(row.umowaId) || null;
    const klient = umowa?.klientNazwa || row.title || '';

    if (!row.orderId) {
      if (row.status !== 'EMPTY') {
        cykleBezZamowien.push({
          umowaId: row.umowaId,
          klient,
          status: row.status,
          powod: 'Cykl bez zamówienia — brak podstawy do faktury.'
        });
      }
      continue;
    }

    const odczyt = stan.zamowienia.get(row.orderId);
    let zamowienie = null;
    let bladZamowienia = odczyt?.error || null;

    if (odczyt?.raw) {
      try {
        zamowienie = normalizujZamowienie(odczyt.raw);
      } catch (e) {
        bladZamowienia = `Nieczytelne zamówienie: ${e.message}`;
      }
    } else if (!bladZamowienia) {
      bladZamowienia = 'Zamówienie nie zostało odczytane.';
    }

    const problemyPowiazania = [];

    if ((wgUmowy.get(row.umowaId) || []).length > 1) {
      problemyPowiazania.push('Kilka wpisów UmowyMiesiace dla tej umowy.');
    }

    if (wgOrderId.has(row.orderId)) {
      problemyPowiazania.push('To samo zamówienie w kilku wpisach cyklu.');
      const pierwszy = wgOrderId.get(row.orderId);
      pierwszy.problemyPowiazania.push('To samo zamówienie w kilku wpisach cyklu.');
    }

    if (zamowienie) {
      problemyPowiazania.push(
        ...sprawdzPowiazanie(zamowienie, row, umowa, cfg)
      );
    }

    const klucz = orderKey(cfg.miesiac, row.umowaId);
    const inne = stan.indeksKluczy
      ? (stan.indeksKluczy.get(klucz) || []).filter(id => id !== row.orderId)
      : null;

    const przypisanie = stan.przypisania.get(row.orderId) || null;

    const w = {
      row,
      umowa,
      klient,
      zamowienie,
      bladZamowienia,
      problemyPowiazania,
      inneZamowienia: inne,
      fakturyWix: stan.fakturyWix
        ? stan.fakturyWix.get(row.orderId) || []
        : null,
      transakcje: stan.transakcje
        ? stan.transakcje.get(row.orderId) || { payments: [], refunds: [] }
        : null,
      przypisanie,
      operacja: przypisanie
        ? stan.operacje.get(przypisanie.operationId) || null
        : null
    };

    wgOrderId.set(row.orderId, w);
    zamowienia.push(w);
  }

  for (const w of zamowienia) {
    Object.assign(w, klasyfikuj(w, cfg));
  }

  // Opcjonalnie: wstrzymanie całego klienta, gdy ma zamówienie do sprawdzenia.
  if (cfg.wstrzymajKlientaPrzyPrzegladzie) {
    const doSprawdzenia = new Set(
      zamowienia
        .filter(w => w.kategoria === K.DO_SPRAWDZENIA)
        .map(w => w.row.klientContactId)
    );

    for (const w of zamowienia) {
      if (
        w.kategoria === K.DO_FAKTURY &&
        doSprawdzenia.has(w.row.klientContactId)
      ) {
        w.kategoria = K.DO_SPRAWDZENIA;
        w.powody = ['Wstrzymane: inne zamówienie klienta wymaga sprawdzenia.'];
      }
    }
  }

  // Grupowanie wyłącznie po stabilnym contactId.
  const grupy = new Map();

  for (const w of zamowienia) {
    if (w.kategoria !== K.DO_FAKTURY) continue;
    const c = w.zamowienie.contactId;
    const list = grupy.get(c) || [];
    list.push(w);
    grupy.set(c, list);
  }

  const plany = [];

  for (const [contactId, list] of grupy) {
    try {
      const plan = zbudujPlan(contactId, list.map(w => w.zamowienie), cfg);
      plan.klient = list[0].klient;
      plan.umowaIds = list.map(w => w.row.umowaId).sort();
      plan.istniejacaOperacja = stan.operacje.get(plan.operationId) || null;
      plany.push(plan);
    } catch (e) {
      for (const w of list) {
        w.kategoria = K.DO_SPRAWDZENIA;
        w.powody = [`Plan faktury: ${e.message}`];
      }
    }
  }

  // Ostrzeżenie: podobne dane, różne kontakty — nigdy nie łączymy.
  const nazwy = new Map();

  for (const w of zamowienia) {
    const n = norm(w.klient);
    if (!n) continue;
    const s = nazwy.get(n) || new Set();
    s.add(w.row.klientContactId);
    nazwy.set(n, s);
  }

  for (const [n, s] of nazwy) {
    if (s.size > 1) {
      ostrzezenia.push(
        `Ta sama nazwa klienta "${n}" dla ${s.size} różnych kontaktów ` +
        `(${[...s].join(', ')}) — faktury osobne.`
      );
    }
  }

  // Ponowna weryfikacja operacji zaplanowanych (PREPARED/APPROVED).
  const weryfikacjaPlanowanych = [];

  for (const op of stan.operacje.values()) {
    if (op.miesiac !== cfg.miesiac || !STATUSY_PLANOWANE.includes(op.status)) {
      continue;
    }
    weryfikacjaPlanowanych.push(
      zweryfikujOperacje(op, zamowienia, cfg)
    );
  }

  const sumy = policzSumy(zamowienia, plany, weryfikacjaPlanowanych);

  return {
    miesiac: cfg.miesiac,
    zamowienia,
    cykleBezZamowien,
    plany,
    weryfikacjaPlanowanych,
    sumy,
    ostrzezenia,
    bledyGlobalne: [...(stan.bledyGlobalne || [])]
  };
}

/**
 * Czy zaplanowana operacja nadal odpowiada stanowi zamówień?
 * Wymaga: każde zamówienie bazowo DO_FAKTURY, przypisane do tej
 * operacji i plan o identycznym fingerprint.
 */
export function zweryfikujOperacje(op, zamowienia, cfg) {
  const problemy = [];
  const w = op.orderIds.map(id =>
    zamowienia.find(x => x.row.orderId === id)
  );

  w.forEach((x, i) => {
    if (!x) {
      problemy.push(`Zamówienie ${op.orderIds[i]} nie występuje w UmowyMiesiace.`);
      return;
    }

    if (x.przypisanie?.operationId !== op._id) {
      problemy.push(`Zamówienie ${x.row.orderId} nie jest przypisane do operacji.`);
    }

    if (x.baza?.kategoria !== K.DO_FAKTURY) {
      problemy.push(
        `Zamówienie ${x.row.orderId}: ${x.baza?.kategoria} — ` +
        (x.baza?.powody || []).join(' ')
      );
    }
  });

  let plan = null;

  if (!problemy.length) {
    try {
      plan = zbudujPlan(
        op.klientContactId,
        w.map(x => x.zamowienie),
        { ...cfg, trybRabatu: op.trybRabatu || cfg.trybRabatu }
      );

      if (plan.operationId !== op._id) {
        problemy.push('Identyfikator operacji nie zgadza się z zamówieniami.');
      }

      if (plan.fingerprint !== op.fingerprint) {
        problemy.push('Zamówienia zmieniły się od przygotowania (fingerprint).');
      }
    } catch (e) {
      problemy.push(`Plan faktury: ${e.message}`);
    }
  }

  return {
    operationId: op._id,
    status: op.status,
    klient: op.klientNazwa,
    kwota: zl(op.kwotaGrosze || 0),
    kwotaGrosze: op.kwotaGrosze || 0,
    ok: !problemy.length,
    problemy,
    plan
  };
}

export function policzSumy(zamowienia, plany, planowane = []) {
  const kwota = w =>
    w.zamowienie
      ? w.zamowienie.razem
      : grosze(w.row.kwota || 0);

  const wKat = k => zamowienia.filter(w => w.kategoria === k);
  const s = list => suma(list, kwota);
  const znane = zamowienia.filter(w => w.zamowienie);

  const r = {
    liczbaZamowien: zamowienia.length,
    bruttoGrosze: suma(znane, w => w.zamowienie.brutto),
    rabatyGrosze: suma(znane, w => w.zamowienie.rabat),
    nettoGrosze: s(zamowienia),
    juzRozliczoneGrosze: s(wKat(K.ROZLICZONE)),
    doNowychFakturGrosze: s(wKat(K.DO_FAKTURY)) + s(wKat(K.W_PRZYGOTOWANIU)),
    nowePlanyGrosze: s(wKat(K.DO_FAKTURY)),
    wPrzygotowaniuGrosze: s(wKat(K.W_PRZYGOTOWANIU)),
    doSprawdzeniaGrosze: s(wKat(K.DO_SPRAWDZENIA)),
    anulowaneGrosze: s(wKat(K.ANULOWANE)),
    zeroweGrosze: s(wKat(K.ZEROWE)),
    szacunkoweGrosze: s(zamowienia.filter(w => !w.zamowienie)),
    sumaPlanowGrosze: suma(plany, p => p.razem),
    sumaPlanowanychOperacjiGrosze: suma(planowane, p => p.kwotaGrosze),
    liczby: Object.fromEntries(
      Object.values(K).map(k => [k, wKat(k).length])
    )
  };

  const rozbicie =
    r.juzRozliczoneGrosze +
    r.doNowychFakturGrosze +
    r.doSprawdzeniaGrosze +
    r.anulowaneGrosze +
    r.zeroweGrosze;

  r.kontrole = {
    // Należności nie mogą zniknąć: netto = suma kategorii.
    rozbicieZgodne: rozbicie === r.nettoGrosze,
    // Nowe faktury = dokładnie nierozliczone zamówienia DO_FAKTURY.
    planyZgodne: r.sumaPlanowGrosze === r.nowePlanyGrosze,
    // Operacje PREPARED/APPROVED = zamówienia W_PRZYGOTOWANIU.
    planowaneZgodne:
      r.sumaPlanowanychOperacjiGrosze === r.wPrzygotowaniuGrosze,
    // brutto − rabaty = netto (dla odczytanych zamówień).
    rabatyZgodne:
      r.bruttoGrosze - r.rabatyGrosze ===
      suma(znane, w => w.zamowienie.razem)
  };

  r.kontroleOk = Object.values(r.kontrole).every(Boolean);

  r.zl = {
    brutto: zl(r.bruttoGrosze),
    rabaty: zl(r.rabatyGrosze),
    netto: zl(r.nettoGrosze),
    juzRozliczone: zl(r.juzRozliczoneGrosze),
    doNowychFaktur: zl(r.doNowychFakturGrosze),
    doSprawdzenia: zl(r.doSprawdzeniaGrosze),
    anulowane: zl(r.anulowaneGrosze),
    zerowe: zl(r.zeroweGrosze),
    szacunkowe: zl(r.szacunkoweGrosze),
    sumaNowychPlanow: zl(r.sumaPlanowGrosze),
    sumaPlanowanychOperacji: zl(r.sumaPlanowanychOperacjiGrosze)
  };

  return r;
}

// Wiersz tabeli PREVIEW dla jednego zamówienia.
export function wierszTabeli(w) {
  const o = w.zamowienie;
  const uslugi = o
    ? [...new Set(o.linie.map(l => l.nazwa))].join(', ')
    : '';

  return {
    klient: w.klient,
    contactId: w.row.klientContactId,
    umowaId: w.row.umowaId,
    orderId: w.row.orderId,
    numer: o?.numer || '',
    usluga: uslugi,
    wizyty: o ? suma(o.linie, l => l.ilosc) : null,
    stawka: o?.linie[0] ? zl(o.linie[0].cena) : '',
    brutto: o ? zl(o.brutto) : '',
    rabaty: o
      ? o.rabaty.map(r => `${zl(r.kwota)} (${r.opis})`).join('; ')
      : '',
    rabat: o ? zl(o.rabat) : '',
    netto: o ? zl(o.razem) : `~${zl(grosze(w.row.kwota || 0))}`,
    statusZamowienia: o?.status || '',
    platnosc: o?.paymentStatus || '',
    fakturyWix: w.fakturyWix
      ? w.fakturyWix.map(x => idOf(x)).join(', ')
      : 'NIEZNANE',
    dziennik: w.operacja
      ? `${w.operacja.status} ${w.operacja.invoiceId || ''}`.trim()
      : '',
    kategoria: w.kategoria,
    powod: (w.powody || []).join(' | ')
  };
}
