const SYMBOLS: Array<[RegExp, string]> = [
  [/\s*&\s*/g, " and "],
  [/\s*->\s*|\s*=>\s*|\s*→\s*/g, " to "],
  [/\s+@\s+/g, " at "],
  [/(\d)\s*%/g, "$1 percent"],
  [/\be\.g\.\s*/gi, "for example, "],
  [/\bi\.e\.\s*/gi, "that is, "],
  [/\betc\./gi, "etcetera"],
  [/\bvs\.?\s/gi, "versus "],
  [/\bPR\b/g, "P R"],
  [/\bPRs\b/g, "P Rs"],
  [/\bCI\b/g, "C I"],
  [/\bAPI\b/g, "A P I"],
  [/\bAPIs\b/g, "A P Is"],
  [/\bUI\b/g, "U I"],
  [/\bMCP\b/g, "M C P"],
  [/\bTTS\b/g, "T T S"],
  [/\bJSON\b/g, "Jason"],
  [/\bSQL\b/g, "sequel"],
  [/\bnpm\b/g, "N P M"],
];

export function cleanForSpeech(input: string): string {
  let text = input;
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/`([^`]*)`/g, (_m, inner: string) => describeInlineCode(inner));
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(LINK, "the link");
  text = text.replace(ABSOLUTE_PATH, "the file");
  text = text.replace(RELATIVE_PATH, "the file");
  text = text.replace(FILE_NAME, "the file");
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s*>\s?/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");
  text = text.replace(/\|/g, " ");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(?<!\w)(\*|_)(?!\s)(.+?)(?<!\s)\1(?!\w)/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");
  for (const [pattern, replacement] of SYMBOLS) text = text.replace(pattern, replacement);
  text = text.replace(/[*_#`~^{}[\]<>]/g, " ");
  text = text.replace(/\bthe file(?:(?:\s*,\s*|\s*,?\s+and\s+)the file)+/g, "the files");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\s*\n\s*/g, "\n");
  return text.trim();
}

const LINK = /https?:\/\/\S+/g;
const ABSOLUTE_PATH = /(?<![\w.-])(?:~|\.{1,2})?(?:\/[\w.@-]*[\w@-]){2,}\/?(?::\d+)?/g;
const RELATIVE_PATH = /\b[\w.-]+(?:\/[\w.@-]*[\w@-]){2,}\/?(?::\d+)?/g;
const FILE_NAME = /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|swift|kt|java|go|rs|rb|yml|yaml|toml|css|html|sh|txt|lock|xml|plist|gradle)(?::\d+(?::\d+)?)?\b/g;

function describeInlineCode(inner: string): string {
  const trimmed = inner.trim();
  if (new RegExp(LINK.source).test(trimmed)) return "the link";
  if (new RegExp(`^(?:${ABSOLUTE_PATH.source}|${RELATIVE_PATH.source}|${FILE_NAME.source}|[\\w.-]+\\/[\\w./-]*)$`).test(trimmed)) return "the file";
  if (/[(){};=<>\\]|^\s*\$|\w\.\w+\(/.test(trimmed) || trimmed.length > 40) return "the code";
  return trimmed;
}

export function splitSentences(text: string): string[] {
  const parts: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const matches = trimmed.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g) ?? [trimmed];
    for (const raw of matches) {
      const sentence = raw.trim();
      if (sentence) parts.push(sentence);
    }
  }
  return mergeShort(parts.flatMap(splitLong));
}

function splitLong(sentence: string): string[] {
  if (sentence.length <= 220) return [sentence];
  const out: string[] = [];
  let current = "";
  for (const piece of sentence.split(/(?<=[,;:—])\s+/)) {
    if ((current + " " + piece).trim().length > 220 && current) {
      out.push(current.trim());
      current = piece;
    } else {
      current = (current + " " + piece).trim();
    }
  }
  if (current) out.push(current.trim());
  return out;
}

function mergeShort(parts: string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    const previous = out[out.length - 1];
    if (previous !== undefined && out.length > 1 && previous.length < 12) {
      out[out.length - 1] = `${previous} ${part}`;
    } else {
      out.push(part);
    }
  }
  return out;
}
