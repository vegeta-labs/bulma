#!/usr/bin/env python3
"""Hand-worked cases for oracle.py. Exit 0 only when all pass.

Every expected value is a literal worked out by hand from the PRD and test plan,
never computed by the code under test. All amounts are pence.
"""

import json
import pathlib
import subprocess
import sys

sys.dont_write_bytecode = True  # do not leave __pycache__ beside the oracle

import oracle  # noqa: E402

POUND = 100


def config(rate=250, low=4_000 * POUND, high=20_000 * POUND, threshold=5_000_000 * POUND, surcharge=10):
    """Defaults are the PRD C-FEE-2 example: 2.5%, min £4,000, max £20,000, threshold £5,000,000, 0.1%."""
    return {"rate_bps": rate, "min_minor": low, "max_minor": high, "surcharge_threshold_minor": threshold, "surcharge_bps": surcharge}


# A plain 2.5% with no effective minimum, so half pennies in the rate part show.
NO_MIN = config(low=0)
HUGE = 10**30

FEE_CASES = [
    # --- PRD C-FEE-2 and TC-FEE-09
    ("TC-FEE-09 B £100,000: 2,500 is below the minimum", config(), 100_000 * POUND, 4_000 * POUND),
    ("TC-FEE-09 B £500,000", config(), 500_000 * POUND, 12_500 * POUND),
    ("TC-FEE-09 B £1,000,000: capped", config(), 1_000_000 * POUND, 20_000 * POUND),
    ("TC-FEE-09 B £6,000,000: cap plus surcharge outside it", config(), 6_000_000 * POUND, 21_000 * POUND),
    # --- Over-subscription: cap £100,000, received £200,000, so B is £100,000 (not the £5,000 fee of £200,000)
    ("TC-FEE-16 over-subscribed, B is the capped £100,000", config(), 100_000 * POUND, 4_000 * POUND),
    # --- Other worked figures in PRD C-FEE-3 that go through C-FEE-2
    ("C-FEE-3 mixed links, B £196,000", config(), 196_000 * POUND, 4_900 * POUND),
    ("C-FEE-3 estimate at SPV size £300,000", config(), 300_000 * POUND, 7_500 * POUND),
    ("C-FEE-3 A plus B, B £100,000", config(), 100_000 * POUND, 4_000 * POUND),
    ("C-FEE-3 A, B and C, B £200,000", config(), 200_000 * POUND, 5_000 * POUND),
    # --- TC-FEE-10 (the test plan names no max for the third case; both readings give £4,000)
    ("TC-FEE-10 all zero, B £100,000", config(0, 0, 0, 0, 0), 100_000 * POUND, 0),
    ("TC-FEE-10 all zero, B 0", config(0, 0, 0, 0, 0), 0, 0),
    ("TC-FEE-10 rate 0, min £4,000, max £20,000", config(rate=0, surcharge=0), 100_000 * POUND, 4_000 * POUND),
    ("TC-FEE-10 rate 0, min £4,000, max £4,000", config(rate=0, high=4_000 * POUND, surcharge=0), 100_000 * POUND, 4_000 * POUND),
    # --- Exact turning points
    ("min turning point: £160,000 at 2.5% is exactly £4,000", config(), 160_000 * POUND, 4_000 * POUND),
    ("one penny above it: 400000.025 rounds down", config(), 160_000 * POUND + 1, 4_000 * POUND),
    ("cap turning point: £800,000 at 2.5% is exactly £20,000", config(), 800_000 * POUND, 20_000 * POUND),
    ("one penny below it: 1999999.975 rounds up to the cap", config(), 800_000 * POUND - 1, 20_000 * POUND),
    # --- Half pennies, rate part
    ("B 19p: 0.475 rounds down", NO_MIN, 19, 0),
    ("B 20p: exactly 0.5 goes up", NO_MIN, 20, 1),
    ("B 60p: 1.5 goes up", NO_MIN, 60, 2),
    ("B 100p: 2.5 goes up to 3, a bankers' round would give 2", NO_MIN, 100, 3),
    ("B 180p: 4.5 goes up to 5, a bankers' round would give 4", NO_MIN, 180, 5),
    ("rate 1bp, B 4,999p: 0.4999 rounds down", config(1, 0), 4_999, 0),
    ("rate 1bp, B 5,000p: exactly 0.5 goes up", config(1, 0), 5_000, 1),
    ("rate 1bp, B 14,999p: 1.4999 rounds down", config(1, 0), 14_999, 1),
    ("rate 1bp, B 15,000p: exactly 1.5 goes up", config(1, 0), 15_000, 2),
    ("rate 50%, B 1p: exactly 0.5 goes up", config(5_000, 0), 1, 1),
    ("rate 99.99%, B 1p: 0.9999 goes up", config(9_999, 0), 1, 1),
    ("rate 100%, B 12,345p", config(10_000, 0, HUGE), 12_345, 12_345),
    # --- Half pennies, surcharge part: £20,000 base plus the surcharge on the excess at 0.1%
    ("B at the threshold: no surcharge", config(), 5_000_000 * POUND, 20_000 * POUND),
    ("1p above the threshold: 0.001 rounds down", config(), 5_000_000 * POUND + 1, 20_000 * POUND),
    ("499p above: 0.499 rounds down", config(), 5_000_000 * POUND + 499, 20_000 * POUND),
    ("500p above: exactly 0.5 goes up", config(), 5_000_000 * POUND + 500, 20_000 * POUND + 1),
    ("1,500p above: 1.5 goes up", config(), 5_000_000 * POUND + 1_500, 20_000 * POUND + 2),
    ("2,500p above: 2.5 goes up to 3, a bankers' round would give 2", config(), 5_000_000 * POUND + 2_500, 20_000 * POUND + 3),
    # --- The two parts round separately: 12.5 -> 13 and 0.5 -> 1 is 14; rounding the sum 13.0 would give 13
    ("both parts half: rounded separately", config(250, 0, HUGE, 0, 10), 500, 14),
    # --- Clamp against rounding
    ("min 3p, B 100p: 2.5 clamps to 3", config(250, 3, HUGE), 100, 3),
    ("min 3p, B 140p: 3.5 goes up to 4", config(250, 3, HUGE), 140, 4),
    ("max 2p, B 100p: 2.5 clamps to 2, the cap holds", config(250, 0, 2), 100, 2),
    ("max 2p, B 60p: 1.5 goes up to the cap", config(250, 0, 2), 60, 2),
    ("min 1p, B 19p: 0.475 clamps to 1", config(250, 1, HUGE), 19, 1),
    # --- Zero edges, read literally from the formula
    ("threshold 0 with a surcharge: applies from the first penny", config(threshold=0), 100_000 * POUND, 4_100 * POUND),
    ("max 0 is a cap of zero, not 'no cap'", config(250, 0, 0, HUGE, 0), 100_000 * POUND, 0),
    ("max 0 with the surcharge: the surcharge is outside the cap", config(250, 0, 0, 0, 10), 100_000 * POUND, 100 * POUND),
    ("min equals max: the fee is fixed", config(250, 4_000 * POUND, 4_000 * POUND), 1_000_000 * POUND, 4_000 * POUND),
    ("B 0 still takes the minimum in C-FEE-2 itself", config(), 0, 4_000 * POUND),
    # --- Beyond 2^53: B * 1bp = 10^16 + 0.5 exactly; floats would lose the half
    ("B above 2^53: half penny kept exactly", config(1, 0, HUGE, HUGE, 0), 10**20 + 5_000, 10**16 + 1),
    ("surcharge above 2^53", config(0, 0, 0, 0, 1), 10**20 + 5_000, 10**16 + 1),
]

