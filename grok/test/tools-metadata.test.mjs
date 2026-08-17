import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('keeps every generated tool description within the server discovery limit', async () => {
  const generated = JSON.parse(await readFile(new URL('../dist/tools.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(generated.tools));
  for (const tool of generated.tools) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length <= 1000, `${tool.name} description is ${tool.description.length} characters`);
  }
});
