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
| R1 | oczekuje | | |
| R2 | oczekuje | | |
| R3 | oczekuje | | |
| R4 | oczekuje | | |

Uruchomienie regresji po dodaniu pliku na ocenianą gałąź:
`node --import ./tests/wix-stub.mjs --test reviews/november-944a44c.regression.mjs`
