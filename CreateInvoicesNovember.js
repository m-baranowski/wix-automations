/**
 * Fakturowanie LISTOPAD 2026 — Centrum Terapii Dziecięcej Toto.
 * Jeden plik backendu Wix Velo: backend/CreateInvoicesNovember.js
 *
 * ŹRÓDŁO ROZLICZENIA: zamówienia eCommerce wskazane w UmowyMiesiace.orderId
 * (nie kalendarz, nie data utworzenia zamówienia). Skrypt NIE tworzy
 * zamówień, NIE zmienia harmonogramów, płatności ani istniejących faktur,
 * NIE oznacza zamówień jako opłaconych i NIE wysyła własnych SMS
 * (SMS wysyła istniejąca automatyzacja „Invoice Sent”).
 *
 * Z października zachowano: createInvoice() z wix-billing-backend
 * zwracające { id: { id, version } }, sendInvoice() z PŁASKIM
 * { id, version }, zapis dziennika PRZED createInvoice, log
 * FAKTURA_UTWORZONA przed zapisem ID, blokadę w GeneratorBlokady.
 *
 * ------------------------------------------------------------------
 * ROZLICZENIE
 * ------------------------------------------------------------------
 * Dla każdego wiersza UmowyMiesiace (miesiac = 2026-11, z orderId):
 *  - weryfikacja: kontakt zamówienia = kontakt cyklu = kontakt umowy,
 *    externalOrderId = TOTO:2026-11:{umowaId}, PLN, pozycje = wizyty
 *    BOOKED z planu, cena = stawka, brak innych zamówień z tym kluczem;
 *  - uzgodnienie kwot w groszach: pozycje = subtotal,
 *    suma appliedDiscounts = priceSummary.discount, total = subtotal − rabat;
 *  - klasyfikacja:
 *      NOT_PAID, bez faktury, bez transakcji .... DO_FAKTURY
 *      faktura już jest (Wix lub dziennik) ...... ROZLICZONE (bez 2. faktury)
 *      PAID bez potwierdzonej faktury ........... DO_SPRAWDZENIA
 *      PARTIALLY_PAID / PENDING / zwroty ........ DO_SPRAWDZENIA
 *      anulowane ................................ ANULOWANE
 *      0 zł po rabacie .......................... ZEROWE
 *  - łączenie DO_FAKTURY wyłącznie po contactId (nigdy po nazwie/e-mailu);
 *  - faktura: pozycja usługi na zamówienie + OSOBNA UJEMNA POZYCJA dla
 *    każdego rabatu (klucz orderId/discountId — rabat dokładnie raz),
 *    tytuł „Listopad 2026”, PLN, termin 5 dni, dane nabywcy z Contacts,
 *    metadata.sourceRefId = operationId.
 *  Przykład: A logopedia 4×160 + B neurologopedia 4×180 = jedna
 *  faktura, dwie pozycje, 1360 zł, orderIds [A, B].
 *
 * ------------------------------------------------------------------
 * DZIENNIK FakturyMiesieczne (wiersze październikowe bez zmian)
 * ------------------------------------------------------------------
 * Nowe pole `rodzaj` rozróżnia dwa typy wierszy (dodaj pola w CMS,
 * aby były widoczne w tabeli):
 *  FAKTURA    _id = operationId = hash(miesiąc, contactId, posortowane
 *             orderIds). Pola: status, invoiceId, invoiceVersion,
 *             orderIds, numeryZamowien, umowaIds, klientContactId,
 *             klientNazwa, email, kwota, kwotaGrosze, bruttoGrosze,
 *             rabatyGrosze, pozycje, rabaty, trybRabatu, fingerprint,
 *             utworzenieRozpoczete, wysylkaRozpoczeta, proby,
 *             powodPrzegladu, blad, znaczniki czasu, writeToken, historia.
 *  ZAMOWIENIE _id = hash(orderId). Pola: orderId, operationId,
 *             klientContactId, miesiac. Wix odrzuca insert istniejącego
 *             _id, więc zamówienie trafia najwyżej do jednej faktury.
 * Statusy: PREPARED → APPROVED → CREATING → CREATED → SENDING → SENT,
 *          NEEDS_REVIEW, CANCELLED, CLOSED_MANUALLY.
 *
 * ------------------------------------------------------------------
 * URUCHAMIANIE — automatyzacja z akcją „Run Velo Code”
 * ------------------------------------------------------------------
 * Jak w październiku: ustaw TRYB i OPCJE w sekcji URUCHOMIENIE poniżej,
 * zapisz plik, uruchom automatyzację (wyzwalacz testowy). Wynik jest
 * w logach (Monitoring / Logi strony) z prefiksem FAKTURY_.
 * Po każdej zmianie TRYBU zapisz plik przed wywołaniem automatyzacji.
 * Ponowne lub podwójne odpalenie automatyzacji jest bezpieczne:
 * równoległe wywołanie dostaje BUSY, a dziennik nie pozwala utworzyć
 * ani wysłać tej samej faktury drugi raz.
 *
 * KOLEJNOŚĆ PRACY
 * 1. TRYB 'PREVIEW' — tylko odczyt. Logi: FAKTURY_PREVIEW_ZAMOWIENIE
 *    (tabela zamówień), FAKTURY_PREVIEW_FAKTURA (proponowane faktury),
 *    FAKTURY_PREVIEW_SUMY (brutto, rabaty, netto, już rozliczone,
 *    do nowych faktur, do sprawdzenia, anulowane, zerowe),
 *    FAKTURY_PREVIEW_KONTROLE, FAKTURY_PREVIEW_doRecznejDecyzji.
 *    Wymagane: kontroleOk = true (arytmetykaOk i kompletne),
 *    bledyGlobalne = []. Braki kompletności (sumy.braki: nieodczytane
 *    lub bez kwoty zamówienia, zdublowane orderId, cykle bez zamówień,
 *    wpisy dziennika bez kontaktu) trzeba rozstrzygnąć albo świadomie
 *    wyłączyć, podając DOKŁADNIE te ID w akceptujNiekompletne.
 * 2. TRYB 'PREPARE' — zapis PREPARED + przypisania. Bez faktur.
 *    Log FAKTURY_PREPARE podaje doZatwierdzenia: liczba i suma.
 * 3. TRYB 'APPROVE' — wpisz w OPCJE.APPROVE oczekiwanaLiczba
 *    i oczekiwanaSuma z PREVIEW/PREPARE; niezgodność = odmowa.
 *    AUDYT: najpierw sprawdź w panelu Faktury, że zatwierdzani klienci
 *    nie mają już faktur za listopad wystawionych poza dziennikiem
 *    (ręcznie, starym skryptem) — API Wix tego nie wykrywa. Potem
 *    audytFaktur = { sprawdzono: true, kto, zakres }. Audyt zapisuje
 *    się w każdej operacji z miesiącem, kontaktem, orderIds
 *    i fingerprintem; RUN bez aktualnego audytu = NEEDS_REVIEW /
 *    BRAK_AUDYTU, bez faktury.
 * 4. TRYB 'RUN', OPCJE.RUN = { maxOperacji: 1, etap: 'UTWORZ',
 *    operationIds: ['<id>'] } — faktura próbna (najlepiej klient
 *    z rabatem), obejrzyj w panelu Faktury. Jeżeli Wix odrzuci ujemną
 *    pozycję: trybRabatu = 'INVOICE_DISCOUNT', RESOLVE 'ANULUJ'
 *    niezrealizowane operacje i ponów kroki 2–3.
 * 5. TRYB 'RUN', etap 'WYSLIJ', ten sam operationId — sprawdź e-mail i SMS.
 * 6. TRYB 'RUN', OPCJE.RUN = { maxOperacji: 2, etap: 'OBA',
 *    operationIds: [] } — odpalaj automatyzację, aż log FAKTURY_RUN
 *    pokaże pozostaloDoUtworzenia = 0 i pozostaloDoWyslania = 0.
 * 7. TRYB 'STATUS', potem 'PREVIEW': doNowychFaktur = 0, netto bez zmian.
 * Na koniec ustaw TRYB = 'PREVIEW' (najbezpieczniejszy) albo usuń
 * automatyzację.
 * RUN przed każdą fakturą ponownie czyta zamówienia; zmiana (opłata,
 * faktura, rabat, anulowanie) → NEEDS_REVIEW / ZMIANA_DANYCH, bez faktury.
 *
 * ------------------------------------------------------------------
 * WZNOWIENIE PO TIMEOUCIE
 * ------------------------------------------------------------------
 * - BUSY: inne wywołanie trwa — poczekaj i odpal ponownie.
 * - LOCK_REVIEW (blokada > 5 min): sprawdź logi, potem TRYB 'UNLOCK'
 *   z OPCJE.UNLOCK.potwierdzam = true.
 * - Ponowny RUN: CREATING → NEEDS_REVIEW/CREATE_UNCERTAIN
 *   (bez ponownego tworzenia); SENDING → SENT, jeśli getInvoice().wasSent,
 *   inaczej NEEDS_REVIEW/SEND_UNCERTAIN; CREATED → wysyłka;
 *   APPROVED → utworzenie.
 *
 * ------------------------------------------------------------------
 * STANY NIEPEWNE — TRYB 'RESOLVE', OPCJE.RESOLVE = { operationId, decyzja, ... }
 * ------------------------------------------------------------------
 *  CREATE_UNCERTAIN: szukaj w panelu Faktury (kontakt, „Listopad 2026”,
 *    kwota) i w logach FAKTURA_UTWORZONA.
 *      jest   → decyzja 'FAKTURA_ISTNIEJE', invoiceId (sprawdzane:
 *               kontakt, suma, metadata.sourceRefId)
 *      brak   → 'FAKTURY_BRAK', potwierdzam: true (wraca do APPROVED)
 *  SEND_UNCERTAIN: panel, skrzynka klienta, SMS.
 *      wysłana → 'WYSLANA';  nie dotarła → 'WYSLIJ_PONOWNIE', potwierdzam
 *  INVOICE_MISMATCH / INVOICE_STATUS: nie wysyłaj; popraw ręcznie →
 *      'ZAMKNIJ_RECZNIE' + uwagi
 *  ZMIANA_DANYCH / KONTAKT / KWOTA / BRAK_AUDYTU (przed createInvoice):
 *      'ANULUJ' i ponowne PREPARE + APPROVE z audytem.
 *  Kontrola faktury (przed wysyłką i przy FAKTURA_ISTNIEJE) porównuje
 *  kontakt, PLN, metadata.sourceRefId, KAŻDĄ pozycję (nazwa, ilość,
 *  cena), rabat faktury i sumę z planem w dzienniku. Brak sourceRefId
 *  (faktura ręczna) dopuszczalny tylko przy FAKTURA_ISTNIEJE
 *  z potwierdzam: true i pełną zgodnością pozycji.
 * Nie usuwaj ręcznie wierszy CREATING ani przypisań. Nie wysyłaj
 * ręcznie z panelu faktur CREATED (ryzyko podwójnego e-maila i SMS).
 *
 * ------------------------------------------------------------------
 * POTWIERDZONE OGRANICZENIA API WIX
 * ------------------------------------------------------------------
 *  - wix-billing-backend nie ma wyszukiwania faktur — faktury po
 *    przerwanym createInvoice nie da się znaleźć automatycznie.
 *  - createInvoice: jeden rabat na fakturę (discount Fixed); dokumentacja
 *    nie potwierdza ujemnej ceny pozycji → faktura próbna.
 *  - Nowe Get Paid Invoices (@wix/get-paid) nie dla wszystkich witryn
 *    (428 przed migracją) — nieużywane.
 *  - Faktura STANDALONE po opłaceniu tworzy NOWE zamówienie; nie oznacza
 *    zamówień listopadowych jako PAID.
 *  - Order Invoices pokazuje tylko faktury powiązane z zamówieniem;
 *    faktury samodzielne (październik, listopad, ręczne) tylko w dzienniku.
 *  - Search Orders pomija PENDING/REJECTED, nigdy nie zwraca INITIALIZED
 *    (brakujące → getOrder); filtr id / externalOrderId obsługuje $in.
 *  - Order Transactions: do 100 zamówień, brak dostępu = pominięcie.
 *  - bulkUpdateOrders nie zmienia statusu płatności; addPayments
 *    świadomie nieużywane.
 *
 * DECYZJE RĘCZNE: PAID bez faktury, częściowe płatności, zwroty,
 * niezgodne kwoty/rabaty, inny kontakt/klucz, dodatkowe zamówienie
 * umowy, cykl ≠ DONE lub bez zamówienia, kontakt scalony/bez e-maila,
 * wszystkie NEEDS_REVIEW, wpisy dziennika za listopad spoza modelu v2,
 * braki kompletności, faktury listopadowe wystawione ręcznie poza
 * skryptem (API ich nie wykrywa — audyt w APPROVE).
 * Brak wymaganej kwoty w zamówieniu (cena, subtotal, total) nie jest
 * traktowany jak 0 — zamówienie ma kwotę NIEZNANA i trafia do kontroli.
 */
