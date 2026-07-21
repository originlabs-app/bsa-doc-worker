import assert from "node:assert/strict";

import { searchPortalPublicCandidates } from "../src/portal-resolver.js";
import type {
  RecoveryPortal,
  RecoveryTarget,
} from "../src/recovery/contracts.js";
import { reconcilePortalCandidates } from "../src/recovery/matching.js";
import {
  createRecoveryPortalSearcher,
  type RecoveryPublicSearchBackend,
} from "../src/recovery/search.js";

interface ProbeCase {
  name: string;
  portal: RecoveryPortal;
  target: RecoveryTarget;
  expectedUrl: string;
  expectedDisposition: "recoverable" | "external_blocked";
  expectedBlockedHost?: string;
  expectedDecision?: "exact" | "strong";
  expectedMinLots?: number;
  expectedUmbrella?: boolean;
}

const PROBE_NOW = new Date("2026-07-21T12:00:00.000Z");
const ALLOWED_ORIGINS = new Set([
  "https://www.marches-publics.info",
  "https://www.marches-publics.gouv.fr",
  "https://marches.maximilien.fr",
]);

const cases: ProbeCase[] = [
  {
    name: "maximilien-942952",
    portal: "maximilien",
    target: {
      tenderId: "00000000-0000-4000-8000-000000000001",
      companyId: "00000000-0000-4000-8000-000000000101",
      title:
        "Travaux de réfection de l'étanchéité et de chauffage au lycée Léonard de Vinci à Saint Witz (95)",
      buyerName: "Conseil Régional d'Ile-de-France",
      reference: "2600683",
      buyerProfileLink: "https://marches.maximilien.fr/",
      lotTitles: [],
    },
    expectedUrl:
      "https://marches.maximilien.fr/entreprise/consultation/942952?orgAcronyme=t5y",
    expectedDisposition: "recoverable",
  },
  {
    name: "aw-bastion-xv",
    portal: "aw_solutions",
    target: {
      tenderId: "00000000-0000-4000-8000-000000000002",
      companyId: "00000000-0000-4000-8000-000000000102",
      title:
        "Travaux de rénovation patrimoniale du Bastion XV, Rue du Rempart à Strasbourg",
      buyerName: "Eurométropole de Strasbourg",
      reference: "26EMS0120",
      buyerProfileLink: "https://www.marches-publics.info/",
      lotTitles: [],
    },
    expectedUrl:
      "https://www.marches-publics.info/Annonces/MPI-pub-20262001118.htm",
    expectedDisposition: "external_blocked",
    expectedBlockedHost: "plateforme.alsacemarchespublics.eu",
  },
  {
    name: "place-aphp-3031184",
    portal: "place",
    target: {
      tenderId: "00000000-0000-4000-8000-000000000003",
      companyId: "00000000-0000-4000-8000-000000000103",
      title:
        "Travaux d’entretien et de modernisation du Groupe Hospitalo-Universitaire AP-HP. Sorbonne",
      buyerName: "AP-HP Sorbonne Université",
      reference: "481582-2026",
      buyerProfileLink: "https://ted.europa.eu/",
      lotTitles: [
        "11B Electricité (SAT)",
        "2AE Peinture (PSL/CFX)",
        "13C CVC (TNN)",
      ],
    },
    expectedUrl:
      "https://www.marches-publics.gouv.fr/app.php/entreprise/consultation/3031184?orgAcronyme=x7c",
    expectedDisposition: "recoverable",
    expectedDecision: "strong",
    expectedMinLots: 2,
    expectedUmbrella: true,
  },
  {
    name: "aw-beziers-26emfa16",
    portal: "aw_solutions",
    target: {
      tenderId: "00000000-0000-4000-8000-000000000004",
      companyId: "00000000-0000-4000-8000-000000000104",
      title: "Construction du nouveau Centre de Secours Principal de Béziers",
      buyerName: "SDIS 34",
      reference: "26EMFA16",
      buyerProfileLink: "https://www.marches-publics.info/",
      lotTitles: [],
    },
    expectedUrl:
      "https://www.marches-publics.info/mpiaws/index.cfm?fuseaction=dematEnt.login&type=DCE&IDM=1848852",
    expectedDisposition: "recoverable",
  },
];

function inputUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

async function run(): Promise<void> {
  const requestedUrls: URL[] = [];
  const probeFetch: typeof fetch = async (input, init) => {
    const url = inputUrl(input);
    assert(ALLOWED_ORIGINS.has(url.origin), `PROBE_HOST_BLOCKED:${url.origin}`);
    requestedUrls.push(url);
    return fetch(input, init);
  };
  const backend: RecoveryPublicSearchBackend = (portal, queries) =>
    searchPortalPublicCandidates(portal, queries, probeFetch);
  const search = createRecoveryPortalSearcher(backend);
  const output: Array<Record<string, unknown>> = [];

  for (const probeCase of cases) {
    const firstRequest = requestedUrls.length;
    const result = await search(probeCase.portal, probeCase.target);
    assert(
      (result.requestCount ?? 0) <= 8,
      `${probeCase.name}:REQUEST_BUDGET_EXCEEDED`,
    );
    const reconciliation = reconcilePortalCandidates(
      probeCase.target,
      result.candidates,
      { now: PROBE_NOW },
    );
    assert.equal(reconciliation.outcome, "matched", `${probeCase.name}:NO_MATCH`);
    if (reconciliation.outcome !== "matched") continue;
    assert(
      reconciliation.match.level === "exact" ||
        reconciliation.match.level === "strong",
      `${probeCase.name}:WEAK_MATCH`,
    );
    if (probeCase.expectedDecision) {
      assert.equal(
        reconciliation.match.level,
        probeCase.expectedDecision,
        `${probeCase.name}:WRONG_DECISION`,
      );
    }
    if (probeCase.expectedMinLots !== undefined) {
      assert(
        reconciliation.match.lotTitleMatches >= probeCase.expectedMinLots,
        `${probeCase.name}:LOTS_NOT_CONFIRMED`,
      );
    }
    if (probeCase.expectedUmbrella !== undefined) {
      assert.equal(
        reconciliation.match.placeUmbrellaCompatible,
        probeCase.expectedUmbrella,
        `${probeCase.name}:UMBRELLA_NOT_CONFIRMED`,
      );
    }
    assert.equal(
      reconciliation.match.candidate.consultationUrl,
      probeCase.expectedUrl,
      `${probeCase.name}:WRONG_CONSULTATION_URL`,
    );
    assert.equal(
      reconciliation.match.candidate.recoveryDisposition ?? "recoverable",
      probeCase.expectedDisposition,
      `${probeCase.name}:WRONG_DISPOSITION`,
    );
    if (probeCase.expectedBlockedHost) {
      assert.equal(
        reconciliation.match.candidate.blockedExternalHost,
        probeCase.expectedBlockedHost,
        `${probeCase.name}:MISSING_BLOCKED_HOST`,
      );
      assert(
        !requestedUrls.some((url) => url.hostname === probeCase.expectedBlockedHost),
        `${probeCase.name}:EXTERNAL_HOST_REQUESTED`,
      );
    }
    output.push({
      case: probeCase.name,
      portal: probeCase.portal,
      decision: reconciliation.match.level,
      consultationUrl: reconciliation.match.candidate.consultationUrl,
      requests: requestedUrls.length - firstRequest,
      disposition:
        reconciliation.match.candidate.recoveryDisposition ?? "recoverable",
      blockedExternalHost:
        reconciliation.match.candidate.blockedExternalHost ?? null,
      deadlineStatus: reconciliation.match.deadlineStatus,
      lotMatches: reconciliation.match.lotTitleMatches,
      placeUmbrellaCompatible: reconciliation.match.placeUmbrellaCompatible,
    });
  }

  console.log("RECOVERY_SEARCH_PROBE_BEGIN");
  for (const item of output) console.log(JSON.stringify(item));
  console.log(JSON.stringify({
    summary: "PASS",
    cases: `${output.length}/${cases.length}`,
    networkRequests: requestedUrls.length,
    browserlessUnits: 0,
    databaseWrites: 0,
  }));
  console.log("RECOVERY_SEARCH_PROBE_PASS");
}

void run().catch((error: unknown) => {
  console.error("RECOVERY_SEARCH_PROBE_FAIL", error);
  process.exitCode = 1;
});
