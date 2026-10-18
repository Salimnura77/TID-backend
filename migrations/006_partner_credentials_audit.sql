-- Preserve existing pilot clients and key bytes while separating credential lifecycle
-- from partner identity. Existing pairwise IDs, requests and grants are unchanged.
CREATE FUNCTION public.valid_partner_permissions(fields text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT fields IS NOT NULL AND cardinality(fields) BETWEEN 1 AND 3 AND array_ndims(fields) = 1
    AND array_position(fields, NULL) IS NULL
    AND fields <@ ARRAY['disclosures:create', 'requests:create', 'requests:read']
    AND fields = ARRAY(SELECT DISTINCT unnest(fields) ORDER BY 1);
$$;
CREATE TABLE public.partner_api_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() CHECK (id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  partner_id uuid NOT NULL REFERENCES public.partner_clients(id),
  key_digest text NOT NULL UNIQUE CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  permissions text[] NOT NULL CHECK (public.valid_partner_permissions(permissions)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz CHECK (revoked_at >= created_at),
  UNIQUE (id, partner_id)
);
CREATE UNIQUE INDEX partner_one_active_credential ON public.partner_api_credentials(partner_id) WHERE revoked_at IS NULL;
CREATE INDEX partner_credentials_history ON public.partner_api_credentials(partner_id, created_at DESC);
INSERT INTO public.partner_api_credentials (partner_id, key_digest, permissions, created_at, revoked_at)
  SELECT id, key_digest, ARRAY['disclosures:create', 'requests:create', 'requests:read'], created_at, disabled_at
  FROM public.partner_clients;

CREATE FUNCTION public.guard_partner_api_credential() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Immutable partner credential'; END IF;
  IF ROW(NEW.id, NEW.partner_id, NEW.key_digest, NEW.permissions, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.partner_id, OLD.key_digest, OLD.permissions, OLD.created_at)
    OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'Invalid partner credential transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_credential_transition BEFORE UPDATE OR DELETE ON public.partner_api_credentials FOR EACH ROW EXECUTE FUNCTION public.guard_partner_api_credential();

DROP TRIGGER partner_client_transition ON public.partner_clients;
ALTER TABLE public.partner_clients DROP COLUMN key_digest;
CREATE OR REPLACE FUNCTION public.guard_partner_client() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.name <> OLD.name OR NEW.created_at <> OLD.created_at
    OR OLD.status <> 'active' OR NEW.status <> 'disabled' THEN
    RAISE EXCEPTION 'Invalid partner transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_client_transition BEFORE UPDATE ON public.partner_clients FOR EACH ROW EXECUTE FUNCTION public.guard_partner_client();

CREATE TABLE public.partner_credential_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL,
  credential_id uuid NOT NULL,
  previous_credential_id uuid,
  event text NOT NULL CHECK (event IN ('credential_created', 'credential_rotated', 'credential_revoked', 'credential_migrated')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (credential_id, partner_id) REFERENCES public.partner_api_credentials(id, partner_id),
  FOREIGN KEY (previous_credential_id, partner_id) REFERENCES public.partner_api_credentials(id, partner_id),
  CHECK ((event = 'credential_rotated' AND previous_credential_id IS NOT NULL AND previous_credential_id <> credential_id)
    OR (event <> 'credential_rotated' AND previous_credential_id IS NULL)),
  UNIQUE (credential_id, event)
);
CREATE INDEX partner_credential_audit_history ON public.partner_credential_audit_events(partner_id, occurred_at DESC);
-- This records migration observation, not an invented historical creation action.
INSERT INTO public.partner_credential_audit_events (partner_id, credential_id, event)
  SELECT partner_id, id, 'credential_migrated' FROM public.partner_api_credentials;
CREATE TRIGGER partner_credential_audit_immutable BEFORE UPDATE OR DELETE ON public.partner_credential_audit_events FOR EACH ROW EXECUTE FUNCTION public.guard_consent_immutable();

-- Historical consent events retain NULL: their authenticating key was not recorded.
-- New partner actions must name a credential belonging to that exact partner.
ALTER TABLE public.consent_audit_events ADD COLUMN partner_credential_id uuid;
ALTER TABLE public.consent_audit_events ADD CONSTRAINT consent_audit_partner_credential
  FOREIGN KEY (partner_credential_id, partner_id) REFERENCES public.partner_api_credentials(id, partner_id);
CREATE FUNCTION public.guard_consent_audit_actor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.event IN ('request_created', 'attributes_disclosed')) <> (NEW.partner_credential_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid consent audit actor';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_audit_actor BEFORE INSERT ON public.consent_audit_events FOR EACH ROW EXECUTE FUNCTION public.guard_consent_audit_actor();
CREATE INDEX consent_audit_request_history ON public.consent_audit_events(account_id, request_id, occurred_at DESC, id DESC);
