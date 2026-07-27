# PDF Edit Web

Browser-based companion project for PDF Edit.

The web app will be deployed as a static GitHub Pages site and will support:

- uploading a PDF from the browser
- editing it locally in the browser
- downloading the edited PDF

The desktop Windows application remains in the sibling `pdf-edit` repository.

## Implemented browser editor

This repository contains the local-only browser editor from
`IMPLEMENTATION_PLAN.md`:

- React + TypeScript + Vite static app;
- official MuPDF.js in a dedicated module Web Worker;
- local upload, drag/drop, password-aware open, page render, structured-text
  inspection, search, and Blob download;
- click-to-edit text directly over the rendered page;
- drag-to-move text and vector signatures, including marquee multi-selection;
- signature drawing, page placement, movement, removal, and grouped undo/redo;
- visible search, selection, and interaction overlays;
- page thumbnails, navigation, 25–500% zoom, fit controls, Ctrl+wheel zoom,
  and pointer panning;
- conservative original-content-stream text replacement and movement;
- save → reopen → search verification and source SHA-256 display;
- a copied embedded-font parity fixture at `public/samples/`.

Run it with `npm install` followed by `npm run dev`, or verify a production
bundle with `npm run build`. The fixture can be loaded from the sidebar.

The checked-in desktop fixture currently contains `Client Name` rather than
the older plan wording `Account ID`; the slice defaults to the fixture's
actual searchable text while keeping both fields editable in the sidebar.

Unsupported content streams and replacement characters that cannot be encoded
with the existing PDF font are rejected explicitly. The editor never simulates
text replacement by painting a white rectangle over the page.

## Licensing gate

MuPDF.js is AGPL-3.0-or-later or commercially licensed by Artifex. The public
deployment license has not been selected; see `LICENSE` and
`THIRD-PARTY-NOTICES.md` before publishing this site.
