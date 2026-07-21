import { describe, expect, it, vi } from "vitest";

import {
  parseAtexoPublicCandidates,
  parseAwPublicCandidates,
} from "../src/portal-resolver.js";
import type { RecoveryTarget } from "../src/recovery/contracts.js";
import {
  buildRecoverySearchTerms,
  createRecoveryPortalSearcher,
} from "../src/recovery/search.js";

const target: RecoveryTarget = {
  tenderId: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  title: "Agrandissement et aménagement du local gardien de la déchèterie d'Aussillon",
  buyerName: "TRIFYL",
  reference: "26-71800",
  buyerProfileLink: "https://www.achatpublic.com/consultation/example",
  lotTitles: [
    "Démolition gros œuvre",
    "Plâtrerie",
    "Électricité chauffage plomberie CVC",
  ],
};

describe("buildRecoverySearchTerms", () => {
  it("prioritizes a distinctive title term and stays within four queries", () => {
    const terms = buildRecoverySearchTerms(target);

    expect(terms[0]).toBe("Aussillon");
    expect(terms).toContain("26-71800");
    expect(terms).toContain("TRIFYL");
    expect(terms).toContain("Démolition");
    expect(new Set(terms).size).toBe(terms.length);
    expect(terms.length).toBeLessThanOrEqual(4);
  });
});

describe("public candidate parsers", () => {
  it("extracts an AW identity while keeping an external DCE blocked", () => {
    const result = parseAwPublicCandidates(`
      <div class="container-fluid" id="entity">
        <h2 class="h2-avis">Eurométropole de Strasbourg (67076)</h2>
        <div id="titre_box">
          <span class="ref-acheteur">[réf. 26EMS0120]</span>
          Travaux de rénovation patrimoniale du Bastion XV, Rue du Rempart à Strasbourg
          <p>Date limite : 15/09/26 à 12h00</p>
        </div>
        <a href="/Annonces/MPI-pub-20262001118.htm">Avis complet</a>
        <a title="Candidature et/ou Offre"
           href="https://plateforme.alsacemarchespublics.eu">Déposer un pli</a>
      </div>
    `);

    expect(result.candidates).toEqual([
      {
        canonicalTitle:
          "Travaux de rénovation patrimoniale du Bastion XV, Rue du Rempart à Strasbourg",
        reference: "26EMS0120",
        buyerName: "Eurométropole de Strasbourg",
        consultationUrl:
          "https://www.marches-publics.info/Annonces/MPI-pub-20262001118.htm",
        deadlineAt: "2026-09-15T10:00:00.000Z",
        lotTitles: [],
        recoveryDisposition: "external_blocked",
        blockedExternalHost: "plateforme.alsacemarchespublics.eu",
      },
    ]);
    expect(result.blockedExternalHosts).toEqual([
      "plateforme.alsacemarchespublics.eu",
    ]);
  });

  it("extracts PLACE and Maximilien consultation identities from Atexo results", () => {
    const html = `
      <div class="item_consultation">
        <input type="hidden" name="refCons" value="942952">
        <input type="hidden" name="orgCons" value="t5y">
        <div class="objet-line">
          <div class="m-b-1"><span class="small pull-left">2600683</span></div>
          <div class="truncate"><span title="Travaux de réfection de l'étanchéité et de chauffage au lycée Léonard de Vinci à Saint Witz (95)">Objet</span></div>
        </div>
        <div id="ctl0_result_ctl1_panelBlocDenomination">
          <div class="truncate-700" title="Conseil Régional d'Ile-de-France (93400 - Saint-Ouen-sur-Seine)">Acheteur</div>
        </div>
        <div class="cons_dateEnd">
          <div class="day"><span>18</span></div>
          <div class="month"><span>Sept.</span></div>
          <div class="year"><span>2026</span></div>
          <div class="time"><label>12:00</label></div>
        </div>
        <a href="https://marches.maximilien.fr/entreprise/consultation/942952?orgAcronyme=t5y">Accéder à la consultation</a>
        <a href="javascript:popUpOpen('index.php?page=Entreprise.PopUpDetailLots&amp;orgAccronyme=t5y&amp;id=942952&amp;lang=', 700, 500)">Lots</a>
      </div>
    `;

    expect(
      parseAtexoPublicCandidates(html, "maximilien").candidates[0],
    ).toMatchObject({
      canonicalTitle:
        "Travaux de réfection de l'étanchéité et de chauffage au lycée Léonard de Vinci à Saint Witz (95)",
      reference: "2600683",
      buyerName: "Conseil Régional d'Ile-de-France",
      consultationUrl:
        "https://marches.maximilien.fr/entreprise/consultation/942952?orgAcronyme=t5y",
      lotDetailUrl:
        "https://marches.maximilien.fr/index.php?page=Entreprise.PopUpDetailLots&orgAccronyme=t5y&id=942952&lang=",
      deadlineAt: "2026-09-18T10:00:00.000Z",
      lotTitles: [],
      recoveryDisposition: "recoverable",
    });
  });
});

describe("createRecoveryPortalSearcher", () => {
  it("sends one bounded query batch and maps portal metadata", async () => {
    const backend = vi.fn(async () => ({
      candidates: [
        {
          canonicalTitle: target.title,
          reference: target.reference,
          buyerName: target.buyerName,
          consultationUrl:
            "https://www.marches-publics.gouv.fr/app.php/entreprise/consultation/42",
          deadlineAt: "2026-09-01T10:00:00.000Z",
          lotTitles: [],
          recoveryDisposition: "recoverable" as const,
        },
      ],
      blockedExternalHosts: [],
      requestCount: 3,
    }));
    const search = createRecoveryPortalSearcher(backend);

    const result = await search("place", target);

    expect(backend).toHaveBeenCalledOnce();
    expect(backend).toHaveBeenCalledWith(
      "place",
      buildRecoverySearchTerms(target),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.portal).toBe("place");
    expect(result.requestCount).toBe(3);
  });
});
