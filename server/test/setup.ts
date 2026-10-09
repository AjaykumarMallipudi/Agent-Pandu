import nock from 'nock';
import { afterAll, afterEach, beforeAll } from 'vitest';

process.env.NODE_ENV = 'test';

beforeAll(() => {
  // Tests must never reach the real network (search APIs, websites, SMTP). Only local supertest servers are allowed.
  nock.disableNetConnect();
  nock.enableNetConnect(/^(127\.0\.0\.1|localhost)(:\d+)?$/);
});
afterEach(() => {
  nock.cleanAll();
});
afterAll(() => {
  nock.enableNetConnect();
});
