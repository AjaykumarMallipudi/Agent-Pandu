import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: { paths: ['*.password', '*.SMTP_PASSWORD', '*.auth.pass', 'req.headers.authorization'], censor: '[redacted]' },
  transport:
    process.env.NODE_ENV === 'development' || (!process.env.NODE_ENV && process.stdout.isTTY)
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});
