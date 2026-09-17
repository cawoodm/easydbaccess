import { describe, expect, it } from 'vitest';
import type { ColumnSpec } from '@easydb/shared';
import { planEditKey } from '../../../packages/renderer/src/plugins/commandlet-edit.js';

/**
 * `edit/<table>`, `edit/<table>/<key>` and `edit/<table>/<field>/<value>` — the
 * rule that turns the targets after the table name into one filter.
 *
 * Unlike `preview`, nothing here is ambiguous: a second target is always a key,
 * because a form showing the whole record has no use for a lone field name.
 */

const col = (field: string, over: Partial<ColumnSpec> = {}): ColumnSpec => ({ field, label: field, type: 'string', ...over });

const table = (...columns: ColumnSpec[]) => ({ columns });

describe('planEditKey', () => {
  const t = table(col('id'), col('author', { label: 'Author' }), col('body'));

  it('adds nothing when only the table was named', () => {
    expect(planEditKey(t, [])).toEqual({ keyFilter: {} });
  });

  it('matches one target against the first column, exactly', () => {
    // `=` because a bare value means "contains" to the filter language, and a key
    // that is a prefix of another key would then open the wrong record.
    expect(planEditKey(t, ['n-17'])).toEqual({ keyFilter: { id: '=n-17' } });
  });

  it('reads a second target as a key even when it names a column', () => {
    expect(planEditKey(t, ['author'])).toEqual({ keyFilter: { id: '=author' } });
  });

  it('takes field and value from the three-target form', () => {
    expect(planEditKey(t, ['author', 'Smith'])).toEqual({ keyFilter: { author: '=Smith' } });
  });

  it('resolves that field by label too, case-insensitively', () => {
    expect(planEditKey(t, ['AUTHOR', 'Smith'])).toEqual({ keyFilter: { author: '=Smith' } });
  });

  it('refuses a field no column has, and names the ones that exist', () => {
    const plan = planEditKey(t, ['nonesuch', 'Smith']);
    expect(plan).toHaveProperty('error');
    expect((plan as { error: string }).error).toContain('id, author, body');
  });

  it('refuses a key when the table has no columns at all', () => {
    expect(planEditKey(table(), ['n-17'])).toHaveProperty('error');
  });

  it('treats an empty first target as no target', () => {
    expect(planEditKey(t, [''])).toEqual({ keyFilter: {} });
  });
});
