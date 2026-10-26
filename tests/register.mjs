// Velo importuje moduły ścieżką 'backend/faktury/...'.
// Ten hook mapuje ją na pliki repozytorium — tylko w testach.
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
