import test from 'node:test';
import assert from 'node:assert/strict';
import { dateParts, prepareRequest, CONFIG } from './wix-runtime.js';

const serviceId = '94fb8eaf-697a-470a-bb44-892e656b58f9';
const booking = () => ({
  _id: 'test-booking-00001', status: 'CONFIRMED',
  contactDetails: { firstName: 'Rodzic', lastName: 'Testowy', email: 'parent@example.com' },
  bookedEntity: { slot: { serviceId,
    resource: { _id: 'staff-1', email: 'therapist@example.com' } } }
});
const submission = () => ({ submissions: {
  data_urodzenia_dziecka: '2020-01-23',
  s_b7a3e662_4597_4103_bab8_b3416e6fc300: 'Dziecko Testowe'
} });

test('hasło zachowuje zera i osiem cyfr, waliduje kalendarz', () => {
  assert.equal(dateParts('2020-01-03').password, '03012020');
  assert.equal(dateParts('03.01.2020').iso, '2020-01-03');
  assert.throws(() => dateParts('2023-02-29'));
  assert.throws(() => dateParts('2100-01-01'));
  assert.throws(() => dateParts('23/01/20'));
});
test('nazwa klienta z rezerwacji i data dziecka z formularza', () => {
  const result = prepareRequest(booking(), {}, CONFIG, submission());
  assert.equal(result.clientName, 'Rodzic Testowy');
  assert.equal(result.clientEmail, 'parent@example.com');
  assert.equal(result.childBirthDate, '2020-01-23');
  assert.equal(result.staffEmail, 'therapist@example.com');
});
test('inne usługi i anulowane rezerwacje nie uruchamiają dokumentacji', () => {
  const value = booking();
  value.status = 'CANCELED';
  assert.equal(prepareRequest(value, {}, CONFIG, submission()), null);
  value.status = 'CONFIRMED';
  value.bookedEntity.slot.serviceId = 'other';
  assert.equal(prepareRequest(value, {}, CONFIG, submission()), null);
});
test('brak pracownika, adresu lub nazwiska klienta blokuje zlecenie', () => {
  const unnamed = booking();
  delete unnamed.contactDetails.lastName;
  assert.throws(() => prepareRequest(unnamed, {}, CONFIG, submission()), /DOCUMENT_NAME/);
  const value = booking();
  value.contactDetails.email = 'parent@example.com,other@example.com';
  assert.throws(() => prepareRequest(value, {}, CONFIG, submission()), /EMAIL_INVALID/);
  value.contactDetails.email = 'parent@example.com';
  delete value.bookedEntity.slot.resource;
  assert.throws(() => prepareRequest(value, {}, CONFIG, submission()), /ASSIGNED_STAFF/);
});
test('brak daty daje null dla kontrolowanego uzupełnienia w menu', () => {
  const form = submission();
  delete form.submissions.data_urodzenia_dziecka;
  assert.equal(prepareRequest(booking(), {}, CONFIG, form).childBirthDate, null);
});
