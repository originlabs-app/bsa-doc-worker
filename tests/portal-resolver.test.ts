import { describe, expect, it } from "vitest";

import {
  buildDistinctiveQuery,
  parseAwPublicSearch,
  parsePlacePublicSearch,
  resolveExactPortalConsultation,
  searchAwPublic,
  searchPlacePublic,
  searchPortalPublicCandidates,
} from "../src/portal-resolver.js";

describe("resolveExactPortalConsultation", () => {
  const candidates = [
    {
      canonicalTitle: "Maintenance des installations thermiques des collèges",
      reference: "MAX-2026-014",
      buyerName: "Région Île-de-France",
      consultationUrl:
        "https://marches.maximilien.fr/entreprise/consultation/7788",
    },
    {
      canonicalTitle: "Maintenance des ascenseurs des collèges",
      reference: "MAX-2026-015",
      buyerName: "Région Île-de-France",
      consultationUrl:
        "https://marches.maximilien.fr/entreprise/consultation/7789",
    },
  ];

  it("prefers an exact normalized reference", () => {
    expect(
      resolveExactPortalConsultation(
        candidates,
        { reference: "max-2026-014" },
        "marches.maximilien.fr",
      ),
    ).toBe(
      "https://marches.maximilien.fr/entreprise/consultation/7788",
    );
  });

  it("accepts one strict title-prefix and buyer match", () => {
    expect(
      resolveExactPortalConsultation(
        candidates,
        {
          title: "Maintenance des installations thermiques des coll",
          buyerName: "Region Ile de France",
        },
        "marches.maximilien.fr",
      ),
    ).toBe(
      "https://marches.maximilien.fr/entreprise/consultation/7788",
    );
  });

  it("rejects candidates outside the allowlisted portal host", () => {
    expect(() =>
      resolveExactPortalConsultation(
        [
          {
            ...candidates[0]!,
            consultationUrl: "https://attacker.invalid/consultation/7788",
          },
        ],
        { reference: "MAX-2026-014" },
        "marches.maximilien.fr",
      ),
    ).toThrow("PORTAL_CONSULTATION_NOT_RESOLVED");
  });
});

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

  it("keeps named places distinctive in full sweep titles", () => {
    expect(
      buildDistinctiveQuery(
        "Travaux de rénovation patrimoniale du Bastion XV, Rue du Rempart à Strasbourg",
      ),
    ).toBe("Bastion");
    expect(
      buildDistinctiveQuery(
        "Construction du nouveau Centre de Secours Principal de Béziers",
      ),
    ).toBe("Béziers");
    expect(buildDistinctiveQuery("Construction du musée de Saint-Gilles")).toBe(
      "Saint-Gilles",
    );
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

  it("uses the real public PLACE GET search with the distinctive term", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetchStub: typeof fetch = async (input, init) => {
      requests.push({
        url: input.toString(),
        method: init?.method ?? "GET",
      });
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
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://www.marches-publics.gouv.fr/?page=Entreprise.EntrepriseAdvancedSearch&searchAnnCons=&keyWord=Erckmann",
    );
    expect(requests[0]?.method).toBe("GET");
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

  it("follows only a same-origin PLACE redirect", async () => {
    const requests: string[] = [];
    const fetchStub: typeof fetch = async (input) => {
      requests.push(input.toString());
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "/?page=Entreprise.EntrepriseAdvancedSearch&searchAnnCons=&keyWord=Erckmann",
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
  });

  it("caps one portal search at four queries", async () => {
    const requests: string[] = [];
    const fetchStub: typeof fetch = async (input) => {
      requests.push(input.toString());
      return new Response('<div class="alert">Aucun résultat trouvé</div>', {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };

    const result = await searchPortalPublicCandidates(
      "maximilien",
      ["un", "deux", "trois", "quatre", "cinq"],
      fetchStub,
    );

    expect(requests).toHaveLength(4);
    expect(result.requestCount).toBe(4);
  });

  it("stops a redirect loop after eight requests", async () => {
    let requests = 0;
    const fetchStub: typeof fetch = async () => {
      requests += 1;
      return new Response(null, {
        status: 302,
        headers: {
          location:
            "/?page=Entreprise.EntrepriseAdvancedSearch&searchAnnCons=&keyWord=loop",
        },
      });
    };

    await expect(
      searchPortalPublicCandidates("place", ["loop"], fetchStub),
    ).rejects.toThrow("PORTAL_SEARCH_REQUEST_LIMIT");
    expect(requests).toBe(8);
  });

  it("rejects a search response larger than five MiB", async () => {
    const fetchStub: typeof fetch = async () =>
      new Response(new Uint8Array(5 * 1024 * 1024 + 1), {
        status: 200,
        headers: { "content-type": "text/html" },
      });

    await expect(
      searchPlacePublic(
        "Travaux d'extension du groupe scolaire Erckmann Chatrian à S",
        fetchStub,
      ),
    ).rejects.toThrow("PORTAL_SEARCH_RESPONSE_TOO_LARGE");
  });
});
