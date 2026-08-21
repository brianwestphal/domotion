import { describe, expect, it } from 'vitest';
import {
  blinkLineClampActivation,
  blinkLineClampEllipsisText,
  blinkLineClampInlineStart,
  blinkLineClampLineIsVisible,
  blinkLogicalLineOrder,
  blinkShouldEmitLineClampEllipsis,
  parseBlinkLineClampCount,
} from './line-clamp.js';

describe('Blink generated line-clamp ellipsis primitives (DM-2417)', () => {
  it('parses only positive integer line counts', () => {
    expect(parseBlinkLineClampCount('1')).toBe(1);
    expect(parseBlinkLineClampCount(' 5 ')).toBe(5);
    for (const value of ['', 'none', '0', '-1', '2.5', 'auto']) {
      expect(parseBlinkLineClampCount(value)).toBeNull();
    }
  });

  it('requires vertical WebKit box orientation and behavioural activation', () => {
    const base = {
      webkitLineClamp: '3',
      webkitBoxOrient: 'vertical',
      computedDisplay: 'flow-root',
      behaviorallyClamps: true,
    };
    expect(blinkLineClampActivation(base)).toEqual({ clampCount: 3 });
    expect(blinkLineClampActivation({ ...base, webkitLineClamp: 'none' })).toBeNull();
    expect(blinkLineClampActivation({ ...base, webkitBoxOrient: 'horizontal' })).toBeNull();
    expect(blinkLineClampActivation({ ...base, computedDisplay: 'block' })).toBeNull();
    // Authored flow-root is CSSOM-indistinguishable from -webkit-box; the
    // isolated browser probe is therefore part of the exact activation gate.
    expect(blinkLineClampActivation({ ...base, behaviorallyClamps: false })).toBeNull();
  });

  it('matches Blink primary-font ellipsis fallback', () => {
    expect(blinkLineClampEllipsisText(true)).toBe('\u2026');
    expect(blinkLineClampEllipsisText(false)).toBe('...');
  });

  it('emits only when content continues beyond the clamp point', () => {
    const base = { active: true, clampCount: 3, totalLineCount: 4 };
    expect(blinkShouldEmitLineClampEllipsis(base)).toBe(true);
    expect(blinkShouldEmitLineClampEllipsis({ ...base, totalLineCount: 3 })).toBe(false);
    expect(blinkShouldEmitLineClampEllipsis({ ...base, active: false })).toBe(false);
    expect(blinkShouldEmitLineClampEllipsis({ ...base, emptyLine: true })).toBe(false);
    expect(blinkShouldEmitLineClampEllipsis({ ...base, blockInInline: true })).toBe(false);
  });

  it('orders horizontal, vertical-lr, and vertical-rl clamp lines logically', () => {
    expect(blinkLogicalLineOrder([42, 22, 22, 62], 'horizontal-tb')).toEqual([22, 42, 62]);
    expect(blinkLogicalLineOrder([80, 60, 40], 'vertical-lr')).toEqual([40, 60, 80]);
    expect(blinkLogicalLineOrder([80, 60, 40], 'vertical-rl')).toEqual([80, 60, 40]);
  });

  it('places shaped markers after LTR and before RTL retained content', () => {
    expect(blinkLineClampInlineStart({
      direction: 'ltr', adjacentInlineStart: 12.5, adjacentInlineEnd: 91.25, ellipsisAdvance: 16,
    })).toBe(91.25);
    expect(blinkLineClampInlineStart({
      direction: 'rtl', adjacentInlineStart: 12.5, adjacentInlineEnd: 91.25, ellipsisAdvance: 16,
    })).toBe(-3.5);
  });

  it('hides every source fragment past the clamp line', () => {
    expect([0, 1, 2, 3, 4].map((i) => blinkLineClampLineIsVisible(i, 3)))
      .toEqual([true, true, true, false, false]);
  });
});
