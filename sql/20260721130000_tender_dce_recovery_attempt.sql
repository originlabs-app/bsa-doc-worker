BEGIN;

CREATE TABLE IF NOT EXISTS public.tender_dce_recovery_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES public.tender(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL,
  portal text,
  decision text NOT NULL,
  status text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_at timestamptz NOT NULL DEFAULT now(),
  attempt_day date NOT NULL,
  next_retry_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT tender_dce_recovery_attempt_number_positive
    CHECK (attempt_number > 0),
  CONSTRAINT tender_dce_recovery_attempt_portal_check
    CHECK (portal IS NULL OR portal IN ('aw_solutions', 'place', 'maximilien')),
  CONSTRAINT tender_dce_recovery_attempt_decision_check
    CHECK (decision IN ('in_flight', 'exact', 'strong', 'medium', 'low', 'blocked', 'error')),
  CONSTRAINT tender_dce_recovery_attempt_status_check
    CHECK (
      status IS NULL OR status IN (
        'found', 'not_found', 'ambiguous', 'blocked', 'too_large', 'error'
      )
    ),
  CONSTRAINT tender_dce_recovery_attempt_completion_check
    CHECK (
      (status IS NULL AND completed_at IS NULL)
      OR (status IS NOT NULL AND completed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tender_dce_recovery_attempt_day
  ON public.tender_dce_recovery_attempt (tender_id, attempt_day);

CREATE INDEX IF NOT EXISTS idx_tender_dce_recovery_retry
  ON public.tender_dce_recovery_attempt (next_retry_at, tender_id)
  WHERE next_retry_at IS NOT NULL;

ALTER TABLE public.tender_dce_recovery_attempt ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.tender_dce_recovery_attempt IS
  'Worker-owned audit and backoff registry for autonomous buyer-profile DCE recovery.';
COMMENT ON COLUMN public.tender_dce_recovery_attempt.evidence IS
  'Safe portal evidence only. Signed URLs, cookies, CAPTCHA answers and credentials are forbidden.';

CREATE OR REPLACE FUNCTION public.list_tender_dce_recovery_candidates(
  p_limit integer DEFAULT 25,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  tender_id uuid,
  company_id uuid,
  title text,
  buyer_name text,
  reference text,
  buyer_profile_link text,
  lot_titles text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT
    target.id,
    target.company_id,
    target.title,
    coalesce(target.buyer_name, ''),
    coalesce(
      nullif(target.reference_number, ''),
      nullif(target.reference_boamp, ''),
      nullif(target.external_id, ''),
      ''
    ),
    target.buyer_profile_link,
    coalesce(
      ARRAY(
        SELECT coalesce(nullif(child.lot_title, ''), child.title)
        FROM public.tender AS child
        WHERE child.parent_tender_id = target.id
          AND child.deleted_at IS NULL
        ORDER BY child.id
      ),
      ARRAY[]::text[]
    )
  FROM public.tender AS target
  WHERE target.deleted_at IS NULL
    AND target.status::text = 'opportunity'
    AND coalesce(target.record_type, 'standalone') <> 'lot'
    AND nullif(btrim(target.buyer_profile_link), '') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.tender_document AS document
      LEFT JOIN public.tender AS document_tender
        ON document_tender.id = document.tender_id
      WHERE document.deleted_at IS NULL
        AND (
          document.tender_id = target.id
          OR document_tender.parent_tender_id = target.id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.tender_dce_recovery_attempt AS attempt
      WHERE attempt.tender_id = target.id
        AND (
          attempt.attempt_day = (p_now AT TIME ZONE 'Europe/Paris')::date
          OR attempt.next_retry_at > p_now
        )
    )
  ORDER BY target.created_at NULLS LAST, target.id
  LIMIT greatest(1, least(coalesce(p_limit, 25), 100));
$$;

CREATE OR REPLACE FUNCTION public.reserve_tender_dce_recovery_attempt(
  p_tender_id uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (attempt_id uuid, attempt_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_attempt_number integer;
  v_attempt_id uuid;
  v_attempt_day date := (p_now AT TIME ZONE 'Europe/Paris')::date;
  v_backoff interval;
BEGIN
  PERFORM 1
  FROM public.tender AS target
  WHERE target.id = p_tender_id
    AND target.deleted_at IS NULL
    AND target.status::text = 'opportunity'
    AND coalesce(target.record_type, 'standalone') <> 'lot'
    AND nullif(btrim(target.buyer_profile_link), '') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.tender_document AS document
      LEFT JOIN public.tender AS document_tender
        ON document_tender.id = document.tender_id
      WHERE document.deleted_at IS NULL
        AND (
          document.tender_id = target.id
          OR document_tender.parent_tender_id = target.id
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.tender_dce_recovery_attempt AS attempt
      WHERE attempt.tender_id = target.id
        AND (
          attempt.attempt_day = v_attempt_day
          OR attempt.next_retry_at > p_now
        )
    )
  FOR UPDATE OF target;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.tender_dce_recovery_attempt
  SET status = 'error',
      decision = 'error',
      completed_at = p_now,
      evidence = evidence || jsonb_build_object('stale_in_flight', true)
  WHERE tender_id = p_tender_id
    AND status IS NULL
    AND next_retry_at <= p_now;

  SELECT count(*)::integer + 1
  INTO v_attempt_number
  FROM public.tender_dce_recovery_attempt
  WHERE tender_id = p_tender_id;

  v_backoff := CASE v_attempt_number
    WHEN 1 THEN interval '24 hours'
    WHEN 2 THEN interval '72 hours'
    ELSE interval '7 days'
  END;

  INSERT INTO public.tender_dce_recovery_attempt (
    tender_id,
    attempt_number,
    decision,
    status,
    evidence,
    attempt_at,
    attempt_day,
    next_retry_at
  ) VALUES (
    p_tender_id,
    v_attempt_number,
    'in_flight',
    NULL,
    jsonb_build_object('phase', 'selected'),
    p_now,
    v_attempt_day,
    p_now + v_backoff
  )
  ON CONFLICT (tender_id, attempt_day) DO NOTHING
  RETURNING id INTO v_attempt_id;

  IF v_attempt_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT v_attempt_id, v_attempt_number;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_tender_dce_recovery_attempt(
  p_attempt_id uuid,
  p_status text,
  p_portal text,
  p_decision text,
  p_evidence jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF p_status NOT IN ('not_found', 'ambiguous', 'blocked', 'too_large', 'error') THEN
    RAISE EXCEPTION 'invalid_recovery_status';
  END IF;
  IF p_portal IS NOT NULL AND p_portal NOT IN ('aw_solutions', 'place', 'maximilien') THEN
    RAISE EXCEPTION 'invalid_recovery_portal';
  END IF;
  IF p_decision NOT IN ('exact', 'strong', 'medium', 'low', 'blocked', 'error') THEN
    RAISE EXCEPTION 'invalid_recovery_decision';
  END IF;

  UPDATE public.tender_dce_recovery_attempt
  SET status = p_status,
      portal = p_portal,
      decision = p_decision,
      evidence = coalesce(p_evidence, '{}'::jsonb),
      completed_at = now()
  WHERE id = p_attempt_id
    AND status IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.persist_tender_dce_recovery_manifest(
  p_attempt_id uuid,
  p_tender_id uuid,
  p_portal text,
  p_decision text,
  p_evidence jsonb,
  p_documents jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_attempt public.tender_dce_recovery_attempt%ROWTYPE;
  v_inserted integer := 0;
  v_queue jsonb := '{}'::jsonb;
BEGIN
  IF p_portal NOT IN ('aw_solutions', 'place', 'maximilien') THEN
    RAISE EXCEPTION 'invalid_recovery_portal';
  END IF;
  IF p_decision NOT IN ('exact', 'strong') THEN
    RAISE EXCEPTION 'invalid_recovery_apply_decision';
  END IF;
  IF jsonb_typeof(coalesce(p_documents, '[]'::jsonb)) <> 'array'
    OR jsonb_array_length(coalesce(p_documents, '[]'::jsonb)) = 0
  THEN
    RAISE EXCEPTION 'recovery_documents_required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tender_id::text, 0));
  SELECT * INTO v_attempt
  FROM public.tender_dce_recovery_attempt
  WHERE id = p_attempt_id
    AND tender_id = p_tender_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'recovery_attempt_not_found';
  END IF;
  IF v_attempt.status = 'found' THEN
    RETURN jsonb_build_object(
      'inserted_documents', 0,
      'queue_status', 'already_found'
    );
  END IF;
  IF v_attempt.status IS NOT NULL THEN
    RAISE EXCEPTION 'recovery_attempt_already_finalized';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tender AS target
    WHERE target.id = p_tender_id
      AND target.deleted_at IS NULL
      AND target.status::text = 'opportunity'
  ) THEN
    RAISE EXCEPTION 'recovery_tender_not_eligible';
  END IF;

  INSERT INTO public.tender_document (
    tender_id,
    added_by,
    document_type,
    file_name,
    url,
    extraction_status,
    source_url,
    source_reference
  )
  SELECT
    p_tender_id,
    NULL,
    'other'::public.type_document,
    document.file_name,
    document.object_path,
    NULL,
    document.source_url,
    document.source_reference
  FROM jsonb_to_recordset(p_documents) AS document(
    file_name text,
    object_path text,
    source_url text,
    source_reference text,
    bytes bigint,
    sha256 text
  )
  WHERE nullif(btrim(document.file_name), '') IS NOT NULL
    AND nullif(btrim(document.object_path), '') IS NOT NULL
    AND nullif(btrim(document.source_url), '') IS NOT NULL
    AND nullif(btrim(document.source_reference), '') IS NOT NULL
    AND document.bytes > 0
    AND document.sha256 ~ '^[0-9a-f]{64}$'
    AND NOT EXISTS (
      SELECT 1
      FROM public.tender_document AS existing
      WHERE existing.tender_id = p_tender_id
        AND existing.parent_document_id IS NULL
        AND existing.deleted_at IS NULL
        AND existing.file_name = document.file_name
    )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  v_queue := public.queue_tender_analysis_target(
    p_tender_id,
    false,
    v_inserted
  );

  UPDATE public.tender_dce_recovery_attempt
  SET status = 'found',
      portal = p_portal,
      decision = p_decision,
      evidence = coalesce(p_evidence, '{}'::jsonb),
      completed_at = now(),
      next_retry_at = NULL
  WHERE id = p_attempt_id;

  RETURN jsonb_build_object(
    'inserted_documents', v_inserted,
    'queue_status', coalesce(v_queue->>'status', 'unknown')
  );
END;
$$;

REVOKE ALL ON TABLE public.tender_dce_recovery_attempt
  FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.tender_dce_recovery_attempt
  TO service_role;

REVOKE ALL ON FUNCTION public.list_tender_dce_recovery_candidates(integer, timestamptz)
  FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_tender_dce_recovery_attempt(uuid, timestamptz)
  FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_tender_dce_recovery_attempt(uuid, text, text, text, jsonb)
  FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_tender_dce_recovery_manifest(uuid, uuid, text, text, jsonb, jsonb)
  FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.list_tender_dce_recovery_candidates(integer, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_tender_dce_recovery_attempt(uuid, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_tender_dce_recovery_attempt(uuid, text, text, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_tender_dce_recovery_manifest(uuid, uuid, text, text, jsonb, jsonb)
  TO service_role;

COMMIT;