import wixData from 'wix-data';
import { invoices } from 'wix-billing-backend';
import { contacts } from 'wix-crm-backend';
import { elevate } from 'wix-auth';
import { orders, orderInvoices, orderTransactions } from '@wix/ecom';
import { auth } from '@wix/essentials';
import { createHash, randomBytes } from 'crypto';

// ##############################################################
// URUCHOMIENIE — ustaw przed wywołaniem automatyzacji
// ##############################################################

// PREVIEW | PREPARE | APPROVE | RUN | STATUS | RESOLVE | UNLOCK
// PREVIEW niczego nie zapisuje. Po pracy wróć do 'PREVIEW'.
const TRYB = 'PREVIEW';

const OPCJE = {
  PREVIEW: {},

  // Puste contactIds = wszyscy klienci z PREVIEW.
  // akceptujNiekompletne: tylko gdy PREVIEW pokazał braki (sumy.braki)
  // i świadomie je wyłączasz — wpisz DOKŁADNIE te ID, np.
  // { orderIds: ['...'], umowaIds: ['...'], wpisyDziennika: [] }.
  PREPARE: { contactIds: [], akceptujNiekompletne: null },

  // Liczba i suma z logu FAKTURY_PREPARE (doZatwierdzenia).
  // audytFaktur: potwierdzenie, że w panelu Faktury nie ma faktur za
  // listopad dla zatwierdzanych klientów wystawionych poza dziennikiem
  // (API Wix tego nie wykrywa). Zapisywane trwale w każdej operacji.
  APPROVE: {
    wszystkie: true,
    oczekiwanaLiczba: null,
    oczekiwanaSuma: '',
    audytFaktur: { sprawdzono: false, kto: '', zakres: '' },
    akceptujNiekompletne: null
  },

  // etap: 'UTWORZ' | 'WYSLIJ' | 'OBA'; puste operationIds = kolejne z dziennika.
  RUN: { maxOperacji: 1, etap: 'UTWORZ', operationIds: [] },

  STATUS: {},

  // decyzja: FAKTURA_ISTNIEJE | FAKTURY_BRAK | WYSLANA | WYSLIJ_PONOWNIE |
  //          ANULUJ | ZAMKNIJ_RECZNIE
  RESOLVE: { operationId: '', decyzja: '', invoiceId: '', uwagi: '', potwierdzam: false },

  UNLOCK: { potwierdzam: false }
};

// ##############################################################
// KONFIGURACJA
// ##############################################################

const KONFIGURACJA_LISTOPAD_2026 = Object.freeze({
  miesiac: '2026-11',
  tytulFaktury: 'Listopad 2026',
  temat:
    'Rachunek za listopad — Centrum Terapii Dziecięcej Toto',
  tresc:
    'Przesyłamy rachunek za listopad 2026. Dziękujemy!',
  waluta: 'PLN',
  strefaCzasowa: 'Europe/Warsaw',
  dniNaPlatnosc: 5,

  // NEGATIVE_LINE — każdy rabat jako osobna ujemna pozycja
  //   (preferowane w Toto).
  // INVOICE_DISCOUNT — suma rabatów jako rabat kwotowy faktury
  //   (zapasowo, gdyby Wix Invoices odrzucał ujemne ceny).
  trybRabatu: 'NEGATIVE_LINE',

  // false: czyste zamówienia klienta są fakturowane, nawet jeśli
  //   inne zamówienie tego klienta czeka na ręczne sprawdzenie.
  // true: cały klient czeka, aż wszystkie jego zamówienia będą jasne.
  wstrzymajKlientaPrzyPrzegladzie: false,

  // Zamówienia z kwotą 0 zł nie trafiają na faktury.
  pomijajZerowe: true,

  // Stałe z generatorUmow.js — muszą być identyczne.
  appIdRezerwacji: '13d21c63-b5ec-5912-8397-c3a5ddb27a97',

  kolekcje: Object.freeze({
    umowy: 'Umowy',
    umowyMiesiace: 'UmowyMiesiace',
    dziennik: 'FakturyMiesieczne',
    blokady: 'GeneratorBlokady'
  }),

  // Limity jednego wywołania (platforma: ok. 59 s).
  maxSekund: 30,
  minZapasMs: 12000,
  maxOperacji: 2,
  blokadaWaznoscMs: 5 * 60 * 1000
});

// ##############################################################
// LOGIKA ROZLICZEŃ — czyste funkcje (bez wywołań Wix)
// ##############################################################

const K = Object.freeze({
  DO_FAKTURY: 'DO_FAKTURY',
  W_PRZYGOTOWANIU: 'W_PRZYGOTOWANIU',
  ROZLICZONE: 'ROZLICZONE',
  DO_SPRAWDZENIA: 'DO_SPRAWDZENIA',
  ANULOWANE: 'ANULOWANE',
  ZEROWE: 'ZEROWE'
});

