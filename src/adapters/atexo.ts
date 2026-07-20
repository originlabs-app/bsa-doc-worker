// Atexo-based portals (PLACE, Maximilien) expose their download actions in
// the query string of `/index.php` style URLs instead of the pathname, e.g.
// `/index.php?page=Entreprise.EntrepriseDemandeTelechargementDce&id=...`.
// Night sweep 2026-07-20 proved both portals serve real pieces exclusively
// through these actions, so pathname-only attachment checks miss every piece.

const ATEXO_PAGE_PARAMETER = "page";

// Only the download actions observed on the real consultations are accepted:
// `Entreprise.EntrepriseDemandeTelechargementDce` (DCE request interstitial)
// and `Entreprise.EntrepriseDownloadReglement` (direct "Règlement" download).
const ATEXO_DOWNLOAD_ACTION_PATTERN =
  /^entreprise\.entreprise(?:demandetelechargementdce|downloadreglement)$/i;

export function atexoPageAction(url: URL): string | null {
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() === ATEXO_PAGE_PARAMETER && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function isAtexoDownloadActionUrl(url: URL): boolean {
  const action = atexoPageAction(url);
  return action !== null && ATEXO_DOWNLOAD_ACTION_PATTERN.test(action);
}
