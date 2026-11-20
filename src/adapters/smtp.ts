// R-NTF-02, plan decision R28 (8): the real mode's mail goes through the operator's SMTP server, set in a mounted file (as R10).
// Only the mail queue calls it (src/server/outbox.ts), and no request waits for it. Plain text, or HTML alone for promotional mail (R-COM-06).
import nodemailer, { type Transporter } from 'nodemailer'
import { z } from 'zod'
import type { MailMessage, Mailer } from './index.ts'

export const SmtpSettings = z.strictObject({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  // true: TLS from the start (usually 465); false: STARTTLS, which is then required, never plain text
  secure: z.boolean(),
  user: z.string().min(1).max(320).optional(),
  from: z.email().max(320),
})
export type SmtpSettings = z.infer<typeof SmtpSettings>

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter
  private readonly from: string
  constructor(s: SmtpSettings, password?: string) {
    if (s.user && !password) throw new Error('SMTP has a user but no password file')
    this.from = s.from
    this.transport = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      requireTLS: !s.secure,
      auth: s.user ? { user: s.user, pass: password } : undefined,
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 60_000,
    })
  }
  async send(m: MailMessage) {
    // a promotional mail has no plain-text part, so no mail program can show it without the warning block
    await this.transport.sendMail({ from: this.from, to: m.to, subject: m.subject, ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...(m.html ? { html: m.body } : { text: m.body }) })
    return { delivered: true }
  }
}
