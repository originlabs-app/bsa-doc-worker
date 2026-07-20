import { describe, expect, it } from "vitest";

import {
  buildDistinctiveQuery,
  parseAwPublicSearch,
  parsePlacePublicSearch,
  searchAwPublic,
  searchPlacePublic,
} from "../src/portal-resolver.js";

describe("buildDistinctiveQuery", () => {
  it("selects a discriminating term instead of the truncated title", () => {
    expect(
      buildDistinctiveQuery(
        "Travaux de rénovation patrimoniale du Bastion XV, Rue du Rem",
      ),
    ).toBe("Bastion");
    expect(
      buildDistinctiveQuery(
        "Travaux d'extension du groupe scolaire Erckmann Chatrian à S",
      ),
    ).toBe("Erckmann");
  });
});

describe("parseAwPublicSearch", () => {
  it("returns an exact-prefix AWS DCE route and ignores a similarly named notice", () => {
    const html = `
      <div class="container-fluid" id="entity">
        <div id="titre_box">Travaux du Bastion Nord</div>
        <a title="Dossier de Consultation des Entreprises"
           href="https://www.marches-publics.info/mpiaws/index.cfm?fuseaction=dematEnt.login&amp;type=DCE&amp;IDM=111">DCE</a>
      </div>
      <div class="container-fluid" id="entity">
        <div id="titre_box">
          <div class="ref-acheteur">[réf. 26EMS0120]</div>
          Travaux de rénovation patrimoniale du Bastion XV, Rue du Rempart à Strasbourg
          <p>[Marché alloti : 14 lots]</p>
        </div>
        <a title="Dossier de Consultation des Entreprises"
           href="https://www.marches-publics.info/mpiaws/index.cfm?fuseaction=dematEnt.login&amp;type=DCE&amp;IDM=1841450">DCE</a>
      </div>
    `;

    expect(
      parseAwPublicSearch(
        html,
        "Travaux de rénovation patrimoniale du Bastion XV, Rue du Rem",
      ),
    ).toEqual({
      type: "recoverable",
      portal: "aw_solutions",
      canonicalTitle:
        "Travaux de rénovation patrimoniale du Bastion XV, Rue du Rempart à Strasbourg",
      consultationUrl:
        "https://www.marches-publics.info/mpiaws/index.cfm?fuseaction=dematEnt.login&type=DCE&IDM=1841450",
    });
  });

  it("reports an exact listing whose DCE is hosted by an out-of-scope portal", () => {
    const html = `
      <div class="container-fluid" id="entity">
        <div id="titre_box">
          <div class="ref-acheteur">[réf. 26EMS0120]</div>
          Travaux de rénovation patrimoniale du Bastion XV, Rue du Rempart à Strasbourg
          <p>[Marché alloti : 14 lots]</p>
        </div>
        <a title="Candidature et/ou Offre" href="https://plateforme.alsacemarchespublics.eu">Déposer un pli</a>
      </div>
    `;

    expect(
      parseAwPublicSearch(
        html,
        "Travaux de rénovation patrimoniale du Bastion XV, Rue du Rem",
      ),
    ).toEqual({
      type: "listed_external",
      portal: "aw_solutions",
      canonicalTitle:
        "Travaux de rénovation patrimoniale du Bastion XV, Rue du Rempart à Strasbourg",
      externalHost: "plateforme.alsacemarchespublics.eu",
    });
  });
});

describe("parsePlacePublicSearch", () => {
  it("returns only an exact-prefix PLACE consultation on the allowlisted host", () => {
    const html = `
      <div class="item_consultation">
        <div class="objet-line">
          <div class="small pull-left truncate">
            <span title="Travaux de rénovation patrimoniale du Bastion XV, Rue du Rempart à Strasbourg">Bastion</span>
          </div>
        </div>
        <a href="https://www.marches-publics.gouv.fr/app.php/entreprise/consultation/3036454?orgAcronyme=f2h">Accéder à la consultation</a>
      </div>
    `;

    expect(
      parsePlacePublicSearch(
        html,
        "Travaux de rénovation patrimoniale du Bastion XV, Rue du Rem",
      ),
    ).toEqual({
      type: "recoverable",
      portal: "place",
      canonicalTitle:
        "Travaux de rénovation patrimoniale du Bastion XV, Rue du Rempart à Strasbourg",
      consultationUrl:
        "https://www.marches-publics.gouv.fr/app.php/entreprise/consultation/3036454?orgAcronyme=f2h",
    });
  });

  it("fails closed when the exact title has no allowlisted consultation URL", () => {
    const html = `
      <div class="item_consultation">
        <div class="objet-line">
          <div class="small pull-left truncate">
            <span title="Travaux de rénovation patrimoniale du Bastion XV, Rue du Rempart à Strasbourg">Bastion</span>
          </div>
        </div>
        <a href="https://attacker.invalid/consultation/1">Accéder à la consultation</a>
      </div>
    `;

    expect(
      parsePlacePublicSearch(
        html,
        "Travaux de rénovation patrimoniale du Bastion XV, Rue du Rem",
      ),
    ).toEqual({ type: "not_found", portal: "place" });
  });
});

