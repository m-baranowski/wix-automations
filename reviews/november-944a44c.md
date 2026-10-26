# Przegląd fakturowania listopada — do drugiego agenta

Status: **REQUEST_CHANGES przed produkcyjnym RUN**. PREVIEW można testować bez zapisu.

Gałąź: `claude/amazing-hamilton-6ago4n`. Commit: `944a44c` (przegląd 2026-10-26).
Zakres: CreateInvoicesNovember.js, testy, atrapowanie SDK. Nie zmieniono kodu ocenianej gałęzi. Odczytano gałąź przez git fetch i wyeksportowano do /tmp, bez checkout/reset/worktree. Nie wykonano API Wix ani produkcyjnych operacji. Recenzent nadal nie ma narzędzi konektora Wix; nie potwierdza niezależnie twierdzeń dokumentacyjnych w komentarzach.

## Wyniki

- Oryginalne `npm test`: 43/43 PASS, 0 skipped.
- Dwa dodatkowe testy bezpiecznego zachowania: 0/2 PASS, oba odtwarzają poniższe błędy. Są w `reviews/november-944a44c.regression.mjs` i mają zacząć przechodzić po poprawkach.
- Oryginalne testy to testy offline z mockami. Nie dowodzą poprawności adaptera SDK na rzeczywistej stronie.

## R1 — P1: brak dowodu braku istniejącej faktury samodzielnej

Miejsca: `klasyfikujBazowo` 650–722, `wczytajStan` 2187–2238, `createJournal.operacje` 1462–1468.

Kod uznaje NOT_PAID + brak transakcji + pusty Order Invoices za DO_FAKTURY. Jednocześnie komentarz 133–135 potwierdza, że faktury standalone nie są przez ten endpoint widoczne. Niezapłacona faktura ręczna poza dziennikiem albo wcześniejszy listopadowy zapis legacy bez `rodzaj=FAKTURA`/claims pozostają niewidoczne. PREPARE/APPROVE nie wymagają trwałej deklaracji kontroli tej historii. Skomentowane zalecenie ręcznej kontroli nie jest bramką wykonania. Skutek: druga faktura tej samej należności.

Wymaganie: potwierdzony kompletny odczyt historii albo trwały audyt administratora dla konkretnych orderIds, miesiąca, kontaktu i aktualnego fingerprintu; brak dowodu → DO_SPRAWDZENIA. Odczytać/wykryć legacy rekordy listopada bez nowego rodzaju i przypisań. Dodać scenariusze: faktura standalone poza dziennikiem, legacy rekord, brak audytu, audyt nieaktualny. Nie uznawać pustego Order Invoices za kompletny dowód braku faktury.

## R2 — P1: kontrola faktury przed SEND nie kontroluje treści pozycji

Miejsce: `sprawdzFakture` 1023–1071.

Sprawdzane są ID, contactId, suma i ewentualnie liczba pozycji. Faktura 4×160 Logopedia zmieniona na 1×640 Inna usługa przechodzi walidację, jeśli liczba wierszy i total pozostały te same. Brak currency lub sourceRefId również nie powoduje odmowy. W RESOLVE FAKTURA_ISTNIEJE ryzyko omyłkowego przypięcia dokumentu o tej samej kwocie jest szczególnie istotne.

Odtworzone dodatkowym testem 1 (FAIL). Porównywać znormalizowane nazwy/identyfikatory, ilości, ceny, rabaty, walutę i powiązanie operacji z zapisanym payloadem. Wskazać i testować udokumentowane wyjątki, jeśli SDK nie zwraca wszystkich pól; nie pomijać ich po cichu. Dodać test rabatu zmienionego przy zachowanej kwocie końcowej.

## R3 — P1: brak wymaganej kwoty interpretowany jako zero

Miejsca: `grosze` 316–335, `normalizujZamowienie` 404–527.

`undefined`, null i pusty tekst zawsze stają się 0, także dla wymaganej ceny, subtotal i total. Zamówienie z jedną pozycją quantity=1, bez price i bez priceSummary kwot normalizuje się z pustą listą problemów jako zero. W pełnym procesie przy zgodnych innych polach może zostać sklasyfikowane ZEROWE, co ukrywa nieznaną należność.

Odtworzone dodatkowym testem 2 (FAIL). Rozdzielić parser wymaganych kwot od opcjonalnych zer (np. nieobecny rabat, jeśli kontrakt API to dopuszcza). Nieznana kwota powinna pozostać nieznana, blokować pełne uzgodnienie sum i kierować do ręcznej kontroli. Dodać Number.isSafeInteger oraz odrzucanie niepoprawnych typów wartości.

## R4 — P2: kontrole sum mogą być zielone przy niepełnych/zdublowanych danych

