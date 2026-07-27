import { describe, expect, it } from 'vitest';

import {
  allowedExternalUrlSchema,
  clipboardTextSchema,
  databaseCheckInputSchema,
} from '../../src/shared/schemas';

describe('Phase 0 input schemas', () => {
  it('allows the configured ChatGPT origin', () => {
    expect(
      allowedExternalUrlSchema.parse('https://chatgpt.com/?model=test'),
    ).toBe('https://chatgpt.com/?model=test');
  });

  it('blocks non-HTTPS and unapproved external origins', () => {
    expect(() =>
      allowedExternalUrlSchema.parse('http://chatgpt.com/'),
    ).toThrow();
    expect(() =>
      allowedExternalUrlSchema.parse('https://example.com/'),
    ).toThrow();
  });

  it('rejects empty clipboard and database values', () => {
    expect(() => clipboardTextSchema.parse('   ')).toThrow();
    expect(() => databaseCheckInputSchema.parse({ value: '' })).toThrow();
  });
});
