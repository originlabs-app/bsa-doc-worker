import { createHash } from "node:crypto";

import { z } from "zod";

import {
  ReaderLlmInvalidOutputError,
  ReaderLlmProviderError,
  roundedCost,
  SdkStructuredOutputError,
  type StructuredPdfClient,
} from "../llm/document-reader.js";
import {
  documentReaderSchemas,
  type DocumentReaderPayload,
  type DocumentReaderRole,
} from "../llm/document-schemas.js";

const PRIMARY_ZOD_ATTEMPTS = 2;

export interface CascadePdfInput {
  bytes: Uint8Array;
  fileName: string;
  role: DocumentReaderRole;
}

export interface CascadeClients {
  primary: StructuredPdfClient;
  /** Absent = cascade désactivée, comportement historique (2 tentatives puis échec). */
  fallback?: StructuredPdfClient | undefined;
}

export interface CascadePdfReadResult {
  text: string;
  pagesRead: number;
  /** Coût total de la lecture (titulaire + secours), hors audit. */
  costUsd: number;
  primaryCostUsd: number;
  fallbackCostUsd: number;
  /** Nombre total d'appels modèle effectués. */
  attempts: number;
  /** Nombre d'appels dont la sortie a violé le schéma zod. */
  zodAttempts: number;
  fallbackUsed: boolean;
}

function isSchemaFailure(error: unknown): boolean {
  return error instanceof z.ZodError || error instanceof SdkStructuredOutputError;
}

function schemaFailureCost(error: unknown): number {
  return error instanceof SdkStructuredOutputError ? error.costUsd : 0;
}

/**
 * Cascade lecteur : modèle titulaire (flash-lite) avec 2 tentatives schéma,
 * puis UN SEUL appel du modèle de secours si les deux tentatives violent le
 * schéma zod. Les erreurs fournisseur restent transitoires et interrompent la
 * cascade avec le coût accumulé.
 */
export async function readPdfWithModelCascade(
  input: CascadePdfInput,
  clients: CascadeClients,
): Promise<CascadePdfReadResult> {
  const schema = documentReaderSchemas[input.role];
  let totalCost = 0;
  let primaryCost = 0;
  let zodAttempts = 0;
  let attempts = 0;
  let lastError: unknown;

  for (let attempt = 1; attempt <= PRIMARY_ZOD_ATTEMPTS; attempt += 1) {
    attempts += 1;
    try {
      const generated = await clients.primary.generate({
        ...input,
        schema,
        repair: attempt > 1,
      });
      totalCost = roundedCost(totalCost + generated.costUsd);
      primaryCost = roundedCost(primaryCost + generated.costUsd);
      const parsed = schema.parse(generated.object);
      return {
        text: parsed.texte.trim(),
        pagesRead: parsed.pages_lues,
        costUsd: totalCost,
        primaryCostUsd: primaryCost,
        fallbackCostUsd: 0,
        attempts,
        zodAttempts,
        fallbackUsed: false,
      };
    } catch (error) {
      if (!isSchemaFailure(error)) {
        if (error instanceof ReaderLlmProviderError) {
          throw new ReaderLlmProviderError(
            roundedCost(totalCost + error.costUsd),
            { cause: error },
          );
        }
        throw error;
      }
      const cost = schemaFailureCost(error);
      totalCost = roundedCost(totalCost + cost);
      primaryCost = roundedCost(primaryCost + cost);
      zodAttempts += 1;
      lastError = error;
    }
  }

  if (!clients.fallback) {
    throw new ReaderLlmInvalidOutputError(totalCost, { cause: lastError });
  }

  attempts += 1;
  try {
    const generated = await clients.fallback.generate({
      ...input,
      schema,
      repair: true,
    });
    const fallbackCost = roundedCost(generated.costUsd);
    totalCost = roundedCost(totalCost + fallbackCost);
    const parsed = schema.parse(generated.object);
    return {
      text: parsed.texte.trim(),
      pagesRead: parsed.pages_lues,
      costUsd: totalCost,
      primaryCostUsd: primaryCost,
      fallbackCostUsd: fallbackCost,
      attempts,
      zodAttempts,
      fallbackUsed: true,
    };
  } catch (error) {
    if (error instanceof ReaderLlmProviderError) {
      throw new ReaderLlmProviderError(roundedCost(totalCost + error.costUsd), {
        cause: error,
      });
    }
    if (!isSchemaFailure(error)) throw error;
    totalCost = roundedCost(totalCost + schemaFailureCost(error));
    throw new ReaderLlmInvalidOutputError(totalCost, { cause: error });
  }
}

export interface AuditGenerationResult {
  payload: DocumentReaderPayload | null;
  costUsd: number;
}

/**
 * Un appel d'audit (une seule tentative, jamais bloquant) sur le modèle de
 * secours. Retourne `payload: null` si la sortie est invalide ou si le
 * fournisseur échoue ; le coût observé est toujours retourné.
 */
export async function generateAuditPayload(
  input: CascadePdfInput,
  client: StructuredPdfClient,
): Promise<AuditGenerationResult> {
  const schema = documentReaderSchemas[input.role];
  try {
    const generated = await client.generate({
      ...input,
      schema,
      repair: false,
    });
    const cost = roundedCost(generated.costUsd);
    const parsed = schema.safeParse(generated.object);
    return { payload: parsed.success ? parsed.data : null, costUsd: cost };
  } catch (error) {
    if (
      error instanceof SdkStructuredOutputError ||
      error instanceof ReaderLlmInvalidOutputError ||
      error instanceof ReaderLlmProviderError
    ) {
      return { payload: null, costUsd: roundedCost(error.costUsd) };
    }
    return { payload: null, costUsd: 0 };
  }
}

function normalizedText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Compare champ à champ deux sorties structurées du lecteur. */
export function compareReaderPayloads(
  primary: DocumentReaderPayload,
  audit: DocumentReaderPayload,
): string[] {
  const differences: string[] = [];
  if (normalizedText(primary.texte) !== normalizedText(audit.texte)) {
    differences.push("texte");
  }
  if (primary.pages_lues !== audit.pages_lues) {
    differences.push("pages_lues");
  }
  return differences;
}

/**
 * Échantillonnage déterministe (sans Math.random) : hash SHA-256 de
 * l'identifiant, premier mot de 32 bits modulo 100 comparé au pourcentage.
 */
export function isAuditSampled(id: string, samplePercent: number): boolean {
  if (samplePercent <= 0) return false;
  if (samplePercent >= 100) return true;
  const bucket = createHash("sha256").update(id).digest().readUInt32BE(0) % 100;
  return bucket < samplePercent;
}
