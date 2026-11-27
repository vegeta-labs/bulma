// The demo scenario (R-DEMO-03..08, decision R30, plan 05 §3): one definition shared by the sandbox seed (block S) and the
// static demo pack (block P). Data only: the seed plays it through the real routes, so the rules, gates and audit apply as
// for anyone. All names and companies are fictional. Amounts are integer minor units (GBP pence), rates bps.
import type { LinkFee } from '../lib/fees.ts'

/** Where a demo investor stops. Each is a state the screens can reach on their own. */
export type DemoStage = 'kyc_in_review' | 'to_sign' | 'to_pay' | 'funded'

export interface DemoInvestor {
  /** One name, as the site shows it. Created through the operator's account route, which takes a single name. */
  name: string
  /** Local part only; the seed adds the run's own domain so a later run never reuses an address. */
  mailbox: string
  stage: DemoStage
  commitmentMinor: bigint
  /**
   * Whole days in this step at export time (P). The seed walks the investors in this order, longest first, so each one's
   * last step follows everything earlier; with the real clock its days are 0, the export moves its clock between them.
   */
  daysAtStep: number
}

export interface DemoDraftDeal {
  company: string
  /** Where the lead stops: a draft with some parts filled, or every part filled and sent for review. */
  stop: 'draft' | 'in_review'
}

export const DEMO_CURRENCY = 'GBP'

export const demoScenario = {
  lead: { name: 'Bulma Briefs', mailbox: 'lead' },
  /** Approves the KYC checks and records the money; retired at the end of every run (plan §4.4). */
  reviewer: { name: 'Demo reviewer', mailbox: 'reviewer' },
  syndicate: { name: 'Capsule Angels' },
  investee: { company: 'Senzu Labs Ltd', contact: 'Korin', mailbox: 'korin' },
  /** The live deal's link. The default link has no lead fee, so the seed opens this one (plan §3). */
  link: { name: 'Senzu lead fee', carryBps: 2_000, fee: { kind: 'percent', bps: 200, mode: 'on_top' } satisfies LinkFee },
  investors: [
    { name: 'Son Goku', mailbox: 'goku', stage: 'to_pay', commitmentMinor: 1_000_000n, daysAtStep: 1 },
    { name: 'Yamcha', mailbox: 'yamcha', stage: 'to_sign', commitmentMinor: 2_500_000n, daysAtStep: 4 },
    { name: 'Krillin', mailbox: 'krillin', stage: 'kyc_in_review', commitmentMinor: 500_000n, daysAtStep: 2 },
    { name: 'Tien', mailbox: 'tien', stage: 'funded', commitmentMinor: 1_500_000n, daysAtStep: 3 },
  ] satisfies DemoInvestor[],
  /** Two more deals of the same lead, without investors, for the lead's story (plan §3, owner 2026-11-23). */
  otherDeals: [
    { company: 'Dragon Radar Ltd', stop: 'draft' },
    { company: 'Kame House Ltd', stop: 'in_review' },
  ] satisfies DemoDraftDeal[],
} as const
