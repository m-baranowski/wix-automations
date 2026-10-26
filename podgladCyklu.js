import wixData from 'wix-data';
import { extendedBookings, services } from '@wix/bookings';
import { auth } from '@wix/essentials';

const READ = {
  suppressAuth: true,
  suppressHooks: true,
  consistentRead: true
};

const queryBookings = auth.elevate(
  extendedBookings.queryExtendedBookings
);

const getService = auth.elevate(services.getService);
const idOf = value => value?._id || value?.id;

export async function podgladCyklu({ processId } = {}) {
  if (!processId) {
    throw new Error('Podaj processId.');
  }

  const process = await wixData.get(
    'ProcesyRezerwacji',
    processId,
    READ
  );

  if (!process) {
    throw new Error('Nie znaleziono procesu.');
  }

  const rule = process.regulaSnapshot;

  if (!rule?.uslugaDocelowaId) {
    throw new Error(
      'Proces nie ma migawki dopasowanej reguły.'
    );
  }

  const response = await queryBookings(
    {
      filter: {
        id: process.rezerwacjaWejsciowaId
      },
      cursorPaging: { limit: 2 }
    },
    { withEcomOrder: true }
  );

  const items = response.extendedBookings || [];

  if (
    items.length !== 1 ||
    idOf(items[0].booking) !== process.rezerwacjaWejsciowaId
  ) {
    throw new Error(
      'Nie znaleziono jednoznacznie rezerwacji.'
    );
  }

  const booking = items[0].booking;
  const slot = booking.bookedEntity?.slot;
  const staffId = idOf(slot?.resource);

  const issues = [];

  const add = (kod, opis) => {
    issues.push({ kod, opis });
  };

  if (booking.status !== 'CONFIRMED') {
    add('STATUS_REZERWACJI', booking.status);
  }

  if (!staffId) {
    add('BRAK_PRACOWNIKA', 'Brak pracownika w rezerwacji.');
  }

  if (slot?.serviceId !== rule.uslugaWejsciowaId) {
    add(
      'ZMIANA_USLUGI',
      'Usługa nie odpowiada migawce reguły.'
    );
  }

  if (
    String(booking.revision) !==
    String(process.daneWejsciowe?.revision)
  ) {
    add(
      'ZMIANA_REZERWACJI',
      'Revision zmieniło się od przyjęcia zgłoszenia.'
    );
  }

  const start = new Date(slot?.startDate);

  if (!Number.isFinite(start.getTime())) {
    throw new Error('Nieprawidłowy termin rezerwacji.');
  }

  if (start.getTime() <= Date.now()) {
    add('TERMIN_MINAL', 'Pierwszy termin już minął.');
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
      .formatToParts(start)
      .map(part => [part.type, part.value])
  );

  const firstDate =
    `${parts.year}-${parts.month}-${parts.day}`;

  const time = `${parts.hour}:${parts.minute}`;

  const target = await getService(
    rule.uslugaDocelowaId
  );

  if (!Array.isArray(target.staffMemberIds)) {
    add(
      'NIEZNANE_PRZYPISANIE',
      'API nie zwróciło listy pracowników usługi docelowej.'
    );
  } else if (!target.staffMemberIds.includes(staffId)) {
    add(
      'PRACOWNIK_NIEPRZYPISANY_DO_USLUGI_DOCELOWEJ',
      `${slot.resource?.name || staffId} ` +
      `nie jest przypisany do ${target.name}.`
    );
  }

  if (target.type !== 'APPOINTMENT') {
    add(
      'TYP_USLUGI',
      'Usługa docelowa nie jest typu APPOINTMENT.'
    );
  }

  const dates = [];
  const interval = rule.coIleTygodni;

  if (
    !Number.isInteger(interval) ||
    interval < 1 ||
    interval > 52
  ) {
    add(
      'ODSTEP_WIZYT',
      'Niepoprawna wartość coIleTygodni.'
    );
  } else if (rule.tryb === 'CYKL') {
    const months = rule.horyzontMiesiecy;

    if (
      !Number.isInteger(months) ||
      months < 1 ||
      months > 12
    ) {
      add(
        'HORYZONT',
        'Niepoprawny horyzont miesięcy.'
      );
    } else {
      // Horyzont obejmuje miesiąc rozpoczęcia.
      // Październik + 3 miesiące oznacza październik–grudzień.
      const end = new Date(
        Date.UTC(
          Number(parts.year),
          Number(parts.month) - 1 + months,
          1
        )
      );

      // UTC służy tu wyłącznie do arytmetyki dat kalendarzowych.
      // Godzina wizyty pozostaje lokalna, także po zmianie czasu.
      const day = new Date(`${firstDate}T00:00:00Z`);

      while (day < end) {
        dates.push(day.toISOString().slice(0, 10));
        day.setUTCDate(day.getUTCDate() + 7 * interval);
      }
    }
  } else if (rule.tryb === 'PAKIET') {
    if (
      !Number.isInteger(rule.liczbaWizyt) ||
      rule.liczbaWizyt < 1 ||
      rule.liczbaWizyt > 52
    ) {
      add(
        'LICZBA_WIZYT',
        'Niepoprawna liczba wizyt.'
      );
    } else {
      const day = new Date(`${firstDate}T00:00:00Z`);

      for (let i = 0; i < rule.liczbaWizyt; i++) {
        dates.push(day.toISOString().slice(0, 10));
        day.setUTCDate(day.getUTCDate() + 7 * interval);
      }
    }
  } else {
    add('TRYB', 'Nieobsługiwany tryb reguły.');
  }

  return {
    status: issues.length
      ? 'BLOCKED'
      : 'WSTEPNA_KONTROLA_OK',

    tylkoOdczyt: true,
    gotoweDoWykonania: false,

    processId,
    bookingId: idOf(booking),

    regula: rule.title,
    wersjaReguly: process.wersjaReguly,

    terapeuta: slot.resource?.name,
    uslugaDocelowa: target.name,
    stawka: rule.stawka,

    pierwszyTermin: firstDate,
    godzina: time,
    strefaCzasowa: zone,

    terminyKandydackie: dates,
    problemy: issues,

    pozostaleKontrole: [
      'Dostępność, blokady i kolizje każdego terminu.',
      'Dokładne sesje oraz serie ofert cyklu do zamknięcia.',
      'Istniejące umowy, wizyty i rozliczenia klienta.'
    ]
  };
}
