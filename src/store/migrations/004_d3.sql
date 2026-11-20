-- D3: invitations, the deal page, commitments, signing, payment instructions, receipts recorded by hand, compliance holds,
-- operator switches and the expected-investor list (PRD §4.9 to 4.13, 4.14a, 4.22, §5.2, §5.5; tech design §3, §5).

-- R-LNK-02, C-REF-1, R-LNK-09: the operator's numbers for invitations and payments
ALTER TABLE deal_config
  ADD COLUMN link_fee_max_bps integer NOT NULL DEFAULT 2500 CHECK (link_fee_max_bps BETWEEN 0 AND 5000),
  ADD COLUMN reference_prefix text NOT NULL DEFAULT 'BU' CHECK (reference_prefix ~ '^[A-Z]{2,4}$'),
  ADD COLUMN eea_count_limit integer NOT NULL DEFAULT 149 CHECK (eea_count_limit > 0);

-- R-LNK-09: the country a person gives, asked with eligibility; ISO 3166 alpha-2, or null when not given
ALTER TABLE user_account ADD COLUMN country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');

-- R-CMP-03, R-OP-05: a relaxed switch and a new receiving account go through the second admin
ALTER TABLE admin_request DROP CONSTRAINT admin_request_kind_check;
ALTER TABLE admin_request ADD CONSTRAINT admin_request_kind_check CHECK (kind IN ('mode_switch', 'profile_change', 'pack_activate', 'role_change', 'user_disable', 'mfa_reset', 'retention_config', 'retention_hold_off', 'policy_change', 'payment_instruction'));

