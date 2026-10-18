CREATE TABLE public.partner_clients (
  id uuid PRIMARY KEY CHECK (id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
  key_digest text NOT NULL UNIQUE CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_at timestamptz,
  CHECK ((status = 'active' AND disabled_at IS NULL) OR (status = 'disabled' AND disabled_at IS NOT NULL AND disabled_at >= created_at))
);
CREATE FUNCTION public.guard_partner_client() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.name <> OLD.name OR NEW.key_digest <> OLD.key_digest OR NEW.created_at <> OLD.created_at
    OR OLD.status <> 'active' OR NEW.status <> 'disabled' THEN
    RAISE EXCEPTION 'Invalid partner transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_client_transition BEFORE UPDATE ON public.partner_clients FOR EACH ROW EXECUTE FUNCTION public.guard_partner_client();

CREATE TABLE public.partner_pairwise_ids (
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  partner_id uuid NOT NULL REFERENCES public.partner_clients(id),
  identifier uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE CHECK (identifier <> account_id AND identifier::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, partner_id)
);
CREATE FUNCTION public.guard_consent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Immutable consent metadata';
END $$;
CREATE TRIGGER pairwise_immutable BEFORE UPDATE OR DELETE ON public.partner_pairwise_ids FOR EACH ROW EXECUTE FUNCTION public.guard_consent_immutable();

CREATE TABLE public.consent_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  partner_id uuid NOT NULL REFERENCES public.partner_clients(id),
  credential_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '5 minutes'),
  consumed_at timestamptz CHECK (consumed_at >= created_at AND consumed_at < expires_at),
  FOREIGN KEY (credential_id, account_id) REFERENCES public.credentials(id, account_id),
  UNIQUE (id, account_id, partner_id, credential_id)
);
CREATE INDEX consent_invitations_account ON public.consent_invitations(account_id, created_at DESC);
CREATE FUNCTION public.guard_consent_invitation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.token_digest, NEW.account_id, NEW.partner_id, NEW.credential_id, NEW.created_at, NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.token_digest, OLD.account_id, OLD.partner_id, OLD.credential_id, OLD.created_at, OLD.expires_at)
    OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'Invalid invitation transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_invitation_transition BEFORE UPDATE ON public.consent_invitations FOR EACH ROW EXECUTE FUNCTION public.guard_consent_invitation();

-- The three canonical nonempty sets available from the minimal credential boundary.
CREATE FUNCTION public.valid_consent_attributes(fields text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT fields IS NOT NULL AND fields IN (ARRAY['verification_result'], ARRAY['verification_expires_at'], ARRAY['verification_expires_at', 'verification_result']);
$$;
CREATE TABLE public.consent_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  partner_id uuid NOT NULL REFERENCES public.partner_clients(id),
  credential_id uuid NOT NULL,
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 200 AND purpose = btrim(purpose) AND purpose !~ '[[:cntrl:]]'),
  requested_attributes text[] NOT NULL CHECK (public.valid_consent_attributes(requested_attributes)),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '5 minutes'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'declined', 'revoked')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  approved_attributes text[],
  approved_expires_at timestamptz,
  decided_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (invitation_id, account_id, partner_id, credential_id) REFERENCES public.consent_invitations(id, account_id, partner_id, credential_id),
  FOREIGN KEY (credential_id, account_id) REFERENCES public.credentials(id, account_id),
  UNIQUE (id, account_id, partner_id),
  CHECK (
    (state = 'pending' AND revision = 0 AND approved_attributes IS NULL AND approved_expires_at IS NULL AND decided_at IS NULL AND revoked_at IS NULL)
    OR (state = 'declined' AND revision = 1 AND approved_attributes IS NULL AND approved_expires_at IS NULL AND decided_at IS NOT NULL AND decided_at >= created_at AND revoked_at IS NULL)
    OR (state IN ('approved', 'revoked') AND revision >= 1 AND public.valid_consent_attributes(approved_attributes)
      AND approved_attributes <@ requested_attributes AND approved_expires_at IS NOT NULL AND decided_at IS NOT NULL AND approved_expires_at > decided_at AND approved_expires_at <= expires_at
      AND decided_at >= created_at AND ((state = 'approved' AND revoked_at IS NULL) OR (state = 'revoked' AND revision >= 2 AND revoked_at IS NOT NULL AND revoked_at >= decided_at)))
  )
);
CREATE INDEX consent_requests_account_history ON public.consent_requests(account_id, created_at DESC, id DESC);
CREATE INDEX consent_requests_partner_history ON public.consent_requests(partner_id, created_at DESC, id DESC);
CREATE FUNCTION public.guard_consent_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invitation_expiry timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT expires_at INTO invitation_expiry FROM public.consent_invitations WHERE id = NEW.invitation_id AND consumed_at IS NOT NULL;
    IF NEW.state <> 'pending' OR NEW.revision <> 0 OR invitation_expiry IS NULL OR NEW.expires_at > invitation_expiry THEN
      RAISE EXCEPTION 'Invalid initial request';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.invitation_id, NEW.account_id, NEW.partner_id, NEW.credential_id, NEW.purpose, NEW.requested_attributes, NEW.created_at, NEW.expires_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.invitation_id, OLD.account_id, OLD.partner_id, OLD.credential_id, OLD.purpose, OLD.requested_attributes, OLD.created_at, OLD.expires_at)
      OR OLD.state IN ('declined', 'revoked') OR NEW.revision <> OLD.revision + 1
      OR (OLD.state = 'pending' AND NEW.state NOT IN ('approved', 'declined'))
      OR (OLD.state = 'approved' AND NEW.state NOT IN ('approved', 'revoked')) THEN
      RAISE EXCEPTION 'Invalid consent transition';
    END IF;
    IF NEW.state = 'revoked' THEN
      IF ROW(NEW.approved_attributes, NEW.approved_expires_at, NEW.decided_at) IS DISTINCT FROM ROW(OLD.approved_attributes, OLD.approved_expires_at, OLD.decided_at) THEN
        RAISE EXCEPTION 'Revocation must retain its binding';
      END IF;
    ELSIF OLD.expires_at <= clock_timestamp() OR OLD.approved_expires_at <= clock_timestamp()
      OR NEW.decided_at < OLD.decided_at THEN
      RAISE EXCEPTION 'Expired consent is terminal';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_request_transition BEFORE INSERT OR UPDATE ON public.consent_requests FOR EACH ROW EXECUTE FUNCTION public.guard_consent_request();

CREATE TABLE public.consent_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  request_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('request_created', 'consent_approved', 'consent_declined', 'consent_revoked', 'attributes_disclosed')),
  revision integer NOT NULL CHECK (revision >= 0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (request_id, account_id, partner_id) REFERENCES public.consent_requests(id, account_id, partner_id)
);
CREATE INDEX consent_audit_account_history ON public.consent_audit_events(account_id, occurred_at DESC);
CREATE UNIQUE INDEX consent_audit_transition_once ON public.consent_audit_events(request_id, revision) WHERE event <> 'attributes_disclosed';
CREATE TRIGGER consent_audit_immutable BEFORE UPDATE OR DELETE ON public.consent_audit_events FOR EACH ROW EXECUTE FUNCTION public.guard_consent_immutable();
