import { describe, expect, it } from 'vitest'
import type { Draft } from './draft.ts'
import { dealRecordsDue, emailComplaintDue, transactionCutoff, withoutPeople } from './retention.ts'

describe('D4 retention rules (R-KYC-04, §5.6)', () => {
  const ended = new Date('2026-11-17T10:00:00Z')

  it('TC-KYC-07 (lib) the deal’s clock starts at its end: the configured years to the day, never under a hold or with no end', () => {
    expect(dealRecordsDue({ endedAt: ended, hold: false }, 5, new Date('2031-11-17T09:59:59Z'))).toBe(false)
    expect(dealRecordsDue({ endedAt: ended, hold: false }, 5, new Date('2031-11-17T10:00:00Z'))).toBe(true)
    expect(dealRecordsDue({ endedAt: ended, hold: true }, 5, new Date('2040-01-01T00:00:00Z'))).toBe(false)
    expect(dealRecordsDue({ endedAt: null, hold: false }, 5, new Date('2040-01-01T00:00:00Z'))).toBe(false)
    // zero years is allowed (R-KYC-04 sets no lower limit): due at once
    expect(dealRecordsDue({ endedAt: ended, hold: false }, 0, ended)).toBe(true)
  })

  it('TC-KYC-07 (lib) transaction records: rows dated on or before the day the configured years back; a leap day falls back to the month’s end', () => {
    expect(transactionCutoff(new Date('2037-11-11T08:00:00Z'), 10)).toBe('2027-11-11')
    expect(transactionCutoff(new Date('2037-11-11T08:00:00Z'), 11)).toBe('2026-11-11')
    expect(transactionCutoff(new Date('2036-02-29T12:00:00Z'), 1)).toBe('2035-02-28')
    expect(transactionCutoff(new Date('2037-11-11T08:00:00Z'), 0)).toBe('2037-11-11')
  })

  it('TC-KYC-07 (lib) an emailed complaint with no account is kept the same years from receipt', () => {
    const received = new Date('2026-11-17T00:00:00Z')
    expect(emailComplaintDue(received, 5, new Date('2031-11-16T23:59:59Z'))).toBe(false)
    expect(emailComplaintDue(received, 5, new Date('2031-11-17T00:00:00Z'))).toBe(true)
  })

  it('TC-KYC-07 (lib) the working copy loses the contact’s and each recipient’s name and address; the company and the rest stay', () => {
    const draft: Draft = {
      basics: { name: 'Seed round' },
      company: { legal_name: 'Seedling Ltd', contact_name: 'Sam Founder', contact_email: 'sam@example.test', jurisdiction: 'England and Wales' },
      economics: {
        default_carry_bps: 2000,
        recipients: [
          { kind: 'person', first_name: 'Cara', last_name: 'Carry', email: 'cara@example.test', share_bps: 6000 },
          {
            kind: 'company',
            legal_name: 'Carry Co Ltd',
            registration_number: '123',
            contact_name: 'Con Tact',
            contact_email: 'con@example.test',
            share_bps: 4000,
          },
        ],
      },
    }
    expect(withoutPeople(draft)).toEqual({
      basics: { name: 'Seed round' },
      company: { legal_name: 'Seedling Ltd', jurisdiction: 'England and Wales' },
      economics: {
        default_carry_bps: 2000,
        recipients: [
          { kind: 'person', share_bps: 6000 },
          { kind: 'company', legal_name: 'Carry Co Ltd', registration_number: '123', share_bps: 4000 },
        ],
      },
    })
    // nothing to take: unchanged, and the input is not touched
    expect(withoutPeople({ terms: { currency: 'GBP' } })).toEqual({ terms: { currency: 'GBP' } })
    expect(draft.company!.contact_name).toBe('Sam Founder')
  })
})
