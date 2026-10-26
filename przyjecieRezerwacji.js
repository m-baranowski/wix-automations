// backend/przyjecieRezerwacji.js
// Wersja 4 — odbiornik zgłoszeń do ręcznej obsługi.
//
// Pusta lista pracownicyIds = reguła podstawowa dla usługi.
// Niepusta lista = wyjątek dla wskazanych pracowników.
//
// Nie tworzy umów, wizyt, zamówień ani faktur.
// Nie pobiera danych dziecka.
// Nie nadpisuje istniejących procesów.

import wixData from 'wix-data';
import { extendedBookings } from '@wix/bookings';
import { auth } from '@wix/essentials';
import { createHash } from 'crypto';

const PROCESSES = 'ProcesyRezerwacji';
const RULES = 'RegulyRezerwacji';

const READ = {
  suppressAuth: true,
  suppressHooks: true,
  consistentRead: true
};

const WRITE = {
  suppressAuth: true,
  suppressHooks: true
};

const queryBookings = auth.elevate(
  extendedBookings.queryExtendedBookings
);

const idOf = value => value?._id || value?.id;

const copy = value =>
  JSON.parse(JSON.stringify(value));

const text = value =>
  typeof value === 'string' ? value.trim() : '';

function selectRule(rules, staffId) {
  if (!staffId) {
    return {
      error: 'Brak identyfikatora pracownika.'
    };
  }

  if (rules.some(rule => !Array.isArray(rule.pracownicyIds))) {
    return {
      error:
        'Pole pracownicyIds musi być tablicą; ' +
        'pusta oznacza regułę podstawową.'
    };
  }

  const defaults = rules.filter(
    rule => rule.pracownicyIds.length === 0
  );

  const exceptions = rules.filter(
    rule => rule.pracownicyIds.includes(staffId)
  );

  if (defaults.length !== 1) {
    return {
      error:
        `Liczba reguł podstawowych: ${defaults.length}; ` +
        'oczekiwano jednej.'
    };
  }

  if (exceptions.length > 1) {
    return {
      error:
        'Pracownik pasuje do kilku wyjątków — wymagana kontrola.'
    };
  }

  // Najpierw wyjątek, w przeciwnym razie reguła podstawowa.
  return {
    rule: exceptions[0] || defaults[0]
  };
}

function localStart(slot) {
  if (!text(slot.startDate).match(/(Z|[+-]\d{2}:\d{2})$/)) {
    throw new Error(
      'Termin nie zawiera przesunięcia strefy czasowej.'
    );
  }

  const zone = slot.timezone || 'Europe/Warsaw';

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(new Date(slot.startDate))
      .map(part => [part.type, part.value])
  );

  return {
    value:
      `${parts.year}-${parts.month}-${parts.day}` +
      `T${parts.hour}:${parts.minute}`,
    zone
  };
}

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter(key => value[key] != null)
        .map(key => [key, canonical(value[key])])
    );
  }

  return value;
}

function verified(saved, expected) {
  if (!saved) return false;

  const keys = [
    '_id',
    'rezerwacjaWejsciowaId',
    'status',
    'etap',
    'kodBledu',
    'wymagaKontroli',
    'wersjaSchematu',
    'regulaId',
    'wersjaReguly',
    'regulaSnapshot',
    'zamowienieWejscioweId',
    'kontaktId',
    'daneWejsciowe',
    'stan'
  ];

  const project = row =>
    canonical(
      Object.fromEntries(
        keys.map(key => [key, row[key]])
      )
    );

  return (
    JSON.stringify(project(saved)) ===
    JSON.stringify(project(expected))
  );
}

function processIdFor(bookingId) {
  // Prefiks pozostaje taki sam jak we wcześniejszych wersjach.
  const hash = createHash('sha256')
    .update(`toto/intake/v1/${bookingId}`)
    .digest('hex');

  return (
    `${hash.slice(0, 8)}-` +
    `${hash.slice(8, 12)}-` +
    `5${hash.slice(13, 16)}-` +
    `a${hash.slice(17, 20)}-` +
    `${hash.slice(20, 32)}`
  );
}

function result(row, duplicate) {
  return {
    status: row.status,
    processId: row._id,
    bookingId: row.rezerwacjaWejsciowaId,
    etap: row.etap,
    duplicate,
    wykonanoCyklWTymWywolaniu: false
  };
}

async function existing(bookingId) {
  const page = await wixData
    .query(PROCESSES)
    .eq('rezerwacjaWejsciowaId', bookingId)
    .limit(2)
    .find(READ);

  if (page.items.length > 1) {
    throw new Error(
      'Dwa procesy tej samej rezerwacji — wymagana kontrola.'
    );
  }

  return page.items[0];
}

