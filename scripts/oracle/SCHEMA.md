# Oracle input and output (D0, D3, D4)

The oracle is an independent Python implementation of money rules. It reads JSON on stdin and writes JSON on stdout. Its author reads `docs/01_PRD.md`, `docs/04_TEST_PLAN.md` and this file only, never any `.ts` or `.js` file under `src/`.

All amounts are integers in minor units (pence), written as JSON **strings** because they can exceed 2^53. Rates are integers in basis points (1 bp = 0.01%). No floating point anywhere in the oracle.

## Command

```
python3 scripts/oracle/oracle.py < cases.json > results.json
python3 scripts/oracle/selfcheck.py     # hand-worked cases from the PRD and test plan; exit 0 when all pass
```

## Input

```json
{
  "cases": [
    {
      "id": "any-string",
      "op": "platform_fee",
      "config": {
        "rate_bps": 250,
        "min_minor": "400000",
        "max_minor": "2000000",
        "surcharge_threshold_minor": "500000000",
        "surcharge_bps": 10
      },
      "base_minor": "10000000"
    },
    {
      "id": "another",
      "op": "validate_fee_config",
      "config": { "rate_bps": 250, "min_minor": "1", "max_minor": "0", "surcharge_threshold_minor": "0", "surcharge_bps": 0 }
    }
  ]
}
```

- `platform_fee`: rule C-FEE-2. `base_minor` is B.
- `validate_fee_config`: requirement R-OP-07. Beyond the PRD wording, a config is also invalid when a rate is outside 0 to 10000 bps or any amount is negative.

## D3 operations

Same envelope; each case has an `op` and an `id`. Amounts are strings, rates integers.

A link fee is one of:

```json
{ "kind": "none" }
{ "kind": "percent", "bps": 400, "mode": "on_top" }
{ "kind": "fixed", "minor": "25000", "mode": "deducted" }
```

`mode` is `on_top` (加在之上) or `deducted` (从打款里扣). A percent fee has 1 to 5000 bps.

