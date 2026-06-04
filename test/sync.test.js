const test = require('node:test');
const assert = require('node:assert/strict');
const { extractGoogleFolderId } = require('../lib/config');
const { slugFromFilename } = require('../lib/sync');

test('extractGoogleFolderId supports folder links', () => {
  const id = extractGoogleFolderId('https://drive.google.com/drive/folders/ABC123_xyz?usp=sharing');
  assert.equal(id, 'ABC123_xyz');
});

test('extractGoogleFolderId returns raw id', () => {
  assert.equal(extractGoogleFolderId('ABC123_xyz'), 'ABC123_xyz');
});

test('slugFromFilename normalizes html filename', () => {
  assert.equal(slugFromFilename('Quarterly-Report.HTML'), 'quarterly-report');
});