VALID_CASES = [
    ("TC-FEE-10 min greater than max is invalid", config(low=20_000 * POUND + 1), False),
    ("SCHEMA example: min 1p, max 0 is invalid", config(250, 1, 0, 0, 0), False),
    ("TC-FEE-10 all zero is valid", config(0, 0, 0, 0, 0), True),
    ("TC-FEE-10 rate 0, min £4,000 is valid", config(rate=0, surcharge=0), True),
    ("PRD example config is valid", config(), True),
    ("min equals max is valid", config(low=20_000 * POUND), True),
    ("rate 10000bp is valid", config(rate=10_000), True),
    ("rate 10001bp is invalid", config(rate=10_001), False),
    ("rate -1bp is invalid", config(rate=-1), False),
    ("surcharge 10000bp is valid", config(surcharge=10_000), True),
    ("surcharge 10001bp is invalid", config(surcharge=10_001), False),
    ("surcharge -1bp is invalid", config(surcharge=-1), False),
    ("negative min is invalid", config(low=-1), False),
    ("negative max is invalid (even with a lower min)", config(low=-2, high=-1), False),
    ("negative threshold is invalid", config(threshold=-1), False),
]

ROUND_CASES = [
    ("round 0", 0, 1, 0),
    ("round 1/2", 1, 2, 1),
    ("round 3/2", 3, 2, 2),
    ("round 5/2", 5, 2, 3),
    ("round 7/2", 7, 2, 4),
    ("round 4999/10000", 4_999, 10_000, 0),
    ("round 5001/10000", 5_001, 10_000, 1),
    ("round 133332/10000 (PRD 13.3332)", 133_332, 10_000, 13),
]

# --- D3. Fees as the JSON shape in SCHEMA.md.
def pct(bps, mode):
    return {"kind": "percent", "bps": bps, "mode": mode}


def fixed(minor, mode):
    return {"kind": "fixed", "minor": str(minor), "mode": mode}


NONE = {"kind": "none"}

# (label, C, fee, D, T, fee shown, rounding), all worked by hand from C-FEE-1 and the TCs.
DUE_CASES = [
    ("TC-FEE-01 on top 4%, C £10,000", 1_000_000, pct(400, "on_top"), 1_040_000, 1_000_000, 40_000, 0),
    ("TC-FEE-02 on top 4%, C £333.33: D ceil(34666.32), fee half-up(1333.32)", 33_333, pct(400, "on_top"), 34_667, 33_333, 1_333, 1),
    ("TC-FEE-03 fixed £250 on top, C £10,000", 1_000_000, fixed(25_000, "on_top"), 1_025_000, 1_000_000, 25_000, 0),
    ("TC-FEE-04 deducted 4%, C £10,000", 1_000_000, pct(400, "deducted"), 1_000_000, 960_000, 40_000, 0),
    ("TC-FEE-05 deducted 4%, C £333.33: T floor(31999.68), fee half-up(1333.29)", 33_333, pct(400, "deducted"), 33_333, 31_999, 1_333, 1),
    ("TC-FEE-06 fixed £250 deducted, C £10,000", 1_000_000, fixed(25_000, "deducted"), 1_000_000, 975_000, 25_000, 0),
    ("TC-FEE-06 fixed £250 deducted, C £250: T 0, fee is C (SCHEMA)", 25_000, fixed(25_000, "deducted"), 25_000, 0, 25_000, 0),
    ("TC-FEE-07 deducted 50%, C £1,000.01", 100_001, pct(5_000, "deducted"), 100_001, 50_000, 50_000, 1),
    ("TC-FEE-07 deducted 49.99%, C £1,049.99: fee 262492491/5001", 104_999, pct(4_999, "deducted"), 104_999, 52_509, 52_488, 2),
    ("TC-FEE-20 on top 4%, C £1,000.01: D ceil(104001.04)", 100_001, pct(400, "on_top"), 104_002, 100_001, 4_000, 1),
    ("no fee: D = T = C", 1_000_000, NONE, 1_000_000, 1_000_000, 0, 0),
    ("on top 50%, C 1p: D ceil(1.5), fee half-up(0.5)", 1, pct(5_000, "on_top"), 2, 1, 1, 0),
    ("on top 1bp, C 4,999p: D ceil(4999.4999), fee half-up(0.4999)", 4_999, pct(1, "on_top"), 5_000, 4_999, 0, 1),
]

# The out-of-limit PRD example, pure function only (the JSON path refuses 99.99%).
EXTREME_DUE = ("C-FEE-1 extreme: deducted 99.99%, C £1,099.99 -> T £0.10, rounding £99.99", 109_999, ("percent", 9_999, "deducted"), (109_999, 10, 99_990, 9_999))

LIMIT = 100_000_000_000
# (label, C, fee, minimum, ok)
COMMIT_CASES = [
    ("TC-FEE-08 C = 0", 0, NONE, 0, False),
    ("TC-FEE-08 C negative", -1, NONE, 0, False),
    ("TC-FEE-08 C 1p, no fee", 1, NONE, 0, True),
    ("TC-FEE-08 D at the limit", LIMIT, NONE, 0, True),
    ("TC-FEE-08 C above the limit", LIMIT + 1, NONE, 0, False),
    ("TC-FEE-08 D above the limit: on top 4% of £1bn", LIMIT, pct(400, "on_top"), 0, False),
    ("TC-FEE-08 D above the limit by 1p: fixed 1p on top", LIMIT, fixed(1, "on_top"), 0, False),
    ("TC-FEE-08 D exactly the limit: fixed 1p on top of limit - 1p", LIMIT - 1, fixed(1, "on_top"), 0, True),
    ("TC-FEE-08 T = 0: fixed £250 deducted, C £250", 25_000, fixed(25_000, "deducted"), 0, False),
    ("TC-FEE-08 T = 0: deducted 50%, C 1p", 1, pct(5_000, "deducted"), 0, False),
    ("TC-FEE-08 T = 1: fixed £250 deducted, C £250.01", 25_001, fixed(25_000, "deducted"), 0, True),
    ("R-CMT-02 below the minimum", 99_999, NONE, 100_000, False),
    ("R-CMT-02 at the minimum", 100_000, NONE, 100_000, True),
    ("R-CMT-02 minimum compares with C, not T", 100_000, pct(400, "deducted"), 100_000, True),
]

