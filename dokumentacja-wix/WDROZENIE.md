# Wdrożenie dokumentacji Centrum Toto

## 1. Pliki i konto

Do wdrożenia użyj trzech plików kodu:

| Plik w projekcie | Gdzie wkleić |
|---|---|
| `wix/DO-WKLEJENIA.js` | Jedna akcja „Uruchom kod Velo” w automatyzacji Wix |
| `google/owner/Code.gs` | Centralny projekt Google Apps Script konta kontakt |
| `google/template/Menu.gs` | Projekt Apps Script powiązany z każdym szablonem Google Docs |

Każdy projekt Google ma także osobny manifest `appsscript.json`. Dla projektu
centralnego użyj manifestu z `google/owner/`, a dla szablonów z `google/template/`.

Zaloguj się do Google jako **kontakt@centrumtoto.pl**. To konto musi być właścicielem
folderów i uruchamiać centralny projekt: z jego Dysku powstaną pliki, a z jego
adresu będą wysyłane wiadomości. Sprawdź adres pod ikoną konta w przeglądarce.

## 2. Foldery i szablony

W konfiguracji na początku `google/owner/Code.gs` znajdują się:

| Element | Link |
|---|---|
| Robocze | [Otwórz folder](https://drive.google.com/drive/folders/1Abgy-9XPDG_jLhAuiLo54PN3j9_RcYv8) |
| Udostępnione | [Otwórz folder](https://drive.google.com/drive/folders/1JiSDKi478Yj-2FF_avcyhYKOnqfWBVMY) |
| Archiwum | [Otwórz folder](https://drive.google.com/drive/folders/1Ke_t2B1sELtD8SL-PZ_E8B7Lg3l19dTo) |
| Szablon ADOS-2 | [Otwórz dokument](https://docs.google.com/document/d/1vvzoQ8rB0fEX7fxm32WM65s8VYXuy1f_HA8LicqEgt4/edit) |
| Szablon SI | [Otwórz dokument](https://docs.google.com/document/d/1n24v4qDx7DF5mPh_4AMVxEY3lq_QT1D0F_uDoD05ypM/edit) |
| Diagnoza / Informacja z przebiegu terapii — tylko ręcznie | [Otwórz dokument](https://docs.google.com/document/d/18MXHSKmE5_I4RGFqitDBJmyHSRz6cgxydCv4aUiKxU4/edit) |

Szablon `diagnoza-informacja-terapia` jest dostępny wyłącznie w panelu ręcznych
zleceń. Nie ma przypisanej usługi w `SETTINGS.services` ani w automatyzacji Wix.
Lista panelu i nazwa tworzonego pliku korzystają z rzeczywistej nazwy dokumentu
Google Docs; ustaw ją na **Diagnoza / Informacja z przebiegu terapii**.

Aby dodać go do działającego projektu, dopisz w `SETTINGS.templates`:

```javascript
'diagnoza-informacja-terapia': '18MXHSKmE5_I4RGFqitDBJmyHSRz6cgxydCv4aUiKxU4'
```

Oddziel wpisy przecinkami. Zachowaj pozostałe ustawienia działającego projektu.
Zapisz kod, uruchom **validateSetup**, a następnie zaktualizuj oba aktywne wdrożenia
do nowej wersji zgodnie z punktem 3. Dodaj menu do nowego szablonu według punktu 4
i odśwież panel ręcznych zleceń.

Na Dysku kontakt utwórz dodatkowy folder **Toto – dokumentacja – techniczne**:

1. Otwórz Google Drive i wybierz **Nowy → Nowy folder**.
2. Nadaj nazwę i otwórz utworzony folder.
3. Z adresu `https://drive.google.com/drive/folders/IDENTYFIKATOR` skopiuj sam identyfikator.
4. W `Code.gs` wpisz go w `SETTINGS.folders.ledger` zamiast tekstu `UZUPELNIJ_…`.

Wszystkie cztery foldery mają być prywatne, na Moim dysku konta kontakt, bez innych
edytorów i przeglądających. W oknie **Udostępnij** sprawdź właściciela i dostęp.
Pracownicy otrzymają dostęp do konkretnych dokumentów, a nie do folderów.
Folder techniczny przechowuje dzienniki oraz dane potrzebne do obsługi wysyłki;
nie udostępniaj go pracownikom ani klientom.

## 3. Centralny projekt Apps Script

### Utworzenie projektu i konfiguracja

1. Otwórz [Google Apps Script](https://script.google.com/) na koncie kontakt i wybierz **Nowy projekt**.
2. Nadaj projektowi nazwę, np. **Toto – dokumentacja**. Zapisz jego adres, aby wracać do niego podczas obsługi.
3. Otwórz domyślny plik kodu, zaznacz całą zawartość i wklej `google/owner/Code.gs`.
   W projekcie ma być jeden plik kodu centralnego, bez dodatkowej funkcji `myFunction`.
4. Uzupełnij `SETTINGS.folders.ledger`. Na czas konfiguracji pozostaw `SETTINGS.enabled: false`.
5. Kliknij **Ustawienia projektu** — ikonę koła zębatego w lewym pasku.
   Włącz pokazywanie pliku manifestu `appsscript.json` w edytorze.
6. Wróć do **Edytora**, otwórz `appsscript.json` i wklej zawartość
   `google/owner/appsscript.json`. Zapisz projekt.
7. W sekcji **Usługi** sprawdź obecność **Drive API**, identyfikator `Drive`, wersja `v3`.
   Manifest deklaruje tę usługę; jeśli nie ma jej na liście, dodaj ją przyciskiem **+**.
   Przy własnym standardowym projekcie Google Cloud włącz także Google Drive API w tym projekcie.

### Dodanie biblioteki szyfrującej

1. W edytorze centralnego projektu kliknij **+** obok **Biblioteki**.
2. W polu identyfikatora skryptu wpisz:

   `1T0UPf50gGp2fJ4dR1rZfEFgKYC5VpCwUVooCRNySiL7klvIUVsFBCZ9m`

3. Wyszukaj bibliotekę ZgaPdfToolkit, wybierz konkretną opublikowaną wersję
   i ustaw jej identyfikator w projekcie na **pdfkit**.
4. Dodaj bibliotekę, wyłącz tryb programisty i zapisz numer wybranej wersji.

Biblioteka wykonuje szyfrowanie AES-256 w Apps Script. Sprawdź jej działanie
na dokumencie testowym przed użyciem dokumentacji klienta.

### Ustawienie sekretu

1. Kliknij **Ustawienia projektu → Właściwości skryptu**.
2. Kliknij **Dodaj właściwość skryptu** lub **Edytuj właściwości skryptu**.
3. Dodaj klucz `HMAC_SECRET` i wartość będącą losowym sekretem o długości co najmniej 32 znaków.
4. Kliknij **Zapisz właściwości skryptu**. Tę samą wartość wpiszesz później w Wix Secrets Manager.

Sekret pozostaje we właściwościach projektu. Nie wklejaj go do pliku kodu,
repozytorium ani skryptów powiązanych z szablonami.

### Jak ręcznie uruchomić funkcję

Poniższą procedurę stosuj zawsze, gdy instrukcja wskazuje nazwę funkcji:

1. Otwórz zapisany adres centralnego projektu Apps Script na koncie kontakt.
2. Kliknij **Edytor** w lewym pasku i otwórz plik `Code.gs`.
3. Zapisz kod: **Ctrl+S** albo przycisk zapisu. Poczekaj na zakończenie zapisywania.
4. Na górnym pasku, obok **Uruchom / Run** i **Debuguj / Debug**, rozwiń listę funkcji.
5. Wybierz podaną nazwę **bez nawiasów**, np. `validateSetup`.
   Nie dopisuj wywołania do kodu i nie wpisuj go w konsoli przeglądarki.
6. Kliknij **Uruchom / Run**. Przy pierwszym uruchomieniu wybierz **Sprawdź uprawnienia**,
   konto kontakt i zatwierdź dostęp wymagany przez własny projekt.
   Jeśli Workspace blokuje autoryzację, potrzebna jest interwencja administratora.
7. Poczekaj na zakończenie. W **Dzienniku wykonania / Execution log** sprawdź błędy.
   Historię uruchomień znajdziesz pod **Wykonania / Executions** w lewym pasku.

Jeżeli funkcji nie ma na liście, sprawdź, czy kod jest zapisany i nie ma błędu
składni, następnie odśwież edytor. Uruchamiaj tylko funkcję wskazaną w danym kroku.
`doPost`, `invoke` i funkcje pomocnicze z końcowym `_` nie służą do ręcznego uruchamiania.

### Kontrola konfiguracji

Wybierz z listy **validateSetup** i kliknij **Uruchom** zgodnie z powyższą procedurą.
Sukces to wykonanie zakończone bez błędu. Funkcja zwraca tekst, ale nie wypisuje go
w dzienniku; brak dodatkowej wiadomości nie oznacza awarii. Kontrola nie wysyła maili.

W przypadku błędu popraw wskazany element i ponów `validateSetup`. Przykłady:

| Kod | Co sprawdzić |
|---|---|
| `WRONG_GOOGLE_OWNER` | Czy projekt uruchamia kontakt@centrumtoto.pl |
| `FOLDER_MUST_BE_OWNER_PRIVATE` | Właściciela folderów i ich uprawnienia |
| `PDF_LIBRARY_MISSING` | Czy biblioteka ma identyfikator `pdfkit` |
| `CONFIG_SECRET` | Czy zapisano `HMAC_SECRET` o wymaganej długości |
| `TEMPLATE_NOT_DOCS` | Czy ID wskazuje natywny dokument Google Docs |

### Test szyfrowania

1. Na koncie kontakt utwórz sztuczny dokument Google Docs z kilkoma zdaniami.
2. Z jego adresu `/document/d/IDENTYFIKATOR/edit` skopiuj identyfikator.
3. W centralnym projekcie, w **Ustawienia projektu → Właściwości skryptu**, dodaj
   `PDF_TEST_SOURCE_ID` z tym identyfikatorem i zapisz właściwości.
4. Wróć do edytora, wybierz **testEncryption** na górnej liście i kliknij **Uruchom**.
5. W dzienniku odczytaj wpis **Testowy PDF: IDENTYFIKATOR**. Plik o nazwie
   `dokumentacja.pdf` znajdziesz w folderze technicznym.
6. Pobierz PDF i sprawdź w czytniku: bez hasła i z błędnym hasłem ma być zablokowany;
   hasło **23012020** ma go otworzyć i pokazać poprawną zawartość.

Ten test tworzy jeden plik w folderze technicznym, nie udostępnia go i nie wysyła maila.
Można wykonać go przy `enabled: false`. Usuń plik testowy po sprawdzeniu.

### Automatyczne wyzwalacze

1. W centralnym edytorze wybierz **installTriggers** i kliknij **Uruchom**.
2. Otwórz **Wyzwalacze / Triggers** — ikonę zegara w lewym pasku.
3. Sprawdź dwa wpisy: `processQueue` co pięć minut i `expireLinks` co godzinę.

Po tej konfiguracji wyzwalacze działają samodzielnie. Ponowne uruchomienie
`installTriggers` zastępuje wyzwalacze tych dwóch funkcji w tym projekcie.

### Dwa aktywne wdrożenia aplikacji internetowej

Centralny projekt Apps Script ma **dwa aktywne wdrożenia** tego samego kodu.
Oba działają jako **Ja — kontakt@centrumtoto.pl**, ale mają różne ustawienia dostępu i adresy.

| Nazwa wdrożenia | Kto ma dostęp | Przeznaczenie |
|---|---|---|
| **Brama Wix i menu** | **Każdy / Anyone** | Żądania z automatyzacji Wix i menu w dokumentach |
| **Panel zleceń Toto** | **Użytkownicy organizacji Workspace centrumtoto.pl** | Panel ręcznego dodawania i zatwierdzania zleceń w przeglądarce |

Dla gotowej konfiguracji testowej ustaw `SETTINGS.enabled: true` i zapisz kod.
Następnie dla każdego wdrożenia wybierz **Wdróż → Nowe wdrożenie → Aplikacja internetowa**,
ustaw nazwę, konto wykonujące oraz dostęp zgodnie z tabelą i kliknij **Wdróż**.
Jeżeli oba wdrożenia już istnieją, nie twórz kolejnych — sprawdź je w
**Wdróż → Zarządzaj wdrożeniami**. Oba mają pozostać w sekcji **Aktywne**.

Skopiuj i zapisz osobno oba URL-e zakończone `/exec`. Korzystaj z adresów skopiowanych
z okna wdrożenia, bez ręcznej zmiany ścieżki.

| Gdzie użyć adresu | Które wdrożenie |
|---|---|
| Wix Secrets Manager → `TOTO_DOCS_WEBAPP_URL` | **Brama Wix i menu** |
| `Menu.gs` w każdym szablonie → `TOTO_WEBAPP_URL` | **Brama Wix i menu** |
| Zakładka w przeglądarce do obsługi ręcznych zleceń | **Panel zleceń Toto** |

Brama weryfikuje podpis HMAC żądań Wix oraz indywidualny klucz zatwierdzenia
każdego dokumentu. **W `Menu.gs` wpisujesz tylko URL bramy — żadnych kluczy.**
Menu samo odczytuje klucz z opisu dokumentu utworzonego przez centralny skrypt.
Panel wymaga rozpoznanej tożsamości Workspace i obecności konta w `adminEmails`.
Centralny projekt Apps Script pozostaje prywatny.

Jeśli administrator Workspace nie zezwala na dostęp „Każdy”, uzgodnij dopuszczenie
bramy z administratorem. Nie zmieniaj dostępu bramy na organizację, ponieważ jej
wywołania z Wix i menu nie korzystają z sesji przeglądarkowej użytkownika.

### Aktualizacja kodu i adresów

Po edycji kodu centralnego zapisz projekt, a następnie **zaktualizuj oba aktywne wdrożenia**:

1. Wybierz **Wdróż → Zarządzaj wdrożeniami**.
2. Wybierz **Brama Wix i menu**, kliknij **Edytuj**, wybierz **Nowa wersja** i kliknij **Wdróż**.
3. Powtórz te czynności dla **Panel zleceń Toto**.
4. Zachowaj konto wykonujące i ustawienia dostępu każdego wdrożenia zgodnie z tabelą.

Aktualizacja istniejącego wdrożenia zachowuje jego URL. Samo Ctrl+S zapisuje kod,
ale nie aktualizuje opublikowanych wersji. Wyzwalacze czasowe i ręczne uruchomienia
korzystają z zapisanego kodu projektu.

Nie archiwizuj wdrożenia, którego adres jest używany przez Wix, menu albo zakładkę panelu.
Jeśli zastępujesz archiwalną bramę nową, jej nowy URL wpisz do sekretu Wix oraz
`TOTO_WEBAPP_URL` w każdym szablonie. Zapisz skrypty szablonów. Dokumenty robocze,
które powstały wcześniej, mają własne kopie skryptu menu: w nich również popraw URL
albo zatwierdzaj je przez aktywny panel. Zmiana skryptu szablonu nie aktualizuje
skryptów w istniejących dokumentach.

## 4. Menu w szablonach Google Docs

Wykonaj poniższe czynności osobno dla każdego szablonu: ADOS-2, SI oraz
„Diagnoza / Informacja z przebiegu terapii”:

1. Otwórz szablon jako właściciel lub edytor.
2. Wybierz **Rozszerzenia → Apps Script**. Jest to projekt powiązany z tym dokumentem.
3. Zastąp zawartość domyślnego pliku kodem `google/template/Menu.gs`.
4. W `TOTO_WEBAPP_URL` wpisz URL `/exec` wdrożenia **Brama Wix i menu** (dostęp **Każdy**).
5. W ustawieniach tego projektu włącz widoczność manifestu. W edytorze otwórz
   `appsscript.json` i wklej `google/template/appsscript.json`. Zapisz projekt.
6. Wróć do dokumentu i odśwież stronę. Pojawi się **Dokumentacja Toto → Zatwierdź i wyślij**.

Skrypt menu jest kopiowany wraz z szablonem. Nie wdrażaj go jako aplikacji internetowej.
`onOpen` uruchamia się przy otwieraniu dokumentu; nie trzeba ręcznie wywoływać go
w edytorze Apps Script. Sam szablon nie ma rekordu rezerwacji i nie służy do wysyłania.

Pracownik uruchamia funkcję przez menu w wygenerowanym dokumencie. Przy pierwszym
użyciu zatwierdza uprawnienia Google. W oknie potwierdzenia sprawdza imię i nazwisko klienta
oraz adres klienta i wybiera **Tak**, aby zlecić wysyłkę, albo **Nie**, aby anulować.
Jeśli w rezerwacji brakuje daty dziecka, menu poprosi o wpisanie `DD.MM.RRRR`.

Nie zmieniaj opisu wygenerowanego pliku: zawiera indywidualny klucz zatwierdzania.
Nie udostępniaj roboczego Google Docs klientowi. Klient dostaje link wyłącznie do PDF.

## 5. Jedna automatyzacja Wix

1. W panelu Wix otwórz **Automatyzacje**, utwórz automatyzację i wybierz zdarzenie
   potwierdzenia rezerwacji w Wix Bookings.
2. Ustaw usługi **Diagnoza SI + pisemna opinia** oraz **Test ADOS-2**.
   Kod także sprawdza ID usługi i status `CONFIRMED`.
3. Dodaj jedną akcję **Uruchom kod Velo** i otwórz edytor kodu tej akcji.
4. Wklej cały `wix/DO-WKLEJENIA.js`. Zachowaj komentarze typów wygenerowane przez Wix
   nad `invoke`. Nie dodawaj drugiego `invoke`, jeśli pozostaje w kodzie domyślnym.
5. W **Payload View** sprawdź pole z ID rezerwacji. W konfiguracji skryptu
   `bookingIdPath` wynosi `booking_id`; dostosuj tę ścieżkę, jeśli payload ma inne pole.
6. Upewnij się, że dostępne są pakiety `@wix/bookings`, `@wix/forms`, `@wix/secrets`
   i `@wix/essentials`. W razie braku dodaj je w obsłudze pakietów edytora Velo.
7. W **Secrets Manager** witryny dodaj dwa sekrety:

   | Nazwa | Wartość |
   |---|---|
   | `TOTO_DOCS_WEBAPP_URL` | URL `/exec` wdrożenia **Brama Wix i menu**, z dostępem **Każdy** |
   | `TOTO_DOCS_HMAC_SECRET` | Ta sama wartość co `HMAC_SECRET` w centralnym projekcie Google |

8. Jeśli rezerwacja nie zawiera adresu pracownika w `slot.resource.email`, wpisz
   właściwy adres w mapie `staffEmails`, pod ID zasobu tego pracownika.
9. Dla gotowej konfiguracji testowej ustaw `CONFIG.enabled: true`, zapisz akcję
   i opublikuj kod witryny. Aktywuj automatyzację dopiero, gdy jesteś gotowy do próby.

Skrypt pobiera zgłoszenie formularza przez `booking.formSubmissionId`.
Dane dziecka pochodzą z pól `data_urodzenia_dziecka` oraz
`s_b7a3e662_4597_4103_bab8_b3416e6fc300`; e-mail odbiorcy z kontaktu rezerwacji.

## 6. Próba całego procesu

Przygotuj konfigurację testową z osobnymi kopiami szablonów i folderami oraz
sztuczną rezerwacją. E-mail klienta ma wskazywać skrzynkę pod Twoją kontrolą.
Test wykonuje realne udostępnienia i wysyła wiadomości, również do pracownika i Sabiny.

1. Potwierdź testową rezerwację właściwej usługi. Sprawdź dokument w Robocze,
   imię i nazwisko klienta, właściwy szablon i powiadomienia o dostępie do edycji.
2. Powtórzenie tej samej akcji dla tej samej rezerwacji ma wskazać ten sam dokument.
3. W wygenerowanym dokumencie wybierz **Dokumentacja Toto → Zatwierdź i wyślij**,
   następnie **Nie**. Nie powinien powstać PDF ani mail.
4. Powtórz wybór menu i potwierdź **Tak**. Oczekiwany status to `QUEUED`.
5. Poczekaj na wyzwalacz albo w centralnym projekcie wybierz z listy funkcję
   **processQueue** i kliknij **Uruchom**. Funkcja obsłuży wszystkie oczekujące
   dokumenty w tym projekcie, nie tylko dokument aktualnie otwarty w przeglądarce.
6. Sprawdź PDF w Udostępnione, poprawne hasło `DDMMRRRR`, nadawcę kontakt,
   odbiorcę i działanie linku w przeglądarce bez zalogowania do Google.
7. Sprawdź przeniesienie źródłowego Google Docs do Archiwum i brak drugiej wysyłki
   po ponownym użyciu menu.

Aby przetestować kosz bez czekania siedmiu dni:

1. Wyłącznie w konfiguracji testowej ustaw `SETTINGS.linkDays: 1/1440`, zapisz
   kod i opublikuj nową wersję obu aktywnych wdrożeń.
2. Utwórz i zatwierdź kolejny dokument testowy. Po wysłaniu poczekaj co najmniej minutę.
3. W centralnym projekcie wybierz **expireLinks** na liście funkcji i kliknij **Uruchom**.
   Funkcja przenosi do kosza wszystkie PDF-y, których zapisany termin minął.
4. Sprawdź kosz i folder Udostępnione. Źródłowy Google Docs ma pozostać w Archiwum.
5. Ustaw `linkDays: 7`, zapisz i opublikuj nową wersję obu aktywnych wdrożeń. Zmiana ustawienia nie zmienia
   terminu PDF-ów, które mają już zapisane `expiresAt`.

Po udanej próbie ustaw foldery i szablony produkcyjne, uruchom z listy **validateSetup**,
zapisz i zaktualizuj oba aktywne wdrożenia centralne oraz kod Wix. Automatyzacja może
wtedy obsługiwać rezerwacje klientów.

## 7. Bieżąca obsługa i awarie

Kolejka pracuje co pięć minut. Kosz sprawdzany jest co godzinę, dlatego PDF trafia
do kosza około siedmiu dni od udostępnienia. Przywrócenie pliku z kosza może
przywrócić także działanie jego linku. Przeniesienie Google Docs do Archiwum
zachowuje przyznane pracownikom uprawnienia.

### Jak sprawdzić stan dokumentów

1. Otwórz centralny projekt na koncie kontakt.
2. W edytorze wybierz **reviewQueue** na górnej liście funkcji i kliknij **Uruchom**.
3. Otwórz **Dziennik wykonania**. Zapis JSON zawiera `recordId`, status, liczbę
   błędów i informację o problemach z koszem, bez danych pacjenta i klucza zatwierdzania.
4. Aby znaleźć dziennik na Dysku, użyj adresu `https://drive.google.com/file/d/RECORD_ID/view`,
   zastępując `RECORD_ID` wartością z wyniku. Jest to prywatny plik JSON w folderze technicznym.
5. Historię automatycznych przebiegów i ich błędy sprawdzaj w **Wykonania / Executions**.

| Status | Znaczenie |
|---|---|
| `CREATING` | Tworzenie dokumentu lub udostępnianie; po usunięciu przyczyny ponów tę samą akcję Wix |
| `DRAFT` | Dokument czeka na opracowanie i zatwierdzenie |
| `QUEUED`, `PREPARING`, `READY` | Kolejka, przygotowanie PDF, gotowość do wysyłki |
| `SENDING` | Rozpoczęto wysyłkę; po przerwaniu następny przebieg nada `SEND_REVIEW` |
| `SEND_REVIEW` | Wymagana kontrola, czy mail został wysłany |
| `PROCESS_REVIEW` | Przygotowanie nie powiodło się trzykrotnie |
| `SENT` | Usługa pocztowa przyjęła mail, pozostała archiwizacja |
| `DONE` | Wysyłka i archiwizacja zakończone |
| `EXPIRED` | PDF przeniesiony do kosza |

### Jak wznowić proces wymagający kontroli

1. Najpierw ustal przyczynę awarii. Przy `SEND_REVIEW` sprawdź pocztę wysłaną
   konta kontakt: odbiorcę i link do konkretnego PDF. Nie ponawiaj przy niepewnym wyniku.
2. W centralnym projekcie otwórz **Ustawienia projektu → Właściwości skryptu**.
3. Dodaj `REVIEW_RECORD_ID` z identyfikatorem dziennika zwróconym przez `reviewQueue`.
   Nie wpisuj tutaj ID dokumentu roboczego ani rezerwacji.
4. Dodaj `REVIEW_DECISION`, wybierając dokładnie jedną z wartości:

   | Wartość | Kiedy użyć |
   |---|---|
   | `MAIL_CONFIRMED_SENT` | Potwierdzono wysyłkę; wykonana zostanie archiwizacja bez kolejnego maila |
   | `MAIL_CONFIRMED_NOT_SENT` | Potwierdzono brak wysyłki, a termin linku jeszcze nie minął |
   | `RESUME_PROCESSING` | Usunięto przyczynę stanu `PROCESS_REVIEW` |

5. Zapisz właściwości. Wróć do edytora, wybierz **resolveReview** i kliknij **Uruchom**.
6. Jeśli wykonanie zakończy się bez błędu, wybierz **processQueue** i kliknij **Uruchom**.
7. Na końcu wybierz **reviewQueue**, kliknij **Uruchom** i sprawdź nowy status w dzienniku.

`resolveReview` usuwa obie właściwości kontrolne po skutecznym zapisaniu decyzji.
Nie edytuj ręcznie statusu w pliku JSON. Sukces wysyłki oznacza przyjęcie wiadomości
przez usługę pocztową, a nie potwierdzenie dostarczenia do skrzynki klienta.

## 8. Ręczne dodawanie zleceń w Apps Script

Panel działa w centralnym projekcie i korzysta z tego samego procesu wysyłki.
Nie wymaga dodawania akcji ani skryptów w Wix.

### Dostęp i otwarcie panelu

1. W `SETTINGS.adminEmails` wpisz adresy osób uprawnionych do dodawania i zatwierdzania
   zleceń. Domyślnie są to kontakt oraz Sabina. Lista pracowników nie nadaje dostępu do panelu.
2. Zapisz kod i zaktualizuj wdrożenie **Panel zleceń Toto** zgodnie z punktem 3:
   wykonywanie jako kontakt, dostęp ograniczony do organizacji Workspace.
3. Otwórz URL `/exec` wdrożenia **Panel zleceń Toto**, będąc zalogowanym
   uprawnionym kontem. Nie używaj do panelu adresu bramy. Nie dopisuj sekretów do URL.
4. Jeżeli widzisz „Brak dostępu”, sprawdź konto i `adminEmails`. Google musi udostępnić
   adres aktywnego użytkownika. Przy pustej tożsamości panel blokuje dostęp; nie zastępuj
   tego sprawdzenia adresem właściciela. Konto właściciela i użytkownik z tej samej domeny
   wymagają sprawdzenia w rzeczywistym wdrożeniu Workspace.

### Utworzenie zlecenia

1. Wpisz imię i nazwisko klienta, datę urodzenia dziecka i adres e-mail klienta.
2. Wybierz pracownika i szablon/typ dokumentacji.
3. Aby utworzyć dokument z szablonu, pozostaw pole linku puste.
4. Aby wykorzystać istniejący dokument, wklej jego pełny link Google Docs.
   Dokument musi należeć do kontakt@centrumtoto.pl. Powstanie jego robocza kopia,
   a oryginał nie będzie zmieniany. Wybór typu dokumentacji nadal jest wymagany.
5. Kliknij **Dodaj do procesu**. Panel pokaże status, ID dziennika zlecenia i link
   **Otwórz dokument roboczy**. Dokument trafi do Robocze i otrzyma uprawnienia pracownika oraz Sabiny.
6. Otwórz i opracuj dokument. Zachowaj ID zlecenia pokazane w panelu.
7. W polu **ID dziennika zlecenia** wpisz lub pozostaw właściwy identyfikator.
8. Kliknij **Sprawdź i zatwierdź wysyłkę**. Sprawdź klienta i adres odbiorcy w oknie
   potwierdzenia. Wybierz potwierdzenie, aby utrwalić dokument i ustawić `QUEUED`.

Zatwierdzanie z panelu działa także dla kopii dokumentu bez skryptu menu.
Po zatwierdzeniu dokument jest obsługiwany przez kolejkę co pięć minut:
PDF AES-256, mail z konta kontakt, archiwizacja źródła i kosz po siedmiu dniach.
Ponowienie tego samego żądania podczas dodawania nie tworzy drugiego zlecenia;
po udanym dodaniu następne kliknięcie „Dodaj do procesu” oznacza nowe zlecenie.
Po odświeżeniu strony wklej zachowane ID, aby sprawdzić/zatwierdzić istniejące zlecenie.

## 9. Lista pracowników z Google Workspace

Możesz wybrać jeden z dwóch sposobów:

- **Lista w konfiguracji:** pozostaw `SETTINGS.staffDirectory.enabled: false`
  i uzupełnij `staffDirectory.manual` wpisami `{ email: 'adres@centrumtoto.pl', name: 'Imię Nazwisko' }`.
- **Katalog Workspace:** włącz poniższą integrację, a potem ustaw `enabled: true`
  wewnątrz `staffDirectory`. Nie jest to to samo ustawienie co główne `SETTINGS.enabled`.

Katalog jest odczytywany na uprawnieniach konta kontakt, nie osoby otwierającej panel.
Konto kontakt potrzebuje uprawnień administratora/delegowanego administratora do
odczytu użytkowników przez Admin SDK Directory API. Zwykłe konto pocztowe może ich
nie mieć. Administrator powinien nadać wymagany odczyt, bez uprawnień do zmiany użytkowników.

Konfiguracja katalogu:

1. W centralnym projekcie Apps Script, w **Usługi → +**, dodaj **Admin SDK API**,
   identyfikator **AdminDirectory**, wersja **directory_v1**.
2. W manifeście `appsscript.json` dodaj do tablicy `oauthScopes` ciąg:
   `https://www.googleapis.com/auth/admin.directory.user.readonly`.
   Dodaj przecinek między elementami JSON. Zachowaj wpisy bibliotek i pozostałych usług.
3. Jeśli używasz własnego standardowego projektu Google Cloud, włącz w nim również Admin SDK API.
4. Ustaw `SETTINGS.staffDirectory.domain: 'centrumtoto.pl'` oraz `enabled: true` w `staffDirectory`.
5. Zapisz kod. W edytorze wybierz **adminBootstrap** na liście funkcji i kliknij **Uruchom**.
   W razie monitu zatwierdź dodatkowy dostęp na koncie kontakt. Brak błędu oznacza,
   że odczyt listy i szablonów się powiódł; wynik funkcji nie jest wypisywany w dzienniku.
6. Zaktualizuj wdrożenia aplikacji, otwórz panel i sprawdź listę pracowników.
   Jeżeli otrzymasz błąd uprawnień Directory, sprawdź rolę konta kontakt z administratorem.
   Kod nie przełącza się potajemnie na listę ręczną przy błędzie katalogu.

Lista obejmuje aktywne konta wskazanej domeny, bez zawieszonych i zarchiwizowanych.
Jest pobierana stronicami i przechowywana w pamięci podręcznej przez pięć minut.
Katalog nie określa, kto jest terapeutą ani jakie usługi obsługuje w Wix; konta
techniczne również mogą pojawić się na liście. Integracja nie zmienia przypisań
pracowników w automatycznych rezerwacjach Wix.

## Źródła

- [Apps Script: wdrażanie aplikacji internetowych](https://developers.google.com/apps-script/guides/web)
- [Apps Script: dziennik i historia wykonań](https://developers.google.com/apps-script/guides/logging)
- [Apps Script: właściwości skryptu](https://developers.google.com/apps-script/guides/properties)
- [Google Docs: menu](https://developers.google.com/apps-script/guides/menus)
- [ZgaPdfToolkit / ZgaPdfSigner](https://github.com/zboris12/zgapdfsigner)

- [Admin Directory: lista użytkowników](https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/list)
- [Apps Script: tożsamość aktywnego użytkownika](https://developers.google.com/apps-script/reference/base/session)
