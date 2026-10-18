-- Only provider outcome metadata; no identity inputs, hashes, tokens or responses.
CREATE TABLE public.verification_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  submission_key uuid NOT NULL,
  provider text NOT NULL DEFAULT 'qoreid' CHECK (provider = 'qoreid'),
  route text NOT NULL DEFAULT 'nin' CHECK (route = 'nin'),
  environment text NOT NULL DEFAULT 'sandbox' CHECK (environment = 'sandbox'),
  outcome text NOT NULL DEFAULT 'in_progress',
  reason text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL DEFAULT clock_timestamp() + INTERVAL '30 seconds',
  completed_at timestamptz,
  UNIQUE (account_id, submission_key),
  UNIQUE (id, account_id),
  CHECK (substring(id::text FROM 15 FOR 1) = '4' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')),
  CHECK (substring(submission_key::text FROM 15 FOR 1) = '4' AND substring(submission_key::text FROM 20 FOR 1) IN ('8','9','a','b')),
  CHECK (deadline_at > started_at),
  CHECK (
    (outcome = 'in_progress' AND reason IS NULL AND completed_at IS NULL) OR
    (reason IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= started_at AND (
      (outcome = 'verified' AND reason = 'exact_match') OR
      (outcome = 'needs_review' AND reason IN ('partial_match','transposed_match','provider_pending')) OR
      (outcome = 'unable_to_verify' AND reason IN ('no_match','identity_mismatch','provider_unverified')) OR
      (outcome = 'timeout' AND reason IN ('provider_timeout','submission_timeout')) OR
      (outcome = 'provider_unavailable' AND reason IN ('provider_unavailable','provider_access_denied','provider_rate_limited','invalid_response'))
    ))
  )
);
CREATE UNIQUE INDEX verification_one_active_per_account ON public.verification_attempts (account_id) WHERE outcome = 'in_progress';
CREATE INDEX verification_account_history ON public.verification_attempts (account_id, started_at DESC);

CREATE FUNCTION public.enforce_verification_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.outcome <> 'in_progress' THEN RAISE EXCEPTION 'Invalid initial verification state'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.outcome <> 'in_progress' OR NEW.outcome = 'in_progress' OR
     (NEW.id, NEW.account_id, NEW.submission_key, NEW.provider, NEW.route, NEW.environment, NEW.started_at, NEW.deadline_at)
     IS DISTINCT FROM
     (OLD.id, OLD.account_id, OLD.submission_key, OLD.provider, OLD.route, OLD.environment, OLD.started_at, OLD.deadline_at) THEN
    RAISE EXCEPTION 'Invalid verification transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER verification_transition BEFORE INSERT OR UPDATE ON public.verification_attempts
FOR EACH ROW EXECUTE FUNCTION public.enforce_verification_transition();

-- This slice appends only coded verification lifecycle events. No arbitrary payload.
CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  verification_id uuid NOT NULL,
  event text NOT NULL,
  outcome text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (verification_id, account_id) REFERENCES public.verification_attempts(id, account_id) ON DELETE CASCADE,
  UNIQUE (verification_id, event),
  CHECK (
    (event = 'verification_submitted' AND outcome = 'in_progress') OR
    (event = 'verification_completed' AND outcome IN ('verified','needs_review','unable_to_verify','timeout','provider_unavailable'))
  )
);
CREATE INDEX audit_account_history ON public.audit_events (account_id, occurred_at DESC);
