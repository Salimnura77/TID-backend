ALTER TABLE public.verification_attempts ADD CONSTRAINT verification_verified_reference UNIQUE (id, account_id, outcome);

-- Public verification keys only; private material stays in KMS/HSM (future
-- production) or ignored dedicated Test key files (Test configuration only).
CREATE TABLE public.credential_signing_keys (
  id varchar(128) PRIMARY KEY CHECK (id ~ '^test-[a-f0-9-]{36}$'),
  algorithm text NOT NULL CHECK (algorithm = 'RS256'),
  environment text NOT NULL DEFAULT 'test' CHECK (environment = 'test'),
  public_key jsonb NOT NULL CHECK (
    jsonb_typeof(public_key) = 'object' AND (public_key->>'kty') IS NOT DISTINCT FROM 'RSA' AND
    public_key->>'n' IS NOT NULL AND public_key->>'e' IS NOT NULL AND
    NOT public_key ?| ARRAY['d','p','q','dp','dq','qi','k'] AND octet_length(public_key::text) < 8192
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION public.immutable_credential_public_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Credential key versions are immutable'; END;
$$;
CREATE TRIGGER credential_key_immutable BEFORE UPDATE ON public.credential_signing_keys
FOR EACH ROW EXECUTE FUNCTION public.immutable_credential_public_key();

CREATE TABLE public.credentials (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  verification_id uuid NOT NULL UNIQUE,
  verification_outcome text NOT NULL DEFAULT 'verified' CHECK (verification_outcome = 'verified'),
  signing_key_id varchar(128) NOT NULL REFERENCES public.credential_signing_keys(id),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked','superseded')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (id, account_id),
  FOREIGN KEY (verification_id, account_id, verification_outcome)
    REFERENCES public.verification_attempts(id, account_id, outcome),
  CHECK (substring(id::text FROM 15 FOR 1) = '4' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + INTERVAL '5 minutes'),
  CHECK (issued_at = date_trunc('second', issued_at) AND expires_at = date_trunc('second', expires_at)),
  CHECK ((state = 'active' AND revoked_at IS NULL) OR (state IN ('revoked','superseded') AND revoked_at IS NOT NULL AND revoked_at >= issued_at))
);
CREATE UNIQUE INDEX credential_one_active_per_account ON public.credentials (account_id) WHERE state = 'active';
CREATE INDEX credential_account_history ON public.credentials (account_id, issued_at DESC);
CREATE FUNCTION public.enforce_credential_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' THEN RAISE EXCEPTION 'Invalid initial credential state'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'active' OR NEW.state NOT IN ('revoked','superseded') OR
     (NEW.id, NEW.account_id, NEW.verification_id, NEW.verification_outcome, NEW.signing_key_id, NEW.issued_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.account_id, OLD.verification_id, OLD.verification_outcome, OLD.signing_key_id, OLD.issued_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'Invalid credential transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER credential_transition BEFORE INSERT OR UPDATE ON public.credentials
FOR EACH ROW EXECUTE FUNCTION public.enforce_credential_transition();

CREATE TABLE public.credential_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('credential_issued','credential_revoked','credential_superseded')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (credential_id, account_id) REFERENCES public.credentials(id, account_id) ON DELETE CASCADE,
  UNIQUE (credential_id, event)
);
CREATE INDEX credential_audit_account_history ON public.credential_audit_events (account_id, occurred_at DESC);
