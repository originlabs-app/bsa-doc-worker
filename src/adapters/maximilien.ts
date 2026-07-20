import type { RecoveryRequest } from "../contracts.js";
import type { AdapterDiscovery, BuyerProfileAdapter } from "../ports.js";
import {
  parsePortalListing,
  type PortalBrowserDiscovery,
  type PortalBrowserSession,
} from "./portal-manifest.js";

export type MaximilienBrowserDiscovery = PortalBrowserDiscovery;
export type MaximilienBrowserSession = PortalBrowserSession;

export function parseMaximilienListing(
  discovery: MaximilienBrowserDiscovery,
): AdapterDiscovery {
  return parsePortalListing(discovery, {
    platform: "maximilien",
    rootHost: "marches.maximilien.fr",
    displayName: "Maximilien",
  });
}

export class MaximilienAdapter implements BuyerProfileAdapter {
  constructor(private readonly browserSession: MaximilienBrowserSession) {}

  async discover(request: RecoveryRequest): Promise<AdapterDiscovery> {
    return parseMaximilienListing(await this.browserSession.discover(request));
  }
}
