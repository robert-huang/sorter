import type { KeyboardEvent } from 'react';

/**
 * JS-style comments for tool query textareas, so saved queries can be kept
 * without being run. Comments are whole-line only, because real titles
 * contain the markers mid-line (`.hack//Sign`, `Fate/stay night`):
 *  - a line whose first non-space characters are `//` is skipped;
 *  - a line starting with `/*` opens a block that runs through the first
 *    line ending with `*\/` (the same line for `/* Heat *\/`). An unclosed
 *    block runs to the end of the text, like JS.
 */
export const TOOL_COMMENT_HINT = '// or /* */ lines are skipped (Ctrl/⌘+/ toggles)';

export interface ToolTextLines {
  /** Lines that are not commented out, in order. */
  live: string[];
  /** Commented lines verbatim (markers included), in order. */
  comments: string[];
}

export function splitToolComments(text: string): ToolTextLines {
  const live: string[] = [];
  const comments: string[] = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (inBlock || trimmed.startsWith('/*')) {
      comments.push(line);
      // On the opening line the `*/` must not reuse the opener's `*` (`/*/` stays open).
      const closes: boolean = trimmed.endsWith('*/') && (inBlock || trimmed.length >= 4);
      inBlock = !closes;
      continue;
    }
    if (trimmed.startsWith('//')) comments.push(line);
    else live.push(line);
  }
  return { live, comments };
}

/** The text with every commented line removed. */
export function stripToolComments(text: string): string {
  return splitToolComments(text).live.join('\n');
}

/** Only the commented lines; what's left in the textarea after its queries are staged. */
export function toolCommentsOnly(text: string): string {
  return splitToolComments(text).comments.join('\n');
}

/** Puts comment lines back under a rewritten list of queries. */
export function withToolComments(queriesText: string, originalText: string): string {
  const comments = toolCommentsOnly(originalText);
  if (!comments) return queriesText;
  return queriesText ? `${queriesText}\n${comments}` : comments;
}

const LINE_COMMENT = /^(\s*)\/\/ ?/;

/**
 * Toggles `// ` on every line touched by the selection, like an editor's
 * Ctrl/⌘+/. Uncomments only when every non-blank line is already commented.
 * Returns the replaced line range and the selection to restore.
 */
export function toggleLineComments(
  text: string,
  selectionStart: number,
  selectionEnd: number,
): { from: number; to: number; replacement: string; selectionStart: number; selectionEnd: number } {
  const from = text.lastIndexOf('\n', selectionStart - 1) + 1;
  // A selection ending at the start of a line doesn't touch that line.
  const endProbe =
    selectionEnd > selectionStart && text[selectionEnd - 1] === '\n'
      ? selectionEnd - 1
      : selectionEnd;
  const lineEnd = text.indexOf('\n', endProbe);
  const to = lineEnd === -1 ? text.length : lineEnd;
  const lines = text.slice(from, to).split('\n');
  const filled = lines.filter((line) => line.trim() !== '');
  const uncomment = filled.length > 0 && filled.every((line) => LINE_COMMENT.test(line));

  const next = lines.map((line) => {
    if (uncomment) return line.replace(LINE_COMMENT, '$1');
    if (line.trim() === '' && lines.length > 1) return line;
    const indent = line.match(/^\s*/)?.[0] ?? '';
    return `${indent}// ${line.slice(indent.length)}`;
  });
  const replacement = next.join('\n');
  const firstShift = next[0]!.length - lines[0]!.length;
  const totalShift = replacement.length - (to - from);
  // The caret moves with its text but never back past the start of its line.
  const moved = (pos: number, shift: number): number => Math.max(from, pos + shift);
  // A selection that starts at the line start keeps covering the whole first line.
  const keepLineStart = selectionStart === from && selectionEnd > selectionStart;
  return {
    from,
    to,
    replacement,
    selectionStart: keepLineStart ? from : moved(selectionStart, firstShift),
    selectionEnd: moved(selectionEnd, selectionStart === selectionEnd ? firstShift : totalShift),
  };
}

function isToggleCommentKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return modifier && !event.altKey && (event.key === '/' || event.code === 'Slash');
}

/**
 * onKeyDown for a controlled textarea: Ctrl/⌘+/ toggles line comments.
 * Goes through `insertText` when the browser supports it so native undo
 * still works; otherwise writes the new value through `onChange`.
 */
export function handleToolCommentShortcut(
  event: KeyboardEvent<HTMLTextAreaElement>,
  onChange: (value: string) => void,
): void {
  if (!isToggleCommentKey(event)) return;
  event.preventDefault();
  const el = event.currentTarget;
  const edit = toggleLineComments(el.value, el.selectionStart, el.selectionEnd);
  el.setSelectionRange(edit.from, edit.to);
  const inserted =
    typeof document.execCommand === 'function' &&
    document.execCommand('insertText', false, edit.replacement);
  if (!inserted) {
    const value = el.value.slice(0, edit.from) + edit.replacement + el.value.slice(edit.to);
    onChange(value);
    requestAnimationFrame(() => el.setSelectionRange(edit.selectionStart, edit.selectionEnd));
    return;
  }
  el.setSelectionRange(edit.selectionStart, edit.selectionEnd);
}
