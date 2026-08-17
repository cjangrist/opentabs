import assert from 'node:assert/strict';
import test from 'node:test';
import { responseFileArtifacts } from '../dist/grok-messages.js';

test('extracts and deduplicates live renderFilePreview chunks without changing UTF-8 filenames', () => {
  const filename = 'École_niños_日本語_😀.md';
  const relativeUrl = '/v1/files/report.md?signature=a%2Fb';
  const artifacts = responseFileArtifacts({
    outputChunks: [
      {
        content: {
          case: 'renderFilePreview',
          value: { fileName: filename, fileSize: '123', url: relativeUrl },
        },
      },
      { renderFilePreview: { fileName: filename, fileSize: 123, url: relativeUrl } },
      { render_file_preview: { file_name: filename, file_size: 123, url: relativeUrl } },
    ],
  });

  assert.deepEqual(artifacts, [
    {
      filename,
      url: 'https://assets.grok.com/v1/files/report.md?signature=a%2Fb',
      sizeBytes: 123,
    },
  ]);
});

test('extracts serialized and decoded rendered-file cards and treats blank sizes as unknown', () => {
  const artifacts = responseFileArtifacts({
    cardAttachmentsJson: [
      JSON.stringify({
        cardType: 'rendered_file_card',
        fileName: 'one.md',
        fileSize: '',
        url: 'https://assets.grok.com/one',
      }),
      {
        card_type: 'rendered_file_card',
        file_name: 'two.md',
        file_size: '   ',
        url: '/two',
      },
    ],
  });

  assert.deepEqual(
    artifacts.map(({ filename, sizeBytes }) => [filename, sizeBytes]),
    [
      ['one.md', null],
      ['two.md', null],
    ],
  );
});

test('rejects unsafe filenames, plaintext URLs, non-Grok hosts, and protocol-relative URLs', () => {
  const artifacts = responseFileArtifacts({
    outputChunks: [
      { renderFilePreview: { fileName: '../escape.md', url: '/bad' } },
      { renderFilePreview: { fileName: 'line\nbreak.md', url: '/bad' } },
      { renderFilePreview: { fileName: 'http.md', url: 'http://assets.grok.com/file' } },
      { renderFilePreview: { fileName: 'third-party.md', url: 'https://example.com/file' } },
      { renderFilePreview: { fileName: 'protocol-relative.md', url: '//evil.grok.com/file' } },
    ],
  });

  assert.deepEqual(artifacts, []);
});
