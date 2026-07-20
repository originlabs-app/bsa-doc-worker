import type { AnalysisRole } from "./types.js";

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function hasToken(value: string, token: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${token}[0-9]*([^a-z0-9]|$)`, "i").test(
    value,
  );
}

export function classifyAnalysisRole(fileName: string): AnalysisRole | null {
  const value = normalize(fileName);
  if (
    hasToken(value, "rc") ||
    /reglement[^a-z0-9]+de[^a-z0-9]+(la[^a-z0-9]+)?consultation/.test(value)
  )
    return "rc";
  if (
    hasToken(value, "avis") ||
    hasToken(value, "aapc") ||
    /avis[^a-z0-9]+d[^a-z0-9]+appel[^a-z0-9]+public/.test(value) ||
    /avis[^a-z0-9]+de[^a-z0-9]+publicite/.test(value) ||
    /publicite/.test(value)
  )
    return "avis";
  if (
    hasToken(value, "ccap") ||
    hasToken(value, "ccp") ||
    /clauses[^a-z0-9]+(administratives|particulieres)/.test(value)
  )
    return "ccap";
  if (
    hasToken(value, "ae") ||
    /acte[^a-z0-9]+d[^a-z0-9]+engagement/.test(value) ||
    /acte[^a-z0-9]+engagement/.test(value)
  )
    return "ae";
  if (
    hasToken(value, "cctp") ||
    /(^|[^a-z0-9])cdc/.test(value) ||
    /cahier[^a-z0-9]+des[^a-z0-9]+charges/.test(value) ||
    /clauses[^a-z0-9]+techniques/.test(value)
  )
    return "cctp";
  if (
    hasToken(value, "dpgf") ||
    /decomposition[^a-z0-9]+du[^a-z0-9]+prix/.test(value)
  )
    return "dpgf";
  if (
    hasToken(value, "bpu") ||
    /bordereau[^a-z0-9]+(des[^a-z0-9]+)?prix/.test(value)
  )
    return "bpu";
  if (hasToken(value, "dqe") || /detail[^a-z0-9]+quantitatif/.test(value))
    return "dqe";
  return null;
}

const CONTENT_PATTERNS: Array<{ role: AnalysisRole; patterns: RegExp[] }> = [
  {
    role: "rc",
    patterns: [
      /reglement\s+de\s+(la\s+)?consultation/,
      /r\.?\s*c\.?\s*[-:]\s*reglement/,
    ],
  },
  {
    role: "avis",
    patterns: [
      /avis\s+d\s+appel\s+public\s+a\s+la\s+concurrence/,
      /avis\s+de\s+publicite/,
      /\baapc\b/,
    ],
  },
  {
    role: "ccap",
    patterns: [
      /cahier\s+des\s+clauses\s+administratives\s+particulieres/,
      /\bccap\b/,
      /cahier\s+des\s+clauses\s+particulieres/,
    ],
  },
  { role: "ae", patterns: [/acte\s+d\s+engagement/, /\bae\b/] },
  {
    role: "cctp",
    patterns: [
      /cahier\s+des\s+clauses\s+techniques\s+particulieres/,
      /\bcctp\b/,
      /cahier\s+des\s+charges/,
    ],
  },
  {
    role: "dpgf",
    patterns: [/decomposition\s+du\s+prix\s+global\s+et\s+forfaitaire/, /\bdpgf\b/],
  },
  { role: "bpu", patterns: [/bordereau\s+(des|de)\s+prix/, /\bbpu\b/] },
  { role: "dqe", patterns: [/detail\s+quantitatif\s+estimatif/, /\bdqe\b/] },
];

export function classifyAnalysisRoleFromText(text: string): AnalysisRole | null {
  const value = normalize(text).replace(/[^a-z0-9]+/g, " ").trim();
  const roles = [
    ...new Set(
      CONTENT_PATTERNS.filter(({ patterns }) =>
        patterns.some((pattern) => pattern.test(value)),
      ).map(({ role }) => role),
    ),
  ];
  return roles.length === 1 ? (roles[0] ?? null) : null;
}
