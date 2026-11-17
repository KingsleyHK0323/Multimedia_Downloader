// OpenAI-Codex: regression checks for the automatic staged release entry point.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const legacyWorkflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
const stagedWorkflow = readFileSync(resolve('.github/workflows/staged-release-pipeline.yml'), 'utf8');

test('legacy release workflow cannot publish', () => {
  assert.equal(legacyWorkflow.startsWith('name: Legacy release workflow (disabled)'), true);
  assert.equal(legacyWorkflow.includes('  push:'), false);
  assert.equal(legacyWorkflow.includes('  workflow_call:'), false);
  assert.equal(legacyWorkflow.includes('contents: write'), false);
  assert.equal(legacyWorkflow.includes('gh release'), false);
});

test('staged pipeline owns the create-only upload path', () => {
  assert.equal(stagedWorkflow.includes('gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --draft --verify-tag'), true);
  assert.equal(stagedWorkflow.includes('gh release upload "$TAG" "$path" --repo "$GITHUB_REPOSITORY"'), true);
  assert.equal(stagedWorkflow.includes('--clobber'), false);
});
