-- D4: operating a deal. Grows chunk by chunk until the D4 pull request (PRD §4.15 to 4.22, §5.1 to 5.3; tech design §3).

-- R23, R-NTF-02: the durable mail queue. A row is written in the transaction of the change it reports; a worker sends it,
-- deciding again before every attempt. The body is sealed (it can hold a sign-in link) and dropped once the row is done.
CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY,
  -- the mode it was queued in: it never goes out in the other one
  mode text NOT NULL CHECK (mode IN ('sandbox', 'real')),
  audience text NOT NULL CHECK (audience IN ('address', 'urgent', 'account', 'invite', 'lead', 'reminder')),
  user_id uuid REFERENCES user_account (id),
  deal_id uuid REFERENCES deal (id),
  invite_id uuid REFERENCES targeted_invite (id),
  -- reminder: what it reminds about, checked again before every attempt (a bound invitation or a participation)
  about_kind text CHECK (about_kind IN ('commit', 'payment', 'reconfirm')),
  about_id uuid,
  -- R-NTF-01: an operator-edited investor template; the sealed body then holds both versions, chosen at each attempt
  promo_template text,
  promo_version integer,
  -- which version went out: 'promo' only to someone who passed that day (R-COM-04)
  sent_variant text CHECK (sent_variant IN ('fixed', 'promo')),
  -- the address written when queued; for a person with an account the worker sends to the current one
  to_address text,
  subject text NOT NULL,
  key_id text,
  wrapped_key bytea,
  body_sealed bytea,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'cancelled', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  -- an error code only, never an address or text from the mail server
  last_error text CHECK (last_error ~ '^[A-Za-z0-9_.-]{1,64}$'),
  cancel_reason text CHECK (cancel_reason IN ('mode_changed', 'no_recipient', 'recipient_disabled', 'role_ended', 'deal_not_live', 'held')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CHECK (audience <> 'address' OR to_address IS NOT NULL),
  CHECK (audience NOT IN ('urgent', 'account', 'lead') OR user_id IS NOT NULL),
  CHECK (audience <> 'lead' OR deal_id IS NOT NULL),
  CHECK (audience <> 'invite' OR (invite_id IS NOT NULL AND deal_id IS NOT NULL AND to_address IS NOT NULL)),
  CHECK ((audience = 'reminder') = (about_kind IS NOT NULL AND about_id IS NOT NULL)),
  CHECK (audience <> 'reminder' OR (user_id IS NOT NULL AND deal_id IS NOT NULL)),
  CHECK ((promo_template IS NULL) = (promo_version IS NULL)),
  CHECK (promo_template IS NULL OR (user_id IS NOT NULL AND deal_id IS NOT NULL)),
  CHECK ((status = 'sent') = (sent_variant IS NOT NULL)),
  CHECK ((status = 'queued') = (body_sealed IS NOT NULL AND key_id IS NOT NULL AND wrapped_key IS NOT NULL)),
  CHECK ((status = 'queued') = (finished_at IS NULL)),
  CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL))
);
CREATE INDEX notification_outbox_due ON notification_outbox (next_attempt_at) WHERE status = 'queued';

GRANT SELECT, INSERT ON notification_outbox TO bulma_app;
GRANT UPDATE (key_id, wrapped_key, body_sealed, status, attempts, next_attempt_at, last_error, cancel_reason, finished_at, sent_variant) ON notification_outbox TO bulma_app;
-- tech design §3.1: retention removes a person's rows, and rows done more than 90 days ago (the address goes with them)
GRANT SELECT (id, user_id, to_address, status, finished_at), DELETE ON notification_outbox TO bulma_maintenance;

-- R-COM-06: a promotional mail kept in the sandbox's outbox is HTML; the page shows it as text, never renders it
ALTER TABLE sandbox_outbox ADD COLUMN is_html boolean NOT NULL DEFAULT false;

-- R-NTF-01: the operator's wording for an investor template. Only inserted; the newest version is in force, a null body
-- puts the fixed wording back. Urgent notices have no row: nobody can change them.
CREATE TABLE email_template (
  key text NOT NULL CHECK (key ~ '^investor\.[a-z_]{1,40}$'),
  version integer NOT NULL CHECK (version > 0),
  subject text CHECK (length(subject) BETWEEN 1 AND 150),
  body text CHECK (length(body) BETWEEN 1 AND 5000),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  edited_by uuid NOT NULL REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (key, version),
  CHECK ((subject IS NULL) = (body IS NULL) AND (body IS NULL) = (sha256 IS NULL))
);

-- R-NTF-01: reminders already queued, so each is queued once. Ids only.
CREATE TABLE mail_reminder (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('commit_invite', 'commit', 'payment', 'reconfirm')),
  about_id uuid NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX mail_reminder_about ON mail_reminder (about_id, kind);

-- R-NTF-01: payment and reconfirmation reminders every this many days until the deadline; 0 turns them off (R-CMP-03)
ALTER TABLE operator_policy ADD COLUMN reminder_every_days integer NOT NULL DEFAULT 3 CHECK (reminder_every_days BETWEEN 0 AND 30);

GRANT SELECT, INSERT ON email_template, mail_reminder TO bulma_app;

-- ---------- Chunk 5a: holds, release decisions and refunds (PRD C-FEE-4, R-KYC-02.1, R-OPS-05, R-WDR-04) ----------

-- C-FEE-4: the part of a receipt a release decision covers. Raised only by a release decision; the money rules cut it back
-- (`applyMoney` in the same transaction). A new receipt starts at 0, so new money is held.
ALTER TABLE receipt ADD COLUMN hold_released_minor bigint NOT NULL DEFAULT 0 CHECK (hold_released_minor >= 0);
ALTER TABLE receipt ADD CONSTRAINT released_within CHECK (hold_released_minor <= amount_minor);

