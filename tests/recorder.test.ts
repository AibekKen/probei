import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HOLD_S, Timeline } from '../src/recorder.js';

describe('Timeline', () => {
  it('holds each frame until the next one at 25 fps', () => {
    const t = new Timeline(25, 1);
    assert.equal(t.next(100), 0); // first frame: nothing to write yet
    assert.equal(t.next(100.2), 5); // previous frame shown for 0.2 s
    assert.equal(t.next(100.24), 1);
  });

  it('cuts long still stretches down to the max hold', () => {
    const t = new Timeline(25, MAX_HOLD_S);
    t.next(0);
    assert.equal(t.next(60), Math.round(MAX_HOLD_S * 25)); // a minute of thinking → 0.8 s
  });

  it('carries rounding so frame counts stay in sync with time', () => {
    const t = new Timeline(25, 1);
    t.next(0);
    let total = 0;
    for (let i = 1; i <= 10; i++) total += t.next(i * 0.03);
    assert.equal(total, Math.round(0.3 * 25));
  });

  it('ends with a short hold of the last frame, never zero frames', () => {
    const t = new Timeline(25, 1);
    assert.equal(t.end(), 0); // no frames at all
    t.next(0);
    assert.ok(t.end(0) >= 1);
  });
});
