import type { RecoveryRequest } from "../contracts.js";
import type {
  PlaceBrowserDiscovery,
  PlaceBrowserSession,
} from "./place.js";

const MOCK_PLACE_LISTING_HTML = `<!doctype html><html lang="fr"><body>
  <section id="documents">
    <a data-size="4096" download="Règlement de consultation.pdf"
       href="https://www.marches-publics.gouv.fr/dce/document/mock-rc?signature=fixture-only">RC</a>
    <a data-size="8192" download="DCE complet.zip"
       href="https://telechargement.marches-publics.gouv.fr/dce/download/mock-package?token=fixture-only">DCE</a>
  </section>
</body></html>`;

function consultationId(rawUrl: string): string {
  const segments = new URL(rawUrl).pathname.split("/").filter(Boolean);
  return [...segments].reverse().find((segment) => /^\d+$/.test(segment)) ??
    "mock-place-consultation";
}

export class MockPlaceBrowserSession implements PlaceBrowserSession {
  async discover(request: RecoveryRequest): Promise<PlaceBrowserDiscovery> {
    return {
      consultationUrl: request.providedUrl,
      consultationId: consultationId(request.providedUrl),
      selectedLots:
        request.requestedLots.kind === "all"
          ? ["all"]
          : [...request.requestedLots.ids],
      listingHtml: MOCK_PLACE_LISTING_HTML,
      cookieHeader: "PLACESESSION=mock-only",
      userAgent: "bsa-place-mock",
    };
  }
}
