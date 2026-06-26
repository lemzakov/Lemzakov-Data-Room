const test = require('node:test');
const assert = require('node:assert/strict');
const { injectSavePdfButton } = require('../lib/save-pdf');

test('injects the Save as PDF button before </body>', () => {
  const out = injectSavePdfButton('<html><body><h1>Hi</h1></body></html>');
  assert.match(out, /id="ldr-save-pdf"/);
  assert.match(out, /window\.print\(\)/);
  // Button sits before the closing body tag.
  assert.ok(out.indexOf('id="ldr-save-pdf"') < out.indexOf('</body>'));
});

test('hides the button in print/PDF output via @media print', () => {
  const out = injectSavePdfButton('<body></body>');
  assert.match(out, /@media print[\s\S]*#ldr-save-pdf[\s\S]*display:\s*none/);
});

test('appends the button when there is no </body> tag', () => {
  const out = injectSavePdfButton('<h1>Bare fragment</h1>');
  assert.match(out, /id="ldr-save-pdf"/);
  assert.ok(out.startsWith('<h1>Bare fragment</h1>'));
});

test('does not inject twice', () => {
  const once = injectSavePdfButton('<body></body>');
  const twice = injectSavePdfButton(once);
  assert.equal(once, twice);
  assert.equal((twice.match(/id="ldr-save-pdf"/g) || []).length, 1);
});

test('leaves empty or non-string input untouched', () => {
  assert.equal(injectSavePdfButton(''), '');
  assert.equal(injectSavePdfButton(null), null);
});
