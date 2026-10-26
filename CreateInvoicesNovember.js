/**
 * Fakturowanie LISTOPAD 2026 — Centrum Terapii Dziecięcej Toto.
 * Plik backendu Velo: backend/CreateInvoicesNovember.js
 * Uruchamianie: automatyzacja z akcją „Run Velo Code” (jak październik).
 *
 * Źródło rozliczenia: zamówienia eCommerce wskazane w UmowyMiesiace.orderId.
 * Skrypt nie tworzy ani nie zmienia zamówień, harmonogramów, płatności
 * i istniejących faktur. Nie oznacza zamówień jako opłaconych. Nie wysyła
 * SMS (robi to istniejąca automatyzacja „Invoice Sent”).
 *
 * Z października zachowano: createInvoice() z wix-billing-backend
 * zwracające { id: { id, version } }, sendInvoice() z płaskim
 * { id, version }, zapis dziennika PRZED createInvoice, log
 * FAKTURA_UTWORZONA przed zapisem ID, blokadę w GeneratorBlokady.
 *
 * ROZLICZENIE (dla wierszy UmowyMiesiace miesiąca z orderId)
 *  - powiązanie: kontakt zamówienia = cyklu = umowy; pozycje = dokładnie
 *    wizyty BOOKED z planu cyklu; cena = stawka; PLN; brak innych
 *    aktywnych zamówień tej umowy; externalOrderId: TOTO:{m}:{umowa}
 *    (także :repairN, /restoreN), {m}/{umowa} albo brak;
 *  - kwoty w groszach; cena, subtotal i total muszą istnieć (brak ≠ 0);
 *    rabaty appliedDiscounts = priceSummary.discount; total = subtotal − rabat;
 *  - kategorie: DO_FAKTURY (APPROVED, NOT_PAID, bez faktury i transakcji),
 *    ROZLICZONE (faktura w Wix lub w dzienniku), ANULOWANE (zamówienie
 *    i cykl anulowane), ZEROWE (0 zł), W_PRZYGOTOWANIU (operacja przed
 *    utworzeniem), DO_SPRAWDZENIA (wszystko inne: PAID bez faktury,
 *    częściowa płatność, niezgodności, cykl DONE z anulowanym zamówieniem);
 *  - jedna faktura na contactId (nigdy po nazwie/e-mailu); pozycja usługi
 *    na zamówienie + osobna ujemna pozycja na każdy rabat; tytuł, PLN,
 *    termin 5 dni, metadata.sourceRefId = identyfikator operacji.
 *
 * DZIENNIK FakturyMiesieczne (wiersze październikowe bez zmian)
 *  Dodaj w CMS pola: rodzaj, operationId, orderId, email, numeryZamowien,
 *  kwotaGrosze, rabatFaktury, fingerprint, utworzenieRozpoczete, powod,
 *  audyt, utworzono, wyslano (pozostałe pola już istnieją).
 *  rodzaj FAKTURA     _id = hash(miesiąc, contactId, posortowane orderIds)
 *  rodzaj ZAMOWIENIE  _id = hash(orderId), pole operationId. Wix odrzuca
 *                     insert istniejącego _id: zamówienie → jedna faktura.
 *  Statusy: PREPARED → APPROVED → CREATING → CREATED → SENDING → SENT,
 *           NEEDS_REVIEW, CANCELLED.
 *
 * KOLEJNOŚĆ PRACY — ustaw TRYB (i OPCJE_RUN), zapisz, odpal automatyzację.
 *  0. PROBE   — getInvoice ostatniej faktury z dziennika; log
 *               FAKTURY_PROBE ze strukturą (bez danych osobowych).
 *               Wymagane brakujaceDlaKontroli = [].
 *  1. PREVIEW — tylko odczyt. Logi: FAKTURY_PREVIEW_ZAMOWIENIE (tabela),
 *               _FAKTURA (proponowane faktury), _SUMY, _BRAKI,
 *               _DO_ZATWIERDZENIA (liczba i suma wszystkich faktur miesiąca).
 *  2. Sprawdź w panelu Faktury, że klienci z PREVIEW nie mają już faktur
 *     za listopad wystawionych poza dziennikiem (API tego nie wykrywa).
 *  3. RUN, OPCJE_RUN: oczekiwanaLiczba i oczekiwanaSuma z PREVIEW,
 *     sprawdzilemPanelFaktur: true, kto: '<imię>', akceptujBraki: ID
 *     z FAKTURY_PREVIEW_BRAKI świadomie pominięte (zwykle []),
 *     maxFaktur: 1, etap: 'UTWORZ' → faktura próbna (najlepiej z rabatem);
 *     obejrzyj w panelu. Jeśli Wix odrzuci ujemną pozycję: RABAT_JAKO =
 *     'RABAT_FAKTURY' (operacja wpadnie w NEEDS_REVIEW — patrz niżej).
 *  4. RUN, etap 'WYSLIJ' → sprawdź e-mail i SMS.
 *  5. RUN, etap 'OBA', maxFaktur 2–5 → odpalaj do pozostalo = 0.
 *  6. STATUS i PREVIEW: doNowychFaktur = 0. Na koniec TRYB = 'PREVIEW'.
 *  RUN przed każdą fakturą ponownie odczytuje zamówienia. Operacja, której
 *  zamówienia się zmieniły, a faktura nie powstała, jest anulowana
 *  automatycznie (wróci w kolejnym PREVIEW z nową kwotą).
 *  Podwójne odpalenie automatyzacji: drugie wywołanie dostaje BUSY.
 *
 * TIMEOUT / AWARIA
 *  - BUSY: inne wywołanie trwa. Blokada starsza niż 5 min = przerwane
 *    wywołanie: sprawdź logi, usuń ręcznie wiersz w GeneratorBlokady
 *    (tytuł „Faktury 2026-11”).
 *  - Kolejny RUN: CREATING → NEEDS_REVIEW/CREATE_UNCERTAIN (bez ponownego
 *    tworzenia); SENDING → SENT, jeśli getInvoice().wasSent, inaczej
 *    NEEDS_REVIEW/SEND_UNCERTAIN (bez ponownej wysyłki).
 *
 * STANY NIEPEWNE — decyzja ręczna przez edycję wiersza FAKTURA w CMS
 *  Zasada: zmieniaj status tylko na podstawie zapisu po stronie Wix.
 *  Niedoręczony e-mail/SMS albo pobieżne wyszukiwanie niczego nie dowodzą.
 *  Gdy wynik jest niejednoznaczny — zostaw NEEDS_REVIEW.
 *  CREATE_UNCERTAIN: log FAKTURA_UTWORZONA oraz panel Faktury (lista
 *    wszystkich faktur kontaktu, w tym szkice, z dnia uruchomienia).
 *      faktura jest → wpisz invoiceId, status CREATED (RUN porówna treść
 *                     z planem przed wysyłką);
 *      brak w logu I w pełnej liście faktur kontaktu → status APPROVED.
 *  SEND_UNCERTAIN: w panelu status faktury (wysłana/szkic) oraz historia
 *    uruchomień automatyzacji „Invoice Sent” dla tej faktury.
 *      oznaczona jako wysłana lub automatyzacja uruchomiona → status SENT;
 *      szkic i brak uruchomienia automatyzacji → status CREATED.
 *  INVOICE_MISMATCH / INVOICE_STATUS / KONTAKT: popraw ręcznie, potem
 *    status CREATED albo APPROVED; sprawa zamknięta poza skryptem → SENT
 *    z opisem w polu blad.
 *  Nie usuwaj wierszy CREATING ani przypisań ZAMOWIENIE. Nie wysyłaj
 *  ręcznie faktur CREATED (podwójny e-mail i SMS).
 *
 * AUDYT: operacja zapisuje w polu audyt, kto potwierdził sprawdzenie panelu
 *  Faktury, kiedy, jakie braki pominięto i fingerprint zamówień — z RUN,
 *  który utworzył fakturę. Potwierdzenie jest deklaracją dla całego
 *  miesiąca, nie dowodem z API (API nie wykrywa faktur spoza dziennika).
 *
 * OGRANICZENIA API (potwierdzone 2026-10-26)
 *  - Witryna ma Wix Invoices V1: nowe API (@wix/get-paid) zwraca 428;
 *    faktury V1 są dostępne tylko przez Velo i nie da się ich wyszukać.
 *  - Order Invoices pokazuje tylko faktury powiązane z zamówieniem;
 *    faktury samodzielne (październik, listopad, ręczne) — tylko dziennik.
 *  - Faktura samodzielna po opłaceniu tworzy NOWE zamówienie; nie oznacza
 *    zamówień listopadowych jako PAID.
 *  - Search Orders pomija PENDING/REJECTED/INITIALIZED (→ getOrder).
 *  - Ujemna cena pozycji w createInvoice nie jest udokumentowana.
 */

import wixData from 'wix-data';
import { invoices } from 'wix-billing-backend';
import { contacts } from 'wix-crm-backend';
import { elevate } from 'wix-auth';
import { orders, orderInvoices, orderTransactions } from '@wix/ecom';
import { auth } from '@wix/essentials';
import { createHash, randomBytes } from 'crypto';

// ======================================================
// URUCHOMIENIE
// ======================================================

// PROBE | PREVIEW | RUN | STATUS — PREVIEW niczego nie zapisuje.
const TRYB = 'PREVIEW';

