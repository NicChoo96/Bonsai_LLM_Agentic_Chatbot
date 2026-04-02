import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import type { McpProvider, McpToolDefinition, McpToolResult } from './types';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

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
      'Run a shell command on the host Windows 11 system and return stdout+stderr. ' +
      'Commands run inside cmd.exe. Dangerous operations require confirmation.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
        cwd: {
          type: 'string',
          description: 'Working directory (absolute path). Defaults to the sandbox folder.',
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
      'Run a PowerShell snippet on the host Windows 11 system and return the output.',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'PowerShell script or one-liner to execute.' },
        cwd: { type: 'string', description: 'Working directory (absolute path). Optional.' },
      },
      required: ['script'],
    },
  },

  // ── File & directory helpers (host-level, outside sandbox) ─────
  {
    name: 'host_list_dir',
    description: 'List files and directories at an absolute path on the host system.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path to list.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'host_read_file',
    description: 'Read the text contents of a file on the host system (max 32 KB returned).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path to read.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'host_write_file',
    description: 'Write text content to a file on the host system. Creates or overwrites.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path to write.' },
        content: { type: 'string', description: 'Content to write to the file.' },
      },
      required: ['path', 'content'],
    },
  },

  // ── System information ─────────────────────────────────────────
  {
    name: 'system_info',
    description: 'Return key Windows system information (hostname, OS, CPU, RAM, uptime).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_processes',
    description: 'List running processes, optionally filtered by name.',
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
    description: 'Ping a hostname or IP address and return the result.',
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
    description: 'Return current network adapter configuration (ipconfig /all).',
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
    description: 'Show active TCP connections and listening ports (netstat).',
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
    description: 'Run a git command in a specified directory.',
    parameters: {
      type: 'object',
      properties: {
        args: { type: 'string', description: 'Git arguments, e.g. "status", "log --oneline -10".' },
        cwd: { type: 'string', description: 'Repository directory (absolute path).' },
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
    description: 'Search for files by name pattern under a directory (recursive).',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Root directory to search (absolute path).' },
        pattern: { type: 'string', description: 'Filename pattern, e.g. "*.txt", "report*".' },
      },
      required: ['directory', 'pattern'],
    },
  },
  {
    name: 'search_in_files',
    description: 'Search for text inside files under a directory (like grep/findstr).',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Root directory to search.' },
        text: { type: 'string', description: 'Text or pattern to search for.' },
        file_pattern: { type: 'string', description: 'Optional file glob filter, e.g. "*.ts".' },
      },
      required: ['directory', 'text'],
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

const SANDBOX_ROOT = path.resolve(process.cwd(), 'sandbox');

function sanitizeCommand(raw: string): string {
  // Strip null bytes and other control characters
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
    cwd: cwd || SANDBOX_ROOT,
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
      cwd: cwd || SANDBOX_ROOT,
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

      // ── Host file operations ───────────────────────────────────
      case 'host_list_dir': {
        const dirPath = args.path as string;
        if (!dirPath) return { success: false, data: null, error: 'path is required' };
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const items = entries.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
        }));
        return { success: true, data: items };
      }

      case 'host_read_file': {
        const filePath = args.path as string;
        if (!filePath) return { success: false, data: null, error: 'path is required' };
        const content = await fs.readFile(filePath, 'utf-8');
        return { success: true, data: content.slice(0, 32_000) };
      }

      case 'host_write_file': {
        const filePath = args.path as string;
        const content = args.content as string;
        if (!filePath) return { success: false, data: null, error: 'path is required' };
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf-8');
        return { success: true, data: `Written: ${filePath}` };
      }

      // ── System information ─────────────────────────────────────
      case 'system_info': {
        const result = await runPs(
          '$os = Get-CimInstance Win32_OperatingSystem; ' +
          '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; ' +
          '[PSCustomObject]@{ ' +
          '  Hostname = $env:COMPUTERNAME; ' +
          '  OS = $os.Caption; ' +
          '  Version = $os.Version; ' +
          '  CPU = $cpu.Name; ' +
          '  Cores = $cpu.NumberOfCores; ' +
          '  RAM_GB = [math]::Round($os.TotalVisibleMemorySize/1MB,1); ' +
          '  FreeRAM_GB = [math]::Round($os.FreePhysicalMemory/1MB,1); ' +
          '  Uptime = (New-TimeSpan -Start $os.LastBootUpTime).ToString() ' +
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
        const result = await runCmd(`git ${gitArgs}`, args.cwd as string | undefined);
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
        const dir = args.directory as string;
        const pattern = args.pattern as string;
        if (!dir || !pattern) return { success: false, data: null, error: 'directory and pattern are required' };
        const result = await runCmd(`dir /s /b "${pattern}"`, dir);
        return { success: true, data: result.stdout };
      }

      case 'search_in_files': {
        const dir = args.directory as string;
        const text = args.text as string;
        const filePattern = (args.file_pattern as string) || '*.*';
        if (!dir || !text) return { success: false, data: null, error: 'directory and text are required' };
        const result = await runCmd(
          `findstr /s /i /n "${text}" "${filePattern}"`,
          dir,
        );
        return { success: true, data: result.stdout };
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
    'Windows 11 system tools – shell commands, PowerShell, file ops, networking, ' +
    'processes, disk, packages, git, clipboard, environment, and more.',
  tools,
  execute,
};