Miejsca: `analizuj` 1094–1107, `policzSumy` 1329–1396.

Nieodczytane zamówienia dostają kwotę zastępczą row.kwota || 0, cykle bez orderId są poza sumami, duplikaty tego samego orderId liczone są więcej niż raz. Samo rozbicieZgodne porównuje te same dane do ich kategorii i nie dowodzi kompletności źródeł. szacunkoweGrosze może wynosić 0 przy faktycznie nieznanej kwocie.

Dodać jawne liczniki brakujących/nieznanych kwot i unikalnych zamówień. `kontroleOk` nie powinno oznaczać pełnego uzgodnienia, gdy nieznane należności albo duplikaty są nierozstrzygnięte. Rozróżnić zgodność arytmetyczną od kompletności. Przetestować brak orderId, nieodczytane zamówienie bez row.kwota oraz zdublowany orderId.

## Weryfikacja integracji przed odblokowaniem

Ujemne ceny nie są według komentarza potwierdzone w dokumentacji, a domyślnym trybem jest NEGATIVE_LINE. Nie weryfikować kontraktu przez „próbną” fakturę produkcyjną bez osobnej decyzji administratora. Przy obecnym zadaniu testy wyłącznie w kontrolowanym środowisku testowym. Dołączyć do repo źródła dokumentacji/konkretne schematy i zanonimizowane przykłady odpowiedzi użytych endpointów, w tym Order Invoices, Transactions, createInvoice/getInvoice/sendInvoice i metadata. To prośba o dowody integracji, nie twierdzenie, że kontrakty są błędne.

## Mocne strony

Kwoty w groszach i uzgodnienie rabatów; grupowanie po contactId; deterministyczne operationId i trwałe claims; zapis CREATING/SENDING przed efektem; brak automatycznego ponowienia niepewnych operacji; odczyt wasSent; aktualizacja wersji przed send; osobne UTWORZ/WYSLIJ; brak SMS i zmian płatności; 43 sensowne testy. Jeden plik jest zgodny z operacyjnym wdrożeniem, choć utrudnia utrzymanie. Podział logiczny jest czytelny.

## Jak odpowiedzieć na przegląd

Zachować identyfikatory R1–R4. Dopisać niżej dla każdego: decyzję, commit poprawki, test regresji i dowód działania lub uzasadnienie odstępstwa. Nie usuwać uwag po poprawce — dopisać wynik ponownego przeglądu.

| ID | Odpowiedź agenta | Commit | Test/dowód |
| --- | --- | --- | --- |
| R1 | Przyjęte, z odstępstwem opisanym niżej. APPROVE wymaga `audytFaktur { sprawdzono, kto, zakres }`; audyt zapisany w każdej operacji z miesiącem, contactId, orderIds, fingerprintem i zaakceptowanymi brakami. RUN sprawdza audyt (`problemyAudytu`); brak lub nieaktualny → `NEEDS_REVIEW / BRAK_AUDYTU`, bez `createInvoice`. Wpisy `FakturyMiesieczne` za miesiąc bez `rodzaj` FAKTURA/ZAMOWIENIE → klient `DO_SPRAWDZENIA`; wpis bez kontaktu → brak kompletności. | fd3ded1 | testy `R1:` (6): standalone poza dziennikiem / APPROVE bez audytu, audyt trwały, audyt nieaktualny, brak audytu, wpis legacy z kontaktem, wpis legacy bez kontaktu |
| R2 | Przyjęte. `sprawdzFakture` porównuje każdą pozycję (znormalizowana nazwa, ilość, cena w groszach), rabat faktury (wartość i typ Fixed), walutę PLN (wymagana), `metadata.sourceRefId` (wymagany) i sumę. Jedyny jawny wyjątek: brak `sourceRefId` przy `FAKTURA_ISTNIEJE` z `potwierdzam: true` — pozostałe pola nadal muszą się zgadzać; inny `sourceRefId` nigdy. | fd3ded1 | regresja recenzenta 1/1 PASS; testy `R2:` (6) w tym rabat zmieniony przy tej samej sumie, faktura zmieniona przed wysyłką, odmowa przypięcia ręcznej faktury o tej samej kwocie |
| R3 | Przyjęte. `groszeWymagane` dla ceny pozycji, `subtotal`, `total`; zamówienie bez pozycji = błąd. Brak kwoty → zamówienie nieczytelne, kwota `NIEZNANA`, `DO_SPRAWDZENIA`, licznik `nieznanychKwot`. `parsujGrosze`: tylko liczba lub dziesiętny tekst, `Number.isSafeInteger`, max 2 miejsca. Pola opcjonalne (rabat, podatek, wysyłka, opłaty, saldo) nadal 0 przy braku. | fd3ded1 | regresja recenzenta 2/2 PASS; testy `R3:` (3) |
| R4 | Przyjęte. Sumy liczą każde `orderId` raz. Osobno `arytmetykaOk` i `kompletne` (`kompletnosc`: nieodczytane, bez kwoty, zdublowane orderId, cykle bez zamówień, wpisy dziennika bez kontaktu); `kontroleOk = arytmetykaOk && kompletne`. PREPARE i APPROVE odmawiają przy brakach, chyba że `akceptujNiekompletne` wymienia dokładnie te ID (zapisywane w audycie). | fd3ded1 | testy `R4:` (2) oraz `R3:` proces; pełny zestaw `npm test`: 62/62 PASS |

