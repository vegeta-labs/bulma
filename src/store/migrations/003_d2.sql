-- D2: syndicates, the deal wizard, review, the investee check and launch (PRD §4.5 to 4.8, §5.1; tech design §3).

-- operator settings for deals; one row, like retention_config
CREATE TABLE deal_config (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled_structures text[] NOT NULL DEFAULT ARRAY['uk_bare_trust'],
  required_company_fields text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (required_company_fields <@ ARRAY['registration_number', 'address']),
  min_commitment_floor_minor bigint NOT NULL DEFAULT 100000 CHECK (min_commitment_floor_minor > 0),
  default_carry_bps integer NOT NULL DEFAULT 2000 CHECK (default_carry_bps BETWEEN 0 AND 10000),
  embed_hosts text[] NOT NULL DEFAULT ARRAY[]::text[],
  review_target_days integer NOT NULL DEFAULT 5 CHECK (review_target_days > 0),
  launch_confirm_days integer NOT NULL DEFAULT 30 CHECK (launch_confirm_days > 0),
  draft_restore_days integer NOT NULL DEFAULT 60 CHECK (draft_restore_days > 0),
  investee_link_days integer NOT NULL DEFAULT 14 CHECK (investee_link_days > 0),
  investee_reminder_hours integer NOT NULL DEFAULT 24 CHECK (investee_reminder_hours > 0),
  investee_valid_days integer NOT NULL DEFAULT 365 CHECK (investee_valid_days > 0),
  -- R-CMP-02: a sandbox does not ask for content approval unless the operator turns this on
  content_approval_in_sandbox boolean NOT NULL DEFAULT false
);
INSERT INTO deal_config (id) VALUES (1);

