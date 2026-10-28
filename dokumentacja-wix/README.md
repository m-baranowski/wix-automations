# Dokumentacja po rezerwacji — Centrum Toto

Wariant uproszczony: **jeden plik Wix + Google Apps Script, bez Cloud Run**.

Kod do ręcznego wdrożenia. Nie wymaga łączenia edytora Wix z GitHub.
Nie został opublikowany w Wix, Google Apps Script. Domyślnie jest wyłączony.

## Jak działa

1. Potwierdzona rezerwacja właściwej usługi uruchamia akcję „Uruchom kod Velo”.
2. Backend pobiera rezerwację oraz powiązane zgłoszenie formularza. Odczytuje
   dane dziecka, adres klienta i przypisanego pracownika.
3. Google Apps Script na koncie **kontakt@centrumtoto.pl** kopiuje odpowiedni
   szablon Google Docs do **Robocze**. Nazwa to **imię i nazwisko klienta + nazwa szablonu**.
4. Pracownik z rezerwacji i **sabina.baranowska@centrumtoto.pl** otrzymują
   uprawnienie edycji i powiadomienie Google Drive.
5. W dokumencie wybierają **Dokumentacja Toto → Zatwierdź i wyślij**.
   Okno wymaga potwierdzenia odbiorcy i wysyłki. Anulowanie niczego nie wysyła.
6. Zatwierdzenie utrwala prywatną kopię wersji dokumentu. Kolejka właściciela
   eksportuje tę wersję, szyfruje PDF hasłem `DDMMRRRR` i zapisuje w **Udostępnione**.
7. PDF otrzymuje dostęp „każda osoba mająca link”. Mail wychodzi z konta
   **kontakt@centrumtoto.pl**, z linkiem do pliku — bez załącznika i bez rzeczywistej daty w treści.
8. Po wysłaniu dokument roboczy trafia do **Archiwum**.
9. Po siedmiu dniach od udostępnienia **PDF trafia do kosza**. Wyzwalacz działa
   co godzinę, więc termin jest przybliżony. Nie usuwamy go bezpowrotnie;
   przywrócenie PDF z kosza może przywrócić również działanie linku.

Menu jest częścią skryptu powiązanego z każdym szablonem, więc jest kopiowane
razem z dokumentem. Nie jest to globalny dodatek do wszystkich Google Docs.

## Pliki

| Katalog | Przeznaczenie |
|---|---|
| `wix/DO-WKLEJENIA.js` | Jedyny plik do wklejenia w automatyzacji Wix |
| `google/owner/Code.gs` | Cały centralny Apps Script: konfiguracja, dokumenty, szyfrowanie, wysyłka, kolejka i administracja |
| `google/template/` | Menu do wklejenia do skryptu każdego szablonu |
| `tests/` | Testy danych wejściowych, podpisów i etapów procesu |
| `WDROZENIE.md` | Instrukcja konfiguracji krok po kroku |
| `USTALENIA-WIX.md` | Potwierdzone identyfikatory i źródła danych |

## Stan konfiguracji

Szablon **Diagnoza / Informacja z przebiegu terapii** jest dostępny w panelu
ręcznych zleceń. Nie uruchamia go rezerwacja w Wix.

Wpisane: trzy foldery, trzy szablony, konto nadawcy, szefowa zespołu, rzeczywiste ID obu usług,
pole daty urodzenia i pole imienia/nazwiska dziecka. Nie zapisano danych pacjentów.

Do uzupełnienia przed wdrożeniem:

- ID dodatkowego prywatnego folderu technicznego na koncie kontakt.
- Dwa adresy aktywnych wdrożeń Apps Script: brama (Każdy) i panel (Workspace), sekret HMAC oraz biblioteka ZgaPdfToolkit z identyfikatorem pdfkit.
- Ewentualna mapa `staffEmails`, jeśli rezerwacja nie zawiera adresu przypisanego pracownika.

Przy braku daty w historycznej rezerwacji menu pozwala wpisać datę dziecka.
Brak poprawnej daty blokuje zatwierdzenie. Jeśli brak również danych klienta,
utworzenie dokumentu wymaga poprawnego imienia i nazwiska klienta z rezerwacji.

## Ważne zachowania

- Powtórzenie tej samej rezerwacji i szablonu nie powinno tworzyć drugiej dokumentacji.
  Zmiana odbiorcy/danych pod tym samym kluczem powoduje stan wymagający kontroli.
- Wysyłka następuje zwykle w ciągu pięciu minut od zatwierdzenia.
- Uprawnienia edycji dotyczą roboczego Google Docs. Klient otrzymuje wyłącznie link do PDF.
- Przeniesienie Google Docs do Archiwum zachowuje wcześniej nadane pracownikom uprawnienia.
- Klucz do zatwierdzenia jest losowy i osobny dla dokumentu, zapisany w jego opisie.
  Jest uprawnieniem do uruchomienia wysyłki TEGO dokumentu. Nie udostępniaj opisu
  dokumentu ani roboczego dokumentu klientowi. Globalny sekret Wix nie trafia do szablonów.