ALLOC = 300_000 * POUND
# (label, config, payer, allocation, T, total T, stage, S', expected)
EXPECTED_CASES = [
    ("TC-FEE-11 live, first investor £10,000", config(), "investors", ALLOC, 1_000_000, 1_000_000, "live", 25_000, 975_000),
    ("TC-FEE-11 live, total T £400,000: denominator £400,000", config(), "investors", ALLOC, 1_000_000, 40_000_000, "live", 18_750, 981_250),
    ("TC-FEE-11 live, never below 0 (min £4,000 on a £1,000 SPV)", config(), "investors", 1_000 * POUND, 1_000 * POUND, 1_000 * POUND, "live", 400_000, 0),
    ("TC-FEE-11 closing A £60,000 of £100,000", config(), "investors", ALLOC, 6_000_000, 10_000_000, "closing", 240_000, 5_760_000),
    ("TC-FEE-11 closing B £40,000 of £100,000", config(), "investors", ALLOC, 4_000_000, 10_000_000, "closing", 160_000, 3_840_000),
    ("TC-FEE-11 closing A after C joins, £200,000", config(), "investors", ALLOC, 6_000_000, 20_000_000, "closing", 150_000, 5_850_000),
    ("TC-FEE-11 closing B after C joins", config(), "investors", ALLOC, 4_000_000, 20_000_000, "closing", 100_000, 3_900_000),
    ("TC-FEE-11 closing C £100,000", config(), "investors", ALLOC, 10_000_000, 20_000_000, "closing", 250_000, 9_750_000),
    ("TC-FEE-11 closing, only A left", config(), "investors", ALLOC, 6_000_000, 6_000_000, "closing", 400_000, 5_600_000),
    ("C-FEE-3 closing over-subscribed: fee on the allocation", config(), "investors", 100_000 * POUND, 10_000_000, 20_000_000, "closing", 200_000, 9_800_000),
    ("C-FEE-3 lead pays: S' 0", config(), "lead", ALLOC, 1_000_000, 1_000_000, "live", 0, 1_000_000),
    ("C-FEE-3 company pays: S' 0", config(), "company", ALLOC, 1_000_000, 1_000_000, "closing", 0, 1_000_000),
]

# (label, config, payer, allocation, min raise, T, least or None)
LEAST_CASES = [
    ("TC-FEE-21 T £10,000, no min raise: bound £4,000.01", config(), "investors", ALLOC, None, 1_000_000, 599_999),
    ("TC-FEE-21 T £10,000, min raise £100,000: bound £400.01", config(), "investors", ALLOC, 100_000 * POUND, 1_000_000, 959_999),
    ("TC-FEE-21 T £3,000, no min raise: no number", config(), "investors", ALLOC, None, 300_000, None),
    ("TC-FEE-21 T £4,000.01, no min raise: bound £4,000.01 = T, no number", config(), "investors", ALLOC, None, 400_001, None),
    ("TC-FEE-21 T £4,000.02: bound £4,000.01 < T, shows 1p", config(), "investors", ALLOC, None, 400_002, 1),
    ("TC-FEE-21 rounding: 2.5%, min 0, T £10,000 -> £9,749.99", config(low=0), "investors", ALLOC, None, 1_000_000, 974_999),
    ("TC-FEE-21 over-subscribed T £200,000, SPV £100,000: shown number before cut-back", config(), "investors", 100_000 * POUND, None, 20_000_000, 19_499_999),
    ("TC-FEE-21 surcharge raises the rate with B: take the top end", config(0, 0, 0, 1_000_000, 100), "investors", 10_000_000, None, 1_000_000, 990_999),
    ("C-FEE-3 interior turning point (cap at £1,000/10%) is the worst", config(1_000, 0, 100_000, 500_000, 100), "investors", 10_000_000, None, 100_000, 89_499),
    ("C-FEE-3 fractional turning point 10^7/3: fee 385000/3, worst 3,850 (ends alone give 3,000)", config(300, 0, 100_000, 500_000, 100), "investors", 10_000_000, None, 100_000, 96_149),
    ("C-FEE-3 min raise above the SPV size: range is a single point", config(), "investors", 1_000_000, 10_000_000, 1_000_000, 959_999),
    ("TC-FEE-21 lead pays: no line", config(), "lead", ALLOC, None, 1_000_000, None),
    ("TC-FEE-21 company pays: no line", config(), "company", ALLOC, None, 1_000_000, None),
]

# --- D4. lead_fee: (label, E, fee, f(E)); TC-FEE-17, TC-FEE-18 and the C-FEE-4 examples.
LEAD_FEE_CASES = [
    ("TC-FEE-17 4% on top, E £10,400: fee £400", 1_040_000, pct(400, "on_top"), 40_000),
    ("TC-FEE-17 4% on top, E £5,200: fee £200", 520_000, pct(400, "on_top"), 20_000),
    ("TC-FEE-17 4% on top, received £11,000 so E = D £10,400: fee £400", 1_040_000, pct(400, "on_top"), 40_000),
    ("TC-FEE-18 fixed £250, E £5,125: fee £250", 512_500, fixed(25_000, "on_top"), 25_000),
    ("TC-FEE-18 fixed £250, E £200: fee 0", 20_000, fixed(25_000, "on_top"), 0),
    ("C-FEE-4 fixed: E = F is still 0", 25_000, fixed(25_000, "deducted"), 0),
    ("C-FEE-4 fixed: E = F + 1p is F", 25_001, fixed(25_000, "deducted"), 25_000),
    ("4% deducted, E £10,000: fee £400", 1_000_000, pct(400, "deducted"), 40_000),
    ("4% deducted, E £333.33: T 31,999, fee half-up(1333.29) as TC-FEE-05", 33_333, pct(400, "deducted"), 1_333),
    ("4% on top, E = D £346.67 of TC-FEE-02: T floor(33333.65), fee half-up(1333.32)", 34_667, pct(400, "on_top"), 1_333),
    ("50% on top, E 2p: T floor(1.33) = 1, fee half-up(0.5) = 1", 2, pct(5_000, "on_top"), 1),
    ("4% on top, E 1p: T 0, fee 0", 1, pct(400, "on_top"), 0),
    ("E 0: fee 0", 0, pct(400, "on_top"), 0),
    ("no fee", 1_040_000, NONE, 0),
]