describe("public portal searches", () => {
  it("sends one bounded AWS request with the distinctive term", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const fetchStub: typeof fetch = async (input, init) => {
      requests.push({
        url: input.toString(),
        body: String(init?.body),
      });
      return new Response('<div class="alert">Aucun résultat trouvé</div>', {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };

    const outcome = await searchAwPublic(
      "Travaux de rénovation patrimoniale du Bastion XV, Rue du Rem",
      fetchStub,
    );

    expect(outcome).toEqual({ type: "not_found", portal: "aw_solutions" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://www.marches-publics.info/Annonces/lister",
    );
    expect(new URLSearchParams(requests[0]?.body).get("txtLibre")).toBe(
      "Bastion",
    );
  });

  it("sends one bounded PLACE search with the distinctive term", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const fetchStub: typeof fetch = async (input, init) => {
      requests.push({
        url: input.toString(),
        body: String(init?.body),
      });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "/?page=Entreprise.EntrepriseAdvancedSearch&searchAnnCons&keyWord=Erckmann",
          },
        });
      }
      return new Response('<div class="alert">Aucun résultat trouvé</div>', {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };

    const outcome = await searchPlacePublic(
      "Travaux d'extension du groupe scolaire Erckmann Chatrian à S",
      fetchStub,
    );

    expect(outcome).toEqual({ type: "not_found", portal: "place" });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(
      "https://www.marches-publics.gouv.fr/espace-entreprise/search",
    );
    expect(new URLSearchParams(requests[0]?.body).get("keyWord")).toBe(
      "Erckmann",
    );
    expect(requests[1]?.url).toBe(
      "https://www.marches-publics.gouv.fr/?page=Entreprise.EntrepriseAdvancedSearch&searchAnnCons&keyWord=Erckmann",
    );
  });

  it("rejects a PLACE redirect to an unallowlisted host", async () => {
    const fetchStub: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid/results" },
      });

    await expect(
      searchPlacePublic(
        "Travaux d'extension du groupe scolaire Erckmann Chatrian à S",
        fetchStub,
      ),
    ).rejects.toThrow("PORTAL_SEARCH_REDIRECT_BLOCKED");
  });

  it("expands PLACE to twenty results in the same ephemeral session", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchStub: typeof fetch = async (input, init) => {
      requests.push({ url: input.toString(), ...(init ? { init } : {}) });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "/?page=Entreprise.EntrepriseAdvancedSearch&searchAnnCons&keyWord=REGLEMENTAIRES",
            "set-cookie": "PLACESESSION=fixture; Secure; HttpOnly",
          },
        });
      }
      if (requests.length === 2) {
        return new Response(
          `<form id="ctl0_ctl1" action="/?page=Entreprise.EntrepriseAdvancedSearch">
             <input id="PRADO_PAGESTATE" value="fixture-state">
             <span id="ctl0_CONTENU_PAGE_resultSearch_nombreElement">15</span>
           </form>`,
          {
            status: 200,
            headers: { "content-type": "text/html" },
          },
        );
      }
      return new Response(
        `<div class="item_consultation">
           <div class="objet-line"><div class="small pull-left truncate">
             <span title="CONTRÔLES RÈGLEMENTAIRES DES BÂTIMENTS ET ÉQUIPEMENTS POUR LA VILLE">Contrôles</span>
           </div></div>
           <a href="https://www.marches-publics.gouv.fr/app.php/entreprise/consultation/3036454">Accéder à la consultation</a>
         </div>`,
        {
          status: 200,
          headers: { "content-type": "text/html" },
        },
      );
    };

    const outcome = await searchPlacePublic(
      "CONTRÔLES RÈGLEMENTAIRES DES BÂTIMENTS ET ÉQUIPEMENTS POUR L",
      fetchStub,
    );

    expect(outcome.type).toBe("recoverable");
    expect(requests).toHaveLength(3);
    expect(requests[1]?.init?.headers).toEqual({
      Cookie: "PLACESESSION=fixture",
    });
    const expandedBody = new URLSearchParams(
      String(requests[2]?.init?.body),
    );
    expect(expandedBody.get("PRADO_PAGESTATE")).toBe("fixture-state");
    expect(
      expandedBody.get("ctl0$CONTENU_PAGE$resultSearch$listePageSizeTop"),
    ).toBe("20");
  });
});
