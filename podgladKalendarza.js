import wixData from 'wix-data';
import { events } from '@wix/calendar';
import { auth } from '@wix/essentials';
import { podgladCyklu } from 'backend/podgladCyklu';

const queryEvents = auth.elevate(events.queryEvents);

const READ = {
  suppressAuth: true,
  suppressHooks: true,
  consistentRead: true
};

const idOf = value => value?._id || value?.id;

function overlaps(startA, endA, startB, endB) {
  // Koniec jednego spotkania równy początkowi drugiego
  // nie oznacza nakładania przedziałów.
  return startA < endB && startB < endA;
}

function addMinutes(local, minutes) {
  // Arytmetyka lokalnych dat, bez zmiany godziny przez DST.
  return new Date(
    Date.parse(local + 'Z') + minutes * 60000
  ).toISOString().slice(0, 19);
}

export async function podgladKalendarza({ processId } = {}) {
  const started = Date.now();

  const check = () => {
    if (Date.now() - started > 25000) {
      throw new Error(
        'Przekroczono budżet podglądu; wynik niekompletny.'
      );
    }
  };

  const base = await podgladCyklu({ processId });
  check();

  const process = await wixData.get(
    'ProcesyRezerwacji',
    processId,
    READ
  );

  check();

  const slot = process?.daneWejsciowe?.slot;
  const staffId = idOf(slot?.resource);
  const scheduleId = slot?.resource?.scheduleId;

  if (!staffId || !scheduleId) {
    throw new Error(
      'Brak identyfikatora pracownika lub jego kalendarza.'
    );
  }

  if (
    base.problemy.some(
      problem => problem.kod === 'ZMIANA_REZERWACJI'
    )
  ) {
    return {
      ...base,
      kalendarzSprawdzony: false,
      powod: 'Najpierw wyjaśnij zmianę rezerwacji.'
    };
  }

  const dates = base.terminyKandydackie;

  if (!dates.length) {
    return {
      ...base,
      kalendarzSprawdzony: false
    };
  }

  const minutes =
    (new Date(slot.endDate) - new Date(slot.startDate)) /
    60000;

  if (
    !Number.isFinite(minutes) ||
    minutes <= 0 ||
    minutes > 1440
  ) {
    throw new Error(
      'Nieprawidłowy czas trwania sesji wejściowej.'
    );
  }

  const options = {
    fromLocalDate: dates[0] + 'T00:00:00',

    toLocalDate: addMinutes(
      dates[dates.length - 1] + 'T00:00:00',
      1440
    ),

    timeZone: base.strefaCzasowa,
    recurrenceType: ['NONE', 'INSTANCE', 'EXCEPTION']
  };

  // Własne wydarzenia terapeuty oraz wydarzenia usług,
  // do których terapeuta jest przypisany jako zasób.
  const filter = {
    $or: [
      { scheduleId },
      {
        'resources.id': {
          $hasSome: [staffId]
        }
      }
    ]
  };

  const all = [];
  const seen = new Set();

  let cursor;

  for (let pageNumber = 0; ; pageNumber++) {
    check();

    if (pageNumber >= 10) {
      throw new Error(
        'Za dużo stron kalendarza; wynik niekompletny.'
      );
    }

    const query = cursor
      ? {
          cursorPaging: {
            limit: 100,
            cursor
          }
        }
      : {
          filter,
          cursorPaging: {
            limit: 100
          }
        };

    const page = await queryEvents(
      query,
      cursor ? {} : options
    );

    check();

    if (!Array.isArray(page.events)) {
      throw new Error('Nieznana odpowiedź kalendarza.');
    }

    all.push(...page.events);

    if (!page.pagingMetadata?.hasNext) {
      break;
    }

    const next = page.pagingMetadata?.cursors?.next;

    if (!next || seen.has(next)) {
      throw new Error('Nieprawidłowy kursor kalendarza.');
    }

    seen.add(next);
    cursor = next;
  }

  const servicesToClose = new Set([
    process.regulaSnapshot.uslugaWejsciowaId,
    ...(
      process.regulaSnapshot.uslugiCykloweDoZamkniecia ||
      []
    )
  ]);

  const unique = [
    ...new Map(
      all.map(event => [idOf(event), event])
    ).values()
  ];

  const relevant = unique.filter(
    event => event.status !== 'CANCELLED'
  );

  for (const event of relevant) {
    if (
      !event.adjustedStart?.localDate ||
      !event.adjustedEnd?.localDate
    ) {
      throw new Error(
        'Wydarzenie bez dat lokalnych; nie można ocenić kolizji.'
      );
    }
  }

  const compact = event => ({
    eventId: idOf(event),
    scheduleId: event.scheduleId,
    serviceId: event.externalScheduleId,
    typ: event.type,
    od: event.adjustedStart.localDate,
    do: event.adjustedEnd.localDate,
    seriaId: event.recurringEventId || null,
    powtarzalnosc: event.recurrenceType,
    wymagaSprawdzeniaUczestnikow: event.type === 'CLASS'
  });

  const calendar = dates.map(date => {
    const start = date + 'T' + base.godzina + ':00';
    const end = addMinutes(start, minutes);

    const hits = relevant.filter(event =>
      overlaps(
        start,
        end,
        event.adjustedStart.localDate.slice(0, 19),
        event.adjustedEnd.localDate.slice(0, 19)
      )
    );

    const isBlock = event =>
      event.type === 'DEFAULT' &&
      event.transparency === 'OPAQUE' &&
      (
        event.scheduleId === scheduleId ||
        event.resources?.some(
          resource => idOf(resource) === staffId
        )
      );

    const isOffer = event =>
      event.type === 'CLASS' &&
      servicesToClose.has(event.externalScheduleId) &&
      event.adjustedStart.localDate.slice(0, 19) === start &&
      event.resources?.some(
        resource => idOf(resource) === staffId
      );

    const blocks = hits.filter(isBlock);
    const offers = hits.filter(isOffer);

    const others = hits.filter(
      event => !isBlock(event) && !isOffer(event)
    );

    return {
      data: date,
      od: start,
      do: end,

      status: blocks.length
        ? 'BLOKADA_KALENDARZA'
        : others.length
          ? 'WYDARZENIA_DO_KONTROLI'
          : offers.length
            ? 'OFERTA_CYKLU_DO_KONTROLI'
            : 'BRAK_WYDARZEN_NIE_POTWIERDZA_DOSTEPNOSCI',

      blokady: blocks.map(compact),
      ofertyCyklu: offers.map(compact),
      inneWydarzenia: others.map(compact)
    };
  });

  return {
    ...base,

    gotoweDoWykonania: false,
    kalendarzSprawdzony: true,

    zakresSprawdzenia:
      'Kalendarz wewnętrzny pracownika, okres planowanych wizyt.',

    czasOknaMinuty: minutes,

    uwagaCzasu:
      'Sprawdzono okno sesji wejściowej; docelowa wizyta ' +
      'może mieć inny czas i bufor.',

    kalendarz: calendar,

    pozostaleKontrole: [
      'Dostępność usługi docelowej, godziny pracy, bufory i zasoby.',
      'Uczestnicy ofert i pełne definicje serii, także poza horyzontem.',
      'Istniejące umowy, rezerwacje i rozliczenia klienta.'
    ],

    czasMs: Date.now() - started
  };
}
