// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. It reads four patch formats (unified diff, SEARCH/REPLACE,
// V4A, JSON edits), applies them to a tree of text files, and changes every file or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old path, new path] pairs, in the order the edits made them. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 3: a file's lines, its line break, and whether it ends with one.
// ---------------------------------------------------------------------------

interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** 0-based positions where O occurs in `lines` at `tier`, starting at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (tierKey(lines[i + j]!, tier) !== tierKey(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (from `from`), with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } {
  for (const tier of tiers(strict)) {
    const positions = occurrences(lines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return { tier: 0, positions: [] };
}

/**
 * One line of N: a context line is written as the file's own matched line (oIdx is its index
 * into O); any other line is written as the patch wrote it, re-indented at tier 2.
 */
interface NLine {
  text: string;
  oIdx: number; // -1 when not a context line
}

function buildReplacement(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const reindent = tier === 2 && o.length > 0;
  const p = reindent ? leadingWs(o[0]!) : '';
  const f = reindent ? leadingWs(fileLines[pos] ?? '') : '';
  const out: string[] = [];
  for (const line of n) {
    if (line.oIdx >= 0) {
      out.push(fileLines[pos + line.oIdx]!);
    } else if (reindent && line.text !== '' && line.text.trim() !== '' && line.text.startsWith(p)) {
      out.push(f + line.text.slice(p.length));
    } else {
      out.push(line.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

type BodyKind = 'ctx' | 'old' | 'new' | 'bslash';
interface BodyLine {
  kind: BodyKind;
  text: string;
  /** A `\` line follows this body line. */
  noNl: boolean;
}

interface Hunk {
  /** Old start line (1-based) from the header; B and D are not used. */
  a: number;
  body: BodyLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  lastCtxPlusNoNl: boolean;
  /** A `\` line follows the hunk's last `+` line, or null when it has no `+` line. */
  lastPlusNoNl: boolean | null;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
  /** A `---`/`+++` pair named the paths, so `rename from`/`rename to` do not. */
  hadPair: boolean;
  renOld?: string;
  renNew?: string;
}

/** A path as a `---`/`+++` line writes it: after the four characters, up to the first tab, trimmed. */
function dashPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/;
const DIFF_GIT_RE = /^diff --git a\/([^ ]+) b\/([^ ]+)$/;

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, newFile: false, deletedFile: false, hunks: [], hadPair: false };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = dashPath(line);
      const newP = dashPath(lines[i + 1]!);
      if (cur !== null && inHeader) {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.hadPair = true;
      } else {
        cur = { oldPath: oldP, newPath: newP, newFile: false, deletedFile: false, hunks: [], hadPair: true };
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const hunk: Hunk = { a: Number(m[1]), body: [], lastCtxPlusNoNl: false, lastPlusNoNl: null };
      cur.hunks.push(hunk);
      i += 1;
      // The body: lines starting with ` `, `-`, `+` or `\`, or empty lines. It ends at the
      // first other line, at a `diff --git ` line, or at a `--- ` line followed by a `+++ ` line.
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('diff --git ')) break;
        if (b === '') {
          hunk.body.push({ kind: 'ctx', text: '', noNl: false });
          i += 1;
          continue;
        }
        if (b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          hunk.body.push({ kind: b[0] === ' ' ? 'ctx' : b[0] === '-' ? 'old' : 'new', text: b.slice(1), noNl: false });
          i += 1;
          continue;
        }
        if (b[0] === '\\') {
          const prev = hunk.body[hunk.body.length - 1];
          if (prev !== undefined && prev.kind !== 'bslash') prev.noNl = true;
          hunk.body.push({ kind: 'bslash', text: b.slice(1), noNl: false });
          i += 1;
          continue;
        }
        break;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      // Whether a `\` line follows the hunk's last context or `+` line, and its last `+` line.
      for (let k = hunk.body.length - 1; k >= 0; k -= 1) {
        const e = hunk.body[k]!;
        if (e.kind === 'ctx' || e.kind === 'new') {
          hunk.lastCtxPlusNoNl = e.noNl;
          break;
        }
      }
      for (let k = hunk.body.length - 1; k >= 0; k -= 1) {
        const e = hunk.body[k]!;
        if (e.kind === 'new') {
          hunk.lastPlusNoNl = e.noNl;
          break;
        }
      }
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) {
        cur.renOld = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        cur.renNew = line.slice('rename to '.length).trim();
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.newFile = true;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.deletedFile = true;
      }
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`,
      // `Index:` and any other line are ignored.
      i += 1;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  // `rename from`/`rename to` name the paths only when no `---`/`+++` pair does.
  for (const s of sections) {
    if (!s.hadPair) {
      if (s.renOld !== undefined) s.oldPath = s.renOld;
      if (s.renNew !== undefined) s.newPath = s.renNew;
    }
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function hunkON(h: Hunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const e of h.body) {
    if (e.kind === 'ctx') {
      o.push(e.text);
      n.push({ text: e.text, oIdx: o.length - 1 });
    } else if (e.kind === 'old') {
      o.push(e.text);
    } else if (e.kind === 'new') {
      n.push({ text: e.text, oIdx: -1 });
    }
  }
  return { o, n };
}

function applyHunks(content: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(content);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h);
    if (o.length === 0) {
      const idx = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const atEnd = idx === f.lines.length;
      const repl = buildReplacement(f.lines, idx, o, n, 0);
      f.lines.splice(idx, 0, ...repl);
      if (atEnd) f.final = !h.lastCtxPlusNoNl;
      d += n.length;
      continue;
    }
    const { tier, positions } = findTier(f.lines, o, strict);
    if (positions.length === 0) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of positions) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const atEnd = best + o.length === f.lines.length;
    const repl = buildReplacement(f.lines, best, o, n, tier);
    f.lines.splice(best, o.length, ...repl);
    if (atEnd) f.final = !h.lastCtxPlusNoNl;
    d += n.length - o.length;
  }
  return joinFile(f);
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.newFile;
    if (isCreate) {
      if (newP === null) return; // `--- /dev/null` and `+++ /dev/null`: nothing to create.
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const e of h.body) if (e.kind === 'new') plus.push(e.text);
      }
      let noNl = false;
      for (let k = sec.hunks.length - 1; k >= 0; k -= 1) {
        const v = sec.hunks[k]!.lastPlusNoNl;
        if (v !== null) {
          noNl = v;
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (newP === null || sec.deletedFile) {
      // Deletion: the old path exists, it is deleted, and its hunks are not read.
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      tree.now.set(oldP!, null);
      return;
    }
    if (oldP !== newP) {
      // Move: hunks apply to the old file's lines, the result is written at the new path.
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const out = applyHunks(tree.get(oldP!)!, sec.hunks, strict, oldP!);
      tree.now.set(oldP!, null);
      tree.now.set(newP!, out);
      tree.moves.push([oldP!, newP!]);
      return;
    }
    // Change of the one path.
    const before = tree.get(oldP!);
    if (before === null) throw new Fail('missing', oldP!);
    tree.now.set(oldP!, applyHunks(before, sec.hunks, strict, oldP!));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let j = searchLine + 1;
    for (; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (j = eq + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const { tier, positions } = findTier(f.lines, oldLines, strict);
    if (positions.length === 0) throw new Fail('no-match', path);
    if (positions.length > 1) throw new Fail('ambiguous', path);
    const n: NLine[] = newLines.map((text) => ({ text, oIdx: -1 }));
    const repl = buildReplacement(f.lines, positions[0]!, oldLines, n, tier);
    f.lines.splice(positions[0]!, oldLines.length, ...repl);
    tree.now.set(path, joinFile(f));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function v4aSectionStart(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (line.startsWith(V4A_ADD)) return { kind: 'add', path: line.slice(V4A_ADD.length).trim() };
  if (line.startsWith(V4A_DEL)) return { kind: 'delete', path: line.slice(V4A_DEL.length).trim() };
  if (line.startsWith(V4A_UPD)) return { kind: 'update', path: line.slice(V4A_UPD.length).trim() };
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const start = v4aSectionStart(lines[i]!);
    if (start === null) throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i + 1;
    i += 1;
    const secLines: Array<{ text: string; num: number }> = [];
    while (i < last) {
      if (v4aSectionStart(lines[i]!) !== null) break;
      secLines.push({ text: lines[i]!, num: i + 1 });
      i += 1;
    }
    // Blank lines at the end of a section are not part of it.
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    if (start.kind === 'add') {
      const fileLines: string[] = [];
      for (const l of secLines) {
        if (l.text === '') fileLines.push('');
        else if (l.text.startsWith('+')) fileLines.push(l.text.slice(1));
        else throw new Exit2(`error: parse ${l.num}`);
      }
      edits.push(v4aAddEdit(start.path, fileLines));
    } else if (start.kind === 'delete') {
      if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0]!.num}`);
      edits.push(v4aDeleteEdit(start.path));
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (secLines.length > 0 && secLines[0]!.text.startsWith(V4A_MOVE)) {
        moveTo = secLines[0]!.text.slice(V4A_MOVE.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunkPossible = true;
      for (; idx < secLines.length; idx += 1) {
        const { text, num } = secLines[idx]!;
        if (text.startsWith('@@')) {
          const anchor = text.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunks.push(cur);
          firstChunkPossible = false;
          continue;
        }
        if (text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${num}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
          if (cur === null) {
            if (!firstChunkPossible) throw new Exit2(`error: parse ${num}`);
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
            firstChunkPossible = false;
          }
          cur.body.push(text);
          continue;
        }
        throw new Exit2(`error: parse ${num}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      edits.push(v4aUpdateEdit(start.path, moveTo, chunks, strict));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aChunkON(body: string[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const line of body) {
    if (line === '' || line[0] === ' ') {
      const text = line === '' ? '' : line.slice(1);
      o.push(text);
      n.push({ text, oIdx: o.length - 1 });
    } else if (line[0] === '-') {
      o.push(line.slice(1));
    } else if (line[0] === '+') {
      n.push({ text: line.slice(1), oIdx: -1 });
    }
  }
  return { o, n };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const tier of tiers(strict)) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (tierKey(f.lines[k]!, tier) === tierKey(ch.anchor, tier)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const { o, n } = v4aChunkON(ch.body);
      if (o.length === 0) {
        const idx = ch.eof ? f.lines.length : cursor;
        const repl = buildReplacement(f.lines, idx, o, n, 0);
        f.lines.splice(idx, 0, ...repl);
        cursor = idx + repl.length;
        continue;
      }
      let positions: number[] = [];
      let tierUsed = 0;
      for (const tier of tiers(strict)) {
        const all = occurrences(f.lines, o, tier, cursor);
        const cand = ch.eof ? all.filter((p) => p + o.length === f.lines.length) : all;
        if (cand.length > 0) {
          positions = cand;
          tierUsed = tier;
          break;
        }
      }
      if (positions.length === 0) throw new Fail('no-match', path);
      const pos = positions[0]!;
      const repl = buildReplacement(f.lines, pos, o, n, tierUsed);
      f.lines.splice(pos, o.length, ...repl);
      cursor = pos + repl.length;
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: the command line, the output, and the all-or-nothing write.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const handled = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (
      tree.original(oldP) !== null &&
      tree.now.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.now.get(newP) !== null
    ) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      handled.add(oldP);
      handled.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (handled.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    // Deletions first, so a path freed by one edit can be created by another.
    for (const p of [...tree.now.keys()]) {
      if (tree.original(p) !== null && tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (now === null || was === now) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
