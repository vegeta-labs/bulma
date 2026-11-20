import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { realAdaptersFromEnv } from './fromEnv.ts'
import { SmtpMailer } from './smtp.ts'

const dir = mkdtempSync(join(tmpdir(), 'bulma-smtp-'))
const put = (name: string, text: string) => {
  const p = join(dir, name)
  writeFileSync(p, text)
  return p
}

describe('the real mode mail settings (R-NTF-02, decision R28 (8))', () => {
  it('TC-NTF-02 SMTP is set from mounted files; a half or wrong setting stops the start', () => {
    const settings = put('smtp.json', JSON.stringify({ host: 'mail.internal', port: 587, secure: false, user: 'bulma', from: 'deals@operator.test' }))
    const password = put('smtp_password', 'pw\n')
    expect(realAdaptersFromEnv({ SMTP_SETTINGS_FILE: settings, SMTP_PASSWORD_FILE: password }).mailer).toBeInstanceOf(SmtpMailer)
    // no settings: no mailer, so the real mode refuses to send rather than send somewhere unknown
    expect(realAdaptersFromEnv({}).mailer).toBeUndefined()
    expect(() => realAdaptersFromEnv({ SMTP_PASSWORD_FILE: password })).toThrow(/without SMTP_SETTINGS_FILE/)
    expect(() => realAdaptersFromEnv({ SMTP_SETTINGS_FILE: settings })).toThrow(/no password/)
    const unknown = put(
      'bad.json',
      JSON.stringify({ host: 'mail.internal', port: 587, secure: false, from: 'deals@operator.test', tls: { rejectUnauthorized: false } }),
    )
    expect(() => realAdaptersFromEnv({ SMTP_SETTINGS_FILE: unknown })).toThrow()
    const noUser = put('nouser.json', JSON.stringify({ host: 'relay.internal', port: 25, secure: false, from: 'deals@operator.test' }))
    expect(realAdaptersFromEnv({ SMTP_SETTINGS_FILE: noUser }).mailer).toBeInstanceOf(SmtpMailer)
  })
})
