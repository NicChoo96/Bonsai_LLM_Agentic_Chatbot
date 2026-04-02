import { NextResponse } from 'next/server';
import { ensureSandbox, listSandboxTree, readSandboxFile } from '@/lib/sandbox';

// Regex to match skill-related files and extract skill names from content
const SKILL_FILE_PATTERN = /skill/i;
const SKILL_NAME_REGEX = /(?:^|\n)\s*(?:name|skill|title)\s*[:=]\s*(.+)/gi;
const SKILL_DESC_REGEX = /(?:^|\n)\s*(?:description|desc|purpose)\s*[:=]\s*(.+)/gi;

interface SkillInfo {
  file: string;
  name: string;
  description: string;
  content: string;
}

/** Recursively collect all file paths from the sandbox tree */
function flattenTree(
  items: { name: string; path: string; isDirectory: boolean; children?: any[] }[],
): string[] {
  const paths: string[] = [];
  for (const item of items) {
    if (item.isDirectory && item.children) {
      paths.push(...flattenTree(item.children));
    } else if (!item.isDirectory) {
      paths.push(item.path);
    }
  }
  return paths;
}

/** Extract a skill name from file content using regex */
function extractSkillName(content: string, fileName: string): string {
  const regex = new RegExp(SKILL_NAME_REGEX.source, 'gi');
  const match = regex.exec(content);
  if (match) return match[1].trim();

  // Fallback: derive from file name
  return fileName
    .replace(/[_-]/g, ' ')
    .replace(/\.(txt|md|json|yaml|yml)$/i, '')
    .replace(/skill/gi, '')
    .trim() || fileName;
}

/** Extract a skill description from file content using regex */
function extractSkillDescription(content: string): string {
  const regex = new RegExp(SKILL_DESC_REGEX.source, 'gi');
  const match = regex.exec(content);
  if (match) return match[1].trim();

  // Fallback: use the first non-empty line as description
  const firstLine = content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('//'));
  return firstLine?.slice(0, 200) || 'No description available';
}

// GET /api/skills – scan sandbox for skill files using regex
export async function GET() {
  try {
    await ensureSandbox();

    const tree = await listSandboxTree('');
    const allFiles = flattenTree(tree);

    // Filter files whose name matches the skill pattern
    const skillFiles = allFiles.filter((f) => SKILL_FILE_PATTERN.test(f));

    const skills: SkillInfo[] = [];

    for (const filePath of skillFiles) {
      try {
        const content = await readSandboxFile(filePath);
        const name = extractSkillName(content, filePath.split('/').pop() || filePath);
        const description = extractSkillDescription(content);

        skills.push({
          file: filePath,
          name,
          description,
          content,
        });
      } catch {
        // Skip files that can't be read
      }
    }

    return NextResponse.json({ skills });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