# scale_back: (label, allocation, [(id, T)], over or None, [scaled] or None)
SCALE_CASES = [
    ("TC-ALO-02 A, B £200,000, allocation £300,000: £150,000 each", 300_000 * POUND, [("A", 200_000 * POUND), ("B", 200_000 * POUND)], 100_000 * POUND, [150_000 * POUND, 150_000 * POUND]),
    ("TC-ALO-02 T total £297,600 under £300,000: nothing shown", 300_000 * POUND, [("A", 9_920_000), ("B", 9_920_000), ("C", 9_920_000)], None, None),
    ("total equal to allocation: nothing shown", 100, [("A", 60), ("B", 40)], None, None),
    ("ties by joining order: 10 split over 4, 4, 4 -> 4, 3, 3", 10, [("A", 4), ("B", 4), ("C", 4)], 2, [4, 3, 3]),
    ("largest remainder beats joining order: 11 over 3, 6, 6 (2.2, 4.4, 4.4) -> 2, 5, 4", 11, [("A", 3), ("B", 6), ("C", 6)], 4, [2, 5, 4]),
    ("remainders 0.6, 0.6, 0.8 for 2 pennies: C then A", 5, [("A", 3), ("B", 3), ("C", 4)], 5, [2, 1, 2]),
    ("T 0 keeps 0", 5, [("A", 0), ("B", 7), ("C", 3)], 5, [0, 4, 1]),
    ("allocation 0: all 0", 0, [("A", 5), ("B", 5)], 10, [0, 0]),
]

K = POUND * 1_000  # £1,000


def ev(kind, **fields):
    out = {"kind": kind}
    for key, value in fields.items():
        out[key] = str(value) if isinstance(value, int) and not isinstance(value, bool) else value
    return out


def rcv(i, pounds_k):
    return ev("receive", id=i, amount_minor=pounds_k * K)


def rel(receipt, pounds_k, basis="consent received"):
    return ev("release", receipt=receipt, amount_minor=pounds_k * K, basis=basis)


def appr(i, pounds_k):
    return ev("approve_refund", id=i, amount_minor=pounds_k * K)


def rec(refund, pounds_k, i=None):
    return ev("record_refund", refund=refund, id=i, actual_minor=pounds_k * K)


Y, NO = True, False


class Pence(int):
    """A row figure already in pence, not £1,000s."""

