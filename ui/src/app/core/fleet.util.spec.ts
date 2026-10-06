import { SCENARIOS } from '../../mock/scenarios';
import { Fleet } from './models';
import { buildTree, findNode, levelOf, matches, needsAttention, sev, storeOf, walk } from './fleet.util';

const opts = { sort: 'az' as const, lang: 'en', centralName: 'Central server', thisStoreName: 'This store server' };
const names = (f: Fleet, sort: 'az' | 'store' = 'az') =>
  buildTree(f, { ...opts, sort }).children.map((s) => [s.name, s.children.map((p) => p.name)]);

describe('fleet tree', () => {
  it('puts POS under their store, stores sorted A–Z', () => {
    const t = buildTree(SCENARIOS['fleet'](), opts);
    expect(t.kind).toBe('central');
    expect(t.children.map((s) => s.name)).toEqual([
      '001707 AMACO Fiume Veneto',
      '001712 AMACO Pordenone Centro',
      '001730 AMACO Udine Via Roma',
      '001745 AMACO Treviso Outlet',
    ]);
    expect(t.children[0].children.map((p) => p.name)).toEqual(['#1 CASSA 1', '#2 CASSA 2', '#3 4POS VM', '#3 CASSA 3 SELF', '#4 CASSA 4']);
    walk(t, (n) => n.children.forEach((c) => expect(c.parent).toBe(n)));
  });

  it('sorts by store id and device id, POS without one last', () => {
    const [first] = names(SCENARIOS['fleet'](), 'store');
    expect(first[0]).toBe('001707 AMACO Fiume Veneto');
    const pordenone = names(SCENARIOS['fleet'](), 'store')[1][1] as string[];
    expect(pordenone.at(-1)).toBe('memphis-pos-lab');
  });

  it('central-only: POS hang directly off central', () => {
    const t = buildTree(SCENARIOS['central-only'](), opts);
    expect(t.children.every((c) => c.kind === 'pos' && c.parent === t)).toBe(true);
    expect(t.children.map((p) => p.key)).toEqual(['cassa-1', 'cassa-2', 'cassa-3']);
  });

  it('store server: the root is the store itself', () => {
    const t = buildTree(SCENARIOS['store'](), { ...opts, upstream: 'ws://7.7.7.179:7681' });
    expect(t.kind).toBe('store');
    expect(t.upstream).toBe('ws://7.7.7.179:7681');
    expect(t.children.every((c) => c.kind === 'pos')).toBe(true);
  });

  it('finds nodes by id and splits agent keys', () => {
    const t = buildTree(SCENARIOS['fleet'](), opts);
    expect(findNode(t, 'p:21/memphis-pos-302')?.name).toBe('#2 CASSA 2');
    expect(findNode(t, 'nope')).toBeNull();
    expect(storeOf('21/memphis-pos-302')).toBe('21');
    expect(storeOf('cassa-1')).toBe('');
  });
});

describe('health', () => {
  it('levels at 80 and 90%', () => {
    expect([79.9, 80, 89.9, 90].map(levelOf)).toEqual(['', 'warn', 'warn', 'crit']);
  });

  it('a full disk is critical and needs attention', () => {
    const t = buildTree(SCENARIOS['fleet'](), opts);
    const cassa1 = findNode(t, 'p:12/memphis-pos-101')!;
    expect(sev(cassa1)).toBe(2);
    expect(needsAttention(cassa1)).toBe(true);
  });
});

describe('search and filters', () => {
  const t = buildTree(SCENARIOS['fleet'](), opts);
  const pos = findNode(t, 'p:14/memphis-pos-202')!;

  it('matches name, host, IP and device id, ignoring case', () => {
    for (const q of ['GASTRONOMIA', 'memphis-pos-202', '10.14.0.12', '202']) expect(matches(pos, q, 'all')).toBe(true);
    expect(matches(pos, 'udine', 'all')).toBe(false);
  });

  it('filters online, offline and needs attention', () => {
    const off = findNode(t, 'p:12/memphis-pos-104')!;
    expect(matches(off, '', 'online')).toBe(false);
    expect(matches(off, '', 'offline')).toBe(true);
    expect(matches(off, '', 'warn')).toBe(true);
    expect(matches(pos, '', 'warn')).toBe(true); // memory 91%
  });
});
