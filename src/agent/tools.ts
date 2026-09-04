/**
 * Page tools the graph depends on.
 *
 * Nothing in `src/agent` may import `chrome.*`. The graph talks to the page only
 * through the {@link PageTools} port; the service worker supplies the real
 * implementation and tests supply {@link FakePageTools}.
 *
 * Every tool is a LangChain `tool()` with a zod schema (C-02: the framework's own
 * tool-calling machinery, not a hand-rolled dispatcher). Descriptions are written
 * for small free models: one imperative sentence, then the argument contract.
 *
 * `navigate` and `download` are Follower tools per O-05's assumption.
 */
import * as z from 'zod';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { FollowerSignal } from '@/src/messaging/contract';

/** Zod mirror of the contract's {@link FollowerSignal} (R-03, verbatim vocabulary). */
export const FollowerSignalSchema = z.enum([
  'CONTINUE',
  'SUBGOAL_COMPLETE',
  'RETURN_TO_LEADER',
  'BLOCKED',
]);

// Compile-time proof the mirror never drifts from the contract.
const _signalParity: FollowerSignal = 'CONTINUE' satisfies z.infer<typeof FollowerSignalSchema>;
void _signalParity;

export interface SnapshotResult {
  text: string;
  tokens?: number;
}

export interface ScreenshotResult {
  dataUrl: string;
  width: number;
  height: number;
}

/** Scroll target: a direction keyword or an element ref from the snapshot. */
export type ScrollTarget = 'up' | 'down' | 'top' | 'bottom' | (string & {});

/**
 * The page port. One method per capability the Follower can exercise.
 * Implementations live outside `src/agent`.
 */
export interface PageTools {
  snapshot(): Promise<SnapshotResult>;
  screenshot(): Promise<ScreenshotResult>;
  extractText(maxChars?: number, startChar?: number): Promise<string>;
  click(ref: string): Promise<string>;
  type(ref: string, text: string): Promise<string>;
  press(key: string): Promise<string>;
  scroll(target: ScrollTarget): Promise<string>;
  select(ref: string, value: string): Promise<string>;
  navigate(url: string): Promise<string>;
  download(target: string): Promise<string>;
  runUserscript(scriptId: string): Promise<string>;
  /**
   * Saves `content` (or, when `fromLastUserscript` is true, the full untruncated
   * result of the most recent `run_userscript` call) as a file. `content` has
   * already been normalised to a string by {@link createPageToolset} (an object arg
   * is JSON.stringify'd there); the runtime implementation owns where it lands.
   */
  saveFile(filename: string, content: string | undefined, fromLastUserscript: boolean): Promise<string>;
  wait(ms: number): Promise<string>;
  done(summary: string): Promise<string>;
  blocked(reason: string): Promise<string>;
}

/**
 * The control envelope carried on every Follower tool call.
 *
 * R-03 wants the Follower to return control on its own signal. The signal rides
 * on the arguments of the action the Follower is already taking, so one model
 * call yields both the action and the classification — no second LLM round trip.
 * Both fields are optional so a small model that omits them still produces a
 * valid call (absent signal means CONTINUE).
 */
const controlEnvelope = {
  signal: FollowerSignalSchema.optional().describe(
    'Your control state after this action. CONTINUE = keep working on the current subgoal. ' +
      'SUBGOAL_COMPLETE = this subgoal is finished. RETURN_TO_LEADER = you need a new plan. ' +
      'BLOCKED = you cannot proceed at all. Leave empty to mean CONTINUE.',
  ),
  note: z.string().optional().describe('One short sentence saying why. Max 20 words.'),
};

const refField = z
  .string()
  .describe('The element ref exactly as it appears in the page snapshot, e.g. "e12".');

/**
 * `save_file`'s filename contract, enforced here so a bad filename never reaches
 * either save mechanism (chrome.downloads and the host's artifact.save): basename
 * only, an allowed extension, no path separator, no "..", no leading dot, not too
 * long. Returns the problem, or `undefined` when the filename is fine.
 */
