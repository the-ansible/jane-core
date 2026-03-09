/**
 * Vault search context module — retrieves relevant vault documents for the current prompt.
 *
 * Searches /agent/data/vault/**\/*.md for files whose paths or content match
 * keywords extracted from the prompt. Returns the most relevant file sections
 * as a context fragment for development-focused agents.
 *
 * Useful for architect and implementer roles that need project documentation
 * injected automatically rather than having to manually search the vault.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ContextModule, ContextModuleParams, ContextFragment } from '../types.js';
import { estimateTokens } from '../tokens.js';

const VAULT_ROOT = '/agent/data/vault';
const DEFAULT_TOKEN_BUDGET = 3000;
const MAX_FILES_TO_RETURN = 3;
const CONTENT_PREVIEW_CHARS = 600;

// Stop words that don't contribute to search relevance
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'this', 'that', 'these', 'those', 'it', 'its',
  'we', 'you', 'he', 'she', 'they', 'i', 'me', 'my', 'our', 'your', 'their',
  'what', 'which', 'who', 'how', 'when', 'where', 'why', 'not', 'no', 'so',
  'if', 'then', 'than', 'as', 'up', 'out', 'about', 'into', 'also', 'just',
  'now', 'use', 'used', 'using', 'make', 'read', 'get', 'set', 'run', 'new',
  'add', 'all', 'any', 'can', 'each', 'file', 'files', 'code', 'data',
]);

/**
 * Extract meaningful keywords from a prompt.
 * Filters stop words and short tokens.
 */
export function extractKeywords(prompt: string): string[] {
  const normalized = prompt.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ');
  const words = normalized.split(/\s+/).filter(Boolean);
  const meaningful = words.filter(w => w.length > 3 && !STOP_WORDS.has(w));
  // Deduplicate while preserving order
  return [...new Set(meaningful)].slice(0, 12);
}

/**
 * Recursively collect all .md file paths under a directory.
 * Skips hidden directories and common noise paths.
 */
export function collectVaultFiles(dir: string, maxDepth = 4, depth = 0): string[] {
  if (depth > maxDepth || !existsSync(dir)) return [];

  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip hidden directories and known noise
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules' || entry.name === 'Attachments') continue;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectVaultFiles(fullPath, maxDepth, depth + 1));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
  } catch {
    // Unreadable directory — skip
  }
  return results;
}

interface ScoredFile {
  path: string;
  score: number;
}

/**
 * Score a vault file by how many keywords match its path or content preview.
 * Path matches score higher than content matches (more signal, less noise).
 */
export function scoreFile(filePath: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;

  const relPath = relative(VAULT_ROOT, filePath).toLowerCase();
  let score = 0;

  for (const kw of keywords) {
    // Path match: high signal
    if (relPath.includes(kw)) score += 3;
  }

  // Only read content if path already has some relevance or we have few keywords
  if (score > 0 || keywords.length <= 3) {
    try {
      const stat = statSync(filePath);
      // Skip very large files (> 100KB) for preview scoring
      if (stat.size > 102400) return score;

      const preview = readFileSync(filePath, 'utf-8').slice(0, CONTENT_PREVIEW_CHARS).toLowerCase();
      for (const kw of keywords) {
        if (preview.includes(kw)) score += 1;
      }
    } catch {
      // Unreadable file — skip content scoring
    }
  }

  return score;
}

/**
 * Read a vault file and return truncated content within token budget.
 */
function readVaultFile(filePath: string, maxTokens: number): string {
  try {
    const content = readFileSync(filePath, 'utf-8');
    // Estimate how many chars fit in budget (4 chars/token heuristic)
    const maxChars = maxTokens * 4;
    if (content.length <= maxChars) return content;
    // Truncate at paragraph boundary near the limit
    const truncated = content.slice(0, maxChars);
    const lastNewline = truncated.lastIndexOf('\n\n');
    return lastNewline > maxChars * 0.7
      ? truncated.slice(0, lastNewline) + '\n\n[...truncated]'
      : truncated + '\n\n[...truncated]';
  } catch {
    return '';
  }
}

const vaultSearchModule: ContextModule = {
  name: 'vault-search',

  async assemble(params: ContextModuleParams): Promise<ContextFragment | null> {
    try {
      const keywords = extractKeywords(params.prompt);
      if (keywords.length === 0) return null;

      // Collect all vault markdown files
      const allFiles = collectVaultFiles(VAULT_ROOT);
      if (allFiles.length === 0) return null;

      // Score each file
      const scored: ScoredFile[] = allFiles
        .map(path => ({ path, score: scoreFile(path, keywords) }))
        .filter(f => f.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_FILES_TO_RETURN);

      if (scored.length === 0) return null;

      // Build output within token budget
      const budget = params.plan?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
      const perFileBudget = Math.floor(budget / scored.length);

      const parts: string[] = ['VAULT KNOWLEDGE (relevant project documentation):'];
      let totalTokens = estimateTokens(parts[0]);

      for (const { path, score } of scored) {
        const relPath = relative(VAULT_ROOT, path);
        const content = readVaultFile(path, perFileBudget - 20); // reserve for header
        if (!content) continue;

        const header = `\n--- ${relPath} ---`;
        const block = `${header}\n${content}`;
        const blockTokens = estimateTokens(block);

        if (totalTokens + blockTokens > budget) break;

        parts.push(block);
        totalTokens += blockTokens;
      }

      if (parts.length <= 1) return null;

      const text = parts.join('\n');

      log('debug', 'Vault search found matches', {
        keywords: keywords.slice(0, 5),
        filesFound: scored.length,
        filesIncluded: parts.length - 1,
        totalTokens,
      });

      return {
        source: 'vault-search',
        text,
        tokenEstimate: totalTokens,
        meta: {
          keywords: keywords.slice(0, 5),
          filesFound: scored.length,
          filesIncluded: parts.length - 1,
          topScores: scored.map(f => ({ path: relative(VAULT_ROOT, f.path), score: f.score })),
        },
      };
    } catch (err) {
      log('warn', 'Vault search module failed', { error: String(err) });
      return null;
    }
  },
};

export default vaultSearchModule;

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'context.vault-search', ts: new Date().toISOString(), ...extra }));
}
