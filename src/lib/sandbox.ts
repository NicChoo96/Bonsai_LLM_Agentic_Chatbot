import path from 'path';
import fs from 'fs/promises';

// Sandbox root – resolved once at module load
const SANDBOX_ROOT = path.resolve(process.cwd(), 'sandbox');

// ─── Path Safety ─────────────────────────────────────────────────
/** Resolve a user-supplied relative path inside the sandbox.
 *  Throws if the resolved path escapes the sandbox boundary. */
export function resolveSandboxPath(relativePath: string): string {
  // Normalise and strip leading slashes / back-slashes
  const cleaned = relativePath.replace(/^[/\\]+/, '');
  const resolved = path.resolve(SANDBOX_ROOT, cleaned);

  if (!resolved.startsWith(SANDBOX_ROOT)) {
    throw new Error('Path escapes the sandbox directory');
  }
  return resolved;
}

// ─── Ensure sandbox exists ───────────────────────────────────────
export async function ensureSandbox(): Promise<void> {
  await fs.mkdir(SANDBOX_ROOT, { recursive: true });
}

// ─── CRUD Operations ─────────────────────────────────────────────

export async function readSandboxFile(relativePath: string): Promise<string> {
  const abs = resolveSandboxPath(relativePath);
  return fs.readFile(abs, 'utf-8');
}

export async function writeSandboxFile(
  relativePath: string,
  content: string,
): Promise<void> {
  const abs = resolveSandboxPath(relativePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}

export async function deleteSandboxFile(relativePath: string): Promise<void> {
  const abs = resolveSandboxPath(relativePath);
  const stat = await fs.stat(abs);
  if (stat.isDirectory()) {
    await fs.rm(abs, { recursive: true });
  } else {
    await fs.unlink(abs);
  }
}

export async function listSandboxFiles(
  relativePath = '',
): Promise<{ name: string; path: string; isDirectory: boolean }[]> {
  const abs = resolveSandboxPath(relativePath || '.');
  await fs.mkdir(abs, { recursive: true });
  const entries = await fs.readdir(abs, { withFileTypes: true });
  return entries.map((e) => ({
    name: e.name,
    path: path.posix.join(relativePath || '', e.name),
    isDirectory: e.isDirectory(),
  }));
}

export async function createSandboxDir(relativePath: string): Promise<void> {
  const abs = resolveSandboxPath(relativePath);
  await fs.mkdir(abs, { recursive: true });
}

/** Recursively list the full file tree under sandbox */
export async function listSandboxTree(
  relativePath = '',
): Promise<{ name: string; path: string; isDirectory: boolean; children?: any[] }[]> {
  const items = await listSandboxFiles(relativePath);
  const result = [];
  for (const item of items) {
    if (item.isDirectory) {
      const children = await listSandboxTree(item.path);
      result.push({ ...item, children });
    } else {
      result.push(item);
    }
  }
  return result;
}

export { SANDBOX_ROOT };