# money_sequence: (label, outcome, D, allocated cash, [(event, (accepted, N, E, H, due or None))]), amounts in £1,000.
# needs_check is checked as N < 0 on every step.
SEQ_CASES = [
    (
        "C-FEE-4 / TC-FEE-22 release -> refund all -> new money is held",
        "rejected_kyc", 0, None,
        [
            (rcv("a", 50), (Y, 50, 0, 50, 0)),
            (appr("x", 1), (NO, 50, 0, 50, 0)),  # nothing released: refund due 0
            (rel("a", 50), (Y, 50, 50, 0, 50)),
            (appr("r1", 50), (Y, 0, 0, 0, 0)),
            (rec("r1", 50), (Y, 0, 0, 0, 0)),
            (rcv("b", 10), (Y, 10, 0, 10, 0)),
        ],
    ),
    (
        "C-FEE-4 overpay refunded before rejection, then release",
        "rejected_kyc", 0, None,
        [
            (rcv("a", 11), (Y, 11, 0, 11, 0)),
            (rec(None, 1, "pre"), (Y, 10, 0, 10, 0)),
            (rel("a", 10), (Y, 10, 10, 0, 10)),
        ],
    ),
    (
        "TC-FEE-22 approve £5,000, actual £10,000, then new money: H £5,000",
        "rejected_kyc", 0, None,
        [
            (rcv("a", 10), (Y, 10, 0, 10, 0)),
            (rel("a", 10), (Y, 10, 10, 0, 10)),
            (appr("r", 5), (Y, 5, 5, 0, 5)),
            (rec("r", 10), (Y, 0, 0, 0, 0)),
            (rcv("b", 5), (Y, 5, 0, 5, 0)),
        ],
    ),
    (
        "TC-FEE-22 mistaken refund £2,000 without release, then release £8,000",
        "rejected_kyc", 0, None,
        [
            (rcv("a", 10), (Y, 10, 0, 10, 0)),
            (rec(None, 2, "oops"), (Y, 8, 0, 8, 0)),
            (rel("a", 9), (NO, 8, 0, 8, 0)),  # more than H
            (rel("a", 8), (Y, 8, 8, 0, 8)),
        ],
    ),
    (
        "TC-FEE-22 two £5,000 released, duplicate reversed, new money: H £5,000",
        "rejected_kyc", 0, None,
        [
            (rcv("a", 5), (Y, 5, 0, 5, 0)),
            (rcv("b", 5), (Y, 10, 0, 10, 0)),
            (rel("a", 5), (Y, 10, 5, 5, 5)),
            (rel("b", 5), (Y, 10, 10, 0, 10)),
            (ev("reverse", receipt="b"), (Y, 5, 5, 0, 5)),
            (rcv("c", 5), (Y, 10, 5, 5, 5)),
            (ev("restore", receipt="b"), (Y, 15, 5, 10, 5)),  # restored: new money, no release
            (ev("restore", receipt="b"), (NO, 15, 5, 10, 5)),
        ],
    ),
    (
        "TC-FEE-22 approve £10,000, actual £5,000: H 0",
        "rejected_kyc", 0, None,
        [
            (rcv("a", 10), (Y, 10, 0, 10, 0)),
            (rel("a", 10), (Y, 10, 10, 0, 10)),
            (appr("r", 10), (Y, 0, 0, 0, 0)),
            (rec("r", 5), (Y, 5, 5, 0, 5)),
        ],
    ),
    (
        "TC-FEE-22 approved before rejection, actual £5,000 (recorded with no approval): H £5,000",
        "rejected_kyc", 0, None,
        [
            (rcv("a", 10), (Y, 10, 0, 10, 0)),
            (rec(None, 5, "pre"), (Y, 5, 0, 5, 0)),
        ],
    ),
    (
        "TC-FEE-22 two released -> approve £10,000 -> reverse duplicate -> new money -> cancel approval: H £5,000",
        "rejected_kyc", 0, None,
        [
            (rcv("a", 5), (Y, 5, 0, 5, 0)),
            (rcv("b", 5), (Y, 10, 0, 10, 0)),
            (rel("a", 5), (Y, 10, 5, 5, 5)),
            (rel("b", 5), (Y, 10, 10, 0, 10)),
            (appr("r", 10), (Y, 0, 0, 0, 0)),
            (ev("reverse", receipt="b"), (Y, -5, 0, 0, None)),  # occupation cut to £5,000 from the approval
            (appr("x", 1), (NO, -5, 0, 0, None)),  # N < 0
            (rcv("c", 5), (Y, 0, 0, 0, 0)),
            (ev("cancel_refund", refund="r", recall_evidence=None), (Y, 10, 5, 5, 5)),
        ],
    ),
    (
        "TC-FEE-22 same, cancel approval before the new money: H £5,000",
        "rejected_kyc", 0, None,
        [
            (rcv("a", 5), (Y, 5, 0, 5, 0)),
            (rcv("b", 5), (Y, 10, 0, 10, 0)),
            (rel("a", 5), (Y, 10, 5, 5, 5)),
            (rel("b", 5), (Y, 10, 10, 0, 10)),
            (appr("r", 10), (Y, 0, 0, 0, 0)),
            (ev("reverse", receipt="b"), (Y, -5, 0, 0, None)),
            (ev("cancel_refund", refund="r", recall_evidence=None), (Y, 5, 5, 0, 5)),
            (rcv("c", 5), (Y, 10, 5, 5, 5)),
        ],
    ),
    (
        "TC-FEE-22 two released and refunded -> new £10,000 -> reverse duplicate (cut from recorded) -> release £5,000",
        "rejected_kyc", 0, None,
        [
            (rcv("a", 5), (Y, 5, 0, 5, 0)),
            (rcv("b", 5), (Y, 10, 0, 10, 0)),
            (rel("a", 5), (Y, 10, 5, 5, 5)),
            (rel("b", 5), (Y, 10, 10, 0, 10)),
            (appr("r", 10), (Y, 0, 0, 0, 0)),
            (rec("r", 10), (Y, 0, 0, 0, 0)),
            (rcv("c", 10), (Y, 10, 0, 10, 0)),
            (ev("reverse", receipt="b"), (Y, 5, 0, 5, 0)),
            (rel("c", 5), (Y, 5, 5, 0, 5)),
        ],
    ),
    (
        "TC-FEE-22 cut order: approval not sent loses its occupation before the recorded refund",
        "rejected_kyc", 0, None,
        [
            (rcv("a", 5), (Y, 5, 0, 5, 0)),
            (rcv("b", 5), (Y, 10, 0, 10, 0)),
            (rel("a", 5), (Y, 10, 5, 5, 5)),
            (rel("b", 5), (Y, 10, 10, 0, 10)),
            (appr("r1", 5), (Y, 5, 5, 0, 5)),
            (rec("r1", 5), (Y, 5, 5, 0, 5)),
            (appr("r2", 5), (Y, 0, 0, 0, 0)),
            (rcv("c", 5), (Y, 5, 0, 5, 0)),
            (ev("reverse", receipt="b"), (Y, 0, 0, 0, 0)),
            (ev("cancel_refund", refund="r2", recall_evidence=None), (Y, 5, 0, 5, 0)),  # the wrong order would give H 0
        ],
    ),
    (
        "TC-FEE-22 release, move the whole receipt out, new money is held",
        "rejected_kyc", 0, None,
        [
            (rcv("a", 10), (Y, 10, 0, 10, 0)),
            (ev("move_out", receipt="a", amount_minor=10 * K), (NO, 10, 0, 10, 0)),  # held money cannot move
            (rel("a", 10), (Y, 10, 10, 0, 10)),
            (ev("move_out", receipt="a", amount_minor=10 * K), (Y, 0, 0, 0, 0)),
            (rcv("b", 10), (Y, 10, 0, 10, 0)),
        ],
    ),
    (
        "R-KYC-02.1 partial move: released part first, bounded by the release",
        "rejected_kyc", 0, None,
        [
            (rcv("a", 10), (Y, 10, 0, 10, 0)),
            (rel("a", 4), (Y, 10, 4, 6, 4)),
            (ev("move_out", receipt="a", amount_minor=5 * K), (NO, 10, 4, 6, 4)),
            (ev("move_out", receipt="a", amount_minor=3 * K), (Y, 7, 1, 6, 1)),
            (rel("a", 2, basis="  "), (NO, 7, 1, 6, 1)),  # blank basis
            (rel("a", 6), (Y, 7, 7, 0, 7)),
            (rel("a", 1), (NO, 7, 7, 0, 7)),  # nothing left unreleased, and H 0
        ],
    ),
    (
        "TC-FEE-19 withdrawn £10,000: E 0, refund due £10,000, 0 after the refund; reversal after it -> needs check",
        "withdrawn", 10 * K, None,
        [
            (rcv("a", 10), (Y, 10, 0, 0, 10)),
            (rel("a", 1), (NO, 10, 0, 0, 10)),  # release only for rejected_kyc
            (appr("r", 11), (NO, 10, 0, 0, 10)),  # above the refund due
            (appr("r", 10), (Y, 0, 0, 0, 0)),
            (ev("send_refund", refund="r"), (Y, 0, 0, 0, 0)),
            (rec("r", 10), (Y, 0, 0, 0, 0)),
            (ev("reverse", receipt="a"), (Y, -10, 0, 0, None)),
            (ev("move_out", receipt="a", amount_minor=1), (NO, -10, 0, 0, None)),
        ],
    ),
    (
        "TC-FEE-19 one refund obligation: overpay, withdraw, partial refund, late money",
        "withdrawn", 10 * K, None,
        [
            (rcv("a", 11), (Y, 11, 0, 0, 11)),
            (appr("r1", 1), (Y, 10, 0, 0, 10)),
            (appr("r2", 4), (NO, 10, 0, 0, 10)),  # one in flight already
            (rec("r1", 1), (Y, 10, 0, 0, 10)),
            (appr("r2", 4), (Y, 6, 0, 0, 6)),
            (rec("r2", 4), (Y, 6, 0, 0, 6)),
            (rcv("b", 2), (Y, 8, 0, 0, 8)),
        ],
    ),
    (
        "TC-FEE-17 active 4% on top D £10,400, received £11,000: refund due £600",
        "active", 1_040_000, None,
        [
            (ev("receive", id="a", amount_minor=1_100_000), (Y, 11, 0, 0, Pence(60_000))),
        ],
    ),
    (
        "TC-FEE-23 in flight: approve £1,000 -> N £10,000; cancel; sent refund cancels only with evidence",
        "active", 10 * K, None,
        [
            (rcv("a", 11), (Y, 11, 0, 0, 1)),
            (appr("r1", 1), (Y, 10, 0, 0, 0)),
            (ev("cancel_refund", refund="r1", recall_evidence=None), (Y, 11, 0, 0, 1)),
            (ev("send_refund", refund="r1"), (NO, 11, 0, 0, 1)),  # cancelled, not approved
            (appr("r2", 1), (Y, 10, 0, 0, 0)),
            (ev("send_refund", refund="r2"), (Y, 10, 0, 0, 0)),
            (ev("send_refund", refund="r2"), (NO, 10, 0, 0, 0)),
            (ev("cancel_refund", refund="r2", recall_evidence=None), (NO, 10, 0, 0, 0)),
            (ev("cancel_refund", refund="r2", recall_evidence=" "), (NO, 10, 0, 0, 0)),
            (ev("cancel_refund", refund="r2", recall_evidence="bank recall ref 123"), (Y, 11, 0, 0, 1)),
            (rec("r2", 1), (NO, 11, 0, 0, 1)),  # cancelled refunds cannot be recorded
        ],
    ),
    (
        "R-OPS-05 recorded above the approval and with no approval: never refused for the amount",
        "active", 10 * K, None,
        [
            (rcv("a", 11), (Y, 11, 0, 0, 1)),
            (appr("r1", 1), (Y, 10, 0, 0, 0)),
            (rec("r1", 3), (Y, 8, 0, 0, 0)),
            (rec(None, 0, "z"), (NO, 8, 0, 0, 0)),  # actual must be at least 1
            (rec(None, 9, "u"), (Y, -1, 0, 0, None)),
        ],
    ),
    (
        "C-FEE-4 over-subscribed: allocated cash £100,000 of N £200,000",
        "active", 200 * K, 100 * K,
        [
            (rcv("a", 200), (Y, 200, 0, 0, 100)),
            (appr("r", 101), (NO, 200, 0, 0, 100)),
            (ev("move_out", receipt="a", amount_minor=101 * K), (NO, 200, 0, 0, 100)),
            (ev("move_out", receipt="a", amount_minor=40 * K), (Y, 160, 0, 0, 60)),
            (appr("r", 60), (Y, 100, 0, 0, 0)),
        ],
    ),
    (
        "acceptance edges: duplicate receipt id, zero amount, unknown receipt",
        "deal_cancelled", 10 * K, None,
        [
            (rcv("a", 5), (Y, 5, 0, 0, 5)),
            (rcv("a", 5), (NO, 5, 0, 0, 5)),
            (ev("receive", id="b", amount_minor=0), (NO, 5, 0, 0, 5)),
            (ev("reverse", receipt="zz"), (NO, 5, 0, 0, 5)),
            (ev("restore", receipt="a"), (NO, 5, 0, 0, 5)),
            (ev("move_out", receipt="a", amount_minor=6 * K), (NO, 5, 0, 0, 5)),
            (ev("move_out", receipt="a", amount_minor=0), (NO, 5, 0, 0, 5)),
            (ev("move_out", receipt="a", amount_minor=5 * K), (Y, 0, 0, 0, 0)),
            (ev("move_out", receipt="a", amount_minor=1), (NO, 0, 0, 0, 0)),
        ],
    ),
]

