import type { Writable } from "node:stream";

import type {
  RecoveryRequest,
  SafeManifest,
  SafeManifestAttachment,
} from "./contracts.js";

export interface EphemeralAttachment extends SafeManifestAttachment {
  downloadUrl: string;
  requestHeaders: Readonly<Record<string, string>>;
}

export interface AdapterDiscovery {
  safeManifest: SafeManifest;
  ephemeralAttachments: EphemeralAttachment[];
}

export interface BuyerProfileAdapter {
  discover(request: RecoveryRequest): Promise<AdapterDiscovery>;
}

export interface DownloadReceipt {
  stableId: string;
  bytes: number;
  sha256: string;
}

export interface QuarantineWrite {
  writable: Writable;
  validate(): Promise<void>;
  commit(receipt: DownloadReceipt): Promise<void>;
  abort(): Promise<void>;
}

export interface DocumentIngestionSink {
  open(attachment: SafeManifestAttachment): Promise<QuarantineWrite>;
}

export interface ConsultationResolver {
  resolve(request: RecoveryRequest): Promise<string>;
}

export class ProvidedUrlOnlyResolver implements ConsultationResolver {
  async resolve(request: RecoveryRequest): Promise<string> {
    return request.providedUrl;
  }
}
