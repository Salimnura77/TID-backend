-- Minimal internal accounts only: no names, contacts, identity numbers, or documents.
CREATE TABLE public.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  disabled_at timestamptz,
  CONSTRAINT accounts_random_id CHECK (
    substring(id::text FROM 15 FOR 1) = '4' AND
    substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT accounts_status_timestamp CHECK (
    (status = 'active' AND disabled_at IS NULL) OR
    (status = 'disabled' AND disabled_at IS NOT NULL AND disabled_at >= created_at)
  ),
  CONSTRAINT accounts_updated_timestamp CHECK (updated_at >= created_at)
);

CREATE FUNCTION public.touch_account_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_updated_at
BEFORE UPDATE ON public.accounts
FOR EACH ROW EXECUTE FUNCTION public.touch_account_updated_at();
