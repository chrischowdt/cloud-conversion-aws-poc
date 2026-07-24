/**
 * dtctl — thin wrapper around the kubectl-style Dynatrace CLI. This is the ONLY
 * component in the tool that writes to a tenant; every create/update/rollback
 * routes through here so the mutating surface is small and auditable.
 *
 * Verbs used (see reference/.github/skills/dtctl/): `auth whoami`, `auth can-i`,
 * `apply -f <file> [--dry-run]` (no id in file = create, id = update-in-place),
 * `get <resource> <id>`, `diff -f <file>`, `history <resource> <id>`,
 * `restore <resource> <id> --version N`, `delete <resource> <id>`.
 *
 * Runs with `--agent` so stdout is the structured `{ok,result,error,context}`
 * envelope. Requires dtctl installed + a readwrite context + write scopes —
 * `available()` / `canI()` are the preflights. NOTE: written to dtctl's
 * documented interface; live behavior must be validated in an environment where
 * dtctl is installed.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export interface DtctlEnvelope {
  ok: boolean;
  result?: unknown;
  error?: { message?: string; code?: string } | string;
  context?: Record<string, unknown>;
}

export class DtctlError extends Error {
  readonly args: string[];
  readonly stderr?: string;
  constructor(message: string, args: string[], stderr?: string) {
    super(`dtctl ${args.join(' ')}: ${message}`);
    this.name = 'DtctlError';
    this.args = args;
    this.stderr = stderr;
  }
}

function tryParse(s: string): DtctlEnvelope | null {
  try {
    const j = JSON.parse(s.trim());
    return j && typeof j === 'object' ? (j as DtctlEnvelope) : null;
  } catch {
    return null;
  }
}

export interface DtctlOptions {
  /** Binary name/path. Default `dtctl` (or $DTCTL_BIN). */
  bin?: string;
  /** dtctl context (tenant). Default: the CLI's current-context. */
  context?: string;
}

export class Dtctl {
  private readonly bin: string;
  private readonly context?: string;

  constructor(opts: DtctlOptions = {}) {
    this.bin = opts.bin ?? process.env.DTCTL_BIN ?? 'dtctl';
    this.context = opts.context;
  }

  /** True if the dtctl binary is on PATH and runnable. */
  async available(): Promise<boolean> {
    try {
      await pexec(this.bin, ['version']);
      return true;
    } catch {
      return false;
    }
  }

  private async run(args: string[]): Promise<DtctlEnvelope> {
    const full = [...args, '--agent'];
    if (this.context) full.push('--context', this.context);
    try {
      const { stdout } = await pexec(this.bin, full, { maxBuffer: 64 * 1024 * 1024 });
      const env = tryParse(stdout);
      // Non-envelope JSON (some verbs) → treat as a successful result.
      if (env && typeof env.ok === 'boolean') return env;
      return { ok: true, result: env ?? stdout };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const env = err.stdout ? tryParse(err.stdout) : null;
      const msg =
        (env && (typeof env.error === 'string' ? env.error : env.error?.message)) ||
        err.stderr?.trim() ||
        err.message ||
        'unknown error';
      throw new DtctlError(msg, args, err.stderr);
    }
  }

  async whoami(): Promise<DtctlEnvelope> {
    return this.run(['auth', 'whoami']);
  }

  /** `dtctl auth can-i <verb> <resource>` → true when permitted. */
  async canI(verb: string, resource: string): Promise<boolean> {
    try {
      const env = await this.run(['auth', 'can-i', verb, resource]);
      const r = env.result;
      if (typeof r === 'boolean') return r;
      if (r && typeof r === 'object' && 'allowed' in r) return Boolean((r as { allowed: unknown }).allowed);
      return env.ok;
    } catch {
      return false;
    }
  }

  /** Apply a resource file (create when it has no id, update when it does). */
  async applyFile(file: string, opts: { dryRun?: boolean } = {}): Promise<DtctlEnvelope> {
    const args = ['apply', '-f', file];
    if (opts.dryRun) args.push('--dry-run');
    return this.run(args);
  }

  /** `dtctl diff -f <file>` — preview a create/update against the live resource. */
  async diffFile(file: string): Promise<DtctlEnvelope> {
    return this.run(['diff', '-f', file]);
  }

  async get(resource: string, id: string): Promise<DtctlEnvelope> {
    return this.run(['get', resource, id]);
  }

  async history(resource: string, id: string): Promise<DtctlEnvelope> {
    return this.run(['history', resource, id]);
  }

  async restore(resource: string, id: string, version: number): Promise<DtctlEnvelope> {
    return this.run(['restore', resource, id, '--version', String(version)]);
  }

  async delete(resource: string, id: string): Promise<DtctlEnvelope> {
    return this.run(['delete', resource, id]);
  }
}

/** Pull a created/updated document id out of an apply envelope (best-effort). */
export function idFromApplyResult(env: DtctlEnvelope): string | undefined {
  const r = env.result as unknown;
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    if (typeof o['id'] === 'string') return o['id'];
    if (Array.isArray(r) && r[0] && typeof (r[0] as Record<string, unknown>)['id'] === 'string') {
      return (r[0] as Record<string, unknown>)['id'] as string;
    }
  }
  return undefined;
}
