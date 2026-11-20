#!/usr/bin/env python3
"""Independent oracle for money rules. See SCHEMA.md.

Written from docs/01_PRD.md, docs/04_TEST_PLAN.md and SCHEMA.md only.
Exact arithmetic: integers and fractions.Fraction, no floating point.

Usage: python3 scripts/oracle/oracle.py < cases.json > results.json
"""

import copy
import json
import re
import sys
from fractions import Fraction

BPS_DENOMINATOR = 10000
_INTEGER_STRING = re.compile(r"-?[0-9]+")


class BadInput(ValueError):
    """The input breaks SCHEMA.md. A driver bug, never a business result."""


def round_half_up(value):
    """半数进位 of a non-negative exact value: an exact half goes up."""
    value = Fraction(value)
    if value < 0:
        raise BadInput(f"round_half_up expects a non-negative value, got {value}")
    return (2 * value.numerator + value.denominator) // (2 * value.denominator)


def platform_fee(rate_bps, min_minor, max_minor, surcharge_threshold_minor, surcharge_bps, base_minor):
    """C-FEE-2.

    fee = round(min(max_fee, max(min_fee, B * rate)))
        + round(max(0, B - threshold) * surcharge_rate)

    The two parts round separately. The surcharge sits outside the cap.
    """
    capped = min(Fraction(max_minor), max(Fraction(min_minor), Fraction(base_minor * rate_bps, BPS_DENOMINATOR)))
    surcharge = Fraction(max(0, base_minor - surcharge_threshold_minor) * surcharge_bps, BPS_DENOMINATOR)
    return round_half_up(capped) + round_half_up(surcharge)


def validate_fee_config(rate_bps, min_minor, max_minor, surcharge_threshold_minor, surcharge_bps):
    """R-OP-07 plus the SCHEMA.md bounds. Zero is allowed everywhere."""
    if not (0 <= rate_bps <= BPS_DENOMINATOR and 0 <= surcharge_bps <= BPS_DENOMINATOR):
        return False
    if min_minor < 0 or max_minor < 0 or surcharge_threshold_minor < 0:
        return False
    return min_minor <= max_minor


# --- D3: link fees, commitments and estimates (PRD §5.4 C-FEE-1, C-FEE-3; R-CMT-02; R-LNK-02)

COMMITMENT_LIMIT_MINOR = 100_000_000_000  # £1,000,000,000 (R-CMT-02)
LINK_PERCENT_MAX_BPS = 5000  # R-LNK-02: at most 50%