const OPCJE_RUN = {
  oczekiwanaLiczba: null,        // z FAKTURY_PREVIEW_DO_ZATWIERDZENIA
  oczekiwanaSuma: '',            // np. '41280.00'
  sprawdzilemPanelFaktur: false, // krok 2
  kto: '',
  akceptujBraki: [],             // ID z FAKTURY_PREVIEW_BRAKI
  maxFaktur: 1,                  // 1–5
  etap: 'UTWORZ',                // UTWORZ | WYSLIJ | OBA
  contactIds: []                 // puste = wszyscy
};

// Pusty = ostatnia faktura z dziennika.
const PROBE_INVOICE_ID = '';

// 'POZYCJA' — każdy rabat jako ujemna pozycja (preferowane w Toto).
// 'RABAT_FAKTURY' — suma rabatów jako rabat kwotowy faktury (zapasowo).
const RABAT_JAKO = 'POZYCJA';

const CFG = {
  miesiac: '2026-11',
  tytul: 'Listopad 2026',
  temat: 'Rachunek za listopad — Centrum Terapii Dziecięcej Toto',
  tresc: 'Przesyłamy rachunek za listopad 2026. Dziękujemy!',
  dniNaPlatnosc: 5,
  rabatJako: RABAT_JAKO,
  appIdRezerwacji: '13d21c63-b5ec-5912-8397-c3a5ddb27a97',
  umowy: 'Umowy',
  cykle: 'UmowyMiesiace',
  dziennik: 'FakturyMiesieczne',
  blokady: 'GeneratorBlokady',
  maxSekund: 30,
  zapasMs: 12000,
  blokadaMs: 5 * 60 * 1000
};

// ======================================================
// POMOCNICZE
// ======================================================

const K = {
  DO_FAKTURY: 'DO_FAKTURY',
  W_PRZYGOTOWANIU: 'W_PRZYGOTOWANIU',
  ROZLICZONE: 'ROZLICZONE',
  DO_SPRAWDZENIA: 'DO_SPRAWDZENIA',
  ANULOWANE: 'ANULOWANE',
  ZEROWE: 'ZEROWE'
};

const S = {
  PREPARED: 'PREPARED',
  APPROVED: 'APPROVED',
  CREATING: 'CREATING',
  CREATED: 'CREATED',
  SENDING: 'SENDING',
  SENT: 'SENT',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  CANCELLED: 'CANCELLED'
};

const FAKTURA = 'FAKTURA';
const ZAMOWIENIE = 'ZAMOWIENIE';

