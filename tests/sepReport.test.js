'use strict';

describe('SEP transaction report', () => {
  let post;
  let report;

  beforeEach(() => {
    jest.resetModules();
    process.env.SEP_REPORT_USERNAME = 'u';
    process.env.SEP_REPORT_PASSWORD = 'p';
    process.env.SEP_REPORT_WEBSERVICE_KEY = 'k';
    jest.doMock('axios', () => ({ post: jest.fn() }));
    post = require('axios').post;
    report = require('../src/services/sep-report.service');
  });

  test('sends the date range as the two switch-date conditions', async () => {
    post.mockResolvedValue({ data: { success: true, count: 1, data: JSON.stringify([{ ResNum: 'o1' }]) } });
    const rows = await report.sepGetTransactionReport({ fromDate: '1405/07/12', toDate: '1405/07/13' });
    expect(rows).toEqual([{ ResNum: 'o1' }]);
    const body = post.mock.calls[0][1];
    expect(body.serviceColumns[0].conditionValue).toBe('1405/07/12');
    expect(body.serviceColumns[1].conditionValue).toBe('1405/07/13');
    expect(body.UserName).toBe('u');
  });

  test('refuses a partial answer and a bad date before calling SEP', async () => {
    post.mockResolvedValue({ data: { success: true, count: 3, data: '[]' } });
    await expect(report.sepGetTransactionReport({ fromDate: '1405/07/12', toDate: '1405/07/13' })).rejects.toThrow('count 3');
    await expect(report.sepGetTransactionReport({ fromDate: '2026-10-05', toDate: '1405/07/13' })).rejects.toThrow('Persian dates');
    expect(post).toHaveBeenCalledTimes(1);
  });

  test('unconfigured is reported, not attempted', () => {
    delete process.env.SEP_REPORT_WEBSERVICE_KEY;
    expect(report.isConfigured()).toBe(false);
  });
});
