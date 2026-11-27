-- Demo deal seed (PRD §4.19 R-DEMO-03..08, decision R30, plan 05 §4). Grows step by step until the S pull request.

-- R-DEMO-04: each run of the seed. A run is adding, added, or retired (failed, interrupted, or cleared at the switch to
-- the real mode). At most one run is adding or added; a retired run does not count, so the seed may run again with new ids.
CREATE TABLE demo_run (
  id uuid PRIMARY KEY,
  started_by uuid REFERENCES user_account (id), -- null when the developer's start-up setting started it
  via text NOT NULL CHECK (via IN ('button', 'env')),
  state text NOT NULL DEFAULT 'adding' CHECK (state IN ('adding', 'added', 'retired')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  failure text,
  CHECK ((state = 'adding') = (finished_at IS NULL)),
  CHECK (failure IS NULL OR state = 'retired')
);
CREATE UNIQUE INDEX demo_run_one_live ON demo_run ((true)) WHERE state IN ('adding', 'added');

-- R-DEMO-04: the run being added, set and cleared with the instance row locked. The switch to the real mode refuses while
-- it is set, and the database refuses it outside the sandbox as a last guard.
ALTER TABLE instance_profile ADD COLUMN demo_adding uuid REFERENCES demo_run (id);
ALTER TABLE instance_profile ADD CONSTRAINT demo_adding_sandbox_only CHECK (demo_adding IS NULL OR mode = 'sandbox');

GRANT SELECT, INSERT ON demo_run TO bulma_app;
GRANT UPDATE (state, finished_at, failure) ON demo_run TO bulma_app;

-- A run only moves forward: adding to added or retired, added to retired. Retired is final, so nothing a retirement hid
-- comes back, whoever updates the row (Codex r1 #6).
CREATE FUNCTION demo_run_forward() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (OLD.state = 'retired' AND (NEW.state, NEW.finished_at, NEW.failure) IS DISTINCT FROM (OLD.state, OLD.finished_at, OLD.failure))
     OR (OLD.state = 'added' AND NEW.state = 'adding') THEN
    RAISE EXCEPTION 'a demo run only moves forward' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER demo_run_forward BEFORE UPDATE ON demo_run FOR EACH ROW EXECUTE FUNCTION demo_run_forward();

-- R-DEMO-05, R-DEMO-08: an account the seed made belongs to its run, so a later run never reuses it and the switch to the
-- real mode can find it. A demo account never counts as staff (`currentStaff`); the database refuses it the admin and
-- approver roles whatever path tries, so it can never approve a request or be counted for one.
ALTER TABLE user_account ADD COLUMN demo_run uuid REFERENCES demo_run (id);
CREATE INDEX user_account_demo_run ON user_account (demo_run) WHERE demo_run IS NOT NULL;
-- the run's reviewer, retired when the run ends, whatever the outcome
ALTER TABLE demo_run ADD COLUMN reviewer uuid REFERENCES user_account (id);
GRANT UPDATE (reviewer) ON demo_run TO bulma_app;

CREATE FUNCTION demo_role_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.role <> 'reviewer' AND EXISTS (SELECT 1 FROM user_account WHERE id = NEW.user_id AND demo_run IS NOT NULL) THEN
    RAISE EXCEPTION 'a demo account cannot take this role' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_grant_demo_guard BEFORE INSERT ON role_grant FOR EACH ROW EXECUTE FUNCTION demo_role_guard();

-- Every demo guard reads the run a record belongs to, so it is kept as made (self-test review 2026-11-24). A demo account
-- gets its run when it is made, and only from a run still being added; no later change, so no existing account can be
-- moved into a run (Codex r1 #7).
CREATE FUNCTION demo_run_kept() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.demo_run IS NOT DISTINCT FROM OLD.demo_run THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the demo run a record belongs to cannot change' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER user_account_demo_run_kept BEFORE UPDATE OF demo_run ON user_account FOR EACH ROW EXECUTE FUNCTION demo_run_kept();
CREATE FUNCTION demo_account_made() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.demo_run IS NOT NULL AND NOT EXISTS (SELECT 1 FROM demo_run WHERE id = NEW.demo_run AND state = 'adding') THEN
    RAISE EXCEPTION 'a demo account is made only by a run being added' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_account_demo_made BEFORE INSERT ON user_account FOR EACH ROW EXECUTE FUNCTION demo_account_made();

-- R-DEMO-05: demo records and ordinary records stay apart. A deal and a syndicate take the run of the person who makes them
-- (the lead, the creator), whatever path makes them, so a demo lead's own new deals and syndicates are demo too. A company
-- record belongs to the run whose deal made it, so a company check is never reused across the line.
ALTER TABLE deal ADD COLUMN demo_run uuid REFERENCES demo_run (id);
ALTER TABLE syndicate ADD COLUMN demo_run uuid REFERENCES demo_run (id);
ALTER TABLE investee_company ADD COLUMN demo_run uuid REFERENCES demo_run (id);
CREATE INDEX deal_demo_run ON deal (demo_run) WHERE demo_run IS NOT NULL;
CREATE INDEX syndicate_demo_run ON syndicate (demo_run) WHERE demo_run IS NOT NULL;

CREATE FUNCTION demo_run_of_maker() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- each branch names only its own table's column: plpgsql cannot read a field the row does not have
  IF TG_TABLE_NAME = 'deal' THEN
    NEW.demo_run := (SELECT demo_run FROM user_account WHERE id = NEW.lead_user);
  ELSE
    NEW.demo_run := (SELECT demo_run FROM user_account WHERE id = NEW.created_by);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deal_demo_run BEFORE INSERT ON deal FOR EACH ROW EXECUTE FUNCTION demo_run_of_maker();
CREATE TRIGGER syndicate_demo_run BEFORE INSERT ON syndicate FOR EACH ROW EXECUTE FUNCTION demo_run_of_maker();
CREATE TRIGGER deal_demo_run_kept BEFORE UPDATE OF demo_run ON deal FOR EACH ROW EXECUTE FUNCTION demo_run_kept();
CREATE TRIGGER syndicate_demo_run_kept BEFORE UPDATE OF demo_run ON syndicate FOR EACH ROW EXECUTE FUNCTION demo_run_kept();
CREATE TRIGGER investee_company_demo_run_kept BEFORE UPDATE OF demo_run ON investee_company FOR EACH ROW EXECUTE FUNCTION demo_run_kept();

-- The last guard: whatever path joins a person to a deal or a syndicate, or a deal to a syndicate or a company, both sides
-- belong to the same run (or both to none). The routes refuse first, in words; this catches a path that forgot. It reads as
-- the owner: a retired run's rows are hidden from the app (below), and a hidden row read as none would let anyone across.
CREATE FUNCTION demo_boundary_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  b uuid;
BEGIN
  IF TG_TABLE_NAME = 'syndicate_member' THEN
    a := (SELECT demo_run FROM syndicate WHERE id = NEW.syndicate_id);
    b := (SELECT demo_run FROM user_account WHERE id = NEW.user_id);
  ELSIF TG_TABLE_NAME IN ('deal_member', 'deal_invitation', 'participation') THEN
    a := (SELECT demo_run FROM deal WHERE id = NEW.deal_id);
    b := (SELECT demo_run FROM user_account WHERE id = NEW.user_id);
  ELSIF TG_TABLE_NAME = 'investee' THEN
    a := (SELECT demo_run FROM deal WHERE id = NEW.deal_id);
    b := (SELECT demo_run FROM investee_company WHERE id = NEW.company_id);
  ELSE -- deal
    IF NEW.syndicate_id IS NULL THEN
      RETURN NEW;
    END IF;
    a := NEW.demo_run;
    b := (SELECT demo_run FROM syndicate WHERE id = NEW.syndicate_id);
  END IF;
  IF a IS DISTINCT FROM b THEN
    RAISE EXCEPTION 'demo and ordinary records stay apart' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER syndicate_member_demo_boundary BEFORE INSERT ON syndicate_member FOR EACH ROW EXECUTE FUNCTION demo_boundary_guard();
CREATE TRIGGER deal_member_demo_boundary BEFORE INSERT ON deal_member FOR EACH ROW EXECUTE FUNCTION demo_boundary_guard();
CREATE TRIGGER deal_invitation_demo_boundary BEFORE INSERT ON deal_invitation FOR EACH ROW EXECUTE FUNCTION demo_boundary_guard();
CREATE TRIGGER participation_demo_boundary BEFORE INSERT ON participation FOR EACH ROW EXECUTE FUNCTION demo_boundary_guard();
CREATE TRIGGER investee_demo_boundary BEFORE INSERT OR UPDATE OF company_id ON investee FOR EACH ROW EXECUTE FUNCTION demo_boundary_guard();
-- after deal_demo_run (triggers fire in name order), so the deal's own run is set when this looks
CREATE TRIGGER deal_syndicate_demo_boundary BEFORE INSERT OR UPDATE OF syndicate_id ON deal FOR EACH ROW EXECUTE FUNCTION demo_boundary_guard();

-- R-DEMO-05: money stays on one side. An import belongs to one side: a statement to the side of the people it matches
-- (both at once is refused), a ledger to its deal's. Unallocated money keeps the side it came from (by hand: ordinary).
ALTER TABLE goten_import ADD COLUMN demo_run uuid REFERENCES demo_run (id);
ALTER TABLE unallocated_receipt ADD COLUMN demo_run uuid REFERENCES demo_run (id);

-- the last guard: a staged line is matched only to a person on its import's side (as the owner, as above)
CREATE FUNCTION demo_import_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.participation_id IS NOT NULL AND (SELECT demo_run FROM goten_import WHERE id = NEW.import_id) IS DISTINCT FROM
     (SELECT d.demo_run FROM participation p JOIN deal d ON d.id = p.deal_id WHERE p.id = NEW.participation_id) THEN
    RAISE EXCEPTION 'demo and ordinary records stay apart' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER goten_import_row_demo_boundary BEFORE INSERT OR UPDATE OF participation_id ON goten_import_row FOR EACH ROW EXECUTE FUNCTION demo_import_guard();

-- R-DEMO-06 (plan 05 §4.5): what a retired run made is gone from the app, whatever route or job asks. The rows stay (all
-- fictional, decision R13's exception) but the app's role can no longer see them: lists, queues, pages, an id typed by hand.
-- Restrictive policies for the app only; a permissive one keeps every role's rights as they were. Reads and checks run as
-- the owner, so a policy does not hide the rows it needs to judge. A child row is judged by its deal, participation or owner.
CREATE FUNCTION demo_retired(run uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT run IS NOT NULL AND EXISTS (SELECT 1 FROM demo_run WHERE id = run AND state = 'retired')
$$;
CREATE FUNCTION demo_retired_deal(d uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM deal x JOIN demo_run r ON r.id = x.demo_run WHERE x.id = d AND r.state = 'retired')
$$;
CREATE FUNCTION demo_retired_participation(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM participation x JOIN deal d ON d.id = x.deal_id JOIN demo_run r ON r.id = d.demo_run WHERE x.id = p AND r.state = 'retired')
$$;
CREATE FUNCTION demo_retired_user(u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM user_account x JOIN demo_run r ON r.id = x.demo_run WHERE x.id = u AND r.state = 'retired')
$$;
CREATE FUNCTION demo_retired_entity(e uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM legal_entity x JOIN user_account u ON u.id = x.owner_user JOIN demo_run r ON r.id = u.demo_run WHERE x.id = e AND r.state = 'retired')
$$;
CREATE FUNCTION demo_retired_syndicate(sy uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM syndicate x JOIN demo_run r ON r.id = x.demo_run WHERE x.id = sy AND r.state = 'retired')
$$;
CREATE FUNCTION demo_retired_investee(i uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM investee x JOIN deal d ON d.id = x.deal_id JOIN demo_run r ON r.id = d.demo_run WHERE x.id = i AND r.state = 'retired')
$$;
REVOKE ALL ON FUNCTION demo_retired(uuid), demo_retired_deal(uuid), demo_retired_participation(uuid), demo_retired_user(uuid), demo_retired_entity(uuid),
  demo_retired_syndicate(uuid), demo_retired_investee(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION demo_retired(uuid), demo_retired_deal(uuid), demo_retired_participation(uuid), demo_retired_user(uuid), demo_retired_entity(uuid),
  demo_retired_syndicate(uuid), demo_retired_investee(uuid) TO bulma_app;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('deal', 'demo_retired(demo_run)'), ('syndicate', 'demo_retired(demo_run)'), ('investee_company', 'demo_retired(demo_run)'),
    ('goten_import', 'demo_retired(demo_run)'), ('unallocated_receipt', 'demo_retired(demo_run)'),
    ('participation', 'demo_retired_deal(deal_id)'), ('deal_invitation', 'demo_retired_deal(deal_id)'), ('deal_member', 'demo_retired_deal(deal_id)'),
    ('invite_link', 'demo_retired_deal(deal_id)'), ('targeted_invite', 'demo_retired_deal(deal_id)'), ('investee', 'demo_retired_deal(deal_id)'),
    ('change_request', 'demo_retired_deal(deal_id)'), ('cancel_request', 'demo_retired_deal(deal_id)'), ('reconfirmation', 'demo_retired_deal(deal_id)'),
    ('message', 'demo_retired_deal(deal_id)'), ('deal_message', 'demo_retired_deal(deal_id)'), ('doc_folder', 'demo_retired_deal(deal_id)'),
    ('receipt', 'demo_retired_participation(participation_id)'), ('payment_query', 'demo_retired_participation(participation_id)'),
    ('refund_todo', 'demo_retired_participation(participation_id)'), ('amount_proposal', 'demo_retired_participation(participation_id)'),
    ('withdrawal_request', 'demo_retired_participation(participation_id)'), ('issued_instruction', 'demo_retired_participation(participation_id)'),
    ('signature_record', 'demo_retired_participation(participation_id)'),
    ('legal_entity', 'demo_retired_user(owner_user)'), ('kyc_case', 'demo_retired_entity(entity_id)'),
    -- every other table hanging off a deal, participation, entity, syndicate or investee (self-test review 2026-11-24): a
    -- route that reads one by the parent's id without loading the parent must find nothing either
    ('carry_recipient', 'demo_retired_deal(deal_id)'), ('deal_version', 'demo_retired_deal(deal_id)'), ('deal_view', 'demo_retired_deal(deal_id)'),
    ('goten_ledger', 'demo_retired_deal(deal_id)'), ('invitee_policy_ack', 'demo_retired_deal(deal_id)'), ('lead_attestation', 'demo_retired_deal(deal_id)'),
    ('pipeline_entry', 'demo_retired_deal(deal_id)'), ('review_event', 'demo_retired_deal(deal_id)'), ('waitlist_entry', 'demo_retired_deal(deal_id)'),
    ('hold_release', 'demo_retired_participation(participation_id)'), ('instruction_ack', 'demo_retired_participation(participation_id)'),
    ('participation_event', 'demo_retired_participation(participation_id)'), ('reconfirm_exclusion', 'demo_retired_participation(participation_id)'),
    ('refund_payment', 'demo_retired_participation(participation_id)'), ('refund_todo_event', 'demo_retired_participation(participation_id)'),
    ('transfer_mark', 'demo_retired_participation(participation_id)'),
    ('entity_bank_account', 'demo_retired_entity(entity_id)'), ('entity_party', 'demo_retired_entity(entity_id)'),
    ('kyc_provider_ref', 'demo_retired_entity(entity_id)'), ('legal_entity_version', 'demo_retired_entity(entity_id)'),
    ('member_invite', 'demo_retired_syndicate(syndicate_id)'), ('syndicate_member', 'demo_retired_syndicate(syndicate_id)'),
    ('investee_link', 'demo_retired_investee(investee_id)')
  ) AS v (tbl, hidden) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('CREATE POLICY rights_as_granted ON %I USING (true) WITH CHECK (true)', t.tbl);
    EXECUTE format('CREATE POLICY demo_retired_hidden ON %I AS RESTRICTIVE TO bulma_app USING (NOT %s) WITH CHECK (NOT %s)', t.tbl, t.hidden, t.hidden);
  END LOOP;
END $$;

-- plan 05 §4.5: a retired run's files. The rows go with their wrapped keys, so nothing can read them again; the stored bytes
-- are queued for the expiry job. The app has no right to delete files, so this does only that, only for a retired run,
-- and returns the keys so the app can drop the sandbox's in-memory copies at once.
CREATE FUNCTION demo_remove_files(run uuid) RETURNS SETOF text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM demo_run WHERE id = run AND state = 'retired') THEN
    RAISE EXCEPTION 'only a retired demo run''s files are removed here' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY WITH gone AS (
    DELETE FROM stored_file f WHERE
      (f.scope IN ('entity_kyc', 'entity_bank') AND f.owner_id IN (SELECT e.id FROM legal_entity e JOIN user_account u ON u.id = e.owner_user WHERE u.demo_run = run))
      OR (f.scope = 'deal_shared' AND f.owner_id IN (SELECT id FROM deal WHERE demo_run = run))
      OR (f.scope = 'investee_verification' AND f.owner_id IN (SELECT i.id FROM investee i JOIN deal d ON d.id = i.deal_id WHERE d.demo_run = run))
    RETURNING f.storage_key
  ), queued AS (
    INSERT INTO file_deletion (storage_key) SELECT storage_key FROM gone ON CONFLICT DO NOTHING
  )
  SELECT storage_key FROM gone;
END $$;
REVOKE ALL ON FUNCTION demo_remove_files(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION demo_remove_files(uuid) TO bulma_app;

-- R-DEMO-07, plan 05 §4.6: the demo rules pack. Only the seed installs one (an upload cannot take its kept name). It is
-- never the instance's current pack, and only a demo deal in the sandbox is bound to it, whatever path tries.
ALTER TABLE regime_pack ADD COLUMN demo_only boolean NOT NULL DEFAULT false;
ALTER TABLE demo_run ADD COLUMN pack_id uuid REFERENCES regime_pack (id);
GRANT UPDATE (pack_id) ON demo_run TO bulma_app;

CREATE FUNCTION demo_pack_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'instance_profile' THEN
    IF EXISTS (SELECT 1 FROM regime_pack WHERE id = NEW.active_pack_id AND demo_only) THEN
      RAISE EXCEPTION 'a demo rules pack is never the current pack' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.pack_id IS NOT NULL AND EXISTS (SELECT 1 FROM regime_pack WHERE id = NEW.pack_id AND demo_only) THEN
    IF NEW.demo_run IS NULL OR (SELECT mode FROM instance_profile WHERE id = 1) <> 'sandbox' THEN
      RAISE EXCEPTION 'a demo rules pack is bound only to a demo deal in the sandbox' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER instance_demo_pack BEFORE INSERT OR UPDATE OF active_pack_id ON instance_profile FOR EACH ROW EXECUTE FUNCTION demo_pack_guard();
-- named after `deal_demo_run`, so on an insert it reads the run that trigger set, not one the caller supplied (triggers fire by name)
CREATE TRIGGER deal_demo_run_pack BEFORE INSERT OR UPDATE OF pack_id, demo_run ON deal FOR EACH ROW EXECUTE FUNCTION demo_pack_guard();
