# Fakturowanie listopada 2026 — CTD Toto

Skrypt wystawia i wysyła faktury za listopad 2026 dla terapii cyklicznych.
**Źródłem rozliczenia są zamówienia eCommerce** wskazane w `UmowyMiesiace.orderId`,
a nie terminy w kalendarzu. Skrypt nie tworzy zamówień, nie zmienia harmonogramów,
płatności ani istniejących faktur.

## 1. Pliki i wdrożenie w Wix Velo

| Repozytorium | Ścieżka w Velo | Rola |
|---|---|---|
| `faktury/konfiguracja.js` | `backend/faktury/konfiguracja.js` | miesiąc, tytuł, termin 5 dni, tryb rabatu, limity |
| `faktury/rozliczenia.js` | `backend/faktury/rozliczenia.js` | **logika rozliczeń** — czyste funkcje (normalizacja zamówień, klasyfikacja, grupowanie, plan faktury, sumy kontrolne) |
| `faktury/dziennik.js` | `backend/faktury/dziennik.js` | **trwałe wykonanie** — dziennik `FakturyMiesieczne`, przypisania zamówień, blokada |
| `faktury/integracjaWix.js` | `backend/faktury/integracjaWix.js` | **integracja Wix** — jedyny moduł z importami API Wix |
| `faktury/proces.js` | `backend/faktury/proces.js` | orkiestracja trybów PREVIEW / PREPARE / APPROVE / RUN |
| `fakturyListopad.js` | `backend/fakturyListopad.js` | punkty wejścia dla administratora |

Wymagane pakiety (są już używane przez `generatorUmow.js`): `@wix/ecom`, `@wix/essentials`.
Pozostałe moduły (`wix-data`, `wix-billing-backend`, `wix-crm-backend`, `wix-auth`) są
wbudowane — te same, których używał skrypt październikowy.

`generatorUmow.js`, `CreateInvoicesOctober.js` i istniejące wiersze CMS pozostają bez zmian.

Testy (lokalnie, bez Wix): `npm test` — 43 testy, wszystkie API Wix zastąpione atrapami.

## 2. Co zmieniono względem października

Zachowane, sprawdzone mechanizmy:

* `createInvoice()` z `wix-billing-backend` — odpowiedź `{ id: { id, version } }`
  (potwierdzone w dokumentacji Velo `createInvoice`);
* `sendInvoice()` z **płaskim** `{ id, version }` + `{ subject, body }`
  (dokumentacja `sendInvoice(id: IdAndVersion, emailInfo)`);
* deterministyczne `_id` w dzienniku, zapis **przed** `createInvoice`, odczyt potwierdzający;
* log `FAKTURA_UTWORZONA` z ID faktury **przed** zapisem do dziennika;
* blokada w `GeneratorBlokady`; małe partie w budżecie czasu.

Zmienione świadomie:

* ilości i kwoty pochodzą z zamówień (`lineItems`, `priceSummary`, `appliedDiscounts`),
  nie z ręcznej listy `DANE` ani z kalendarza;
* klucz operacji = miesiąc + contactId + **posortowane orderIds** (październik: miesiąc + contactId),
  więc klient może mieć drugą fakturę za resztę należności;
* osobny wiersz przypisania na każde zamówienie (jedno zamówienie → najwyżej jedna operacja);
* wersja do `sendInvoice` jest brana ze świeżego `getInvoice()` (nie tylko z odpowiedzi `createInvoice`);
* przed wysyłką faktura jest odczytywana i sprawdzana (kontakt, suma, `metadata.sourceRefId`);
* przerwany `CREATING`/`SENDING` **nie jest ponawiany** — przechodzi do `NEEDS_REVIEW`;
* stara blokada nie jest przejmowana automatycznie (jak w `generatorUmow.js`);
* RUN nie jest podpięty pod automatyzację (`invoke` wykonuje tylko PREVIEW).

## 3. Kolekcje CMS

