import nodemailer from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import { config } from '../config.js';

export interface SendInfo {
  messageId?: string;
  response?: string;
  accepted?: (string | { address: string })[];
  rejected?: (string | { address: string })[];
}
export interface MailTransport {
  sendMail(msg: Mail.Options): Promise<SendInfo>;
  verify(): Promise<unknown>;
}

export type TransportFactory = () => MailTransport;

const realFactory: TransportFactory = () => {
  const c = config();
  return nodemailer.createTransport({
    host: c.SMTP_HOST,
    port: c.SMTP_PORT,
    secure: c.SMTP_SECURE,
    auth: c.SMTP_USER ? { user: c.SMTP_USER, pass: c.SMTP_PASSWORD } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  }) as unknown as MailTransport;
};

let factory: TransportFactory = realFactory;
let cached: MailTransport | null = null;

/** Test hook: replace the real SMTP transport. */
export function setTransportFactory(f?: TransportFactory): void {
  factory = f ?? realFactory;
  cached = null;
}

export function realTransport(): MailTransport {
  if (!cached) cached = factory();
  return cached;
}

/** Network-free transport used in test mode: builds the full MIME message but never connects anywhere. */
const simulated = nodemailer.createTransport({ jsonTransport: true }) as unknown as MailTransport;
export function simulatedTransport(): MailTransport {
  return simulated;
}

export function smtpStatus(): { configured: boolean; missing: string[]; host: string; port: number; secure: boolean; user: string; from: string; senderName: string; testAddress: string } {
  const c = config();
  const missing: string[] = [];
  if (!c.SMTP_HOST) missing.push('SMTP_HOST');
  if (!c.EMAIL_FROM) missing.push('EMAIL_FROM');
  if (!c.SENDER_NAME) missing.push('SENDER_NAME');
  if (c.SMTP_USER && !c.SMTP_PASSWORD) missing.push('SMTP_PASSWORD');
  // Never return the password; mask the username.
  const user = c.SMTP_USER ? c.SMTP_USER.replace(/^(.{2}).*(@.*)?$/, (_m, a: string, b?: string) => `${a}***${b ?? ''}`) : '';
  return {
    configured: missing.length === 0,
    missing,
    host: c.SMTP_HOST,
    port: c.SMTP_PORT,
    secure: c.SMTP_SECURE,
    user,
    from: c.EMAIL_FROM,
    senderName: c.SENDER_NAME,
    testAddress: c.TEST_EMAIL_ADDRESS,
  };
}

export function fromHeader(): { name: string; address: string } {
  const c = config();
  return { name: c.SENDER_NAME, address: c.EMAIL_FROM.replace(/^.*<([^>]+)>.*$/, '$1').trim() };
}
