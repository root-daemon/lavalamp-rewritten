import type { RuntimeSubagentInspection } from '../runtime/types';

export function formatSubagentInspection(
  inspection: RuntimeSubagentInspection,
): string {
  const { subagent } = inspection;
  const metadata = [
    `Status: ${subagent.status}`,
    subagent.role === undefined ? undefined : `Role: ${subagent.role}`,
    subagent.model === undefined ? undefined : `Model: ${subagent.model}`,
  ].filter((line): line is string => line !== undefined);
  const transcript = inspection.messages
    .map((message) =>
      `## ${message.role === 'user' ? 'User' : 'Assistant'}\n\n${message.content}`,
    )
    .join('\n\n');
  return [
    `# ${subagent.name}`,
    metadata.join(' · '),
    `## Task\n\n${subagent.task || '(No task description)'}`,
    transcript || '## Transcript\n\n(No transcript available)',
  ].join('\n\n');
}
