/**
 * rewrite-dql — apply this project's metric mapping + the dt-migration skill's
 * entity rules to a classic DQL query, producing the new equivalent.
 *
 * For things the rewriter can't safely automate (classicEntitySelector,
 * entity-relationship traversal, composite formulas, classic ID literals),
 * it emits warnings pointing at the relevant skill reference instead of
 * generating wrong DQL.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { rewriteDql } from '../lib/dql-rewriter.ts';
import { OUT_DIR, REPO_ROOT } from '../lib/paths.ts';
import { loadRecipeIndex } from '../lib/recipe-lookup.ts';

export interface RewriteDqlArgs {
  query?: string;
  file?: string;
  mappingPath?: string;
  outDir?: string;
  /** Quiet stdout, just write the output file. */
  quiet?: boolean;
}

export async function runRewriteDql(args: RewriteDqlArgs): Promise<void> {
  const outDir = args.outDir ?? OUT_DIR;
  await mkdir(outDir, { recursive: true });
  const mappingPath =
    args.mappingPath ?? join(REPO_ROOT, 'mappings', 'aws_mapping.with_recipes.json');

  let dql = args.query;
  if (!dql && args.file) dql = await readFile(args.file, 'utf8');
  if (!dql) throw new Error('Provide --query or --file.');

  const index = await loadRecipeIndex(mappingPath);
  const result = rewriteDql(dql, index);

  if (!args.quiet) {
    console.log('=== ORIGINAL ===');
    console.log(result.original);
    console.log('');
    console.log('=== REWRITTEN ===');
    console.log(result.rewritten);
    console.log('');
    if (result.transforms.length > 0) {
      console.log(`=== TRANSFORMS (${result.transforms.length}) ===`);
      for (const t of result.transforms) {
        console.log(`  [${t.kind}] ${t.before}  →  ${t.after}`);
        if (t.detail) console.log(`    ${t.detail}`);
      }
      console.log('');
    }
    if (result.warnings.length > 0) {
      console.log(`=== WARNINGS (${result.warnings.length}) ===`);
      for (const w of result.warnings) {
        console.log(`  [${w.kind}] ${w.text}`);
        if (w.match) console.log(`    matched: ${w.match}`);
        if (w.reference) console.log(`    reference: ${w.reference}`);
      }
      console.log('');
    }
  }

  const outPath = join(outDir, 'rewrite_result.json');
  await writeFile(outPath, JSON.stringify(result, null, 2));
  if (!args.quiet) console.log(`Wrote ${outPath}`);
}
