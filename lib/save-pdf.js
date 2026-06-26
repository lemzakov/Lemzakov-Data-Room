'use strict';

// Markup injected into every served page: a fixed "Save as PDF" button at the
// top of the document. It triggers the browser's print dialog (where the user
// can pick "Save as PDF") and is hidden in print/PDF output via `@media print`
// so it never shows up in the saved document.
const SAVE_PDF_SNIPPET = `
<style id="ldr-save-pdf-style">
  #ldr-save-pdf {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 2147483647;
    padding: 8px 14px;
    font: 600 14px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #fff;
    background: #1a73e8;
    border: none;
    border-radius: 6px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
    cursor: pointer;
  }
  #ldr-save-pdf:hover { background: #1666c1; }
  @media print {
    #ldr-save-pdf, #ldr-save-pdf-style { display: none !important; }
  }
</style>
<button id="ldr-save-pdf" type="button" onclick="window.print()" aria-label="Save as PDF">Save as PDF</button>
`;

// Insert the button just before </body> (so window.print exists and the button
// sits above page content via fixed positioning). Falls back to appending when
// there is no </body> tag.
function injectSavePdfButton(html) {
  if (typeof html !== 'string' || !html) {
    return html;
  }
  if (html.includes('id="ldr-save-pdf"')) {
    return html;
  }
  const closingBody = /<\/body\s*>/i;
  if (closingBody.test(html)) {
    return html.replace(closingBody, (match) => SAVE_PDF_SNIPPET + match);
  }
  return html + SAVE_PDF_SNIPPET;
}

module.exports = { injectSavePdfButton, SAVE_PDF_SNIPPET };