### `UmowyMiesiace` (tylko odczyt)
Używane pola: `miesiac`, `umowaId`, `klientContactId`, `status` (wymagane `DONE`),
`orderId`, `stawka`, `kwota`, `stan.plan[].status/bookingId`. Bez zmian struktury.

### `Umowy` (tylko odczyt)
`_id`, `klientContactId`, `klientNazwa`. Bez zmian.

### `GeneratorBlokady`
Nowy wiersz blokady fakturowania (`_id` = hash `toto/faktury/v2/global`, pola `title`, `token`, `utworzono`).
Skrypt **sprawdza** też blokadę generatora i nie startuje, gdy generator pracuje. Bez zmian struktury.

### `FakturyMiesieczne` — rozszerzenie struktury

Wiersze październikowe (bez pola `rodzaj`) pozostają nietknięte. Dla listopada dochodzą
dwa rodzaje wierszy rozróżniane polem **`rodzaj`**. Dodaj w CMS brakujące pola
(Wix zapisze je także bez tego, ale nie pokaże w tabeli):

**`rodzaj = FAKTURA`** — jedna operacja = jedna faktura. `_id` = `operationId`.

| Pole | Typ | Znaczenie |
|---|---|---|
| `rodzaj` | tekst | `FAKTURA` |
| `wersjaModelu` | liczba | `2` |
| `miesiac` | tekst | `2026-11` |
| `operationKey` | tekst | = `_id` (hash miesiąc + contactId + posortowane orderIds) |
| `klientContactId`, `klientNazwa`, `email` | tekst | nabywca |
| `orderIds`, `numeryZamowien`, `umowaIds` | tablica | **pełne powiązanie faktura ↔ zamówienia** |
| `status` | tekst | `PREPARED`, `APPROVED`, `CREATING`, `CREATED`, `SENDING`, `SENT`, `NEEDS_REVIEW`, `CANCELLED`, `CLOSED_MANUALLY` |
| `invoiceId`, `invoiceVersion`, `invoiceNumber` | tekst/liczba | ID i wersja faktury Wix |
| `kwota` (zł), `kwotaGrosze`, `bruttoGrosze`, `rabatyGrosze`, `rabatFaktury` | liczba | kwoty |
| `pozycje`, `rabaty` | tablica | pozycje faktury i rabaty z kluczem `orderId/discountId` |
| `trybRabatu`, `fingerprint`, `hashPol` | tekst | kontrola niezmienności danych |
| `utworzenieRozpoczete`, `wysylkaRozpoczeta` | logiczne | czy kiedykolwiek wywołano `createInvoice` / `sendInvoice` |
| `proby` | liczba | liczba prób utworzenia |
| `powodPrzegladu`, `blad` | tekst | `CREATE_UNCERTAIN`, `SEND_UNCERTAIN`, `INVOICE_MISMATCH`, `INVOICE_STATUS`, `ZMIANA_DANYCH`, `KONTAKT`, `KWOTA` |
| `przygotowano`, `zatwierdzono`, `rozpoczetoTworzenie`, `utworzono`, `rozpoczetoWysylke`, `wyslano`, `zmieniono` | tekst (ISO) | znaczniki czasu |
| `writeToken` | tekst | wykrywanie równoległej / ręcznej zmiany |
| `historia` | tablica | ostatnie 50 przejść `{ts, z, na, info}` |

**`rodzaj = ZAMOWIENIE`** — przypisanie zamówienia. `_id` = hash `toto/invoice-order/v2/{orderId}`.
Pola: `rodzaj`, `wersjaModelu`, `miesiac`, `orderId`, `klientContactId`, `operationId`, `status`, `przypisano`.
Ponieważ Wix odrzuca `insert` z istniejącym `_id`, **zamówienie nie może trafić do dwóch operacji**.

Model: `invoiceId ↔ orderIds[] ↔ contactId ↔ miesiąc` w wierszu `FAKTURA`
oraz `orderId → operationId` w wierszu `ZAMOWIENIE`.

> Nie edytuj ręcznie `status`, `writeToken` ani przypisań. Zmiany stanu tylko przez `rozstrzygnijFakture`.

