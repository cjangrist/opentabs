import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shapes for the ChatGPT-specific tools that sit OUTSIDE the SPEC.md surface
// (memories, prompt library, GPT store, account profile). The normalized
// conversation / message / model / project shapes live in
// `normalized-schemas.ts` and must not be duplicated here.
// ---------------------------------------------------------------------------

/**
 * Coerces the several timestamp shapes the ChatGPT backend uses into an ISO 8601
 * string. Returns '' rather than throwing on unparseable input —
 * `new Date(NaN).toISOString()` raises "Invalid time value", which previously
 * took down get_memories when /memories switched updated_at to a date string.
 */
export const toIsoTimestamp = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    const milliseconds = Math.abs(value) > 1e11 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return toIsoTimestamp(Number(trimmed));
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  return '';
};

// --- User ---

export const userSchema = z.object({
  id: z.string().describe('User ID'),
  email: z.string().describe('Email address'),
  name: z.string().describe('Display name'),
  picture: z.string().describe('Avatar URL'),
  country: z.string().describe('Country code'),
  created: z.string().describe('Account creation timestamp'),
});

interface RawUser {
  id?: string;
  email?: string;
  name?: string;
  picture?: string;
  country?: string;
  created?: number | string;
}

export const mapUser = (u: RawUser) => ({
  id: u.id ?? '',
  email: u.email ?? '',
  name: u.name ?? '',
  picture: u.picture ?? '',
  country: u.country ?? '',
  created: toIsoTimestamp(u.created),
});

// --- Memory ---

export const memorySchema = z.object({
  id: z.string().describe('Memory ID'),
  content: z.string().describe('Memory content text'),
  status: z.string().describe('Memory status (e.g. "warm"), empty if not reported'),
  conversation_id: z.string().describe('Conversation the memory was learned from, empty if unknown'),
  created_at: z.string().describe('Created ISO 8601 timestamp, empty if not reported'),
  updated_at: z.string().describe('Updated ISO 8601 timestamp, empty if not reported'),
});

interface RawMemory {
  id?: string;
  content?: string;
  status?: string | null;
  conversation_id?: string | null;
  /** Legacy epoch-seconds fields. */
  created_at?: number | string | null;
  /** Current field names — `updated_at` is now a "YYYY-MM-DD" string, not epoch seconds. */
  created_timestamp?: number | string | null;
  updated_at?: number | string | null;
  last_updated?: number | string | null;
}

export const mapMemory = (m: RawMemory) => ({
  id: m.id ?? '',
  content: m.content ?? '',
  status: m.status ?? '',
  conversation_id: m.conversation_id ?? '',
  created_at: toIsoTimestamp(m.created_timestamp ?? m.created_at),
  updated_at: toIsoTimestamp(m.updated_at ?? m.last_updated),
});

// --- GPT (Gizmo) ---

export const gptSchema = z.object({
  id: z.string().describe('GPT ID'),
  name: z.string().describe('GPT display name'),
  description: z.string().describe('GPT description'),
  short_url: z.string().describe('Short URL for the GPT'),
  author_name: z.string().describe('Author display name'),
  num_interactions: z.number().describe('Number of interactions/conversations'),
  tags: z.array(z.string()).describe('GPT tags'),
  created_at: z.string().describe('Created ISO 8601 timestamp'),
  updated_at: z.string().describe('Updated ISO 8601 timestamp'),
});

interface RawGpt {
  id?: string;
  display?: { name?: string; description?: string };
  short_url?: string;
  author?: { display_name?: string };
  num_interactions?: number;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

export const mapGpt = (g: RawGpt) => ({
  id: g.id ?? '',
  name: g.display?.name ?? '',
  description: g.display?.description ?? '',
  short_url: g.short_url ?? '',
  author_name: g.author?.display_name ?? '',
  num_interactions: g.num_interactions ?? 0,
  tags: g.tags ?? [],
  created_at: g.created_at ?? '',
  updated_at: g.updated_at ?? '',
});

// --- Prompt Library Item ---

export const promptSchema = z.object({
  id: z.string().describe('Prompt ID'),
  title: z.string().describe('Prompt title'),
  description: z.string().describe('Prompt description'),
  prompt: z.string().describe('Prompt text template'),
  category: z.string().describe('Prompt category'),
});

interface RawPrompt {
  id?: string;
  title?: string;
  description?: string;
  prompt?: string;
  category?: string;
}

export const mapPrompt = (p: RawPrompt) => ({
  id: p.id ?? '',
  title: p.title ?? '',
  description: p.description ?? '',
  prompt: p.prompt ?? '',
  category: p.category ?? '',
});
