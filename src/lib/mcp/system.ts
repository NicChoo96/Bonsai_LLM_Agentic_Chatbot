import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import type { McpProvider, McpToolDefinition, McpToolResult } from './types';

const execAsync = promisify(exec);

// ─── Default working directory: user's home (NOT sandbox) ────────
const DEFAULT_CWD = os.homedir();

// ─── Safety: allow-list of executables the agent may invoke ──────
const ALLOWED_COMMANDS = new Set([
  // File & directory
  'dir', 'type', 'copy', 'move', 'rename', 'del', 'mkdir', 'rmdir', 'tree',
  'xcopy', 'robocopy', 'attrib', 'where', 'findstr', 'fc', 'comp',
  // Text & data
  'echo', 'sort', 'more', 'find',
  // System info
  'hostname', 'whoami', 'systeminfo', 'ver', 'date', 'time',
  'wmic', 'tasklist', 'taskkill', 'sc', 'net',
  // Networking
  'ping', 'ipconfig', 'nslookup', 'tracert', 'netstat', 'curl',
  'arp', 'pathping', 'route',
  // Disk & storage
  'diskpart', 'chkdsk', 'vol', 'label', 'fsutil',
  // Power & session
  'shutdown', 'logoff', 'gpresult',
  // Dev & scripting
  'node', 'npm', 'npx', 'python', 'python3', 'pip', 'pip3',
  'git', 'code', 'dotnet',
  'powershell', 'pwsh', 'cmd',
  // Package managers
  'winget', 'choco', 'scoop',
  // Archives & misc
  'tar', 'clip', 'start', 'explorer', 'notepad', 'calc',
  'certutil', 'sfc', 'setx', 'reg',
]);

// Commands that are blocked even if in the allow list when combined with
// destructive flags.  Prevents accidental catastrophic operations.
const DESTRUCTIVE_PATTERNS = [
  /\bformat\b/i,
  /\brmdir\s+.*\/s\b/i,
  /\bdel\s+.*\/s\b/i,
  /\brd\s+.*\/s\b/i,
  /\brm\s+-rf?\b/i,
  /\b(shutdown|logoff)\b/i,
  /\bdiskpart\b/i,
  /\breg\s+delete\b/i,
  /\bsfc\b/i,
  /\btaskkill\b/i,
];

/** Maximum output length returned to the model (characters). */
const MAX_OUTPUT = 16_000;
/** Command timeout in milliseconds. */
const CMD_TIMEOUT = 30_000;