export async function przyjmijRezerwacje(payload = {}) {
  const bookingId = String(payload?.booking_id || '')
    .trim()
    .toLowerCase();

  if (
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
      bookingId
    )
  ) {
    throw new Error('Brak poprawnego payload.booking_id.');
  }

  const response = await queryBookings(
    {
      filter: { id: bookingId },
      cursorPaging: { limit: 2 }
    },
    {
      withEcomOrder: true
    }
  );

  const found = response.extendedBookings || [];

  if (
    found.length !== 1 ||
    idOf(found[0].booking) !== bookingId
  ) {
    throw new Error(
      'Nie znaleziono jednoznacznie wskazanej rezerwacji.'
    );
  }

  const booking = found[0].booking;

  if (
    booking.status === 'CANCELED' ||
    booking.status === 'DECLINED'
  ) {
    return {
      status: 'POMINIETA',
      bookingId,
      powod: booking.status
    };
  }

  const slot = booking.bookedEntity?.slot;

  if (!slot?.serviceId) {
    throw new Error('Brak usługi w rezerwacji.');
  }

  // Odczytujemy także nieaktywne reguły:
  // obecny moduł wyłącznie rejestruje zgłoszenia.
  const page = await wixData
    .query(RULES)
    .eq('uslugaWejsciowaId', slot.serviceId)
    .limit(100)
    .find(READ);

  if (page.hasNext()) {
    throw new Error('Lista reguł nie jest kompletna.');
  }

  if (!page.items.length) {
    return {
      status: 'POMINIETA',
      bookingId,
      powod: 'USLUGA_POZA_REGULAMI'
    };
  }

  // Istniejącego procesu nie zmieniamy.
  // Dotyczy to również wpisów REVIEW oraz RECZNIE.
  const previous = await existing(bookingId);

  if (previous) {
    return result(previous, true);
  }

  const staffId = idOf(slot.resource);
  const selection = selectRule(page.items, staffId);
  const rule = selection.rule;

  const contactId = booking.contactDetails?.contactId;
  const order = found[0].order;

  let local = {
    value: '',
    zone: slot.timezone || 'Europe/Warsaw'
  };

  let dateError = '';

  try {
    local = localStart(slot);
  } catch (error) {
    dateError = String(error.message || error);
  }

  let code = 'WYKONAWCA_NIEWDROZONY';

  let reason =
    'Zapisano zgłoszenie. Ten moduł nie tworzy umów, ' +
    'wizyt, zamówień ani faktur.';

  if (!rule) {
    code = 'NIEJEDNOZNACZNA_REGULA';
    reason = selection.error;
  } else if (booking.status !== 'CONFIRMED') {
    code = 'STATUS_REZERWACJI';
    reason =
      `Status rezerwacji: ${booking.status}; ` +
      'oczekiwano CONFIRMED.';
  } else if (
    !contactId ||
    !staffId ||
    !slot.startDate ||
    !slot.endDate
  ) {
    code = 'BRAK_DANYCH';
    reason = 'Brak kontaktu, pracownika lub terminu.';
  } else if (!booking.revision || dateError) {
    code = 'BRAK_DANYCH';
    reason = dateError || 'Brak revision rezerwacji.';
  } else if (
    !Number.isFinite(Date.parse(slot.startDate)) ||
    Date.parse(slot.startDate) <= Date.now()
  ) {
    code = 'TERMIN_MINAL';
    reason =
      'Nieprawidłowy lub miniony termin pierwszej wizyty.';
  }

  const row = {
    _id: processIdFor(bookingId),
    title: `Rezerwacja ${bookingId}`,
    rezerwacjaWejsciowaId: bookingId,

    ...(idOf(order)
      ? { zamowienieWejscioweId: idOf(order) }
      : {}),

    ...(contactId
      ? { kontaktId: contactId }
      : {}),

    ...(rule
      ? {
          regulaId: rule._id,
          wersjaReguly: rule.wersja,
          regulaSnapshot: copy(rule),
          tryb: rule.tryb
        }
      : {}),

    status: 'REVIEW',
    etap: 'PRZYJECIE',
    wymagaKontroli: true,
    kodBledu: code,
    blad: reason,
    liczbaProb: 0,
    wersjaSchematu: 3,

    daneWejsciowe: copy({
      bookingId,
      status: booking.status,
      kontaktId: contactId,
      revision: booking.revision,
      utworzono: booking.createdDate,
      zrodlo: booking.bookingSource,
      lokalnyStart: local.value,
      strefaCzasowa: local.zone,
      slot,
      zamowienieId: idOf(order),
      statusPlatnosciPrzyPrzyjeciu: order?.paymentStatus,
      regulaAktywnaPrzyPrzyjeciu: rule?.aktywna === true,
      odczytano: new Date().toISOString()
    }),

    stan: {
      wykonanoCykl: false,
      automatyczneWykonanieDozwolone: false,
      obsluga: 'RECZNA',
      powodBlokadyAutomatu: 'WYKONAWCA_NIEWDROZONY'
    }
  };

  try {
    await wixData.insert(PROCESSES, row, WRITE);
  } catch (error) {
    // Insert mógł się udać mimo utraty odpowiedzi.
    // Drugi równoczesny insert także trafi tutaj.
    const recovered = await wixData.get(
      PROCESSES,
      row._id,
      READ
    );

    if (
      recovered?.rezerwacjaWejsciowaId === bookingId
    ) {
      return result(recovered, true);
    }

    throw error;
  }

  const saved = await wixData.get(
    PROCESSES,
    row._id,
    READ
  );

  if (!verified(saved, row)) {
    throw new Error(
      'Nie potwierdzono zapisu procesu. Nie uruchamiaj generatora.'
    );
  }

  return result(saved, false);
}