-- written when a deal is submitted, never for a draft (R-SYN-02)
CREATE TABLE syndicate (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  thesis jsonb,
  lead_entity uuid NOT NULL REFERENCES legal_entity (id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by uuid NOT NULL REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE syndicate_member (
  syndicate_id uuid NOT NULL REFERENCES syndicate (id),
  user_id uuid NOT NULL REFERENCES user_account (id),
  role text NOT NULL CHECK (role IN ('admin', 'deal_member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (syndicate_id, user_id)
);

CREATE TABLE member_invite (
  id uuid PRIMARY KEY,
  syndicate_id uuid NOT NULL REFERENCES syndicate (id),
  token_hmac text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('admin', 'deal_member')),
  created_by uuid NOT NULL REFERENCES user_account (id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deal (
  id uuid PRIMARY KEY,
  lead_user uuid NOT NULL REFERENCES user_account (id),
  syndicate_id uuid REFERENCES syndicate (id),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'in_review', 'changes_requested', 'rejected', 'approved', 'live')),
  -- the working copy, including a syndicate not yet created; what was reviewed lives in deal_version
  draft jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- goes up with every write of the working copy, so a page that read an older copy cannot save over a newer one
  draft_rev integer NOT NULL DEFAULT 0,
  -- no company information in it (PRD §5.5): the same alphabet as a payment reference's random part
  public_code text NOT NULL UNIQUE CHECK (public_code ~ '^[A-HJKMNP-Z2-9]{6}$'),
  -- copied from the draft so the review queue can sort (R-REV-01)
  target_close date,
  fee_config_id uuid REFERENCES fee_config (id),
  -- the operator's minimum commitment when the deal was submitted: like the fee, it stays with the deal
  bound_floor_minor bigint,
  pack_id uuid REFERENCES regime_pack (id),
  submitted_at timestamptz,
  approved_at timestamptz,
  approved_version integer,
  went_live_at timestamptz,
  deleted_at timestamptz,
  ended_at timestamptz,
  retention_hold boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- backstops for rules the service enforces: a submitted deal has its syndicate, and a live one its pack (R-SYN-02, R-OP-04.2)
  CONSTRAINT submitted_has_syndicate CHECK (state = 'draft' OR syndicate_id IS NOT NULL),
  CONSTRAINT approved_has_time CHECK (state NOT IN ('approved', 'live') OR (approved_at IS NOT NULL AND approved_version IS NOT NULL)),
  CONSTRAINT live_is_bound CHECK (state <> 'live' OR (pack_id IS NOT NULL AND fee_config_id IS NOT NULL AND went_live_at IS NOT NULL)),
  CONSTRAINT only_drafts_deleted CHECK (deleted_at IS NULL OR state = 'draft')
);
CREATE INDEX deal_review_queue ON deal (target_close NULLS LAST, submitted_at) WHERE state = 'in_review';
CREATE INDEX deal_lead ON deal (lead_user);

CREATE TABLE deal_member (
  deal_id uuid NOT NULL REFERENCES deal (id),
  user_id uuid NOT NULL REFERENCES user_account (id),
  role text NOT NULL CHECK (role IN ('member', 'co_lead')),
  -- set when a co-lead has been told, so nobody is told twice or left out (R-DRF-11)
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_id, user_id)
);

-- immutable: a changed contact or carry recipient is a new row, and a snapshot refers to the row it saw (R-PUB-02)
CREATE TABLE person_version (
  id uuid PRIMARY KEY,
  fields jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deal_version (
  deal_id uuid NOT NULL REFERENCES deal (id),
  n integer NOT NULL CHECK (n > 0),
  snapshot jsonb NOT NULL,
  sha256 text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('submitted', 'edited', 'approved')),
  approved_by uuid REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_id, n),
  CONSTRAINT approved_names_who CHECK ((kind = 'approved') = (approved_by IS NOT NULL))
);

ALTER TABLE deal ADD CONSTRAINT deal_approved_version_exists FOREIGN KEY (id, approved_version) REFERENCES deal_version (deal_id, n);

CREATE TABLE carry_recipient (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deal (id),
  kind text NOT NULL CHECK (kind IN ('person', 'company')),
  person_version uuid NOT NULL REFERENCES person_version (id),
  share_bps integer NOT NULL CHECK (share_bps BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX carry_recipient_deal ON carry_recipient (deal_id);

CREATE TABLE review_event (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deal (id),
  from_state text NOT NULL,
  to_state text NOT NULL,
  actor uuid REFERENCES user_account (id),
  event text NOT NULL,
  reason text,
  -- never returned to the lead (R-REV-02)
  internal_note text,
  version_n integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX review_event_deal ON review_event (deal_id, created_at);

CREATE TABLE lead_attestation (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deal (id),
  kind text NOT NULL CHECK (kind IN ('board_and_shareholders', 'fund_mainly_unlisted')),
  actor uuid NOT NULL REFERENCES user_account (id),
  version_n integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE promotion_approval (
  id uuid PRIMARY KEY,
  subject_kind text NOT NULL CHECK (subject_kind IN ('deal_version', 'message', 'template')),
  subject_id text NOT NULL,
  approver_user uuid NOT NULL REFERENCES user_account (id),
  -- as the operator states them; the software has not checked either (R-OP-09)
  self_declared_name text NOT NULL,
  self_declared_frn text,
  approved_on date NOT NULL,
  content_sha256 text NOT NULL,
  -- the clock at insert: a writer may have waited for the switch to the real mode to finish (decision R13)
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX promotion_approval_subject ON promotion_approval (subject_kind, subject_id);

CREATE TABLE investee_company (
  id uuid PRIMARY KEY,
  legal_name text NOT NULL,
  jurisdiction text NOT NULL,
  registration_number text,
  verified_until date,
  -- what was checked in a sandbox does not count after the switch to the real mode (decision R13)
  verified_at timestamptz,
  -- what the company said when it was checked: a later deal reusing the check keeps it, whatever becomes of the deal that asked
  needs_notarised_signature boolean,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE investee (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL UNIQUE REFERENCES deal (id),
  company_id uuid NOT NULL REFERENCES investee_company (id),
  contact_version uuid NOT NULL REFERENCES person_version (id),
  extra_contact_versions uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'submitted', 'approved', 'returned')),
  needs_notarised_signature boolean,
  decided_by uuid REFERENCES user_account (id),
  decided_at timestamptz,
  return_reason text,
  last_reminded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE investee_link (
  id uuid PRIMARY KEY,
  investee_id uuid NOT NULL REFERENCES investee (id),
  token_hmac text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- a new link replaces the old one (R-INV-01)
CREATE UNIQUE INDEX investee_link_one_open ON investee_link (investee_id) WHERE revoked_at IS NULL;

CREATE TABLE doc_folder (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deal (id),
  parent_id uuid REFERENCES doc_folder (id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE stored_file DROP CONSTRAINT stored_file_scope_check;
ALTER TABLE stored_file ADD CONSTRAINT stored_file_scope_check CHECK (scope IN ('entity_kyc', 'entity_bank', 'deal_shared', 'investee_verification'));
ALTER TABLE stored_file ADD COLUMN folder_id uuid REFERENCES doc_folder (id);
ALTER TABLE stored_file ADD COLUMN removed_at timestamptz;
-- an investee contact has no account (R-INV-01)
ALTER TABLE stored_file ALTER COLUMN uploaded_by DROP NOT NULL;
ALTER TABLE stored_file ADD CONSTRAINT stored_file_has_uploader CHECK (uploaded_by IS NOT NULL OR scope = 'investee_verification');
CREATE INDEX stored_file_owner ON stored_file (scope, owner_id) WHERE removed_at IS NULL;

CREATE TRIGGER deal_version_only_new BEFORE UPDATE OR DELETE ON deal_version FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER review_event_only_new BEFORE UPDATE OR DELETE ON review_event FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER lead_attestation_only_new BEFORE UPDATE OR DELETE ON lead_attestation FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER promotion_approval_only_new BEFORE UPDATE OR DELETE ON promotion_approval FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER person_version_no_delete BEFORE DELETE ON person_version FOR EACH ROW EXECUTE FUNCTION refuse_change();

GRANT SELECT, INSERT ON deal_version, review_event, lead_attestation, promotion_approval, person_version TO bulma_app;
GRANT SELECT, INSERT ON doc_folder TO bulma_app;
GRANT SELECT, INSERT ON syndicate, deal, investee TO bulma_app;
-- who leads a deal, its public code and which deal a check belongs to are set once and never rewritten
GRANT UPDATE (name, thesis, status) ON syndicate TO bulma_app;
GRANT UPDATE (draft, draft_rev, state, syndicate_id, target_close, fee_config_id, bound_floor_minor, pack_id, submitted_at, approved_at, approved_version, went_live_at, deleted_at, ended_at, updated_at) ON deal TO bulma_app;
GRANT UPDATE (company_id, contact_version, status, decided_by, decided_at, return_reason, needs_notarised_signature, last_reminded_at, extra_contact_versions) ON investee TO bulma_app;
-- a link is only ever revoked, and a company only ever marked as checked: tokens, roles and identities are not rewritten
GRANT SELECT, INSERT ON member_invite, investee_company, investee_link TO bulma_app;
GRANT UPDATE (revoked_at) ON member_invite, investee_link TO bulma_app;
GRANT UPDATE (verified_until, verified_at, needs_notarised_signature) ON investee_company TO bulma_app;
GRANT SELECT, INSERT, DELETE ON syndicate_member, deal_member TO bulma_app;
GRANT UPDATE (role) ON syndicate_member TO bulma_app;
GRANT UPDATE (role, notified_at) ON deal_member TO bulma_app;
GRANT SELECT, INSERT, DELETE ON carry_recipient TO bulma_app;
GRANT SELECT, UPDATE ON deal_config TO bulma_app;
GRANT UPDATE (removed_at) ON stored_file TO bulma_app;
