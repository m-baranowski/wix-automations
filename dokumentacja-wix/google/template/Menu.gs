// Wklej do skryptu POWIĄZANEGO Z KAŻDYM SZABLONEM Google Docs.
// Nie zawiera globalnego klucza. Kopie dokumentu dziedziczą ten skrypt.
const TOTO_WEBAPP_URL = 'UZUPELNIJ_URL_WDROZENIA_EXEC';

function onOpen() {
  DocumentApp.getUi().createMenu('Dokumentacja Toto')
    .addItem('Zatwierdź i wyślij', 'zatwierdzIWyslij').addToUi();
}

function zatwierdzIWyslij() {
  const ui = DocumentApp.getUi();
  try {
    const document = DocumentApp.getActiveDocument();
    const documentId = document.getId();
    const description = DriveApp.getFileById(documentId).getDescription();
    const metadata = JSON.parse(description || '{}').totoDocumentation;
    if (!metadata) throw new Error('Ten dokument nie został utworzony przez automatyzację Toto.');
    const request = { recordId: metadata.recordId, token: metadata.token, documentId: documentId };
    const preview = totoRequest_('preview', request);
    if (preview.status !== 'DRAFT') {
      ui.alert('Dokument ma status: ' + preview.status + '. Ponowna wysyłka nie została zlecona.');
      return;
    }
    if (preview.needsBirthDate) {
      const answer = ui.prompt('Data urodzenia DZIECKA',
        'Brak daty z rezerwacji. Wpisz datę DZIECKA w formacie DD.MM.RRRR. ' +
        'Zostanie użyta jako hasło PDF. Nie wpisuj daty urodzenia rodzica.', ui.ButtonSet.OK_CANCEL);
      if (answer.getSelectedButton() !== ui.Button.OK) return;
      const parts = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(answer.getResponseText().trim());
      if (!parts) throw new Error('Wymagany format DD.MM.RRRR.');
      request.birthDate = parts[3] + '-' + parts[2] + '-' + parts[1];
    }
    const choice = ui.alert('Potwierdź wysyłkę klientowi',
      'Odbiorca: ' + preview.clientName + '\nAdres: ' + preview.clientEmail +
      '\n\nCzy zatwierdzasz tę wersję dokumentu i wysłanie zaszyfrowanego PDF? ' +
      'Link będzie dostępny około 7 dni. Po zatwierdzeniu wersja do wysyłki zostanie utrwalona.',
      ui.ButtonSet.YES_NO);
    if (choice !== ui.Button.YES) return;
    document.saveAndClose();
    const result = totoRequest_('approve', request);
    ui.alert('Zatwierdzono. Status: ' + result.status +
      '. Wysyłka odbywa się z konta kontakt@centrumtoto.pl, zwykle w ciągu 5 minut.');
  } catch (error) {
    ui.alert('Nie udało się zatwierdzić dokumentu: ' + error.message +
      '\nJeśli żądanie przekroczyło czas oczekiwania, sprawdź status ponownie przed ponawianiem.');
  }
}

function totoRequest_(action, request) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(TOTO_WEBAPP_URL)) {
    throw new Error('Brak poprawnego adresu wdrożenia Google Apps Script.');
  }
  const response = UrlFetchApp.fetch(TOTO_WEBAPP_URL, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(Object.assign({ action: action }, request)),
    muteHttpExceptions: true
  });
  let result;
  try { result = JSON.parse(response.getContentText()); }
  catch (_) { throw new Error('Serwer nie zwrócił JSON. Sprawdź uprawnienia wdrożenia.'); }
  if (!result.ok) throw new Error(result.code || 'Błąd serwera');
  return result;
}
