import { describe, it, expect } from 'vitest';
import { isUuid, assertUuid } from '@bb/common/utils/uuid.util';
import { BadRequestException } from '@bb/common/exceptions';

describe('isUuid', () => {
  it.each([
    ['018f4d3a-1c2b-7e90-8a1b-2c3d4e5f6071', true], // UUID v7
    ['9e107d9d-372b-4a8e-9f1c-0123456789ab', true],
    ['9E107D9D-372B-4A8E-9F1C-0123456789AB', true], // uppercase
    ['T-not-a-uuid', false], // the reported P2023 trigger
    ['12345', false], // legacyId int
    ['ABC12345', false], // 8-char program code
    ['018f4d3a1c2b7e908a1b2c3d4e5f6071', false], // no hyphens
    ['', false],
  ])('isUuid(%s) === %s', (input, expected) => {
    expect(isUuid(input)).toBe(expected);
  });

  it('returns false for null/undefined', () => {
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe('assertUuid', () => {
  it('passes through a valid UUID', () => {
    expect(() => assertUuid('9e107d9d-372b-4a8e-9f1c-0123456789ab')).not.toThrow();
  });

  it('throws BadRequestException on a non-UUID string', () => {
    expect(() => assertUuid('T-not-a-uuid')).toThrow(BadRequestException);
  });

  it('throws BadRequestException on null/undefined', () => {
    expect(() => assertUuid(null)).toThrow(BadRequestException);
    expect(() => assertUuid(undefined)).toThrow(BadRequestException);
  });
});
