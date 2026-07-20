import type { RecoveryRequest } from "../contracts.js";
import type {
  MaximilienBrowserDiscovery,
  MaximilienBrowserSession,
} from "./maximilien.js";
import { PlaywrightPortalBrowserSession } from "./playwright-portal-session.js";

export interface PlaywrightMaximilienSessionOptions {
  browserlessToken: string;
  maximilienPortalEmail: string;
  maximilienPortalPassword: string;
  timeoutMs?: number;
}

export class PlaywrightMaximilienBrowserSession
  implements MaximilienBrowserSession
{
  private readonly session: PlaywrightPortalBrowserSession;

  constructor(options: PlaywrightMaximilienSessionOptions) {
    this.session = new PlaywrightPortalBrowserSession({
      browserlessToken: options.browserlessToken,
      email: options.maximilienPortalEmail,
      password: options.maximilienPortalPassword,
      rootHost: "marches.maximilien.fr",
      displayName: "Maximilien",
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
  }

  discover(request: RecoveryRequest): Promise<MaximilienBrowserDiscovery> {
    return this.session.discover(request);
  }
}
