'use strict';
// Pins the small pure helpers before they are restructured: what each returns for every shape of input.
const { parseGatewayParams } = require('../src/controllers/callbackParams');
const { chargedRial } = require('../src/utils/chargedAmount');

describe('parseGatewayParams', () => {
  const cases = [
    [{ trackId: '5', orderId: 'o' }, { gateway: 'zibal', code: '5', orderId: 'o' }],
    [{ trackID: '5', orderID: 'o' }, { gateway: 'zibal', code: '5', orderId: 'o' }],
    [{ trackid: '5', orderid: 'o' }, { gateway: 'zibal', code: '5', orderId: 'o' }],
    [{ trackId: '5' }, { gateway: 'zibal', code: '5', orderId: '' }],
    [{ trackId: '5', Authority: 'A', RefNum: 'R' }, { gateway: 'zibal', code: '5', orderId: '' }],
    [{ Authority: 'A', orderId: 'o' }, { gateway: 'zarinpal', code: 'A', orderId: 'o' }],
    [{ authority: 'A' }, { gateway: 'zarinpal', code: 'A', orderId: '' }],
    [{ Authority: 'A', RefNum: 'R' }, { gateway: 'zarinpal', code: 'A', orderId: '' }],
    [{ RefNum: 'R', ResNum: 'o' }, { gateway: 'sep', code: 'R', orderId: 'o' }],
    [{ refNum: 'R' }, { gateway: 'sep', code: 'R', orderId: '' }],
    [{ refnum: 'R', resnum: 'o' }, { gateway: 'sep', code: 'R', orderId: 'o' }],
    [{ ResNum: 'o' }, { gateway: 'sep', code: 'o', orderId: 'o' }],
    [{ resNum: 'o' }, { gateway: 'sep', code: 'o', orderId: 'o' }],
    [{ Status: '1' }, { gateway: 'sep', code: '', orderId: '' }],
    [{ status: '2', State: 'OK' }, { gateway: 'sep', code: '', orderId: '' }],
    [{ State: 'OK' }, { gateway: '', code: '', orderId: '' }],
    [{}, { gateway: '', code: '', orderId: '' }],
    [{ foo: 'bar' }, { gateway: '', code: '', orderId: '' }],
    [{ RefNum: '', refNum: 'R' }, { gateway: 'sep', code: 'R', orderId: '' }],
    [{ trackId: 0 }, { gateway: '', code: '', orderId: '' }],
    [{ Status: 0 }, { gateway: '', code: '', orderId: '' }],
    [{ Status: '0' }, { gateway: 'sep', code: '', orderId: '' }],
    [{ trackId: '', Authority: 'A' }, { gateway: 'zarinpal', code: 'A', orderId: '' }],
    [{ trackId: '' }, { gateway: '', code: '', orderId: '' }],
    [{ trackId: ['a', 'b'], orderId: ['x'] }, { gateway: 'zibal', code: ['a', 'b'], orderId: ['x'] }],
  ];
  test.each(cases)('%j', (query, expected) => {
    expect(parseGatewayParams(query)).toEqual(expected);
  });
});

describe('chargedRial', () => {
  const cases = [
    ['zibal', { amount: 5000 }, null, 5000],
    ['zibal', { amount: '5000' }, null, 5000],
    ['zibal', {}, null, null],
    ['zibal', null, null, null],
    ['zibal', { amount: '' }, null, null],
    ['zibal', { amount: -1 }, null, null],
    ['zibal', { amount: 'abc' }, null, null],
    ['zibal', { amount: 0 }, null, 0],
    ['zarinpal', {}, 2500, 2500],
    ['zarinpal_sandbox', {}, '2500', 2500],
    ['zarinpal', {}, null, null],
    ['zarinpal', {}, undefined, null],
    ['sep', { TransactionDetail: { OrginalAmount: 7000 } }, null, 7000],
    ['sep', { TransactionDetail: { OrginalAmount: '7000' } }, null, 7000],
    ['sep', { TransactionDetail: {} }, null, null],
    ['sep', {}, null, null],
    ['sep', undefined, null, null],
    ['unknown', { amount: 5 }, 5, null],
    ['', {}, 5, null],
    [['zibal'], { amount: 5 }, null, null],
    ['constructor', { amount: 5 }, 5, null],
    ['__proto__', { amount: 5 }, 5, null],
    ['toString', { amount: 5 }, 5, null],
  ];
  test.each(cases)('%s %j session=%j -> %j', (gateway, verifyResult, sessionAmount, expected) => {
    expect(chargedRial(gateway, verifyResult, sessionAmount)).toBe(expected);
  });
});
