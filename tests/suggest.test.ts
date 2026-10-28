import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactSnapshot, parseSuggestions, type PageSnapshot } from '../src/suggest.js';

const page: PageSnapshot = {
  url: 'https://shop.example.com/',
  title: 'Demo shop',
  headings: ['Products', 'Cart'],
  links: [{ text: 'Cart', href: 'https://shop.example.com/cart' }],
  buttons: ['Add to cart', 'Checkout'],
  inputs: ['search (text)', 'quantity (number)'],
  text: 'Welcome to the demo shop. Green tea costs 2500.',
};

describe('parseSuggestions', () => {
  it('keeps valid scenarios and caps the count', () => {
    const data = {
      scenarios: [
        { title: 'Buy tea', scenario: 'Add Green tea to the cart. Expected: cart shows ×1.', url: 'https://shop.example.com/' },
        { title: 'Search', scenario: 'Search for tea. Expected: results list it.', url: '/search' },
        { title: 'Extra', scenario: 'Do more. Expected: it works.', url: 'https://shop.example.com/' },
      ],
    };
    const out = parseSuggestions(data, 'https://shop.example.com/', 2);
    assert.equal(out.length, 2);
    assert.equal(out[0].title, 'Buy tea');
    assert.equal(out[1].url, 'https://shop.example.com/search');
  });

  it('fills in title and url and drops blank or duplicate scenarios', () => {
    const data = {
      scenarios: [
        { scenario: 'Add Green tea to the cart twice.\nExpected: the cart shows ×2.' },
        { scenario: '  ' },
        { title: 'Dup', scenario: 'Add  Green   tea to the cart twice. Expected: the cart shows ×2.' },
        { title: 'Bad url', scenario: 'Open the shop. Expected: products load.', url: 'ftp://files.example.com/x' },
      ],
    };
    const out = parseSuggestions(data, 'https://shop.example.com/', 10);
    assert.equal(out.length, 2);
    assert.equal(out[0].title, 'Add Green tea to the cart twice.');
    assert.equal(out[0].url, 'https://shop.example.com/');
    assert.equal(out[1].url, 'https://shop.example.com/');
  });

  it('returns an empty list for malformed model output', () => {
    assert.deepEqual(parseSuggestions(null, 'https://shop.example.com/', 10), []);
    assert.deepEqual(parseSuggestions({ scenarios: 'nope' }, 'https://shop.example.com/', 10), []);
    assert.deepEqual(parseSuggestions({ scenarios: [{ title: 'no text' }] }, 'https://shop.example.com/', 10), []);
  });
});

describe('compactSnapshot', () => {
  it('renders page facts and truncates long text', () => {
    const long = compactSnapshot({ ...page, text: 'x'.repeat(5000) });
    assert.ok(long.includes('Demo shop'));
    assert.ok(long.includes('Add to cart'));
    assert.ok(long.includes('quantity (number)'));
    assert.ok(long.length < 5000);
    const short = compactSnapshot(page);
    assert.ok(short.includes('Green tea costs 2500'));
  });
});
