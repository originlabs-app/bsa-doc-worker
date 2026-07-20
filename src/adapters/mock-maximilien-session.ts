import type { RecoveryRequest } from "../contracts.js";
import type {
  MaximilienBrowserDiscovery,
  MaximilienBrowserSession,
} from "./maximilien.js";

const MOCK_MAXIMILIEN_LISTING_HTML = `<!doctype html><html lang="fr"><body>
  <section id="documents">
    <a data-file-name="Avis de marché.pdf" data-size="2048"
       href="https://marches.maximilien.fr/document/download/mock-avis?signature=fixture-only">Avis</a>
    <a data-file-name="Pièces DCE.zip"
       href="https://fichiers.marches.maximilien.fr/dce/attachment/mock-package?token=fixture-only">DCE</a>
  </section>
</body></html>`;

function consultationId(rawUrl: string): string {
  const segments = new URL(rawUrl).pathname.split("/").filter(Boolean);
  return [...segments].reverse().find((segment) => /^\d+$/.test(segment)) ??
    "mock-maximilien-consultation";
}

export class MockMaximilienBrowserSession implements MaximilienBrowserSession {
  async discover(
    request: RecoveryRequest,
  ): Promise<MaximilienBrowserDiscovery> {
    return {
      consultationUrl: request.providedUrl,
      consultationId: consultationId(request.providedUrl),
      selectedLots:
        request.requestedLots.kind === "all"
          ? ["all"]
          : [...request.requestedLots.ids],
      listingHtml: MOCK_MAXIMILIEN_LISTING_HTML,
      cookieHeader: "MAXSESSION=mock-only",
      userAgent: "bsa-maximilien-mock",
    };
  }
}
