/**
 * Parser for classicEntitySelector(...) contents.
 *
 * Selector grammar (per dt-migration/references/entity-selector-predicates.md):
 *
 *   selector       = predicate ("," predicate)*
 *   predicate      = identifier ("." identifier)? ("(" args ")")?
 *   args           = relationshipArgs | modifierArgs | valueArgs | empty
 *   relationshipArgs = selector              # for fromRelationships.X / toRelationships.X
 *   modifierArgs   = predicate | selector    # for not(...) / caseSensitive(...)
 *   valueArgs      = (string | bareToken) ("," (string | bareToken))*
 *   string         = '"' ... '"'             # supports backslash escapes
 *   bareToken      = unquoted run of [^,)]
 *
 * Output: a typed AST so the translator can decide per-predicate how to
 * emit a DQL filter expression.
 */

export type Predicate =
  | { kind: 'type'; value: string }
  | { kind: 'entityName'; op: StringOp; values: string[] }
  | { kind: 'entityId'; op: StringOp; values: string[] }
  | { kind: 'tag'; raw: string; context?: string; key?: string; value?: string }
  | { kind: 'mz'; field: 'mzId' | 'mzName' | 'managementZoneId' | 'managementZoneName' | 'mz'; op: StringOp; values: string[] }
  | { kind: 'attribute'; predicate: string; op: StringOp; values: string[] }
  | { kind: 'relationship'; direction: 'from' | 'to'; relationshipName: string; inner: Predicate[] }
  | { kind: 'modifier'; modifier: 'not' | 'caseSensitive'; inner: Predicate[] }
  | { kind: 'healthState'; values: string[] }
  | { kind: 'unknown'; raw: string };

export type StringOp = 'equals' | 'contains' | 'startsWith' | 'in' | 'exists' | 'gte' | 'gt' | 'lte' | 'lt';

// Both plural and singular forms are accepted in classic selectors. The
// official docs document the plural; multiple in-the-wild examples (and
// dt-migration/references/examples.md Example 003) use the singular.
const RELATIONSHIP_PREFIXES = [
  'fromRelationships',
  'toRelationships',
  'fromRelationship',
  'toRelationship',
];
const MODIFIERS = new Set(['not', 'caseSensitive']);
const TAG_NAMES = new Set(['tag']);
const TYPE_NAMES = new Set(['type']);
const ENTITY_NAME_NAMES = new Set(['entityName']);
const ENTITY_ID_NAMES = new Set(['entityId']);
const MZ_NAMES = new Set(['mzId', 'mzName', 'managementZoneId', 'managementZoneName', 'mz']);
const HEALTH_STATE_NAMES = new Set(['healthState']);

/**
 * Classic selector predicate names are matched case-INSENSITIVELY by the
 * platform, and real dashboards exploit that freely — `entityname.contains(…)`
 * and `servicetype(…)` are both common. Comparing them case-sensitively made
 * them fall through to the generic `attribute` branch, which is why 383
 * entityName predicates were being treated as unknown attributes and kept their
 * classicEntitySelector. Canonicalise before dispatch.
 */
const CANONICAL_PREDICATES = new Map<string, string>(
  [
    ...MODIFIERS, ...TAG_NAMES, ...TYPE_NAMES, ...ENTITY_NAME_NAMES,
    ...ENTITY_ID_NAMES, ...MZ_NAMES, ...HEALTH_STATE_NAMES,
  ].map((n) => [n.toLowerCase(), n])
);

function canonicalPredicate(name: string): string {
  return CANONICAL_PREDICATES.get(name.toLowerCase()) ?? name;
}

class Parser {
  pos = 0;
  private readonly input: string;
  constructor(input: string) {
    this.input = input;
  }

  parse(): Predicate[] {
    const out: Predicate[] = [];
    this.skipWs();
    while (this.pos < this.input.length && this.peek() !== ')') {
      out.push(this.parsePredicate());
      this.skipWs();
      if (this.peek() === ',') {
        this.pos++;
        this.skipWs();
      }
    }
    return out;
  }

  private parsePredicate(): Predicate {
    const start = this.pos;
    const name = canonicalPredicate(this.readIdent());
    if (!name) {
      const raw = this.consumeBalanced();
      return { kind: 'unknown', raw };
    }
    // The optional `.X` segment may be an operator (.startsWith, .equals)
    // or a relationship name (fromRelationships.runsOn). Capture as-is and
    // resolve based on the predicate name below.
    let dottedSuffix = '';
    if (this.peek() === '.') {
      this.pos++;
      dottedSuffix = this.readIdent();
    }
    // The bare legacy `entityName("x")` (no `.equals`/`.contains` suffix) is a
    // case-insensitive CONTAINS in classic, not an equality — tenant-measured,
    // see entityNameClause in classic-selector-translator.ts.
    const op: StringOp = isStringOp(dottedSuffix)
      ? dottedSuffix
      : !dottedSuffix && ENTITY_NAME_NAMES.has(canonicalPredicate(name))
        ? 'contains'
        : 'equals';

    if (this.peek() !== '(') {
      return this.buildPredicate(name, op, []);
    }

    this.pos++; // consume '('
    const argsRaw = this.captureUntilMatchingParen();

    if (RELATIONSHIP_PREFIXES.includes(name)) {
      const inner = parseSelector(argsRaw);
      return {
        kind: 'relationship',
        direction: name.startsWith('from') ? 'from' : 'to',
        relationshipName: dottedSuffix,
        inner,
      };
    }

    if (MODIFIERS.has(name)) {
      const inner = parseSelector(argsRaw);
      return { kind: 'modifier', modifier: name as 'not' | 'caseSensitive', inner };
    }

    // Predicate with value-list args
    const values = parseValueList(argsRaw);

    if (TYPE_NAMES.has(name)) {
      return { kind: 'type', value: values[0] ?? '' };
    }
    if (ENTITY_NAME_NAMES.has(name)) {
      return { kind: 'entityName', op, values };
    }
    if (ENTITY_ID_NAMES.has(name)) {
      return { kind: 'entityId', op, values };
    }
    if (TAG_NAMES.has(name)) {
      return parseTagPredicate(values[0] ?? '');
    }
    if (MZ_NAMES.has(name)) {
      return { kind: 'mz', field: name as 'mzId' | 'mzName' | 'managementZoneId' | 'managementZoneName' | 'mz', op, values };
    }
    if (HEALTH_STATE_NAMES.has(name)) {
      return { kind: 'healthState', values };
    }

    void start;
    return { kind: 'attribute', predicate: name, op, values };
  }

