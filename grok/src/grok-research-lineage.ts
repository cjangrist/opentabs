import { responseFileArtifacts, type RawResponse } from './grok-messages.js';
import { hasFileArtifactContinuationInstruction, hasFileArtifactInstruction } from './grok-research-prompt.js';

const isHuman = (response: RawResponse): boolean => response.sender?.toLowerCase() === 'human';

export const researchLineageResponses = (responses: RawResponse[]): RawResponse[] => {
  const acceptedHumanIds = new Set<string>();
  const acceptedAssistantIds = new Set<string>();
  let foundResearchPrompt = false;

  for (const response of responses) {
    if (!response.responseId) continue;
    if (isHuman(response)) {
      if (!foundResearchPrompt && hasFileArtifactInstruction(response.message ?? '')) {
        foundResearchPrompt = true;
        acceptedHumanIds.add(response.responseId);
      } else if (
        foundResearchPrompt &&
        response.parentResponseId &&
        acceptedAssistantIds.has(response.parentResponseId) &&
        hasFileArtifactContinuationInstruction(response.message ?? '')
      ) {
        acceptedHumanIds.add(response.responseId);
      }
    } else if (foundResearchPrompt && response.parentResponseId && acceptedHumanIds.has(response.parentResponseId)) {
      acceptedAssistantIds.add(response.responseId);
    }
  }

  return responses.filter(
    response =>
      Boolean(response.responseId) &&
      (acceptedHumanIds.has(response.responseId as string) || acceptedAssistantIds.has(response.responseId as string)),
  );
};

export const newerResearchArtifactResponse = (
  responses: RawResponse[],
  currentResponseId: string,
): RawResponse | null => {
  const lineage = researchLineageResponses(responses);
  const currentIndex = lineage.findIndex(response => response.responseId === currentResponseId);
  if (currentIndex < 0) return null;
  return (
    [...lineage.slice(currentIndex + 1)]
      .reverse()
      .find(response => !isHuman(response) && responseFileArtifacts(response).length > 0) ?? null
  );
};
