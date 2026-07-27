import { z } from 'zod';

export const clipboardTextSchema = z
  .string()
  .trim()
  .min(1, '복사할 내용이 없습니다.')
  .max(50_000, '복사할 내용이 너무 깁니다.');

export const databaseCheckInputSchema = z.object({
  value: z
    .string()
    .trim()
    .min(1, '저장할 값이 없습니다.')
    .max(200, '테스트 값은 200자 이하여야 합니다.'),
});

const allowedExternalOrigins = new Set(['https://chatgpt.com']);

export const allowedExternalUrlSchema = z
  .url('올바른 URL이 아닙니다.')
  .transform((value, context) => {
    const parsed = new URL(value);

    if (
      parsed.protocol !== 'https:' ||
      !allowedExternalOrigins.has(parsed.origin)
    ) {
      context.addIssue({
        code: 'custom',
        message: '허용되지 않은 외부 URL입니다.',
      });

      return z.NEVER;
    }

    return parsed.toString();
  });