-- R-KYC-02.1, tech design: one row per participation with money to give back or held money, made at a KYC rejection whether or
-- not there is money. The amount is never stored: it is worked out from N, E and H every time (C-FEE-4).
CREATE TABLE refund_todo (
  participation_id uuid PRIMARY KEY REFERENCES participation (id),
  hold text NOT NULL DEFAULT 'none' CHECK (hold IN ('none', 'considering', 'disclosure_consent', 'release_allowed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- the history of one to-do: reasons as they change (one obligation, reasons only as history) and hold steps with their basis
CREATE TABLE refund_todo_event (
  id uuid PRIMARY KEY,
  participation_id uuid NOT NULL REFERENCES refund_todo (participation_id),
  kind text NOT NULL CHECK (kind IN ('reason', 'hold_step')),
  value text NOT NULL CHECK (value ~ '^[a-z_]{1,40}$'),
  basis text CHECK (basis IS NULL OR length(basis) BETWEEN 1 AND 2000),
  actor uuid REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX refund_todo_event_participation ON refund_todo_event (participation_id, created_at);

-- R-KYC-02.1: a release decision names the receipts, the amounts and the basis; their total is at most H at the time
CREATE TABLE hold_release (
  id uuid PRIMARY KEY,
  participation_id uuid NOT NULL REFERENCES refund_todo (participation_id),
  basis text NOT NULL CHECK (length(trim(basis)) BETWEEN 3 AND 2000),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 100),
  decided_by uuid NOT NULL REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- R-OPS-05: the software never pays; this is the operator's record of a refund they make. Prepared → approved (a second person)
-- → sent → recorded. Approved and sent are in flight and come off N. A refund recorded with no approval has no amount.
-- One row stands for both the payment and its record (tech design `refund_payment` and `refund_record`).
CREATE TABLE refund_payment (
  id uuid PRIMARY KEY,
  participation_id uuid NOT NULL REFERENCES refund_todo (participation_id),
  state text NOT NULL CHECK (state IN ('prepared', 'approved', 'sent', 'recorded', 'cancelled')),
  reason text NOT NULL CHECK (reason ~ '^[a-z_]{1,40}$'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint CHECK (amount_minor BETWEEN 1 AND 100000000000),
  actual_minor bigint CHECK (actual_minor BETWEEN 1 AND 100000000000),
  -- C-FEE-4 占用: the part of the released money this refund uses
  hold_used_minor bigint NOT NULL DEFAULT 0 CHECK (hold_used_minor >= 0),
  source_name text NOT NULL CHECK (length(trim(source_name)) BETWEEN 1 AND 200),
  source_account text NOT NULL CHECK (length(trim(source_account)) BETWEEN 1 AND 200),
  dest_name text NOT NULL CHECK (length(trim(dest_name)) BETWEEN 1 AND 200),
  dest_account text NOT NULL CHECK (length(trim(dest_account)) BETWEEN 1 AND 200),
  differs_from_source boolean NOT NULL,
  evidence text CHECK (evidence IS NULL OR length(trim(evidence)) BETWEEN 3 AND 2000),
  prepared_by uuid REFERENCES user_account (id),
  prepared_at timestamptz,
  approved_by uuid REFERENCES user_account (id),
  approved_at timestamptz,
  -- what the person was to pay and whether money was held when approved: a later change is an exception at record time
  due_at_approval bigint,
  held_at_approval boolean,
  sent_by uuid REFERENCES user_account (id),
  sent_at timestamptz,
  recorded_by uuid REFERENCES user_account (id),
  recorded_at timestamptz,
  sent_on date,
  recall_evidence text CHECK (recall_evidence IS NULL OR length(trim(recall_evidence)) BETWEEN 3 AND 2000),
  cancelled_by uuid REFERENCES user_account (id),
  cancelled_at timestamptz,
  -- recorded as it happened and sent to the workbench: no_approval, amount_differs, commitment_changed, held_meanwhile
  exceptions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT second_person CHECK (approved_by IS NULL OR prepared_by IS NULL OR approved_by <> prepared_by),
  CONSTRAINT evidence_when_differs CHECK (NOT differs_from_source OR evidence IS NOT NULL),
  CONSTRAINT amount_when_prepared CHECK (amount_minor IS NOT NULL OR (state = 'recorded' AND prepared_by IS NULL AND approved_by IS NULL)),
  CONSTRAINT approved_complete CHECK ((approved_by IS NULL) = (approved_at IS NULL) AND (state NOT IN ('approved', 'sent') OR approved_by IS NOT NULL)),
  CONSTRAINT recorded_complete CHECK ((state = 'recorded') = (actual_minor IS NOT NULL AND recorded_at IS NOT NULL AND sent_on IS NOT NULL))
);
-- R-OPS-05: one refund in progress per participation; someone already working on it means nobody else can take it
CREATE UNIQUE INDEX refund_payment_one_open ON refund_payment (participation_id) WHERE state IN ('prepared', 'approved', 'sent');

-- a refund only moves forward (prepared → approved → sent → recorded, or cancelled from any open state; recorded straight
-- from prepared or approved when the money went without the steps); a recorded or cancelled one is never rewritten except
-- the C-FEE-4 occupation (recorded; cancelled only down to 0) and the retention job's blanking of names, accounts and evidence; what was
-- approved is never rewritten
CREATE FUNCTION refund_payment_forward() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  blankable text[] := ARRAY['source_name', 'source_account', 'dest_name', 'dest_account', 'evidence', 'recall_evidence'];
BEGIN
  IF OLD.state IN ('recorded', 'cancelled') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'a finished refund stays finished' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.state <> OLD.state AND NOT (OLD.state, NEW.state) IN (('prepared', 'approved'), ('prepared', 'recorded'), ('prepared', 'cancelled'),
      ('approved', 'sent'), ('approved', 'recorded'), ('approved', 'cancelled'), ('sent', 'recorded'), ('sent', 'cancelled')) THEN
    RAISE EXCEPTION 'a refund only moves forward' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.state = 'recorded' AND to_jsonb(NEW) - blankable - 'hold_used_minor' IS DISTINCT FROM to_jsonb(OLD) - blankable - 'hold_used_minor' THEN
    RAISE EXCEPTION 'a finished refund stays finished' USING ERRCODE = 'P0001';
  END IF;
  -- a cancelled refund occupies nothing: the money rules set its occupation to 0 just after cancelling it
  IF OLD.state = 'cancelled' AND (to_jsonb(NEW) - blankable - 'hold_used_minor' IS DISTINCT FROM to_jsonb(OLD) - blankable - 'hold_used_minor'
      OR NEW.hold_used_minor NOT IN (OLD.hold_used_minor, 0)) THEN
    RAISE EXCEPTION 'a finished refund stays finished' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.approved_by IS NOT NULL AND (NEW.approved_by, NEW.approved_at) IS DISTINCT FROM (OLD.approved_by, OLD.approved_at) THEN
    RAISE EXCEPTION 'an approval is never rewritten' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_payment_forward BEFORE UPDATE ON refund_payment FOR EACH ROW EXECUTE FUNCTION refund_payment_forward();

GRANT SELECT, INSERT ON refund_todo, refund_todo_event, hold_release, refund_payment TO bulma_app;
GRANT UPDATE (hold_released_minor) ON receipt TO bulma_app;
GRANT UPDATE (hold) ON refund_todo TO bulma_app;
GRANT UPDATE (state, actual_minor, hold_used_minor, approved_by, approved_at, due_at_approval, held_at_approval, sent_by, sent_at, recorded_by, recorded_at, sent_on, recall_evidence, cancelled_by, cancelled_at, exceptions) ON refund_payment TO bulma_app;

-- ---------- Chunk 5b1: unallocated money, moves, payment queries (PRD R-OPS-04, R-PAY-07, R-PAY-08, R-PAY-09) ----------

-- R-OPS-04: one list for the whole instance. Belongs to nobody and counts in no N. Allocating writes `receipt` rows.
-- A return (not identified) needs a second person; open until then.
CREATE TABLE unallocated_receipt (
  id uuid PRIMARY KEY,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 100000000000),
  received_on date NOT NULL,
  payer_name text NOT NULL CHECK (length(trim(payer_name)) BETWEEN 1 AND 200),
  payer_account text NOT NULL CHECK (length(trim(payer_account)) BETWEEN 1 AND 200),
  bank_ref text NOT NULL DEFAULT '' CHECK (length(bank_ref) <= 500),
  note text CHECK (note IS NULL OR length(note) <= 2000),
  -- money moved back here from a person's receipt
  from_receipt uuid REFERENCES receipt (id),
  owner uuid NOT NULL REFERENCES user_account (id),
  entered_by uuid NOT NULL REFERENCES user_account (id),
  outcome text NOT NULL DEFAULT 'open' CHECK (outcome IN ('open', 'allocated', 'split', 'returned')),
  decided_by uuid REFERENCES user_account (id),
  decided_at timestamptz,
  return_requested_by uuid REFERENCES user_account (id),
  return_requested_at timestamptz,
  return_basis text CHECK (return_basis IS NULL OR length(trim(return_basis)) BETWEEN 3 AND 2000),
  returned_approved_by uuid REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT decided_complete CHECK ((outcome = 'open') = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT request_complete CHECK ((return_requested_by IS NULL) = (return_requested_at IS NULL) AND (return_requested_by IS NULL) = (return_basis IS NULL)),
  CONSTRAINT return_second_person CHECK (
    (outcome = 'returned') = (returned_approved_by IS NOT NULL)
    AND (returned_approved_by IS NULL OR (return_requested_by IS NOT NULL AND returned_approved_by <> return_requested_by))
  )
);
CREATE INDEX unallocated_open ON unallocated_receipt (created_at) WHERE outcome = 'open';

-- a decided row stays decided
CREATE FUNCTION unallocated_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.outcome <> 'open' THEN
    RAISE EXCEPTION 'a decided unallocated receipt stays decided' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER unallocated_once BEFORE UPDATE ON unallocated_receipt FOR EACH ROW EXECUTE FUNCTION unallocated_once();

-- R-OPS-04: where a receipt came from. `moved_out_minor` is the part moved to another person or back to unallocated money;
-- what is left on this participation is amount − moved out, and the release covers only that part.
ALTER TABLE receipt DROP CONSTRAINT receipt_source_check;
ALTER TABLE receipt ADD CONSTRAINT receipt_source_check CHECK (source IN ('manual', 'unallocated', 'moved'));
ALTER TABLE receipt ADD COLUMN unallocated_id uuid REFERENCES unallocated_receipt (id);
ALTER TABLE receipt ADD COLUMN moved_from uuid REFERENCES receipt (id);
ALTER TABLE receipt ADD COLUMN moved_out_minor bigint NOT NULL DEFAULT 0 CHECK (moved_out_minor >= 0);
ALTER TABLE receipt ADD CONSTRAINT moved_within CHECK (moved_out_minor + hold_released_minor <= amount_minor);
ALTER TABLE receipt ADD CONSTRAINT source_complete CHECK (
  (source = 'unallocated') = (unallocated_id IS NOT NULL) AND (source = 'moved') = (moved_from IS NOT NULL)
);
CREATE INDEX receipt_moved_from ON receipt (moved_from) WHERE moved_from IS NOT NULL;

-- R-PAY-07, R-PAY-08: an investor's "my reference was wrong" report, and money from someone other than the investor, listed
-- for a reviewer. A third-party payment is approved or declined; a wrong-reference report is closed when dealt with.
CREATE TABLE payment_query (
  id uuid PRIMARY KEY,
  participation_id uuid NOT NULL REFERENCES participation (id),
  kind text NOT NULL CHECK (kind IN ('wrong_reference', 'third_party')),
  receipt_id uuid REFERENCES receipt (id),
  note text CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 2000),
  raised_by uuid NOT NULL REFERENCES user_account (id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'declined', 'closed')),
  decided_by uuid REFERENCES user_account (id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(trim(decision_note)) BETWEEN 3 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT receipt_when_third_party CHECK ((kind = 'third_party') = (receipt_id IS NOT NULL)),
  CONSTRAINT status_fits_kind CHECK (status IN ('open', CASE kind WHEN 'third_party' THEN 'approved' ELSE 'closed' END, CASE kind WHEN 'third_party' THEN 'declined' ELSE 'closed' END)),
  CONSTRAINT query_decided_complete CHECK ((status = 'open') = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL) AND (decided_by IS NULL) = (decision_note IS NULL))
);
CREATE UNIQUE INDEX payment_query_one_per_receipt ON payment_query (receipt_id) WHERE receipt_id IS NOT NULL;
-- one open report of a wrong reference per participation
CREATE UNIQUE INDEX payment_query_one_open_report ON payment_query (participation_id) WHERE kind = 'wrong_reference' AND status = 'open';

GRANT SELECT, INSERT ON unallocated_receipt, payment_query TO bulma_app;
GRANT UPDATE (outcome, decided_by, decided_at, owner, return_requested_by, return_requested_at, return_basis, returned_approved_by) ON unallocated_receipt TO bulma_app;
GRANT UPDATE (moved_out_minor) ON receipt TO bulma_app;
GRANT UPDATE (status, decided_by, decided_at, decision_note) ON payment_query TO bulma_app;
-- a decided query stays decided: not reopened, re-decided or given other evidence
CREATE FUNCTION payment_query_decided_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'a decided payment query stays decided' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_query_decided_once BEFORE UPDATE ON payment_query FOR EACH ROW EXECUTE FUNCTION payment_query_decided_once();

-- ---------- Chunk 5b2: statement import, Goten ledger read-back (PRD R-OPS-07, §5.7) ----------

-- R28 (1): Goten's ledger export carries no ledger ID, so the operator names a ledger at its first import, per deal.
CREATE TABLE goten_ledger (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deal (id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  created_by uuid NOT NULL REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (deal_id, name)
);

-- The staging area: a file read and reviewed, nothing counted until a person decides each row (Goten R-REC-04.3).
CREATE TABLE goten_import (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('statement', 'ledger')),
  -- 'acct:<sha256>' for a receiving account, 'ledger:<id>' for a named Goten ledger
  scope text NOT NULL CHECK (scope ~ '^(acct:[0-9a-f]{64}|ledger:[0-9a-f-]{36})$'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  ledger_id uuid REFERENCES goten_ledger (id),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by uuid NOT NULL REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ledger_named CHECK ((kind = 'ledger') = (ledger_id IS NOT NULL))
);

-- One proposal per row: a bank line (statement match or unallocated, ledger added or changed) or a receipt gone from the ledger.
CREATE TABLE goten_import_row (
  import_id uuid NOT NULL REFERENCES goten_import (id),
  n integer NOT NULL CHECK (n > 0),
  kind text NOT NULL CHECK (kind IN ('match', 'unallocated', 'added', 'changed', 'gone')),
  file_line integer,
  -- sha256 of the line's §5.7 identity and of its details; the identity can hold the payer's name, so only its hash is kept
  key_sha256 text CHECK (key_sha256 ~ '^[0-9a-f]{64}$'),
  fingerprint_sha256 text CHECK (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  received_on date,
  amount_minor bigint CHECK (amount_minor > 0 AND amount_minor <= 100000000000),
  payer text,
  reference text,
  transaction_id text,
  participation_id uuid REFERENCES participation (id),
  -- the receipt a changed or gone row is about
  receipt_id uuid REFERENCES receipt (id),
  proposal jsonb NOT NULL,
  decision text CHECK (decision IN ('record', 'pair', 'unallocated', 'skip', 'reverse', 'keep')),
  decided_by uuid REFERENCES user_account (id),
  decided_at timestamptz,
  PRIMARY KEY (import_id, n),
  CONSTRAINT decided_complete CHECK ((decision IS NULL) = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT line_complete CHECK ((kind = 'gone') = (key_sha256 IS NULL) AND (kind = 'gone') = (amount_minor IS NULL))
);

-- §5.7 identity of a bank line taken in, per scope: what it became (a receipt, unallocated money, or nothing when a person
-- said it was not money to count). A receipt can carry lines from several scopes once paired; it counts once.
-- `origin`: the receipt was made from this line. A ledger is a full snapshot, so its lines can end; a statement's never do.
CREATE TABLE imported_line (
  id uuid PRIMARY KEY,
  scope text NOT NULL,
  key_sha256 text NOT NULL CHECK (key_sha256 ~ '^[0-9a-f]{64}$'),
  fingerprint_sha256 text NOT NULL CHECK (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_id uuid REFERENCES receipt (id),
  unallocated_id uuid REFERENCES unallocated_receipt (id),
  origin boolean NOT NULL,
  import_id uuid NOT NULL REFERENCES goten_import (id),
  created_by uuid NOT NULL REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  ended_by uuid REFERENCES user_account (id),
  CONSTRAINT one_target CHECK (receipt_id IS NULL OR unallocated_id IS NULL),
  CONSTRAINT origin_has_target CHECK (NOT origin OR receipt_id IS NOT NULL OR unallocated_id IS NOT NULL),
  CONSTRAINT ended_complete CHECK ((ended_at IS NULL) = (ended_by IS NULL)),
  CONSTRAINT statements_never_end CHECK (ended_at IS NULL OR scope LIKE 'ledger:%')
);
-- re-importing never counts a line twice
CREATE UNIQUE INDEX imported_line_once ON imported_line (scope, key_sha256) WHERE ended_at IS NULL;
-- a receipt carries at most one live line per scope
CREATE UNIQUE INDEX imported_line_receipt_scope ON imported_line (receipt_id, scope) WHERE ended_at IS NULL AND receipt_id IS NOT NULL;
CREATE INDEX imported_line_receipt ON imported_line (receipt_id) WHERE receipt_id IS NOT NULL;

-- an ended line stays ended
CREATE FUNCTION imported_line_end_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'an ended imported line stays ended' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER imported_line_end_once BEFORE UPDATE ON imported_line FOR EACH ROW EXECUTE FUNCTION imported_line_end_once();

-- a decided import row stays decided
CREATE FUNCTION goten_import_row_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.decision IS NOT NULL THEN
    RAISE EXCEPTION 'a decided import row stays decided' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER goten_import_row_once BEFORE UPDATE ON goten_import_row FOR EACH ROW EXECUTE FUNCTION goten_import_row_once();

ALTER TABLE receipt DROP CONSTRAINT receipt_source_check;
ALTER TABLE receipt ADD CONSTRAINT receipt_source_check CHECK (source IN ('manual', 'unallocated', 'moved', 'statement', 'ledger'));

GRANT SELECT, INSERT ON goten_ledger, goten_import, goten_import_row, imported_line TO bulma_app;
GRANT UPDATE (decision, decided_by, decided_at) ON goten_import_row TO bulma_app;
GRANT UPDATE (ended_at, ended_by) ON imported_line TO bulma_app;

-- ---------- D4 chunk 6a: the deal after `live`, removal, withdrawal, cancellation (PRD §5.1, R-WDR-01..05, R-CLS-01) ----------

-- `settled` and `closed` are written only from D5; they are allowed now so the column holds every state a gate judges
ALTER TABLE deal DROP CONSTRAINT deal_state_check;
ALTER TABLE deal ADD CONSTRAINT deal_state_check CHECK (
  state IN ('draft', 'in_review', 'changes_requested', 'rejected', 'approved', 'live', 'closing_requested', 'closing', 'settled', 'closed', 'cancelled', 'archived')
);

-- R-WDR-03: a cancellation is asked for by a lead (a reviewer confirms) or a reviewer (a second person confirms); one open at a time
CREATE TABLE cancel_request (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deal (id),
  asked_by uuid NOT NULL REFERENCES user_account (id),
  asked_as text NOT NULL CHECK (asked_as IN ('lead', 'reviewer')),
  reason text CHECK (reason IS NULL OR length(reason) <= 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- declined by a reviewer, or lapsed when the deal left the states a cancellation applies to
  decision text CHECK (decision IN ('confirmed', 'declined', 'lapsed')),
  decided_by uuid REFERENCES user_account (id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 2000),
  CONSTRAINT decided_complete CHECK ((decision IS NULL) = (decided_at IS NULL) AND (decision = 'lapsed' OR (decision IS NULL) = (decided_by IS NULL))),
  CONSTRAINT someone_else CHECK (decided_by IS NULL OR decided_by <> asked_by)
);
CREATE UNIQUE INDEX cancel_request_one_open ON cancel_request (deal_id) WHERE decision IS NULL;

-- R-WDR-02: a withdrawal needs the investor's written consent; a reviewer with no stake accepts the evidence
CREATE TABLE withdrawal_request (
  id uuid PRIMARY KEY,
  participation_id uuid NOT NULL REFERENCES participation (id),
  asked_by uuid NOT NULL REFERENCES user_account (id),
  consent_confirmed boolean NOT NULL CHECK (consent_confirmed),
  -- where the written consent is: the email or letter as received, or where the signed copy is kept
  evidence text NOT NULL CHECK (length(trim(evidence)) BETWEEN 3 AND 5000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- lapsed: the participation ended another way first
  decision text CHECK (decision IN ('accepted', 'declined', 'lapsed')),
  decided_by uuid REFERENCES user_account (id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 2000),
  CONSTRAINT decided_complete CHECK ((decision IS NULL) = (decided_at IS NULL) AND (decision = 'lapsed' OR (decision IS NULL) = (decided_by IS NULL)))
);
CREATE UNIQUE INDEX withdrawal_request_one_open ON withdrawal_request (participation_id) WHERE decision IS NULL;

-- a decided request stays decided
CREATE FUNCTION request_decided_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.decision IS NOT NULL THEN
    RAISE EXCEPTION 'a decided request stays decided' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cancel_request_once BEFORE UPDATE ON cancel_request FOR EACH ROW EXECUTE FUNCTION request_decided_once();
CREATE TRIGGER withdrawal_request_once BEFORE UPDATE ON withdrawal_request FOR EACH ROW EXECUTE FUNCTION request_decided_once();

-- R-WDR-05: the operator's words on what cancelling may cost; shown to whoever asks for a cancellation
ALTER TABLE operator_policy ADD COLUMN cancel_fee_note text CHECK (cancel_fee_note IS NULL OR length(cancel_fee_note) BETWEEN 1 AND 2000);

GRANT SELECT, INSERT ON cancel_request, withdrawal_request TO bulma_app;
GRANT UPDATE (decision, decided_by, decided_at, decision_note) ON cancel_request, withdrawal_request TO bulma_app;

-- ---------- D4 chunk 6b: amount proposals, the waiting list (R-ALO-01, R-ALO-03, R-ALO-04) ----------

-- R-ALO-01: the lead proposes a new commitment; it takes effect only when the investor agrees. One open per participation.
CREATE TABLE amount_proposal (
  id uuid PRIMARY KEY,
  participation_id uuid NOT NULL REFERENCES participation (id),
  proposed_by uuid NOT NULL REFERENCES user_account (id),
  from_commitment_minor bigint NOT NULL CHECK (from_commitment_minor > 0),
  proposed_minor bigint NOT NULL CHECK (proposed_minor > 0 AND proposed_minor <> from_commitment_minor),
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- accepted takes effect; every other end leaves the amount as it was
  decision text CHECK (decision IN ('accepted', 'declined', 'lapsed', 'money_arrived', 'closing_requested', 'part_ended')),
  decided_at timestamptz,
  CONSTRAINT decided_complete CHECK ((decision IS NULL) = (decided_at IS NULL))
);
CREATE UNIQUE INDEX amount_proposal_one_open ON amount_proposal (participation_id) WHERE decision IS NULL;
CREATE TRIGGER amount_proposal_once BEFORE UPDATE ON amount_proposal FOR EACH ROW EXECUTE FUNCTION request_decided_once();

-- R-ALO-04: no participation, no D, no reference, no instruction. One waiting or let-in entry per invitation.
CREATE TABLE waitlist_entry (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deal (id),
  invitation_id uuid NOT NULL REFERENCES deal_invitation (id),
  user_id uuid NOT NULL REFERENCES user_account (id),
  desired_minor bigint NOT NULL CHECK (desired_minor > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'released', 'committed', 'ended')),
  released_by uuid REFERENCES user_account (id),
  released_at timestamptz,
  -- left: the investor took themselves off; closing_requested, cancelled: the deal moved on
  end_reason text CHECK (end_reason IN ('left', 'closing_requested', 'cancelled')),
  ended_at timestamptz,
  CONSTRAINT released_complete CHECK ((released_by IS NULL) = (released_at IS NULL) AND (state <> 'released' OR released_at IS NOT NULL)),
  CONSTRAINT ended_complete CHECK ((state IN ('committed', 'ended')) = (ended_at IS NOT NULL) AND (state = 'ended') = (end_reason IS NOT NULL))
);
CREATE UNIQUE INDEX waitlist_entry_one_open ON waitlist_entry (invitation_id) WHERE state IN ('waiting', 'released');
CREATE INDEX waitlist_entry_deal ON waitlist_entry (deal_id) WHERE state IN ('waiting', 'released');

-- an entry that was taken up or ended stays so
CREATE FUNCTION waitlist_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('committed', 'ended') THEN
    RAISE EXCEPTION 'a finished waiting-list entry stays finished' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER waitlist_entry_final BEFORE UPDATE ON waitlist_entry FOR EACH ROW EXECUTE FUNCTION waitlist_final();

-- R-ALO-01: the working days an investor has to answer a proposed amount
ALTER TABLE operator_policy ADD COLUMN amount_proposal_days integer NOT NULL DEFAULT 5 CHECK (amount_proposal_days BETWEEN 1 AND 30);

GRANT SELECT, INSERT ON amount_proposal, waitlist_entry TO bulma_app;
GRANT UPDATE (decision, decided_at) ON amount_proposal TO bulma_app;
GRANT UPDATE (state, released_by, released_at, end_reason, ended_at) ON waitlist_entry TO bulma_app;

-- ---------- D4 chunk 7: changes to a live deal and reconfirmation (R-CHG-01..05, R-CMP-02, §5.3) ----------

-- R-CHG-01: the lead's own dates take effect with no reviewer and no content approval (R-CMP-02's exempt fields)
ALTER TABLE deal_version DROP CONSTRAINT deal_version_kind_check;
ALTER TABLE deal_version ADD CONSTRAINT deal_version_kind_check CHECK (kind IN ('submitted', 'edited', 'approved', 'self_service'));

-- R-CHG-02: a change the lead asks for, judged by a reviewer with no stake, in force only with the content approval (R-CMP-02).
-- The lead's own dates are kept here too, applied at once, so every change has its plain sentence and its differences.
CREATE TABLE change_request (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deal (id),
  -- the approved version it was written against: if another takes effect first, this one must be made again
  base_version integer NOT NULL,
  proposed jsonb NOT NULL,
  -- the content as it will be approved, made once when asked, so a reviewer and an approver decide on what they read
  proposed_snapshot jsonb NOT NULL,
  proposed_sha256 text NOT NULL CHECK (proposed_sha256 ~ '^[0-9a-f]{64}$'),
  summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 300),
  -- the classifier's answer when it was asked (items, differences, people below a raised minimum, signing again)
  classification jsonb NOT NULL,
  self_service boolean NOT NULL,
  submitted_by uuid NOT NULL REFERENCES user_account (id),
  state text NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted', 'reviewed', 'applied', 'returned', 'withdrawn')),
  verdict text CHECK (verdict IN ('notice', 'reconfirm')),
  verdict_reason text CHECK (verdict_reason IS NULL OR length(trim(verdict_reason)) BETWEEN 1 AND 2000),
  reviewed_by uuid REFERENCES user_account (id),
  reviewed_at timestamptz,
  return_reason text CHECK (return_reason IS NULL OR length(trim(return_reason)) BETWEEN 1 AND 2000),
  applied_version integer,
  applied_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT reviewed_complete CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL) AND (self_service OR state NOT IN ('reviewed', 'applied') OR reviewed_by IS NOT NULL)),
  CONSTRAINT verdict_has_reason CHECK ((verdict IS NULL) = (verdict_reason IS NULL)),
  CONSTRAINT applied_complete CHECK ((state = 'applied') = (applied_version IS NOT NULL) AND (applied_version IS NULL) = (applied_at IS NULL)),
  CONSTRAINT returned_has_reason CHECK ((state = 'returned') = (return_reason IS NOT NULL)),
  CONSTRAINT ended_complete CHECK ((state IN ('applied', 'returned', 'withdrawn')) = (ended_at IS NOT NULL)),
  CONSTRAINT applied_version_exists FOREIGN KEY (deal_id, applied_version) REFERENCES deal_version (deal_id, n)
);
-- one change at a time: each is judged against the version investors see
CREATE UNIQUE INDEX change_request_one_open ON change_request (deal_id) WHERE state IN ('submitted', 'reviewed');
CREATE INDEX change_request_deal ON change_request (deal_id, created_at);

CREATE FUNCTION change_request_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('applied', 'returned', 'withdrawn') THEN
    RAISE EXCEPTION 'a finished change request stays finished' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.proposed IS DISTINCT FROM OLD.proposed OR NEW.proposed_snapshot IS DISTINCT FROM OLD.proposed_snapshot OR NEW.proposed_sha256 <> OLD.proposed_sha256 OR NEW.summary <> OLD.summary OR NEW.base_version <> OLD.base_version THEN
    RAISE EXCEPTION 'what was asked for does not change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER change_request_final BEFORE UPDATE ON change_request FOR EACH ROW EXECUTE FUNCTION change_request_final();

-- §5.3: the deal version this person last agreed to, at commitment or by reconfirming; differences are shown against it
ALTER TABLE participation ADD COLUMN agreed_version integer;

-- §5.3: one person asked to agree to a change. A newer change replaces the one still waiting (superseded).
CREATE TABLE reconfirmation (
  id uuid PRIMARY KEY,
  participation_id uuid NOT NULL REFERENCES participation (id),
  change_id uuid NOT NULL REFERENCES change_request (id),
  deal_id uuid NOT NULL REFERENCES deal (id),
  -- the version to agree to, and the one the person last agreed to
  deal_version integer NOT NULL,
  compared_to integer NOT NULL,
  -- the deal sheet changed, so agreeing means signing again
  resign boolean NOT NULL,
  -- §5.3: working days to answer, from the operator's setting when asked; a later change of setting does not move it
  days integer NOT NULL CHECK (days BETWEEN 1 AND 30),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'agreed', 'declined', 'superseded', 'ended')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by uuid REFERENCES user_account (id),
  decided_at timestamptz,
  -- agreeing to a changed deal sheet signs it again: the new signature
  signature_id uuid REFERENCES signature_record (id),
  CONSTRAINT decided_complete CHECK ((state = 'pending') = (decided_at IS NULL)),
  CONSTRAINT signed_when_agreed CHECK (signature_id IS NULL OR state = 'agreed'),
  CONSTRAINT version_exists FOREIGN KEY (deal_id, deal_version) REFERENCES deal_version (deal_id, n)
);
CREATE UNIQUE INDEX reconfirmation_one_pending ON reconfirmation (participation_id) WHERE state = 'pending';
CREATE INDEX reconfirmation_deal ON reconfirmation (deal_id) WHERE state = 'pending';

CREATE FUNCTION reconfirmation_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'a decided reconfirmation stays decided' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reconfirmation_final BEFORE UPDATE ON reconfirmation FOR EACH ROW EXECUTE FUNCTION reconfirmation_final();

GRANT SELECT, INSERT ON change_request, reconfirmation TO bulma_app;
GRANT UPDATE (state, verdict, verdict_reason, reviewed_by, reviewed_at, return_reason, applied_version, applied_at, ended_at) ON change_request TO bulma_app;
-- deal_version: a later change that asks nothing of the person moves their pending one onto the version in force
GRANT UPDATE (state, decided_by, decided_at, signature_id, deal_version) ON reconfirmation TO bulma_app;
GRANT UPDATE (agreed_version) ON participation TO bulma_app;

-- ---------- D4 chunk 7b: the investor's answer, the deadline and silence (§5.3) ----------

-- §5.3: working days to reconfirm, 5 by default; a deadline for an answer, not a safety switch
ALTER TABLE operator_policy ADD COLUMN reconfirm_days integer NOT NULL DEFAULT 5 CHECK (reconfirm_days BETWEEN 1 AND 30);

-- §5.3: a person whose part ends (removed, withdrawn, cancelled, rejected, excluded) has nothing left to reconfirm
CREATE FUNCTION reconfirmation_end_with_part() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE reconfirmation SET state = 'ended', decided_at = clock_timestamp() WHERE participation_id = NEW.id AND state = 'pending';
  RETURN NEW;
END $$;
CREATE TRIGGER reconfirmation_end_with_part AFTER UPDATE OF outcome ON participation FOR EACH ROW
  WHEN (OLD.outcome = 'active' AND NEW.outcome <> 'active') EXECUTE FUNCTION reconfirmation_end_with_part();

-- §5.3: a person with money on hand stayed silent past the deadline; the operator recorded the decision to exclude them and
-- refund, after the pack's notice. What they were told and why are kept as evidence; only inserted.
CREATE TABLE reconfirm_exclusion (
  id uuid PRIMARY KEY,
  reconfirmation_id uuid NOT NULL UNIQUE REFERENCES reconfirmation (id),
  participation_id uuid NOT NULL REFERENCES participation (id),
  decided_by uuid NOT NULL REFERENCES user_account (id),
  deadline_at timestamptz NOT NULL,
  notice_text text NOT NULL CHECK (length(notice_text) BETWEEN 1 AND 20000),
  notice_sha256 text NOT NULL CHECK (notice_sha256 ~ '^[0-9a-f]{64}$'),
  pack_id uuid NOT NULL REFERENCES regime_pack (id),
  evidence text NOT NULL CHECK (length(evidence) BETWEEN 3 AND 5000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER reconfirm_exclusion_only_new BEFORE UPDATE OR DELETE ON reconfirm_exclusion FOR EACH ROW EXECUTE FUNCTION refuse_change();
GRANT SELECT, INSERT ON reconfirm_exclusion TO bulma_app;

-- ---------- D4 chunk 7c: one person's terms changed (R-CHG-02 last line) ----------

-- a change to one person's link terms: the invitation whose frozen terms it changes. Null = a change to the whole deal.
-- For these, `proposed` is the new terms and `proposed_snapshot` the terms before and after.
ALTER TABLE change_request ADD COLUMN invitation_id uuid REFERENCES deal_invitation (id);

-- R-LNK-05, R-CHG-02: every set of terms an invitation has had once one person's terms were changed. n = 0 is the set frozen at the
-- first commitment, written with the first change; the invitation holds the latest. Only inserted.
CREATE TABLE invitation_terms (
  invitation_id uuid NOT NULL REFERENCES deal_invitation (id),
  n integer NOT NULL CHECK (n >= 0),
  terms jsonb NOT NULL,
  change_id uuid REFERENCES change_request (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (invitation_id, n),
  CONSTRAINT first_is_frozen CHECK ((n = 0) = (change_id IS NULL))
);
CREATE TRIGGER invitation_terms_only_new BEFORE UPDATE OR DELETE ON invitation_terms FOR EACH ROW EXECUTE FUNCTION refuse_change();
GRANT SELECT, INSERT ON invitation_terms TO bulma_app;

-- frozen terms still never change on their own: only to the latest set a change request wrote (the link and the time stay)
CREATE OR REPLACE FUNCTION invitation_terms_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.terms_frozen_at IS NOT NULL AND (NEW.terms_frozen_at, NEW.invite_link) IS DISTINCT FROM (OLD.terms_frozen_at, OLD.invite_link) THEN
    RAISE EXCEPTION 'frozen terms cannot change' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.terms_frozen_at IS NOT NULL AND NEW.terms_snapshot IS DISTINCT FROM OLD.terms_snapshot AND NOT EXISTS (
    SELECT 1 FROM invitation_terms t WHERE t.invitation_id = NEW.id AND t.change_id IS NOT NULL AND t.terms = NEW.terms_snapshot
       AND t.n = (SELECT max(n) FROM invitation_terms WHERE invitation_id = NEW.id)) THEN
    RAISE EXCEPTION 'frozen terms cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- the set of terms (invitation_terms.n) the person last agreed to; 0 = those frozen at the first commitment
ALTER TABLE participation ADD COLUMN agreed_terms_n integer NOT NULL DEFAULT 0;
GRANT UPDATE (agreed_terms_n) ON participation TO bulma_app;
-- the set of terms to agree to, and the one last agreed, as `deal_version` and `compared_to` are for the deal
ALTER TABLE reconfirmation ADD COLUMN terms_n integer NOT NULL DEFAULT 0, ADD COLUMN terms_compared_to integer NOT NULL DEFAULT 0;

-- R-PIP-06 (decision R29): a lead confirmed the operator's text on whom to invite, by version, before importing a list or
-- sending a targeted invitation. Another lead's confirmation does not count. Evidence only; only inserted.
CREATE TABLE invitee_policy_ack (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_account (id),
  pack_id uuid NOT NULL REFERENCES regime_pack (id),
  text_version integer NOT NULL CHECK (text_version > 0),
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  deal_id uuid NOT NULL REFERENCES deal (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX invitee_policy_ack_user ON invitee_policy_ack (user_id, created_at);
CREATE TRIGGER invitee_policy_ack_only_new BEFORE UPDATE OR DELETE ON invitee_policy_ack FOR EACH ROW EXECUTE FUNCTION refuse_change();
GRANT SELECT, INSERT ON invitee_policy_ack TO bulma_app;

-- R-COM-01..04 (chunk 8d): the lead's messages, kept (R-COM-03). Free text is promotional: it needs approved content
-- (`promotion_approval` with subject_kind 'message', R-CMP-02) and goes to each person as decided for them (R-COM-04).
-- Editable until sent; the text is what the approval's hash is over.
CREATE TABLE message (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deal (id),
  author uuid NOT NULL REFERENCES user_account (id),
  kind text NOT NULL CHECK (kind IN ('bulk', 'single')),
  -- bulk: the filter chosen (R-COM-01); single: the row it was written from (R-COM-02)
  audience jsonb,
  invitation_id uuid REFERENCES deal_invitation (id),
  subject text,
  body text,
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  -- tech design §3.1: the text goes when its time comes; the record that a message was sent stays
  erased_at timestamptz,
  CHECK ((kind = 'single') = (invitation_id IS NOT NULL)),
  CHECK ((kind = 'bulk') = (audience IS NOT NULL)),
  CHECK ((erased_at IS NULL) = (subject IS NOT NULL AND body IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE INDEX message_deal ON message (deal_id, created_at);
-- a sent message stays as it went: only its erasure when its time comes changes the text (R-COM-03, R-AUD-02)
CREATE FUNCTION message_sent_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sent_at IS NOT NULL AND (NEW.sent_at IS DISTINCT FROM OLD.sent_at
      OR (NEW.erased_at IS NULL AND (NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body IS DISTINCT FROM OLD.body OR NEW.sha256 IS DISTINCT FROM OLD.sha256))) THEN
    RAISE EXCEPTION 'a sent message stays as it was sent' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_sent_fixed BEFORE UPDATE ON message FOR EACH ROW EXECUTE FUNCTION message_sent_fixed();

-- one row per person a sent message was meant for: whether they got it, a sign-in notice, or nothing and why
CREATE TABLE message_recipient (
  message_id uuid NOT NULL REFERENCES message (id),
  user_id uuid NOT NULL REFERENCES user_account (id),
  delivery text NOT NULL CHECK (delivery IN ('message', 'notice', 'excluded')),
  exclusion text CHECK (exclusion IN ('no_account', 'ended', 'held')),
  outbox_id uuid REFERENCES notification_outbox (id),
  PRIMARY KEY (message_id, user_id),
  CHECK ((delivery = 'excluded') = (exclusion IS NOT NULL)),
  CHECK ((delivery = 'excluded') = (outbox_id IS NULL))
);
CREATE INDEX message_recipient_user ON message_recipient (user_id);
CREATE TRIGGER message_recipient_only_new BEFORE UPDATE ON message_recipient FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- a message is decided again before each attempt, as the person and the deal are then; replies go to its author (R-COM-02)
ALTER TABLE notification_outbox ADD COLUMN message_id uuid REFERENCES message (id);
ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_audience_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_audience_check
  CHECK (audience IN ('address', 'urgent', 'account', 'invite', 'lead', 'reminder', 'message'));
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_message
  CHECK ((audience = 'message') = (message_id IS NOT NULL AND user_id IS NOT NULL AND deal_id IS NOT NULL));
ALTER TABLE sandbox_outbox ADD COLUMN reply_to text;

GRANT SELECT, INSERT ON message, message_recipient TO bulma_app;
GRANT UPDATE (subject, body, sha256, updated_at, sent_at) ON message TO bulma_app;
-- tech design §3.1: a person's rows go with them; the text of a message goes on the deal's clock (chunk 9)
GRANT SELECT (message_id, user_id), DELETE ON message_recipient TO bulma_maintenance;
GRANT SELECT (id, deal_id, sent_at, erased_at), UPDATE (subject, body, sha256, erased_at) ON message TO bulma_maintenance;

-- R-OPS-02 (chunk 9a): the to-do list is worked out from the facts each time (`lib/workQueue.ts`); only who works on an item is
-- stored. Only inserted: the latest row for a key is who is on it now, null when nobody; the rows before are its history.
CREATE TABLE work_item_assignment (
  id uuid PRIMARY KEY,
  item_key text NOT NULL CHECK (length(item_key) BETWEEN 3 AND 120),
  assignee uuid REFERENCES user_account (id),
  assigned_by uuid NOT NULL REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX work_item_assignment_key ON work_item_assignment (item_key, created_at DESC);
CREATE TRIGGER work_item_assignment_only_new BEFORE UPDATE OR DELETE ON work_item_assignment FOR EACH ROW EXECUTE FUNCTION refuse_change();
GRANT SELECT, INSERT ON work_item_assignment TO bulma_app;

-- R-AUD-05, decision R28 (5) (chunk 9b): complaints are registered here, from the investor's form or entered by staff from
-- an email; each is on the to-do list until acknowledged, due 30 days after it was received (DUAA 2025 s.103 / DPA 2018
-- s.164A). The operator may give an address for complaints, shown next to the form.
ALTER TABLE operator_policy ADD COLUMN complaints_email text CHECK (complaints_email IS NULL OR length(complaints_email) BETWEEN 3 AND 320);
CREATE TABLE complaint (
  id uuid PRIMARY KEY,
  channel text NOT NULL CHECK (channel IN ('form', 'email')),
  user_id uuid REFERENCES user_account (id),
  from_address text CHECK (from_address IS NULL OR length(from_address) BETWEEN 3 AND 320),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  received_at timestamptz NOT NULL,
  recorded_by uuid REFERENCES user_account (id),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES user_account (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- the form is the person's own; an email is entered by staff, from an address
  CONSTRAINT complaint_source CHECK (
    (channel = 'form' AND user_id IS NOT NULL AND from_address IS NULL AND recorded_by IS NULL)
    OR (channel = 'email' AND user_id IS NULL AND from_address IS NOT NULL AND recorded_by IS NOT NULL)
  ),
  CONSTRAINT acknowledged_complete CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL))
);
CREATE INDEX complaint_open ON complaint (received_at) WHERE acknowledged_at IS NULL;
CREATE INDEX complaint_user ON complaint (user_id);
GRANT SELECT, INSERT ON complaint TO bulma_app;
GRANT UPDATE (acknowledged_at, acknowledged_by) ON complaint TO bulma_app;

-- Retention for D2–D4 records (PRD §5.6, R-KYC-04, tech design §3.1; TC-KYC-07). Three clocks:
--  * the person's: what the expiry job removes with a person, now also their parts in deals;
--  * the deal's: contacts and carry recipients (no account), investee files, messages, the lead's list, from `deal.ended_at`;
--  * the transaction records': payer details on money rows go after `transaction_years` (MLR reg 40(4)), even while the
--    relationship goes on. The date is each row's own money date, read with the period as it is now (see the tech design).
-- A legal hold on the person or the deal stops all three.
ALTER TABLE retention_config ADD COLUMN transaction_years integer NOT NULL DEFAULT 10 CHECK (transaction_years BETWEEN 0 AND 10);
ALTER TABLE person_version ADD COLUMN anonymised_at timestamptz;
ALTER TABLE deal ADD COLUMN records_erased_at timestamptz;

-- Rows that otherwise only take new rows, or move one way, still let the expiry job delete or blank them. What it can
-- change is set by its column grants below; the app role is refused as before.
CREATE FUNCTION only_new_but_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'bulma_maintenance' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% on % is not allowed: this table only takes new rows', TG_OP, TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
DROP TRIGGER participation_event_only_new ON participation_event;
CREATE TRIGGER participation_event_only_new BEFORE UPDATE OR DELETE ON participation_event FOR EACH ROW EXECUTE FUNCTION only_new_but_expiry();
DROP TRIGGER instruction_ack_only_new ON instruction_ack;
CREATE TRIGGER instruction_ack_only_new BEFORE UPDATE OR DELETE ON instruction_ack FOR EACH ROW EXECUTE FUNCTION only_new_but_expiry();
DROP TRIGGER deal_view_only_new ON deal_view;
CREATE TRIGGER deal_view_only_new BEFORE UPDATE OR DELETE ON deal_view FOR EACH ROW EXECUTE FUNCTION only_new_but_expiry();
DROP TRIGGER deal_message_only_new ON deal_message;
CREATE TRIGGER deal_message_only_new BEFORE UPDATE OR DELETE ON deal_message FOR EACH ROW EXECUTE FUNCTION only_new_but_expiry();
DROP TRIGGER invitee_policy_ack_only_new ON invitee_policy_ack;
CREATE TRIGGER invitee_policy_ack_only_new BEFORE UPDATE OR DELETE ON invitee_policy_ack FOR EACH ROW EXECUTE FUNCTION only_new_but_expiry();
DROP TRIGGER reconfirm_exclusion_only_new ON reconfirm_exclusion;
CREATE TRIGGER reconfirm_exclusion_only_new BEFORE UPDATE OR DELETE ON reconfirm_exclusion FOR EACH ROW EXECUTE FUNCTION only_new_but_expiry();

CREATE OR REPLACE FUNCTION signature_evidence_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- the expiry job blanks the name, address and text it may update; the hash, dates and state stay (its grants)
  IF current_user = 'bulma_maintenance' THEN
    RETURN NEW;
  END IF;
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'a superseded signature stays superseded' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.external_status, NEW.signed_name, NEW.signed_at) IS DISTINCT FROM (OLD.external_status, OLD.signed_name, OLD.signed_at)
     AND NOT (OLD.provider = 'external' AND OLD.external_status = 'sent' AND NEW.external_status = 'signed' AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NULL) THEN
    RAISE EXCEPTION 'signature evidence cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION unallocated_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.outcome <> 'open' AND current_user <> 'bulma_maintenance' THEN
    RAISE EXCEPTION 'a decided unallocated receipt stays decided' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION change_request_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- the expiry job may only take the contact's and recipients' names out of what was asked for (its grants)
  IF current_user = 'bulma_maintenance' THEN
    RETURN NEW;
  END IF;
  IF OLD.state IN ('applied', 'returned', 'withdrawn') THEN
    RAISE EXCEPTION 'a finished change request stays finished' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.proposed IS DISTINCT FROM OLD.proposed OR NEW.proposed_snapshot IS DISTINCT FROM OLD.proposed_snapshot OR NEW.proposed_sha256 <> OLD.proposed_sha256 OR NEW.summary <> OLD.summary OR NEW.base_version <> OLD.base_version THEN
    RAISE EXCEPTION 'what was asked for does not change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

GRANT UPDATE (to_address) ON notification_outbox TO bulma_maintenance;
GRANT SELECT (id, user_id, deal_id, outcome, invested_minor, holding_ended_at) ON participation TO bulma_maintenance;
GRANT SELECT (id, state, draft, ended_at, retention_hold, records_erased_at), UPDATE (draft, records_erased_at) ON deal TO bulma_maintenance;
GRANT SELECT (participation_id), DELETE ON participation_event, instruction_ack, payment_query, withdrawal_request, refund_todo_event, reconfirm_exclusion TO bulma_maintenance;
GRANT SELECT (id, created_at) ON participation_event, payment_query, withdrawal_request TO bulma_maintenance;
-- open work waits: a query or request still undecided is not deleted
GRANT SELECT (status) ON payment_query TO bulma_maintenance;
GRANT SELECT (decision) ON withdrawal_request TO bulma_maintenance;
GRANT SELECT (user_id), DELETE ON deal_view, invitee_policy_ack, pending_invite TO bulma_maintenance;
GRANT SELECT (deal_id, author), DELETE ON deal_message TO bulma_maintenance;
GRANT SELECT (id, user_id, channel, from_address, received_at), DELETE ON complaint TO bulma_maintenance;
GRANT SELECT (import_id, participation_id, received_on, decision), DELETE ON goten_import_row TO bulma_maintenance;
GRANT SELECT (id, created_at) ON goten_import TO bulma_maintenance;
GRANT SELECT (participation_id), UPDATE (signed_name, ip, document, document_lead) ON signature_record TO bulma_maintenance;
GRANT SELECT (id, participation_id, unallocated_id, received_on, payer_name), UPDATE (payer_name, payer_account, note) ON receipt TO bulma_maintenance;
GRANT SELECT (id, from_receipt, received_on, payer_name, return_basis, outcome), UPDATE (payer_name, payer_account, bank_ref, note, return_basis) ON unallocated_receipt TO bulma_maintenance;
GRANT SELECT (participation_id, state, evidence, recall_evidence, source_name, prepared_at, sent_at, recorded_at, cancelled_at, created_at),
  UPDATE (source_name, source_account, dest_name, dest_account, evidence, recall_evidence) ON refund_payment TO bulma_maintenance;
GRANT SELECT (participation_id, basis), UPDATE (basis) ON hold_release TO bulma_maintenance;
GRANT SELECT (id, deal_id, email, consumed_by), UPDATE (email) ON targeted_invite TO bulma_maintenance;
GRANT SELECT (deal_id, name, email, targeted_invite), UPDATE (name, email, private_note) ON pipeline_entry TO bulma_maintenance;
GRANT SELECT (id, anonymised_at), UPDATE (fields, anonymised_at) ON person_version TO bulma_maintenance;
GRANT SELECT (id, deal_id, contact_version, extra_contact_versions) ON investee TO bulma_maintenance;
GRANT SELECT (deal_id, person_version) ON carry_recipient TO bulma_maintenance;
GRANT SELECT (deal_id, snapshot) ON deal_version TO bulma_maintenance;
GRANT SELECT (id, deal_id, proposed, proposed_snapshot), UPDATE (proposed) ON change_request TO bulma_maintenance;
GRANT SELECT (scope) ON stored_file TO bulma_maintenance;
GRANT SELECT (user_id, deal_id, state) ON deal_invitation TO bulma_maintenance;
