import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseSelector } from './classic-selector-parser.ts';
import { translateSelector } from './classic-selector-translator.ts';

describe('parseSelector — predicate parsing', () => {
  it('parses simple type predicate', () => {
    const ast = parseSelector('type("HOST")');
    assert.equal(ast.length, 1);
    assert.deepEqual(ast[0], { kind: 'type', value: 'HOST' });
  });

  it('parses entityName with operator', () => {
    const ast = parseSelector('entityName.startsWith("prod")');
    assert.equal(ast.length, 1);
    assert.deepEqual(ast[0], { kind: 'entityName', op: 'startsWith', values: ['prod'] });
  });

  it('parses entityName.in with multiple values', () => {
    const ast = parseSelector('entityName.in("a","b","c")');
    assert.equal(ast.length, 1);
    assert.deepEqual(ast[0], { kind: 'entityName', op: 'in', values: ['a', 'b', 'c'] });
  });

  it('parses tag with [Context]key:value form', () => {
    const ast = parseSelector('tag("[Environment]env:prod")');
    assert.equal(ast.length, 1);
    assert.deepEqual(ast[0], {
      kind: 'tag',
      raw: '[Environment]env:prod',
      context: 'Environment',
      key: 'env',
      value: 'prod',
    });
  });

  it('parses tag with key:value (no context)', () => {
    const ast = parseSelector('tag("env:prod")');
    assert.deepEqual(ast[0], {
      kind: 'tag',
      raw: 'env:prod',
      context: undefined,
      key: 'env',
      value: 'prod',
    });
  });

  it('parses tag with value-only (no key)', () => {
    const ast = parseSelector('tag("BF")');
    assert.deepEqual(ast[0], {
      kind: 'tag',
      raw: 'BF',
      context: undefined,
      value: 'BF',
    });
  });

  it('parses comma-separated predicates', () => {
    const ast = parseSelector('type("HOST"),tag("env:prod"),awsRegion("us-east-1")');
    assert.equal(ast.length, 3);
    assert.equal(ast[0]?.kind, 'type');
    assert.equal(ast[1]?.kind, 'tag');
    assert.equal(ast[2]?.kind, 'attribute');
  });

  it('parses bare-token type argument like type(HOST) without quotes', () => {
    const ast = parseSelector('type(HOST)');
    assert.deepEqual(ast[0], { kind: 'type', value: 'HOST' });
  });

  it('parses relationship with inner selector', () => {
    const ast = parseSelector('fromRelationships.runsOn(type("HOST"),tag("env:prod"))');
    assert.equal(ast.length, 1);
    const p = ast[0]!;
    assert.equal(p.kind, 'relationship');
    if (p.kind === 'relationship') {
      assert.equal(p.direction, 'from');
      assert.equal(p.relationshipName, 'runsOn');
      assert.equal(p.inner.length, 2);
    }
  });

  it('parses not(...) modifier', () => {
    const ast = parseSelector('not(type("HOST"))');
    const p = ast[0]!;
    assert.equal(p.kind, 'modifier');
    if (p.kind === 'modifier') {
      assert.equal(p.modifier, 'not');
      assert.equal(p.inner[0]?.kind, 'type');
    }
  });

  it('parses unknown predicate as attribute', () => {
    const ast = parseSelector('madeUpThing("foo")');
    assert.deepEqual(ast[0], { kind: 'attribute', predicate: 'madeUpThing', op: 'equals', values: ['foo'] });
  });
});

describe('translateSelector — DQL emission', () => {
  const dim = 'dt.smartscape.aws_ec2_instance';

  it('drops type() (implicit when filtering on a typed dim)', () => {
    const ast = parseSelector('type("ec2_instance")');
    const r = translateSelector(ast, dim);
    assert.equal(r.filter, '');
  });

  it('translates entityName equality', () => {
    const ast = parseSelector('entityName("my-instance")');
    const r = translateSelector(ast, dim);
    assert.equal(r.filter, `getNodeField(${dim}, "name") == "my-instance"`);
  });

  it('translates entityName.startsWith', () => {
    const ast = parseSelector('entityName.startsWith("prod-")');
    const r = translateSelector(ast, dim);
    assert.equal(r.filter, `startsWith(getNodeField(${dim}, "name"), "prod-")`);
  });

  it('translates tag with explicit context', () => {
    const ast = parseSelector('tag("[Environment]env:prod")');
    const r = translateSelector(ast, dim);
    assert.equal(r.filter, `getNodeField(${dim}, "tags:environment")[env] == "prod"`);
  });

  it('translates tag without context using AWS default and notes the assumption', () => {
    const ast = parseSelector('tag("env:prod")');
    const r = translateSelector(ast, dim);
    assert.equal(r.filter, `getNodeField(${dim}, "tags:aws")[env] == "prod"`);
    assert.ok(r.notes.some((n) => n.includes('assumed context="aws"')));
  });

  it('translates value-only tag as substring match with note', () => {
    const ast = parseSelector('tag("Production")');
    const r = translateSelector(ast, dim);
    assert.equal(r.filter, `getNodeField(${dim}, "tags") ~ "Production"`);
    assert.ok(r.notes[0]?.includes('substring'));
  });

  it('translates known awsRegion attribute predicate', () => {
    const ast = parseSelector('awsRegion("us-east-1")');
    const r = translateSelector(ast, dim);
    assert.equal(r.filter, `getNodeField(${dim}, "aws.region") == "us-east-1"`);
  });

  it('emits getNodeField with raw predicate name + note for unknown attribute', () => {
    const ast = parseSelector('mysteryAttr("xyz")');
    const r = translateSelector(ast, dim);
    assert.match(r.filter, /getNodeField\(.*, "mysteryAttr"\) == "xyz"/);
    assert.ok(r.notes.some((n) => n.includes('mysteryAttr') && n.includes('fieldsSnapshot')));
  });

  it('joins multiple predicates with " and "', () => {
    const ast = parseSelector('type("ec2_instance"),tag("[AWS]env:prod"),awsRegion("us-east-1")');
    const r = translateSelector(ast, dim);
    assert.equal(
      r.filter,
      `getNodeField(${dim}, "tags:aws")[env] == "prod" and getNodeField(${dim}, "aws.region") == "us-east-1"`
    );
  });

  it('flags entityId as not-migratable', () => {
    const ast = parseSelector('entityId("EC2_INSTANCE-ABC")');
    const r = translateSelector(ast, dim);
    assert.equal(r.filter, '');
    assert.ok(r.notes.some((n) => n.includes('entityId')));
  });

  it('flags management zone as not-migratable', () => {
    const ast = parseSelector('mzName("Production")');
    const r = translateSelector(ast, dim);
    assert.equal(r.filter, '');
    assert.ok(r.notes.some((n) => n.includes('management zone')));
  });

  it('flags relationships for manual translation', () => {
    const ast = parseSelector('fromRelationships.runsOn(type("HOST"))');
    const r = translateSelector(ast, dim);
    assert.equal(r.filter, '');
    assert.ok(r.notes.some((n) => n.includes('relationship')));
  });

  it('translates not() wrapping a translatable predicate', () => {
    const ast = parseSelector('not(awsRegion("us-east-1"))');
    const r = translateSelector(ast, dim);
    assert.equal(r.filter, `not (getNodeField(${dim}, "aws.region") == "us-east-1")`);
  });

  it('translates entityName.in to in() over array', () => {
    const ast = parseSelector('entityName.in("a","b","c")');
    const r = translateSelector(ast, dim);
    assert.equal(
      r.filter,
      `in(getNodeField(${dim}, "name"), array("a", "b", "c"))`
    );
  });
});
