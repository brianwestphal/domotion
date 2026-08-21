import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isStretchyFenceChar,
  mathMLOperatorDictionaryEntry,
  type MathMLOperatorForm,
} from './unicode-classification.js';

const FORMS: MathMLOperatorForm[] = ['infix', 'prefix', 'postfix'];

describe('generated Blink MathML operator dictionary (DM-2397)', () => {
  it('has a stable exhaustive digest across every BMP scalar and form', () => {
    const rows: string[] = [];
    for (let cp = 1; cp <= 0xffff; cp++) {
      const content = String.fromCharCode(cp);
      for (const form of FORMS) {
        const entry = mathMLOperatorDictionaryEntry(content, form);
        if (entry.category !== 'none') rows.push(`${cp.toString(16)}:${form}:${entry.category}`);
      }
    }
    for (const content of ['!!', '!=', '&&', '**', '*=', '++', '+=', '--', '-=', '->', '//', '/=', ':=', '<=', '<>', '==', '>=', '||', '\u{1eef0}', '\u{1eef1}']) {
      for (const form of FORMS) {
        const entry = mathMLOperatorDictionaryEntry(content, form);
        if (entry.category !== 'none') rows.push(`${content}:${form}:${entry.category}`);
      }
    }
    expect(rows.length).toBe(729);
    expect(createHash('sha256').update(rows.join('\n')).digest('hex'))
      .toBe('1d24b382caf77726b6edc9acc2a844d210090d01fb71b4a6b4daaf72478dc312');
  });

  it('transcribes category spacing and stretch/symmetry metadata', () => {
    expect(mathMLOperatorDictionaryEntry('(', 'prefix')).toMatchObject({
      category: 'F/G', leadingSpaceMathUnits: 0, trailingSpaceMathUnits: 0,
      stretchy: true, symmetric: true, largeOp: false, movableLimits: false,
      fence: false, separator: false,
    });
    expect(mathMLOperatorDictionaryEntry('∑', 'prefix')).toMatchObject({
      category: 'J', leadingSpaceMathUnits: 3, trailingSpaceMathUnits: 3,
      stretchy: false, symmetric: true, largeOp: true, movableLimits: true,
    });
    expect(mathMLOperatorDictionaryEntry(',', 'infix')).toMatchObject({
      category: 'M', leadingSpaceMathUnits: 0, trailingSpaceMathUnits: 3,
    });
  });

  it('uses the full vertical-stretch intersection, not a curated fence list', () => {
    for (const content of ['(', ')', '⟦', '⟧', '⟮', '⟯', '⦃', '⦄']) {
      expect(isStretchyFenceChar(content), content).toBe(true);
    }
    for (const content of ['→', '=', '^', '_', '~', '∑', 'A', '...', '']) {
      expect(isStretchyFenceChar(content), content).toBe(false);
    }
  });

  it('keeps overlay, two-ASCII, Arabic SMP, and unknown controls exact', () => {
    expect(mathMLOperatorDictionaryEntry('≠', 'infix'))
      .toEqual(mathMLOperatorDictionaryEntry(`=\u0338`, 'infix'));
    expect(mathMLOperatorDictionaryEntry('&&', 'infix').category).toBe('B');
    expect(mathMLOperatorDictionaryEntry('!=', 'infix').category).toBe('none');
    expect(mathMLOperatorDictionaryEntry('\u{1eef0}', 'postfix').category).toBe('I');
    expect(mathMLOperatorDictionaryEntry('\u{1eef0}', 'prefix').category).toBe('none');
    expect(mathMLOperatorDictionaryEntry('ordinary', 'infix').category).toBe('none');
  });
});
