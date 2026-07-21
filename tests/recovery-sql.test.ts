import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../sql/20260721130000_tender_dce_recovery_attempt.sql",
  import.meta.url,
);

const NO_DOC = "11111111-1111-4111-8111-111111111111";
const WITH_DOC = "22222222-2222-4222-8222-222222222222";
const RETRYING = "33333333-3333-4333-8333-333333333333";
const SOFT_DELETED_DOC = "44444444-4444-4444-8444-444444444444";
const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SYSTEM_ACTOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function bootstrap(database: PGlite): Promise<void> {
  await database.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE TYPE public.type_document AS ENUM (
      'specifications', 'rules', 'appendix', 'response', 'other'
    );
    CREATE TYPE public.nukema_queue_status AS ENUM (
      'pending', 'processing', 'done', 'failed'
    );
    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY,
      name text NOT NULL
    );
    CREATE TABLE public.tender (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL,
      title text NOT NULL,
      buyer_name text NOT NULL DEFAULT '',
      buyer_profile_link text,
      reference_number text,
      reference_boamp text,
      external_id text,
      deleted_at timestamptz,
      status text NOT NULL,
      record_type text NOT NULL DEFAULT 'standalone',
      parent_tender_id uuid,
      lot_title text,
      dce_analyzed_at timestamptz,
      analysis_state text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.tender_document (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tender_id uuid NOT NULL REFERENCES public.tender(id),
      added_by uuid NOT NULL,
      document_type public.type_document NOT NULL,
      file_name text NOT NULL,
      url text NOT NULL,
      extraction_status text,
      source_url text,
      source_reference text,
      parent_document_id uuid,
      deleted_at timestamptz
    );
    CREATE TABLE public.dce_analysis_queue (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tender_id uuid NOT NULL REFERENCES public.tender(id),
      status public.nukema_queue_status NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE OR REPLACE FUNCTION public.queue_tender_analysis_target(
      _analysis_tender_id uuid,
      _force boolean,
      _new_document_count integer
    ) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE v_id uuid;
    BEGIN
      SELECT id INTO v_id FROM public.dce_analysis_queue
      WHERE tender_id = _analysis_tender_id
        AND status IN ('pending', 'processing')
      LIMIT 1;
      IF v_id IS NULL AND (_force OR _new_document_count > 0) THEN
        INSERT INTO public.dce_analysis_queue (tender_id, status)
        VALUES (_analysis_tender_id, 'pending') RETURNING id INTO v_id;
      END IF;
      RETURN jsonb_build_object(
        'status', CASE WHEN v_id IS NULL THEN 'skipped' ELSE 'queued' END,
        'queue_id', v_id
      );
    END;
    $$;
    INSERT INTO public.profiles (id, name)
    VALUES ('${SYSTEM_ACTOR}', 'Système Ingestion Nukema');
  `);
  const migration = await readFile(migrationUrl, "utf8");
  await database.exec(migration);
  await database.exec(migration);
}

describe("tender DCE recovery SQL", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite();
    await bootstrap(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it("selects only active opportunities without documents whose retry is due", async () => {
    await database.exec(`
      INSERT INTO public.tender (
        id, company_id, title, buyer_name, buyer_profile_link, status
      ) VALUES
        ('${NO_DOC}', '${COMPANY}', 'Sans document', 'Ville A', 'https://example.test/a', 'opportunity'),
        ('${WITH_DOC}', '${COMPANY}', 'Avec document', 'Ville B', 'https://example.test/b', 'opportunity'),
        ('${RETRYING}', '${COMPANY}', 'Retry futur', 'Ville C', 'https://example.test/c', 'opportunity'),
        ('${SOFT_DELETED_DOC}', '${COMPANY}', 'Document supprimé', 'Ville D', 'https://example.test/d', 'opportunity');
      INSERT INTO public.tender_document (
        tender_id, added_by, document_type, file_name, url, deleted_at
      ) VALUES
        ('${WITH_DOC}', '${SYSTEM_ACTOR}', 'other', 'active.pdf', '${COMPANY}/${WITH_DOC}/active.pdf', NULL),
        ('${SOFT_DELETED_DOC}', '${SYSTEM_ACTOR}', 'other', 'deleted.pdf', '${COMPANY}/${SOFT_DELETED_DOC}/deleted.pdf', '2026-07-20T00:00:00Z');
      INSERT INTO public.tender_dce_recovery_attempt (
        tender_id, attempt_number, decision, status, evidence,
        attempt_at, attempt_day, next_retry_at, completed_at
      ) VALUES (
        '${RETRYING}', 1, 'low', 'not_found', '{}'::jsonb,
        '2026-07-21T05:00:00Z', '2026-07-21', '2026-07-22T05:00:00Z', '2026-07-21T05:00:01Z'
      );
    `);

    const result = await database.query<{ tender_id: string }>(`
      SELECT tender_id FROM public.list_tender_dce_recovery_candidates(
        25, '2026-07-21T06:00:00Z'
      ) ORDER BY tender_id
    `);

    expect(result.rows.map(({ tender_id }) => tender_id)).toEqual([
      NO_DOC,
      SOFT_DELETED_DOC,
    ]);
  });

  it("enforces one attempt per Paris day and the 24h then 72h backoff", async () => {
    await database.exec(`
      INSERT INTO public.tender (
        id, company_id, title, buyer_name, buyer_profile_link, status
      ) VALUES (
        '${NO_DOC}', '${COMPANY}', 'Sans document', 'Ville A',
        'https://example.test/a', 'opportunity'
      );
    `);

    const first = await database.query<{ attempt_id: string }>(`
      SELECT * FROM public.reserve_tender_dce_recovery_attempt(
        '${NO_DOC}', '2026-07-21T05:15:00Z'
      )
    `);
    expect(first.rows).toHaveLength(1);
    const duplicate = await database.query(`
      SELECT * FROM public.reserve_tender_dce_recovery_attempt(
        '${NO_DOC}', '2026-07-21T10:00:00Z'
      )
    `);
    expect(duplicate.rows).toHaveLength(0);

    await database.query(
      `SELECT public.finalize_tender_dce_recovery_attempt($1, 'not_found', NULL, 'low', '{}'::jsonb)`,
      [first.rows[0]!.attempt_id],
    );
    const retryOne = await database.query<{ hours: number }>(`
      SELECT extract(epoch FROM (next_retry_at - attempt_at)) / 3600 AS hours
      FROM public.tender_dce_recovery_attempt WHERE attempt_number = 1
    `);
    expect(Number(retryOne.rows[0]!.hours)).toBe(24);

    const second = await database.query<{ attempt_id: string }>(`
      SELECT * FROM public.reserve_tender_dce_recovery_attempt(
        '${NO_DOC}', '2026-07-22T06:16:00Z'
      )
    `);
    expect(second.rows).toHaveLength(1);
    const retryTwo = await database.query<{ hours: number }>(`
      SELECT extract(epoch FROM (next_retry_at - attempt_at)) / 3600 AS hours
      FROM public.tender_dce_recovery_attempt WHERE attempt_number = 2
    `);
    expect(Number(retryTwo.rows[0]!.hours)).toBe(72);
  });

  it("replays a crashed in-flight attempt only after its backoff", async () => {
    await database.exec(`
      INSERT INTO public.tender (
        id, company_id, title, buyer_name, buyer_profile_link, status
      ) VALUES (
        '${NO_DOC}', '${COMPANY}', 'Crash replay', 'Ville A',
        'https://example.test/a', 'opportunity'
      );
    `);
    await database.query(`
      SELECT * FROM public.reserve_tender_dce_recovery_attempt(
        '${NO_DOC}', '2026-07-21T05:15:00Z'
      )
    `);

    const tooEarly = await database.query(`
      SELECT * FROM public.reserve_tender_dce_recovery_attempt(
        '${NO_DOC}', '2026-07-22T05:14:59Z'
      )
    `);
    expect(tooEarly.rows).toHaveLength(0);

    const replay = await database.query<{ attempt_number: number }>(`
      SELECT * FROM public.reserve_tender_dce_recovery_attempt(
        '${NO_DOC}', '2026-07-22T05:15:01Z'
      )
    `);
    expect(replay.rows[0]!.attempt_number).toBe(2);
    const attempts = await database.query<{ status: string | null }>(`
      SELECT status FROM public.tender_dce_recovery_attempt
      WHERE tender_id = '${NO_DOC}' ORDER BY attempt_number
    `);
    expect(attempts.rows.map(({ status }) => status)).toEqual(["error", null]);
  });

  it("persists the same manifest twice as one document and one queue row", async () => {
    await database.exec(`
      INSERT INTO public.tender (
        id, company_id, title, buyer_name, buyer_profile_link, status
      ) VALUES (
        '${NO_DOC}', '${COMPANY}', 'Sans document', 'Ville A',
        'https://example.test/a', 'opportunity'
      );
    `);
    const reserved = await database.query<{ attempt_id: string }>(`
      SELECT * FROM public.reserve_tender_dce_recovery_attempt(
        '${NO_DOC}', '2026-07-21T05:15:00Z'
      )
    `);
    const attemptId = reserved.rows[0]!.attempt_id;
    const documents = JSON.stringify([
      {
        file_name: "DCE.zip",
        object_path: `${COMPANY}/${NO_DOC}/DCE.zip`,
        source_url: "https://www.marches-publics.gouv.fr/consultation/42",
        source_reference: "place:42:piece-42",
        bytes: 12,
        sha256: "a".repeat(64),
      },
    ]).replaceAll("'", "''");

    await database.query(
      `SELECT public.persist_tender_dce_recovery_manifest($1, $2, 'place', 'exact', '{}'::jsonb, $3::jsonb)`,
      [attemptId, NO_DOC, documents],
    );
    await database.query(
      `SELECT public.persist_tender_dce_recovery_manifest($1, $2, 'place', 'exact', '{}'::jsonb, $3::jsonb)`,
      [attemptId, NO_DOC, documents],
    );

    const counts = await database.query<{
      documents: number;
      queues: number;
      found: number;
      actors: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM public.tender_document WHERE tender_id = '${NO_DOC}') AS documents,
        (SELECT count(*)::int FROM public.dce_analysis_queue WHERE tender_id = '${NO_DOC}') AS queues,
        (SELECT count(*)::int FROM public.tender_dce_recovery_attempt WHERE tender_id = '${NO_DOC}' AND status = 'found') AS found,
        (SELECT count(*)::int FROM public.tender_document WHERE tender_id = '${NO_DOC}' AND added_by = '${SYSTEM_ACTOR}') AS actors
    `);
    expect(counts.rows[0]).toEqual({
      documents: 1,
      queues: 1,
      found: 1,
      actors: 1,
    });
  });

  it("rejects apply readiness when the system profile is missing or duplicated", async () => {
    await database.exec(`DELETE FROM public.profiles`);
    await expect(
      database.query(`SELECT public.assert_tender_dce_recovery_system_profile()`),
    ).rejects.toThrow(/recovery_system_profile_not_unique/);

    await database.exec(`
      INSERT INTO public.profiles (id, name) VALUES
        ('${SYSTEM_ACTOR}', 'Système Ingestion Nukema'),
        ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Système Ingestion Nukema')
    `);
    await expect(
      database.query(`SELECT public.assert_tender_dce_recovery_system_profile()`),
    ).rejects.toThrow(/recovery_system_profile_not_unique/);
  });
});
