import type {
  PlaceBrowserDiscovery,
  PlaceBrowserSession,
} from "./place.js";
import { PlaywrightPortalBrowserSession } from "./playwright-portal-session.js";
import type { RecoveryRequest } from "../contracts.js";

export interface PlaywrightPlaceSessionOptions {
  browserlessToken: string;
  placePortalEmail: string;
  placePortalPassword: string;
  timeoutMs?: number;
  solveCaptchas?: boolean;
}

export class PlaywrightPlaceBrowserSession implements PlaceBrowserSession {
  private readonly session: PlaywrightPortalBrowserSession;

  constructor(options: PlaywrightPlaceSessionOptions) {
    this.session = new PlaywrightPortalBrowserSession({
      browserlessToken: options.browserlessToken,
      email: options.placePortalEmail,
      password: options.placePortalPassword,
      rootHost: "marches-publics.gouv.fr",
      displayName: "PLACE",
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.solveCaptchas === undefined
        ? {}
        : { solveCaptchas: options.solveCaptchas }),
    });
  }

  discover(request: RecoveryRequest): Promise<PlaceBrowserDiscovery> {
    return this.session.discover(request);
  }
}
