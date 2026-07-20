import type { RecoveryRequest } from "../contracts.js";
import type { AdapterDiscovery, BuyerProfileAdapter } from "../ports.js";
import {
  parsePortalListing,
  type PortalBrowserDiscovery,
  type PortalBrowserSession,
} from "./portal-manifest.js";

export type PlaceBrowserDiscovery = PortalBrowserDiscovery;
export type PlaceBrowserSession = PortalBrowserSession;

export function parsePlaceListing(
  discovery: PlaceBrowserDiscovery,
): AdapterDiscovery {
  return parsePortalListing(discovery, {
    platform: "place",
    rootHost: "marches-publics.gouv.fr",
    displayName: "PLACE",
  });
}

export class PlaceAdapter implements BuyerProfileAdapter {
  constructor(private readonly browserSession: PlaceBrowserSession) {}

  async discover(request: RecoveryRequest): Promise<AdapterDiscovery> {
    return parsePlaceListing(await this.browserSession.discover(request));
  }
}
