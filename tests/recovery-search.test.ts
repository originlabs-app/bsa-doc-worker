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
  it("keeps identity and lot evidence bounded to nine unique public queries", () => {
    const terms = buildRecoverySearchTerms(target);

    expect(terms).toContain("26-71800");
    expect(terms).toContain("TRIFYL");
    expect(terms).toContain("Aussillon");
    expect(terms).toContain("Démolition");
    expect(new Set(terms).size).toBe(terms.length);
    expect(terms.length).toBeLessThanOrEqual(9);
  });
});

describe("public candidate parsers", () => {
  it("extracts a safe AW identity without following an external link", () => {
    const result = parseAwPublicCandidates(`
      <div class="container-fluid" id="entity">
        <div id="titre_box">
          Réhabilitation de l'école Jean Jaurès
          <span class="ref-acheteur">Référence acheteur : LYON-42</span>
          <p class="acheteur">Acheteur : Ville de Lyon</p>
        </div>
        <a title="Dossier de Consultation"
           href="/mpIAWS/index.cfm?fuseaction=dematEnt.login&amp;type=DCE&amp;IDM=42">DCE</a>
        <a href="https://www.achatpublic.com/other">Déposer un pli</a>
      </div>
    `);

    expect(result.candidates).toEqual([
      {
        canonicalTitle: "Réhabilitation de l'école Jean Jaurès",
        reference: "LYON-42",
        buyerName: "Ville de Lyon",
        consultationUrl:
          "https://www.marches-publics.info/mpIAWS/index.cfm?fuseaction=dematEnt.login&type=DCE&IDM=42",
      },
    ]);
    expect(result.blockedExternalHosts).toEqual(["www.achatpublic.com"]);
  });

  it("extracts PLACE and Maximilien consultation identities from Atexo results", () => {
    const html = `
      <div class="item_consultation">
        <div class="objet-line"><span title="Réfection étanchéité lycée Vinci">Objet</span></div>
        <div class="reference">Référence : 2600683</div>
        <div class="acheteur">Acheteur : Région Île-de-France</div>
        <a href="/index.php?page=Entreprise.EntrepriseDetailsConsultation&amp;id=942952&amp;orgAcronyme=IDF">Accéder à la consultation</a>
      </div>
    `;

    expect(
      parseAtexoPublicCandidates(html, "maximilien").candidates[0],
    ).toMatchObject({
      canonicalTitle: "Réfection étanchéité lycée Vinci",
      reference: "2600683",
      buyerName: "Région Île-de-France",
      consultationUrl:
        "https://marches.maximilien.fr/index.php?page=Entreprise.EntrepriseDetailsConsultation&id=942952&orgAcronyme=IDF",
    });
  });
});

describe("createRecoveryPortalSearcher", () => {
  it("deduplicates candidates collected from every bounded query", async () => {
    const backend = vi.fn(async () => ({
      candidates: [
        {
          canonicalTitle: target.title,
          reference: target.reference,
          buyerName: target.buyerName,
          consultationUrl:
            "https://www.marches-publics.gouv.fr/app.php/entreprise/consultation/42",
        },
      ],
      blockedExternalHosts: [],
    }));
    const search = createRecoveryPortalSearcher(backend);

    const result = await search("place", target);

    expect(backend).toHaveBeenCalledTimes(buildRecoverySearchTerms(target).length);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.portal).toBe("place");
  });
});
