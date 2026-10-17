import { expect, it } from 'vitest';
import { normalizeIdentifier, validateSale } from './configuration.js';
const sale = {
  id: ' SALE ',
  startsAt: '2030-01-01T10:00:00+07:00',
  endsAt: '2030-01-01T11:00:00+07:00',
  initialStock: 0,
};
it('normalizes generic identifiers and UTC instants, including zero stock', () => {
  expect(normalizeIdentifier("  A + ' / 人  ")).toBe("a + ' / 人");
  expect(normalizeIdentifier(' Alice ')).toBe(normalizeIdentifier('ALICE'));
  expect(validateSale(sale)).toEqual({
    ...sale,
    id: 'sale',
    startsAt: '2030-01-01T03:00:00.000Z',
    endsAt: '2030-01-01T04:00:00.000Z',
  });
});
it('rejects invalid ranges, ambiguous times, stock and infrastructure limits', () => {
  for (const initialStock of [-1, 0.5, NaN, Infinity, 2147483648])
    expect(() => validateSale({ ...sale, initialStock })).toThrow();
  for (const startsAt of [
    sale.endsAt,
    'nonsense',
    '2030-01-01T00:00:00',
    '2029-02-29T00:00:00Z',
    '2030-01-01T24:00:00Z',
  ])
    expect(() => validateSale({ ...sale, startsAt })).toThrow();
  for (const id of ['  ', '\0', 'x'.repeat(1025)])
    expect(() => normalizeIdentifier(id)).toThrow();
});
