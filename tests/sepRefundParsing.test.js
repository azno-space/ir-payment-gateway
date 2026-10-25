// SEP refund service answers (SOAP) and what each error code asks the merchant to do.
const { parseRefundActionResponse, REFUND_STATUS } = require('../src/sep/refundResponse');
const { classifyRegError, ACTION } = require('../src/sep/refundErrors');

const actionXml = ({ referenceId = '0', errorCode = '', requestStatus = '' }) =>
  `<s:Envelope><a:ActionName>Refund_Reg</a:ActionName><a:ErrorCode>${errorCode}</a:ErrorCode>` +
  `<a:ErrorMessage>m</a:ErrorMessage><a:ReferenceId>${referenceId}</a:ReferenceId>` +
  `<a:RequestStatus>${requestStatus}</a:RequestStatus></s:Envelope>`;

describe('SEP refund answers', () => {
  it('reads a registered refund id and an error code', () => {
    const ok = parseRefundActionResponse(actionXml({ referenceId: '1234', requestStatus: 'Start' }));
    expect(ok.referenceId).toBe('1234');
    const dup = parseRefundActionResponse(actionXml({ errorCode: 'DuplicateRequest' }));
    expect(dup.errorCode).toBe('DuplicateRequest');
  });

  it('never treats an unknown error code as success', () => {
    expect(classifyRegError('SomethingNew').action).toBe(ACTION.MANUAL);
    expect(classifyRegError('DuplicateRequest').action).not.toBe(ACTION.MANUAL);
  });

  it('knows the documented refund states', () => {
    expect(Object.keys(REFUND_STATUS).length).toBeGreaterThan(0);
  });
});