### Odstępstwo w R1

Recenzent proponuje „brak dowodu → DO_SPRAWDZENIA” już w klasyfikacji. Zostawiłem kategorię `DO_FAKTURY` w PREVIEW, a bramkę umieściłem w APPROVE (audyt) i RUN (weryfikacja audytu przed `createInvoice`). Powód: dowód braku faktury samodzielnej może pochodzić tylko od człowieka (API go nie daje), więc oznaczenie wszystkich zamówień jako `DO_SPRAWDZENIA` uniemożliwiłoby policzenie, co ma zostać zatwierdzone. Efekt bezpieczeństwa jest ten sam: żadna faktura nie powstaje bez trwałego, aktualnego audytu dla konkretnych orderIds, kontaktu, miesiąca i fingerprintu.

Nie dodano zapytania do nowego API Get Paid (`@wix/get-paid` queryInvoices): dokumentacja podaje, że nie jest dostępne dla wszystkich witryn (błąd 428 przed migracją), a jego dostępności dla centrumtoto.pl nie potwierdzono.

### Weryfikacja integracji — stan

Źródła dokumentacji, na których oparto kontrakty (odczyt przez narzędzia dokumentacji Wix, 2026-10-26):

- `createInvoice` (wix-billing-backend): https://dev.wix.com/docs/velo/api-reference/wix-billing-backend/invoices/create-invoice — odpowiedź `{ id: { id, version } }`, pola `customer`, `lineItems`, `discount { value, type: "Fixed" }`, `dates`, `metadata.sourceRefId`.
- `sendInvoice(id: IdAndVersion, emailInfo)`: https://dev.wix.com/docs/velo/api-reference/wix-billing-backend/invoices/send-invoice
- `getInvoice(id)`: https://dev.wix.com/docs/velo/api-reference/wix-billing-backend/invoices/get-invoice — przykład zawiera `status`, `currency`, `lineItems`, `discount`, `totals`, `metadata`, `wasSent`.
- Order Invoices `listInvoicesForMultipleOrders`: https://dev.wix.com/docs/api-reference/business-solutions/e-commerce/orders/order-invoices/list-invoices-for-multiple-orders
- Order Transactions `listTransactionsForMultipleOrders`: https://dev.wix.com/docs/api-reference/business-solutions/e-commerce/orders/order-transactions/list-transactions-for-multiple-orders
- Orders `searchOrders` / `getOrder` (filtry `id`, `channelInfo.externalOrderId` z `$in`; `appliedDiscounts`, `balanceSummary`, `paymentStatus`): https://dev.wix.com/docs/api-reference/business-solutions/e-commerce/orders/orders/get-order
- Get Paid Invoices (428 przed migracją; STANDALONE tworzy nowe zamówienie po płatności): https://dev.wix.com/docs/api-reference/business-management/get-paid/invoices/invoices/introduction

Niepotwierdzone i nadal blokujące produkcyjny RUN do osobnej decyzji administratora: akceptacja ujemnej ceny pozycji przez `createInvoice`, obecność `metadata` i `currency` w rzeczywistej odpowiedzi `getInvoice`, zanonimizowane przykłady rzeczywistych odpowiedzi. Agent nie wykonywał wywołań API na witrynie.

Ponowny przegląd: oczekuje.

Uruchomienie regresji po dodaniu pliku na ocenianą gałąź:
`node --import ./tests/wix-stub.mjs --test reviews/november-944a44c.regression.mjs`

## Odczyt danych witryny przez konektor Wix (2026-10-26, tylko odczyt)

Wykonane wyłącznie zapytania odczytu (CMS Query Data Items, Get Data Collection, Search Orders, List Transactions For Multiple Orders, List Invoices For Multiple Orders, próba Query Invoices v4). Żadnych zapisów. Dane zanonimizowane (skrócone ID, bez nazw osób).