def ceil_fraction(value):
    value = Fraction(value)
    return -((-value.numerator) // value.denominator)


def floor_fraction(value):
    value = Fraction(value)
    return value.numerator // value.denominator


def due(commitment_minor, fee):
    """C-FEE-1. Returns (D, T, fee shown, rounding) with D = T + fee + rounding.

    fee is ("none",), ("percent", bps, mode) or ("fixed", minor, mode).
    The pure function accepts any percent below 100% so the PRD's out-of-limit
    example (99.99%) can be checked; the JSON path enforces R-LNK-02.
    """
    c = commitment_minor
    kind = fee[0]
    if kind == "none":
        return c, c, 0, 0
    if kind == "fixed":
        amount, mode = fee[1], fee[2]
        if mode == "on_top":
            return c + amount, c, amount, 0
        # Deducted: T = C - F; when C <= F, SCHEMA.md says T is 0 and the fee is C.
        if c <= amount:
            return c, 0, c, 0
        return c, c - amount, amount, 0
    if kind == "percent":
        bps, mode = fee[1], fee[2]
        f = Fraction(bps, BPS_DENOMINATOR)
        if not (0 < f < 1):
            raise BadInput(f"percent fee must be above 0 and below 100%, got {bps} bps")
        if mode == "on_top":
            d = ceil_fraction(c * (1 + f))
            shown = round_half_up(c * f)
            return d, c, shown, d - c - shown
        t = floor_fraction(c * (1 - f))
        shown = round_half_up(t * f / (1 - f))
        return c, t, shown, c - t - shown
    raise BadInput(f"unknown fee kind {kind!r}")


def commitment_ok(commitment_minor, fee, minimum_minor):
    """R-CMT-02 with the SCHEMA.md list."""
    c = commitment_minor
    if c < 1 or c < minimum_minor or c > COMMITMENT_LIMIT_MINOR:
        return False
    d, t, _, _ = due(c, fee)
    return d <= COMMITMENT_LIMIT_MINOR and t >= 1


def expected_investment(config, payer, allocation_minor, invest_minor, total_invest_minor, stage):
    """C-FEE-3 预计投资额. Returns (S', T - S' floored at 0)."""
    t = invest_minor
    if payer != "investors":
        return 0, t
    if stage == "live":
        estimate = platform_fee(base_minor=allocation_minor, **config)
        share = round_half_up(Fraction(estimate * t, max(allocation_minor, total_invest_minor)))
    elif stage == "closing":
        estimate = platform_fee(base_minor=min(allocation_minor, total_invest_minor), **config)
        share = round_half_up(Fraction(estimate * t, total_invest_minor))
    else:
        raise BadInput(f"unknown stage {stage!r}")
    return share, max(0, t - share)


def _unrounded_fee(config, base):
    """C-FEE-2 before either rounding, at an exact (possibly fractional) base."""
    rate = Fraction(config["rate_bps"], BPS_DENOMINATOR)
    surcharge = Fraction(config["surcharge_bps"], BPS_DENOMINATOR)
    capped = min(Fraction(config["max_minor"]), max(Fraction(config["min_minor"]), base * rate))
    return capped + max(Fraction(0), base - config["surcharge_threshold_minor"]) * surcharge


def least_investment(config, payer, allocation_minor, min_raise_minor, invest_minor):
    """C-FEE-3 最少可能投入 (R-CMT-05.1). Returns T - S bound, or None when no number is shown."""
    if payer != "investors":
        return None
    t = invest_minor
    low = t if min_raise_minor is None else max(t, min_raise_minor)
    high = max(low, allocation_minor)
    points = {Fraction(low), Fraction(high), Fraction(config["surcharge_threshold_minor"])}
    if config["rate_bps"] > 0:
        rate = Fraction(config["rate_bps"], BPS_DENOMINATOR)
        points.add(config["min_minor"] / rate)
        points.add(config["max_minor"] / rate)
    # fee(B) is affine between these points, so fee(B) * T / B is monotonic on each piece.
    worst = max(_unrounded_fee(config, b) * t / b for b in points if low <= b <= high)
    bound = ceil_fraction(worst) + 1
    if bound >= t:
        return None
    return t - bound


# --- D4: dashboard money (PRD §5.4 C-FEE-4; R-ALO-02; R-KYC-02.1; R-OPS-04; R-OPS-05)


def lead_fee(effective_minor, fee):
    """C-FEE-4 发起人费 f(E) for one person, one link fee, no scale-back.

    PRD C-FEE-4: "固定费 E ≤ F 时为 0，否则 F；百分比按 E 算", whatever the mode.
    Reading of "百分比按 E 算" (the PRD quotes no more of Goten C-ALL-1/4/6): E is
    treated as the money paid, as C-FEE-1 treats it, so f(E) is the fee C-FEE-1
    would show for that payment. On top: T = floor(E / (1 + f)), fee = half-up(T * f)
    (at E = D this gives back C and C-FEE-1's fee). Deducted: T = floor(E * (1 - f)),
    fee = half-up(T * f / (1 - f)). The rounding difference stays in the gross,
    as the PRD's "含取整差" says.
    """
    e = effective_minor
    kind = fee[0]
    if kind == "none" or e <= 0:
        return 0
    if kind == "fixed":
        return 0 if e <= fee[1] else fee[1]
    if kind == "percent":
        f = Fraction(fee[1], BPS_DENOMINATOR)
        if fee[2] == "on_top":
            return round_half_up(floor_fraction(e / (1 + f)) * f)
        return round_half_up(floor_fraction(e * (1 - f)) * f / (1 - f))
    raise BadInput(f"unknown fee kind {kind!r}")


def scale_back(allocation_minor, invest):
    """R-ALO-02 / C-ALL-3 preview. invest is a list of T in joining order.

    Returns None when Σ T ≤ allocation, else (over, shares): the allocation split
    in proportion to T by largest remainder, equal remainders by joining order.
    """
    total = sum(invest)
    if total <= allocation_minor:
        return None
    exact = [Fraction(allocation_minor * t, total) for t in invest]
    shares = [floor_fraction(x) for x in exact]
    left = allocation_minor - sum(shares)
    order = sorted(range(len(invest)), key=lambda i: (-(exact[i] - shares[i]), i))
    for i in order[:left]:
        shares[i] += 1
    return total - allocation_minor, shares


OUTCOMES = ("active", "removed", "withdrawn", "deal_cancelled", "rejected_kyc", "excluded_at_close")


def _blank(text):
    return text is None or (isinstance(text, str) and text.strip() == "")


class _Money:
    """One participation's money under C-FEE-4. Everything is derived from receipts and refunds."""

    def __init__(self, outcome, due_minor, allocated_cash):
        self.outcome = outcome
        self.d = due_minor
        self.allocated = allocated_cash
        self.receipts = {}  # id -> dict(amount left, reversed, released, place)
        self.refunds = {}  # id -> dict(approved, state, actual, occupation, place)
        self.places = 0

    def n(self):
        received = sum(r["left"] for r in self.receipts.values() if not r["reversed"])
        out = 0
        for f in self.refunds.values():
            if f["state"] == "recorded":
                out += f["actual"]
            elif f["state"] in ("approved", "sent"):
                out += f["approved"]
        return received - out

    def e(self):
        if self.outcome != "active":
            return 0
        return max(0, min(self.n(), self.d))

    def released(self):
        return sum(r["released"] for r in self.receipts.values() if not r["reversed"])

    def occupied(self):
        return sum(f["occupation"] for f in self.refunds.values() if f["state"] != "cancelled")

    def r(self):
        return self.released() - self.occupied()

    def h(self):
        if self.outcome != "rejected_kyc":
            return 0
        return max(0, self.n() - self.e() - self.r())

    def used(self):
        # SCHEMA.md: with allocated cash given, it takes the place of E.
        return self.e() if self.allocated is None else self.allocated

    def refund_due(self):
        n = self.n()
        if n < 0:
            return None
        return max(0, n - self.used() - self.h())

    def restore_invariants(self):
        excess = self.occupied() - self.released()
        if excess > 0:
            # Approved not sent, then sent, then recorded; latest first within each.
            # "Latest" is read as the refund created last (approved, or recorded with no approval).
            rank = {"approved": 0, "sent": 1, "recorded": 2}
            live = [f for f in self.refunds.values() if f["state"] in rank]
            for f in sorted(live, key=lambda f: (rank[f["state"]], -f["place"])):
                cut = min(excess, f["occupation"])
                f["occupation"] -= cut
                excess -= cut
                if excess == 0:
                    break
        excess = self.r() - max(self.n(), 0)
        if excess > 0:
            live = [r for r in self.receipts.values() if not r["reversed"]]
            for r in sorted(live, key=lambda r: -r["place"]):
                cut = min(excess, r["released"])
                r["released"] -= cut
                excess -= cut
                if excess == 0:
                    break

    def _new_refund(self, refund_id, approved, state, actual, occupation):
        if refund_id in self.refunds:
            raise BadInput(f"refund id {refund_id!r} used twice (SCHEMA: ids are unique within their kind)")
        self.refunds[refund_id] = {"approved": approved, "state": state, "actual": actual, "occupation": occupation, "place": self.places}
        self.places += 1

    def apply(self, event):
        """Returns True when accepted. A refused event changes nothing."""
        kind = _field(event, "kind")
        if kind == "receive":
            receipt_id = _id(_field(event, "id"))
            amount = _amount(_field(event, "amount_minor"), "amount_minor")
            if amount < 1 or receipt_id in self.receipts:
                return False
            self.receipts[receipt_id] = {"left": amount, "reversed": False, "released": 0, "place": self.places}
            self.places += 1
            return True
        if kind in ("reverse", "restore"):
            receipt = self.receipts.get(_id(_field(event, "receipt")))
            if receipt is None or receipt["reversed"] != (kind == "restore"):
                return False
            receipt["reversed"] = kind == "reverse"
            receipt["released"] = 0  # reversed: the release goes with it; restored: new money, no release
            return True
        if kind == "move_out":
            receipt = self.receipts.get(_id(_field(event, "receipt")))
            amount = _amount(_field(event, "amount_minor"), "amount_minor")
            n = self.n()
            if receipt is None or receipt["reversed"] or not (1 <= amount <= receipt["left"]) or n < 0:
                return False
            if amount > n - (0 if self.allocated is None else self.allocated) - self.h():
                return False
            if self.outcome == "rejected_kyc" and amount > receipt["released"]:
                return False
            receipt["released"] -= min(receipt["released"], amount)
            receipt["left"] -= amount
            return True
        if kind == "release":
            receipt = self.receipts.get(_id(_field(event, "receipt")))
            amount = _amount(_field(event, "amount_minor"), "amount_minor")
            basis = _field(event, "basis")
            if self.outcome != "rejected_kyc" or _blank(basis) or receipt is None or receipt["reversed"]:
                return False
            if not (1 <= amount <= receipt["left"] - receipt["released"]) or amount > self.h():
                return False
            receipt["released"] += amount
            return True
        if kind == "approve_refund":
            refund_id = _id(_field(event, "id"))
            amount = _amount(_field(event, "amount_minor"), "amount_minor")
            if refund_id in self.refunds:
                raise BadInput(f"refund id {refund_id!r} used twice (SCHEMA: ids are unique within their kind)")
            if self.n() < 0 or any(f["state"] in ("approved", "sent") for f in self.refunds.values()):
                return False
            if not (1 <= amount <= self.refund_due()):
                return False
            self._new_refund(refund_id, amount, "approved", None, max(0, min(self.r(), amount)))
            return True
        if kind == "send_refund":
            refund = self.refunds.get(_id(_field(event, "refund")))
            if refund is None or refund["state"] != "approved":
                return False
            refund["state"] = "sent"
            return True
        if kind == "cancel_refund":
            refund = self.refunds.get(_id(_field(event, "refund")))
            evidence = _field(event, "recall_evidence")
            if refund is None:
                return False
            if not (refund["state"] == "approved" or (refund["state"] == "sent" and not _blank(evidence))):
                return False
            refund["state"] = "cancelled"
            refund["occupation"] = 0
            return True
        if kind == "record_refund":
            named = _field(event, "refund")
            actual = _amount(_field(event, "actual_minor"), "actual_minor")
            if named is None:
                refund_id = _id(_field(event, "id"))
                if refund_id in self.refunds:
                    raise BadInput(f"refund id {refund_id!r} used twice (SCHEMA: ids are unique within their kind)")
                if actual < 1:
                    return False
                self._new_refund(refund_id, None, "recorded", actual, max(0, min(self.r(), actual)))
                return True
            refund = self.refunds.get(_id(named))
            if actual < 1 or refund is None or refund["state"] not in ("approved", "sent"):
                return False
            r_before = self.r()
            if actual < refund["approved"]:
                refund["occupation"] = min(refund["occupation"], actual)
            elif actual > refund["approved"]:
                refund["occupation"] += max(0, min(r_before, actual - refund["approved"]))
            refund["state"] = "recorded"
            refund["actual"] = actual
            return True
        raise BadInput(f"unknown event kind {kind!r}")

    def step(self, accepted):
        n = self.n()
        due = self.refund_due()
        return {
            "accepted": accepted,
            "on_hand_minor": str(n),
            "usable_minor": str(self.r()),  # SCHEMA: R, not E
            "hold_minor": str(self.h()),
            "refund_due_minor": None if due is None else str(due),
            "needs_check": n < 0,
        }


def money_sequence(outcome, due_minor, allocated_cash, events):
    if outcome not in OUTCOMES:
        raise BadInput(f"unknown outcome {outcome!r}")
    money = _Money(outcome, due_minor, allocated_cash)
    steps = []
    for event in events:
        before = copy.deepcopy((money.receipts, money.refunds, money.places))
        accepted = money.apply(event)
        if accepted:
            money.restore_invariants()
        else:
            money.receipts, money.refunds, money.places = before
        steps.append(money.step(accepted))
    return steps


_ASCII_ALNUM = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
REFERENCE_MAX_PARTS = 3


def _ascii_upper(text):
    """C-REC-1: only a-z become A-Z. No other case or accent change (str.upper would fold ß, é, ...)."""
    return "".join(chr(ord(c) - 32) if "a" <= c <= "z" else c for c in text)


def _is_separator(char):
    """C-REC-1: separators are ASCII characters other than A-Z, a-z, 0-9. Every non-ASCII character belongs to a part."""
    return ord(char) < 128 and char not in _ASCII_ALNUM


def normalise_reference(text):
    """C-REC-1: upper-case a-z and drop the separators."""
    return _ascii_upper("".join(c for c in text if not _is_separator(c)))


def memo_parts(text):
    """C-REC-2: the memo split at separators into non-empty parts, each upper-cased as C-REC-1."""
    parts, current = [], []
    for char in text:
        if _is_separator(char):
            if current:
                parts.append("".join(current))
            current = []
        else:
            current.append(char)
    if current:
        parts.append("".join(current))
    return [_ascii_upper(part) for part in parts]


def reference_matches(reference, memo):
    """C-REC-2: some 1 to 3 neighbouring parts of the memo, joined, equal the normalised reference."""
    target = normalise_reference(reference)
    if target == "":
        return False
    parts = memo_parts(memo)
    for start in range(len(parts)):
        for width in range(1, REFERENCE_MAX_PARTS + 1):
            if start + width > len(parts):
                break
            if "".join(parts[start : start + width]) == target:
                return True
    return False


def statement_match(account_currency, row_currency, memo, holders):
    """R-OPS-07 with C-REC-1 and C-REC-2. holders: (participation, reference, currency)."""
    if row_currency is not None and _ascii_upper(row_currency) != account_currency:
        return {"kind": "unallocated", "reason": "currency_column", "participation": None}
    found = [h for h in holders if reference_matches(h[1], memo)]
    if not found:
        return {"kind": "unallocated", "reason": "no_match", "participation": None}
    if len(found) > 1:
        return {"kind": "unallocated", "reason": "several", "participation": None}
    participation, _, currency = found[0]
    if currency != account_currency:
        return {"kind": "unallocated", "reason": "deal_currency", "participation": None}
    return {"kind": "match", "participation": participation}


def _text(value, name):
    if not isinstance(value, str):
        raise BadInput(f"{name} must be a string, got {value!r}")
    return value


def _id(value):
    if not isinstance(value, str):
        raise BadInput(f"ids are strings, got {value!r}")
    return value


def _amount(value, name):
    if not isinstance(value, str) or not _INTEGER_STRING.fullmatch(value):
        raise BadInput(f"{name} must be an integer written as a JSON string, got {value!r}")
    return int(value)


def _rate(value, name):
    if isinstance(value, bool) or not isinstance(value, int):
        raise BadInput(f"{name} must be a JSON integer in basis points, got {value!r}")
    return value


def _field(mapping, name):
    if not isinstance(mapping, dict) or name not in mapping:
        raise BadInput(f"missing field {name}")
    return mapping[name]


def _config(config):
    return {
        "rate_bps": _rate(_field(config, "rate_bps"), "rate_bps"),
        "min_minor": _amount(_field(config, "min_minor"), "min_minor"),
        "max_minor": _amount(_field(config, "max_minor"), "max_minor"),
        "surcharge_threshold_minor": _amount(_field(config, "surcharge_threshold_minor"), "surcharge_threshold_minor"),
        "surcharge_bps": _rate(_field(config, "surcharge_bps"), "surcharge_bps"),
    }


def _fee(value):
    kind = _field(value, "kind")
    if kind == "none":
        return ("none",)
    mode = _field(value, "mode")
    if mode not in ("on_top", "deducted"):
        raise BadInput(f"unknown fee mode {mode!r}")
    if kind == "percent":
        bps = _rate(_field(value, "bps"), "bps")
        if not (1 <= bps <= LINK_PERCENT_MAX_BPS):
            raise BadInput(f"percent fee must be 1 to {LINK_PERCENT_MAX_BPS} bps (R-LNK-02), got {bps}")
        return ("percent", bps, mode)
    if kind == "fixed":
        minor = _amount(_field(value, "minor"), "minor")
        if minor < 0:
            raise BadInput("fixed fee must not be negative")
        return ("fixed", minor, mode)
    raise BadInput(f"unknown fee kind {kind!r}")


def _valid_config(case, case_id, op):
    config = _config(_field(case, "config"))
    # SCHEMA.md: the driver only sends valid input. Anything else is a driver
    # bug and must not come back looking like a fee.
    if not validate_fee_config(**config):
        raise BadInput(f"case {case_id}: {op} got an invalid config")
    return config


def _payer(case):
    payer = _field(case, "payer")
    if payer not in ("investors", "lead", "company"):
        raise BadInput(f"unknown payer {payer!r}")
    return payer


def run_case(case):
    case_id = _field(case, "id")
    op = _field(case, "op")
    if op == "due":
        c = _amount(_field(case, "commitment_minor"), "commitment_minor")
        if c < 1:
            raise BadInput(f"case {case_id}: due needs a commitment of at least 1")
        d, t, shown, rounding = due(c, _fee(_field(case, "fee")))
        return {"id": case_id, "due_minor": str(d), "invest_minor": str(t), "lead_fee_minor": str(shown), "rounding_minor": str(rounding)}
    if op == "commitment_ok":
        c = _amount(_field(case, "commitment_minor"), "commitment_minor")
        minimum = _amount(_field(case, "minimum_minor"), "minimum_minor")
        return {"id": case_id, "ok": commitment_ok(c, _fee(_field(case, "fee")), minimum)}
    if op == "expected_investment":
        config = _valid_config(case, case_id, op)
        allocation = _amount(_field(case, "allocation_minor"), "allocation_minor")
        t = _amount(_field(case, "invest_minor"), "invest_minor")
        total = _amount(_field(case, "total_invest_minor"), "total_invest_minor")
        if allocation < 0 or t < 1 or total < t:
            raise BadInput(f"case {case_id}: expected_investment needs allocation >= 0, T >= 1 and total >= T")
        share, expected = expected_investment(config, _payer(case), allocation, t, total, _field(case, "stage"))
        return {"id": case_id, "share_minor": str(share), "expected_minor": str(expected)}
    if op == "least_investment":
        config = _valid_config(case, case_id, op)
        allocation = _amount(_field(case, "allocation_minor"), "allocation_minor")
        raw_min_raise = _field(case, "min_raise_minor")
        min_raise = None if raw_min_raise is None else _amount(raw_min_raise, "min_raise_minor")
        t = _amount(_field(case, "invest_minor"), "invest_minor")
        if allocation < 0 or t < 1 or (min_raise is not None and min_raise < 0):
            raise BadInput(f"case {case_id}: least_investment needs allocation >= 0, T >= 1 and min raise >= 0")
        least = least_investment(config, _payer(case), allocation, min_raise, t)
        return {"id": case_id, "least_minor": None if least is None else str(least)}
    if op == "lead_fee":
        e = _amount(_field(case, "effective_minor"), "effective_minor")
        if e < 0:
            raise BadInput(f"case {case_id}: lead_fee needs E >= 0")
        return {"id": case_id, "fee_minor": str(lead_fee(e, _fee(_field(case, "fee"))))}
    if op == "scale_back":
        allocation = _amount(_field(case, "allocation_minor"), "allocation_minor")
        entries = _field(case, "entries")
        if not isinstance(entries, list):
            raise BadInput(f"case {case_id}: entries must be a list")
        ids = [_id(_field(entry, "id")) for entry in entries]
        invest = [_amount(_field(entry, "invest_minor"), "invest_minor") for entry in entries]
        if allocation < 0 or any(t < 0 for t in invest):
            raise BadInput(f"case {case_id}: scale_back needs allocation >= 0 and every T >= 0")
        result = scale_back(allocation, invest)
        if result is None:
            return {"id": case_id, "over_minor": None, "scaled": None}
        over, shares = result
        return {"id": case_id, "over_minor": str(over), "scaled": [{"id": i, "invest_minor": str(s)} for i, s in zip(ids, shares)]}
    if op == "money_sequence":
        d = _amount(_field(case, "due_minor"), "due_minor")
        raw_allocated = _field(case, "allocated_cash_minor")
        allocated = None if raw_allocated is None else _amount(raw_allocated, "allocated_cash_minor")
        events = _field(case, "events")
        if d < 0 or (allocated is not None and allocated < 0) or not isinstance(events, list):
            raise BadInput(f"case {case_id}: money_sequence needs D >= 0, allocated cash >= 0 and a list of events")
        return {"id": case_id, "steps": money_sequence(_field(case, "outcome"), d, allocated, events)}
    if op == "statement_match":
        account = _text(_field(case, "account_currency"), "account_currency")
        raw_row = _field(case, "row_currency")
        row = None if raw_row is None else _text(raw_row, "row_currency")
        memo = _text(_field(case, "memo"), "memo")
        raw_holders = _field(case, "holders")
        if not isinstance(raw_holders, list):
            raise BadInput(f"case {case_id}: holders must be a list")
        holders = [
            (_id(_field(h, "participation")), _text(_field(h, "reference"), "reference"), _text(_field(h, "currency"), "currency")) for h in raw_holders
        ]
        if len({h[0] for h in holders}) != len(holders):
            raise BadInput(f"case {case_id}: a participation appears more than once in holders")
        return {"id": case_id, **statement_match(account, row, memo, holders)}
    config = _config(_field(case, "config"))
    if op == "validate_fee_config":
        return {"id": case_id, "valid": validate_fee_config(**config)}
    if op == "platform_fee":
        base_minor = _amount(_field(case, "base_minor"), "base_minor")
        # SCHEMA.md: the driver only sends valid input. Anything else is a driver
        # bug and must not come back looking like a fee.
        if not validate_fee_config(**config):
            raise BadInput(f"case {case_id}: platform_fee got an invalid config")
        if base_minor < 0:
            raise BadInput(f"case {case_id}: platform_fee got a negative base")
        return {"id": case_id, "fee_minor": str(platform_fee(base_minor=base_minor, **config))}
    raise BadInput(f"case {case_id}: unknown op {op!r}")


def run(document):
    return {"results": [run_case(case) for case in _field(document, "cases")]}


def _reject_number(text):
    raise BadInput(f"non-integer number in input: {text}")


def parse(text):
    return json.loads(text, parse_float=_reject_number, parse_constant=_reject_number)


def main():
    try:
        output = run(parse(sys.stdin.read()))
    except BadInput as error:
        print(f"oracle: {error}", file=sys.stderr)
        return 2
    json.dump(output, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