  private buildPredicate(rawName: string, op: StringOp, values: string[]): Predicate {
    const name = canonicalPredicate(rawName);
    if (TYPE_NAMES.has(name)) return { kind: 'type', value: values[0] ?? '' };
    if (ENTITY_NAME_NAMES.has(name)) return { kind: 'entityName', op, values };
    if (ENTITY_ID_NAMES.has(name)) return { kind: 'entityId', op, values };
    if (MZ_NAMES.has(name)) return { kind: 'mz', field: name as 'mzId' | 'mzName' | 'managementZoneId' | 'managementZoneName' | 'mz', op, values };
    if (HEALTH_STATE_NAMES.has(name)) return { kind: 'healthState', values };
    return { kind: 'attribute', predicate: name, op, values };
  }

  private peek(): string {
    return this.pos < this.input.length ? this.input[this.pos]! : '';
  }
  private skipWs() {
    while (/\s/.test(this.peek())) this.pos++;
  }
  private readIdent(): string {
    const start = this.pos;
    while (/[A-Za-z0-9_]/.test(this.peek())) this.pos++;
    return this.input.slice(start, this.pos);
  }
  private captureUntilMatchingParen(): string {
    // Capture from current position, balancing parens, stopping at the
    // matching ')'. Returns the captured content (excluding the closing
    // paren), and advances pos past it.
    let depth = 1;
    const start = this.pos;
    while (this.pos < this.input.length && depth > 0) {
      const c = this.peek();
      if (c === '"') {
        this.pos++;
        while (this.pos < this.input.length && this.peek() !== '"') {
          if (this.peek() === '\\') this.pos++; // skip escape
          this.pos++;
        }
        if (this.peek() === '"') this.pos++;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          const end = this.pos;
          this.pos++; // consume ')'
          return this.input.slice(start, end);
        }
      }
      this.pos++;
    }
    return this.input.slice(start, this.pos);
  }
  private consumeBalanced(): string {
    const start = this.pos;
    let depth = 0;
    while (this.pos < this.input.length) {
      const c = this.peek();
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
      this.pos++;
    }
    return this.input.slice(start, this.pos);
  }
}

function isStringOp(s: string): s is StringOp {
  return ['equals', 'contains', 'startsWith', 'in', 'exists', 'gte', 'gt', 'lte', 'lt'].includes(s);
}

/** Parse a selector string. Public entry. */
export function parseSelector(input: string): Predicate[] {
  return new Parser(input).parse();
}

/** Parse the comma-separated value list inside a predicate's parens. */
function parseValueList(args: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < args.length) {
    // Every branch below must consume at least one character. If one ever
    // doesn't, the index stalls and this loop appends forever until the array
    // blows past its max length ("RangeError: Invalid array length") — a hang,
    // not a parse error. The `)` case below was exactly that; this guard makes
    // any future non-advancing branch degrade to a truncated parse instead.
    const loopStart = i;
    while (i < args.length && /\s/.test(args[i]!)) i++;
    if (i >= args.length) break;
    if (args[i] === '"') {
      // Quoted string with backslash escapes
      i++;
      let s = '';
      while (i < args.length && args[i] !== '"') {
        if (args[i] === '\\' && i + 1 < args.length) {
          i++;
          s += args[i];
          i++;
        } else {
          s += args[i];
          i++;
        }
      }
      if (i < args.length) i++; // consume closing quote
      out.push(s);
    } else {
      // Bare token (e.g. type(HOST))
      const start = i;
      while (i < args.length && args[i] !== ',' && args[i] !== ')') i++;
      const token = args.slice(start, i).trim();
      if (token.length > 0) out.push(token);
      // A ')' sitting inside the value list is an unbalanced or nested paren
      // (e.g. `entityName.in(type(HOST))`). The scan above stops on it but
      // never consumes it, and the comma check below won't either — so treat it
      // as the end of the list rather than stalling.
      if (i < args.length && args[i] === ')') break;
    }
    while (i < args.length && /\s/.test(args[i]!)) i++;
    if (args[i] === ',') i++;
    if (i === loopStart) break; // defensive: no branch consumed anything
  }
  return out;
}

/** Parse a tag predicate's single argument. Forms: "[Context]key:value", "key:value", "value". */
function parseTagPredicate(raw: string): Predicate {
  const m = /^\[([^\]]+)\](.*)$/.exec(raw);
  let context: string | undefined;
  let body: string;
  if (m) {
    context = m[1]!;
    body = m[2]!;
  } else {
    body = raw;
  }
  const colonIdx = body.indexOf(':');
  if (colonIdx >= 0) {
    return {
      kind: 'tag',
      raw,
      context,
      key: body.slice(0, colonIdx),
      value: body.slice(colonIdx + 1),
    };
  }
  // No colon — value-only tag like tag("BF")
  return { kind: 'tag', raw, context, value: body };
}
