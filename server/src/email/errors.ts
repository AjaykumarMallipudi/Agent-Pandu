export type SmtpErrorKind = 'permanent' | 'transient' | 'ambiguous' | 'config';

export interface SmtpErrorClass {
  kind: SmtpErrorKind;
  code: string;
  message: string;
  recipientRejected: boolean;
}

/** Commands that happen before the message body is handed over — a failure here cannot have sent anything. */
const PRE_SUBMISSION = /^(CONN|EHLO|HELO|LHLO|STARTTLS|AUTH.*|MAIL FROM|RCPT TO)$/i;
const PRE_SUBMISSION_CODES = new Set(['ECONNECTION', 'ECONNREFUSED', 'EDNS', 'ENOTFOUND', 'ETLS', 'EAI_AGAIN']);

/**
 * Classifies a Nodemailer error:
 * - 5xx reply → permanent (do not retry)
 * - 4xx reply → transient (safe to retry: server explicitly did not accept)
 * - failure before DATA with no reply → transient (nothing was submitted)
 * - auth failure → config (pause campaign)
 * - anything else (timeout/socket loss during or after DATA, unknown) → ambiguous: never auto-retried
 */
export function classifySmtpError(err: unknown): SmtpErrorClass {
  const e = (err ?? {}) as { code?: string; responseCode?: number; command?: string; message?: string; response?: string };
  const code = e.code ?? (e.responseCode ? String(e.responseCode) : 'UNKNOWN');
  const message = (e.response || e.message || 'Unknown SMTP error').slice(0, 500);
  const command = e.command ?? '';
  const recipientRejected = /^RCPT TO$/i.test(command);

  if (e.code === 'EAUTH' || /^AUTH/i.test(command)) return { kind: 'config', code: 'EAUTH', message, recipientRejected: false };
  if (typeof e.responseCode === 'number') {
    if (e.responseCode >= 500) return { kind: 'permanent', code, message, recipientRejected };
    if (e.responseCode >= 400) return { kind: 'transient', code, message, recipientRejected: false };
  }
  if (e.code === 'EENVELOPE' && !e.responseCode) return { kind: 'permanent', code, message, recipientRejected: true };
  if (PRE_SUBMISSION.test(command) || (!command && e.code && PRE_SUBMISSION_CODES.has(e.code))) {
    return { kind: 'transient', code, message, recipientRejected: false };
  }
  return { kind: 'ambiguous', code, message, recipientRejected: false };
}