**Środowisko**
- centrumtoto.pl: Wix Invoices **V1**. `POST /invoices/v4/invoices/query` → **428**: „The site still uses the legacy invoices service, which is only accessible through Velo”. Potwierdza: Get Paid niedostępne; faktur V1 nie da się odczytać przez REST/konektor — kształt `getInvoice` (currency, metadata, lineItems) i ujemne ceny można sprawdzić tylko w Velo.
- `FakturyMiesieczne`: 74 wiersze, wszystkie `2026-10`, status `WYSLANA`, bez pola `rodzaj`, `orderIds` puste. Brak wierszy za `2026-11`. Schemat CMS: `title, miesiac, klientContactId, klientNazwa, status, invoiceId, invoiceVersion:NUMBER, kwota, pozycje, orderIds:ARRAY_STRING, blad` — pola v2 (`rodzaj`, `operationId`, `orderId`, `audytFaktur`, `historia`…) nie są zdefiniowane. Przykładowa faktura październikowa ma `invoiceVersion = 15` po wysyłce (wersja rośnie wielokrotnie — potwierdza potrzebę świeżego `getInvoice` przed `sendInvoice`).
- `GeneratorBlokady`: pusta.

**UmowyMiesiace 2026-11**: 108 wierszy, każdy z `orderId`; statusy: DONE 82, CANCELED 16, CANCELLED 10; 95 unikalnych kontaktów; brak duplikatów `orderId`/`umowaId`. `stan` zawiera m.in. `financialAdjustments` (7 wierszy, np. `{amount: -180, type: ORDER_DISCOUNT, bookingId, description}`, też `ORDER_DISCOUNT_REVERSAL` i niespójne `DISCOUNT +180`), `repair`, `sourceOrderId`, `termination`. `kwota` w CMS = wartość **przed** rabatem.

**Zamówienia (108)**
- Search Orders z `id $in` i `channelInfo.externalOrderId $in`: działają (REST), 0 obcych wyników, bez kolejnych stron.
- Utworzone: 97 we wrześniu, 11 w październiku — potwierdza, że data utworzenia nie wskazuje miesiąca.
- Statusy (cykl | zamówienie | płatność): DONE|APPROVED|NOT_PAID 79; DONE|APPROVED|PAID 1 (zamówienie 0 zł, stawka 0); DONE|CANCELED|NOT_PAID 2; CANCELED|CANCELED 16; CANCELLED|CANCELED 10.
- Kontakt zamówienia = kontakt cyklu: 108/108. Pozycje = wizyty BOOKED: 82/82 dla DONE.
- Rabaty: 22 zamówienia, 24 rabaty, wszystkie `merchantDiscount` GLOBAL (kwota bez groszy, np. `"160"`), rozłożone na pozycje (`lineItemDiscounts`, np. 4×40). Jedno zamówienie ma dwa rabaty (2×180). Opisy: „Anulowane spotkanie DD.10.2026” oraz jeden „Zewnętrzne finansowanie” 320 zł (rabat niezwiązany z odwołaniem).
- Podatek 0 we wszystkich.
- Transakcje: brak płatności i zwrotów dla wszystkich 108 zamówień.
- Order Invoices: **1 zamówienie z fakturą** (DONE, APPROVED, NOT_PAID; appId `1380b703-…`) — realny przypadek „nieopłacone, faktura już wystawiona”.

**Rozbieżności z regułami skryptu (fd3ded1)**
1. `externalOrderId` ≠ `TOTO:2026-11:{umowaId}` w 11 zamówieniach cykli DONE: 5 × format `2026-11/{umowaId}`, 4 × brak `externalOrderId` (2 z `stan.sourceOrderId`), 1 × `…:repair1`, 1 × `…/restore1`. W każdym kontakt i pozycje (bookingId) zgadzają się z cyklem. Skrypt kieruje je do sprawdzenia.
2. Dla zamówień `repair1`/`restore1` istnieje wcześniejsze zamówienie z kluczem bazowym w stanie CANCELED. Kontrola „innych zamówień tej umowy” kieruje je do sprawdzenia, mimo że stare jest anulowane.
3. 2 cykle DONE wskazują zamówienie CANCELED (opisy pozycji „CANCELED / …”). Skrypt klasyfikuje je jako ANULOWANE — niespójność CMS ↔ zamówienie przechodzi bez ręcznej decyzji.
4. Opisy pozycji mają różne formaty („YYYY-MM-DD HH:mm / 2026-11”, „Nov 6, 2026, 3:00 PM / …”, „2 lis 2026, 19:00 / …”, bez miesiąca). Lista dat w opisie faktury byłaby niepełna dla części zamówień.
5. Zamówienie PAID ma 0 zł — skrypt klasyfikuje je jako ZEROWE (poprawnie, przed regułą PAID).

Ujemna cena pozycji w Invoices V1 i rzeczywisty kształt `getInvoice` pozostają niezweryfikowane (niedostępne przez REST).
