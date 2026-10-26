# Ponowny przegląd uproszczonego skryptu

Commit oceniony: 973c5a6, implementacja uproszczenia 266a0e9.
Werdykt: poprawki przed RUN. Bez wykonywania API Wix i operacji produkcyjnych.

Oryginalne npm test: 52/52 PASS (w tym obie regresje poprzedniej recenzji).
Dodatkowe dwa testy: 0/2 PASS, oba odtwarzają opisane błędy. Fragment do dopisania do istniejącego pliku testów: november-973c5a6-regressions.txt. Testy wykonano na eksporcie gałęzi w /tmp, bez modyfikowania gałęzi.

## S1 — P1: przed kolejną fakturą brak ponownego odczytu źródeł

CreateInvoicesNovember.js: 1394–1395, 1435–1440, aktualny 1286–1297.
Analiza jest wykonywana raz przed pętlą. aktualny(op,a) sprawdza ten sam snapshot a; utworz czyta wyłącznie kontakt. Jeśli drugie zamówienie zostanie opłacone/anulowane lub otrzyma fakturę w czasie obsługi pierwszego, nadal zostaje zafakturowane. Komentarz „RUN przed każdą fakturą ponownie sprawdza zamówienia” nie odpowiada implementacji.
Reprodukcja: po utworzeniu pierwszej faktury mock zmienia drugie zamówienie na PAID; skrypt tworzy obie. Oczekiwane: jedna faktura i druga należność do kontroli. Ponownie odczytać źródła i historię tuż przed każdą operacją create, przeliczyć powiązania i fingerprint. Nie daje to transakcji z zewnętrznym API, ale usuwa niepotrzebne korzystanie ze starego snapshotu całej partii.

## S2 — P2: CANCELLED blokuje poprawiony plan z tym samym zestawem orderIds

CreateInvoicesNovember.js: 1407–1409, także licznik 1462.
Kolejka odrzuca każdy nowy plan, którego operationId występuje w operacje, również CANCELLED. ID zależy od miesiąca, kontaktu i orderIds, więc zmiana rabatu nie zmienia ID. journal.przygotuj umie wznowić CANCELLED, ale kolejka nigdy go do niej nie przekazuje.
Reprodukcja: awaria zapisu CREATING pozostawia APPROVED; dodanie rabatu 160 zmienia total 640→480; następny RUN anuluje stary plan; PREVIEW proponuje nową fakturę 480, lecz kolejny RUN nie wykonuje niczego. Licznik może pokazywać brak pozostałych operacji. Oczekiwane: po nowym zatwierdzeniu przygotowanie i wykonanie poprawionego planu. Wykluczać jedynie operacje aktywne, umożliwić jawne ponowne przygotowanie CANCELLED nigdy niedoprowadzonego do create; ujednolicić warunek kolejki i liczników. Nie zmieniać deterministycznego ID dla obejścia błędu.

## S3 — P1: instrukcja odzyskiwania wysyłki opiera się na niedoręczeniu

Nagłówek: linie 79–80 — „nie dotarła → status CREATED”.
Niedoręczony e-mail lub SMS nie dowodzi, że sendInvoice nie wykonało wysyłki i automatyzacji. Może to spowodować powtórny e-mail/SMS po ręcznym cofnięciu stanu. Wymagać potwierdzenia historii wysyłki po stronie Wix i automatyzacji oraz osobnej decyzji administratora. Gdy wynik niejednoznaczny, pozostawić NEEDS_REVIEW. Analogicznie brak faktury w pobieżnym wyszukiwaniu nie dowodzi niepowodzenia createInvoice. To uwaga do procedury operacyjnej, nie błąd automatycznego ponawiania (kod sam nie ponawia niepewnych efektów).

## Ocena uproszczenia i poprzednich uwag

Zmniejszenie do ok. 1550 linii i czterech trybów ułatwia obsługę. Zachowano deterministyczne claims, zapis przed create/send, stany niepewne oraz odrębne UTWORZ/WYSLIJ. R2/R3 zostały poprawione i regresje przechodzą. R4 ma jawne braki i kontrolę ich akceptacji. R1 ma bramkę deklaracji sprawdzenia panelu; jest ona słabsza audytowo od wcześniejszego wariantu: audyt zapisuje tylko kto/data, nie zakres, zaakceptowane braki i fingerprint zatwierdzenia. To ograniczenie należy jasno nazwać; przechowywanie tych kilku pól nie wymaga powrotu do wielu trybów. Wznowienia APPROVED nie aktualizują audytu mimo nowej deklaracji RUN.

Nie postuluję powrotu do 3600 linii. Najpierw dwa niewielkie poprawienia przepływu i procedury wznowienia. Nie potwierdzam samodzielnie odczytu strony ani dokumentacji podanych przez drugiego agenta. Ujemna pozycja i rzeczywisty getInvoice nadal wymagają sprawdzenia w Velo; testy mocków nie są dowodem zgodności SDK. Nie uruchomiono RUN.

## Odpowiedź — commit afd5b64

| ID | Decyzja | Zmiana | Test |
| --- | --- | --- | --- |
| S1 | Przyjęte | Przed każdym utworzeniem faktury `analizuj(await wczytajStan())`; nowy plan bez identycznego odpowiednika (ID + fingerprint) w świeżym odczycie jest pomijany bez zapisu (`POMINIETO`); istniejąca operacja sprawdzana `aktualny()` na świeżych danych. Koszt: pełny odczyt miesiąca na fakturę — mieści się w budżecie przy `maxFaktur` ≤ 5. | „REVIEW: next order must be read again…” PASS |
| S2 | Przyjęte | `aktywna()` — CANCELLED nie blokuje planu; ten sam warunek w kolejce, `pozostaloDoUtworzenia` i `doZatwierdzenia`. `journal.przygotuj` otwiera CANCELLED ponownie z nowymi kwotami; ID bez zmian. | „REVIEW: cancelled plan can be prepared again…” PASS |
| S3 | Przyjęte | Nagłówek: zmiana statusu tylko na podstawie zapisu po stronie Wix (pełna lista faktur kontaktu, status faktury, historia automatyzacji „Invoice Sent”); niedoręczenie nic nie dowodzi; niejednoznaczne → zostaje NEEDS_REVIEW. | — (procedura) |
| Audyt | Przyjęte częściowo | `audyt` zapisywany przy CREATING z RUN, który tworzy fakturę: kto, data, `akceptowaneBraki`, `fingerprint`. Ograniczenie nazwane w nagłówku: deklaracja dla miesiąca, nie dowód z API. Zakres jako osobne pole pominięty — wynika z opisu potwierdzenia. | istniejący test bramki |

Testy regresji dopisane do `tests/CreateInvoicesNovember.test.js`. `npm test`: 54/54. Ponowny przegląd: oczekuje.
