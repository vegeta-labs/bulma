-- D0 foundation (tech design §3, PRD R-OP-*, R-AUD-01). Amounts are bigint minor units, rates integer bps.

CREATE FUNCTION refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: this table only takes new rows', TG_OP, TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;

CREATE TABLE regime_pack (
  id uuid PRIMARY KEY,
  key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  regime text NOT NULL CHECK (regime IN ('uk-fpo', 'uk-cobs')),
  content jsonb NOT NULL,
  content_sha256 text NOT NULL,
  built_in boolean NOT NULL DEFAULT false,
  added_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, version)
);

CREATE TABLE legal_text (
  id uuid PRIMARY KEY,
  pack_id uuid NOT NULL REFERENCES regime_pack (id),
  text_key text NOT NULL,
  variant text NOT NULL DEFAULT 'default',
  version integer NOT NULL CHECK (version > 0),
  format text NOT NULL CHECK (format IN ('plain', 'bold_markup')),
  body text NOT NULL,
  required_bold jsonb NOT NULL DEFAULT '[]',
  sha256 text NOT NULL,
  is_placeholder boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, text_key, variant)
);

CREATE TABLE assessment_question (
  id uuid PRIMARY KEY,
  pack_id uuid NOT NULL REFERENCES regime_pack (id),
  question_key text NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, question_key)
);

