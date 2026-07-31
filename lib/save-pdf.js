'use strict';

// Markup injected into every served page: a tiny icon-only "Save as PDF"
// button pinned to the bottom-right corner. Kept small (28px) and mostly
// transparent until hovered so it never obscures the page content, and hidden
// in print/PDF output via @media print so it never appears in the saved
// document. It triggers the browser's print dialog (where the user can pick
// "Save as PDF").
const SAVE_PDF_SNIPPET = `
<style id="ldr-save-pdf-style">
  #ldr-save-pdf {
    position: fixed;
    bottom: 10px;
    right: 10px;
    z-index: 2147483647;
    width: 28px;
    height: 28px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    background: rgba(26, 115, 232, 0.45);
    border: none;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
    cursor: pointer;
    transition: background 0.15s ease;
  }
  #ldr-save-pdf:hover,
  #ldr-save-pdf:focus-visible { background: #1a73e8; }
  #ldr-save-pdf svg { width: 14px; height: 14px; display: block; }
  @media print {
    #ldr-save-pdf, #ldr-save-pdf-style { display: none !important; }
  }
</style>
<button id="ldr-save-pdf" type="button" onclick="window.print()" aria-label="Save as PDF" title="Save as PDF">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 3v11" />
    <path d="M7 10l5 5 5-5" />
    <path d="M4 20h16" />
  </svg>
</button>
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