- HMAC chroni żądania Wix → Google. Obsługiwane jest pięć minut tolerancji czasu.
- Szyfrowanie wykonuje biblioteka ZgaPdfToolkit w procesie Apps Script. Nie jest potrzebny osobny serwer szyfrujący.
- Kolejka zapisuje etap przed wysyłką. Jeżeli wynik wysyłki jest niejednoznaczny,
  pojawia się `SEND_REVIEW`; automatyczne ponowienie jest blokowane, aby nie
  wysłać dokumentu drugi raz. Patrz instrukcja obsługi awarii.
- Foldery muszą być prywatne i należeć do kontakt@centrumtoto.pl.
  Współdzielone dyski i foldery z odziedziczonym szerokim dostępem nie są obsługiwane.
- Jest to mały proces oparty o limity Apps Script i Gmail. Awaria wyzwalacza,
  brak uprawnień lub wyczerpanie limitów mogą opóźnić wysyłkę i kosz.
  Kontroluj `reviewQueue()` i historię wykonań. Nie jest to gwarantowany termin SLA.

## Testy lokalne

Z katalogu `dokumentacja-wix`:

```powershell
node --test tests/core.test.js tests/workflow.test.js tests/menu.test.js
```

Testy JavaScript używają atrap Google i nie wykonują operacji na koncie.
Testują bezpośrednio plik `wix/DO-WKLEJENIA.js`, bez generatora i duplikatów kodu.
Szyfrowanie w Apps Script sprawdź również przez `testEncryption()`.
Pełny test Wix → Google Docs → mail wymaga wdrożenia i kontrolnej rezerwacji.

## Wynik sprawdzenia wersji uproszczonej

24 testy procesu, panelu, menu i HTML przechodzą. Adapter szyfrowania w `google/owner/Code.gs` przetestowano lokalnie
z prawdziwą biblioteką `zgapdfsigner@2.8.0`: wynik ma AES-256, niezależny pypdf
odrzuca złe hasło, otwiera poprawne hasło i odczytuje stronę. Nie jest to jeszcze
próba w środowisku Google Apps Script z biblioteką ZgaPdfToolkit — tę wykonuje
`testEncryption()` po dodaniu biblioteki do projektu Google.

Do Wix wklejasz tylko `wix/DO-WKLEJENIA.js`.

Do wdrożenia są trzy pliki kodu: `wix/DO-WKLEJENIA.js`, `google/owner/Code.gs` i `google/template/Menu.gs`. Menu jest w oddzielnym projekcie powiązanym z szablonem; manifesty `appsscript.json` są wymaganymi osobnymi plikami konfiguracyjnymi Google.

## Ręczne zlecenia

Centralny Apps Script udostępnia panel `/exec` z dodawaniem zleceń z szablonu
lub kopii istniejącego Google Docs i zatwierdzaniem wysyłki po potwierdzeniu.
Dostęp określa `adminEmails`. Pracowników można wpisać w konfiguracji lub pobierać
z katalogu Workspace przez Admin Directory API po nadaniu uprawnień odczytu
kontu kontakt. Instrukcja konfiguracji jest w punktach 8–9 `WDROZENIE.md`.

## Adresy dwóch aktywnych wdrożeń

| Wdrożenie | Wykonywanie | Dostęp | Gdzie użyć URL |
|---|---|---|---|
| Brama Wix i menu | kontakt@centrumtoto.pl | Każdy | Sekret Wix `TOTO_DOCS_WEBAPP_URL` oraz `TOTO_WEBAPP_URL` w menu obu szablonów |
| Panel zleceń Toto | kontakt@centrumtoto.pl | Organizacja Workspace | Przeglądarka — ręczna obsługa zleceń |

W `Menu.gs` nie wpisujesz kluczy. Menu odczytuje klucz konkretnego dokumentu
z jego opisu. Po zmianach centralnego kodu aktualizujesz oba aktywne wdrożenia.
Szczegóły konfiguracji, aktualizacji i zastąpienia archiwalnego adresu opisuje punkt 3 instrukcji wdrożenia.

## Wiadomość HTML

Szablon wiadomości znajduje się w funkcji `documentationEmailHtml_` w `Code.gs`.
Podgląd wizualny: `podglad-maila.html` (przycisk ma przykładowy adres).
Wysyłka używa prawdziwego adresu PDF jako hiperłącza „Pobierz dokumentację”.
Pozostaje także wersja tekstowa dla poczty bez obsługi HTML.
Po podmianie `Code.gs` zaktualizuj oba aktywne wdrożenia.

### Wygląd zgodny z brandbookiem Toto

Paleta wiadomości: krem #F7EDDC, żółty #FFCA4C, oliwkowy #789862,
brąz #725733 i ciemny #291E02. Nagłówki: Wix Madefor Display; treść: Montserrat,
z zastępczymi Arial/Helvetica w klientach pocztowych bez fontów marki.
Oryginalne logo z dostarczonego brandbooka jest osadzone w `Code.gs` i wysyłane
jako obraz CID. Nie trzeba udostępniać publicznie pliku logo ani wklejać osobnego
klucza lub adresu do obrazka. `assets/toto-logo.png` jest lokalnym plikiem źródłowym.
Podgląd HTML zawiera ten sam obraz osadzony lokalnie i przykładowy link przycisku.
