import type {
  AdapterPlatform,
  Platform,
  ReasonCode,
} from "./contracts.js";

export type PortalRoute =
  | { platform: AdapterPlatform; disposition: "adapter" }
  | {
      platform: Exclude<Platform, AdapterPlatform>;
      disposition: "publication_only" | "blocked";
      reasonCode: ReasonCode;
    };

function isHostOrSubdomain(hostname: string, root: string): boolean {
  return hostname === root || hostname.endsWith(`.${root}`);
}

export function routePortal(rawUrl: string): PortalRoute {
  const hostname = new URL(rawUrl).hostname.toLowerCase();

  if (isHostOrSubdomain(hostname, "marches-publics.info")) {
    return { platform: "aw_solutions", disposition: "adapter" };
  }

  if (isHostOrSubdomain(hostname, "marches-publics.gouv.fr")) {
    return { platform: "place", disposition: "adapter" };
  }

  if (isHostOrSubdomain(hostname, "marches.maximilien.fr")) {
    return { platform: "maximilien", disposition: "adapter" };
  }

  if (isHostOrSubdomain(hostname, "ted.europa.eu")) {
    return {
      platform: "ted",
      disposition: "publication_only",
      reasonCode: "TED_PUBLICATION_ONLY",
    };
  }

  if (
    isHostOrSubdomain(hostname, "dila.gouv.fr") ||
    isHostOrSubdomain(hostname, "boamp.fr")
  ) {
    return {
      platform: "dila",
      disposition: "publication_only",
      reasonCode: "DILA_PUBLICATION_ONLY",
    };
  }

  return {
    platform: "unsupported",
    disposition: "blocked",
    reasonCode: "UNSUPPORTED_PORTAL",
  };
}
