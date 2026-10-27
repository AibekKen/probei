import OpenAI from 'openai';
import { getLLMConfig, type LLMConfig } from './config.js';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;
type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

let cachedConfig: LLMConfig | null = null;
let cachedClient: OpenAI | null = null;

export function llmInfo(): LLMConfig {
  if (!cachedConfig) cachedConfig = getLLMConfig();
  return cachedConfig;
}

function client(): OpenAI {
  if (!cachedClient) {
    const c = llmInfo();
    // Both Meta Model API and Baseten speak the OpenAI Chat Completions format.
    cachedClient = new OpenAI({ baseURL: c.baseURL, apiKey: c.apiKey });
  }
  return cachedClient;
}

/** Muse Spark Open always reasons; drop reasoning blocks if they come inside the content. */
function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** Returns every top-level balanced {...} block in the text, in order. */
function topLevelObjects(text: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) break;
    found.push(text.slice(start, end + 1));
    i = end + 1;
  }
  return found;
}

/** Pulls the agent's JSON answer out of a model reply (last valid top-level object wins). */
export function extractJson(text: string): unknown {
  const cleaned = stripReasoning(text);
  const candidates = topLevelObjects(cleaned).reverse();
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next one
    }
  }
  throw new Error('Model reply contains no valid JSON object');
}

/** Sends text (and optionally one PNG screenshot) and expects a JSON object back. Retries once. */
export async function askJSON(
  system: string,
  text: string,
  imagePng?: Buffer,
): Promise<{ data: unknown; raw: string; usage: Usage }> {
  const c = llmInfo();
  const content: ContentPart[] = [{ type: 'text', text }];
  if (imagePng) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${imagePng.toString('base64')}` },
    });
  }
  const messages: Message[] = [
    { role: 'system', content: system },
    { role: 'user', content },
  ];

  const usage: Usage = { promptTokens: 0, completionTokens: 0 };
  let lastRaw = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await client().chat.completions.create({
      model: c.model,
      messages,
      max_tokens: c.maxTokens,
    });
    usage.promptTokens += res.usage?.prompt_tokens ?? 0;
    usage.completionTokens += res.usage?.completion_tokens ?? 0;
    lastRaw = res.choices[0]?.message?.content ?? '';
    try {
      return { data: extractJson(lastRaw), raw: lastRaw, usage };
    } catch {
      messages.push({ role: 'assistant', content: lastRaw });
      messages.push({
        role: 'user',
        content: 'Your reply did not contain a valid JSON object. Reply again with ONLY the JSON object.',
      });
    }
  }
  throw new Error(`Model did not return valid JSON after a retry. Last reply: ${lastRaw.slice(0, 300)}`);
}
