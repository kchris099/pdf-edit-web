# PDF Edit Web

PDF Edit Web is a local-first PDF editor that runs in the browser. It lets
you open a PDF, inspect and search its text, edit supported text, move text
and signatures, draw and place signatures, and download the result.

PDF content stays in the browser. Files, passwords, extracted text, edits,
and signatures are not uploaded to a server or saved to browser storage.

## Run locally

Install the dependencies and start the Vite development server:

```bash
npm install
npm run dev
```

Open the local URL shown by Vite, then choose `Open PDF` or drag a PDF into
the viewer. The sidebar shows the pages of the document after it is opened.

To try the included sample, select
`public/samples/editable-embedded-font.pdf` in the file picker.

## Use the editor

- Search for text with the search field in the toolbar.
- Select the text tool, then click supported text on the page to edit it.
- Select text or signatures and drag them to move them. Marquee selection can
  be used for multiple text runs.
- Draw a signature, place it on the page, and resize or move it as needed.
- Use undo and redo while making changes, then download the edited PDF.

The editor reports unsupported content streams and replacement characters
that cannot be encoded by the existing PDF font. It does not fake text edits
by painting over the original page.

## Production build

Create a production bundle with:

```bash
npm run build
```

## Licensing

MuPDF.js is available under AGPL-3.0-or-later or a commercial Artifex
license. Review [LICENSE](LICENSE) and
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) before distributing or
deploying the application.
