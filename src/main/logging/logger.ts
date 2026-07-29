import pino, { type DestinationStream, type Logger } from 'pino';

export const SECRET_REDACTION_PATHS = [
  'apiKey',
  'apiSecret',
  'secret',
  'signature',
  'authorization',
  'UPLOADER_WRITE_KEY',
  'ACTION_READ_KEY',
  'relayUploadKey',
  'actionReadKey',
  'X-MBX-APIKEY',
  'clientId',
  'clientSecret',
  'NAVER_CLIENT_ID',
  'NAVER_CLIENT_SECRET',
  '*.apiKey',
  '*.apiSecret',
  '*.secret',
  '*.signature',
  '*.authorization',
  '*.UPLOADER_WRITE_KEY',
  '*.ACTION_READ_KEY',
  '*.relayUploadKey',
  '*.actionReadKey',
  '*.X-MBX-APIKEY',
  '*.clientId',
  '*.clientSecret',
  '*.NAVER_CLIENT_ID',
  '*.NAVER_CLIENT_SECRET',
] as const;

export function createAppLogger(destination?: DestinationStream): Logger {
  const options = {
    name: 'btc-futures-assistant',
    level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
    redact: {
      paths: [...SECRET_REDACTION_PATHS],
      censor: '[REDACTED]',
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger = createAppLogger();
