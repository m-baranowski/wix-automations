/**
 * WSPÓŁDZIELONY MODUŁ — Bramka SMS (uslugidlafirm.play.pl)
 *
 * Umieść ten plik w Edytorze kodu strony, w folderze backend/, jako
 * backend/smsService.js — zwykły plik backendowy (NIE .jsw/.web.js,
 * bo ta funkcja jest wywoływana wyłącznie z innego kodu backendowego —
 * automatyzacji "Run Velo Code" — nigdy z frontendu, więc web module
 * jest tu niepotrzebny).
 *
 * Użycie w akcji "Run Velo Code":
 *   import { wyslijSms } from 'backend/smsService';
 *   export const invoke = async ({ payload }) => {
 *     await wyslijSms('48600123456', 'Nowa faktura za wrzesień, sprawdź maila.');
 *     return {};
 *   };
 *
 * PRZED PIERWSZYM UŻYCIEM — jednorazowa konfiguracja:
 * 1. W Sekretach strony dodaj: "bramkaSmsClientId" i "bramkaSmsClientSecret".
 * 2. Podmień NADAWCA_NUMER / NADAWCA_NAZWA poniżej na zatwierdzone wartości
 *    z Bramki SMS.
 * 3. Przy PIERWSZYM teście odkomentuj linię z "DEBUG" niżej, żeby zobaczyć
 *    prawdziwe nazwy pól w odpowiedzi tokena — potem z powrotem zakomentuj
 *    (żeby nie logować niczego wrażliwego bez potrzeby).
 *
 * NIEPRZETESTOWANE na żywo — oparte na dostarczonej dokumentacji PDF.
 * Pierwsze uruchomienie zweryfikuje szczegóły (nazwa pola tokena, kształt
 * odpowiedzi sendSms).
 */

import { fetch } from 'wix-fetch';
import { secrets } from 'wix-secrets-backend.v2';
import { elevate } from 'wix-auth';

const TOKEN_URL = 'https://uslugidlafirm.play.pl/oauth/token-jwt';
const SEND_SMS_URL = 'https://uslugidlafirm.play.pl/api/bramkasms/sendSms';

const NADAWCA_NUMER = '48662323663';
// Zostaw puste (''), dopóki nie masz zatwierdzonego nadpisu w panelu Play
// (Bramka SMS → sekcja z nadpisami nadawcy) — błąd "Sender name is not
// available" oznacza, że podana wartość nie jest zarejestrowana/zaakceptowana.
// Bez nadpisu SMS przyjdzie po prostu z samego numeru.
const NADAWCA_NAZWA = '';

const getSecretValue = elevate(secrets.getSecretValue);

async function pobierzToken() {
  // Celowo bez cache na start — generujemy świeży token przed każdą
  // wysyłką. Prostsze i bezpieczniejsze do testowania; dokumentacja
  // pozwala skonfigurować czas życia tokena od 30 do 7200s w panelu,
  // więc sztywne założenie czasu ważności byłoby kruche. Optymalizację
  // (cache) można dodać później, gdy wolumen SMS-ów to uzasadni.
  const clientIdResponse = await getSecretValue('bramkaSmsClientId');
  const clientSecretResponse = await getSecretValue('bramkaSmsClientSecret');

  // getSecretValue() zwraca obiekt (GetSecretValueResponse), nie goły
  // string — dokumentacja Wix nie ujawniła mi dokładnej nazwy pola przez
  // ukryty akordeon "Show Properties", więc zakładam najbardziej
  // prawdopodobne (.value), z zabezpieczeniem: jeśli się mylę, log niżej
  // pokaże Ci prawdziwe nazwy pól bez kolejnej rundy zgadywania.
  const clientId = clientIdResponse?.value;
  const clientSecret = clientSecretResponse?.value;

  if (!clientId) {
    console.log('UWAGA: clientIdResponse.value puste. Prawdziwe pola obiektu:', Object.keys(clientIdResponse || {}));
  }
  if (!clientSecret) {
    console.log('UWAGA: clientSecretResponse.value puste. Prawdziwe pola obiektu:', Object.keys(clientSecretResponse || {}));
  }

  // Bezpieczna diagnostyka — długość, NIGDY treść sekretu. Dokumentacja
  // Play mówi: Client ID = 16 znaków, Client Secret = 64 znaki. Jeśli te
  // liczby się nie zgadzają, problem jest w Secrets Manager (literówka,
  // spacja, nieaktualna wartość), nie w samym zapytaniu do API.
  // Ostrzeżenie tylko wtedy, gdy coś jest nie tak z sekretami.
  if (clientId?.length !== 16 || clientSecret?.length !== 64) {
    console.warn(
      `SMS_SEKRETY: nieoczekiwana długość (ID ${clientId?.length ?? 'BRAK'}, ` +
      `Secret ${clientSecret?.length ?? 'BRAK'})`
    );
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Nie udało się pobrać tokena JWT (status ${response.status}): ${errorBody}`);
  }

  const data = await response.json();

  // DEBUG (odkomentuj tylko na czas pierwszego testu):
  // console.log('Pola w odpowiedzi tokena:', Object.keys(data));

  const token = data.token || data.access_token;
  if (!token) {
    throw new Error(`Odpowiedź tokena nie zawiera oczekiwanego pola. Dostępne pola: ${Object.keys(data).join(', ')}`);
  }
  return token;
}

/**
 * Wysyła pojedynczą wiadomość SMS do jednego lub kilku odbiorców (max 10).
 * @param {string|string[]} numeryOdbiorcow - pojedynczy numer albo lista (max 10)
 * @param {string} tresc - treść wiadomości
 */
function normalizujNumer(numer) {
  let n = String(numer).replace(/\s+/g, '').replace(/^\+/, '');
  if (/^\d{9}$/.test(n)) {
    // Goły polski numer bez kierunkowego (np. z Wix Contacts) — dodaj "48".
    n = `48${n}`;
  }
  return n;
}

export async function wyslijSms(numeryOdbiorcow, tresc) {
  // Normalizacja formatu numeru — przydatne już teraz, a konieczne, gdy
  // numer zacznie pochodzić automatycznie z Wix Contacts (tam bywa zapisany
  // jako "+48 600 123 456", "+48600123456", "48600123456" albo goły
  // "600123456"). Bramka SMS (wg przykładów w dokumentacji) oczekuje
  // formatu bez spacji i "+", np. "48600123456" — wszystkie cztery warianty
  // wyżej sprowadzają się do tej samej postaci.
  const to = (Array.isArray(numeryOdbiorcow) ? numeryOdbiorcow : [numeryOdbiorcow]).map(normalizujNumer);
  if (to.length === 0 || to.length > 10) {
    throw new Error('Bramka SMS pozwala na 1–10 odbiorców w jednej wysyłce.');
  }

  const token = await pobierzToken();

  const body = { from: NADAWCA_NUMER, text: tresc, to };
  if (NADAWCA_NAZWA) {
    body.fromName = NADAWCA_NAZWA;
  }

  const response = await fetch(SEND_SMS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // Dokumentacja nie precyzuje kształtu odpowiedzi sendSms (tylko że
  // wiadomość "zostanie przekazana do wysyłki") — możliwe, że treść jest
  // pusta mimo statusu 200. Nie zakładamy JSON-a na sztywno.
  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(`Wysyłka SMS nie powiodła się (status ${response.status}): ${bodyText}`);
  }

  return { success: true, status: response.status, body: bodyText };
}