failures = 0


# statement_match (R-OPS-07, C-REC-1, C-REC-2), worked by hand from the spec.
NW = ("p1", "NW-7K2M9Q", "GBP")
AB = ("p2", "AB CD1234", "GBP")
NW_EUR = ("p1", "NW-7K2M9Q", "EUR")
MATCH_CASES = [
    # label, account, row currency, memo, holders, expected (kind/reason, participation)
    ("C-REC-2 lower case with a space", "GBP", None, "nw 7k2m9q", [NW, AB], ("match", "p1")),
    ("C-REC-2 hyphen and trailing word", "GBP", None, "NW-7K2M9Q SPV", [NW, AB], ("match", "p1")),
    ("C-REC-2 punctuation around", "GBP", None, "Payment/NW.7K2M9Q!", [NW, AB], ("match", "p1")),
    ("C-REC-2 control character separates", "GBP", None, "NW\t7K2M9Q", [NW], ("match", "p1")),
    ("C-REC-2 one part, no separator", "GBP", None, "NW7K2M9Q", [NW], ("match", "p1")),
    ("R-REC-03.2 extra digit in the same part", "GBP", None, "NW7K2M9Q1", [NW], ("no_match", None)),
    ("R-REC-03.2 extra digit after hyphen form", "GBP", None, "NW-7K2M9Q1", [NW], ("no_match", None)),
    ("R-REC-03.2 extra leading character", "GBP", None, "XNW-7K2M9Q", [NW], ("no_match", None)),
    ("C-REC-2 E-acute belongs to the part", "GBP", None, "NW-7K2M9QÉ", [NW], ("no_match", None)),
    ("C-REC-2 E-acute after a space is its own part", "GBP", None, "NW-7K2M9Q É", [NW], ("match", "p1")),
    ("C-REC-1 en dash is not a separator", "GBP", None, "NW–7K2M9Q", [NW], ("no_match", None)),
    ("C-REC-1 non-ASCII digit is not 0-9", "GBP", None, "NW-٧K2M9Q", [("p1", "NW-7K2M9Q", "GBP")], ("no_match", None)),
    ("C-REC-1 no case folding beyond a-z", "GBP", None, "é001", [("p1", "É001", "GBP")], ("no_match", None)),
    ("C-REC-1 non-ASCII matches itself", "GBP", None, "ref É001", [("p1", "É001", "GBP")], ("match", "p1")),
    ("C-REC-2 three neighbouring parts", "GBP", None, "N W 7K2M9Q", [NW], ("match", "p1")),
    ("C-REC-2 three parts in the middle", "GBP", None, "from N-W/7K2M9Q spv", [NW], ("match", "p1")),
    ("C-REC-2 four parts never match", "GBP", None, "N W 7K2M9 Q", [NW], ("no_match", None)),
    ("C-REC-2 parts must be neighbours", "GBP", None, "NW x 7K2M9Q", [NW], ("no_match", None)),
    ("C-REC-2 two holders match", "GBP", None, "NW7K2M9Q AB CD1234", [NW, AB], ("several", None)),
    ("C-REC-2 several before deal currency", "GBP", None, "NW7K2M9Q AB CD1234", [NW_EUR, AB], ("several", None)),
    ("C-REC-2 second holder alone", "GBP", None, "ab-cd-1234", [NW, AB], ("match", "p2")),
    ("blank memo", "GBP", None, "", [NW, AB], ("no_match", None)),
    ("memo of separators only", "GBP", None, " -/. ", [NW, AB], ("no_match", None)),
    ("reference normalising to empty matches nothing", "GBP", None, "--", [("p1", "--", "GBP")], ("no_match", None)),
    ("no holders", "GBP", None, "NW7K2M9Q", [], ("no_match", None)),
    ("currency column equal, case-insensitive", "GBP", "gbp", "NW7K2M9Q", [NW], ("match", "p1")),
    ("currency column mixed case", "GBP", "Gbp", "NW7K2M9Q", [NW], ("match", "p1")),
    ("currency column differs", "GBP", "EUR", "NW7K2M9Q", [NW], ("currency_column", None)),
    ("currency column checked first (no match anyway)", "GBP", "eur", "nothing", [NW], ("currency_column", None)),
    ("currency column checked first (several)", "GBP", "EUR", "NW7K2M9Q AB CD1234", [NW, AB], ("currency_column", None)),
    ("currency column full-width letters differ", "GBP", "ＧＢＰ", "NW7K2M9Q", [NW], ("currency_column", None)),
    ("TC-OPS-06 GBP account, EUR deal", "GBP", None, "NW7K2M9Q", [NW_EUR], ("deal_currency", None)),
    ("TC-OPS-06 GBP column, EUR deal", "GBP", "GBP", "NW7K2M9Q", [NW_EUR, AB], ("deal_currency", None)),
]