## 4. Logika rozliczenia

Dla każdego wiersza `UmowyMiesiace` z miesiąca `2026-11` i `orderId`:

1. Odczyt zamówienia (Search Orders `id $in`, brakujące — `getOrder`).
2. Weryfikacja powiązania: `buyerInfo.contactId` = kontakt cyklu = kontakt umowy;
   `channelInfo.externalOrderId` = `TOTO:2026-11:{umowaId}`; PLN;
   pozycje = wizyty `BOOKED` z planu; cena pozycji = `stawka`; brak innych zamówień z tym kluczem.
   Data utworzenia zamówienia **nie ma znaczenia**.
3. Uzgodnienie kwot (grosze): suma pozycji = `subtotal`; suma `appliedDiscounts` = `priceSummary.discount`;
   `total` = `subtotal − discount`; brak podatku/wysyłki/opłat.
4. Klasyfikacja:

| Sytuacja | Kategoria | Skutek |
|---|---|---|
| NOT_PAID, bez faktury, bez transakcji | `DO_FAKTURY` | nowa faktura |
| PAID + faktura (Wix lub dziennik) | `ROZLICZONE` | pomijane |
| PAID bez potwierdzonej faktury | `DO_SPRAWDZENIA` | decyzja ręczna |
| NOT_PAID, faktura już jest | `ROZLICZONE` | **bez drugiej faktury** |
| PARTIALLY_PAID / PENDING / zwroty | `DO_SPRAWDZENIA` | decyzja ręczna |
| anulowane | `ANULOWANE` | pomijane, kwota widoczna w sumach |
| 0 zł (np. rabat = wartość) | `ZEROWE` | pomijane, rabat widoczny w sumach |
| w operacji PREPARED/APPROVED | `W_PRZYGOTOWANIU` | zaplanowane |
| w operacji CREATING/NEEDS_REVIEW | `DO_SPRAWDZENIA` | decyzja ręczna |

5. Grupowanie `DO_FAKTURY` **wyłącznie po `contactId`**. Różne kontakty o tej samej nazwie
   lub e-mailu nie są łączone (PREVIEW pokazuje ostrzeżenie).
6. Plan faktury: dla każdego zamówienia pozycja usługi (`nazwa`, `ilość` = liczba wizyt, cena z zamówienia),
   a następnie **osobna ujemna pozycja dla każdego rabatu** (`Rabat — opis — zamówienie #nr`).
   Rabat jest kluczowany `orderId/discountId`, więc nie może wystąpić dwa razy;
   plan sprawdza: suma rabatów = suma rabatów zamówień, suma pozycji = suma `total` zamówień.
   Usługi o tej samej cenie z różnych zamówień zostają osobnymi pozycjami.
7. Faktura: tytuł `Listopad 2026`, PLN, termin 5 dni od wystawienia, nabywca z Wix Contacts
   (`contactId`, `email`, `firstName`, `lastName`, `fullName`, `phone`),
   `metadata.sourceRefId = operationId`, `metadata.notes` = numery zamówień.

Przykład: zamówienie A logopedia 4 × 160 = 640 zł, zamówienie B neurologopedia 4 × 180 = 720 zł
→ jedna faktura, dwie pozycje, 1360 zł, `orderIds = [A, B]`.

## 5. Instrukcja: PREVIEW

Uruchamiaj z edytora Velo (testowanie funkcji backendu) lub z tymczasowego modułu
`.web.js` z uprawnieniem **Admin**.

```js
import { podgladFaktur } from 'backend/fakturyListopad';
const r = await podgladFaktur();
```

PREVIEW: czyta CMS, zamówienia, faktury zamówień, transakcje i kontakty;
**nic nie zapisuje i nie wywołuje Wix Invoices**. Zwraca:

* `tabela` — każde zamówienie: klient, contactId, umowa, zamówienie, usługa, wizyty, stawka, brutto,
  rabaty, netto, status zamówienia i płatności, faktury Wix, stan w dzienniku, kategoria, powód;
