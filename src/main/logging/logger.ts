import pino from 'pino';

export const logger = pino({
  name: 'btc-futures-assistant',
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  redact: {
    paths: [
      'apiKey',
      'secret',
      'signature',
      'X-MBX-APIKEY',
      '*.apiKey',
      '*.secret',
      '*.signature',
      '*.X-MBX-APIKEY',
    ],
    censor: '[REDACTED]',
  },
});