export function validateSaveFilename(filename: string): string | undefined {
  if (typeof filename !== 'string' || filename.length === 0) return 'filename must be a non-empty string';
  if (filename.length > 100) return 'filename must be at most 100 characters';
  if (filename.includes('/') || filename.includes('\\')) return 'filename must not contain a path separator';
  if (filename.includes('..')) return 'filename must not contain ".."';
  if (filename.startsWith('.')) return 'filename must not start with a dot';
  if (!/\.(json|txt|csv)$/i.test(filename)) return 'filename must end in .json, .txt, or .csv';
  return undefined;
}

/** Tool names the Follower may call. Kept as a const tuple so the graph can switch on it. */
export const TOOL_NAMES = [
  'snapshot',
  'screenshot',
  'extract_text',
  'click',
  'type',
  'press',
  'scroll',
  'select',
  'navigate',
  'download',
  'run_userscript',
  'save_file',
  'wait',
  'done',
  'blocked',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Tools whose call ends the run regardless of the reported signal. */
export const TERMINAL_TOOLS: Record<string, 'done' | 'blocked'> = {
  done: 'done',
  blocked: 'blocked',
};

export interface PageToolset {
  /** Every Follower tool, in the order the model sees them. */
  all: StructuredToolInterface[];
  byName: Map<string, StructuredToolInterface>;
}

/** Keeps a tool result short enough for the UI log (R-06) without echoing payloads. */
export function summarize(value: unknown, max = 240): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Builds the Follower toolset over a {@link PageTools} implementation.
 */
export function createPageToolset(page: PageTools): PageToolset {
  const all: StructuredToolInterface[] = [
    tool(
      async () => {
        const snap = await page.snapshot();
        return snap.text;
      },
      {
        name: 'snapshot',
        description:
          'Read the page as text with a ref for every element you can act on. ' +
          'Call this when you do not know what is on the page or after it changed.',
        schema: z.object({ ...controlEnvelope }),
      },
    ),
    tool(
      async () => {
        const shot = await page.screenshot();
        return `screenshot ${shot.width}x${shot.height}`;
      },
      {
        name: 'screenshot',
        description:
          'Take a picture of the visible page. Use only when the text snapshot is not enough.',
        schema: z.object({ ...controlEnvelope }),
      },
    ),
    tool(async ({ maxChars, startChar }) => page.extractText(maxChars, startChar), {
      name: 'extract_text',
      description:
        'Read the page as plain readable text instead of a structured snapshot. Use this for ' +
        'long lists or articles where you only need to read, not act on refs. Links become ' +
        '"text (href)".',
      schema: z.object({
        maxChars: z
          .number()
          .int()
          .min(1)
          .max(60_000)
          .optional()
          .describe('Character cap on the returned text. Default 20000, max 60000.'),
        startChar: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Start reading from this offset. When a reply ends "[truncated at N of M]", ' +
              'call again with startChar N to read the rest.',
          ),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ ref }) => page.click(ref), {
      name: 'click',
      description: 'Click one element. Give the ref from the snapshot, nothing else.',
      schema: z.object({ ref: refField, ...controlEnvelope }),
    }),
    tool(async ({ ref, text }) => page.type(ref, text), {
      name: 'type',
      description:
        'Type text into one field. Give the ref of the field and the exact text to enter. ' +
        'This replaces whatever is already in the field.',
      schema: z.object({
        ref: refField,
        text: z.string().describe('The literal text to enter.'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ key }) => page.press(key), {
      name: 'press',
      description:
        'Press one keyboard key, e.g. "Enter", "Tab", "Escape", "ArrowDown". One key per call.',
      schema: z.object({
        key: z.string().describe('A single key name such as "Enter".'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ target }) => page.scroll(target), {
      name: 'scroll',
      description:
        'Scroll the page. Give "up", "down", "top", "bottom", or an element ref to scroll it into view.',
      schema: z.object({
        target: z
          .string()
          .describe('"up", "down", "top", "bottom", or an element ref like "e12".'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ ref, value }) => page.select(ref, value), {
      name: 'select',
      description: 'Choose an option in a dropdown. Give the ref of the select and the option text.',
      schema: z.object({
        ref: refField,
        value: z.string().describe('The visible option text or its value.'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ url }) => page.navigate(url), {
      name: 'navigate',
      description:
        'Go to a URL in the tab the user already has open. Use a full URL starting with http.',
      schema: z.object({
        url: z.string().describe('Full URL, e.g. "https://example.com/search".'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ target }) => page.download(target), {
      name: 'download',
      description:
        'Download a file. Give a full URL, or the ref of the link or button that starts the download.',
      schema: z.object({
        target: z.string().describe('A full URL or an element ref like "e12".'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ scriptId }) => page.runUserscript(scriptId), {
      name: 'run_userscript',
      description: 'Run a saved userscript on this page by its id. Only ids you were given.',
      schema: z.object({
        scriptId: z.string().describe('The id of a saved userscript.'),
        ...controlEnvelope,
      }),
    }),
    tool(
      async ({ filename, content, fromLastUserscript }) => {
        const problem = validateSaveFilename(filename);
        if (problem) throw new Error(problem);
        if (!fromLastUserscript && content === undefined) {
          throw new Error('content is required unless fromLastUserscript is true');
        }
        const body =
          content === undefined ? undefined : typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        return page.saveFile(filename, body, fromLastUserscript ?? false);
      },
      {
        name: 'save_file',
        description:
          'Save data to a file in the user\'s Downloads/nanobrowser folder. Give it a filename ' +
          'ending .json, .txt or .csv and either content, or fromLastUserscript:true to save the ' +
          'full result of the most recent run_userscript call losslessly.',
        schema: z.object({
          filename: z
            .string()
            .describe('Basename only, ending .json, .txt or .csv, e.g. "ddr5-current.json".'),
          content: z
            // An array has to be here in its own right: the natural thing to save is a
            // list of extracted rows, and a bare `z.record` rejects one. A live run
            // failed every save with "Invalid input -> at content" for exactly that.
            .union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
            .optional()
            .describe('The data to save: text, or a JSON array or object, written as 2-space-indented JSON.'),
          fromLastUserscript: z
            .boolean()
            .optional()
            .describe('Save the full result of the last run_userscript call verbatim, ignoring content.'),
          ...controlEnvelope,
        }),
      },
    ),
    tool(async ({ ms }) => page.wait(ms), {
      name: 'wait',
      description:
        'Wait for the page to settle. Use only after an action that loads new content. Keep it short.',
      schema: z.object({
        ms: z.number().int().min(0).max(15000).describe('Milliseconds to wait, at most 15000.'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ summary }) => page.done(summary), {
      name: 'done',
      description:
        'The whole objective is finished. Say what was accomplished. This ends the run.',
      schema: z.object({
        summary: z.string().describe('What was accomplished, in one or two sentences.'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ reason }) => page.blocked(reason), {
      name: 'blocked',
      description:
        'You cannot go any further, e.g. a login wall or a missing element. Say why. This ends the run.',
      schema: z.object({
        reason: z.string().describe('Why you are stuck, in one sentence.'),
        ...controlEnvelope,
      }),
    }),
  ];

  return { all, byName: new Map(all.map((t) => [t.name, t])) };
}

/**
 * The Leader's only tool. Planning is expressed as a tool call rather than as
 * JSON-mode structured output because most of the free models in
 * `docs/research/models-and-grounding.md` advertise `tools` but not
 * `structured_outputs`.
 */
export const planTool = tool(
  async ({ plan }) => `plan recorded: ${summarize(plan, 80)}`,
  {
    name: 'set_plan',
    description:
      'Record the plan for the objective and pick the subgoal the follower should work on now. ' +
      'Always call this exactly once. Keep subgoals short and concrete.',
    schema: z.object({
      plan: z.string().describe('One short paragraph: how the objective will be achieved.'),
      subgoals: z
        .array(z.string())
        .min(1)
        .describe('Ordered list of short concrete subgoals, e.g. "open the search page".'),
      currentSubgoal: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Zero-based index into subgoals of the one to work on now.'),
    }),
  },
);

/* ------------------------------------------------------------------------- */
/* Test double                                                               */
/* ------------------------------------------------------------------------- */

export interface RecordedToolCall {
  name: keyof PageTools;
  args: unknown[];
}

export interface FakePageToolsInit {
  /** Snapshots handed out in order; the last one repeats once exhausted. */
  snapshots?: SnapshotResult[];
  /** Screenshots handed out in order; the last one repeats once exhausted. */
  screenshots?: ScreenshotResult[];
}

/** Records every call and returns scripted observations. Never touches a browser. */
export class FakePageTools implements PageTools {
  readonly calls: RecordedToolCall[] = [];

  #snapshots: SnapshotResult[];
  #screenshots: ScreenshotResult[];
  #snapshotIndex = 0;
  #screenshotIndex = 0;

  constructor(init: FakePageToolsInit = {}) {
    this.#snapshots = init.snapshots?.length
      ? init.snapshots
      : [{ text: 'page: [e1] link "Example"', tokens: 8 }];
    this.#screenshots = init.screenshots?.length
      ? init.screenshots
      : [{ dataUrl: 'data:image/png;base64,ZmFrZQ==', width: 1024, height: 768 }];
  }

  /** Names of the calls made, in order. Convenient for assertions. */
  get names(): string[] {
    return this.calls.map((c) => c.name);
  }

  #record(name: keyof PageTools, ...args: unknown[]): void {
    this.calls.push({ name, args });
  }

  #next<T>(list: T[], index: number): [T, number] {
    const item = list[Math.min(index, list.length - 1)] as T;
    return [item, index + 1];
  }

  async snapshot(): Promise<SnapshotResult> {
    this.#record('snapshot');
    const [item, next] = this.#next(this.#snapshots, this.#snapshotIndex);
    this.#snapshotIndex = next;
    return item;
  }

  async screenshot(): Promise<ScreenshotResult> {
    this.#record('screenshot');
    const [item, next] = this.#next(this.#screenshots, this.#screenshotIndex);
    this.#screenshotIndex = next;
    return item;
  }

  async extractText(maxChars?: number, startChar?: number): Promise<string> {
    this.#record('extractText', maxChars, startChar);
    return 'extracted text';
  }

  async click(ref: string): Promise<string> {
    this.#record('click', ref);
    return `clicked ${ref}`;
  }

  async type(ref: string, text: string): Promise<string> {
    this.#record('type', ref, text);
    return `typed into ${ref}`;
  }

  async press(key: string): Promise<string> {
    this.#record('press', key);
    return `pressed ${key}`;
  }

  async scroll(target: ScrollTarget): Promise<string> {
    this.#record('scroll', target);
    return `scrolled ${target}`;
  }

  async select(ref: string, value: string): Promise<string> {
    this.#record('select', ref, value);
    return `selected ${value} in ${ref}`;
  }

  async navigate(url: string): Promise<string> {
    this.#record('navigate', url);
    return `navigated to ${url}`;
  }

  async download(target: string): Promise<string> {
    this.#record('download', target);
    return `downloaded ${target}`;
  }

  async runUserscript(scriptId: string): Promise<string> {
    this.#record('runUserscript', scriptId);
    return `ran userscript ${scriptId}`;
  }

  async saveFile(filename: string, content: string | undefined, fromLastUserscript: boolean): Promise<string> {
    this.#record('saveFile', filename, content, fromLastUserscript);
    return `saved ${filename}`;
  }

  async wait(ms: number): Promise<string> {
    this.#record('wait', ms);
    return `waited ${ms}ms`;
  }

  async done(summary: string): Promise<string> {
    this.#record('done', summary);
    return summary;
  }

  async blocked(reason: string): Promise<string> {
    this.#record('blocked', reason);
    return reason;
  }
}
