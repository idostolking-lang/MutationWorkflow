import type {
  Action,
  Adapter,
  AdapterDescription,
  AdapterFactoryOptions,
  AdapterSession,
  Assertion,
  Logger,
  SessionOptions,
} from '@mutationworkflow/core';
import { MutationWorkflowError } from '@mutationworkflow/core';
import { ACTION_EXAMPLES, CliActionSchemas } from './actions.js';
import { ASSERTION_EXAMPLES, CliAssertionSchemas } from './assertions.js';
import { parseCliOptions, type ResolvedCliOptions } from './options.js';
import { CliSession } from './session.js';
import { parseByType, specsOf } from './vocabulary.js';

/**
 * Drives a command-line application through stdin and stdout pipes. Each session runs at most
 * one process at a time and records a transcript of everything it printed.
 */
export class CliAdapter implements Adapter {
  readonly kind = 'cli';
  readonly options: ResolvedCliOptions;
  private readonly logger: Logger;
  private readonly sessions = new Set<CliSession>();

  constructor({ target, rootDir, logger }: AdapterFactoryOptions) {
    this.options = parseCliOptions(target.id, target.options, rootDir);
    this.logger = logger.child('cli');
  }

  describe(): AdapterDescription {
    return describeCliAdapter(this.options);
  }

  validateAction(action: Action): Action {
    const parsed = parseByType(CliActionSchemas, 'action', action);
    if (parsed.type === 'wait' && parsed.prompt && this.options.promptPattern === undefined) {
      throw new MutationWorkflowError(
        'INVALID_INPUT',
        'wait.prompt needs the target option promptPattern; wait for output instead',
      );
    }
    return parsed;
  }

  validateAssertion(assertion: Assertion): Assertion {
    return parseByType(CliAssertionSchemas, 'assertion', assertion);
  }

  async open(options: SessionOptions): Promise<AdapterSession> {
    const session: CliSession = new CliSession(this.options, options, () =>
      this.sessions.delete(session),
    );
    this.sessions.add(session);
    this.logger.debug('Opened session', { sessionId: options.sessionId });
    return session;
  }

  /** Close every open session, killing processes that are still running. */
  async dispose(): Promise<void> {
    await Promise.all([...this.sessions].map((session) => session.close()));
  }
}

/** Adapter factory: `kind: "cli"` targets load this. */
export function createAdapter(options: AdapterFactoryOptions): CliAdapter {
  return new CliAdapter(options);
}

/**
 * The CLI vocabulary. Works without a target (for setup flows) and matches `adapter.describe()`
 * once a target is known; the guide adapts to whether a prompt pattern is configured.
 */
export function describeCliAdapter(
  options?: Pick<ResolvedCliOptions, 'command' | 'promptPattern'>,
): AdapterDescription {
  const command = options?.command;
  return {
    kind: 'cli',
    summary: command
      ? `Runs \`${command}\` and interacts with it through stdin, stdout and stderr (pipes, no terminal).`
      : 'Runs a command-line application and interacts with it through stdin, stdout and stderr (pipes, no terminal).',
    actions: specsOf(CliActionSchemas, ACTION_EXAMPLES),
    assertions: specsOf(CliAssertionSchemas, ASSERTION_EXAMPLES),
    hints: {
      anchorActionTypes: ['start', 'exec'],
      inputActions: [{ type: 'write', field: 'text' }],
      interruptSequences: [[{ type: 'signal', signal: 'SIGINT' }]],
      waitAction: { type: 'wait', field: 'ms' },
    },
    guide: guide(options?.promptPattern !== undefined),
  };
}

function guide(hasPromptPattern: boolean): string {
  const waitHint = hasPromptPattern
    ? 'After `start` and after every `write`, add `wait {prompt: true}` so the next step only runs once the application asks for input.'
    : 'Without a promptPattern on the target, after `start` and after every `write` add `wait {output: "<regex>"}` for the response you expect before the next step.';
  return [
    'Interactive applications begin with `start`; one-shot commands use `exec {args}` and are judged with `exit-code` and `output-matches`.',
    waitHint,
    'Observations show the transcript: stdout verbatim, stderr lines prefixed with "[stderr]", and "──" marker lines for steps and process starts and exits. Read it to see what the application answered.',
    'An action is `blocked` when the application did not accept it: the process was not running, it stopped reading input, or the expected output never appeared before the timeout.',
    'Input is not echoed, so an answer can share a line with the prompt that preceded it ("> 5"): anchor patterns at the end of the line or on word boundaries (for example "\\b5$") rather than with "^".',
    'Prefer `output-matches` with `since: "step"` so an assertion checks the answer to this step rather than earlier output.',
  ].join(' ');
}