// ─── Tool Definitions ────────────────────────────────────────────
const tools: McpToolDefinition[] = [
  // ── Shell execution ────────────────────────────────────────────
  {
    name: 'run_command',
    description:
      'Run a shell command anywhere on the Windows system via cmd.exe. ' +
      'Use the cwd parameter to target any drive or folder (e.g. "D:\\Projects", "C:\\Users"). ' +
      'Defaults to the user home directory. Dangerous operations require confirmation.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
        cwd: {
          type: 'string',
          description: 'Working directory (absolute path on any drive, e.g. "D:\\Data", "C:\\"). Defaults to user home.',
        },
        confirm_destructive: {
          type: 'string',
          description: 'Set to "yes" to allow a destructive command (shutdown, del /s, etc.).',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'run_powershell',
    description:
      'Run a PowerShell snippet anywhere on the Windows system. ' +
      'Use cwd to target any drive or directory. Defaults to user home.',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'PowerShell script or one-liner to execute.' },
        cwd: { type: 'string', description: 'Working directory (absolute path on any drive). Defaults to user home.' },
      },
      required: ['script'],
    },
  },

  // ── Drive & volume discovery ───────────────────────────────────
  {
    name: 'list_drives',
    description: 'List all available drives/volumes on the system with their type, label, total size, and free space.',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  // ── File & directory helpers (full system, any drive) ──────────
  {
    name: 'host_list_dir',
    description:
      'List files and directories at any absolute path on any drive of the system ' +
      '(e.g. "C:\\Users", "D:\\Projects", "E:\\"). Returns names, sizes, types, and modification dates. ' +
      'SMART: If the directory is not found, automatically searches for similar directory names using multi-pass matching ' +
      '(exact → per-word → regex) and suggests candidates.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path on any drive (e.g. "D:\\Documents", "C:\\").' },
        recursive: { type: 'string', description: '"true" to list recursively (max 500 entries). Default is flat listing.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'host_read_file',
    description:
      'Read the text contents of a file anywhere on the system (any drive). ' +
      'Supports absolute paths like "D:\\data\\config.json" or "C:\\Windows\\System32\\drivers\\etc\\hosts". ' +
      'Returns up to 64 KB of text. ' +
      'SMART: If the file is not found at the exact path, automatically searches nearby directories using multi-pass ' +
      'matching (exact glob → per-word → regex). Auto-resolves if exactly one candidate is found.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path on any drive.' },
        encoding: { type: 'string', description: 'Text encoding (default: "utf-8"). Use "latin1" for binary-ish files.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'host_write_file',
    description:
      'Write text content to a file anywhere on the system (any drive). Creates parent directories if needed. ' +
      'SMART: If the parent directory does not exist, attempts to auto-resolve a similar directory name.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path on any drive.' },
        content: { type: 'string', description: 'Content to write to the file.' },
        append: { type: 'string', description: '"true" to append instead of overwrite.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'host_copy',
    description:
      'Copy a file or directory to another location. Works across drives (e.g. C:\\ to D:\\).',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute path of the source file or directory.' },
        destination: { type: 'string', description: 'Absolute path of the destination.' },
        recursive: { type: 'string', description: '"true" to copy directories recursively.' },
      },
      required: ['source', 'destination'],
    },
  },
  {
    name: 'host_move',
    description:
      'Move or rename a file or directory. Works across drives.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute path of the source.' },
        destination: { type: 'string', description: 'Absolute path of the destination.' },
      },
      required: ['source', 'destination'],
    },
  },
  {
    name: 'host_delete',
    description:
      'Delete a file or directory anywhere on the system. Directories are deleted recursively.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file or directory to delete.' },
        confirm: { type: 'string', description: 'Must be "yes" to confirm deletion.' },
      },
      required: ['path', 'confirm'],
    },
  },
  {
    name: 'host_create_dir',
    description: 'Create a directory (and parent directories) at any absolute path on any drive.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path to create.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'host_file_info',
    description:
      'Get detailed information about a file or directory (size, dates, permissions, type). Works on any drive. ' +
      'SMART: If path not found, auto-searches for similar files/directories and returns candidates.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file or directory.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'host_file_exists',
    description: 'Check whether a file or directory exists at the given absolute path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to check.' },
      },
      required: ['path'],
    },
  },

  // ── System information ─────────────────────────────────────────
  {
    name: 'system_info',
    description: 'Return key system information (hostname, OS, CPU, RAM, uptime, username, home directory).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_processes',
    description: 'List running processes on the system, optionally filtered by name.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional process name substring to filter by.' },
      },
      required: [],
    },
  },
  {
    name: 'kill_process',
    description: 'Terminate a running process by name or PID.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Process name (e.g. "notepad.exe") or PID number.' },
      },
      required: ['target'],
    },
  },

  // ── Networking ─────────────────────────────────────────────────
  {
    name: 'ping_host',
    description: 'Ping a hostname or IP address.',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Hostname or IP to ping.' },
        count: { type: 'string', description: 'Number of pings (default 4).' },
      },
      required: ['host'],
    },
  },
  {
    name: 'network_info',
    description: 'Return current network adapter configuration (all adapters, IPs, DNS, etc.).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'dns_lookup',
    description: 'Perform a DNS lookup for a hostname.',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Hostname to look up.' },
      },
      required: ['host'],
    },
  },
  {
    name: 'check_ports',
    description: 'Show active TCP connections and listening ports.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional port number or address to filter.' },
      },
      required: [],
    },
  },

  // ── Disk & storage ─────────────────────────────────────────────
  {
    name: 'disk_usage',
    description: 'Show disk usage / free space for all drives.',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  // ── Installed software & packages ──────────────────────────────
  {
    name: 'installed_apps',
    description: 'List installed applications via winget or registry.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional app name filter.' },
      },
      required: [],
    },
  },
  {
    name: 'install_package',
    description: 'Install a package using winget, npm, or pip.',
    parameters: {
      type: 'object',
      properties: {
        manager: {
          type: 'string',
          description: 'Package manager to use.',
          enum: ['winget', 'npm', 'pip'],
        },
        package: { type: 'string', description: 'Package name/id to install.' },
        global: { type: 'string', description: '"true" for global install (npm -g, pip --user).' },
      },
      required: ['manager', 'package'],
    },
  },

  // ── Git helpers ────────────────────────────────────────────────
  {
    name: 'git_command',
    description: 'Run a git command in any repository directory on any drive.',
    parameters: {
      type: 'object',
      properties: {
        args: { type: 'string', description: 'Git arguments, e.g. "status", "log --oneline -10".' },
        cwd: { type: 'string', description: 'Repository directory (absolute path on any drive). Defaults to user home.' },
      },
      required: ['args'],
    },
  },

  // ── Clipboard ──────────────────────────────────────────────────
  {
    name: 'clipboard_read',
    description: 'Read current text from the Windows clipboard.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'clipboard_write',
    description: 'Write text to the Windows clipboard.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to copy to clipboard.' },
      },
      required: ['text'],
    },
  },

  // ── Environment variables ──────────────────────────────────────
  {
    name: 'env_get',
    description: 'Get the value of an environment variable.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Environment variable name.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'env_list',
    description: 'List all environment variables.',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  // ── Open / launch ──────────────────────────────────────────────
  {
    name: 'open_url',
    description: 'Open a URL in the default browser.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'open_app',
    description: 'Launch a Windows application by name or path.',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Application name or full path (e.g. "notepad", "calc", "code .").' },
      },
      required: ['app'],
    },
  },

  // ── Search files ───────────────────────────────────────────────
  {
    name: 'search_files',
    description:
      'Search for files by name pattern under any directory on any drive (recursive). ' +
      'SMART MULTI-PASS: If the exact pattern finds nothing, automatically retries with each word from the pattern individually, ' +
      'then with a regex OR of all words. If a specific directory was given and nothing was found, expands search to all drives. ' +
      'Returns which strategy matched. Examples: "annual_report.pdf" → tries exact, then "annual", then "report", then regex.',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Root directory to search (absolute path, e.g. "D:\\", "C:\\Users"). Defaults to all drives if empty.' },
        pattern: { type: 'string', description: 'Filename pattern, e.g. "*.txt", "report*", "*.pdf".' },
        max_results: { type: 'string', description: 'Maximum results to return (default 100).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'search_in_files',
    description:
      'Search for text inside files under any directory on any drive (like grep/findstr). ' +
      'SMART MULTI-PASS: If exact text not found, retries with each word individually, then regex OR of all words via PowerShell Select-String. ' +
      'Returns the strategy that matched.',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Root directory to search (absolute path). Defaults to user home.' },
        text: { type: 'string', description: 'Text or pattern to search for.' },
        file_pattern: { type: 'string', description: 'Optional file glob filter, e.g. "*.ts", "*.log".' },
      },
      required: ['text'],
    },
  },

  // ── Date / time ────────────────────────────────────────────────
  {
    name: 'current_datetime',
    description: 'Return the current date, time, and timezone.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

// ─── Helpers ─────────────────────────────────────────────────────
import fs from 'fs/promises';

function sanitizeCommand(raw: string): string {
  return raw.replace(/[\x00-\x08\x0e-\x1f]/g, '');
}

function getFirstWord(cmd: string): string {
  return cmd.trim().split(/[\s/\\]+/)[0].toLowerCase();
}

function isDestructive(cmd: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((p) => p.test(cmd));
}

async function runCmd(
  command: string,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execAsync(command, {
    cwd: cwd || DEFAULT_CWD,
    timeout: CMD_TIMEOUT,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    shell: 'cmd.exe',
  });
  return {
    stdout: stdout.slice(0, MAX_OUTPUT),
    stderr: stderr.slice(0, MAX_OUTPUT),
  };
}

async function runPs(
  script: string,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execAsync(
    `powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`,
    {
      cwd: cwd || DEFAULT_CWD,
      timeout: CMD_TIMEOUT,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  return {
    stdout: stdout.slice(0, MAX_OUTPUT),
    stderr: stderr.slice(0, MAX_OUTPUT),
  };
}

// ─── Smart Search Helpers ────────────────────────────────────────
// Multi-pass file/directory finder. When an exact path fails, it
// progressively widens the search:
//   Pass 1: exact glob pattern
//   Pass 2: each significant word individually as *word*
//   Pass 3: regex OR of all words (catches partial matches)

interface SmartSearchResult {
  found: string[];
  strategy: string;
  searchDir: string;
}

/** Extract meaningful search words from a filename / query string */
function extractWords(input: string): string[] {
  // Strip extension, split on separators, drop tiny/noisy tokens
  const base = input.replace(/\.[^.]+$/, '');
  const raw = base.split(/[\s_\-./\\,;:]+/).filter(Boolean);
  return raw.filter((w) => w.length >= 2 && !/^(the|and|for|from|with|a|an|of|in|on|to|is)$/i.test(w));
}

/** PowerShell-safe single-quote escaping */
function psEsc(s: string): string {
  return s.replace(/'/g, "''");
}

/** Determine a reasonable search root from a given path.
 *  If the path has a drive letter, use that drive root.
 *  Otherwise fall back to all filesystem drives. */
function inferSearchRoot(filePath: string): string {
  const driveMatch = filePath.match(/^([A-Za-z]):[/\\]/);
  if (driveMatch) return `${driveMatch[1].toUpperCase()}:\\`;
  return DEFAULT_CWD;
}

/**
 * Smart multi-pass file search.
 * @param name     The filename or pattern the user asked for
 * @param baseDir  Where to start looking (drive root, specific folder)
 * @param type     'file' | 'directory' | 'any'
 * @param maxResults  Cap on results per pass
 */
async function smartFind(
  name: string,
  baseDir: string,
  type: 'file' | 'directory' | 'any' = 'any',
  maxResults = 30,
): Promise<SmartSearchResult> {
  const typeFilter = type === 'file'
    ? ' | Where-Object { !$_.PSIsContainer }'
    : type === 'directory'
    ? ' | Where-Object { $_.PSIsContainer }'
    : '';
  const selectFields = 'Select-Object FullName, Name, Length, LastWriteTime';

  // ── Pass 1: Direct glob pattern (exact name or *name*)
  const exactFilter = name.includes('*') || name.includes('?') ? name : `*${name}*`;
  try {
    const r1 = await runPs(
      `Get-ChildItem -Path '${psEsc(baseDir)}' -Filter '${psEsc(exactFilter)}' -Recurse -ErrorAction SilentlyContinue` +
      `${typeFilter} | ${selectFields} -First ${maxResults} | ConvertTo-Json`,
    );
    const parsed = JSON.parse(r1.stdout || '[]');
    const items = Array.isArray(parsed) ? parsed : parsed.FullName ? [parsed] : [];
    if (items.length > 0) {
      return { found: items.map((i: any) => i.FullName), strategy: `exact glob "${exactFilter}"`, searchDir: baseDir };
    }
  } catch { /* continue to next pass */ }

  // ── Pass 2: Each word individually as *word* filters
  const words = extractWords(name);
  if (words.length > 0) {
    for (const word of words) {
      try {
        const r2 = await runPs(
          `Get-ChildItem -Path '${psEsc(baseDir)}' -Filter '*${psEsc(word)}*' -Recurse -ErrorAction SilentlyContinue` +
          `${typeFilter} | ${selectFields} -First ${maxResults} | ConvertTo-Json`,
        );
        const parsed = JSON.parse(r2.stdout || '[]');
        const items = Array.isArray(parsed) ? parsed : parsed.FullName ? [parsed] : [];
        if (items.length > 0) {
          return { found: items.map((i: any) => i.FullName), strategy: `word search "*${word}*"`, searchDir: baseDir };
        }
      } catch { /* continue */ }
    }
  }

  // ── Pass 3: Regex OR of all words (catches partial/scattered matches)
  if (words.length > 1) {
    const regexPattern = words.map((w) => psEsc(w)).join('|');
    try {
      const r3 = await runPs(
        `Get-ChildItem -Path '${psEsc(baseDir)}' -Recurse -ErrorAction SilentlyContinue` +
        `${typeFilter} | Where-Object { $_.Name -match '${regexPattern}' } | ` +
        `${selectFields} -First ${maxResults} | ConvertTo-Json`,
      );
      const parsed = JSON.parse(r3.stdout || '[]');
      const items = Array.isArray(parsed) ? parsed : parsed.FullName ? [parsed] : [];
      if (items.length > 0) {
        return { found: items.map((i: any) => i.FullName), strategy: `regex "${regexPattern}"`, searchDir: baseDir };
      }
    } catch { /* continue */ }
  }

  // ── Pass 4: Widen to drive root if we were in a subdirectory
  const driveRoot = inferSearchRoot(baseDir);
  if (driveRoot !== baseDir) {
    const widened = await smartFind(name, driveRoot, type, maxResults);
    if (widened.found.length > 0) {
      return { ...widened, strategy: `widened to ${driveRoot} → ${widened.strategy}` };
    }
  }

  return { found: [], strategy: 'all passes exhausted', searchDir: baseDir };
}

/**
 * Resolve a file path — if it doesn't exist, run smartFind to locate it.
 * Returns { resolved, suggestion } where resolved is the actual path if found,
 * or null with suggestion listing candidates.
 */
async function resolveOrSearch(
  filePath: string,
  type: 'file' | 'directory' | 'any' = 'any',
): Promise<{ resolved: string | null; suggestion: string | null; candidates: string[] }> {
  // Check if the exact path exists
  try {
    await fs.access(filePath);
    return { resolved: filePath, suggestion: null, candidates: [] };
  } catch { /* not found, search */ }

  // Try searching
  const fileName = path.basename(filePath);
  const searchRoot = path.dirname(filePath);
  const validRoot = await fs.access(searchRoot).then(() => searchRoot).catch(() => inferSearchRoot(filePath));

  const result = await smartFind(fileName, validRoot, type);
  if (result.found.length === 1) {
    return { resolved: result.found[0], suggestion: `Auto-resolved via ${result.strategy}`, candidates: result.found };
  } else if (result.found.length > 1) {
    return {
      resolved: null,
      suggestion: `File "${filePath}" not found. Found ${result.found.length} candidates via ${result.strategy}:\n${result.found.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}`,
      candidates: result.found,
    };
  }
  return {
    resolved: null,
    suggestion: `File "${filePath}" not found anywhere. Searched "${validRoot}" using exact, per-word, and regex strategies.`,
    candidates: [],
  };
}

// ─── Provider Implementation ─────────────────────────────────────
async function execute(
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  try {
    switch (toolName) {
      // ── Shell execution ────────────────────────────────────────
      case 'run_command': {
        const command = sanitizeCommand(args.command as string);
        if (!command) return { success: false, data: null, error: 'command is required' };

        const firstWord = getFirstWord(command);
        if (!ALLOWED_COMMANDS.has(firstWord)) {
          return {
            success: false,
            data: null,
            error: `Command "${firstWord}" is not in the allow-list. Allowed: ${[...ALLOWED_COMMANDS].join(', ')}`,
          };
        }

        if (isDestructive(command) && (args.confirm_destructive as string) !== 'yes') {
          return {
            success: false,
            data: null,
            error: `This command looks destructive. Set confirm_destructive="yes" to proceed: ${command}`,
          };
        }

        const result = await runCmd(command, args.cwd as string | undefined);
        return { success: true, data: result };
      }

      case 'run_powershell': {
        const script = sanitizeCommand(args.script as string);
        if (!script) return { success: false, data: null, error: 'script is required' };
        const result = await runPs(script, args.cwd as string | undefined);
        return { success: true, data: result };
      }

      // ── Drive discovery ────────────────────────────────────────
      case 'list_drives': {
        const result = await runPs(
          'Get-PSDrive -PSProvider FileSystem | Select-Object Name, ' +
          '@{N="Label";E={(Get-Volume -DriveLetter $_.Name -ErrorAction SilentlyContinue).FileSystemLabel}}, ' +
          '@{N="Total_GB";E={[math]::Round(($_.Used+$_.Free)/1GB,2)}}, ' +
          '@{N="Used_GB";E={[math]::Round($_.Used/1GB,2)}}, ' +
          '@{N="Free_GB";E={[math]::Round($_.Free/1GB,2)}}, ' +
          'Root | ConvertTo-Json',
        );
        return { success: true, data: JSON.parse(result.stdout || '[]') };
      }

      // ── Host file operations (full system, any drive) ──────────
      case 'host_list_dir': {
        let dirPath = args.path as string;
        if (!dirPath) return { success: false, data: null, error: 'path is required (absolute path, e.g. "C:\\Users")' };
        const isRecursive = (args.recursive as string) === 'true';

        // Smart resolve: if directory doesn't exist, search for it
        const resolved = await resolveOrSearch(dirPath, 'directory');
        if (!resolved.resolved && resolved.candidates.length === 0) {
          return { success: false, data: null, error: resolved.suggestion || `Directory "${dirPath}" not found.` };
        }
        if (!resolved.resolved && resolved.candidates.length > 0) {
          return { success: false, data: { suggestion: resolved.suggestion, candidates: resolved.candidates }, error: `Directory "${dirPath}" not found. See candidates in data.` };
        }
        dirPath = resolved.resolved!;
        const resolveNote = resolved.suggestion ? `\n[Auto-resolved: ${resolved.suggestion}]` : '';

        if (isRecursive) {
          const result = await runPs(
            `Get-ChildItem -Path '${dirPath.replace(/'/g, "''")}' -Recurse -ErrorAction SilentlyContinue | ` +
            'Select-Object FullName, Name, Length, LastWriteTime, ' +
            '@{N="Type";E={if($_.PSIsContainer){"Directory"}else{"File"}}} ' +
            '-First 500 | ConvertTo-Json',
          );
          return { success: true, data: { items: JSON.parse(result.stdout || '[]'), resolvedPath: dirPath, note: resolveNote || undefined } };
        }

        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const items = [];
        for (const e of entries) {
          try {
            const fullPath = path.join(dirPath, e.name);
            const stat = await fs.stat(fullPath);
            items.push({
              name: e.name,
              isDirectory: e.isDirectory(),
              size: e.isDirectory() ? null : stat.size,
              modified: stat.mtime.toISOString(),
            });
          } catch {
            items.push({ name: e.name, isDirectory: e.isDirectory(), size: null, modified: null });
          }
        }
        return { success: true, data: { items, resolvedPath: dirPath, note: resolveNote || undefined } };
      }

      case 'host_read_file': {
        let filePath = args.path as string;
        if (!filePath) return { success: false, data: null, error: 'path is required (absolute path, e.g. "D:\\file.txt")' };
        const encoding = (args.encoding as BufferEncoding) || 'utf-8';

        // Smart resolve: if file doesn't exist, auto-search for it
        const resolved = await resolveOrSearch(filePath, 'file');
        if (!resolved.resolved && resolved.candidates.length === 0) {
          return { success: false, data: null, error: resolved.suggestion || `File "${filePath}" not found.` };
        }
        if (!resolved.resolved && resolved.candidates.length > 0) {
          return { success: false, data: { suggestion: resolved.suggestion, candidates: resolved.candidates }, error: `File "${filePath}" not found exactly, but candidates were found. See data.candidates.` };
        }
        filePath = resolved.resolved!;
        const resolveNote = resolved.suggestion ? `[Auto-resolved: ${resolved.suggestion}]\n` : '';

        const content = await fs.readFile(filePath, encoding);
        return { success: true, data: resolveNote + content.slice(0, 64_000) };
      }

      case 'host_write_file': {
        let filePath = args.path as string;
        const content = args.content as string;
        if (!filePath) return { success: false, data: null, error: 'path is required' };

        // For writes: if the parent directory doesn't exist, try to locate a similar one
        const parentDir = path.dirname(filePath);
        try {
          await fs.access(parentDir);
        } catch {
          const dirResolved = await resolveOrSearch(parentDir, 'directory');
          if (dirResolved.resolved) {
            filePath = path.join(dirResolved.resolved, path.basename(filePath));
          }
        }

        await fs.mkdir(path.dirname(filePath), { recursive: true });
        if ((args.append as string) === 'true') {
          await fs.appendFile(filePath, content, 'utf-8');
          return { success: true, data: `Appended to: ${filePath}` };
        }
        await fs.writeFile(filePath, content, 'utf-8');
        return { success: true, data: `Written: ${filePath}` };
      }

      case 'host_copy': {
        const src = args.source as string;
        const dst = args.destination as string;
        if (!src || !dst) return { success: false, data: null, error: 'source and destination are required' };
        const isRecursive = (args.recursive as string) === 'true';
        const stat = await fs.stat(src);
        if (stat.isDirectory() || isRecursive) {
          await runPs(`Copy-Item -Path '${src.replace(/'/g, "''")}' -Destination '${dst.replace(/'/g, "''")}' -Recurse -Force`);
        } else {
          await fs.copyFile(src, dst);
        }
        return { success: true, data: `Copied: ${src} → ${dst}` };
      }

      case 'host_move': {
        const src = args.source as string;
        const dst = args.destination as string;
        if (!src || !dst) return { success: false, data: null, error: 'source and destination are required' };
        await fs.rename(src, dst).catch(async () => {
          // Cross-drive move: copy then delete
          await runPs(`Move-Item -Path '${src.replace(/'/g, "''")}' -Destination '${dst.replace(/'/g, "''")}' -Force`);
        });
        return { success: true, data: `Moved: ${src} → ${dst}` };
      }

      case 'host_delete': {
        const delPath = args.path as string;
        if (!delPath) return { success: false, data: null, error: 'path is required' };
        if ((args.confirm as string) !== 'yes') {
          return { success: false, data: null, error: 'Set confirm="yes" to confirm deletion.' };
        }
        const stat = await fs.stat(delPath);
        if (stat.isDirectory()) {
          await fs.rm(delPath, { recursive: true });
        } else {
          await fs.unlink(delPath);
        }
        return { success: true, data: `Deleted: ${delPath}` };
      }

      case 'host_create_dir': {
        const dirPath = args.path as string;
        if (!dirPath) return { success: false, data: null, error: 'path is required' };
        await fs.mkdir(dirPath, { recursive: true });
        return { success: true, data: `Directory created: ${dirPath}` };
      }

      case 'host_file_info': {
        let filePath = args.path as string;
        if (!filePath) return { success: false, data: null, error: 'path is required' };

        // Smart resolve: search if path doesn't exist
        const resolved = await resolveOrSearch(filePath);
        if (!resolved.resolved && resolved.candidates.length === 0) {
          return { success: true, data: { path: filePath, exists: false, note: resolved.suggestion } };
        }
        if (!resolved.resolved && resolved.candidates.length > 0) {
          return { success: true, data: { path: filePath, exists: false, candidates: resolved.candidates, note: resolved.suggestion } };
        }
        filePath = resolved.resolved!;

        const stat = await fs.stat(filePath);
        return {
          success: true,
          data: {
            path: filePath,
            exists: true,
            autoResolved: !!resolved.suggestion,
            isFile: stat.isFile(),
            isDirectory: stat.isDirectory(),
            size: stat.size,
            size_human: stat.size > 1073741824
              ? `${(stat.size / 1073741824).toFixed(2)} GB`
              : stat.size > 1048576
              ? `${(stat.size / 1048576).toFixed(2)} MB`
              : `${(stat.size / 1024).toFixed(2)} KB`,
            created: stat.birthtime.toISOString(),
            modified: stat.mtime.toISOString(),
            accessed: stat.atime.toISOString(),
          },
        };
      }

      case 'host_file_exists': {
        const filePath = args.path as string;
        if (!filePath) return { success: false, data: null, error: 'path is required' };
        try {
          const stat = await fs.stat(filePath);
          return { success: true, data: { exists: true, isFile: stat.isFile(), isDirectory: stat.isDirectory() } };
        } catch {
          return { success: true, data: { exists: false } };
        }
      }

      // ── System information ─────────────────────────────────────
      case 'system_info': {
        const result = await runPs(
          '$os = Get-CimInstance Win32_OperatingSystem; ' +
          '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; ' +
          '[PSCustomObject]@{ ' +
          '  Hostname = $env:COMPUTERNAME; ' +
          '  Username = $env:USERNAME; ' +
          '  HomeDir = $env:USERPROFILE; ' +
          '  OS = $os.Caption; ' +
          '  Version = $os.Version; ' +
          '  CPU = $cpu.Name; ' +
          '  Cores = $cpu.NumberOfCores; ' +
          '  RAM_GB = [math]::Round($os.TotalVisibleMemorySize/1MB,1); ' +
          '  FreeRAM_GB = [math]::Round($os.FreePhysicalMemory/1MB,1); ' +
          '  Uptime = (New-TimeSpan -Start $os.LastBootUpTime).ToString(); ' +
          '  Drives = (Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Root }) -join ", " ' +
          '} | ConvertTo-Json',
        );
        return { success: true, data: JSON.parse(result.stdout || '{}') };
      }

      case 'list_processes': {
        const filter = args.filter as string | undefined;
        const ps = filter
          ? `Get-Process | Where-Object { $_.ProcessName -like '*${filter.replace(/'/g, "''")}*' } | Select-Object Id,ProcessName,CPU,WorkingSet64 -First 30 | ConvertTo-Json`
          : 'Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64 -First 50 | ConvertTo-Json';
        const result = await runPs(ps);
        return { success: true, data: JSON.parse(result.stdout || '[]') };
      }

      case 'kill_process': {
        const target = args.target as string;
        if (!target) return { success: false, data: null, error: 'target is required' };
        const isNumeric = /^\d+$/.test(target);
        const ps = isNumeric
          ? `Stop-Process -Id ${target} -Force -PassThru | Select-Object Id,ProcessName | ConvertTo-Json`
          : `Stop-Process -Name "${target.replace(/"/g, '')}" -Force -PassThru | Select-Object Id,ProcessName | ConvertTo-Json`;
        const result = await runPs(ps);
        return { success: true, data: result.stdout || 'Process terminated' };
      }

      // ── Networking ─────────────────────────────────────────────
      case 'ping_host': {
        const host = args.host as string;
        const count = args.count || '4';
        if (!host) return { success: false, data: null, error: 'host is required' };
        const result = await runCmd(`ping -n ${count} ${host}`);
        return { success: true, data: result.stdout };
      }

      case 'network_info': {
        const result = await runCmd('ipconfig /all');
        return { success: true, data: result.stdout };
      }

      case 'dns_lookup': {
        const host = args.host as string;
        if (!host) return { success: false, data: null, error: 'host is required' };
        const result = await runCmd(`nslookup ${host}`);
        return { success: true, data: result.stdout };
      }

      case 'check_ports': {
        const filter = args.filter as string | undefined;
        const cmd = filter
          ? `netstat -ano | findstr "${filter}"`
          : 'netstat -ano | more';
        const result = await runCmd(cmd);
        return { success: true, data: result.stdout };
      }

      // ── Disk ───────────────────────────────────────────────────
      case 'disk_usage': {
        const result = await runPs(
          'Get-PSDrive -PSProvider FileSystem | Select-Object Name, ' +
          '@{N="Used_GB";E={[math]::Round($_.Used/1GB,2)}}, ' +
          '@{N="Free_GB";E={[math]::Round($_.Free/1GB,2)}}, ' +
          'Root | ConvertTo-Json',
        );
        return { success: true, data: JSON.parse(result.stdout || '[]') };
      }

      // ── Installed software ─────────────────────────────────────
      case 'installed_apps': {
        const filter = args.filter as string | undefined;
        const cmd = filter
          ? `winget list --name "${filter}" --accept-source-agreements`
          : 'winget list --accept-source-agreements';
        try {
          const result = await runCmd(cmd);
          return { success: true, data: result.stdout };
        } catch {
          // Fallback to PowerShell registry query
          const ps = filter
            ? `Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Where-Object { $_.DisplayName -like '*${filter}*' } | Select-Object DisplayName,DisplayVersion -First 30 | ConvertTo-Json`
            : 'Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Select-Object DisplayName,DisplayVersion -First 50 | ConvertTo-Json';
          const result = await runPs(ps);
          return { success: true, data: result.stdout };
        }
      }

      case 'install_package': {
        const mgr = args.manager as string;
        const pkg = args.package as string;
        const isGlobal = (args.global as string) === 'true';
        if (!pkg) return { success: false, data: null, error: 'package is required' };

        let cmd: string;
        switch (mgr) {
          case 'winget':
            cmd = `winget install --id "${pkg}" --accept-package-agreements --accept-source-agreements`;
            break;
          case 'npm':
            cmd = isGlobal ? `npm install -g ${pkg}` : `npm install ${pkg}`;
            break;
          case 'pip':
            cmd = isGlobal ? `pip install --user ${pkg}` : `pip install ${pkg}`;
            break;
          default:
            return { success: false, data: null, error: `Unknown manager: ${mgr}. Use winget, npm, or pip.` };
        }
        const result = await runCmd(cmd);
        return { success: true, data: result.stdout + (result.stderr ? `\n${result.stderr}` : '') };
      }

      // ── Git ────────────────────────────────────────────────────
      case 'git_command': {
        const gitArgs = args.args as string;
        if (!gitArgs) return { success: false, data: null, error: 'args is required' };
        const result = await runCmd(`git ${gitArgs}`, (args.cwd as string) || DEFAULT_CWD);
        return { success: true, data: result.stdout + (result.stderr ? `\n${result.stderr}` : '') };
      }

      // ── Clipboard ──────────────────────────────────────────────
      case 'clipboard_read': {
        const result = await runPs('Get-Clipboard');
        return { success: true, data: result.stdout.trim() };
      }

      case 'clipboard_write': {
        const text = args.text as string;
        if (!text) return { success: false, data: null, error: 'text is required' };
        await runPs(`Set-Clipboard -Value '${text.replace(/'/g, "''")}'`);
        return { success: true, data: 'Text copied to clipboard' };
      }

      // ── Environment variables ──────────────────────────────────
      case 'env_get': {
        const name = args.name as string;
        if (!name) return { success: false, data: null, error: 'name is required' };
        const value = process.env[name];
        return { success: true, data: value ?? `Variable "${name}" not found` };
      }

      case 'env_list': {
        const env = { ...process.env };
        // Redact sensitive-looking values
        for (const key of Object.keys(env)) {
          if (/secret|password|token|key|api_key/i.test(key)) {
            env[key] = '***REDACTED***';
          }
        }
        return { success: true, data: env };
      }

      // ── Open / launch ──────────────────────────────────────────
      case 'open_url': {
        const url = args.url as string;
        if (!url) return { success: false, data: null, error: 'url is required' };
        await runCmd(`start "" "${url}"`);
        return { success: true, data: `Opened: ${url}` };
      }

      case 'open_app': {
        const app = args.app as string;
        if (!app) return { success: false, data: null, error: 'app is required' };
        await runCmd(`start "" "${app}"`);
        return { success: true, data: `Launched: ${app}` };
      }

      // ── Search files ───────────────────────────────────────────
      case 'search_files': {
        const dir = args.directory as string | undefined;
        const pattern = args.pattern as string;
        const maxResults = parseInt(args.max_results as string) || 100;
        if (!pattern) return { success: false, data: null, error: 'pattern is required (filename, partial name, or glob pattern like *.txt)' };

        const searchRoot = dir || DEFAULT_CWD;

        // Smart multi-pass search via smartFind
        const result = await smartFind(pattern, searchRoot, 'file', maxResults);

        if (result.found.length > 0) {
          return {
            success: true,
            data: {
              files: result.found,
              count: result.found.length,
              strategy: result.strategy,
              searchDir: result.searchDir,
            },
          };
        }

        // If we had a specific dir and nothing found, try all drives
        if (dir) {
          try {
            const allDrivesResult = await runPs(
              'Get-PSDrive -PSProvider FileSystem | ForEach-Object { ' +
              `Get-ChildItem -Path $_.Root -Filter '*${psEsc(pattern)}*' -Recurse -ErrorAction SilentlyContinue | ` +
              `Select-Object FullName, Length, LastWriteTime } | Select-Object -First ${maxResults} | ConvertTo-Json`,
            );
            const parsed = JSON.parse(allDrivesResult.stdout || '[]');
            const items = Array.isArray(parsed) ? parsed : parsed.FullName ? [parsed] : [];
            if (items.length > 0) {
              return {
                success: true,
                data: {
                  files: items.map((i: any) => i.FullName),
                  count: items.length,
                  strategy: `expanded to all drives with "*${pattern}*"`,
                  searchDir: 'all drives',
                },
              };
            }
          } catch { /* fall through */ }

          // Word-split across all drives
          const words = extractWords(pattern);
          for (const word of words) {
            try {
              const wordResult = await runPs(
                'Get-PSDrive -PSProvider FileSystem | ForEach-Object { ' +
                `Get-ChildItem -Path $_.Root -Filter '*${psEsc(word)}*' -Recurse -ErrorAction SilentlyContinue | ` +
                `Select-Object FullName, Length, LastWriteTime } | Select-Object -First ${maxResults} | ConvertTo-Json`,
              );
              const parsed = JSON.parse(wordResult.stdout || '[]');
              const items = Array.isArray(parsed) ? parsed : parsed.FullName ? [parsed] : [];
              if (items.length > 0) {
                return {
                  success: true,
                  data: {
                    files: items.map((i: any) => i.FullName),
                    count: items.length,
                    strategy: `all-drives word search "*${word}*"`,
                    searchDir: 'all drives',
                  },
                };
              }
            } catch { /* continue */ }
          }
        }

        return {
          success: true,
          data: {
            files: [],
            count: 0,
            strategy: result.strategy,
            searchDir: result.searchDir,
            message: `No files found matching "${pattern}". Tried: exact glob, per-word search, regex matching.`,
          },
        };
      }

      case 'search_in_files': {
        const dir = (args.directory as string) || DEFAULT_CWD;
        const text = args.text as string;
        const filePattern = (args.file_pattern as string) || '*.*';
        if (!text) return { success: false, data: null, error: 'text is required' };

        // Pass 1: Exact text search
        try {
          const r1 = await runCmd(`findstr /s /i /n "${text}" "${filePattern}"`, dir);
          if (r1.stdout.trim()) {
            return { success: true, data: { results: r1.stdout, strategy: 'exact match' } };
          }
        } catch { /* no results, continue */ }

        // Pass 2: Search for each word individually
        const words = extractWords(text);
        const allResults: string[] = [];
        let usedStrategy = 'no results';

        for (const word of words) {
          try {
            const r2 = await runCmd(`findstr /s /i /n "${word}" "${filePattern}"`, dir);
            if (r2.stdout.trim()) {
              allResults.push(`--- Matches for "${word}" ---\n${r2.stdout.trim()}`);
              usedStrategy = `per-word search`;
            }
          } catch { /* word not found, continue */ }
        }

        if (allResults.length > 0) {
          return { success: true, data: { results: allResults.join('\n\n').slice(0, MAX_OUTPUT), strategy: usedStrategy } };
        }

        // Pass 3: Regex search with PowerShell (more flexible)
        if (words.length > 0) {
          try {
            const regexOr = words.join('|');
            const r3 = await runPs(
              `Get-ChildItem -Path '${psEsc(dir)}' -Filter '${psEsc(filePattern)}' -Recurse -ErrorAction SilentlyContinue | ` +
              `Select-String -Pattern '${psEsc(regexOr)}' -ErrorAction SilentlyContinue | ` +
              'Select-Object Path, LineNumber, Line -First 100 | ConvertTo-Json',
            );
            const parsed = JSON.parse(r3.stdout || '[]');
            const items = Array.isArray(parsed) ? parsed : parsed.Path ? [parsed] : [];
            if (items.length > 0) {
              return { success: true, data: { results: items, strategy: `regex "${regexOr}"` } };
            }
          } catch { /* fall through */ }
        }

        return {
          success: true,
          data: {
            results: '',
            strategy: 'all passes exhausted',
            message: `No matches for "${text}" in ${dir}/${filePattern}. Tried: exact, per-word, and regex.`,
          },
        };
      }

      // ── Date / time ────────────────────────────────────────────
      case 'current_datetime': {
        const now = new Date();
        return {
          success: true,
          data: {
            iso: now.toISOString(),
            local: now.toLocaleString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            unix: Math.floor(now.getTime() / 1000),
          },
        };
      }

      default:
        return { success: false, data: null, error: `Unknown tool: ${toolName}` };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, data: null, error: message };
  }
}

export const systemProvider: McpProvider = {
  name: 'system',
  description:
    'Full Windows system tools – operates across ALL drives and directories. ' +
    'Shell commands, PowerShell, file operations (read/write/copy/move/delete on any drive), ' +
    'drive discovery, networking, processes, disk, packages, git, clipboard, environment, search, and more.',
  tools,
  execute,
};
