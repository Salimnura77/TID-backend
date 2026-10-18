-- Authentication binding only. Never retain tokens, names, emails or provider profiles.
CREATE TABLE public.account_identities (
  issuer varchar(2048) NOT NULL CHECK (length(issuer) > 0),
  subject varchar(255) NOT NULL CHECK (length(subject) > 0),
  account_id uuid NOT NULL UNIQUE REFERENCES public.accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (issuer, subject)
);
