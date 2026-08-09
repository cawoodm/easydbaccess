import { describe, expect, it } from 'vitest';
import { CommandletError, formatCommandlet, looksLikeCommandlet, parseCommandlets, substituteCommandlet } from '../../../packages/renderer/src/plugins/commandlet-lang.js';

const one = (s: string) => {
  const [first] = parseCommandlets(s);
  if (!first) throw new Error('no commandlet parsed');
  return first;
};

describe('parseCommandlets', () => {
  it('splits the path into a verb and targets', () => {
    expect(one('goto/bible')).toMatchObject({ verb: 'goto', targets: ['bible'] });
    expect(one('preview/bible/Text')).toMatchObject({ verb: 'preview', targets: ['bible', 'Text'] });
  });

  it('treats an unknown first segment as a table name', () => {
    expect(one('bible?Book=Matthew')).toMatchObject({ verb: 'goto', targets: ['bible'], filters: { Book: 'Matthew' } });
  });

  it('accepts table/ as an alias of goto/', () => {
    expect(one('table/bible').verb).toBe('goto');
  });

  it('reads bare query keys as column filters and @keys as options', () => {
    const cmd = one('goto/bible?Book=^M&Chapter==5&@sort=-Chapter&@clear=1');
    expect(cmd.filters).toEqual({ Book: '^M', Chapter: '=5' });
    expect(cmd.options).toEqual({ sort: '-Chapter', clear: '1' });
  });

  it('keeps a leading-underscore column filterable', () => {
    // The reason `@` marks options instead of Datasette's `_`: this app meets
    // `_id` columns routinely and they must not become unreachable.
    expect(one('goto/imported?_id=42').filters).toEqual({ _id: '42' });
  });

  it('leaves the filter grammar untouched', () => {
    const cmd = one('goto/people?City=%22Berlin%2C+DE%22%2CZurich&Status=!NULL+AND+Open');
    expect(cmd.filters.City).toBe('"Berlin, DE",Zurich');
    expect(cmd.filters.Status).toBe('!NULL AND Open');
  });

  it('gives a greedy verb the rest of the path, so a command id keeps its colons', () => {
    expect(one('cmd/windows:close-all').targets).toEqual(['windows:close-all']);
    expect(one('search/berlin AND active').targets).toEqual(['berlin AND active']);
    expect(one('view/Reading plan/2026').targets).toEqual(['Reading plan/2026']);
  });

  it('decodes each path segment on its own, so %2F is not a separator', () => {
    expect(one('goto/a%2Fb').targets).toEqual(['a/b']);
  });

  it('splits a chain on ; and runs left to right', () => {
    const chain = parseCommandlets('goto/bible?Book=Matthew;preview/bible/Text?Chapter==5');
    expect(chain.map((c) => c.verb)).toEqual(['goto', 'preview']);
  });

  it('rejects a verb without its targets', () => {
    expect(() => parseCommandlets('preview/bible')).toThrow(CommandletError);
    expect(() => parseCommandlets('  ')).toThrow(CommandletError);
  });

  it('rejects broken percent-encoding instead of throwing a URIError', () => {
    expect(() => parseCommandlets('goto/%zz')).toThrow(CommandletError);
  });

  // `view` is the one verb whose target is optional: with none it means the view
  // the click came from, so a template can narrow the view it is already in.
  it('accepts view with no target at all', () => {
    const [cmd] = parseCommandlets('view?Title==Psalms 139');
    expect(cmd?.verb).toBe('view');
    expect(cmd?.targets).toEqual([]);
    expect(cmd?.filters).toEqual({ Title: '=Psalms 139' });
  });

  it('accepts a leading slash, which is how a link spells a path', () => {
    const [cmd] = parseCommandlets('/view?@search=foo');
    expect(cmd?.verb).toBe('view');
    expect(cmd?.targets).toEqual([]);
    expect(cmd?.options).toEqual({ search: 'foo' });
  });

  it('keeps a named view in one target, trailing slash and all', () => {
    expect(parseCommandlets('view/AnotherView/?@search=foo')[0]?.targets).toEqual(['AnotherView']);
    // A `/` inside the name is part of it — `view` owns the rest of the path.
    expect(parseCommandlets('view/Reading plan/2026')[0]?.targets).toEqual(['Reading plan/2026']);
  });
});

describe('looksLikeCommandlet', () => {
  it('is true only for a known verb, so a plain anchor stays an anchor', () => {
    expect(looksLikeCommandlet('goto/bible?Book=Matthew')).toBe(true);
    expect(looksLikeCommandlet('cmd/windows:close-all')).toBe(true);
    expect(looksLikeCommandlet('/view?Title==Psalms 139')).toBe(true);
    expect(looksLikeCommandlet('Matthew')).toBe(false);
    expect(looksLikeCommandlet('/Matthew')).toBe(false);
    expect(looksLikeCommandlet('section-2')).toBe(false);
  });
});

describe('substituteCommandlet', () => {
  it('substitutes after parsing, so a value cannot split a parameter', () => {
    const cmd = substituteCommandlet(one('goto/$TABLE?Owner=$VALUE'), { TABLE: 'notes', VALUE: 'a&b=c;d' });
    expect(cmd.targets).toEqual(['notes']);
    expect(cmd.filters).toEqual({ Owner: 'a&b=c;d' });
  });

  it('substitutes the numbered captures an anchor is split into', () => {
    const cmd = substituteCommandlet(one('goto/bible?Book=$1&Chapter==$2'), { '1': 'Matthew', '2': '5' });
    expect(cmd.filters).toEqual({ Book: 'Matthew', Chapter: '=5' });
  });

  it('leaves an unknown placeholder visible rather than blanking it', () => {
    expect(one('goto/x?A=$NOPE').filters.A).toBe('$NOPE');
    expect(substituteCommandlet(one('goto/x?A=$NOPE'), {}).filters.A).toBe('$NOPE');
  });
});

describe('formatCommandlet', () => {
  it('encodes values that would otherwise break the query', () => {
    expect(formatCommandlet('goto/orders', { Customer: '=Smith & Co' })).toBe('#goto/orders?Customer=%3DSmith+%26+Co');
  });

  it('round-trips through the parser', () => {
    const href = formatCommandlet(['goto', 'my orders'], { Customer: '=Smith & Co', '@sort': '-Date' });
    const cmd = one(href.slice(1));
    expect(cmd.targets).toEqual(['my orders']);
    expect(cmd.filters).toEqual({ Customer: '=Smith & Co' });
    expect(cmd.options).toEqual({ sort: '-Date' });
  });
});
