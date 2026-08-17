import { responseFileArtifacts, type RawResponse, type RawResponseNode } from './grok-messages.js';
import { hasFileArtifactContinuationInstruction, hasFileArtifactInstruction } from './grok-research-prompt.js';

const responseNodeMap = (nodes: RawResponseNode[]): Map<string, RawResponseNode> =>
  new Map(nodes.filter(node => node.responseId).map(node => [node.responseId as string, node]));

const senderOf = (response: RawResponse, nodes: Map<string, RawResponseNode>): string | undefined =>
  response.sender ?? (response.responseId ? nodes.get(response.responseId)?.sender : undefined);

const parentOf = (response: RawResponse, nodes: Map<string, RawResponseNode>): string | undefined =>
  response.parentResponseId ?? (response.responseId ? nodes.get(response.responseId)?.parentResponseId : undefined);

const isHuman = (response: RawResponse, nodes: Map<string, RawResponseNode>): boolean =>
  senderOf(response, nodes)?.toLowerCase() === 'human';

export const researchLineageResponses = (responses: RawResponse[], nodes: RawResponseNode[] = []): RawResponse[] => {
  const acceptedHumanIds = new Set<string>();
  const acceptedAssistantIds = new Set<string>();
  const nodesById = responseNodeMap(nodes);
  let foundResearchPrompt = false;

  for (const response of responses) {
    if (!response.responseId) continue;
    const parentResponseId = parentOf(response, nodesById);
    if (isHuman(response, nodesById)) {
      if (!foundResearchPrompt && hasFileArtifactInstruction(response.message ?? '')) {
        foundResearchPrompt = true;
        acceptedHumanIds.add(response.responseId);
      } else if (
        foundResearchPrompt &&
        parentResponseId &&
        acceptedAssistantIds.has(parentResponseId) &&
        hasFileArtifactContinuationInstruction(response.message ?? '')
      ) {
        acceptedHumanIds.add(response.responseId);
      }
    } else if (foundResearchPrompt && parentResponseId && acceptedHumanIds.has(parentResponseId)) {
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
  nodes: RawResponseNode[],
  currentResponseId: string,
): RawResponse | null => {
  const lineage = researchLineageResponses(responses, nodes);
  const nodesById = responseNodeMap(nodes);
  const currentIndex = lineage.findIndex(response => response.responseId === currentResponseId);
  if (currentIndex < 0) return null;
  return (
    [...lineage.slice(currentIndex + 1)]
      .reverse()
      .find(response => !isHuman(response, nodesById) && responseFileArtifacts(response).length > 0) ?? null
  );
};
