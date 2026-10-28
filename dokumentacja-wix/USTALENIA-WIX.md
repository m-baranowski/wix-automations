# Ustalenia z odczytu Wix — 27.10.2026

Witryna: **Centrum Terapii Dziecięcej Toto**, `d222a57f-cfce-4123-83e7-50d68bba4577`.
Odczytano definicje pól i usług, bez pobierania zgłoszeń klientów do repozytorium.

| Usługa | ID | Typ | Formularz |
|---|---|---|---|
| Diagnoza SI + pisemna opinia | `385f98a1-e497-4b61-a437-455846850cb3` | CLASS | `00000000-0000-0000-0000-000000000000` |
| Test ADOS-2 | `94fb8eaf-697a-470a-bb44-892e656b58f9` | APPOINTMENT | `12e9f90c-00af-4283-8cd7-53311529aa3f` |

Nie dodano automatycznie odrębnych usług „Diagnoza SI (sesja)”, konsultacji
wstępnej/podsumowującej ADOS ani terapii SI. Można dodać je świadomie do obu map
usługa → szablon. Rezerwacja CLASS również ma slot; dokumentacja powstaje osobno
dla każdego booking ID, a nie jeden raz dla całej serii czy rodziny.

Potwierdzone pola obu formularzy:

| Etykieta | Target w zgłoszeniu | Typ |
|---|---|---|
| Data urodzenia dziecka | `data_urodzenia_dziecka` | DATE, wymagane |
| Imię i nazwisko dziecka | `s_b7a3e662_4597_4103_bab8_b3416e6fc300` | tekst, wymagane |

`contactDetails.firstName/lastName` oznaczają rodzica/opiekuna. Do nazwy dokumentu
używamy imienia i nazwiska klienta z `booking.contactDetails`. Data urodzenia dziecka służy do hasła PDF. E-mail klienta pochodzi z `booking.contactDetails.email`.
Adres pracownika pochodzi z `booking.bookedEntity.slot.resource.email` lub jawnej
mapy ID zasobu → e-mail w konfiguracji.

Niestandardowe dane formularza odczytuje się przez `booking.formSubmissionId` →
`submissions.getSubmission()` → `submission.submissions[target]`.
Nie należy polegać na dawnym `additionalFields`. Potwierdzono schemat, nie wykonano
jeszcze testu na rzeczywistej/sztucznej rezerwacji tej automatyzacji.

Źródła:

- [Powiązanie Bookings z Forms](https://dev.wix.com/docs/api-reference/business-solutions/bookings/wix-forms-integration)
- [Pobranie zgłoszenia — SDK](https://dev.wix.com/docs/api-reference/crm/forms/form-submissions/get-submission?apiView=SDK)
- [Query Extended Bookings](https://dev.wix.com/docs/api-reference/business-solutions/bookings/bookings/bookings-reader-v2/query-extended-bookings?apiView=SDK)
- [Obsługiwane filtry — pole `id`](https://dev.wix.com/docs/api-reference/business-solutions/bookings/bookings/bookings-reader-v2/supported-filters)
- [Własna akcja automatyzacji — invoke](https://dev.wix.com/docs/velo/events-service-plugins/automations/service-plugins/automations-actions/invoke)
- [Pobieranie sekretów](https://dev.wix.com/docs/api-reference/business-management/secrets/get-secret-value?apiView=SDK)
