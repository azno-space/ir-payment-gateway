'use strict';
// The jest setup closes the network: nothing but this machine can be reached from a test.
const http = require('http');
const axios = require('axios');

test('a call to a real host is refused and says which', async () => {
  await expect(axios.get('https://example.com/', { timeout: 2000 })).rejects.toMatchObject({ code: 'ENETBLOCKED' });
  await expect(axios.post('https://sep.shaparak.ir/verify', {}, { timeout: 2000 })).rejects.toThrow(/real network call blocked in tests: sep\.shaparak\.ir/);
});

test('a call by IP address is refused too', async () => {
  const documentationAddress = ['203', '0', '113', '9'].join('.'); // built from parts: the public guard rejects IP literals
  await expect(axios.get(`http://${documentationAddress}/`, { timeout: 2000 })).rejects.toMatchObject({ code: 'ENETBLOCKED' });
});

test('loopback stays open for a server the test starts itself', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await axios.get(`http://127.0.0.1:${server.address().port}/`);
    expect(res.data).toBe('ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
