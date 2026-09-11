import test from 'node:test';
import assert from 'node:assert/strict';
import { Five9RestClient } from '../src/five9rest.js';

// Regression: {domainId} used to expand to '' when FIVE9_DOMAIN_ID was unset,
// silently producing /campaigns/v1/domains//campaigns. Most services answer
// that with a bare 404, which reads as "no such endpoint" rather than
// "no domain id" — the failure mode this guards against.
test('{domainId} is never expanded to an empty path segment', async () => {
  const c = new Five9RestClient({ restConsumerKey: 'k', restConsumerSecret: 's' });
  await assert.rejects(
    () => c._resolvePath('/campaigns/v1/domains/{domainId}/campaigns'),
    /No Five9 domain id available/,
  );
});

test('a configured domain id is substituted without calling the resolver', async () => {
  let calls = 0;
  const c = new Five9RestClient({
    restConsumerKey: 'k', restConsumerSecret: 's', restDomainId: '143050',
    domainIdResolver: () => { calls++; return '999'; },
  });
  assert.equal(await c._resolvePath('/prompts/v1/domains/{domainId}/prompts'), '/prompts/v1/domains/143050/prompts');
  assert.equal(calls, 0);
});

test('the resolver supplies the domain id once and the result is cached', async () => {
  let calls = 0;
  const c = new Five9RestClient({
    restConsumerKey: 'k', restConsumerSecret: 's',
    domainIdResolver: async () => { calls++; return '143050'; },
  });
  const [a, b] = await Promise.all([
    c._resolvePath('/campaigns/v1/domains/{domainId}/campaigns'),
    c._resolvePath('/numbers/v1/domains/{domainId}/phone-numbers'),
  ]);
  assert.equal(a, '/campaigns/v1/domains/143050/campaigns');
  assert.equal(b, '/numbers/v1/domains/143050/phone-numbers');
  assert.equal(calls, 1);
  assert.equal(c.domainId, '143050');
});

test('a resolver that returns nothing is an error, not an empty segment', async () => {
  const c = new Five9RestClient({
    restConsumerKey: 'k', restConsumerSecret: 's',
    domainIdResolver: async () => '',
  });
  await assert.rejects(
    () => c._resolvePath('/campaigns/v1/domains/{domainId}/campaigns'),
    /returned nothing/,
  );
});

test('paths without the placeholder never trigger a domain lookup', async () => {
  let calls = 0;
  const c = new Five9RestClient({
    restConsumerKey: 'k', restConsumerSecret: 's',
    domainIdResolver: () => { calls++; return '143050'; },
  });
  assert.equal(await c._resolvePath('oauth2/v1/token'), '/oauth2/v1/token');
  assert.equal(calls, 0);
});