* `proponowaneFaktury` — planowane faktury z pozycjami i sumą;
* `sumy` — **brutto, rabaty, netto, już rozliczone, do nowych faktur, do ręcznego sprawdzenia, anulowane, zerowe**;
* `kontroleSum` — `rozbicieZgodne` (netto = suma kategorii), `planyZgodne` (suma faktur = zamówienia do faktury),
  `planowaneZgodne`, `rabatyZgodne` (brutto − rabaty = netto);
* `doRecznejDecyzji`, `cykleBezZamowien`, `ostrzezenia`, `bledyGlobalne`, `gotoweDoPrzygotowania`.

Te same dane są w logach (`FAKTURY_PREVIEW_*`). Przed dalszymi krokami:
`kontroleOk = true`, `bledyGlobalne = []`, lista `doRecznejDecyzji` przejrzana.

## 6. Instrukcja: bezpieczny RUN (osobna decyzja administratora)

1. **PREPARE** — zapisuje plan w dzienniku (`PREPARED`) i przypisuje zamówienia. Bez faktur.
   ```js
   const p = await przygotujFaktury();          // lub { contactIds: ['...'] }
   // p.doZatwierdzenia = { liczba, suma, operationIds }
   ```
   Odmawia, gdy kontrole sum lub odczyty API (faktury zamówień, transakcje, duplikaty) zawiodły.
2. **APPROVE** — porównaj liczbę i sumę z PREVIEW, a potem:
   ```js
   await zatwierdzFaktury({ wszystkie: true, oczekiwanaLiczba: 57, oczekiwanaSuma: '41280.00' });
   ```
   Niezgodna liczba/suma lub zmienione zamówienia = odmowa bez zapisu.
3. **Pierwsza faktura próbna** — tylko utworzenie, jedna operacja, najlepiej klient z rabatem:
   ```js
   await wykonajFaktury({ maxOperacji: 1, etap: 'UTWORZ', operationIds: ['...'] });
   ```
   Obejrzyj fakturę w panelu (pozycje, ujemny rabat, suma, termin). Jeżeli Wix odrzuci ujemną
   pozycję, operacja przejdzie do `NEEDS_REVIEW` — patrz §8 (tryb `INVOICE_DISCOUNT`).
4. **Wysyłka próbna**: `wykonajFaktury({ maxOperacji: 1, etap: 'WYSLIJ', operationIds: ['...'] })`.
   Sprawdź e-mail i SMS z automatyzacji Invoice Sent.
5. **Partie**: powtarzaj `wykonajFaktury({ maxOperacji: 2 })` do `pozostaloDoUtworzenia = 0`
   i `pozostaloDoWyslania = 0`. Każde wywołanie mieści się w ok. 30 s.
6. Na koniec `statusFaktur()` i ponowny `podgladFaktur()`: `doNowychFaktur = 0`, netto bez zmian.

RUN przed każdą fakturą ponownie odczytuje zamówienia; jeśli coś się zmieniło
(opłata, nowa faktura, rabat, anulowanie) — `NEEDS_REVIEW / ZMIANA_DANYCH`, bez faktury.

**Skrypt nie oznacza zamówień jako opłaconych.** Wysłanie faktury nie jest opłatą,
a opłacenie faktury samodzielnej (STANDALONE) tworzy w Wix nowe zamówienie — nie oznacza
zamówień listopadowych jako PAID. Uzgodnienie płatności z zamówieniami pozostaje procesem ręcznym.

**SMS**: istniejąca automatyzacja Invoice Sent wysyła SMS po każdej wysyłce. Skrypt nie dodaje
własnego SMS. Ryzyko podwójnego SMS = ryzyko podwójnej wysyłki, któremu zapobiega stan `SENDING`
i blokada ponowienia bez decyzji. Nie wysyłaj faktur ręcznie z panelu, gdy operacja jest
`CREATED` — w takim wypadku zrób `rozstrzygnijFakture({ decyzja: 'WYSLANA' })` zamiast RUN.

## 7. Wznowienie po timeoutcie

Platforma przerywa wywołanie po ok. 59 s; skrypt sam kończy partię po `maxSekund` (30 s).

