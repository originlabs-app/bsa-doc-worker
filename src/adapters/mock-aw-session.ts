import type {
  AwBrowserDiscovery,
  AwBrowserSession,
} from "./aw-solutions.js";
import type { RecoveryRequest } from "../contracts.js";

const MOCK_LISTING_HTML = `<!doctype html>
<html lang="fr"><body>
  <a data-size="24576" download="AAPC 26DSP03.pdf"
     href="https://downloads.awsolutions.fr/dce/attachment/mock-aapc?signature=fixture-only">AAPC</a>
  <a data-size="1048576" download="DCE 26DSP03.zip"
     href="https://downloads.awsolutions.fr/dce/attachment/mock-dce?signature=fixture-only">DCE</a>
  <a href="/index.cfm?fuseaction=dce.TDoc&id=mock-notice">Avis</a>
</body></html>`;

function consultationId(rawUrl: string): string {
  const url = new URL(rawUrl);
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() === "idm" && value) return value;
  }
  return "mock-consultation";
}

export class MockAwBrowserSession implements AwBrowserSession {
  async discover(request: RecoveryRequest): Promise<AwBrowserDiscovery> {
    return {
      consultationUrl: request.providedUrl,
      consultationId: consultationId(request.providedUrl),
      selectedLots:
        request.requestedLots.kind === "all"
          ? ["all"]
          : [...request.requestedLots.ids],
      listingHtml: MOCK_LISTING_HTML,
      cookieHeader: "CFID=mock-only; CFTOKEN=mock-only",
      userAgent: "bsa-dce-recovery-mock",
    };
  }
}
