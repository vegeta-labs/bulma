-- D1: accounts, investing entities, eligibility, KYC (PRD §4.1 to 4.4, §5.6; tech design §3).
ALTER TABLE user_account
  ADD COLUMN first_name text,
  ADD COLUMN last_name text,
  ADD COLUMN email_verified_at timestamptz,
  ADD COLUMN mfa_secret bytea,
  ADD COLUMN mfa_key_id text,
  ADD COLUMN mfa_wrapped_key bytea,
  ADD COLUMN mfa_enabled_at timestamptz,
  ADD COLUMN mfa_last_step bigint,
  ADD COLUMN deletion_requested_at timestamptz,
  -- a statement signed before this needs signing again (R-ACC-04), whichever regime it was under
  ADD COLUMN identity_changed_at timestamptz,
  ADD COLUMN anonymised_at timestamptz;

-- the first admin and accounts an admin creates were vouched for by that admin; everyone else proves the address
UPDATE user_account SET email_verified_at = now();

-- how this session signed in: what a signature's evidence reports (R-SIG-03)
ALTER TABLE app_session ADD COLUMN auth_method text NOT NULL DEFAULT 'password' CHECK (auth_method IN ('password', 'password+totp', 'password+recovery_code'));

-- from this moment only what was done in the real mode counts (decision R13). Compared with created_at, which for the tables
-- concerned is the clock at insert, not the transaction's start: a writer may have waited for the switch to finish.
ALTER TABLE instance_profile ADD COLUMN real_since timestamptz;

-- R-ACC-03.1: lost two-step goes through the second admin too
ALTER TABLE admin_request DROP CONSTRAINT admin_request_kind_check;
ALTER TABLE admin_request ADD CONSTRAINT admin_request_kind_check CHECK (kind IN ('mode_switch', 'profile_change', 'pack_activate', 'role_change', 'user_disable', 'mfa_reset', 'retention_config', 'retention_hold_off'));