1. `statusFaktur()` — zobacz statusy.
2. Jeśli kolejne wywołanie zwraca `LOCK_REVIEW` (blokada > 5 min po przerwanym wywołaniu):
   sprawdź w logach, że nic nie działa, i `zwolnijBlokadeFaktur({ potwierdzam: true })`.
   Jeżeli zwraca `BUSY` — inne wywołanie trwa, poczekaj.
3. Uruchom ponownie `wykonajFaktury({ maxOperacji: 2 })`. Na starcie RUN:
   * `CREATING` → `NEEDS_REVIEW / CREATE_UNCERTAIN` (**bez ponownego tworzenia**);
   * `SENDING` → `getInvoice().wasSent === true` ? `SENT` : `NEEDS_REVIEW / SEND_UNCERTAIN`;
   * `CREATED` → wysyłka (po kontroli faktury);
   * `APPROVED` → utworzenie (po ponownej weryfikacji zamówień).

`PREPARED`/`APPROVED` można powtarzać bez ryzyka — nie było wywołania Wix Invoices.

## 8. Stany niepewne — procedura

Każda decyzja: `rozstrzygnijFakture({ operationId, decyzja, invoiceId?, uwagi, potwierdzam? })`.
Wszystkie wymagają blokady i zapisują wpis w `historia`.

| Stan | Co sprawdzić | Decyzja |
|---|---|---|
| `CREATE_UNCERTAIN` (przerwa/błąd podczas `createInvoice`) | panel **Faktury**: faktura dla kontaktu z tytułem „Listopad 2026”, kwotą operacji; logi `FAKTURA_UTWORZONA` (operationId → invoiceId) | faktura jest → `FAKTURA_ISTNIEJE` + `invoiceId` (skrypt sprawdza kontakt, sumę i `metadata.sourceRefId`); faktury nie ma → `FAKTURY_BRAK` + `potwierdzam: true` (wraca do `APPROVED`) |
| `SEND_UNCERTAIN` (przerwa/błąd podczas `sendInvoice`) | panel: czy faktura oznaczona jako wysłana; skrzynka klienta; czy wyszedł SMS | wysłana → `WYSLANA`; na pewno nie → `WYSLIJ_PONOWNIE` + `potwierdzam: true` |
| `INVOICE_MISMATCH` (faktura różni się od planu) | treść faktury w panelu | nie wysyłaj; popraw/unieważnij fakturę ręcznie → `ZAMKNIJ_RECZNIE` + `uwagi` |
| `ZMIANA_DANYCH`, `KONTAKT`, `KWOTA` (przed `createInvoice`) | PREVIEW | `ANULUJ` (zwalnia zamówienia) i ponowny PREPARE |
| `INVOICE_STATUS` (faktura unieważniona/opłacona przed wysyłką) | panel | `ZAMKNIJ_RECZNIE` lub `WYSLIJ_PONOWNIE` |

Zasady: nigdy nie usuwaj wiersza `CREATING` ani przypisań ręcznie; `ANULUJ` jest możliwe tylko,
gdy `utworzenieRozpoczete = false`.

Tryb rabatu: jeżeli Wix Invoices odrzuci ujemną cenę pozycji, ustaw w konfiguracji
`trybRabatu: 'INVOICE_DISCOUNT'` (suma rabatów jako rabat kwotowy faktury, `type: 'Fixed'`),
anuluj niezrealizowane operacje (`ANULUJ`) i ponów PREPARE/APPROVE. Rabaty są wtedy wymienione
w opisach, a suma faktury pozostaje identyczna.

## 9. Potwierdzone ograniczenia API Wix

Na podstawie aktualnej dokumentacji Wix (dev.wix.com) z października 2026:

1. **wix-billing-backend `createInvoice`** zwraca `{ id: { id, version } }`; **`sendInvoice(id: IdAndVersion, emailInfo)`**
   przyjmuje płaskie `{ id, version }`. `getInvoice(id)` zwraca `status`, `totals`, `metadata`, `wasSent`, `id.version`.