// Statusy operacji (faktury) w dzienniku FakturyMiesieczne.
const S = Object.freeze({
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
const STATUSY_ZAFAKTUROWANE = [
  S.CREATED,
  S.SENDING,
  S.SENT,
  S.CLOSED_MANUALLY
];

const STATUSY_PLANOWANE = [S.PREPARED, S.APPROVED];

const STATUSY_NIEPEWNE = [S.CREATING, S.NEEDS_REVIEW];

// ======================================================
// POMOCNICZE
// ======================================================

const idOf = x => x?._id || x?.id;

const copy = x => JSON.parse(JSON.stringify(x));

const norm = v =>
  String(v || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

function stableId(text) {
  const h = createHash('sha256').update(text).digest('hex');

  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}-` +
    `5${h.slice(13, 16)}-a${h.slice(17, 20)}-` +
    `${h.slice(20, 32)}`
  );
}

function hash(value) {
  return createHash('sha256')
    .update(JSON.stringify(canon(value)))
    .digest('hex');
}

function canon(x) {
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
// Pole OPCJONALNE: brak wartości = 0 (np. brak rabatu, podatku).
// Do kwot, które muszą istnieć (cena, subtotal, total), służy
// groszeWymagane() — brak nie może zamienić się w 0 (przegląd R3).
function grosze(value) {
  const raw =
    value && typeof value === 'object' ? value.amount : value;

  if (raw === undefined || raw === null || raw === '') return 0;

  return parsujGrosze(raw);
}

function groszeWymagane(value, nazwa) {
  const raw =
    value && typeof value === 'object' ? value.amount : value;

  if (raw === undefined || raw === null || raw === '') {
    throw new Error(`Brak wymaganej kwoty: ${nazwa}.`);
  }

  return parsujGrosze(raw);
}

function parsujGrosze(raw) {
  if (
    typeof raw !== 'number' &&
    !(typeof raw === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(raw))
  ) {
    throw new Error(`Nieprawidłowa kwota: ${JSON.stringify(raw)}`);
  }

  const n = Number(raw);

  if (!Number.isFinite(n)) {
    throw new Error(`Nieprawidłowa kwota: ${JSON.stringify(raw)}`);
  }

  const c = Math.round(n * 100);

  if (!Number.isSafeInteger(c)) {
    throw new Error(`Kwota poza zakresem: ${raw}`);
  }

  if (Math.abs(n * 100 - c) > 1e-6) {
    throw new Error(`Kwota z więcej niż 2 miejscami: ${raw}`);
  }

  return c;
}

const zl = c => (c / 100).toFixed(2);

const msg = e => String(e?.message || e).slice(0, 1500);

const suma = (list, f) => list.reduce((s, x) => s + f(x), 0);

const operationId = (month, contactId, orderIds) =>
  stableId(
    `toto/invoice/v2/${month}/${contactId}/` +
    [...orderIds].sort().join(',')
  );

const claimId = orderId =>
  stableId(`toto/invoice-order/v2/${orderId}`);

// Klucz zamówienia nadawany przez generatorUmow.js.
const orderKey = (month, umowaId) =>
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
 * Brak wymaganej kwoty (cena pozycji, subtotal, total) = wyjątek:
 * zamówienie zostaje z NIEZNANĄ kwotą i trafia do ręcznej kontroli.
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
  const subtotal = groszeWymagane(p.subtotal, 'priceSummary.subtotal');
  const rabat = grosze(p.discount);
  const podatek = grosze(p.tax);
  const wysylka = grosze(p.shipping);
  const oplaty = grosze(p.totalAdditionalFees);
  const razem = groszeWymagane(p.total, 'priceSummary.total');
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

function sprawdzPowiazanie(o, row, umowa, cfg) {
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
function klasyfikujBazowo(w, cfg) {
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

  // Wpis listopada w FakturyMiesieczne spoza modelu v2 (np. skrypt
  // październikowy z innym MIESIAC) może oznaczać wystawioną fakturę,
  // której Order Invoices nie pokaże (przegląd R1).
  if (w.obceWpisy?.length) {
    return {
      kategoria: K.DO_SPRAWDZENIA,
      powody: [
        'W dzienniku jest wpis tego klienta za ten miesiąc spoza modelu v2 ' +
        `(${w.obceWpisy.join(', ')}) — sprawdź, czy faktura nie istnieje.`
      ]
    };
  }

  return { kategoria: K.DO_FAKTURY, powody: [] };
}

// Kategoria końcowa — z uwzględnieniem przypisania w dzienniku.
function klasyfikuj(w, cfg) {
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
function zbudujPlan(contactId, zamowienia, cfg) {
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

function wyciagnijKontakt(raw) {
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

function terminPlatnosci(teraz, dni) {
  return new Date(teraz.getTime() + dni * 24 * 60 * 60 * 1000);
}

/**
 * Pola dla invoices.createInvoice() z wix-billing-backend.
 * Kształt zgodny z działającym skryptem październikowym
 * oraz dokumentacją createInvoice (customer, lineItems, discount,
 * dates, metadata).
 */
function polaFaktury(plan, kontakt, cfg, teraz) {
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

// Kontrola faktury odczytanej przez getInvoice() przed wysyłką
// i przy przypinaniu faktury (RESOLVE FAKTURA_ISTNIEJE).
// Porównuje z planem zapisanym w dzienniku: kontakt, walutę,
// powiązanie z operacją, każdą pozycję (nazwa, ilość, cena),
// rabat faktury i sumę (przegląd R2). Brak pola = problem,
// chyba że wyjątek jest jawnie podany w `opcje`.
function sprawdzFakture(faktura, op, opcje = {}) {
  const problemy = [];

  if (!faktura) return ['Nie odczytano faktury.'];

  const kwota = (v, nazwa) => {
    try {
      return groszeWymagane(v, nazwa);
    } catch (e) {
      problemy.push(e.message);
      return null;
    }
  };

  if (faktura.id?.id !== op.invoiceId) {
    problemy.push('Odczytana faktura ma inne ID.');
  }

  if (faktura.customer?.contactId !== op.klientContactId) {
    problemy.push('Faktura wystawiona na inny kontakt.');
  }

  if (faktura.currency !== 'PLN') {
    problemy.push(`Waluta faktury: ${faktura.currency || 'brak'}.`);
  }

  const ref = faktura.metadata?.sourceRefId;

  if (ref !== op._id && !(opcje.bezRef && !ref)) {
    problemy.push(
      ref
        ? `Faktura należy do innej operacji (${ref}).`
        : 'Faktura bez metadata.sourceRefId.'
    );
  }

  const total = kwota(faktura.totals?.total, 'totals.total faktury');

  if (total !== null && total !== op.kwotaGrosze) {
    problemy.push(
      `Suma faktury ${zl(total)} ≠ oczekiwana ${zl(op.kwotaGrosze)}.`
    );
  }

  const plan = Array.isArray(op.pozycje) ? op.pozycje : null;
  const linie = Array.isArray(faktura.lineItems) ? faktura.lineItems : null;

  if (!plan || !plan.length) {
    problemy.push('Operacja nie ma zapisanych pozycji planu.');
  } else if (!linie) {
    problemy.push('Faktura bez listy pozycji.');
  } else if (linie.length !== plan.length) {
    problemy.push('Liczba pozycji faktury ≠ liczba pozycji planu.');
  } else {
    plan.forEach((p, i) => {
      const l = linie[i];
      const nr = i + 1;

      if (norm(l?.name) !== norm(p.nazwa)) {
        problemy.push(`Pozycja ${nr}: nazwa „${l?.name}” ≠ „${p.nazwa}”.`);
      }

      if (Number(l?.quantity) !== p.ilosc) {
        problemy.push(`Pozycja ${nr}: ilość ${l?.quantity} ≠ ${p.ilosc}.`);
      }

      const cena = kwota(l?.price, `cena pozycji ${nr}`);

      if (cena !== null && cena !== p.cena) {
        problemy.push(`Pozycja ${nr}: cena ${zl(cena)} ≠ ${zl(p.cena)}.`);
      }
    });
  }

  const rabatPlanu = op.rabatFaktury || 0;
  const d = faktura.discount;
  const rabatFaktury =
    d && d.value !== undefined && d.value !== null
      ? kwota(d.value, 'rabat faktury')
      : 0;

  if (rabatFaktury !== null && rabatFaktury !== rabatPlanu) {
    problemy.push(
      `Rabat faktury ${zl(rabatFaktury)} ≠ oczekiwany ${zl(rabatPlanu)}.`
    );
  }

  if (rabatFaktury && String(d?.type).toLowerCase() !== 'fixed') {
    problemy.push(`Rabat faktury typu ${d?.type}, oczekiwano Fixed.`);
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
function analizuj(stan, cfg) {
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
      obceWpisy: (stan.obceWpisy || [])
        .filter(x => x.klientContactId === row.klientContactId)
        .map(x => x._id),
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

  for (const x of stan.obceWpisy || []) {
    if (!x.klientContactId) {
      ostrzezenia.push(
        `Wpis dziennika ${x._id} za ${cfg.miesiac} spoza modelu v2 bez ` +
        'klientContactId — nie da się go przypisać do klienta.'
      );
    }
  }

  const sumy = policzSumy(
    zamowienia,
    plany,
    weryfikacjaPlanowanych,
    cykleBezZamowien,
    (stan.obceWpisy || []).filter(x => !x.klientContactId).map(x => x._id)
  );

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
function zweryfikujOperacje(op, zamowienia, cfg) {
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

  // Operacja zatwierdzona musi mieć aktualny audyt administratora.
  const audyt = op.status === S.APPROVED ? problemyAudytu(op, cfg) : [];

  return {
    operationId: op._id,
    status: op.status,
    klient: op.klientNazwa,
    kwota: zl(op.kwotaGrosze || 0),
    kwotaGrosze: op.kwotaGrosze || 0,
    ok: !problemy.length && !audyt.length,
    brakAudytu: audyt.length > 0,
    problemy: [...problemy, ...audyt],
    plan
  };
}

/**
 * Audyt administratora (przegląd R1): API nie pozwala wykryć faktur
 * wystawionych poza dziennikiem (ręcznie w panelu, starym skryptem).
 * APPROVE zapisuje w każdej operacji deklarację, że historia faktur
 * klienta za miesiąc została sprawdzona — powiązaną z miesiącem,
 * kontaktem, orderIds i fingerprintem. Brak lub nieaktualny audyt
 * = brak faktury.
 */
function problemyAudytu(op, cfg) {
  const a = op.audytFaktur;

  if (!a || a.sprawdzono !== true || !a.kto) {
    return ['Brak audytu faktur administratora (APPROVE.audytFaktur).'];
  }

  const p = [];

  if (a.miesiac !== cfg.miesiac) p.push('Audyt dotyczy innego miesiąca.');
  if (a.contactId !== op.klientContactId) p.push('Audyt dotyczy innego kontaktu.');
  if (a.fingerprint !== op.fingerprint) p.push('Audyt dotyczy innej wersji zamówień.');

  if (
    !Array.isArray(a.orderIds) ||
    [...a.orderIds].sort().join(',') !== [...op.orderIds].sort().join(',')
  ) {
    p.push('Audyt dotyczy innych zamówień.');
  }

  return p.map(x => `Nieaktualny audyt faktur: ${x}`);
}

// Kwota zamówienia do sum: odczytana, szacunek z cyklu albo null (nieznana).
function kwotaDoSum(w) {
  if (w.zamowienie) return w.zamowienie.razem;

  const k = w.row.kwota;

  if (typeof k === 'number' && Number.isFinite(k) && k > 0) {
    try {
      return groszeWymagane(k, 'kwota cyklu');
    } catch (_) {
      return null;
    }
  }

  return null;
}

/**
 * Sumy kontrolne (przegląd R4). Dwie niezależne kontrole:
 *  - arytmetyka: należności nie znikają między kategoriami,
 *  - kompletność: każde zamówienie odczytane, z kwotą, policzone raz,
 *    każdy cykl ma zamówienie, każdy wpis dziennika przypisany.
 * kontroleOk wymaga obu. Braki można wyłączyć tylko jawnie
 * (OPCJE.*.akceptujNiekompletne), wskazując konkretne ID.
 */
function policzSumy(
  zamowienia,
  plany,
  planowane = [],
  cykleBezZamowien = [],
  nieprzypisaneWpisy = []
) {
  // Każde zamówienie liczone raz — duplikaty orderId tylko raportujemy.
  const widziane = new Set();
  const zdublowane = new Set();
  const unikalne = [];

  for (const w of zamowienia) {
    if (widziane.has(w.row.orderId)) {
      zdublowane.add(w.row.orderId);
      continue;
    }
    widziane.add(w.row.orderId);
    unikalne.push(w);
  }

  const nieodczytane = unikalne.filter(w => !w.zamowienie);
  const bezKwoty = unikalne.filter(w => kwotaDoSum(w) === null);

  const wKat = k => unikalne.filter(w => w.kategoria === k);
  const s = list => suma(list, w => kwotaDoSum(w) ?? 0);
  const znane = unikalne.filter(w => w.zamowienie);

  const r = {
    liczbaZamowien: unikalne.length,
    bruttoGrosze: suma(znane, w => w.zamowienie.brutto),
    rabatyGrosze: suma(znane, w => w.zamowienie.rabat),
    nettoGrosze: s(unikalne),
    juzRozliczoneGrosze: s(wKat(K.ROZLICZONE)),
    doNowychFakturGrosze: s(wKat(K.DO_FAKTURY)) + s(wKat(K.W_PRZYGOTOWANIU)),
    nowePlanyGrosze: s(wKat(K.DO_FAKTURY)),
    wPrzygotowaniuGrosze: s(wKat(K.W_PRZYGOTOWANIU)),
    doSprawdzeniaGrosze: s(wKat(K.DO_SPRAWDZENIA)),
    anulowaneGrosze: s(wKat(K.ANULOWANE)),
    zeroweGrosze: s(wKat(K.ZEROWE)),
    szacunkoweGrosze: s(nieodczytane),
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

  r.arytmetykaOk = Object.values(r.kontrole).every(Boolean);

  // Kompletność źródeł — zgodna arytmetyka nie dowodzi kompletności.
  r.kompletnosc = {
    nieodczytaneZamowienia: nieodczytane.map(w => w.row.orderId),
    bezKwoty: bezKwoty.map(w => w.row.orderId),
    zdublowaneOrderId: [...zdublowane],
    cykleBezZamowien: cykleBezZamowien.map(c => c.umowaId),
    nieprzypisaneWpisyDziennika: nieprzypisaneWpisy
  };

  r.braki = {
    orderIds: [...new Set([
      ...r.kompletnosc.nieodczytaneZamowienia,
      ...r.kompletnosc.bezKwoty,
      ...r.kompletnosc.zdublowaneOrderId
    ])].sort(),
    umowaIds: [...new Set(r.kompletnosc.cykleBezZamowien)].sort(),
    wpisyDziennika: [...nieprzypisaneWpisy].sort()
  };

  r.kompletne =
    !r.braki.orderIds.length &&
    !r.braki.umowaIds.length &&
    !r.braki.wpisyDziennika.length;

  r.kontroleOk = r.arytmetykaOk && r.kompletne;

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
    nieznanychKwot: bezKwoty.length,
    sumaNowychPlanow: zl(r.sumaPlanowGrosze),
    sumaPlanowanychOperacji: zl(r.sumaPlanowanychOperacjiGrosze)
  };

  return r;
}

/**
 * Jawna akceptacja braków kompletności: administrator musi wymienić
 * dokładnie te ID, które PREVIEW pokazał w sumy.braki.
 * @returns {string|null} opis odmowy albo null
 */
function sprawdzAkceptacjeBrakow(braki, akceptacja) {
  const a = akceptacja || {};

  for (const [klucz, lista] of Object.entries(braki)) {
    const dane = [...new Set(a[klucz] || [])].sort();

    if (dane.join(',') !== lista.join(',')) {
      return (
        `Niekompletne dane (${klucz}: ${lista.join(', ') || 'brak'}). ` +
        `Rozstrzygnij je albo podaj dokładnie te ID w akceptujNiekompletne.${klucz}.`
      );
    }
  }

  return null;
}

// Wiersz tabeli PREVIEW dla jednego zamówienia.
function wierszTabeli(w) {
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
    netto: o
      ? zl(o.razem)
      : kwotaDoSum(w) === null ? 'NIEZNANA' : `~${zl(kwotaDoSum(w))}`,
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

// ##############################################################
// TRWAŁE WYKONANIE — dziennik FakturyMiesieczne i blokada
// ##############################################################

const RODZAJ_FAKTURA = 'FAKTURA';
const RODZAJ_ZAMOWIENIE = 'ZAMOWIENIE';

const LOCK_ID = stableId('toto/faktury/v2/global');
const GENERATOR_LOCK_ID = stableId('toto/generator/global/v1');

function blad(text, name) {
  const e = new Error(text);
  e.name = name;
  return e;
}

const token = () => randomBytes(12).toString('hex');

/**
 * @param {Object} db adapter: get, insert, update, remove, find
 * @param {Object} cfg konfiguracja miesiąca
 * @param {Object} [opts]
 */
function createJournal(db, cfg, opts = {}) {
  const now = opts.now || (() => new Date());
  const LEDGER = cfg.kolekcje.dziennik;
  const LOCKS = cfg.kolekcje.blokady;

  async function operacje() {
    const rows = await db.find(LEDGER, {
      miesiac: cfg.miesiac,
      rodzaj: RODZAJ_FAKTURA
    });
    return new Map(rows.map(r => [r._id, r]));
  }

  // Wpisy miesiąca spoza modelu v2 (np. format październikowy bez
  // `rodzaj`) — mogą oznaczać fakturę wystawioną innym skryptem (R1).
  async function obceWpisy() {
    const rows = await db.find(LEDGER, { miesiac: cfg.miesiac });
    return rows.filter(r =>
      ![RODZAJ_FAKTURA, RODZAJ_ZAMOWIENIE].includes(r.rodzaj)
    );
  }

  async function przypisania() {
    const rows = await db.find(LEDGER, {
      miesiac: cfg.miesiac,
      rodzaj: RODZAJ_ZAMOWIENIE
    });
    return new Map(rows.map(r => [r.orderId, r]));
  }

  // Przypisania mogą pochodzić z innego miesiąca (to samo orderId),
  // dlatego dla zamówień bez przypisania w tym miesiącu sprawdzamy
  // też deterministyczne _id.
  async function przypisaniaDla(orderIds) {
    const map = await przypisania();
    const brak = orderIds.filter(id => !map.has(id));

    const odczyty = await Promise.all(
      brak.map(id => db.get(LEDGER, claimId(id)))
    );

    odczyty.forEach(r => {
      if (r) map.set(r.orderId, r);
    });

    return map;
  }

  async function operacjeDla(przyp) {
    const map = await operacje();
    const brak = [...new Set(
      [...przyp.values()].map(c => c.operationId)
    )].filter(id => !map.has(id));

    const odczyty = await Promise.all(brak.map(id => db.get(LEDGER, id)));

    odczyty.forEach(r => {
      if (r) map.set(r._id, r);
    });

    return map;
  }

  /**
   * Zmiana stanu operacji z kontrolą statusu i writeToken.
   * Rzuca JournalConflictError albo JournalPersistenceError.
   */
  async function zmien(op, oczekiwany, patch, info) {
    const obecny = await db.get(LEDGER, op._id);

    if (!obecny) {
      throw blad(`Brak wiersza operacji ${op._id}.`, 'JournalConflictError');
    }

    const dozwolone = Array.isArray(oczekiwany) ? oczekiwany : [oczekiwany];

    if (
      !dozwolone.includes(obecny.status) ||
      (op.writeToken && obecny.writeToken !== op.writeToken)
    ) {
      throw blad(
        `Operacja ${op._id} zmieniła się (${obecny.status}); ` +
        'przerwano bez zapisu.',
        'JournalConflictError'
      );
    }

    const nastepny = copy({
      ...obecny,
      ...patch,
      writeToken: token(),
      zmieniono: now().toISOString(),
      historia: [
        ...(obecny.historia || []),
        {
          ts: now().toISOString(),
          z: obecny.status,
          na: patch.status || obecny.status,
          info: info || ''
        }
      ].slice(-50)
    });

    try {
      await db.update(LEDGER, nastepny);
    } catch (e) {
      throw blad(
        `Niepotwierdzony zapis dziennika ${op._id}: ${e?.message || e}`,
        'JournalPersistenceError'
      );
    }

    let odczyt;

    try {
      odczyt = await db.get(LEDGER, op._id);
    } catch (e) {
      throw blad(
        `Brak odczytu potwierdzającego ${op._id}: ${e?.message || e}`,
        'JournalPersistenceError'
      );
    }

    if (
      !odczyt ||
      odczyt.writeToken !== nastepny.writeToken ||
      odczyt.status !== nastepny.status ||
      (odczyt.invoiceId || '') !== (nastepny.invoiceId || '') ||
      (odczyt.invoiceVersion ?? null) !== (nastepny.invoiceVersion ?? null)
    ) {
      throw blad(
        `Zapis i odczyt dziennika różnią się (${op._id}).`,
        'JournalPersistenceError'
      );
    }

    return odczyt;
  }

  function wierszOperacji(plan, kontakt) {
    const t = now().toISOString();

    return {
      _id: plan.operationId,
      title:
        `${cfg.miesiac} | ${kontakt.fullName || plan.klient} | ` +
        `${plan.orderIds.length} zam.`,
      rodzaj: RODZAJ_FAKTURA,
      wersjaModelu: 2,
      miesiac: cfg.miesiac,
      operationKey: plan.operationId,
      klientContactId: plan.contactId,
      klientNazwa: plan.klient || kontakt.fullName,
      email: kontakt.email,
      orderIds: plan.orderIds,
      numeryZamowien: plan.numeryZamowien,
      umowaIds: plan.umowaIds || [],
      status: S.PREPARED,
      invoiceId: '',
      invoiceVersion: null,
      invoiceNumber: '',
      kwota: Number(zl(plan.razem)),
      kwotaGrosze: plan.razem,
      bruttoGrosze: plan.brutto,
      rabatyGrosze: plan.sumaRabatow,
      pozycje: plan.pozycje,
      rabaty: plan.rabaty,
      rabatFaktury: plan.rabatFaktury,
      trybRabatu: plan.trybRabatu,
      fingerprint: plan.fingerprint,
      utworzenieRozpoczete: false,
      wysylkaRozpoczeta: false,
      proby: 0,
      powodPrzegladu: '',
      blad: '',
      przygotowano: t,
      zatwierdzono: null,
      utworzono: null,
      wyslano: null,
      writeToken: token(),
      historia: [{ ts: t, z: '', na: S.PREPARED, info: 'PREPARE' }]
    };
  }

  /**
   * Zapis PREPARED + przypisania zamówień. Idempotentne:
   * ponowne wywołanie uzupełnia brakujące przypisania.
   */
  async function przygotuj(plan, kontakt) {
    for (const orderId of plan.orderIds) {
      const c = await db.get(LEDGER, claimId(orderId));

      if (c && c.operationId !== plan.operationId) {
        throw blad(
          `Zamówienie ${orderId} jest już przypisane do operacji ` +
          `${c.operationId}.`,
          'ClaimConflictError'
        );
      }
    }

    let op = await db.get(LEDGER, plan.operationId);

    if (!op) {
      await db.insert(LEDGER, wierszOperacji(plan, kontakt));
      op = await db.get(LEDGER, plan.operationId);

      if (!op) {
        throw blad('Wiersz operacji nie został zapisany.', 'JournalPersistenceError');
      }
    } else if (op.status === S.CANCELLED && !op.utworzenieRozpoczete) {
      const nowy = wierszOperacji(plan, kontakt);
      op = await zmien(op, S.CANCELLED, {
        ...nowy,
        historia: undefined,
        writeToken: undefined
      }, 'Ponowne przygotowanie po anulowaniu');
    } else if (op.status !== S.PREPARED) {
      return { op, pominieto: `Operacja ma status ${op.status}.` };
    } else if (op.fingerprint !== plan.fingerprint) {
      throw blad(
        'Istniejąca operacja PREPARED ma inny fingerprint — anuluj ją i przygotuj ponownie.',
        'ClaimConflictError'
      );
    }

    for (const orderId of plan.orderIds) {
      const id = claimId(orderId);

      if (await db.get(LEDGER, id)) continue;

      try {
        await db.insert(LEDGER, {
          _id: id,
          title: `${cfg.miesiac} | zamówienie ${orderId}`,
          rodzaj: RODZAJ_ZAMOWIENIE,
          wersjaModelu: 2,
          miesiac: cfg.miesiac,
          orderId,
          klientContactId: plan.contactId,
          operationId: plan.operationId,
          status: 'PRZYPISANE',
          przypisano: now().toISOString()
        });
      } catch (e) {
        const c = await db.get(LEDGER, id);

        if (!c || c.operationId !== plan.operationId) {
          throw blad(
            `Nie przypisano zamówienia ${orderId}: ${e?.message || e}`,
            'ClaimConflictError'
          );
        }
      }
    }

    return { op: await db.get(LEDGER, plan.operationId) };
  }

  // Anulowanie dozwolone wyłącznie, gdy nigdy nie rozpoczęto
  // tworzenia faktury. Zwalnia przypisania zamówień.
  async function anuluj(op, info) {
    if (op.utworzenieRozpoczete || op.invoiceId) {
      throw blad(
        'Nie można anulować: tworzenie faktury było rozpoczęte.',
        'ReviewError'
      );
    }

    const nowy = await zmien(
      op,
      [...STATUSY_PLANOWANE, S.NEEDS_REVIEW],
      { status: S.CANCELLED },
      info || 'Anulowano'
    );

    for (const orderId of op.orderIds) {
      const c = await db.get(LEDGER, claimId(orderId));
      if (c?.operationId === op._id) await db.remove(LEDGER, c._id);
    }

    return nowy;
  }

  // ======================================================
  // BLOKADA (wzorzec z generatorUmow.js — bez automatycznego
  // przejmowania starych blokad)
  // ======================================================

  const stara = l => {
    const t = new Date(l?._createdDate || l?.utworzono).getTime();
    return Number.isFinite(t) && now().getTime() - t > cfg.blokadaWaznoscMs;
  };

  async function zablokuj(opis) {
    if (await db.get(LOCKS, GENERATOR_LOCK_ID)) {
      throw blad(
        'Trwa praca generatora cykli. Spróbuj po jej zakończeniu.',
        'BusyError'
      );
    }

    const t = token();

    try {
      await db.insert(LOCKS, {
        _id: LOCK_ID,
        title: `Faktury ${cfg.miesiac} ${opis || ''}`.trim(),
        token: t,
        utworzono: now().toISOString()
      });
    } catch (e) {
      const istniejaca = await db.get(LOCKS, LOCK_ID);

      if (!istniejaca) throw e;

      if (stara(istniejaca)) {
        throw blad(
          'Blokada fakturowania starsza niż 5 minut — poprzednie wywołanie ' +
          'mogło zostać przerwane. Sprawdź dziennik i użyj zwolnijBlokade().',
          'LockReviewError'
        );
      }

      throw blad(
        'Trwa inne uruchomienie fakturowania. Poczekaj na jego zakończenie.',
        'BusyError'
      );
    }

    const potwierdzenie = await db.get(LOCKS, LOCK_ID);

    if (potwierdzenie?.token !== t) {
      throw blad('Nie potwierdzono blokady.', 'BusyError');
    }

    return {
      token: t,

      async pilnuj() {
        const l = await db.get(LOCKS, LOCK_ID);

        if (l?.token !== t || stara(l)) {
          throw blad('Utracono blokadę fakturowania.', 'LockLostError');
        }
      },

      async zwolnij() {
        const l = await db.get(LOCKS, LOCK_ID);
        if (l?.token === t) await db.remove(LOCKS, LOCK_ID);
      }
    };
  }

  async function zwolnijStara() {
    const l = await db.get(LOCKS, LOCK_ID);

    if (!l) return { status: 'BRAK_BLOKADY' };

    if (!stara(l)) {
      return {
        status: 'AKTYWNA',
        uwaga: 'Blokada młodsza niż 5 minut — może trwać uruchomienie.'
      };
    }

    await db.remove(LOCKS, LOCK_ID);
    return { status: 'ZWOLNIONA', token: l.token, utworzono: l.utworzono };
  }

  return {
    operacje,
    obceWpisy,
    przypisania,
    przypisaniaDla,
    operacjeDla,
    operacja: id => db.get(LEDGER, id),
    zmien,
    przygotuj,
    anuluj,
    zablokuj,
    zwolnijStara
  };
}

// ##############################################################
// INTEGRACJA WIX — jedyne miejsce wywołań API Wix
// ##############################################################

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

function kawalki(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// ======================================================
// CMS
// ======================================================

const db = {
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

function createGateway(cfg) {
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

// ##############################################################
// PROCES — PREVIEW / PREPARE / APPROVE / RUN / rozstrzygnięcia
// ##############################################################


const KRYTYCZNE = [
  'JournalPersistenceError',
  'LockLostError',
  'JournalConflictError'
];

function budzet(cfg, maxSekund) {
  const sekundy = Math.min(Math.max(Number(maxSekund) || cfg.maxSekund, 5), 40);
  const koniec = Date.now() + sekundy * 1000;

  return {
    // Nie zaczynamy operacji zapisu, gdy zostało mniej niż zapas.
    wystarczy: () => koniec - Date.now() > cfg.minZapasMs,
    pozostalo: () => koniec - Date.now()
  };
}

async function rownolegle(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;

  async function worker() {
    while (i < list.length) {
      const k = i++;
      out[k] = await fn(list[k], k);
    }
  }

  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}

function opisOperacji(op) {
  return {
    operationId: op._id,
    status: op.status,
    klient: op.klientNazwa,
    contactId: op.klientContactId,
    orderIds: op.orderIds,
    kwota: zl(op.kwotaGrosze || 0),
    invoiceId: op.invoiceId || '',
    invoiceVersion: op.invoiceVersion ?? null,
    powodPrzegladu: op.powodPrzegladu || '',
    blad: op.blad || '',
    utworzenieRozpoczete: Boolean(op.utworzenieRozpoczete),
    wysylkaRozpoczeta: Boolean(op.wysylkaRozpoczeta)
  };
}

function opisPlanu(p) {
  return {
    operationId: p.operationId,
    statusDziennika: p.istniejacaOperacja?.status || 'NOWA',
    klient: p.klient,
    contactId: p.contactId,
    email: p.kontakt?.email || '',
    telefon: p.kontakt?.phone || '',
    orderIds: p.orderIds,
    numeryZamowien: p.numeryZamowien,
    pozycje: p.pozycje.map(x => ({
      nazwa: x.nazwa,
      opis: x.opis,
      cena: zl(x.cena),
      ilosc: x.ilosc,
      wartosc: zl(x.cena * x.ilosc)
    })),
    rabatFaktury: zl(p.rabatFaktury),
    brutto: zl(p.brutto),
    rabaty: zl(p.sumaRabatow),
    razem: zl(p.razem),
    problemyKontaktu: p.problemyKontaktu || []
  };
}

function createProcess({ gateway, journal, cfg, now, log }) {
  now = now || (() => new Date());
  log = log || console;

  // ======================================================
  // ODCZYT STANU
  // ======================================================

  async function wczytajStan() {
    const rows = await gateway.wierszeCykli();
    const orderIds = [...new Set(rows.map(r => r.orderId).filter(Boolean))];
    const umowaIds = [...new Set(rows.map(r => r.umowaId).filter(Boolean))];
    const klucze = rows
      .filter(r => r.umowaId)
      .map(r => `TOTO:${cfg.miesiac}:${r.umowaId}`);

    const [umowy, zamowienia, indeksKluczy, fakturyWix, transakcje] =
      await Promise.all([
        gateway.umowy(umowaIds),
        gateway.zamowienia(orderIds),
        gateway.indeksKluczy(klucze),
        gateway.fakturyZamowien(orderIds),
        gateway.transakcje(orderIds)
      ]);

    const przypisania = await journal.przypisaniaDla(orderIds);
    const operacje = await journal.operacjeDla(przypisania);
    const obceWpisy = await journal.obceWpisy();

    const bledyGlobalne = [];

    if (indeksKluczy === null) {
      bledyGlobalne.push(
        'Nie sprawdzono, czy umowy nie mają dodatkowych zamówień (Search Orders).'
      );
    }

    if (fakturyWix === null) {
      bledyGlobalne.push(
        'Nie odczytano faktur powiązanych z zamówieniami (Order Invoices).'
      );
    }

    if (transakcje === null) {
      bledyGlobalne.push(
        'Nie odczytano transakcji zamówień (Order Transactions).'
      );
    }

    return {
      rows,
      umowy,
      zamowienia,
      indeksKluczy,
      fakturyWix,
      transakcje,
      przypisania,
      operacje,
      obceWpisy,
      bledyGlobalne
    };
  }

  async function kontaktDla(contactId) {
    try {
      const k = wyciagnijKontakt(await gateway.kontakt(contactId));
      const problemy = [];

      if (k.contactId !== contactId) {
        problemy.push('Kontakt scalony lub inne ID — popraw dane źródłowe.');
      }

      if (!k.email) problemy.push('Kontakt bez adresu e-mail.');

      return { kontakt: k, problemy };
    } catch (e) {
      return {
        kontakt: null,
        problemy: [`Nie odczytano kontaktu: ${msg(e)}`]
      };
    }
  }

  async function analiza({ zKontaktami = true } = {}) {
    const stan = await wczytajStan();
    const a = analizuj(stan, cfg);

    if (zKontaktami) {
      await rownolegle(a.plany, 5, async p => {
        const { kontakt, problemy } = await kontaktDla(p.contactId);
        p.kontakt = kontakt;
        p.problemyKontaktu = problemy;
      });

      const emaile = new Map();

      for (const p of a.plany) {
        const e = (p.kontakt?.email || '').toLowerCase();
        if (!e) continue;
        const list = emaile.get(e) || [];
        list.push(p.contactId);
        emaile.set(e, list);
      }

      for (const [e, ids] of emaile) {
        if (ids.length > 1) {
          a.ostrzezenia.push(
            `Ten sam e-mail ${e} w ${ids.length} kontaktach ` +
            `(${ids.join(', ')}) — faktury osobne, nie łączymy.`
          );
        }
      }
    }

    return { stan, a };
  }

  function raport(tryb, a, extra = {}) {
    return {
      tryb,
      miesiac: cfg.miesiac,
      sumy: { ...a.sumy.zl, liczby: a.sumy.liczby },
      kontroleSum: a.sumy.kontrole,
      arytmetykaOk: a.sumy.arytmetykaOk,
      kompletne: a.sumy.kompletne,
      kompletnosc: a.sumy.kompletnosc,
      braki: a.sumy.braki,
      kontroleOk: a.sumy.kontroleOk,
      bledyGlobalne: a.bledyGlobalne,
      ostrzezenia: a.ostrzezenia,
      ...extra
    };
  }

  // Bramka PREPARE/APPROVE: odczyty API kompletne, arytmetyka sum
  // zgodna, a braki kompletności rozstrzygnięte albo jawnie wyłączone.
  function bramkaDanych(a, akceptujNiekompletne) {
    if (a.bledyGlobalne.length) {
      return 'Odczyty API niekompletne: ' + a.bledyGlobalne.join(' ');
    }

    if (!a.sumy.arytmetykaOk) {
      return 'Kontrole sum nie przeszły — popraw dane i uruchom PREVIEW.';
    }

    if (!a.sumy.kompletne) {
      return sprawdzAkceptacjeBrakow(a.sumy.braki, akceptujNiekompletne);
    }

    return null;
  }

  // ======================================================
  // PREVIEW — wyłącznie odczyt
  // ======================================================

  async function podglad({ zKontaktami = true } = {}) {
    const { stan, a } = await analiza({ zKontaktami });

    const tabela = a.zamowienia.map(wierszTabeli);

    const wynik = raport('PREVIEW', a, {
      tabela,
      proponowaneFaktury: a.plany.map(opisPlanu),
      zaplanowaneOperacje: a.weryfikacjaPlanowanych.map(w => ({
        operationId: w.operationId,
        status: w.status,
        klient: w.klient,
        kwota: w.kwota,
        aktualne: w.ok,
        problemy: w.problemy
      })),
      operacjeDziennika: [...stan.operacje.values()]
        .filter(op => op.miesiac === cfg.miesiac)
        .map(opisOperacji),
      cykleBezZamowien: a.cykleBezZamowien,
      doRecznejDecyzji: a.zamowienia
        .filter(w => w.kategoria === K.DO_SPRAWDZENIA)
        .map(w => ({
          klient: w.klient,
          orderId: w.row.orderId,
          powod: w.powody.join(' | ')
        })),
      gotoweDoPrzygotowania:
        a.sumy.kontroleOk && !a.bledyGlobalne.length
    });

    log.log('FAKTURY_PREVIEW_SUMY', JSON.stringify(wynik.sumy));
    log.log('FAKTURY_PREVIEW_KONTROLE', JSON.stringify({
      ...wynik.kontroleSum,
      arytmetykaOk: wynik.arytmetykaOk,
      kompletne: wynik.kompletne,
      braki: wynik.braki
    }));
    for (const w of tabela) log.log('FAKTURY_PREVIEW_ZAMOWIENIE', JSON.stringify(w));
    for (const p of wynik.proponowaneFaktury) {
      log.log('FAKTURY_PREVIEW_FAKTURA', JSON.stringify(p));
    }

    return wynik;
  }

  // ======================================================
  // Wspólne opakowanie trybów zapisujących
  // ======================================================

  async function zBlokada(opis, fn) {
    let lock;

    try {
      lock = await journal.zablokuj(opis);
    } catch (e) {
      if (['BusyError', 'LockReviewError'].includes(e?.name)) {
        return {
          tryb: opis,
          status: e.name === 'BusyError' ? 'BUSY' : 'LOCK_REVIEW',
          blad: msg(e)
        };
      }
      throw e;
    }

    try {
      return await fn(lock);
    } finally {
      await lock.zwolnij().catch(e =>
        log.error('FAKTURY_BLOKADA_ZWOLNIENIE', msg(e))
      );
    }
  }

  // ======================================================
  // PREPARE — zapis planu w dzienniku (bez Wix Invoices)
  // ======================================================

  async function przygotuj({
    contactIds = [],
    maxSekund,
    akceptujNiekompletne
  } = {}) {
    return zBlokada('PREPARE', async lock => {
      const b = budzet(cfg, maxSekund);
      const { a } = await analiza();

      const odmowa = bramkaDanych(a, akceptujNiekompletne);

      if (odmowa) {
        return raport('PREPARE', a, { status: 'ODMOWA', blad: odmowa });
      }

      const wyniki = [];

      for (const p of a.plany) {
        if (contactIds.length && !contactIds.includes(p.contactId)) continue;

        const istn = p.istniejacaOperacja;

        if (istn && istn.status !== S.CANCELLED && istn.status !== S.PREPARED) {
          wyniki.push({ operationId: p.operationId, status: istn.status, uwaga: 'Bez zmian.' });
          continue;
        }

        if (!b.wystarczy()) {
          wyniki.push({ operationId: p.operationId, status: 'POMINIETO', uwaga: 'Koniec budżetu czasu.' });
          continue;
        }

        if (p.problemyKontaktu?.length) {
          wyniki.push({
            operationId: p.operationId,
            klient: p.klient,
            status: 'ODMOWA',
            blad: p.problemyKontaktu.join(' ')
          });
          continue;
        }

        await lock.pilnuj();

        try {
          const r = await journal.przygotuj(p, p.kontakt);
          wyniki.push({
            operationId: p.operationId,
            klient: p.klient,
            status: r.op?.status,
            kwota: zl(p.razem),
            uwaga: r.pominieto || ''
          });
        } catch (e) {
          if (KRYTYCZNE.includes(e?.name)) throw e;
          wyniki.push({
            operationId: p.operationId,
            klient: p.klient,
            status: 'BLAD',
            blad: msg(e)
          });
        }
      }

      const ops = await journal.operacje();
      const przygotowane = [...ops.values()].filter(o => o.status === S.PREPARED);

      return raport('PREPARE', a, {
        status: 'OK',
        wyniki,
        doZatwierdzenia: {
          liczba: przygotowane.length,
          suma: zl(przygotowane.reduce((s, o) => s + o.kwotaGrosze, 0)),
          operationIds: przygotowane.map(o => o._id)
        }
      });
    });
  }

  // ======================================================
  // APPROVE — decyzja administratora z sumą kontrolną
  // ======================================================

  async function zatwierdz({
    operationIds = [],
    wszystkie = false,
    oczekiwanaLiczba,
    oczekiwanaSuma,
    audytFaktur,
    akceptujNiekompletne
  } = {}) {
    // R1: API nie wykrywa faktur wystawionych poza dziennikiem.
    // Administrator deklaruje, że sprawdził panel Faktury za miesiąc.
    if (
      audytFaktur?.sprawdzono !== true ||
      !String(audytFaktur?.kto || '').trim() ||
      !String(audytFaktur?.zakres || '').trim()
    ) {
      return {
        tryb: 'APPROVE',
        status: 'ODMOWA',
        blad:
          'Wymagany audytFaktur: { sprawdzono: true, kto, zakres } — ' +
          'potwierdzenie, że w panelu Faktury nie ma faktur za ten miesiąc ' +
          'dla zatwierdzanych klientów poza dziennikiem.'
      };
    }

    return zBlokada('APPROVE', async lock => {
      const { a, stan } = await analiza({ zKontaktami: false });

      const odmowaDanych = bramkaDanych(a, akceptujNiekompletne);

      if (odmowaDanych) {
        return { tryb: 'APPROVE', status: 'ODMOWA', blad: odmowaDanych };
      }

      const kandydaci = [...stan.operacje.values()].filter(op =>
        op.miesiac === cfg.miesiac &&
        op.status === S.PREPARED &&
        (wszystkie || operationIds.includes(op._id))
      );

      if (!wszystkie) {
        const brak = operationIds.filter(id => !kandydaci.some(o => o._id === id));
        if (brak.length) {
          return { tryb: 'APPROVE', status: 'ODMOWA', blad: `Nie PREPARED: ${brak.join(', ')}` };
        }
      }

      const suma = kandydaci.reduce((s, o) => s + o.kwotaGrosze, 0);

      if (
        oczekiwanaLiczba !== kandydaci.length ||
        oczekiwanaSuma === undefined ||
        grosze(oczekiwanaSuma) !== suma
      ) {
        return {
          tryb: 'APPROVE',
          status: 'ODMOWA',
          blad:
            'Liczba lub suma nie zgadza się z PREVIEW/PREPARE. ' +
            `Dziennik: ${kandydaci.length} faktur, ${zl(suma)} zł.`
        };
      }

      const nieaktualne = a.weryfikacjaPlanowanych.filter(w =>
        kandydaci.some(o => o._id === w.operationId) && !w.ok
      );

      if (nieaktualne.length) {
        return {
          tryb: 'APPROVE',
          status: 'ODMOWA',
          blad: 'Część operacji nie odpowiada już zamówieniom.',
          nieaktualne
        };
      }

      const wyniki = [];

      for (const op of kandydaci) {
        await lock.pilnuj();
        const nowy = await journal.zmien(
          op,
          S.PREPARED,
          {
            status: S.APPROVED,
            zatwierdzono: now().toISOString(),
            // Trwały audyt powiązany z miesiącem, kontaktem,
            // zamówieniami i wersją danych (fingerprint).
            audytFaktur: {
              sprawdzono: true,
              kto: String(audytFaktur.kto).trim(),
              zakres: String(audytFaktur.zakres).trim(),
              data: now().toISOString(),
              miesiac: cfg.miesiac,
              contactId: op.klientContactId,
              orderIds: op.orderIds,
              fingerprint: op.fingerprint,
              akceptowaneBraki: a.sumy.kompletne ? null : a.sumy.braki
            }
          },
          `APPROVE (${kandydaci.length} faktur, ${zl(suma)} zł), audyt: ${audytFaktur.kto}`
        );
        wyniki.push(opisOperacji(nowy));
      }

      return { tryb: 'APPROVE', status: 'OK', liczba: wyniki.length, suma: zl(suma), wyniki };
    });
  }

  // ======================================================
  // RUN — tworzenie i wysyłka
  // ======================================================

  async function doPrzegladu(op, z, powod, blad) {
    return journal.zmien(
      op,
      z,
      { status: S.NEEDS_REVIEW, powodPrzegladu: powod, blad: blad || '' },
      `${powod}: ${blad || ''}`.slice(0, 500)
    );
  }

  // Stany pozostawione przez przerwane wywołanie.
  async function uporzadkujNiepewne(ops, lock) {
    const wyniki = [];

    for (const op of ops.values()) {
      if (op.miesiac !== cfg.miesiac) continue;

      if (op.status === S.CREATING) {
        await lock.pilnuj();
        const n = await doPrzegladu(
          op,
          S.CREATING,
          'CREATE_UNCERTAIN',
          'Przerwano po rozpoczęciu createInvoice — nie wiadomo, czy faktura ' +
          'powstała. Sprawdź panel Faktury i logi FAKTURA_UTWORZONA.'
        );
        wyniki.push(opisOperacji(n));
      }

      if (op.status === S.SENDING) {
        await lock.pilnuj();
        let faktura = null;

        try {
          faktura = await gateway.pobierzFakture(op.invoiceId);
        } catch (e) {
          log.warn('FAKTURY_GET_INVOICE', msg(e));
        }

        const n = faktura?.wasSent === true
          ? await journal.zmien(
              op,
              S.SENDING,
              { status: S.SENT, wyslano: now().toISOString(), blad: '' },
              'Wznowienie: getInvoice.wasSent = true (bez ponownej wysyłki)'
            )
          : await doPrzegladu(
              op,
              S.SENDING,
              'SEND_UNCERTAIN',
              'Przerwano po rozpoczęciu sendInvoice; wasSent ≠ true. ' +
              'Nie wysyłamy ponownie bez decyzji.'
            );

        wyniki.push(opisOperacji(n));
      }
    }

    return wyniki;
  }

  async function wyslij(op, lock) {
    let faktura;

    try {
      faktura = await gateway.pobierzFakture(op.invoiceId);
    } catch (e) {
      // Nic nie wysłano — operacja zostaje CREATED.
      return { op, blad: `getInvoice: ${msg(e)}`, stop: true };
    }

    const problemy = sprawdzFakture(faktura, op);

    if (problemy.length) {
      op = await doPrzegladu(op, S.CREATED, 'INVOICE_MISMATCH', problemy.join(' '));
      return { op, stop: false };
    }

    if (faktura.wasSent === true) {
      op = await journal.zmien(
        op,
        S.CREATED,
        { status: S.SENT, wyslano: now().toISOString() },
        'Faktura już wysłana (wasSent) — bez ponownej wysyłki'
      );
      return { op };
    }

    if (/void|cancel|delet|paid/i.test(String(faktura.status || ''))) {
      op = await doPrzegladu(
        op,
        S.CREATED,
        'INVOICE_STATUS',
        `Nieoczekiwany status faktury przed wysyłką: ${faktura.status}.`
      );
      return { op };
    }

    // Wersja z bieżącego odczytu — createInvoice/updateInvoice ją zmieniają.
    const version = faktura.id?.version ?? op.invoiceVersion;

    op = await journal.zmien(
      op,
      S.CREATED,
      {
        status: S.SENDING,
        wysylkaRozpoczeta: true,
        invoiceVersion: version,
        rozpoczetoWysylke: now().toISOString()
      },
      'sendInvoice start'
    );

    await lock.pilnuj();

    try {
      await gateway.wyslijFakture(op.invoiceId, version, {
        subject: cfg.temat,
        body: cfg.tresc
      });
    } catch (e) {
      op = await doPrzegladu(op, S.SENDING, 'SEND_UNCERTAIN', `sendInvoice: ${msg(e)}`);
      return { op, stop: true };
    }

    log.log('FAKTURA_WYSLANA', JSON.stringify({
      operationId: op._id,
      invoiceId: op.invoiceId,
      version
    }));

    op = await journal.zmien(
      op,
      S.SENDING,
      { status: S.SENT, wyslano: now().toISOString(), blad: '' },
      'sendInvoice OK'
    );

    return { op };
  }

  async function utworz(op, weryfikacja, lock) {
    if (!weryfikacja?.ok) {
      op = await doPrzegladu(
        op,
        S.APPROVED,
        weryfikacja?.brakAudytu ? 'BRAK_AUDYTU' : 'ZMIANA_DANYCH',
        (weryfikacja?.problemy || ['Brak weryfikacji.']).join(' ')
      );
      return { op };
    }

    const { kontakt, problemy } = await kontaktDla(op.klientContactId);

    if (problemy.length) {
      op = await doPrzegladu(op, S.APPROVED, 'KONTAKT', problemy.join(' '));
      return { op };
    }

    const pola = polaFaktury(weryfikacja.plan, kontakt, cfg, now());

    const sumaPol =
      pola.lineItems.reduce((s, x) => s + grosze(x.price) * x.quantity, 0) -
      (pola.discount ? grosze(pola.discount.value) : 0);

    if (sumaPol !== op.kwotaGrosze) {
      op = await doPrzegladu(op, S.APPROVED, 'KWOTA', 'Pola faktury ≠ kwota operacji.');
      return { op };
    }

    // Trwały zapis PRZED createInvoice.
    op = await journal.zmien(
      op,
      S.APPROVED,
      {
        status: S.CREATING,
        utworzenieRozpoczete: true,
        proby: (op.proby || 0) + 1,
        rozpoczetoTworzenie: now().toISOString(),
        hashPol: hash({ ...pola, dates: null }),
        email: kontakt.email,
        blad: ''
      },
      'createInvoice start'
    );

    await lock.pilnuj();

    let wynik;

    try {
      wynik = await gateway.utworzFakture(pola);
    } catch (e) {
      // Błąd mógł nastąpić po utworzeniu faktury (np. timeout).
      op = await doPrzegladu(op, S.CREATING, 'CREATE_UNCERTAIN', `createInvoice: ${msg(e)}`);
      return { op, stop: true };
    }

    // createInvoice zwraca { id: { id, version } }.
    const invoiceId = wynik?.id?.id;
    const invoiceVersion = wynik?.id?.version ?? null;

    if (!invoiceId) {
      op = await doPrzegladu(
        op,
        S.CREATING,
        'CREATE_UNCERTAIN',
        `createInvoice bez ID: ${JSON.stringify(wynik).slice(0, 300)}`
      );
      return { op, stop: true };
    }

    // Log PRZED zapisem — jeśli zapis zawiedzie, ID zostaje w logach.
    log.log('FAKTURA_UTWORZONA', JSON.stringify({
      operationId: op._id,
      contactId: op.klientContactId,
      orderIds: op.orderIds,
      invoiceId,
      invoiceVersion
    }));

    op = await journal.zmien(
      op,
      S.CREATING,
      {
        status: S.CREATED,
        invoiceId,
        invoiceVersion,
        utworzono: now().toISOString()
      },
      'createInvoice OK'
    );

    return { op };
  }

  async function wykonaj({
    maxOperacji,
    maxSekund,
    etap = 'OBA',
    operationIds = []
  } = {}) {
    if (!['OBA', 'UTWORZ', 'WYSLIJ'].includes(etap)) {
      throw new Error('etap: OBA | UTWORZ | WYSLIJ');
    }

    const limit = Math.min(Math.max(Number(maxOperacji) || cfg.maxOperacji, 1), 5);

    return zBlokada('RUN', async lock => {
      const b = budzet(cfg, maxSekund);

      const poczatkowe = await journal.operacje();
      const uporzadkowane = await uporzadkujNiepewne(poczatkowe, lock);

      const { a, stan } = await analiza({ zKontaktami: false });

      const wybrane = op =>
        op.miesiac === cfg.miesiac &&
        (!operationIds.length || operationIds.includes(op._id));

      const ops = [...stan.operacje.values()].filter(wybrane);

      const kolejka = [
        ...(etap === 'UTWORZ' ? [] : ops.filter(o => o.status === S.CREATED)),
        ...(etap === 'WYSLIJ' ? [] : ops.filter(o => o.status === S.APPROVED))
      ].slice(0, limit);

      const wyniki = [];
      let zatrzymano = '';

      for (let op of kolejka) {
        if (!b.wystarczy()) {
          zatrzymano = 'Koniec budżetu czasu — uruchom ponownie.';
          break;
        }

        try {
          let r;

          if (op.status === S.APPROVED) {
            const wer = a.weryfikacjaPlanowanych.find(w => w.operationId === op._id);
            r = await utworz(op, wer, lock);

            if (
              !r.stop &&
              r.op.status === S.CREATED &&
              etap === 'OBA' &&
              b.wystarczy()
            ) {
              r = await wyslij(r.op, lock);
            }
          } else {
            r = await wyslij(op, lock);
          }

          op = r.op;
          wyniki.push({ ...opisOperacji(op), uwaga: r.blad || '' });

          if (r.stop) {
            zatrzymano = `Zatrzymano po operacji ${op._id}: ${op.powodPrzegladu || r.blad}`;
            break;
          }
        } catch (e) {
          if (KRYTYCZNE.includes(e?.name)) {
            log.error('FAKTURY_RUN_KRYTYCZNY', op._id, msg(e));
            throw e;
          }

          wyniki.push({ ...opisOperacji(op), status: 'BLAD', blad: msg(e) });
          zatrzymano = `Błąd: ${msg(e)}`;
          break;
        }
      }

      const po = await journal.operacje();
      const liczby = {};
      for (const o of po.values()) liczby[o.status] = (liczby[o.status] || 0) + 1;

      const wynik = {
        tryb: 'RUN',
        etap,
        miesiac: cfg.miesiac,
        uporzadkowaneNiepewne: uporzadkowane,
        wyniki,
        zatrzymano,
        statusy: liczby,
        pozostaloDoUtworzenia: [...po.values()].filter(o => o.status === S.APPROVED).length,
        pozostaloDoWyslania: [...po.values()].filter(o => o.status === S.CREATED).length,
        doRecznejDecyzji: [...po.values()]
          .filter(o => o.status === S.NEEDS_REVIEW)
          .map(opisOperacji)
      };

      log.log('FAKTURY_RUN', JSON.stringify({ ...wynik, wyniki: wyniki.length }));
      for (const w of wyniki) log.log('FAKTURY_RUN_OPERACJA', JSON.stringify(w));

      return wynik;
    });
  }

  // ======================================================
  // STATUS
  // ======================================================

  async function status() {
    const ops = [...(await journal.operacje()).values()];
    const liczby = {};
    for (const o of ops) liczby[o.status] = (liczby[o.status] || 0) + 1;

    return {
      tryb: 'STATUS',
      miesiac: cfg.miesiac,
      statusy: liczby,
      operacje: ops.map(opisOperacji)
    };
  }

  // ======================================================
  // ROZSTRZYGNIĘCIA STANÓW NIEPEWNYCH (decyzja administratora)
  // ======================================================

  async function rozstrzygnij({
    operationId,
    decyzja,
    invoiceId,
    uwagi = '',
    potwierdzam = false
  } = {}) {
    return zBlokada('RESOLVE', async lock => {
      const op = await journal.operacja(operationId);

      if (!op) return { status: 'ODMOWA', blad: 'Brak operacji.' };

      const odmowa = blad => ({ status: 'ODMOWA', blad, operacja: opisOperacji(op) });
      const info = `${decyzja}: ${uwagi}`.slice(0, 500);

      await lock.pilnuj();

      switch (decyzja) {
        // Faktura z CREATE_UNCERTAIN istnieje w panelu: przypinamy jej ID.
        case 'FAKTURA_ISTNIEJE': {
          if (!(op.status === S.NEEDS_REVIEW && op.powodPrzegladu === 'CREATE_UNCERTAIN')) {
            return odmowa('Dotyczy wyłącznie NEEDS_REVIEW / CREATE_UNCERTAIN.');
          }
          if (!invoiceId) return odmowa('Podaj invoiceId z panelu Faktury.');

          const f = await gateway.pobierzFakture(invoiceId);
          // Pełna zgodność treści z planem jest wymagana zawsze.
          // Brak metadata.sourceRefId (np. faktura wystawiona ręcznie)
          // dopuszczalny tylko z potwierdzam: true; inny sourceRefId — nigdy.
          const problemy = sprawdzFakture(f, { ...op, invoiceId }, {
            bezRef: potwierdzam
          });

          if (problemy.length) return odmowa(problemy.join(' '));

          const n = await journal.zmien(op, S.NEEDS_REVIEW, {
            status: f.wasSent === true ? S.SENT : S.CREATED,
            invoiceId,
            invoiceVersion: f.id?.version ?? null,
            powodPrzegladu: '',
            blad: '',
            utworzono: op.utworzono || now().toISOString(),
            ...(f.wasSent === true ? { wyslano: now().toISOString() } : {})
          }, info);

          return { status: 'OK', operacja: opisOperacji(n) };
        }

        // Faktury na pewno nie ma: wolno ponowić utworzenie.
        case 'FAKTURY_BRAK': {
          if (!(op.status === S.NEEDS_REVIEW && op.powodPrzegladu === 'CREATE_UNCERTAIN')) {
            return odmowa('Dotyczy wyłącznie NEEDS_REVIEW / CREATE_UNCERTAIN.');
          }
          if (!potwierdzam) {
            return odmowa('Potwierdź (potwierdzam: true), że w panelu Faktury nie ma tej faktury.');
          }

          const n = await journal.zmien(op, S.NEEDS_REVIEW, {
            status: S.APPROVED,
            powodPrzegladu: '',
            blad: ''
          }, info);

          return { status: 'OK', operacja: opisOperacji(n) };
        }

        // Wysyłka niepewna, a klient otrzymał fakturę / panel pokazuje wysłaną.
        case 'WYSLANA': {
          if (!op.invoiceId || ![S.NEEDS_REVIEW].includes(op.status)) {
            return odmowa('Dotyczy NEEDS_REVIEW z invoiceId.');
          }

          const f = await gateway.pobierzFakture(op.invoiceId);

          if (f?.wasSent !== true && !potwierdzam) {
            return odmowa('getInvoice nie potwierdza wysyłki — podaj potwierdzam: true, jeśli sprawdzono inaczej.');
          }

          const n = await journal.zmien(op, S.NEEDS_REVIEW, {
            status: S.SENT,
            powodPrzegladu: '',
            blad: '',
            wyslano: now().toISOString()
          }, info);

          return { status: 'OK', operacja: opisOperacji(n) };
        }

        // Faktura istnieje, na pewno nie wysłana: wraca do kolejki wysyłki.
        case 'WYSLIJ_PONOWNIE': {
          if (!(op.status === S.NEEDS_REVIEW && op.invoiceId &&
            ['SEND_UNCERTAIN', 'INVOICE_STATUS'].includes(op.powodPrzegladu))) {
            return odmowa('Dotyczy NEEDS_REVIEW / SEND_UNCERTAIN z invoiceId.');
          }
          if (!potwierdzam) {
            return odmowa('Potwierdź (potwierdzam: true), że faktura i SMS nie dotarły.');
          }

          const n = await journal.zmien(op, S.NEEDS_REVIEW, {
            status: S.CREATED,
            powodPrzegladu: '',
            blad: ''
          }, info);

          return { status: 'OK', operacja: opisOperacji(n) };
        }

        // Rezygnacja z operacji, która nigdy nie dotarła do createInvoice.
        case 'ANULUJ': {
          if (!(STATUSY_PLANOWANE.includes(op.status) || op.status === S.NEEDS_REVIEW)) {
            return odmowa(`Nie można anulować statusu ${op.status}.`);
          }
          try {
            const n = await journal.anuluj(op, info);
            return { status: 'OK', operacja: opisOperacji(n) };
          } catch (e) {
            return odmowa(msg(e));
          }
        }

        // Sprawa załatwiona poza skryptem; zamówienia pozostają przypisane.
        case 'ZAMKNIJ_RECZNIE': {
          if (op.status !== S.NEEDS_REVIEW) return odmowa('Dotyczy NEEDS_REVIEW.');
          if (!uwagi) return odmowa('Opisz w uwagach, jak sprawę rozwiązano.');

          const n = await journal.zmien(op, S.NEEDS_REVIEW, {
            status: S.CLOSED_MANUALLY,
            ...(invoiceId ? { invoiceId } : {}),
            blad: ''
          }, info);

          return { status: 'OK', operacja: opisOperacji(n) };
        }

        default:
          return odmowa(
            'decyzja: FAKTURA_ISTNIEJE | FAKTURY_BRAK | WYSLANA | ' +
            'WYSLIJ_PONOWNIE | ANULUJ | ZAMKNIJ_RECZNIE'
          );
      }
    });
  }

  async function zwolnijBlokade({ potwierdzam = false } = {}) {
    if (!potwierdzam) {
      return { status: 'ODMOWA', blad: 'Najpierw sprawdź STATUS; potem potwierdzam: true.' };
    }
    return journal.zwolnijStara();
  }

  return {
    wczytajStan,
    podglad,
    przygotuj,
    zatwierdz,
    wykonaj,
    status,
    rozstrzygnij,
    zwolnijBlokade
  };
}

// ##############################################################
// WYWOŁANIE Z AUTOMATYZACJI („Run Velo Code”)
// ##############################################################

function proces() {
  const cfg = KONFIGURACJA_LISTOPAD_2026;
  const gateway = createGateway(cfg);
  const journal = createJournal(gateway.db, cfg);
  return createProcess({ gateway, journal, cfg });
}

async function wykonajTryb(p, tryb, opcje) {
  switch (tryb) {
    case 'PREVIEW': return p.podglad(opcje);
    case 'PREPARE': return p.przygotuj(opcje);
    case 'APPROVE': return p.zatwierdz(opcje);
    case 'RUN': return p.wykonaj(opcje);
    case 'STATUS': return p.status();
    case 'RESOLVE': return p.rozstrzygnij(opcje);
    case 'UNLOCK': return p.zwolnijBlokade(opcje);
    default: throw new Error(`Nieznany TRYB: ${tryb}`);
  }
}

// Logi Wix ucinają bardzo długie wpisy — tablice logujemy element po elemencie.
function zalogujWynik(tryb, wynik) {
  // PREVIEW loguje już tabelę zamówień i faktury.
  const pomin = tryb === 'PREVIEW' ? ['tabela', 'proponowaneFaktury'] : [];
  const reszta = {};

  for (const [k, v] of Object.entries(wynik || {})) {
    if (pomin.includes(k)) continue;

    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      for (const x of v) console.log(`FAKTURY_${tryb}_${k}`, JSON.stringify(x));
      reszta[k] = `${v.length} (osobne wpisy FAKTURY_${tryb}_${k})`;
    } else {
      reszta[k] = v;
    }
  }

  console.log(`FAKTURY_${tryb}`, JSON.stringify(reszta));
}

export const invoke = async () => {
  try {
    const wynik = await wykonajTryb(proces(), TRYB, OPCJE[TRYB] || {});
    zalogujWynik(TRYB, wynik);
  } catch (e) {
    console.error('FAKTURY_BLAD', TRYB, e?.name || '', e?.message || String(e));
    throw e;
  }

  return {};
};

// Wyłącznie dla testów lokalnych (Node, atrapy API Wix).
export const _test = {
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
};
