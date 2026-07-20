import { z } from "zod";

export const DOCUMENT_READER_ROLES = [
  "rc",
  "avis",
  "ccap",
  "ae",
  "cctp",
  "dpgf",
  "bpu",
  "dqe",
  "inconnu",
] as const;

export type DocumentReaderRole = (typeof DOCUMENT_READER_ROLES)[number];

export interface DocumentReaderPayload {
  texte: string;
  pages_lues: number;
}

function compatibleTextSchema(role: DocumentReaderRole) {
  return z
    .object({
      texte: z
        .string()
        .max(500_000)
        .describe(`Texte utile lu dans le document ${role}`),
      pages_lues: z.number().int().nonnegative(),
    })
    .strict();
}

export const documentReaderSchemas = {
  rc: compatibleTextSchema("rc"),
  avis: compatibleTextSchema("avis"),
  ccap: compatibleTextSchema("ccap"),
  ae: compatibleTextSchema("ae"),
  cctp: compatibleTextSchema("cctp"),
  dpgf: compatibleTextSchema("dpgf"),
  bpu: compatibleTextSchema("bpu"),
  dqe: compatibleTextSchema("dqe"),
  inconnu: compatibleTextSchema("inconnu"),
} satisfies Record<
  DocumentReaderRole,
  z.ZodType<DocumentReaderPayload, z.ZodTypeDef, unknown>
>;

export function readerRoleInstruction(role: DocumentReaderRole): string {
  switch (role) {
    case "rc":
      return "Lis le règlement de consultation en insistant sur qualifications, visites, admissibilité, référence, profil acheteur et critères d’attribution.";
    case "avis":
      return "Lis l’avis de publicité en insistant sur montants, lots, durée, référence, profil acheteur et critères d’attribution.";
    case "ccap":
      return "Lis le CCAP en insistant sur délai d’exécution, durée, début des prestations, insertion sociale et indications financières.";
    case "ae":
      return "Lis l’acte d’engagement en insistant sur montants, lots, durée, référence, forme du contrat et éléments financiers.";
    case "cctp":
      return "Lis le CCTP en insistant sur qualifications, exigences techniques et prestations attendues.";
    case "dpgf":
    case "bpu":
    case "dqe":
      return `Lis le document de prix ${role.toUpperCase()} en conservant prestations, quantités, unités, prix unitaires et totaux.`;
    case "inconnu":
      return "Lis cette pièce de marché public sans supposer son type et conserve tout texte utile à l’analyse du dossier.";
  }
}
