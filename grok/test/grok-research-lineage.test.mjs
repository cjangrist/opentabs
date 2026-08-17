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
    { responseId: 'repair-prompt', sender: 'human', message: FILE_ARTIFACT_REPAIR_INSTRUCTION },
    { responseId: 'repair', sender: 'assistant', ...artifact('repair.md') },
    { responseId: 'revision-prompt', sender: 'human', message: `${FILE_ARTIFACT_REVISION_PREFIX}\n\nfix one record` },
    { responseId: 'revision', sender: 'assistant', ...artifact('revision.md') },
    { responseId: 'unrelated-prompt', sender: 'human', parentResponseId: 'revision', message: 'Create an unrelated file.' },
    {
      responseId: 'unrelated',
      sender: 'assistant',
      parentResponseId: 'unrelated-prompt',
      webSearchResults: [{ url: 'https://unrelated.example' }],
      ...artifact('unrelated.md'),
    },
  ];
  const nodes = [
    { responseId: 'prompt', sender: 'human' },
    { responseId: 'research', sender: 'assistant', parentResponseId: 'prompt' },
    { responseId: 'regeneration', sender: 'assistant', parentResponseId: 'prompt' },
    { responseId: 'repair-prompt', sender: 'human', parentResponseId: 'regeneration' },
    { responseId: 'repair', sender: 'assistant', parentResponseId: 'repair-prompt' },
    { responseId: 'revision-prompt', sender: 'human', parentResponseId: 'repair' },
    { responseId: 'revision', sender: 'assistant', parentResponseId: 'revision-prompt' },
    { responseId: 'unrelated-prompt', sender: 'human', parentResponseId: 'revision' },
    { responseId: 'unrelated', sender: 'assistant', parentResponseId: 'unrelated-prompt' },
  ];

  assert.deepEqual(
    researchLineageResponses(responses, nodes).map(response => response.responseId),
    ['prompt', 'research', 'regeneration', 'repair-prompt', 'repair', 'revision-prompt', 'revision'],
  );
  assert.equal(newerResearchArtifactResponse(responses, nodes, 'research')?.responseId, 'revision');
  assert.equal(newerResearchArtifactResponse(responses, nodes, 'revision'), null);
});
