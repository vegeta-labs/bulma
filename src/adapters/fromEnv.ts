// What a deployment configured (tech design §7). Only used in the real mode; the sandbox ignores all of it.
import { readFileSync } from 'node:fs'
import { Clamd, LocalStorage, type RealAdapters } from './index.ts'
import { SmtpMailer, SmtpSettings } from './smtp.ts'
import { SumsubKyc } from './sumsub.ts'

const file = (name: string, env: NodeJS.ProcessEnv) => (env[name] ? readFileSync(env[name]!, 'utf8').trim() : undefined)

export function realAdaptersFromEnv(env: NodeJS.ProcessEnv = process.env): RealAdapters {
  const out: RealAdapters = {}
  if (env.STORAGE_DIR) out.storage = new LocalStorage(env.STORAGE_DIR)
  if (env.CLAMD_HOST) out.scanner = new Clamd(env.CLAMD_HOST, Number(env.CLAMD_PORT ?? 3310))
  const sumsub = ['SUMSUB_APP_TOKEN_FILE', 'SUMSUB_SECRET_KEY_FILE', 'SUMSUB_WEBHOOK_SECRET_FILE', 'SUMSUB_LEVEL_NAME'].filter((k) => env[k])
  if (sumsub.length && sumsub.length < 4) throw new Error('Sumsub is only partly configured: set all of SUMSUB_APP_TOKEN_FILE, SUMSUB_SECRET_KEY_FILE, SUMSUB_WEBHOOK_SECRET_FILE and SUMSUB_LEVEL_NAME, or none')
  const appToken = file('SUMSUB_APP_TOKEN_FILE', env)
  const secretKey = file('SUMSUB_SECRET_KEY_FILE', env)
  const webhookSecret = file('SUMSUB_WEBHOOK_SECRET_FILE', env)
  if (appToken && secretKey && webhookSecret && env.SUMSUB_LEVEL_NAME) out.kyc = new SumsubKyc({ appToken, secretKey, webhookSecret, levelName: env.SUMSUB_LEVEL_NAME })
  // R28 (8): a JSON file of settings, and the password in a file of its own
  const smtp = file('SMTP_SETTINGS_FILE', env)
  if (smtp) out.mailer = new SmtpMailer(SmtpSettings.parse(JSON.parse(smtp)), file('SMTP_PASSWORD_FILE', env))
  else if (env.SMTP_PASSWORD_FILE) throw new Error('SMTP_PASSWORD_FILE is set without SMTP_SETTINGS_FILE')
  return out
}