CREATE TABLE account_token (
  token_hmac text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_account (id),
  kind text NOT NULL CHECK (kind IN ('verify_email', 'reset_password', 'change_email')),
  new_email text,
  -- registering again on an unconfirmed address: the new credential, applied only on confirmation
  pending_password_hash text,
  pending_first_name text,
  pending_last_name text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- addresses a person had before changing them, so their sandbox mail can still be found at the end of retention
CREATE TABLE user_email_history (
  user_id uuid NOT NULL REFERENCES user_account (id),
  email text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mfa_recovery_code (
  code_hmac text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_account (id),
  used_at timestamptz
);

CREATE TABLE legal_entity (
  id uuid PRIMARY KEY,
  owner_user uuid NOT NULL REFERENCES user_account (id),
  type text NOT NULL CHECK (type IN ('individual', 'company', 'trust', 'other')),
  current_version integer NOT NULL DEFAULT 1,
  -- R-KYC-02: refusal is final for the entity, whichever of its cases it was given on
  rejected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- one row per change of identity; a KYC pass belongs to one version (R-ENT-03)
CREATE TABLE legal_entity_version (
  entity_id uuid NOT NULL REFERENCES legal_entity (id),
  version integer NOT NULL,
  fields jsonb NOT NULL,
  anonymised_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, version)
);

CREATE TABLE entity_party (
  id uuid PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES legal_entity (id),
  entity_version integer NOT NULL,
  name text NOT NULL,
  email text,
  kind text NOT NULL CHECK (kind IN ('owner', 'controller', 'director', 'representative')),
  ownership_bps integer NOT NULL DEFAULT 0 CHECK (ownership_bps BETWEEN 0 AND 10000),
  verify_token_hmac text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entity_bank_account (
  id uuid PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES legal_entity (id),
  holder text NOT NULL,
  account_fields jsonb NOT NULL,
  evidence_file uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'refused', 'replaced')),
  confirmed_by uuid REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- R-ENT-06: one account in use at a time
CREATE UNIQUE INDEX entity_bank_one_confirmed ON entity_bank_account (entity_id) WHERE status = 'confirmed';

CREATE TABLE stored_file (
  id uuid PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('entity_kyc', 'entity_bank')),
  owner_id uuid NOT NULL,
  requirement text NOT NULL,
  display_name text NOT NULL,
  content_type text NOT NULL,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  scan_status text NOT NULL CHECK (scan_status IN ('clean')),
  storage_key text NOT NULL,
  key_id text NOT NULL,
  wrapped_key bytea NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE kyc_case (
  id uuid PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES legal_entity (id),
  entity_version integer NOT NULL,
  provider text NOT NULL CHECK (provider IN ('manual', 'fake', 'sumsub')),
  provider_ref text,
  -- our id for this verification cycle at the provider; a new cycle has a new applicant, so an old result cannot match it
  provider_external_id text,
  status text NOT NULL CHECK (status IN ('in_progress', 'pending_review', 'approved', 'returned', 'rejected', 'superseded')),
  provider_suggestion text,
  -- a provider's "no" arriving when the case had moved on: for a reviewer to look at, deciding nothing by itself
  late_provider_result text,
  -- a result that came while the case was sent back for a retry: kept for when the person resubmits
  unapplied_result text,
  -- the files this case is about (R-ENT-03): what is reviewed is what stays bound to the pass
  file_ids jsonb NOT NULL DEFAULT '[]',
  information_confirmed_at timestamptz,
  return_reason text,
  decided_by uuid REFERENCES user_account (id),
  decided_at timestamptz,
  expires_on date,
  biometric_consent_at timestamptz,
  biometric_consent_text_sha256 text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- R-KYC-02: a rejection is a person's decision
  CONSTRAINT rejection_by_a_person CHECK (status <> 'rejected' OR decided_by IS NOT NULL)
);
CREATE UNIQUE INDEX kyc_case_one_open ON kyc_case (entity_id) WHERE status IN ('in_progress', 'pending_review', 'returned');
-- one open case per applicant; a resubmission reuses the applicant, so closed cases may share it
CREATE UNIQUE INDEX kyc_case_provider_ref ON kyc_case (provider, provider_ref) WHERE provider_ref IS NOT NULL AND status IN ('in_progress', 'pending_review');

-- every applicant the provider ever gave us, recorded as soon as it answers, so none is lost if the submission then fails.
-- Removing them at the provider is the operator's; retention reports these ids.
CREATE TABLE kyc_provider_ref (
  provider text NOT NULL,
  provider_ref text NOT NULL,
  entity_id uuid NOT NULL REFERENCES legal_entity (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_ref)
);

-- deliveries seen: the provider retries, and its documents give no unique event id, so the signed body identifies one
CREATE TABLE kyc_webhook_event (
  provider text NOT NULL,
  body_sha256 text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, body_sha256)
);

CREATE TABLE eligibility_statement (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_account (id),
  regime text NOT NULL,
  pack_id uuid NOT NULL REFERENCES regime_pack (id),
  category text NOT NULL CHECK (category IN ('high_net_worth', 'sophisticated', 'neither')),
  qualifies boolean NOT NULL,
  answers jsonb NOT NULL,
  legal_text_sha256 text,
  signed_name text NOT NULL,
  signed_on date NOT NULL,
  payload_sha256 text NOT NULL,
  ip text NOT NULL,
  auth_method text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- R-ELG-04, decision R12: a reviewer's early reopening. The reason can hold personal information, so it is not in the audit.
CREATE TABLE eligibility_reopen (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_account (id),
  reason text NOT NULL,
  decided_by uuid NOT NULL REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE assessment_attempt (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_account (id),
  pack_id uuid NOT NULL REFERENCES regime_pack (id),
  questions_used jsonb NOT NULL,
  passed boolean,
  answered_at timestamptz,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- one open attempt per person and version, so opening several cannot dodge the lock (R-ELG-05)
CREATE UNIQUE INDEX assessment_one_open ON assessment_attempt (user_id, pack_id) WHERE passed IS NULL;

CREATE TABLE warning_ack (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_account (id),
  pack_id uuid NOT NULL REFERENCES regime_pack (id),
  kind text NOT NULL CHECK (kind IN ('personalised_warning', 'warning_block')),
  full_name text,
  legal_text_sha256 text NOT NULL,
  shown_at timestamptz NOT NULL,
  decision text NOT NULL CHECK (decision IN ('continue', 'leave')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- once per person for the one operator of this instance (R-ELG-06)
CREATE TABLE cooling_off (
  user_id uuid PRIMARY KEY REFERENCES user_account (id),
  started_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  decision text CHECK (decision IN ('continue', 'leave')),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- files to remove once the rows that name them are gone; kept so a storage failure is tried again. Holds no personal data.
CREATE TABLE file_deletion (
  storage_key text PRIMARY KEY,
  queued_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE retention_config (
  id integer PRIMARY KEY CHECK (id = 1),
  relationship_years integer NOT NULL DEFAULT 5 CHECK (relationship_years >= 0),
  idle_months integer NOT NULL DEFAULT 24 CHECK (idle_months > 0),
  kyc_valid_years integer NOT NULL DEFAULT 3 CHECK (kyc_valid_years > 0)
);
INSERT INTO retention_config (id) VALUES (1);

CREATE TRIGGER legal_entity_version_identity BEFORE DELETE ON legal_entity_version FOR EACH ROW EXECUTE FUNCTION refuse_change();

GRANT SELECT, INSERT, UPDATE ON account_token, mfa_recovery_code, legal_entity, entity_party, entity_bank_account, kyc_case, cooling_off, assessment_attempt, retention_config TO bulma_app;
-- identity versions and signed evidence are written once
GRANT SELECT, INSERT ON kyc_provider_ref, legal_entity_version, stored_file, eligibility_statement, warning_ack, eligibility_reopen, user_email_history, kyc_webhook_event TO bulma_app;

-- the expiry job (tech design §3.1): reads only what it must judge or find, removes personal data, keeps ids; records ids in the audit
-- never the password hash or the two-step secret to read, only to clear
GRANT SELECT (id, email, last_login_at, created_at, deletion_requested_at, relationship_ended_at, retention_hold, anonymised_at, disabled_at) ON user_account TO bulma_maintenance;
GRANT SELECT, INSERT, DELETE ON file_deletion TO bulma_maintenance;
GRANT SELECT, DELETE ON kyc_provider_ref TO bulma_maintenance;
GRANT SELECT, DELETE ON sandbox_outbox TO bulma_maintenance;
GRANT SELECT ON legal_entity, retention_config, role_grant TO bulma_maintenance;
-- every audit row names the active pack version, and nothing more of either table is needed
GRANT SELECT (active_pack_id) ON instance_profile TO bulma_maintenance;
GRANT SELECT (id, key, version) ON regime_pack TO bulma_maintenance;
GRANT SELECT (user_id, new_email), DELETE ON account_token TO bulma_maintenance;
GRANT SELECT (user_id, email), DELETE ON user_email_history TO bulma_maintenance;
GRANT SELECT (entity_id, email), DELETE ON entity_party TO bulma_maintenance;
GRANT SELECT (entity_id), DELETE ON entity_bank_account TO bulma_maintenance;
-- not the wrapped keys: with the files volume they would open every document
GRANT SELECT (owner_id, storage_key), DELETE ON stored_file TO bulma_maintenance;
GRANT SELECT (entity_id, provider, provider_ref, status, created_at), DELETE ON kyc_case TO bulma_maintenance;
GRANT SELECT (user_id), DELETE ON mfa_recovery_code, eligibility_statement, assessment_attempt, warning_ack, cooling_off, eligibility_reopen TO bulma_maintenance;
GRANT SELECT, INSERT ON audit, audit_detail TO bulma_maintenance;

-- The expiry job cannot write to accounts directly: with that right it could set an admin's password and clear two-step.
-- These two do the only things it needs, and refuse anyone holding a role or under a legal hold.
CREATE FUNCTION lock_person_for_retention(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM user_account WHERE id = p FOR UPDATE;
  -- then the periods: a change made while this waited is seen, and a later one waits for this deletion
  PERFORM 1 FROM retention_config FOR SHARE;
END $$;

CREATE FUNCTION anonymise_person(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM role_grant WHERE user_id = p) OR EXISTS (SELECT 1 FROM user_account WHERE id = p AND retention_hold) THEN
    RAISE EXCEPTION 'this person cannot be removed' USING ERRCODE = 'P0001';
  END IF;
  UPDATE user_account SET email = 'removed-' || id || '@invalid', name = 'Removed', first_name = NULL, last_name = NULL, password_hash = NULL,
    mfa_secret = NULL, mfa_key_id = NULL, mfa_wrapped_key = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL,
    disabled_at = coalesce(disabled_at, now()), anonymised_at = now() WHERE id = p;
  UPDATE legal_entity_version SET fields = '{}', anonymised_at = now() WHERE entity_id IN (SELECT id FROM legal_entity WHERE owner_user = p);
END $$;
REVOKE ALL ON FUNCTION lock_person_for_retention(uuid), anonymise_person(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_person_for_retention(uuid), anonymise_person(uuid) TO bulma_maintenance;
