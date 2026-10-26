// Mapuje importy Velo ('backend/faktury/x') na pliki repozytorium.
const KORZEN = new URL('../', import.meta.url);

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('backend/faktury/')) {
    const plik = specifier.slice('backend/'.length);
    return next(new URL(`${plik}.js`, KORZEN).href, context);
  }
  return next(specifier, context);
}