- `due` (rule C-FEE-1): input `commitment_minor` (C, at least 1) and `fee`. Output `due_minor` (D), `invest_minor` (T), `lead_fee_minor` (the fee shown) and `rounding_minor` (取整差), with D = T + fee + rounding. For a fixed fee taken from the payment with C ≤ F, T is `"0"` and the fee is C. The fee shown and the rounding follow the examples in C-FEE-1 and TC-FEE-01 to TC-FEE-07.
- `commitment_ok` (R-CMT-02): input `commitment_minor`, `fee`, `minimum_minor` (the deal's minimum commitment, compared with C). Output `ok`: false when C < 1, C < minimum, C > 100000000000, D > 100000000000, or T < 1.
- `expected_investment` (C-FEE-3, the 预计投资额 bullets): input `config` (as for `platform_fee`), `payer` (`investors`, `lead` or `company`), `allocation_minor` (SPV 额度), `invest_minor` (this person's T, at least 1), `total_invest_minor` (Σ T of all active participations including this one, at least T), `stage` (`live`, or `closing` for 申请关闭起). Output `share_minor` (S') and `expected_minor` (T − S', never below 0). When the payer is not `investors`, S' is 0.
- `least_investment` (C-FEE-3 最少可能投入, R-CMT-05.1): input `config`, `payer`, `allocation_minor`, `min_raise_minor` (string, or null when the deal has none), `invest_minor`. Output `least_minor`: the number shown (T minus the bound on S), or null when no number is shown (the bound is at least T, or the payer is not `investors`).

## D4 operations

Same envelope and conventions.

- `lead_fee` (C-FEE-4 发起人费): input `effective_minor` (E, at least 0) and `fee` (a link fee as in D3). Output `fee_minor`: f(E) as Goten C-ALL-1, C-ALL-4, C-ALL-6 compute it for one person with that one fee and no scale-back. The usable gross is E − f(E).
- `scale_back` (R-ALO-02, Goten C-ALL-3): input `allocation_minor` and `entries`, a list of `{ "id", "invest_minor" }` in joining order (T of each active participation, at least 0). Output `over_minor` and `scaled`: when Σ T ≤ allocation both are null; otherwise `over_minor` is Σ T − allocation and `scaled` is a list `{ "id", "invest_minor" }` in the input order, the allocation split in proportion to T by largest remainder, equal remainders by joining order, summing to the allocation.
- `money_sequence` (C-FEE-4, R-KYC-02.1, R-OPS-04, R-OPS-05): one participation's money, event by event. Input:
  - `outcome`: `active`, `removed`, `withdrawn`, `deal_cancelled`, `rejected_kyc` or `excluded_at_close`, fixed for the whole sequence;
  - `due_minor`: D;
  - `allocated_cash_minor`: string, or null before `settled`. When given, the refund due is N − this − H instead of N − E − H, and at most N − this − H can be moved off;
  - `events`: a list, each with `kind` and the fields below. Ids are strings, unique within their kind, chosen by the driver.

  | `kind` | Fields | Accepted when |
  |---|---|---|
  | `receive` | `id`, `amount_minor` | amount ≥ 1 and the id is new. A new receipt has no release |
  | `reverse` | `receipt` | the receipt exists and is not reversed. Its release goes with it |
  | `restore` | `receipt` | the receipt is reversed. It counts as new money: no release |
  | `move_out` | `receipt`, `amount_minor` | the receipt is not reversed; 1 ≤ amount ≤ what is left on it; N ≥ 0; amount ≤ N − allocated cash (when given) − H; for `rejected_kyc` also amount ≤ the released part of that receipt. The released part of the receipt moves first |
  | `release` | `receipt`, `amount_minor`, `basis` | outcome is `rejected_kyc`; `basis` is not blank; the receipt is not reversed; 1 ≤ amount ≤ the part of that receipt not yet released; amount ≤ H at that moment |
  | `approve_refund` | `id`, `amount_minor` | N ≥ 0; no other refund of this participation approved or sent and not yet recorded or cancelled; 1 ≤ amount ≤ the refund due at that moment |
  | `send_refund` | `refund` | that refund is approved and not sent |
  | `cancel_refund` | `refund`, `recall_evidence` (string or null) | that refund is approved, or sent with non-blank `recall_evidence` |
  | `record_refund` | `refund` (null when recorded with no approval), `id` (for the null case), `actual_minor` | actual ≥ 1; with a refund named, it is approved or sent. Never refused for its amount: the money has gone |

  A refused event changes nothing. Occupation (占用) is as C-FEE-4 says: at approval min(R, amount); a refund recorded with no approval also occupies min(R, actual); recorded below the approval, occupation drops to at most the actual; recorded above, the extra occupies min(R, extra) with R as just before recording; a cancelled refund occupies nothing. After **every** accepted event both invariants of C-FEE-4 are restored: excess occupation is cut first from refunds approved and not sent, then from sent ones, then from recorded ones, latest first within each; then excess release over max(N, 0) is taken back from the receipts received last first (by the order of their `receive` event, a restored receipt keeping its place). Before rejection nothing is released, so nothing is occupied.

  Output `steps`, one per event in order: `{ "accepted", "on_hand_minor", "usable_minor", "hold_minor", "refund_due_minor", "needs_check" }` after that event: `on_hand_minor` is N, `usable_minor` is R (the usable release, not E and not the usable gross of `lead_fee`), `hold_minor` is H. N = received on receipts not reversed − recorded refunds (actual) − approved or sent refunds (approved amount). E = 0 unless the outcome is `active`, then min(N, D) and never below 0. R = release on receipts not reversed − occupation. H as C-FEE-4. `refund_due_minor` is null when N < 0, else max(0, N − E − H) (or with the allocated cash in place of E). `needs_check` is N < 0.

- `statement_match` (R-OPS-07, Goten C-REC-1 and C-REC-2, TC-OPS-06): one bank statement row against every payment reference in the instance. Input:
  - `account_currency`: the receiving account's ISO code (the statement's currency);
  - `row_currency`: the row's own currency cell, or null when the file has no such column or the cell is blank;
  - `memo`: the row's reference text, exactly as in the file (any Unicode);
  - `holders`: a list of `{ "participation", "reference", "currency" }`, the reference as issued and the currency of its deal. A participation appears at most once.

  Output `kind` and `participation`:
  - `{"kind": "unallocated", "reason": "currency_column"}` when `row_currency` is not null and, upper-cased, differs from `account_currency`; checked first;
  - otherwise the participations whose reference matches the memo by C-REC-2 (C-REC-1 normalisation of the reference; the memo split into parts; any 1 to 3 neighbouring parts joined equal to it): none gives `"reason": "no_match"`, more than one gives `"reason": "several"`;
  - exactly one whose deal currency differs from `account_currency` gives `"reason": "deal_currency"` (the currency comes from the account, never from the deal);
  - exactly one otherwise gives `{"kind": "match", "participation": "<id>"}`. Unallocated results have `"participation": null`.

  A reference that normalises to the empty string matches nothing.

## Output

```json
{
  "results": [
    { "id": "any-string", "fee_minor": "400000" },
    { "id": "another", "valid": false }
  ]
}
```

Results are in the same order as the cases. `platform_fee` assumes a valid config and a non-negative base; the test driver only sends those.

D3 outputs use the keys named above, for example `{ "id": "x", "due_minor": "1040000", "invest_minor": "1000000", "lead_fee_minor": "40000", "rounding_minor": "0" }`. The driver sends only a valid config, and for `due` and the estimates only a commitment that `commitment_ok` accepts.
