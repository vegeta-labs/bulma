# Goten fixtures (D4, decision R28 (1))

Made by Goten's own code, not written by hand, so the read-back and the roster export are tested against what Goten really
reads and writes. Goten `goten-dev` at `72d6439` (2026-11-10).

- `roster.csv`: Bulma's `rosterExport` output. Goten `importCommitments` takes it with no error and reports `refund_only` as an
  ignored column.
- `bank.csv`: a statement in Goten §5.5 columns: an ID'd line, two identical lines with no ID, money out, an unknown reference,
  a formula-looking payer.
- `ledger.csv`: Goten `ledgerCsv` after importing the two files above, with both identical lines confirmed to one person by
  hand and one person marked withdrawn.

To make them again, copy `generate.txt` to an empty folder as `gen.test.ts`, replace `BULMA_CHECKOUT/` and `GOTEN_CHECKOUT/` in its
imports with the absolute paths of the two checkouts, and run from the Goten checkout:
`OUT=<folder> node_modules/.bin/vitest run --root <folder>`.