CREATE TABLE user_account (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  password_hash text,
  must_change_password boolean NOT NULL DEFAULT true,
  credential_version integer NOT NULL DEFAULT 1,
  disabled_at timestamptz,
  last_login_at timestamptz,
  relationship_ended_at timestamptz,
  retention_hold boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_account_email ON user_account (lower(email));

CREATE TABLE role_grant (
  user_id uuid NOT NULL REFERENCES user_account (id),
  role text NOT NULL CHECK (role IN ('admin', 'reviewer', 'approver')),
  granted_by uuid REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE app_session (
  id_hmac text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_account (id),
  credential_version integer NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- sign-in attempts in the current window per key (an HMAC of the email, or of the address); no personal data
CREATE TABLE login_throttle (
  key_hmac text PRIMARY KEY,
  failures integer NOT NULL,
  window_started_at timestamptz NOT NULL
);

CREATE TABLE instance_profile (
  id integer PRIMARY KEY CHECK (id = 1),
  mode text NOT NULL DEFAULT 'sandbox' CHECK (mode IN ('sandbox', 'real')),
  regulatory_status text CHECK (regulatory_status IN ('authorised_firm', 'unauthorised_relying_on_exemption', 'appointed_representative')),
  accountable_person text,
  accountable_confirmed_on date,
  active_pack_id uuid NOT NULL REFERENCES regime_pack (id),
  approved_by uuid REFERENCES user_account (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- R-OP-02: the real mode never runs for an appointed representative or without an accountable person
  CONSTRAINT real_mode_profile CHECK (
    mode = 'sandbox' OR (
      regulatory_status IN ('authorised_firm', 'unauthorised_relying_on_exemption')
      AND accountable_person IS NOT NULL AND accountable_confirmed_on IS NOT NULL AND approved_by IS NOT NULL
    )
  )
);

-- A change a second admin approves (R-OP-02, R-OP-04, R-OP-08). Not one of the tech design's listed tables: it holds
-- the approved_by those tables name while a change waits.
CREATE TABLE admin_request (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('mode_switch', 'profile_change', 'pack_activate', 'role_change', 'user_disable')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by uuid NOT NULL REFERENCES user_account (id),
  decided_by uuid REFERENCES user_account (id),
  decided_at timestamptz,
  single_admin_exception boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT second_person CHECK (status <> 'approved' OR decided_by IS NOT NULL AND (decided_by <> requested_by OR single_admin_exception))
);

CREATE TABLE fee_config (
  id uuid PRIMARY KEY,
  version integer NOT NULL UNIQUE CHECK (version > 0),
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  min_minor bigint NOT NULL CHECK (min_minor >= 0),
  max_minor bigint NOT NULL CHECK (max_minor >= 0),
  surcharge_threshold_minor bigint NOT NULL CHECK (surcharge_threshold_minor >= 0),
  surcharge_bps integer NOT NULL CHECK (surcharge_bps BETWEEN 0 AND 10000),
  changed_by uuid NOT NULL REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT min_not_above_max CHECK (min_minor <= max_minor)
);

-- Only ever written when a second admin approves the switch to the real mode in D0; the edit flow arrives with D3.
CREATE TABLE payment_instruction (
  id uuid PRIMARY KEY,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  version integer NOT NULL CHECK (version > 0),
  account_fields jsonb NOT NULL,
  holder text NOT NULL CHECK (holder <> ''),
  holder_capacity text NOT NULL CHECK (holder_capacity <> ''),
  holder_frn text,
  asserted_client_money boolean NOT NULL,
  your_money_text_key text NOT NULL,
  refund_days integer NOT NULL CHECK (refund_days >= 0),
  receipt_check_note text NOT NULL,
  prepared_by uuid NOT NULL REFERENCES user_account (id),
  approved_by uuid NOT NULL REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (currency, version),
  CONSTRAINT second_person CHECK (approved_by <> prepared_by)
);

-- Everything a sandbox would have emailed stays here (R-OP-01). It is never sent.
CREATE TABLE sandbox_outbox (
  id uuid PRIMARY KEY,
  to_address text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit (
  seq bigint PRIMARY KEY,
  at text NOT NULL, -- ISO 8601 UTC, exactly as hashed; one form, so no second copy can drift
  actor_id text NOT NULL,
  action text NOT NULL,
  entity_id text,
  detail_hmac text,
  software_version text NOT NULL,
  pack_version text,
  prev_hash text NOT NULL,
  hash text NOT NULL
);

CREATE TABLE audit_detail (
  audit_seq bigint PRIMARY KEY REFERENCES audit (seq),
  detail text NOT NULL -- the exact text the audit row's HMAC covers
);

-- What was asked never changes, and a decision is final (Codex D0 round 1): only a pending request can move, and only its decision fields.
CREATE FUNCTION guard_admin_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' OR NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.payload <> OLD.payload OR NEW.requested_by <> OLD.requested_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a request cannot be rewritten' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_request_guard BEFORE UPDATE ON admin_request FOR EACH ROW EXECUTE FUNCTION guard_admin_request();

-- append-only tables (tech design T8, R-AUD-01)
CREATE TRIGGER regime_pack_only_new BEFORE UPDATE OR DELETE ON regime_pack FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER legal_text_only_new BEFORE UPDATE OR DELETE ON legal_text FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER assessment_question_only_new BEFORE UPDATE OR DELETE ON assessment_question FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER fee_config_only_new BEFORE UPDATE OR DELETE ON fee_config FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER payment_instruction_only_new BEFORE UPDATE OR DELETE ON payment_instruction FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER audit_only_new BEFORE UPDATE OR DELETE ON audit FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER audit_detail_no_update BEFORE UPDATE ON audit_detail FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit FOR EACH STATEMENT EXECUTE FUNCTION refuse_change();

-- table-by-table grants (tech design §3, as Trunks §4.1); roles are created by migrate before this file runs
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT, INSERT ON regime_pack, legal_text, assessment_question, fee_config, payment_instruction, audit, audit_detail, sandbox_outbox TO bulma_app;
GRANT SELECT, INSERT, UPDATE ON user_account, instance_profile, admin_request TO bulma_app;
GRANT SELECT, INSERT, DELETE ON role_grant TO bulma_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app_session, login_throttle TO bulma_app;
-- only what the expiry job needs so far; it gets more when retention arrives, never password hashes or payment details
GRANT SELECT, DELETE ON audit_detail, app_session TO bulma_maintenance;
