'use strict';
const { chargedRial } = require('../src/utils/chargedAmount');

describe('chargedRial', () => {
  test('zibal uses the verify response amount', () => {
    expect(chargedRial('zibal', { amount: 120000 })).toBe(120000);
  });
  test('zarinpal uses the stored session amount', () => {
    expect(chargedRial('zarinpal', { data: { code: 100 } }, 450000)).toBe(450000);
  });
  test('sep uses the verify response, not the callback', () => {
    expect(chargedRial('sep', { Success: true, TransactionDetail: { OrginalAmount: 990000 } })).toBe(990000);
  });
  test('null when the gateway reported nothing', () => {
    expect(chargedRial('sep', { Success: true })).toBeNull();
    expect(chargedRial('zibal', {})).toBeNull();
    expect(chargedRial('zarinpal', {}, undefined)).toBeNull();
    expect(chargedRial('unknown', {}, 5)).toBeNull();
  });
});
