import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '@/config/env';
import { logger } from '@/config/logger';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

class Mailer {
  private transporter: Transporter | null = null;

  private getTransport(): Transporter | null {
    if (this.transporter) return this.transporter;
    if (!env.smtp.host) return null;
    this.transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
    });
    return this.transporter;
  }

  async send(msg: MailMessage): Promise<void> {
    const transport = this.getTransport();
    if (!transport) {
      logger.warn(
        { to: msg.to, subject: msg.subject, body: msg.text },
        '[mailer] SMTP_HOST not configured — printing message instead of sending',
      );
      return;
    }
    await transport.sendMail({
      from: env.smtp.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
  }
}

export const mailer = new Mailer();