2. Stare API faktur Velo **nie ma wyszukiwania/listowania faktur** — nie da się automatycznie znaleźć faktury
   utworzonej przed przerwą. Dlatego `metadata.sourceRefId` + log + decyzja ręczna.
3. `createInvoice` przyjmuje jeden rabat na fakturę (`discount: { value, type: 'Fixed' }`);
   dokumentacja nie potwierdza, że ujemna cena pozycji jest akceptowana — stąd faktura próbna i tryb zapasowy.
4. Nowe API **Get Paid Invoices (`@wix/get-paid`)** nie jest dostępne dla wszystkich witryn (błąd `428` do czasu migracji).
   Skrypt go nie używa.
5. **Faktura STANDALONE** po pierwszej płatności tworzy **nowe** zamówienie eCommerce
   (`reference.standaloneReference.orderId`). Opłacenie faktury nie oznacza zamówień listopadowych jako PAID.
6. **Order Invoices `listInvoicesForMultipleOrders`** zwraca tylko faktury powiązane z zamówieniem
   (np. automatyczne faktury eCommerce). Faktury samodzielne (październik, listopad) **nie są** tam widoczne —
   dla nich źródłem prawdy jest dziennik `FakturyMiesieczne`.
7. **Search Orders** domyślnie pomija statusy `PENDING` i `REJECTED`, nigdy nie zwraca `INITIALIZED`;
   filtr `id`, `channelInfo.externalOrderId`, `buyerInfo.contactId` obsługuje `$in`. Brakujące zamówienia — `getOrder`.
   Jeśli filtr zostałby zignorowany, skrypt to wykrywa i przechodzi na `getOrder` / blokuje PREPARE.
8. **Order Transactions `listTransactionsForMultipleOrders`** — do 100 zamówień; zamówienia bez uprawnień są pomijane
   (skrypt traktuje brak odpowiedzi jako „nieznane”).
9. `paymentStatus`: `NOT_PAID`, `PAID`, `PARTIALLY_PAID`, `PENDING`, `PENDING_MERCHANT`, `PARTIALLY_REFUNDED`,
   `FULLY_REFUNDED`, `CANCELED`, `DECLINED`. `PAID` nie mówi nic o fakturze.
10. Rabaty zamówienia: `appliedDiscounts[]` (`merchantDiscount.amount` + `description`, `coupon`, `discountRule`,
    `lineItemDiscounts`) i `priceSummary.discount`; skrypt wymaga ich zgodności.
11. `bulkUpdateOrders` nie pozwala zmienić statusu płatności (lista edytowalnych pól w dokumentacji).
    Rejestrowanie płatności (`orderTransactions.addPayments`) istnieje, ale skrypt **świadomie go nie używa** —
    zamówienia nie są oznaczane jako opłacone.

## 10. Przypadki wymagające ręcznej decyzji

* zamówienie `PAID` bez potwierdzonej faktury (zapłata gotówką? faktura wystawiona ręcznie?);
* zamówienie częściowo opłacone, `PENDING`, zwrot, chargeback;
* niezgodność kwot/rabatów zamówienia, podatek lub opłaty dodatkowe;
* zamówienie innego kontaktu niż umowa, inny `externalOrderId`, pozycje niezgodne z planem wizyt;
* dodatkowe zamówienie z tym samym kluczem umowy i miesiąca;
* cykl `UmowyMiesiace` inny niż `DONE` lub bez zamówienia (`cykleBezZamowien`);
* zamówienie anulowane z powiązaną fakturą;
* zamówienie zafakturowane w dzienniku **i** w eCommerce;
* kontakt scalony / bez e-maila; ta sama nazwa lub e-mail u różnych kontaktów (faktury pozostają osobne);
* wszystkie stany `NEEDS_REVIEW` z §8;
* faktury listopadowe wystawione ręcznie w panelu **poza** skryptem — API nie pozwala ich wykryć;
  przed PREPARE potwierdź, że takich nie ma, albo wyłącz tych klientów (`contactIds`).
