import { describe, expect, it } from 'vitest';
import { activeColumnScript, activeValidateScript, scriptState } from '../../../packages/shared/src/column-scripts.js';
import type { ColumnSpec } from '../../../packages/shared/src/types.js';

/**
 * The one rule that decides whether a column's script runs.
 *
 * It exists to be asked, not re-derived: a reader that writes `col.script?.trim()`
 * for itself runs a script the user switched off, and the column editor then says
 * red while the grid computes away. These tests pin the two properties everything
 * else leans on — ABSENT MEANS ON, so no column written before the switch existed
 * changes behaviour, and a blank body is "none" rather than a script that fails.
 */

const col = (over: Partial<ColumnSpec>): ColumnSpec => ({ field: 'f', label: 'F', type: 'string', ...over });

describe('activeColumnScript', () => {
  it('returns the source when there is one and no switch', () => {
    expect(activeColumnScript(col({ script: 'return 1;' }))).toBe('return 1;');
  });

  it('treats an absent switch as ON, so old columns are unchanged', () => {
    // The whole compatibility story in one assertion: every ColumnSpec written
    // before `scriptActive` existed has it absent.
    const before: ColumnSpec = col({ script: 'return 1;' });
    expect('scriptActive' in before).toBe(false);
    expect(activeColumnScript(before)).toBe('return 1;');
  });

  it('withholds the source when the switch is off', () => {
    expect(activeColumnScript(col({ script: 'return 1;', scriptActive: false }))).toBeUndefined();
  });

  it('runs it again when the switch goes back on', () => {
    expect(activeColumnScript(col({ script: 'return 1;', scriptActive: true }))).toBe('return 1;');
  });

  it('is undefined for no script, a blank one, and whitespace', () => {
    expect(activeColumnScript(col({}))).toBeUndefined();
    expect(activeColumnScript(col({ script: '' }))).toBeUndefined();
    expect(activeColumnScript(col({ script: '   \n\t ' }))).toBeUndefined();
  });

  it('is undefined for no column at all', () => {
    // Callers hold `ColumnSpec | undefined` (a token mapped to a field that no
    // longer exists), and asking about a column that is not there is a fair
    // question with an obvious answer.
    expect(activeColumnScript(undefined)).toBeUndefined();
  });

  it('does not trim what it returns — the body is handed back verbatim', () => {
    // The compile cache is keyed by source string, so trimming here would
    // compile the same script twice under two keys.
    expect(activeColumnScript(col({ script: '  return 1;  ' }))).toBe('  return 1;  ');
  });

  it('ignores the OTHER script’s switch', () => {
    expect(activeColumnScript(col({ script: 'return 1;', validateActive: false }))).toBe('return 1;');
  });
});

describe('activeValidateScript', () => {
  it('answers on the same terms for the validation rule', () => {
    expect(activeValidateScript(col({ validate: 'throw 1;' }))).toBe('throw 1;');
    expect(activeValidateScript(col({ validate: 'throw 1;', validateActive: false }))).toBeUndefined();
    expect(activeValidateScript(col({ validate: '  ' }))).toBeUndefined();
    expect(activeValidateScript(col({}))).toBeUndefined();
  });

  it('is not confused by the render script’s switch', () => {
    // The two switches are independent: parking a column's display script must
    // not quietly stop its edits being checked.
    expect(activeValidateScript(col({ validate: 'throw 1;', scriptActive: false }))).toBe('throw 1;');
  });
});

describe('scriptState', () => {
  it('is none for nothing, blank or whitespace — whatever the switch says', () => {
    expect(scriptState(undefined, undefined)).toBe('none');
    expect(scriptState('', true)).toBe('none');
    expect(scriptState('  ', false)).toBe('none');
  });

  it('is on for a script with the switch absent or true', () => {
    expect(scriptState('return 1;', undefined)).toBe('on');
    expect(scriptState('return 1;', true)).toBe('on');
  });

  it('is off only for a script explicitly switched off', () => {
    expect(scriptState('return 1;', false)).toBe('off');
  });
});
