import assert from 'node:assert/strict';
import test from 'node:test';
import { newerResearchArtifactResponse, researchLineageResponses } from '../dist/grok-research-lineage.js';
import {
  FILE_ARTIFACT_INSTRUCTION_BLOCK,
  FILE_ARTIFACT_REPAIR_INSTRUCTION,
  FILE_ARTIFACT_REVISION_PREFIX,
} from '../dist/grok-research-prompt.js';

const artifact = filename => ({
  outputChunks: [{ renderFilePreview: { fileName: filename, url: `/files/${filename}` } }],
});

test('restricts artifact adoption to regeneration, repair, and marked revision lineage', () => {
  const responses = [
    { responseId: 'prompt', sender: 'human', message: `question\n\n${FILE_ARTIFACT_INSTRUCTION_BLOCK}` },
    { responseId: 'research', sender: 'assistant', parentResponseId: 'prompt', webSearchResults: [{ url: 'https://primary.example' }] },
    { responseId: 'regeneration', sender: 'assistant', parentResponseId: 'prompt' },
    { responseId: 'repair-prompt', sender: 'human', parentResponseId: 'regeneration', message: FILE_ARTIFACT_REPAIR_INSTRUCTION },
    { responseId: 'repair', sender: 'assistant', parentResponseId: 'repair-prompt', ...artifact('repair.md') },
    { responseId: 'revision-prompt', sender: 'human', parentResponseId: 'repair', message: `${FILE_ARTIFACT_REVISION_PREFIX}\n\nfix one record` },
    { responseId: 'revision', sender: 'assistant', parentResponseId: 'revision-prompt', ...artifact('revision.md') },
    { responseId: 'unrelated-prompt', sender: 'human', parentResponseId: 'revision', message: 'Create an unrelated file.' },
    {
      responseId: 'unrelated',
      sender: 'assistant',
      parentResponseId: 'unrelated-prompt',
      webSearchResults: [{ url: 'https://unrelated.example' }],
      ...artifact('unrelated.md'),
    },
  ];

  assert.deepEqual(
    researchLineageResponses(responses).map(response => response.responseId),
    ['prompt', 'research', 'regeneration', 'repair-prompt', 'repair', 'revision-prompt', 'revision'],
  );
  assert.equal(newerResearchArtifactResponse(responses, 'research')?.responseId, 'revision');
  assert.equal(newerResearchArtifactResponse(responses, 'revision'), null);
});
