import type { ReasonCode } from "../contracts.js";

export class PortalAdapterError extends Error {
  constructor(
    readonly reasonCode: ReasonCode,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "PortalAdapterError";
  }
}
