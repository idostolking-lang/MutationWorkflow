import { type QuestionDecision, QuestionDecisionSchema } from '@mutationworkflow/core';
import { Argument, type Command } from 'commander';
import type { Cli } from '../context.js';
import { formatFindings, formatQuestions, formatWorkflows } from '../format.js';

export function registerQuestions(program: Command, cli: Cli): void {
  program
    .command('questions')
    .description('Questions the agents raised for the team (open ones by default)')
    .option('--all', 'include answered questions')
    .option('--json', 'print JSON')
    .action((options: { all?: boolean; json?: boolean }) =>
      cli.withEngine(async (engine) => {
        const questions = await engine.store.questions.list(options.all ? {} : { status: 'open' });
        if (options.json) cli.output.json(questions);
        else cli.output.out(formatQuestions(questions));
      }),
    );

  program
    .command('answer')
    .description('Answer a question: confirm the behaviour, report it as a bug, or dismiss it')
    .argument('<id>', 'question id')
    .addArgument(
      new Argument('<decision>', 'confirm, bug or dismiss').choices(QuestionDecisionSchema.options),
    )
    .option('--note <text>', 'your answer, kept with the question')
    .action((id: string, decision: QuestionDecision, options: { note?: string }) =>
      cli.withEngine(async (engine) => {
        const result = await engine.answerQuestion(id, decision, options.note);
        cli.output.out(`Answered ${result.question.id}: ${decision}`);
        if (result.workflow) cli.output.out(formatWorkflows([result.workflow]));
        if (result.finding) cli.output.out(formatFindings([result.finding]));
      }),
    );
}
