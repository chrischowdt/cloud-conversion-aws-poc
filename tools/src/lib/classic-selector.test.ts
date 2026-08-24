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

  it('translates fromRelationships.runsOn into a smartscapeNodes/traverse subquery (direction:backward)', () => {
    // service-side outer dim, relationship to host, inner has tag
    const ast = parseSelector(
      'type("service"),fromRelationships.runsOn(type("host"),tag("[Azure]dt_owner_email:team-ops@example.com"))'
    );
    const r = translateSelector(ast, 'dt.smartscape.service');
    assert.match(r.filter, /dt\.smartscape\.service in \[/);
    assert.match(r.filter, /smartscapeNodes HOST/);
    assert.match(r.filter, /`tags:azure`\[dt_owner_email\] == "team-ops@example\.com"/);
    assert.match(r.filter, /traverse runs_on, SERVICE, direction:backward/);
    assert.match(r.filter, /\| fields id/);
  });

  it('translates toRelationships.X with direction:forward (when edge wiring matches)', () => {
    // From an EC2 instance: "this EC2 has runs_on coming TO it from HOST"
    // Smartscape edge: HOST → runs_on → AWS_EC2_INSTANCE (forward from HOST POV)
    const ast = parseSelector('toRelationships.runsOn(type("host"))');
    const r = translateSelector(ast, 'dt.smartscape.aws_ec2_instance');
    assert.match(r.filter, /smartscapeNodes HOST/);
    assert.match(r.filter, /traverse runs_on, AWS_EC2_INSTANCE, direction:forward/);
  });

  it('accepts singular fromRelationship (no s) per dt-migration examples.md', () => {
    const ast = parseSelector('fromRelationship.runsOnHost(type("host"))');
    const r = translateSelector(ast, 'dt.smartscape.service');
    assert.match(r.filter, /smartscapeNodes HOST/);
    assert.match(r.filter, /traverse runs_on, SERVICE, direction:backward/);
  });

  it('flags unknown relationship name with reference to skill docs', () => {
    const ast = parseSelector('fromRelationships.totallyMadeUpRel(type("host"))');
    const r = translateSelector(ast, 'dt.smartscape.service');
    assert.equal(r.filter, '');
    assert.ok(r.notes.some((n) => /no documented Smartscape edge mapping/.test(n)));
  });

  it('flags relationship missing inner type()', () => {
    const ast = parseSelector('fromRelationships.runsOn(tag("foo"))');
    const r = translateSelector(ast, 'dt.smartscape.service');
    assert.equal(r.filter, '');
    assert.ok(r.notes.some((n) => /no type\(X\) predicate/.test(n)));
  });

  it('flags nested relationship inside relationship', () => {
    const ast = parseSelector(
      'fromRelationships.runsOn(type("host"),fromRelationships.belongsTo(type("aws_availability_zone")))'
    );
    const r = translateSelector(ast, 'dt.smartscape.service');
    assert.equal(r.filter, '');
    assert.ok(r.notes.some((n) => /[Nn]ested relationship/.test(n)));
  });

  it('combines relationship subquery with sibling tag/attribute predicates', () => {
    const ast = parseSelector(
      'type("ec2_instance"),tag("[AWS]env:prod"),fromRelationships.belongsTo(type("aws_availability_zone"),entityName("us-east-1a"))'
    );
    const r = translateSelector(ast, 'dt.smartscape.aws_ec2_instance');
    // Both clauses present, joined by " and "
    assert.match(
      r.filter,
      /getNodeField\(dt\.smartscape\.aws_ec2_instance, "tags:aws"\)\[env\] == "prod"/
    );
    assert.match(r.filter, /dt\.smartscape\.aws_ec2_instance in \[/);
    assert.match(r.filter, /smartscapeNodes AWS_AVAILABILITY_ZONE/);
    assert.match(r.filter, /name == "us-east-1a"/);
    assert.match(r.filter, / and /);
  });

  it('per-pair validation substitutes the actual Smartscape edge when classic-name mapping is wrong', () => {
    // Classic `belongsTo` would naively map to `belongs_to`, but the actual
    // Smartscape edge between AWS_EC2_INSTANCE and AWS_AVAILABILITY_ZONE is
    // `runs_on`. The validator should detect and substitute.
    const ast = parseSelector(
      'fromRelationships.belongsTo(type("aws_availability_zone"),entityName("us-east-1a"))'
    );
    const r = translateSelector(ast, 'dt.smartscape.aws_ec2_instance');
    assert.match(r.filter, /traverse runs_on, AWS_EC2_INSTANCE/);
    assert.doesNotMatch(r.filter, /belongs_to/);
    assert.ok(r.notes.some((n) => /Substituting/.test(n)));
  });

  it('case-insensitive type lookup (HOST and host both work)', () => {
    const upper = parseSelector('fromRelationships.runsOn(type("HOST"))');
    const lower = parseSelector('fromRelationships.runsOn(type("host"))');
    const a = translateSelector(upper, 'dt.smartscape.service');
    const b = translateSelector(lower, 'dt.smartscape.service');
    assert.match(a.filter, /smartscapeNodes HOST/);
    assert.match(b.filter, /smartscapeNodes HOST/);
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

describe('parseSelector — malformed input must terminate (no hang)', () => {
  it('does not spin forever on a nested paren inside a value list', () => {
    // Regression: parseValueList stopped its bare-token scan on ')' but never
    // consumed it, so the index stalled and the loop appended '' until the array
    // exceeded its max length — surfacing as "RangeError: Invalid array length"
    // after ~8s of spinning. Found while scanning the UA dashboard corpus.
    const started = Date.now();
    const r = parseSelector('entityName.in(type(HOST))');
    assert.ok(Date.now() - started < 1000, 'must terminate promptly');
    assert.ok(r.length >= 1);
  });

  it('terminates on an unbalanced trailing paren mid-list', () => {
    const started = Date.now();
    const r = parseSelector('type(HOST),entityName.in(a(b))');
    assert.ok(Date.now() - started < 1000, 'must terminate promptly');
    assert.equal(r.length, 2);
  });

  it('still parses a normal quoted value list unchanged', () => {
    const r = parseSelector('entityName.in("a","b")');
    const p = r.find((x) => x.kind === 'entityName') as any;
    assert.deepEqual(p.values, ['a', 'b']);
  });
});
