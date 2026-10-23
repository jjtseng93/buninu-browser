// Command line: Ctrl+E turns the address bar into a "cmd> " prompt.
// Each command maps to an action in input.js; `help` lists them.

export const COMMANDS = [
  { name: 'open', aliases: ['o', 'go'], usage: 'open <url|query>', help: 'Open a URL or search' },
  { name: 'back', aliases: ['b'], usage: 'back', help: 'Go back' },
  { name: 'forward', aliases: ['f'], usage: 'forward', help: 'Go forward' },
  { name: 'reload', aliases: ['r'], usage: 'reload', help: 'Reload the page' },
  { name: 'home', aliases: [], usage: 'home', help: 'Open the home page' },
  { name: 'bookmark', aliases: ['bm'], usage: 'bookmark [query]', help: 'Open the first matching bookmark' },
  { name: 'links', aliases: ['hints', 'l'], usage: 'links', help: 'Hint mode: pick a link to click' },
  { name: 'copy', aliases: ['c'], usage: 'copy', help: 'Copy the selected text' },
  { name: 'copyurl', aliases: ['yank', 'y'], usage: 'copyurl', help: 'Copy the page URL' },
  { name: 'paste', aliases: ['p'], usage: 'paste', help: 'Paste the clipboard into the page' },
  { name: 'pasteurl', aliases: ['pu'], usage: 'pasteurl', help: 'Put the clipboard into the address bar to edit or send' },
  { name: 'download', aliases: ['dl', 'save'], usage: 'download', help: 'Save the page as the browser received it to the Downloads folder' },
  { name: 'find', aliases: ['/'], usage: 'find [text] (or /text)', help: 'Find text in the page; again for the next match' },
  { name: 'eruda', aliases: ['devtools'], usage: 'eruda', help: 'Show or hide the eruda console in the page (loaded from a CDN)' },
  { name: 'zoom', aliases: ['z'], usage: 'zoom [n|n%|+|-|reset]', help: 'Show or set the zoom (1 = automatic)' },
  { name: 'cdp', aliases: [], usage: 'cdp [ws]', help: 'Show CDP address, state and engine; ws shows the full WebSocket URL' },
  { name: 'kitty', aliases: [], usage: 'kitty [inline|file]', help: 'Show image transport and capture format, or switch transport' },
  { name: 'pixelmouse', aliases: [], usage: 'pixelmouse [on|off]', help: 'Query and enable pixel mouse, or use cell coordinates' },
  { name: 'help', aliases: ['?', 'h'], usage: 'help', help: 'List commands' },
  { name: 'quit', aliases: ['q', 'exit'], usage: 'quit', help: 'Quit casty' },
];

const BY_NAME = new Map(COMMANDS.flatMap(c => [[c.name, c], ...c.aliases.map(a => [a, c])]));

// "zoom 1.5" → { name: 'zoom', arg: '1.5' }; "/text" finds; unknown → { error }
export function parseCommand(line) {
  const text = line.trim();
  if (text.startsWith('/')) return { name: 'find', arg: text.slice(1).trim() };
  const m = text.match(/^(\S+)\s*(.*)$/);
  if (!m) return { error: 'Empty command' };
  const command = BY_NAME.get(m[1].toLowerCase());
  if (!command) return { error: `Unknown command: ${m[1]} (try help)` };
  return { name: command.name, arg: m[2] };
}

// One-line command summary for the status bar
export function helpText() {
  return COMMANDS.map(c => c.usage).join(' · ');
}

// Browser-style zoom steps for "zoom +" / "zoom -"
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS.at(-1);

// New zoom factor for a "zoom" argument, or null if it is not one.
// "1.5" and "150%" are absolute; "+"/"-" step; "reset" (or "0") goes back to 1.
export function parseZoom(arg, current = 1) {
  const text = arg.trim().toLowerCase();
  if (text === 'reset' || text === '0') return 1;
  if (text === '+' || text === 'in') return ZOOM_STEPS.find(s => s > current + 1e-9) ?? MAX_ZOOM;
  if (text === '-' || text === 'out') return ZOOM_STEPS.findLast(s => s < current - 1e-9) ?? MIN_ZOOM;
  const m = text.match(/^(\d+(?:\.\d+)?|\.\d+)(%?)$/);
  if (!m) return null;
  const value = Number(m[1]) / (m[2] ? 100 : 1);
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}