-- R-CMP-03: the operator's switches. A row per version; the newest is in force. Relaxing names a second admin.
CREATE TABLE operator_policy (
  version integer PRIMARY KEY CHECK (version > 0),
  per_link_terms boolean NOT NULL,
  generic_links boolean NOT NULL,
  bulk_promo boolean NOT NULL,
  export_roles text[] NOT NULL CHECK (export_roles <@ ARRAY['admin', 'reviewer', 'lead']),
  reminder_count integer NOT NULL CHECK (reminder_count BETWEEN 0 AND 10),
  changed_by uuid REFERENCES user_account (id),
  approved_by uuid REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- R-CMP-01: three levels. A reviewer applies alone; release needs someone else (the sandbox's only admin excepted).
CREATE TABLE compliance_hold (
  id uuid PRIMARY KEY,
  level text NOT NULL CHECK (level IN ('deal', 'lead', 'instance')),
  -- the deal or the lead's account; null for the instance
  target_id uuid,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  applied_by uuid NOT NULL REFERENCES user_account (id),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_by uuid REFERENCES user_account (id),
  released_at timestamptz,
  single_admin_exception boolean NOT NULL DEFAULT false,
  CONSTRAINT target_matches_level CHECK ((level = 'instance') = (target_id IS NULL)),
  CONSTRAINT release_complete CHECK ((released_by IS NULL) = (released_at IS NULL)),
  CONSTRAINT second_person CHECK (released_by IS NULL OR released_by <> applied_by OR single_admin_exception)
);
CREATE INDEX compliance_hold_open ON compliance_hold (level, target_id) WHERE released_at IS NULL;

-- R-LNK-02 to R-LNK-06. The terms never change once written (trigger below): new terms are a new link.
CREATE TABLE invite_link (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deal (id),
  kind text NOT NULL CHECK (kind IN ('open', 'terms_only')),
  -- an open link is found by the HMAC of its token and can be shown again from the encrypted copy (R-LNK-04)
  token_hmac text UNIQUE,
  token_sealed bytea,
  token_key_id text,
  token_wrapped_key bytea,
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 200),
  carry_bps integer NOT NULL CHECK (carry_bps BETWEEN 0 AND 10000),
  fee_kind text NOT NULL CHECK (fee_kind IN ('none', 'percent', 'fixed')),
  fee_bps integer CHECK (fee_bps BETWEEN 1 AND 5000),
  fee_minor bigint CHECK (fee_minor BETWEEN 1 AND 100000000000),
  fee_mode text CHECK (fee_mode IN ('on_top', 'deducted')),
  reason text CHECK (reason IS NULL OR length(reason) <= 2000),
  incentive_attested boolean NOT NULL DEFAULT false,
  -- R-LNK-06: under a pack that asks, different terms wait for a reviewer; null approval and needs_approval = waiting
  needs_approval boolean NOT NULL DEFAULT false,
  terms_approved_by uuid REFERENCES user_account (id),
  terms_approved_at timestamptz,
  -- the two links a deal gets on launch (R-LNK-02)
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES user_account (id),
  disabled_at timestamptz,
  disabled_reason text CHECK (disabled_reason IS NULL OR disabled_reason IN ('lead', 'policy', 'replaced')),
  closing_paused_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fee_shape CHECK (
    (fee_kind = 'none' AND fee_bps IS NULL AND fee_minor IS NULL AND fee_mode IS NULL)
    OR (fee_kind = 'percent' AND fee_bps IS NOT NULL AND fee_minor IS NULL AND fee_mode IS NOT NULL)
    OR (fee_kind = 'fixed' AND fee_bps IS NULL AND fee_minor IS NOT NULL AND fee_mode IS NOT NULL)
  ),
  CONSTRAINT token_matches_kind CHECK ((kind = 'open') = (token_hmac IS NOT NULL AND token_sealed IS NOT NULL AND token_key_id IS NOT NULL AND token_wrapped_key IS NOT NULL)),
  CONSTRAINT approval_complete CHECK ((terms_approved_by IS NULL) = (terms_approved_at IS NULL))
);
CREATE INDEX invite_link_deal ON invite_link (deal_id) WHERE disabled_at IS NULL;

CREATE FUNCTION invite_link_terms_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invite links are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.deal_id, NEW.kind, NEW.token_hmac, NEW.token_sealed, NEW.carry_bps, NEW.fee_kind, NEW.fee_bps, NEW.fee_minor, NEW.fee_mode, NEW.reason, NEW.incentive_attested, NEW.needs_approval, NEW.is_default, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.deal_id, OLD.kind, OLD.token_hmac, OLD.token_sealed, OLD.carry_bps, OLD.fee_kind, OLD.fee_bps, OLD.fee_minor, OLD.fee_mode, OLD.reason, OLD.incentive_attested, OLD.needs_approval, OLD.is_default, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'the terms of an invite link cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invite_link_terms_fixed BEFORE UPDATE OR DELETE ON invite_link FOR EACH ROW EXECUTE FUNCTION invite_link_terms_fixed();

-- R-LNK-07: sent to one address; only an account that proved that address can take it, once
CREATE TABLE targeted_invite (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deal (id),
  invite_link uuid NOT NULL REFERENCES invite_link (id),
  token_hmac text NOT NULL UNIQUE,
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  allows_reentry boolean NOT NULL DEFAULT false,
  sent_by uuid NOT NULL REFERENCES user_account (id),
  sent_count integer NOT NULL DEFAULT 1 CHECK (sent_count > 0),
  last_sent_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  consumed_by uuid REFERENCES user_account (id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT consumed_complete CHECK ((consumed_at IS NULL) = (consumed_by IS NULL))
);
CREATE INDEX targeted_invite_deal ON targeted_invite (deal_id);

-- R-LNK-10: an opened link before it is bound. The browser holds a cookie; an account is attached on sign-up or sign-in.
CREATE TABLE pending_invite (
  id uuid PRIMARY KEY,
  browser_hmac text NOT NULL UNIQUE,
  invite_link uuid NOT NULL REFERENCES invite_link (id),
  targeted_invite uuid REFERENCES targeted_invite (id),
  user_id uuid REFERENCES user_account (id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX pending_invite_user ON pending_invite (user_id) WHERE user_id IS NOT NULL;

-- §5.2: one invitation in progress per person per deal. Terms are frozen on it at the first commitment.
CREATE TABLE deal_invitation (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deal (id),
  user_id uuid NOT NULL REFERENCES user_account (id),
  invite_link uuid NOT NULL REFERENCES invite_link (id),
  targeted_invite uuid REFERENCES targeted_invite (id),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'passed', 'revoked')),
  -- the link's terms as they were at the first commitment, so the link and later changes cannot move them (R-LNK-05)
  terms_snapshot jsonb,
  terms_frozen_at timestamptz,
  -- R-LNK-11: told when this person opened a second link
  second_link_seen_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT frozen_complete CHECK ((terms_snapshot IS NULL) = (terms_frozen_at IS NULL)),
  CONSTRAINT ended_complete CHECK ((state = 'active') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX deal_invitation_one_active ON deal_invitation (deal_id, user_id) WHERE state = 'active';

CREATE SEQUENCE participation_join_seq;

-- created at commitment, one per entity (§5.2, R-CMT-07)
CREATE TABLE participation (
  id uuid PRIMARY KEY,
  invitation_id uuid NOT NULL REFERENCES deal_invitation (id),
  deal_id uuid NOT NULL REFERENCES deal (id),
  user_id uuid NOT NULL REFERENCES user_account (id),
  entity_id uuid NOT NULL REFERENCES legal_entity (id),
  entity_version integer NOT NULL,
  outcome text NOT NULL DEFAULT 'active' CHECK (outcome IN ('active', 'removed', 'withdrawn', 'deal_cancelled', 'rejected_kyc', 'excluded_at_close')),
  identity_review text NOT NULL DEFAULT 'none' CHECK (identity_review IN ('none', 'pending', 'resolved')),
  scheme text NOT NULL DEFAULT 'none' CHECK (scheme IN ('none', 'seis', 'eis')),
  commitment_minor bigint NOT NULL CHECK (commitment_minor BETWEEN 1 AND 100000000000),
  invest_minor bigint NOT NULL CHECK (invest_minor > 0),
  lead_fee_minor bigint NOT NULL CHECK (lead_fee_minor >= 0),
  rounding_minor bigint NOT NULL CHECK (rounding_minor >= 0),
  cash_due_minor bigint NOT NULL CHECK (cash_due_minor BETWEEN 1 AND 100000000000),
  -- the version of the terms this commitment was made under; bumped by a change that must be agreed again (D4)
  terms_version integer NOT NULL DEFAULT 1 CHECK (terms_version > 0),
  reference text NOT NULL CHECK (reference ~ '^[A-Z]{2,4}-[A-HJKMNP-Z2-9]{6}$'),
  reference_norm text NOT NULL UNIQUE,
  join_seq bigint NOT NULL DEFAULT nextval('participation_join_seq'),
  invested_minor bigint,
  cash_consumed_minor bigint,
  holding_ended_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT adds_up CHECK (cash_due_minor = invest_minor + lead_fee_minor + rounding_minor),
  CONSTRAINT reference_norm_matches CHECK (reference_norm = replace(reference, '-', '')),
  CONSTRAINT ended_complete CHECK ((outcome = 'active') = (ended_at IS NULL))
);
-- a reference is never used again, by anyone, for anything (C-REF-1)
CREATE UNIQUE INDEX participation_one_active ON participation (deal_id, user_id, entity_id) WHERE outcome = 'active';
CREATE INDEX participation_invitation ON participation (invitation_id);
CREATE INDEX participation_user ON participation (user_id);

-- only inserted; status is worked out from facts (§5.2)
CREATE TABLE participation_event (
  id uuid PRIMARY KEY,
  participation_id uuid NOT NULL REFERENCES participation (id),
  event text NOT NULL,
  actor uuid REFERENCES user_account (id),
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX participation_event_participation ON participation_event (participation_id);

-- R-PAGE-05, §5.2: "not investing" from the invitation, before any participation
CREATE TABLE invitation_pass (
  invitation_id uuid PRIMARY KEY REFERENCES deal_invitation (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- R-SIG-02, R-SIG-04: the operator's documents to sign. Written once; a change is a new version.
CREATE TABLE document_template (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('deal_sheet')),
  version integer NOT NULL CHECK (version > 0),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 100000),
  needs_deed boolean NOT NULL DEFAULT false,
  is_placeholder boolean NOT NULL,
  sha256 text NOT NULL,
  created_by uuid REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (kind, version)
);

-- R-SIG-03: what was signed and the evidence. The rendered document is kept so it can be downloaded later (R-SIG-06).
CREATE TABLE signature_record (
  id uuid PRIMARY KEY,
  participation_id uuid NOT NULL REFERENCES participation (id),
  entity_version integer NOT NULL,
  terms_version integer NOT NULL,
  template_id uuid NOT NULL REFERENCES document_template (id),
  document text NOT NULL,
  -- the warning and sender that led the document, kept apart so the copy can be drawn as it was shown (§5.5)
  document_lead text NOT NULL DEFAULT '',
  document_sha256 text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('click', 'fake', 'external')),
  provider_ref text,
  signed_name text NOT NULL CHECK (length(trim(signed_name)) > 0),
  ip text NOT NULL,
  auth_method text NOT NULL,
  -- a deed goes outside; a person marks it done (R-SIG-04)
  external_status text CHECK (external_status IN ('sent', 'signed')),
  -- the date written into the document when it was made, so a deed sent one day can be recorded on another (Codex round 6)
  document_date date,
  signed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  superseded_at timestamptz
);
CREATE UNIQUE INDEX signature_one_current ON signature_record (participation_id) WHERE superseded_at IS NULL;

-- R-OP-05: an investor confirms which receiving account they saw; a new account is not shown without it
CREATE TABLE instruction_ack (
  participation_id uuid NOT NULL REFERENCES participation (id),
  payment_instruction_id uuid NOT NULL REFERENCES payment_instruction (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (participation_id, payment_instruction_id)
);

-- R-PAY-03: each issue is bound to the versions it was made from, and voided in the same transaction as any change
CREATE TABLE issued_instruction (
  id uuid PRIMARY KEY,
  participation_id uuid NOT NULL REFERENCES participation (id),
  -- null in the sandbox, whose fictional account is generated, never stored
  payment_instruction_id uuid REFERENCES payment_instruction (id),
  account_sha256 text NOT NULL,
  cash_due_minor bigint NOT NULL,
  terms_version integer NOT NULL,
  signature_id uuid NOT NULL REFERENCES signature_record (id),
  entity_version integer NOT NULL,
  deal_version integer NOT NULL,
  -- the warning shown with this issue, kept so the issue is always served with it, whatever the person's category later (§5.5)
  warning jsonb NOT NULL DEFAULT '{}',
  verify_hmac text NOT NULL UNIQUE,
  verify_sealed bytea NOT NULL,
  verify_key_id text NOT NULL,
  verify_wrapped_key bytea NOT NULL,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT void_complete CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE UNIQUE INDEX issued_instruction_one_valid ON issued_instruction (participation_id) WHERE voided_at IS NULL;

-- R-PAY-04: "I have paid". Not a receipt.
CREATE TABLE transfer_mark (
  id uuid PRIMARY KEY,
  participation_id uuid NOT NULL REFERENCES participation (id),
  actor uuid NOT NULL REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- R-PAY-09: one row per payment received. Recorded by a reviewer or admin, never the lead. Reversal keeps the row.
CREATE TABLE receipt (
  id uuid PRIMARY KEY,
  participation_id uuid NOT NULL REFERENCES participation (id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 100000000000),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source text NOT NULL CHECK (source IN ('manual')),
  received_on date NOT NULL,
  payer_name text NOT NULL CHECK (length(trim(payer_name)) > 0),
  payer_account text NOT NULL CHECK (length(trim(payer_account)) > 0),
  -- R-ENT-06: the payer did not match the entity or its account; listed for checking
  payer_mismatch boolean NOT NULL DEFAULT false,
  note text CHECK (note IS NULL OR length(note) <= 2000),
  entered_by uuid NOT NULL REFERENCES user_account (id),
  reversed_at timestamptz,
  reversed_by uuid REFERENCES user_account (id),
  reverse_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT reversal_complete CHECK ((reversed_at IS NULL) = (reversed_by IS NULL) AND (reversed_at IS NULL) = (reverse_reason IS NULL))
);
CREATE INDEX receipt_participation ON receipt (participation_id);

-- R-PIP-01 to R-PIP-03: the lead's list. Never seen by investors.
CREATE TABLE pipeline_entry (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deal (id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  expected_minor bigint CHECK (expected_minor IS NULL OR expected_minor BETWEEN 1 AND 100000000000),
  terms_label text NOT NULL DEFAULT '' CHECK (length(terms_label) <= 100),
  invite_link uuid REFERENCES invite_link (id),
  private_note text CHECK (private_note IS NULL OR length(private_note) <= 2000),
  targeted_invite uuid REFERENCES targeted_invite (id),
  created_by uuid NOT NULL REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  removed_at timestamptz
);
CREATE INDEX pipeline_entry_deal ON pipeline_entry (deal_id) WHERE removed_at IS NULL;

-- R-PAGE-07, R-AUD-02: which version was served to whom. Served, not read.
CREATE TABLE deal_view (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deal (id),
  user_id uuid NOT NULL REFERENCES user_account (id),
  version integer NOT NULL,
  served_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX deal_view_deal ON deal_view (deal_id);

-- R-PAGE-06: a note to the lead
CREATE TABLE deal_message (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deal (id),
  author uuid NOT NULL REFERENCES user_account (id),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX deal_message_deal ON deal_message (deal_id);

-- R-LNK-05: once frozen at the first commitment, the terms on an invitation never change; a change is a change request (D4)
CREATE FUNCTION invitation_terms_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.terms_frozen_at IS NOT NULL AND (NEW.terms_snapshot, NEW.terms_frozen_at, NEW.invite_link) IS DISTINCT FROM (OLD.terms_snapshot, OLD.terms_frozen_at, OLD.invite_link) THEN
    RAISE EXCEPTION 'frozen terms cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invitation_terms_frozen BEFORE UPDATE ON deal_invitation FOR EACH ROW EXECUTE FUNCTION invitation_terms_frozen();

-- R-SIG-03: signature evidence is fixed. The only changes: a current deed sent outside is recorded as signed once (status,
-- who recorded it, when), and a current record is superseded once. Nothing else, ever (Codex round 7).
CREATE FUNCTION signature_evidence_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'a superseded signature stays superseded' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.external_status, NEW.signed_name, NEW.signed_at) IS DISTINCT FROM (OLD.external_status, OLD.signed_name, OLD.signed_at)
     AND NOT (OLD.provider = 'external' AND OLD.external_status = 'sent' AND NEW.external_status = 'signed' AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NULL) THEN
    RAISE EXCEPTION 'signature evidence cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signature_evidence_fixed BEFORE UPDATE ON signature_record FOR EACH ROW EXECUTE FUNCTION signature_evidence_fixed();

-- R-PAY-03: a voided issue stays void, and a reversed receipt stays reversed, with their first reason and time (Codex round 8).
-- Otherwise the app role could clear voided_at and the verify page would call an old account or amount valid again.
CREATE FUNCTION instruction_void_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL AND (NEW.voided_at, NEW.void_reason) IS DISTINCT FROM (OLD.voided_at, OLD.void_reason) THEN
    RAISE EXCEPTION 'a voided instruction stays void' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER instruction_void_once BEFORE UPDATE ON issued_instruction FOR EACH ROW EXECUTE FUNCTION instruction_void_once();
CREATE FUNCTION receipt_reversal_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.reversed_at IS NOT NULL AND (NEW.reversed_at, NEW.reversed_by, NEW.reverse_reason) IS DISTINCT FROM (OLD.reversed_at, OLD.reversed_by, OLD.reverse_reason) THEN
    RAISE EXCEPTION 'a reversed receipt stays reversed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receipt_reversal_once BEFORE UPDATE ON receipt FOR EACH ROW EXECUTE FUNCTION receipt_reversal_once();

-- Every end in D3 is one-way (Codex round 9; the round 8 fix covered voids and reversals only, these are the rest of that kind).
-- The app sets each of these once and never clears it; the app role cannot either. Coming back needs a new row: a new
-- invitation, a new targeted invite, a new link, a new hold.
CREATE FUNCTION targeted_invite_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL AND (NEW.consumed_at, NEW.consumed_by) IS DISTINCT FROM (OLD.consumed_at, OLD.consumed_by) THEN
    RAISE EXCEPTION 'a used invite stays used' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revoked invite stays revoked' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER targeted_invite_once BEFORE UPDATE ON targeted_invite FOR EACH ROW EXECUTE FUNCTION targeted_invite_once();
CREATE FUNCTION invitation_end_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'active' AND (NEW.state, NEW.ended_at) IS DISTINCT FROM (OLD.state, OLD.ended_at) THEN
    RAISE EXCEPTION 'an ended invitation stays ended' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.second_link_seen_at IS NOT NULL AND NEW.second_link_seen_at IS DISTINCT FROM OLD.second_link_seen_at THEN
    RAISE EXCEPTION 'a second link seen stays seen' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invitation_end_once BEFORE UPDATE ON deal_invitation FOR EACH ROW EXECUTE FUNCTION invitation_end_once();
CREATE FUNCTION participation_end_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL AND (NEW.ended_at, NEW.outcome) IS DISTINCT FROM (OLD.ended_at, OLD.outcome) THEN
    RAISE EXCEPTION 'an ended participation stays ended' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER participation_end_once BEFORE UPDATE ON participation FOR EACH ROW EXECUTE FUNCTION participation_end_once();
CREATE FUNCTION invite_link_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.disabled_at IS NOT NULL AND (NEW.disabled_at, NEW.disabled_reason) IS DISTINCT FROM (OLD.disabled_at, OLD.disabled_reason) THEN
    RAISE EXCEPTION 'a disabled link stays disabled' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.terms_approved_at IS NOT NULL AND (NEW.terms_approved_at, NEW.terms_approved_by) IS DISTINCT FROM (OLD.terms_approved_at, OLD.terms_approved_by) THEN
    RAISE EXCEPTION 'an approval stays as given' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invite_link_once BEFORE UPDATE ON invite_link FOR EACH ROW EXECUTE FUNCTION invite_link_once();
CREATE FUNCTION compliance_hold_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.released_at IS NOT NULL AND (NEW.released_at, NEW.released_by, NEW.single_admin_exception) IS DISTINCT FROM (OLD.released_at, OLD.released_by, OLD.single_admin_exception) THEN
    RAISE EXCEPTION 'a release stays as recorded' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER compliance_hold_once BEFORE UPDATE ON compliance_hold FOR EACH ROW EXECUTE FUNCTION compliance_hold_once();
CREATE FUNCTION pipeline_removal_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL AND NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
    RAISE EXCEPTION 'a removed entry stays removed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pipeline_removal_once BEFORE UPDATE ON pipeline_entry FOR EACH ROW EXECUTE FUNCTION pipeline_removal_once();
CREATE TRIGGER operator_policy_only_new BEFORE UPDATE OR DELETE ON operator_policy FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER document_template_only_new BEFORE UPDATE OR DELETE ON document_template FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER participation_event_only_new BEFORE UPDATE OR DELETE ON participation_event FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER transfer_mark_only_new BEFORE UPDATE OR DELETE ON transfer_mark FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER instruction_ack_only_new BEFORE UPDATE OR DELETE ON instruction_ack FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER deal_view_only_new BEFORE UPDATE OR DELETE ON deal_view FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER deal_message_only_new BEFORE UPDATE OR DELETE ON deal_message FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER invitation_pass_only_new BEFORE UPDATE OR DELETE ON invitation_pass FOR EACH ROW EXECUTE FUNCTION refuse_change();

GRANT SELECT, INSERT ON operator_policy, document_template, participation_event, transfer_mark, instruction_ack, deal_view, deal_message, invitation_pass TO bulma_app;
GRANT SELECT, INSERT ON compliance_hold, invite_link, targeted_invite, deal_invitation, participation, signature_record, issued_instruction, receipt, pipeline_entry TO bulma_app;
GRANT SELECT, INSERT, DELETE ON pending_invite TO bulma_app;
GRANT UPDATE (released_by, released_at, single_admin_exception) ON compliance_hold TO bulma_app;
GRANT UPDATE (label, terms_approved_by, terms_approved_at, disabled_at, disabled_reason, closing_paused_at) ON invite_link TO bulma_app;
GRANT UPDATE (sent_count, last_sent_at, consumed_at, consumed_by, revoked_at) ON targeted_invite TO bulma_app;
GRANT UPDATE (user_id, expires_at) ON pending_invite TO bulma_app;
GRANT UPDATE (invite_link, targeted_invite, state, terms_snapshot, terms_frozen_at, second_link_seen_at, ended_at) ON deal_invitation TO bulma_app;
GRANT UPDATE (entity_version, outcome, identity_review, scheme, commitment_minor, invest_minor, lead_fee_minor, rounding_minor, cash_due_minor, terms_version, ended_at, updated_at) ON participation TO bulma_app;
GRANT UPDATE (external_status, superseded_at, signed_name, signed_at) ON signature_record TO bulma_app;
GRANT UPDATE (voided_at, void_reason) ON issued_instruction TO bulma_app;
GRANT UPDATE (reversed_at, reversed_by, reverse_reason) ON receipt TO bulma_app;
GRANT UPDATE (name, email, expected_minor, terms_label, invite_link, private_note, targeted_invite, removed_at) ON pipeline_entry TO bulma_app;
GRANT UPDATE (country) ON user_account TO bulma_app;
GRANT USAGE ON SEQUENCE participation_join_seq TO bulma_app;

-- R-SIG-02: a placeholder deal sheet, so the sandbox works from the start. The real mode refuses to sign on a placeholder.
INSERT INTO document_template (id, kind, version, body, needs_deed, is_placeholder, sha256)
SELECT gen_random_uuid(), 'deal_sheet', 1, b, false, true, encode(sha256(convert_to(b, 'UTF8')), 'hex')
  FROM (SELECT E'PLACEHOLDER DEAL SHEET. The operator replaces this text before real use.\n\nDeal: {deal_code}\nCompany: {company_name}\nInstrument: {instrument}\nInvestor: {investor_name}\nInvesting as: {entity_name}\nFee terms: {fee_terms}\n{breakdown}\nCarry: {carry}\nPayment reference: {reference}\nDate: {date}' AS b) t;