def check(label, actual, expected):
    global failures
    ok = actual == expected
    failures += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'}  {label}: got {actual}, expected {expected}")


def as_json_config(cfg):
    return {
        "rate_bps": cfg["rate_bps"],
        "min_minor": str(cfg["min_minor"]),
        "max_minor": str(cfg["max_minor"]),
        "surcharge_threshold_minor": str(cfg["surcharge_threshold_minor"]),
        "surcharge_bps": cfg["surcharge_bps"],
    }


def check_rejected(label, document):
    """Malformed input must raise, not produce a number."""
    try:
        result = oracle.run(oracle.parse(document))
    except oracle.BadInput:
        check(label, "rejected", "rejected")
    else:
        check(label, result, "rejected")


def main():
    for label, numerator, denominator, expected in ROUND_CASES:
        check(label, oracle.round_half_up(oracle.Fraction(numerator, denominator)), expected)

    for label, cfg, base, expected in FEE_CASES:
        check(label, oracle.platform_fee(base_minor=base, **cfg), expected)

    for label, cfg, expected in VALID_CASES:
        check(label, oracle.validate_fee_config(**cfg), expected)

    # The JSON path, in process: every case above, strings in and strings out.
    cases = [
        {"id": f"f{i}", "op": "platform_fee", "config": as_json_config(cfg), "base_minor": str(base)}
        for i, (_, cfg, base, _) in enumerate(FEE_CASES)
    ] + [{"id": f"v{i}", "op": "validate_fee_config", "config": as_json_config(cfg)} for i, (_, cfg, _) in enumerate(VALID_CASES)]
    expected_results = [{"id": f"f{i}", "fee_minor": str(fee)} for i, (_, _, _, fee) in enumerate(FEE_CASES)] + [
        {"id": f"v{i}", "valid": valid} for i, (_, _, valid) in enumerate(VALID_CASES)
    ]
    check("JSON path matches every case, in order", oracle.run({"cases": cases})["results"], expected_results)

    # The command in SCHEMA.md, with its own example input.
    schema_example = {
        "cases": [
            {
                "id": "any-string",
                "op": "platform_fee",
                "config": {
                    "rate_bps": 250,
                    "min_minor": "400000",
                    "max_minor": "2000000",
                    "surcharge_threshold_minor": "500000000",
                    "surcharge_bps": 10,
                },
                "base_minor": "10000000",
            },
            {
                "id": "another",
                "op": "validate_fee_config",
                "config": {"rate_bps": 250, "min_minor": "1", "max_minor": "0", "surcharge_threshold_minor": "0", "surcharge_bps": 0},
            },
        ]
    }
    script = pathlib.Path(__file__).with_name("oracle.py")
    process = subprocess.run([sys.executable, str(script)], input=json.dumps(schema_example), capture_output=True, text=True)
    check("command exit code", process.returncode, 0)
    check(
        "command output is the SCHEMA.md example output",
        json.loads(process.stdout) if process.returncode == 0 else process.stderr,
        {"results": [{"id": "any-string", "fee_minor": "400000"}, {"id": "another", "valid": False}]},
    )

    # Malformed input is a driver bug.
    good_config = '{"rate_bps":250,"min_minor":"1","max_minor":"2","surcharge_threshold_minor":"0","surcharge_bps":0}'
    check_rejected("float rate", '{"cases":[{"id":"x","op":"validate_fee_config","config":{"rate_bps":2.5,"min_minor":"1","max_minor":"2","surcharge_threshold_minor":"0","surcharge_bps":0}}]}')
    check_rejected("amount as a JSON number", '{"cases":[{"id":"x","op":"validate_fee_config","config":{"rate_bps":250,"min_minor":1,"max_minor":"2","surcharge_threshold_minor":"0","surcharge_bps":0}}]}')
    check_rejected("decimal amount string", '{"cases":[{"id":"x","op":"platform_fee","config":' + good_config + ',"base_minor":"1.5"}]}')
    check_rejected("unknown op", '{"cases":[{"id":"x","op":"other","config":' + good_config + "}]}")
    check_rejected("platform_fee with negative base", '{"cases":[{"id":"x","op":"platform_fee","config":' + good_config + ',"base_minor":"-1"}]}')
    bad_config = '{"rate_bps":250,"min_minor":"2","max_minor":"1","surcharge_threshold_minor":"0","surcharge_bps":0}'
    check_rejected("platform_fee with invalid config", '{"cases":[{"id":"x","op":"platform_fee","config":' + bad_config + ',"base_minor":"1"}]}')

    # --- D3
    for label, c, fee, d, t, shown, rounding in DUE_CASES:
        result = oracle.run_case({"id": "d", "op": "due", "commitment_minor": str(c), "fee": fee})
        expected = {"id": "d", "due_minor": str(d), "invest_minor": str(t), "lead_fee_minor": str(shown), "rounding_minor": str(rounding)}
        check(label, result, expected)
        check(label + " (D = T + fee + rounding)", d, t + shown + rounding)
    label, c, fee, expected = EXTREME_DUE
    check(label, oracle.due(c, fee), expected)

    for label, c, fee, minimum, ok in COMMIT_CASES:
        result = oracle.run_case({"id": "c", "op": "commitment_ok", "commitment_minor": str(c), "fee": fee, "minimum_minor": str(minimum)})
        check(label, result, {"id": "c", "ok": ok})

    for label, cfg, payer, allocation, t, total, stage, share, expected in EXPECTED_CASES:
        case = {
            "id": "e",
            "op": "expected_investment",
            "config": as_json_config(cfg),
            "payer": payer,
            "allocation_minor": str(allocation),
            "invest_minor": str(t),
            "total_invest_minor": str(total),
            "stage": stage,
        }
        check(label, oracle.run_case(case), {"id": "e", "share_minor": str(share), "expected_minor": str(expected)})

    for label, cfg, payer, allocation, min_raise, t, least in LEAST_CASES:
        case = {
            "id": "l",
            "op": "least_investment",
            "config": as_json_config(cfg),
            "payer": payer,
            "allocation_minor": str(allocation),
            "min_raise_minor": None if min_raise is None else str(min_raise),
            "invest_minor": str(t),
        }
        check(label, oracle.run_case(case), {"id": "l", "least_minor": None if least is None else str(least)})

    # TC-FEE-21 rounding: actual T £10,000, £1,000.10, £1,000.10 at 2.5% min 0 -> fee £300.01;
    # A's exact share 250.0083 is at most £250.01, so A's investment £9,749.99 is not below the number shown.
    check("TC-FEE-21 actual fee on £12,000.20", oracle.platform_fee(base_minor=1_200_020, **config(low=0)), 30_001)
    check("TC-FEE-21 A's share ceiling", -((-30_001 * 1_000_000) // 1_200_020), 25_001)

    check_rejected("R-LNK-02 percent 50.01% refused", '{"cases":[{"id":"x","op":"due","commitment_minor":"100","fee":{"kind":"percent","bps":5001,"mode":"on_top"}}]}')
    check_rejected("percent 0bp refused", '{"cases":[{"id":"x","op":"due","commitment_minor":"100","fee":{"kind":"percent","bps":0,"mode":"on_top"}}]}')
    check_rejected("unknown fee mode", '{"cases":[{"id":"x","op":"due","commitment_minor":"100","fee":{"kind":"fixed","minor":"1","mode":"sideways"}}]}')
    check_rejected("due with C 0", '{"cases":[{"id":"x","op":"due","commitment_minor":"0","fee":{"kind":"none"}}]}')
    check_rejected(
        "expected_investment with total below T",
        '{"cases":[{"id":"x","op":"expected_investment","config":' + good_config + ',"payer":"investors","allocation_minor":"10","invest_minor":"5","total_invest_minor":"4","stage":"live"}]}',
    )
    check_rejected(
        "least_investment with invalid config",
        '{"cases":[{"id":"x","op":"least_investment","config":' + bad_config + ',"payer":"investors","allocation_minor":"10","min_raise_minor":null,"invest_minor":"5"}]}',
    )

    # --- D4
    for label, e, fee, expected in LEAD_FEE_CASES:
        check(label, oracle.run_case({"id": "f", "op": "lead_fee", "effective_minor": str(e), "fee": fee}), {"id": "f", "fee_minor": str(expected)})
    check("C-FEE-4 4% on top, E £10,400: gross £10,000", 1_040_000 - oracle.lead_fee(1_040_000, ("percent", 400, "on_top")), 1_000_000)
    check("C-FEE-4 fixed £250, E £5,125: gross £4,875", 512_500 - oracle.lead_fee(512_500, ("fixed", 25_000, "on_top")), 487_500)

    for label, allocation, entries, over, scaled in SCALE_CASES:
        case = {"id": "s", "op": "scale_back", "allocation_minor": str(allocation), "entries": [{"id": i, "invest_minor": str(t)} for i, t in entries]}
        if scaled is None:
            expected = {"id": "s", "over_minor": None, "scaled": None}
        else:
            expected = {"id": "s", "over_minor": str(over), "scaled": [{"id": i, "invest_minor": str(v)} for (i, _), v in zip(entries, scaled)]}
            check(label + " (sums to the allocation)", sum(scaled), allocation)
        check(label, oracle.run_case(case), expected)

    for label, outcome, d, allocated, rows in SEQ_CASES:
        case = {
            "id": "m",
            "op": "money_sequence",
            "outcome": outcome,
            "due_minor": str(d),
            "allocated_cash_minor": None if allocated is None else str(allocated),
            "events": [event for event, _ in rows],
        }
        steps = oracle.run_case(case)["steps"]
        expected = []
        for _, (accepted, n, r, h, due_) in rows:
            to_minor = lambda v: str(int(v) if isinstance(v, Pence) else v * K)  # noqa: E731
            expected.append(
                {
                    "accepted": accepted,
                    "on_hand_minor": to_minor(n),
                    "usable_minor": to_minor(r),
                    "hold_minor": to_minor(h),
                    "refund_due_minor": None if due_ is None else to_minor(due_),
                    "needs_check": n < 0,
                }
            )
        for i, (got, want) in enumerate(zip(steps, expected)):
            check(f"{label} [step {i + 1}]", got, want)
        check(f"{label} [step count]", len(steps), len(rows))

    check_rejected("lead_fee with negative E", '{"cases":[{"id":"x","op":"lead_fee","effective_minor":"-1","fee":{"kind":"none"}}]}')
    check_rejected("scale_back with negative T", '{"cases":[{"id":"x","op":"scale_back","allocation_minor":"1","entries":[{"id":"a","invest_minor":"-1"}]}]}')
    check_rejected(
        "money_sequence unknown outcome",
        '{"cases":[{"id":"x","op":"money_sequence","outcome":"other","due_minor":"1","allocated_cash_minor":null,"events":[]}]}',
    )
    check_rejected(
        "money_sequence unknown event kind",
        '{"cases":[{"id":"x","op":"money_sequence","outcome":"active","due_minor":"1","allocated_cash_minor":null,"events":[{"kind":"teleport"}]}]}',
    )
    check_rejected(
        "money_sequence refund id used twice",
        '{"cases":[{"id":"x","op":"money_sequence","outcome":"withdrawn","due_minor":"1","allocated_cash_minor":null,"events":['
        '{"kind":"receive","id":"a","amount_minor":"10"},{"kind":"approve_refund","id":"r","amount_minor":"1"},'
        '{"kind":"record_refund","refund":"r","id":null,"actual_minor":"1"},{"kind":"approve_refund","id":"r","amount_minor":"1"}]}]}',
    )

    for label, account, row, memo, holders, (kind, participation) in MATCH_CASES:
        case = {
            "id": "s",
            "op": "statement_match",
            "account_currency": account,
            "row_currency": row,
            "memo": memo,
            "holders": [{"participation": p, "reference": r, "currency": c} for p, r, c in holders],
        }
        if kind == "match":
            want = {"id": "s", "kind": "match", "participation": participation}
        else:
            want = {"id": "s", "kind": "unallocated", "reason": kind, "participation": None}
        check(label, oracle.run_case(case), want)
    check_rejected(
        "statement_match participation twice",
        '{"cases":[{"id":"x","op":"statement_match","account_currency":"GBP","row_currency":null,"memo":"a",'
        '"holders":[{"participation":"p","reference":"AB1","currency":"GBP"},{"participation":"p","reference":"AB2","currency":"GBP"}]}]}',
    )
    check_rejected("statement_match memo not a string", '{"cases":[{"id":"x","op":"statement_match","account_currency":"GBP","row_currency":null,"memo":null,"holders":[]}]}')

    print(f"\n{'FAILED: ' + str(failures) if failures else 'ALL PASS'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