const idOf = x => x?._id || x?.id;
const copy = x => JSON.parse(JSON.stringify(x));
const msg = e => String(e?.message || e).slice(0, 1000);
const norm = v => String(v || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const suma = (list, f) => list.reduce((s, x) => s + f(x), 0);
const zl = c => (c / 100).toFixed(2);

function blad(text, name) {
  const e = new Error(text);
  e.name = name;
  return e;
}

function stableId(text) {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function canon(x) {
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === 'object') {
    return Object.fromEntries(Object.keys(x).sort().map(k => [k, canon(x[k])]));
  }
  return x;
}

const hash = v => createHash('sha256').update(JSON.stringify(canon(v))).digest('hex');

const operationId = (month, contactId, orderIds) =>
  stableId(`toto/invoice/v2/${month}/${contactId}/${[...orderIds].sort().join(',')}`);

const claimId = orderId => stableId(`toto/invoice-order/v2/${orderId}`);

const LOCK_ID = stableId('toto/faktury/v2/global');

// Kwoty: string "160.00" / "160", liczba lub obiekt Price -> grosze.
// grosze(): pole opcjonalne (brak = 0). groszeWymagane(): brak = błąd.
function parsujGrosze(raw) {
  const ok = typeof raw === 'number' ||
    (typeof raw === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(raw));
  const n = ok ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new Error(`Nieprawidłowa kwota: ${JSON.stringify(raw)}`);

  const c = Math.round(n * 100);
  if (!Number.isSafeInteger(c)) throw new Error(`Kwota poza zakresem: ${raw}`);
  if (Math.abs(n * 100 - c) > 1e-6) throw new Error(`Kwota z więcej niż 2 miejscami: ${raw}`);
  return c;
}

const surowa = v => (v && typeof v === 'object' ? v.amount : v);
const pusta = v => v === undefined || v === null || v === '';

function grosze(value) {
  const raw = surowa(value);
  return pusta(raw) ? 0 : parsujGrosze(raw);
}

function groszeWymagane(value, nazwa) {
  const raw = surowa(value);
  if (pusta(raw)) throw new Error(`Brak wymaganej kwoty: ${nazwa}.`);
  return parsujGrosze(raw);
}

// ======================================================
// ZAMÓWIENIE → POSTAĆ ZNORMALIZOWANA
// ======================================================

// Klucze spotykane na witrynie (odczyt 2026-10-26):
// TOTO:{m}:{umowa} (generator), …:repairN / …/restoreN (naprawy; poprzednik
// anulowany), {m}/{umowa} (spoza generatora), brak (zamówienia ręczne —
// powiązanie dowodzą wtedy kontakt i wizyty).
const orderKey = (month, umowaId) => `TOTO:${month}:${umowaId}`;
const kluczeWyszukiwania = (month, umowaId) => [orderKey(month, umowaId), `${month}/${umowaId}`];

function kluczZgodny(ext, month, umowaId) {
  if (!ext) return true;
  const baza = orderKey(month, umowaId);
  return ext === baza ||
    ext === `${month}/${umowaId}` ||
    (ext.startsWith(baza) && /^(:repair|\/restore)\d+$/.test(ext.slice(baza.length)));
}

function kwotaRabatu(d) {
  const z = d.merchantDiscount?.amount ?? d.coupon?.amount ?? d.discountRule?.amount;
  if (z !== undefined && z !== null) return grosze(z);
  if (d.lineItemDiscounts?.length) return suma(d.lineItemDiscounts, x => grosze(x.totalDiscount));
  return null;
}

function dataWizyty(line) {
  for (const d of line.descriptionLines || []) {
    const t = String(d?.plainText?.original || d?.lineValue?.original || '');
    const m = t.match(/(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Normalizuje zamówienie (kształt SDK @wix/ecom). Brak wymaganej kwoty
 * rzuca wyjątek — zamówienie zostaje z kwotą NIEZNANA i trafia do kontroli.
 */
function normalizujZamowienie(raw) {
  const problemy = [];
  const p = raw.priceSummary || {};

  if (!Array.isArray(raw.lineItems) || !raw.lineItems.length) {
    throw new Error('Zamówienie bez pozycji.');
  }

  const linie = raw.lineItems.map(li => {
    const cena = groszeWymagane(li.price, `cena pozycji ${idOf(li)}`);
    const ilosc = Number(li.quantity);
    if (!Number.isInteger(ilosc) || ilosc <= 0) problemy.push(`Pozycja ${idOf(li)}: nieprawidłowa ilość.`);
    return {
      lineItemId: idOf(li),
      appId: li.catalogReference?.appId || '',
      bookingId: li.catalogReference?.catalogItemId || '',
      nazwa: li.productName?.original || li.productName || '',
      cena,
      ilosc,
      rabatPozycji: grosze(li.totalDiscount),
      data: dataWizyty(li)
    };
  });

  const rabaty = [];
  for (const d of raw.appliedDiscounts || []) {
    const kwota = kwotaRabatu(d);
    if (kwota === null || kwota < 0) {
      problemy.push(`Rabat ${idOf(d)}: nieustalona lub ujemna kwota.`);
      continue;
    }
    if (d.discountType === 'SHIPPING') problemy.push(`Rabat ${idOf(d)}: rabat na wysyłkę.`);
    rabaty.push({
      discountId: idOf(d) || `idx-${rabaty.length}`,
      kwota,
      opis: d.merchantDiscount?.description || d.coupon?.name || d.discountRule?.name?.original || 'Rabat'
    });
  }

  const brutto = suma(linie, l => l.cena * l.ilosc);
  const subtotal = groszeWymagane(p.subtotal, 'priceSummary.subtotal');
  const razem = groszeWymagane(p.total, 'priceSummary.total');
  const rabat = grosze(p.discount);
  const dodatki = grosze(p.tax) + grosze(p.shipping) + grosze(p.totalAdditionalFees);
  const sumaRabatow = suma(rabaty, r => r.kwota);
  const rabatyPozycji = suma(linie, l => l.rabatPozycji);

  if (subtotal !== brutto) problemy.push(`Suma pozycji ${zl(brutto)} ≠ subtotal ${zl(subtotal)}.`);
  if (sumaRabatow !== rabat) problemy.push(`Suma rabatów ${zl(sumaRabatow)} ≠ priceSummary.discount ${zl(rabat)}.`);
  if (rabatyPozycji && rabatyPozycji !== rabat) problemy.push(`Rabaty pozycji ${zl(rabatyPozycji)} ≠ rabat ${zl(rabat)}.`);
  if (dodatki) problemy.push('Zamówienie ma podatek, wysyłkę lub opłaty.');
  if (razem !== subtotal - rabat + dodatki) problemy.push(`Total ${zl(razem)} ≠ subtotal − rabat.`);
  if (razem < 0 || rabat > brutto) problemy.push('Rabat większy niż wartość zamówienia.');

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
    saldo: pusta(surowa(b.balance)) ? null : grosze(b.balance),
    problemy
  };
}

function sprawdzPowiazanie(o, row, umowa) {
  const p = [];
  const m = CFG.miesiac;

  if (!row.klientContactId || o.contactId !== row.klientContactId) p.push('Kontakt zamówienia ≠ kontakt cyklu.');
  if (!umowa) p.push(`Brak umowy ${row.umowaId}.`);
  else if (umowa.klientContactId !== row.klientContactId) p.push('Kontakt umowy ≠ kontakt cyklu.');
  if (!kluczZgodny(o.externalOrderId, m, row.umowaId)) p.push(`externalOrderId "${o.externalOrderId}" nie wskazuje umowy i miesiąca.`);
  if (o.waluta !== 'PLN') p.push(`Waluta ${o.waluta || '?'}.`);

  const booked = new Set((row.stan?.plan || []).filter(x => x.status === 'BOOKED').map(x => x.bookingId));
  const ids = o.linie.map(l => l.bookingId);
  if (booked.size !== ids.length || new Set(ids).size !== ids.length || ids.some(id => !booked.has(id))) {
    p.push('Pozycje zamówienia ≠ wizyty BOOKED cyklu.');
  }

  for (const l of o.linie) {
    if (l.appId !== CFG.appIdRezerwacji) p.push(`Pozycja ${l.lineItemId} nie jest rezerwacją.`);
    if (typeof row.stawka === 'number' && l.cena !== Math.round(row.stawka * 100)) {
      p.push(`Pozycja ${l.lineItemId}: cena ${zl(l.cena)} ≠ stawka ${row.stawka}.`);
    }
  }

  return p;
}

// ======================================================
// KLASYFIKACJA
// ======================================================

// Kategoria bez uwzględnienia dziennika (używana też przy ponownej
// weryfikacji operacji przed utworzeniem faktury).
function klasyfikujBazowo(w) {
  const o = w.zamowienie;
  if (!o) return [K.DO_SPRAWDZENIA, w.bladZamowienia || 'Nie odczytano zamówienia.'];

  if (o.status === 'CANCELED') {
    if (w.row.status === 'DONE') return [K.DO_SPRAWDZENIA, 'Cykl DONE, a zamówienie anulowane — sprawdź wizyty i zamówienie zastępcze.'];
    if (w.fakturyWix?.length) return [K.DO_SPRAWDZENIA, 'Zamówienie anulowane, ale ma fakturę Wix.'];
    return [K.ANULOWANE, 'Zamówienie anulowane.'];
  }

  const problemy = [...o.problemy, ...w.problemyPowiazania];
  if (w.row.status !== 'DONE') problemy.push(`Cykl ma status ${w.row.status}.`);
  if (w.inneZamowienia === null) problemy.push('Nie sprawdzono innych zamówień umowy.');
  else if (w.inneZamowienia.length) problemy.push(`Inne aktywne zamówienia umowy: ${w.inneZamowienia.join(', ')}.`);
  if (problemy.length) return [K.DO_SPRAWDZENIA, problemy.join(' ')];

  if (w.fakturyWix === null) return [K.DO_SPRAWDZENIA, 'Nie odczytano faktur zamówienia.'];
  if (w.fakturyWix.length) return [K.ROZLICZONE, `Faktura Wix: ${w.fakturyWix.map(idOf).join(', ')}.`];
  if (o.status !== 'APPROVED') return [K.DO_SPRAWDZENIA, `Status zamówienia ${o.status}.`];
  if (o.razem === 0) return [K.ZEROWE, 'Wartość 0 zł.'];
  if (w.transakcje === null) return [K.DO_SPRAWDZENIA, 'Nie odczytano transakcji zamówienia.'];

  if (o.paymentStatus === 'PAID') return [K.DO_SPRAWDZENIA, 'Opłacone, brak potwierdzonej faktury.'];
  if (o.paymentStatus === 'PARTIALLY_PAID') return [K.DO_SPRAWDZENIA, `Częściowo opłacone (${zl(o.zaplacono)} z ${zl(o.razem)}).`];
  if (o.paymentStatus !== 'NOT_PAID') return [K.DO_SPRAWDZENIA, `Status płatności ${o.paymentStatus || 'brak'}.`];
  if (w.transakcje.payments?.length || w.transakcje.refunds?.length || o.zaplacono) {
    return [K.DO_SPRAWDZENIA, 'NOT_PAID, ale są transakcje lub wpłaty.'];
  }
  if (o.saldo !== null && o.saldo !== o.razem) return [K.DO_SPRAWDZENIA, `Saldo ${zl(o.saldo)} ≠ wartość ${zl(o.razem)}.`];

  // Wpis dziennika za miesiąc spoza modelu v2 może oznaczać fakturę
  // wystawioną innym skryptem, niewidoczną w Order Invoices.
  if (w.obceWpisy.length) return [K.DO_SPRAWDZENIA, `Wpis dziennika spoza modelu: ${w.obceWpisy.join(', ')}.`];

  return [K.DO_FAKTURY, ''];
}

function klasyfikuj(w) {
  const [kat, powod] = klasyfikujBazowo(w);
  w.bazowa = kat;
  w.kategoria = kat;
  w.powod = powod;

  if (!w.przypisanie) return;

  const op = w.operacja;
  const opis = `operacja ${w.przypisanie.operationId} (${op?.status || 'brak'})`;

  if (!op || op.status === S.CANCELLED) {
    [w.kategoria, w.powod] = [K.DO_SPRAWDZENIA, `Przypisanie do nieaktywnej operacji: ${opis}.`];
  } else if ([S.CREATED, S.SENDING, S.SENT].includes(op.status)) {
    [w.kategoria, w.powod] = w.fakturyWix?.length
      ? [K.DO_SPRAWDZENIA, `Faktura z dziennika (${opis}) ORAZ faktura Wix.`]
      : [K.ROZLICZONE, `Zafakturowane: ${opis}, faktura ${op.invoiceId || '?'}.`];
  } else if ([S.PREPARED, S.APPROVED].includes(op.status)) {
    [w.kategoria, w.powod] = [K.W_PRZYGOTOWANIU, `Zaplanowane: ${opis}.`];
  } else {
    [w.kategoria, w.powod] = [K.DO_SPRAWDZENIA, `Wymaga decyzji: ${opis} ${op.powod || ''} ${op.blad || ''}`.trim()];
  }
}

// ======================================================
// PLAN FAKTURY (jeden contactId)
// ======================================================

const wizyt = n => (n === 1 ? 'wizyta' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'wizyty' : 'wizyt');

// Daty tylko, gdy odczytane ze wszystkich pozycji (opisy mają różne formaty).
function opisDat(daty) {
  if (!daty.length || daty.length > 8 || daty.some(d => !d)) return '';
  return ` (${[...daty].sort().map(d => `${d.slice(8, 10)}.${d.slice(5, 7)}`).join(', ')})`;
}

function zbudujPlan(contactId, zamowienia) {
  if (!zamowienia.length) throw new Error('Pusta grupa zamówień.');
  if (zamowienia.some(o => o.contactId !== contactId)) throw new Error('Zamówienie innego kontaktu — nie łączymy.');

  const ids = zamowienia.map(o => o.orderId);
  if (new Set(ids).size !== ids.length) throw new Error('Zduplikowane zamówienie w grupie.');

  const kolejne = [...zamowienia].sort((a, b) => (Number(a.numer) || 0) - (Number(b.numer) || 0) || a.orderId.localeCompare(b.orderId));
  const pozycje = [];
  const rabaty = [];

  for (const o of kolejne) {
    const nr = o.numer ? `#${o.numer}` : o.orderId.slice(0, 8);
    const grupy = new Map();

    for (const l of o.linie) {
      const g = grupy.get(`${l.nazwa}|${l.cena}`) || { nazwa: l.nazwa, cena: l.cena, ilosc: 0, daty: [] };
      g.ilosc += l.ilosc;
      g.daty.push(l.data);
      grupy.set(`${l.nazwa}|${l.cena}`, g);
    }

    for (const g of grupy.values()) {
      pozycje.push({
        nazwa: g.nazwa,
        opis: `${CFG.tytul}: ${g.ilosc} ${wizyt(g.ilosc)}${opisDat(g.daty)} — zamówienie ${nr}`,
        cena: g.cena,
        ilosc: g.ilosc
      });
    }

    for (const r of o.rabaty.filter(r => r.kwota)) {
      const klucz = `${o.orderId}/${r.discountId}`;
      if (rabaty.some(x => x.klucz === klucz)) throw new Error(`Rabat ${klucz} dwukrotnie.`);
      rabaty.push({ klucz, kwota: r.kwota, opis: r.opis });
      if (CFG.rabatJako === 'POZYCJA') {
        pozycje.push({ nazwa: 'Rabat', opis: `${r.opis} — zamówienie ${nr}`, cena: -r.kwota, ilosc: 1 });
      }
    }
  }

  const razem = suma(kolejne, o => o.razem);
  const sumaRabatow = suma(rabaty, r => r.kwota);
  const rabatFaktury = CFG.rabatJako === 'RABAT_FAKTURY' ? sumaRabatow : 0;

  if (sumaRabatow !== suma(kolejne, o => o.rabat)) throw new Error('Rabaty faktury ≠ rabaty zamówień.');
  if (suma(pozycje, p => p.cena * p.ilosc) - rabatFaktury !== razem) throw new Error('Pozycje faktury ≠ wartość zamówień.');
  if (razem <= 0) throw new Error('Faktura ≤ 0 zł.');

  const orderIds = [...ids].sort();
  const plan = {
    operationId: operationId(CFG.miesiac, contactId, orderIds),
    contactId,
    orderIds,
    numery: kolejne.map(o => o.numer),
    pozycje,
    rabatFaktury,
    brutto: suma(kolejne, o => o.brutto),
    rabaty: sumaRabatow,
    razem
  };

  plan.fingerprint = hash({
    orderIds,
    pozycje,
    rabatFaktury,
    zamowienia: kolejne.map(o => [o.orderId, o.razem, o.rabat, o.paymentStatus])
  });

  return plan;
}

// ======================================================
// FAKTURA (wix-billing-backend)
// ======================================================

function wyciagnijKontakt(raw) {
  const c = raw?.contact || raw;
  const first = c?.info?.name?.first || '';
  const last = c?.info?.name?.last || '';
  const emails = c?.info?.emails?.items || c?.info?.emails || [];
  const phones = c?.info?.phones?.items || c?.info?.phones || [];
  const pierwszy = (list, k) => (Array.isArray(list) ? (list.find(x => x.primary) || list[0])?.[k] : '') || '';

  return {
    contactId: idOf(c) || '',
    firstName: first,
    lastName: last,
    fullName: [first, last].filter(Boolean).join(' '),
    email: c?.primaryInfo?.email || pierwszy(emails, 'email'),
    phone: c?.primaryInfo?.phone || pierwszy(phones, 'phone')
  };
}

function polaFaktury(plan, k, teraz) {
  if (k.contactId !== plan.contactId) throw new Error('Kontakt faktury ≠ kontakt planu.');
  if (!k.email) throw new Error('Kontakt bez adresu e-mail.');

  const pola = {
    title: CFG.tytul,
    customer: {
      contactId: k.contactId,
      email: k.email,
      ...(k.firstName && { firstName: k.firstName }),
      ...(k.lastName && { lastName: k.lastName }),
      ...(k.fullName && { fullName: k.fullName }),
      ...(k.phone && { phone: k.phone })
    },
    currency: 'PLN',
    lineItems: plan.pozycje.map((p, i) => ({
      id: `poz-${i + 1}`,
      name: p.nazwa,
      description: p.opis,
      price: p.cena / 100,
      quantity: p.ilosc
    })),
    dates: {
      issueDate: teraz,
      dueDate: new Date(teraz.getTime() + CFG.dniNaPlatnosc * 86400000)
    },
    metadata: {
      notes: `Zamówienia: ${plan.numery.map(n => '#' + n).join(', ')}`,
      source: 'toto-faktury-v2',
      sourceRefId: plan.operationId
    }
  };

  if (plan.rabatFaktury) pola.discount = { value: plan.rabatFaktury / 100, type: 'Fixed' };
  return pola;
}

/**
 * Kontrola faktury z getInvoice() przed wysyłką: kontakt, PLN, powiązanie
 * z operacją, każda pozycja (nazwa, ilość, cena), rabat i suma względem
 * planu zapisanego w dzienniku. Brak pola = problem.
 */
function sprawdzFakture(f, op) {
  if (!f) return ['Nie odczytano faktury.'];

  const p = [];
  const kwota = (v, nazwa) => {
    try {
      return groszeWymagane(v, nazwa);
    } catch (e) {
      p.push(e.message);
      return null;
    }
  };

  if (f.id?.id !== op.invoiceId) p.push('Faktura ma inne ID.');
  if (f.customer?.contactId !== op.klientContactId) p.push('Faktura na inny kontakt.');
  if (f.currency !== 'PLN') p.push(`Waluta faktury: ${f.currency || 'brak'}.`);
  if (f.metadata?.sourceRefId !== op._id) {
    p.push(f.metadata?.sourceRefId ? 'Faktura innej operacji.' : 'Faktura bez metadata.sourceRefId.');
  }

  const total = kwota(f.totals?.total, 'totals.total');
  if (total !== null && total !== op.kwotaGrosze) p.push(`Suma ${zl(total)} ≠ ${zl(op.kwotaGrosze)}.`);

  const plan = op.pozycje || [];
  const linie = Array.isArray(f.lineItems) ? f.lineItems : [];

  if (!plan.length || linie.length !== plan.length) {
    p.push('Liczba pozycji faktury ≠ planu.');
  } else {
    plan.forEach((x, i) => {
      const l = linie[i];
      if (norm(l.name) !== norm(x.nazwa)) p.push(`Pozycja ${i + 1}: nazwa „${l.name}” ≠ „${x.nazwa}”.`);
      if (Number(l.quantity) !== x.ilosc) p.push(`Pozycja ${i + 1}: ilość ${l.quantity} ≠ ${x.ilosc}.`);
      const c = kwota(l.price, `cena pozycji ${i + 1}`);
      if (c !== null && c !== x.cena) p.push(`Pozycja ${i + 1}: cena ${zl(c)} ≠ ${zl(x.cena)}.`);
    });
  }

  const rabat = pusta(f.discount?.value) ? 0 : kwota(f.discount.value, 'rabat faktury');
  if (rabat !== null && rabat !== (op.rabatFaktury || 0)) p.push(`Rabat faktury ${zl(rabat)} ≠ ${zl(op.rabatFaktury || 0)}.`);

  return p;
}

// Struktura getInvoice bez danych osobowych (tryb PROBE).
function strukturaFaktury(f) {
  const klucze = v => (v && typeof v === 'object' ? Object.keys(v).sort() : []);
  const linie = Array.isArray(f?.lineItems) ? f.lineItems : [];
  const wymagane = {
    'id.id': typeof f?.id?.id === 'string',
    'id.version': typeof f?.id?.version === 'number',
    currency: typeof f?.currency === 'string',
    'customer.contactId': typeof f?.customer?.contactId === 'string',
    'metadata.sourceRefId': f?.metadata?.sourceRefId !== undefined,
    'totals.total': f?.totals?.total !== undefined,
    'lineItems[].name/price/quantity': linie.length > 0 &&
      linie.every(l => typeof l.name === 'string' && l.price !== undefined && l.quantity !== undefined),
    wasSent: typeof f?.wasSent === 'boolean'
  };

  return {
    klucze: klucze(f),
    statusFaktury: f?.status,
    wasSent: f?.wasSent,
    waluta: f?.currency,
    customerKlucze: klucze(f?.customer),
    metadataKlucze: klucze(f?.metadata),
    totalsKlucze: klucze(f?.totals),
    discount: f?.discount ? { klucze: klucze(f.discount), type: f.discount.type } : null,
    liczbaPozycji: linie.length,
    pozycjaKlucze: klucze(linie[0]),
    cenaTyp: typeof linie[0]?.price,
    brakujaceDlaKontroli: Object.keys(wymagane).filter(k => !wymagane[k])
  };
}

// ======================================================
// ANALIZA MIESIĄCA
// ======================================================

function analizuj(stan) {
  const ostrzezenia = [];
  const zamowienia = [];
  const cykleBezZamowien = [];
  const ileNaUmowe = new Map();
  const ileNaZamowienie = new Map();

  for (const r of stan.rows) {
    ileNaUmowe.set(r.umowaId, (ileNaUmowe.get(r.umowaId) || 0) + 1);
    if (r.orderId) ileNaZamowienie.set(r.orderId, (ileNaZamowienie.get(r.orderId) || 0) + 1);
  }

  for (const row of stan.rows) {
    const umowa = stan.umowy.get(row.umowaId) || null;
    const klient = umowa?.klientNazwa || row.title || '';

    if (!row.orderId) {
      if (row.status !== 'EMPTY') cykleBezZamowien.push({ umowaId: row.umowaId, klient, status: row.status });
      continue;
    }

    const odczyt = stan.zamowienia.get(row.orderId);
    let zamowienie = null;
    let bladZamowienia = odczyt?.error || (odczyt?.raw ? null : 'Nie odczytano zamówienia.');

    if (odczyt?.raw) {
      try {
        zamowienie = normalizujZamowienie(odczyt.raw);
      } catch (e) {
        bladZamowienia = `Nieczytelne zamówienie: ${e.message}`;
      }
    }

    const problemyPowiazania = zamowienie ? sprawdzPowiazanie(zamowienie, row, umowa) : [];
    if (ileNaUmowe.get(row.umowaId) > 1) problemyPowiazania.push('Kilka cykli tej umowy.');
    if (ileNaZamowienie.get(row.orderId) > 1) problemyPowiazania.push('To samo zamówienie w kilku cyklach.');

    // Inne AKTYWNE zamówienia tej umowy (anulowane poprzedniki napraw pomijamy).
    const inne = stan.indeksKluczy
      ? kluczeWyszukiwania(CFG.miesiac, row.umowaId)
        .flatMap(k => stan.indeksKluczy.get(k) || [])
        .filter(x => x.id !== row.orderId && x.status !== 'CANCELED')
        .map(x => `${x.id} (${x.status})`)
      : null;

    const przypisanie = stan.przypisania.get(row.orderId) || null;

    const w = {
      row,
      klient,
      zamowienie,
      bladZamowienia,
      problemyPowiazania,
      inneZamowienia: inne,
      fakturyWix: stan.fakturyWix ? stan.fakturyWix.get(row.orderId) || [] : null,
      transakcje: stan.transakcje ? stan.transakcje.get(row.orderId) || {} : null,
      obceWpisy: stan.obceWpisy.filter(x => x.klientContactId === row.klientContactId).map(x => x._id),
      przypisanie,
      operacja: przypisanie ? stan.operacje.get(przypisanie.operationId) || null : null
    };

    klasyfikuj(w);
    zamowienia.push(w);
  }

  // Grupowanie wyłącznie po contactId.
  const grupy = new Map();
  for (const w of zamowienia.filter(x => x.kategoria === K.DO_FAKTURY)) {
    const c = w.zamowienie.contactId;
    grupy.set(c, [...(grupy.get(c) || []), w]);
  }

  const plany = [];
  for (const [contactId, list] of grupy) {
    try {
      const plan = zbudujPlan(contactId, list.map(w => w.zamowienie));
      plan.klient = list[0].klient;
      plany.push(plan);
    } catch (e) {
      list.forEach(w => Object.assign(w, { kategoria: K.DO_SPRAWDZENIA, powod: `Plan faktury: ${e.message}` }));
    }
  }

  const nazwy = new Map();
  for (const w of zamowienia) {
    const n = norm(w.klient);
    if (n) nazwy.set(n, new Set([...(nazwy.get(n) || []), w.row.klientContactId]));
  }
  for (const [n, s] of nazwy) {
    if (s.size > 1) ostrzezenia.push(`Nazwa „${n}” u ${s.size} różnych kontaktów — faktury osobne.`);
  }

  const wpisyBezKontaktu = stan.obceWpisy.filter(x => !x.klientContactId).map(x => x._id);
  const sumy = policzSumy(zamowienia, plany, cykleBezZamowien, wpisyBezKontaktu);

  // Liczba i suma wszystkich faktur miesiąca (istniejące operacje + nowe
  // plany) — stała między kolejnymi RUN, dopóki dane się nie zmienią.
  const aktywne = [...stan.operacje.values()].filter(op => op.status !== S.CANCELLED);
  const nowe = plany.filter(p => !aktywna(aktywne, p.operationId));
  const doZatwierdzenia = {
    liczba: aktywne.length + nowe.length,
    suma: zl(suma(aktywne, op => op.kwotaGrosze || 0) + suma(nowe, p => p.razem))
  };

  return { zamowienia, plany, cykleBezZamowien, sumy, doZatwierdzenia, ostrzezenia, bledyGlobalne: stan.bledyGlobalne };
}

// Anulowana operacja nie blokuje poprawionego planu z tym samym ID
// (journal.przygotuj otwiera ją ponownie z nowymi kwotami).
const aktywna = (operacje, id) => operacje.some(op => op._id === id && op.status !== S.CANCELLED);

function kwotaDoSum(w) {
  if (w.zamowienie) return w.zamowienie.razem;
  const k = w.row.kwota;
  return typeof k === 'number' && Number.isFinite(k) && k > 0 ? Math.round(k * 100) : null;
}

/**
 * Sumy kontrolne. arytmetykaOk: należności nie znikają między kategoriami.
 * braki: kompletność źródeł (nieodczytane / bez kwoty / zdublowane
 * zamówienia, cykle bez zamówień, wpisy dziennika bez kontaktu) — RUN
 * wymaga, by administrator wymienił je dokładnie w akceptujBraki.
 */
function policzSumy(zamowienia, plany, cykleBezZamowien, wpisyBezKontaktu) {
  const widziane = new Set();
  const zdublowane = new Set();
  const unikalne = [];

  for (const w of zamowienia) {
    if (widziane.has(w.row.orderId)) zdublowane.add(w.row.orderId);
    else unikalne.push(w);
    widziane.add(w.row.orderId);
  }

  const s = list => suma(list, w => kwotaDoSum(w) ?? 0);
  const wKat = k => unikalne.filter(w => w.kategoria === k);
  const znane = unikalne.filter(w => w.zamowienie);

  const r = {
    brutto: suma(znane, w => w.zamowienie.brutto),
    rabaty: suma(znane, w => w.zamowienie.rabat),
    netto: s(unikalne),
    juzRozliczone: s(wKat(K.ROZLICZONE)),
    doNowychFaktur: s(wKat(K.DO_FAKTURY)) + s(wKat(K.W_PRZYGOTOWANIU)),
    doSprawdzenia: s(wKat(K.DO_SPRAWDZENIA)),
    anulowane: s(wKat(K.ANULOWANE)),
    zerowe: s(wKat(K.ZEROWE)),
    sumaNowychPlanow: suma(plany, p => p.razem)
  };

  const kontrole = {
    rozbicieZgodne: r.juzRozliczone + r.doNowychFaktur + r.doSprawdzenia + r.anulowane + r.zerowe === r.netto,
    planyZgodne: r.sumaNowychPlanow === s(wKat(K.DO_FAKTURY)),
    rabatyZgodne: r.brutto - r.rabaty === suma(znane, w => w.zamowienie.razem)
  };

  const braki = [...new Set([
    ...unikalne.filter(w => kwotaDoSum(w) === null || !w.zamowienie).map(w => w.row.orderId),
    ...zdublowane,
    ...cykleBezZamowien.map(c => c.umowaId),
    ...wpisyBezKontaktu
  ])].sort();

  return {
    zl: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, zl(v)])),
    grosze: r,
    liczby: Object.fromEntries(Object.values(K).map(k => [k, wKat(k).length])),
    nieznanychKwot: unikalne.filter(w => kwotaDoSum(w) === null).length,
    kontrole,
    arytmetykaOk: Object.values(kontrole).every(Boolean),
    braki,
    kontroleOk: Object.values(kontrole).every(Boolean) && !braki.length
  };
}

function wierszTabeli(w) {
  const o = w.zamowienie;
  const kw = kwotaDoSum(w);
  return {
    klient: w.klient,
    contactId: w.row.klientContactId,
    umowaId: w.row.umowaId,
    orderId: w.row.orderId,
    numer: o?.numer || '',
    klucz: o ? o.externalOrderId || '(brak)' : '',
    usluga: o ? [...new Set(o.linie.map(l => l.nazwa))].join(', ') : '',
    wizyty: o ? suma(o.linie, l => l.ilosc) : null,
    brutto: o ? zl(o.brutto) : '',
    rabaty: o ? o.rabaty.map(r => `${zl(r.kwota)} (${r.opis})`).join('; ') : '',
    netto: o ? zl(o.razem) : kw === null ? 'NIEZNANA' : `~${zl(kw)}`,
    zamowienie: o ? `${o.status}/${o.paymentStatus}` : '',
    fakturyWix: w.fakturyWix ? w.fakturyWix.map(idOf).join(', ') : 'NIEZNANE',
    dziennik: w.operacja ? `${w.operacja.status} ${w.operacja.invoiceId || ''}`.trim() : '',
    kategoria: w.kategoria,
    powod: w.powod
  };
}

// ======================================================
// DZIENNIK I BLOKADA
// ======================================================

function createJournal(db, opts = {}) {
  const now = opts.now || (() => new Date());

  async function wiersze() {
    const rows = await db.find(CFG.dziennik, { miesiac: CFG.miesiac });
    return {
      operacje: new Map(rows.filter(r => r.rodzaj === FAKTURA).map(r => [r._id, r])),
      przypisania: new Map(rows.filter(r => r.rodzaj === ZAMOWIENIE).map(r => [r.orderId, r])),
      obce: rows.filter(r => r.rodzaj !== FAKTURA && r.rodzaj !== ZAMOWIENIE)
    };
  }

  // Zmiana stanu: kontrola statusu, zapis kopii, odczyt potwierdzający.
  async function zmien(op, oczekiwane, patch) {
    const obecny = await db.get(CFG.dziennik, op._id);

    if (!obecny || !oczekiwane.includes(obecny.status)) {
      throw blad(`Operacja ${op._id} ma status ${obecny?.status}, oczekiwano ${oczekiwane}.`, 'JournalConflictError');
    }

    const nowy = copy({ ...obecny, ...patch });

    try {
      await db.update(CFG.dziennik, nowy);
      const odczyt = await db.get(CFG.dziennik, op._id);
      if (odczyt?.status !== nowy.status || (odczyt.invoiceId || '') !== (nowy.invoiceId || '')) {
        throw new Error('zapis i odczyt różnią się');
      }
      return odczyt;
    } catch (e) {
      throw blad(`Niepotwierdzony zapis dziennika ${op._id}: ${msg(e)}`, 'JournalPersistenceError');
    }
  }

  // Wiersz PREPARED + przypisania zamówień (idempotentne).
  async function przygotuj(plan, audyt) {
    let op = await db.get(CFG.dziennik, plan.operationId);

    if (!op) {
      await db.insert(CFG.dziennik, {
        _id: plan.operationId,
        title: `${CFG.miesiac} | ${plan.klient} | ${plan.orderIds.length} zam.`,
        rodzaj: FAKTURA,
        miesiac: CFG.miesiac,
        klientContactId: plan.contactId,
        klientNazwa: plan.klient,
        orderIds: plan.orderIds,
        numeryZamowien: plan.numery,
        status: S.PREPARED,
        invoiceId: '',
        invoiceVersion: null,
        kwota: plan.razem / 100,
        kwotaGrosze: plan.razem,
        pozycje: plan.pozycje,
        rabatFaktury: plan.rabatFaktury,
        fingerprint: plan.fingerprint,
        utworzenieRozpoczete: false,
        audyt,
        powod: '',
        blad: ''
      });
      op = await db.get(CFG.dziennik, plan.operationId);
      if (!op) throw blad('Wiersz operacji nie został zapisany.', 'JournalPersistenceError');
    } else if (op.status === S.CANCELLED) {
      op = await zmien(op, [S.CANCELLED], {
        status: S.PREPARED,
        numeryZamowien: plan.numery,
        kwota: plan.razem / 100,
        kwotaGrosze: plan.razem,
        pozycje: plan.pozycje,
        rabatFaktury: plan.rabatFaktury,
        fingerprint: plan.fingerprint,
        audyt,
        powod: '',
        blad: ''
      });
    }

    if (op.status !== S.PREPARED) return op;

    for (const orderId of plan.orderIds) {
      const id = claimId(orderId);
      try {
        await db.insert(CFG.dziennik, { _id: id, title: `${CFG.miesiac} | zamówienie ${orderId}`, rodzaj: ZAMOWIENIE, miesiac: CFG.miesiac, orderId, klientContactId: plan.contactId, operationId: plan.operationId });
      } catch (e) {
        const c = await db.get(CFG.dziennik, id);
        // Brak wiersza = błąd zapisu, nie konflikt: PREPARED dokończy kolejny RUN.
        if (!c) throw blad(`Nie zapisano przypisania ${orderId}: ${msg(e)}`, 'JournalPersistenceError');
        if (c.operationId !== plan.operationId) {
          return zmien(op, [S.PREPARED], { status: S.NEEDS_REVIEW, powod: 'KONFLIKT', blad: `Zamówienie ${orderId} przypisane do ${c.operationId}.` });
        }
      }
    }

    return zmien(op, [S.PREPARED], { status: S.APPROVED });
  }

  // Anulowanie operacji, która nigdy nie dotarła do createInvoice.
  async function anuluj(op, powod) {
    if (op.utworzenieRozpoczete || op.invoiceId) throw blad('Tworzenie faktury było rozpoczęte.', 'JournalConflictError');
    const n = await zmien(op, [S.PREPARED, S.APPROVED], { status: S.CANCELLED, powod: 'ZMIANA_DANYCH', blad: powod });
    for (const orderId of op.orderIds) {
      const c = await db.get(CFG.dziennik, claimId(orderId));
      if (c?.operationId === op._id) await db.remove(CFG.dziennik, c._id);
    }
    return n;
  }

  async function ostatniaFaktura() {
    const rows = (await db.find(CFG.dziennik, {})).filter(r => r.invoiceId);
    rows.sort((a, b) => String(b._createdDate || '').localeCompare(String(a._createdDate || '')));
    return rows[0] || null;
  }

  // Blokada globalna bez automatycznego przejmowania (jak generatorUmow.js).
  async function zablokuj() {
    const token = randomBytes(12).toString('hex');

    try {
      await db.insert(CFG.blokady, { _id: LOCK_ID, title: `Faktury ${CFG.miesiac}`, token });
    } catch (e) {
      const l = await db.get(CFG.blokady, LOCK_ID);
      if (!l) throw e;
      const wiek = now().getTime() - new Date(l._createdDate).getTime();
      throw blad(
        wiek > CFG.blokadaMs
          ? 'Blokada starsza niż 5 min — poprzednie wywołanie przerwane. Sprawdź logi i usuń wiersz „Faktury 2026-11” w GeneratorBlokady.'
          : 'Trwa inne uruchomienie fakturowania.',
        'BusyError'
      );
    }

    return {
      async pilnuj() {
        const l = await db.get(CFG.blokady, LOCK_ID);
        if (l?.token !== token) throw blad('Utracono blokadę.', 'LockLostError');
      },
      async zwolnij() {
        const l = await db.get(CFG.blokady, LOCK_ID);
        if (l?.token === token) await db.remove(CFG.blokady, LOCK_ID);
      }
    };
  }

  return { wiersze, zmien, przygotuj, anuluj, ostatniaFaktura, zablokuj, operacja: id => db.get(CFG.dziennik, id) };
}

// ======================================================
// INTEGRACJA WIX
// ======================================================

const READ = { suppressAuth: true, suppressHooks: true, consistentRead: true };
const WRITE = { suppressAuth: true, suppressHooks: true };

const kawalki = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

function createGateway() {
  const searchOrders = auth.elevate(orders.searchOrders);
  const getOrder = auth.elevate(orders.getOrder);
  const listInvoices = auth.elevate(orderInvoices.listInvoicesForMultipleOrders);
  const listTransactions = auth.elevate(orderTransactions.listTransactionsForMultipleOrders);
  const createInvoice = elevate(invoices.createInvoice);
  const getInvoice = elevate(invoices.getInvoice);
  const sendInvoice = elevate(invoices.sendInvoice);

  const db = {
    async get(c, id) {
      return (await wixData.query(c).eq('_id', id).limit(1).find(READ)).items[0] || null;
    },
    insert: (c, item) => wixData.insert(c, copy(item), WRITE),
    update: (c, item) => wixData.update(c, copy(item), WRITE),
    remove: (c, id) => wixData.remove(c, id, WRITE),
    async find(c, eq) {
      const out = [];
      for (let skip = 0; ; skip += 100) {
        let q = wixData.query(c);
        for (const [k, v] of Object.entries(eq)) q = q.eq(k, v);
        const page = await q.ascending('_id').skip(skip).limit(100).find(READ);
        out.push(...page.items);
        if (page.items.length < 100) return out;
      }
    }
  };

  // Mapa id → wynik albo null, gdy odczyt się nie powiódł (= „nieznane”).
  async function wgZamowien(ids, fn, pole, wartosc) {
    try {
      const map = new Map();
      for (const part of kawalki(ids, 100)) {
        const r = await fn(part);
        for (const x of r[pole] || []) map.set(x.orderId, wartosc(x));
        if (part.some(id => !map.has(id))) throw new Error('Niepełna odpowiedź.');
      }
      return map;
    } catch (e) {
      console.warn('FAKTURY_ODCZYT', pole, msg(e));
      return null;
    }
  }

  return {
    db,

    wierszeCykli: () => db.find(CFG.cykle, { miesiac: CFG.miesiac }),

    async umowy(ids) {
      const out = new Map();
      for (const part of kawalki(ids, 100)) {
        const r = await wixData.query(CFG.umowy).hasSome('_id', part).limit(100).find(READ);
        r.items.forEach(x => out.set(x._id, x));
      }
      return out;
    },

    // Search Orders (id $in); brakujące i odrzucone — getOrder.
    async zamowienia(ids) {
      const out = new Map();
      for (const part of kawalki(ids, 100)) {
        try {
          const r = await searchOrders({ filter: { id: { $in: part } }, cursorPaging: { limit: 100 } });
          if ((r.orders || []).some(o => !part.includes(idOf(o)))) break; // filtr zignorowany
          (r.orders || []).forEach(o => out.set(idOf(o), { raw: o }));
        } catch (e) {
          console.warn('FAKTURY_SEARCH_ORDERS', msg(e));
          break;
        }
      }
      for (const part of kawalki(ids.filter(id => !out.has(id)), 5)) {
        await Promise.all(part.map(async id => {
          try {
            out.set(id, { raw: await getOrder(id) });
          } catch (e) {
            out.set(id, { error: `getOrder: ${msg(e)}` });
          }
        }));
      }
      return out;
    },

    // externalOrderId → [{ id, status }]; null = nie sprawdzono.
    async indeksKluczy(klucze) {
      try {
        const map = new Map();
        for (const part of kawalki([...new Set(klucze)], 100)) {
          const r = await searchOrders({ filter: { 'channelInfo.externalOrderId': { $in: part } }, cursorPaging: { limit: 100 } });
          if (r.metadata?.hasNext) throw new Error('Więcej niż 100 wyników.');
          for (const o of r.orders || []) {
            const k = o.channelInfo?.externalOrderId;
            if (!part.includes(k)) throw new Error('Filtr externalOrderId zignorowany.');
            map.set(k, [...(map.get(k) || []), { id: idOf(o), status: o.status }]);
          }
        }
        return map;
      } catch (e) {
        console.warn('FAKTURY_INDEKS', msg(e));
        return null;
      }
    },

    fakturyZamowien: ids => wgZamowien(ids, listInvoices, 'invoicesForOrder', x => x.invoicesInfo || []),

    transakcje: ids => wgZamowien(ids, listTransactions, 'orderTransactions', x => ({ payments: x.payments || [], refunds: x.refunds || [] })),

    kontakt: id => contacts.getContact(id, { suppressAuth: true }),

    // createInvoice → { id: { id, version } }
    utworzFakture: pola => createInvoice(pola),

    pobierzFakture: id => getInvoice(id),

    // sendInvoice wymaga płaskiego { id, version }
    wyslijFakture: (id, version, email) => sendInvoice({ id, version }, email)
  };
}

// ======================================================
// PROCES
// ======================================================

function createProcess({ gateway, journal, now = () => new Date(), log = console }) {
  async function wczytajStan() {
    const rows = await gateway.wierszeCykli();
    const orderIds = [...new Set(rows.map(r => r.orderId).filter(Boolean))];
    const umowaIds = [...new Set(rows.map(r => r.umowaId).filter(Boolean))];
    const klucze = umowaIds.flatMap(u => kluczeWyszukiwania(CFG.miesiac, u));

    const [umowy, zamowienia, indeksKluczy, fakturyWix, transakcje, dziennik] = await Promise.all([
      gateway.umowy(umowaIds),
      gateway.zamowienia(orderIds),
      gateway.indeksKluczy(klucze),
      gateway.fakturyZamowien(orderIds),
      gateway.transakcje(orderIds),
      journal.wiersze()
    ]);

    // Operacja PREPARED (przerwana przed zapisem wszystkich przypisań)
    // obejmuje swoje zamówienia — nie mogą trafić do nowego planu.
    for (const op of dziennik.operacje.values()) {
      if (op.status !== S.PREPARED) continue;
      for (const id of op.orderIds) {
        if (!dziennik.przypisania.has(id)) dziennik.przypisania.set(id, { orderId: id, operationId: op._id });
      }
    }

    const bledyGlobalne = [
      indeksKluczy === null && 'Nie sprawdzono innych zamówień umów (Search Orders).',
      fakturyWix === null && 'Nie odczytano faktur zamówień (Order Invoices).',
      transakcje === null && 'Nie odczytano transakcji zamówień (Order Transactions).'
    ].filter(Boolean);

    return {
      rows,
      umowy,
      zamowienia,
      indeksKluczy,
      fakturyWix,
      transakcje,
      operacje: dziennik.operacje,
      przypisania: dziennik.przypisania,
      obceWpisy: dziennik.obce,
      bledyGlobalne
    };
  }

  async function kontaktDla(contactId) {
    try {
      const k = wyciagnijKontakt(await gateway.kontakt(contactId));
      const problemy = [
        k.contactId !== contactId && 'Kontakt scalony lub inne ID.',
        !k.email && 'Kontakt bez e-maila.'
      ].filter(Boolean);
      return { k, problemy };
    } catch (e) {
      return { k: null, problemy: [`Nie odczytano kontaktu: ${msg(e)}`] };
    }
  }

  // ---------------- PREVIEW ----------------

  async function podglad() {
    const stan = await wczytajStan();
    const a = analizuj(stan);

    const kontakty = [];
    for (const part of kawalki(a.plany, 5)) kontakty.push(...await Promise.all(part.map(p => kontaktDla(p.contactId))));
    const emaile = new Map();
    kontakty.forEach(({ k }, i) => {
      const e = (k?.email || '').toLowerCase();
      if (e) emaile.set(e, [...(emaile.get(e) || []), a.plany[i].contactId]);
    });
    for (const [e, ids] of emaile) {
      if (ids.length > 1) a.ostrzezenia.push(`E-mail ${e} u ${ids.length} kontaktów — faktury osobne.`);
    }

    const wynik = {
      tryb: 'PREVIEW',
      sumy: { ...a.sumy.zl, liczby: a.sumy.liczby, nieznanychKwot: a.sumy.nieznanychKwot },
      kontrole: a.sumy.kontrole,
      arytmetykaOk: a.sumy.arytmetykaOk,
      braki: a.sumy.braki,
      kontroleOk: a.sumy.kontroleOk,
      doZatwierdzenia: a.doZatwierdzenia,
      bledyGlobalne: a.bledyGlobalne,
      ostrzezenia: a.ostrzezenia,
      tabela: a.zamowienia.map(wierszTabeli),
      proponowaneFaktury: a.plany.map((p, i) => ({
        operationId: p.operationId,
        klient: p.klient,
        contactId: p.contactId,
        email: kontakty[i].k?.email || '',
        orderIds: p.orderIds,
        pozycje: p.pozycje.map(x => ({ nazwa: x.nazwa, opis: x.opis, cena: zl(x.cena), ilosc: x.ilosc })),
        rabatFaktury: zl(p.rabatFaktury),
        razem: zl(p.razem),
        problemyKontaktu: kontakty[i].problemy
      })),
      cykleBezZamowien: a.cykleBezZamowien,
      doRecznejDecyzji: a.zamowienia
        .filter(w => w.kategoria === K.DO_SPRAWDZENIA)
        .map(w => ({ klient: w.klient, orderId: w.row.orderId, powod: w.powod }))
    };

    wynik.tabela.forEach(x => log.log('FAKTURY_PREVIEW_ZAMOWIENIE', JSON.stringify(x)));
    wynik.proponowaneFaktury.forEach(x => log.log('FAKTURY_PREVIEW_FAKTURA', JSON.stringify(x)));
    log.log('FAKTURY_PREVIEW_SUMY', JSON.stringify({ ...wynik.sumy, kontrole: wynik.kontrole }));
    log.log('FAKTURY_PREVIEW_BRAKI', JSON.stringify(wynik.braki));
    log.log('FAKTURY_PREVIEW_DO_ZATWIERDZENIA', JSON.stringify(wynik.doZatwierdzenia));

    return wynik;
  }

  // ---------------- RUN ----------------

  async function doPrzegladu(op, z, powod, tekst) {
    return journal.zmien(op, [z], { status: S.NEEDS_REVIEW, powod, blad: String(tekst).slice(0, 1000) });
  }

  // Stany pozostawione przez przerwane wywołanie — nigdy nie ponawiamy.
  async function uporzadkuj(operacje) {
    const out = [];
    for (const op of operacje.values()) {
      if (op.status === S.CREATING) {
        out.push(await doPrzegladu(op, S.CREATING, 'CREATE_UNCERTAIN', 'Przerwano w trakcie createInvoice. Sprawdź panel Faktury i log FAKTURA_UTWORZONA.'));
      }
      if (op.status === S.SENDING) {
        const f = await gateway.pobierzFakture(op.invoiceId).catch(() => null);
        out.push(f?.wasSent === true
          ? await journal.zmien(op, [S.SENDING], { status: S.SENT, wyslano: now().toISOString() })
          : await doPrzegladu(op, S.SENDING, 'SEND_UNCERTAIN', 'Przerwano w trakcie sendInvoice; wasSent ≠ true.'));
      }
    }
    return out;
  }

  // Czy operacja nadal odpowiada zamówieniom? (przed createInvoice)
  function aktualny(op, a) {
    const w = op.orderIds.map(id => a.zamowienia.find(x => x.row.orderId === id));
    if (w.some(x => !x || x.bazowa !== K.DO_FAKTURY || (x.przypisanie && x.przypisanie.operationId !== op._id))) {
      return 'Zamówienia operacji nie są już do faktury.';
    }
    try {
      return zbudujPlan(op.klientContactId, w.map(x => x.zamowienie)).fingerprint === op.fingerprint
        ? null
        : 'Zamówienia zmieniły się od zaplanowania.';
    } catch (e) {
      return e.message;
    }
  }

  async function utworz(op, lock, audyt) {
    const { k, problemy } = await kontaktDla(op.klientContactId);
    if (problemy.length) return { op: await doPrzegladu(op, S.APPROVED, 'KONTAKT', problemy.join(' ')) };

    const plan = { ...op, contactId: op.klientContactId, operationId: op._id, numery: op.numeryZamowien };
    const pola = polaFaktury(plan, k, now());

    // Trwały zapis PRZED createInvoice.
    op = await journal.zmien(op, [S.APPROVED], {
      status: S.CREATING,
      utworzenieRozpoczete: true,
      email: k.email,
      audyt: { ...audyt, fingerprint: op.fingerprint },
      blad: ''
    });
    await lock.pilnuj();

    let wynik;
    try {
      wynik = await gateway.utworzFakture(pola);
    } catch (e) {
      // Błąd mógł nastąpić po utworzeniu faktury (np. timeout).
      return { op: await doPrzegladu(op, S.CREATING, 'CREATE_UNCERTAIN', `createInvoice: ${msg(e)}`), stop: true };
    }

    const invoiceId = wynik?.id?.id;
    if (!invoiceId) return { op: await doPrzegladu(op, S.CREATING, 'CREATE_UNCERTAIN', 'createInvoice bez ID.'), stop: true };

    log.log('FAKTURA_UTWORZONA', JSON.stringify({ operationId: op._id, orderIds: op.orderIds, invoiceId, version: wynik.id.version }));

    return {
      op: await journal.zmien(op, [S.CREATING], {
        status: S.CREATED,
        invoiceId,
        invoiceVersion: wynik.id.version ?? null,
        utworzono: now().toISOString()
      })
    };
  }

  async function wyslij(op, lock) {
    let f;
    try {
      f = await gateway.pobierzFakture(op.invoiceId);
    } catch (e) {
      return { op, stop: true, uwaga: `getInvoice: ${msg(e)}` }; // nic nie wysłano
    }

    const problemy = sprawdzFakture(f, op);
    if (problemy.length) return { op: await doPrzegladu(op, S.CREATED, 'INVOICE_MISMATCH', problemy.join(' ')) };
    if (f.wasSent === true) return { op: await journal.zmien(op, [S.CREATED], { status: S.SENT, wyslano: now().toISOString() }) };
    if (/void|cancel|delet|paid/i.test(String(f.status || ''))) {
      return { op: await doPrzegladu(op, S.CREATED, 'INVOICE_STATUS', `Status faktury ${f.status}.`) };
    }

    // Wersja ze świeżego odczytu — rośnie po każdej zmianie faktury.
    const version = f.id.version;
    op = await journal.zmien(op, [S.CREATED], { status: S.SENDING, invoiceVersion: version });
    await lock.pilnuj();

    try {
      await gateway.wyslijFakture(op.invoiceId, version, { subject: CFG.temat, body: CFG.tresc });
    } catch (e) {
      return { op: await doPrzegladu(op, S.SENDING, 'SEND_UNCERTAIN', `sendInvoice: ${msg(e)}`), stop: true };
    }

    return { op: await journal.zmien(op, [S.SENDING], { status: S.SENT, wyslano: now().toISOString(), blad: '' }) };
  }

  function bramka(a, o) {
    if (a.bledyGlobalne.length) return a.bledyGlobalne.join(' ');
    if (!a.sumy.arytmetykaOk) return 'Kontrole sum nie przeszły — uruchom PREVIEW.';
    if ([...new Set(o.akceptujBraki || [])].sort().join(',') !== a.sumy.braki.join(',')) {
      return `Braki kompletności: [${a.sumy.braki.join(', ')}] — rozstrzygnij albo wpisz je dokładnie w akceptujBraki.`;
    }
    if (o.sprawdzilemPanelFaktur !== true || !String(o.kto || '').trim()) {
      return 'Potwierdź sprawdzenie panelu Faktury (sprawdzilemPanelFaktur: true, kto).';
    }
    if (o.oczekiwanaLiczba !== a.doZatwierdzenia.liczba || pusta(o.oczekiwanaSuma) || grosze(o.oczekiwanaSuma) !== grosze(a.doZatwierdzenia.suma)) {
      return `Liczba/suma ≠ PREVIEW (teraz: ${a.doZatwierdzenia.liczba} faktur, ${a.doZatwierdzenia.suma} zł).`;
    }
    return null;
  }

  async function wykonaj(o = {}) {
    const etap = o.etap || 'UTWORZ';
    if (!['UTWORZ', 'WYSLIJ', 'OBA'].includes(etap)) throw new Error('etap: UTWORZ | WYSLIJ | OBA');
    const limit = Math.min(Math.max(Number(o.maxFaktur) || 1, 1), 5);
    const koniec = Date.now() + CFG.maxSekund * 1000;
    const czas = () => koniec - Date.now() > CFG.zapasMs;

    let lock;
    try {
      lock = await journal.zablokuj();
    } catch (e) {
      if (e.name === 'BusyError') return { tryb: 'RUN', status: 'BUSY', blad: e.message };
      throw e;
    }

    try {
      const uporzadkowane = await uporzadkuj((await journal.wiersze()).operacje);
      const a = analizuj(await wczytajStan());

      const odmowa = bramka(a, o);
      if (odmowa) return { tryb: 'RUN', status: 'ODMOWA', blad: odmowa, uporzadkowane: uporzadkowane.map(x => x._id) };

      const wybrany = c => !o.contactIds?.length || o.contactIds.includes(c);
      const operacje = [...(await journal.wiersze()).operacje.values()].filter(op => wybrany(op.klientContactId));
      // Audyt: kto potwierdził panel Faktury, kiedy, jakie braki świadomie
      // pominięto. Zapisywany w operacji przy tworzeniu faktury.
      const audyt = { kto: String(o.kto).trim(), data: now().toISOString(), akceptowaneBraki: a.sumy.braki };

      const kolejka = [
        ...(etap === 'UTWORZ' ? [] : operacje.filter(op => op.status === S.CREATED)),
        ...(etap === 'WYSLIJ' ? [] : [
          ...operacje.filter(op => [S.PREPARED, S.APPROVED].includes(op.status)),
          ...a.plany.filter(p => wybrany(p.contactId) && !aktywna(operacje, p.operationId))
        ])
      ].slice(0, limit);

      const wyniki = [];
      let zatrzymano = '';

      for (let x of kolejka) {
        if (!czas()) {
          zatrzymano = 'Koniec czasu — uruchom ponownie.';
          break;
        }

        await lock.pilnuj();
        let r;

        if (x.status === S.CREATED) {
          r = await wyslij(x, lock);
        } else {
          // Świeży odczyt zamówień przed każdą fakturą — w trakcie partii
          // zamówienie mogło zostać opłacone, anulowane lub zafakturowane.
          const teraz = analizuj(await wczytajStan());
          if (!x.status && !teraz.plany.some(p => p.operationId === x.operationId && p.fingerprint === x.fingerprint)) {
            wyniki.push({ operationId: x.operationId, klient: x.klient, status: 'POMINIETO', uwaga: 'Zamówienia zmieniły się w trakcie partii — sprawdź PREVIEW.' });
            continue;
          }

          // Nowy plan albo PREPARED po awarii → przypisania → APPROVED.
          let op = x.status === S.APPROVED
            ? x
            : await journal.przygotuj(x.status ? { operationId: x._id, orderIds: x.orderIds, contactId: x.klientContactId } : x, audyt);

          if (op.status !== S.APPROVED) {
            r = { op };
          } else {
            const zmiana = aktualny(op, teraz);
            if (zmiana) {
              r = { op: await journal.anuluj(op, zmiana), uwaga: 'Anulowano przed createInvoice — sprawdź PREVIEW.' };
            } else {
              r = await utworz(op, lock, audyt);
              if (!r.stop && r.op.status === S.CREATED && etap === 'OBA' && czas()) r = await wyslij(r.op, lock);
            }
          }
        }

        wyniki.push({ operationId: r.op._id, klient: r.op.klientNazwa, status: r.op.status, kwota: zl(r.op.kwotaGrosze), invoiceId: r.op.invoiceId, powod: r.op.powod || '', uwaga: r.uwaga || r.op.blad || '' });
        if (r.stop) {
          zatrzymano = `Zatrzymano: ${r.op.powod || r.uwaga}.`;
          break;
        }
      }

      const po = [...(await journal.wiersze()).operacje.values()];
      const ile = st => po.filter(op => op.status === st).length;

      return {
        tryb: 'RUN',
        status: 'OK',
        etap,
        uporzadkowane: uporzadkowane.map(x => `${x._id} → ${x.status}`),
        wyniki,
        zatrzymano,
        pozostaloDoUtworzenia: ile(S.APPROVED) + ile(S.PREPARED) + a.plany.filter(p => !aktywna(po, p.operationId)).length,
        pozostaloDoWyslania: ile(S.CREATED),
        doRecznejDecyzji: po.filter(op => op.status === S.NEEDS_REVIEW).map(op => ({ operationId: op._id, klient: op.klientNazwa, powod: op.powod, blad: op.blad }))
      };
    } finally {
      await lock.zwolnij().catch(e => log.error('FAKTURY_BLOKADA', msg(e)));
    }
  }

  // ---------------- STATUS / PROBE ----------------

  async function status() {
    const ops = [...(await journal.wiersze()).operacje.values()];
    const statusy = {};
    ops.forEach(op => { statusy[op.status] = (statusy[op.status] || 0) + 1; });
    return {
      tryb: 'STATUS',
      statusy,
      operacje: ops.map(op => ({ operationId: op._id, klient: op.klientNazwa, status: op.status, kwota: zl(op.kwotaGrosze || 0), invoiceId: op.invoiceId, orderIds: op.orderIds, powod: op.powod || '', blad: op.blad || '' }))
    };
  }

  async function sonda(invoiceId = '') {
    const zrodlo = invoiceId ? 'PROBE_INVOICE_ID' : await journal.ostatniaFaktura();
    const id = invoiceId || zrodlo?.invoiceId;
    if (!id) return { tryb: 'PROBE', status: 'ODMOWA', blad: 'Brak invoiceId.' };
    const f = await gateway.pobierzFakture(id);
    return { tryb: 'PROBE', status: 'OK', zrodlo: invoiceId ? 'PROBE_INVOICE_ID' : `dziennik ${zrodlo.miesiac}`, ...strukturaFaktury(f) };
  }

  return { podglad, wykonaj, status, sonda };
}

// ======================================================
// WYWOŁANIE Z AUTOMATYZACJI
// ======================================================

// Logi Wix ucinają długie wpisy — tablice logujemy element po elemencie.
function zaloguj(wynik) {
  const reszta = {};
  for (const [k, v] of Object.entries(wynik || {})) {
    if (['tabela', 'proponowaneFaktury'].includes(k)) continue; // PREVIEW loguje sam
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      v.forEach(x => console.log(`FAKTURY_${TRYB}_${k}`, JSON.stringify(x)));
      reszta[k] = v.length;
    } else {
      reszta[k] = v;
    }
  }
  console.log(`FAKTURY_${TRYB}`, JSON.stringify(reszta));
}

export const invoke = async () => {
  const gateway = createGateway();
  const p = createProcess({ gateway, journal: createJournal(gateway.db) });

  try {
    const wynik =
      TRYB === 'PREVIEW' ? await p.podglad()
        : TRYB === 'RUN' ? await p.wykonaj(OPCJE_RUN)
          : TRYB === 'STATUS' ? await p.status()
            : TRYB === 'PROBE' ? await p.sonda(PROBE_INVOICE_ID)
              : null;
    if (!wynik) throw new Error(`Nieznany TRYB: ${TRYB}`);
    zaloguj(wynik);
  } catch (e) {
    console.error('FAKTURY_BLAD', TRYB, e?.name || '', msg(e));
    throw e;
  }

  return {};
};

// Wyłącznie dla testów lokalnych (Node, atrapy API Wix).
export const _test = {
  CFG,
  K,
  S,
  LOCK_ID,
  grosze,
  kluczZgodny,
  normalizujZamowienie,
  zbudujPlan,
  operationId,
  polaFaktury,
  sprawdzFakture,
  strukturaFaktury,
  wyciagnijKontakt,
  createJournal,
  createProcess
};
