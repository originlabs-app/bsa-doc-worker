import { z } from "zod";

export const RecoveryModeSchema = z.enum(["off", "dry_run", "apply"]);
export const RecoveryProviderSchema = z.enum(["mock", "real"]);

export const RequestedLotsSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("all") }).strict(),
    z
      .object({
        kind: z.literal("ids"),
        ids: z.array(z.string().trim().min(1).max(100)).min(1).max(100),
      })
      .strict(),
  ])
  .default({ kind: "all" });

const HttpsUrlSchema = z
  .string()
  .url()
  .max(4_096)
  .refine((value) => new URL(value).protocol === "https:", {
    message: "providedUrl must use HTTPS",
  });

export const RecoveryRequestSchema = z
  .object({
    jobId: z.string().trim().min(1).max(128),
    tenderId: z.string().trim().min(1).max(128),
    sourceField: z.enum(["link_to_buyer_profile", "url_consultation"]),
    providedUrl: HttpsUrlSchema,
    requestedLots: RequestedLotsSchema,
    searchHints: z
      .object({
        reference: z.string().trim().min(1).max(200).optional(),
        title: z.string().trim().min(1).max(500).optional(),
        buyerName: z.string().trim().min(1).max(300).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RecoveryMode = z.infer<typeof RecoveryModeSchema>;
export type RecoveryProvider = z.infer<typeof RecoveryProviderSchema>;
export type RecoveryRequest = z.infer<typeof RecoveryRequestSchema>;
export type RequestedLots = z.infer<typeof RequestedLotsSchema>;

export type Platform = "aw_solutions" | "place" | "dila" | "unsupported";

export type ReasonCode =
  | "WORKER_OFF"
  | "DILA_PUBLICATION_ONLY"
  | "PLACE_V2_PENDING_VALIDATION"
  | "UNSUPPORTED_PORTAL"
  | "MISSING_REAL_SECRETS"
  | "CAPTCHA_UNSOLVED"
  | "AW_AUTHENTICATION_REJECTED"
  | "PROFILE_LINK_NOT_FINAL"
  | "DOWNLOAD_INCOMPLETE"
  | "RETRY_CAP_REACHED"
  | "APPLY_NOT_AUTHORIZED"
  | "ADAPTER_FAILURE";

export interface SafeManifestAttachment {
  stableId: string;
  fileName: string;
  kind: "pdf" | "zip" | "unknown";
  expectedSize: number | null;
}

export interface SafeManifest {
  consultationId: string;
  selectedLots: string[];
  attachments: SafeManifestAttachment[];
}

export interface RecoveryReport {
  jobId: string;
  tenderId: string;
  mode: RecoveryMode;
  platform: Platform;
  status:
    | "off"
    | "manifest_ready"
    | "publication_only"
    | "recovery_blocked"
    | "failed";
  reasonCode?: ReasonCode;
  attemptsUsed: number;
  manifest?: SafeManifest;
  productionWriteOccurred: false;
}
