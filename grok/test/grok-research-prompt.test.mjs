import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FILE_ARTIFACT_INSTRUCTION,
  FILE_ARTIFACT_INSTRUCTION_BLOCK,
  FILE_ARTIFACT_VERIFICATION_INSTRUCTION,
  hasFileArtifactInstruction,
  withFileArtifactInstruction,
} from '../dist/grok-research-prompt.js';

test('appends the exact artifact block without changing UTF-8 prompt content', () => {
  const prompt = 'Résumé for Côte d’Ivoire 日本語 😀';
  assert.equal(withFileArtifactInstruction(prompt), `${prompt}\n\n${FILE_ARTIFACT_INSTRUCTION_BLOCK}`);
});

test('upgrades the legacy suffix once and keeps the full suffix idempotent', () => {
  const legacy = `question\n\n${FILE_ARTIFACT_INSTRUCTION}`;
  const upgraded = `${legacy}\n\n${FILE_ARTIFACT_VERIFICATION_INSTRUCTION}`;
  assert.equal(withFileArtifactInstruction(legacy), upgraded);
  assert.equal(withFileArtifactInstruction(upgraded), upgraded);
  assert.equal(withFileArtifactInstruction(`${upgraded}\n`), `${upgraded}\n`);
  assert.equal(upgraded.split(FILE_ARTIFACT_INSTRUCTION).length - 1, 1);
  assert.equal(upgraded.split(FILE_ARTIFACT_VERIFICATION_INSTRUCTION).length - 1, 1);
});

test('preserves trailing whitespace while upgrading the legacy suffix', () => {
  const legacy = `question\n\n${FILE_ARTIFACT_INSTRUCTION}\n\n`;
  assert.equal(withFileArtifactInstruction(legacy), `${legacy}${FILE_ARTIFACT_VERIFICATION_INSTRUCTION}`);
});

test('recognizes legacy and strengthened research prompts but not the verification sentence alone', () => {
  assert.equal(hasFileArtifactInstruction(`question\n\n${FILE_ARTIFACT_INSTRUCTION}\n`), true);
  assert.equal(hasFileArtifactInstruction(`question\n\n${FILE_ARTIFACT_INSTRUCTION_BLOCK}\n`), true);
  assert.equal(hasFileArtifactInstruction(FILE_ARTIFACT_VERIFICATION_INSTRUCTION), false);
});
