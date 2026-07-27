# PDF Edit Web implementation plan

## 1. Goal

Build a local-first browser version of the sibling `pdf-edit` desktop
application. A user must be able to:

1. open or drag a PDF into the browser;
2. view and navigate a multi-page document;
3. search, edit, and move supported existing text;
4. draw, place, move, remove, undo, and redo vector signatures;
5. download an edited PDF without uploading the document to a server.

The application will be a static site deployable to GitHub Pages. PDF bytes,
passwords, extracted text, rendered pages, fonts, edits, and signatures stay
inside the browser process.

## 2. Important conclusion from the reference project

`perfectPixel_webdemo` is useful as a product and deployment model, not as a
direct technical template. It:

- ports the original Python algorithm to TypeScript;
- processes uploaded files locally;
- uses React, TypeScript, Vite, and browser Canvas APIs;
- downloads the result as a browser-generated file;
- publishes the static `dist` directory to GitHub Pages.

PDF Edit Web should follow the same model. The WinUI UI cannot be reused, and
the native .NET MuPDF adapter cannot run in a normal browser. The reusable
parts are the domain model, coordinate math, undo/redo semantics, content
stream rewriting rules, fixtures, and expected behavior.

## 3. Scope and parity target

### Required for the first complete release

| Desktop capability | Web implementation |
| --- | --- |
| File picker and drag/drop | File API and drag/drop |
| Password-protected PDFs | In-app password dialog; password remains in memory |
| Continuous multi-page view | Virtualized page list rendered by MuPDF.js |
| Page thumbnails | Low-resolution worker renders |
| Page navigation | Page number, previous/next, keyboard shortcuts |
| Zoom and pan | 25–500%, fit page, fit width, Ctrl+wheel, middle-button pan |
| Search | Worker-side page search with result overlays and next/previous |
| Edit existing text | Port the conservative content-stream rewriter |
| Move one or several text runs | Port stream matrix/operator movement |
| Draw/place signature | Pointer Events canvas; save as PDF Ink annotation |
| Move/remove signatures | Overlay handles plus annotation mutation |
| Undo/redo | Command history compatible with the desktop behavior |
| Signed-document warning | Require explicit confirmation before mutation |
| Save Copy | Generate a Blob and download `<name>_edited.pdf` |
| Save Copy As | File System Access API when available, download fallback |
| Theme and sidebar preferences | `localStorage`; no document content persisted |
| Keyboard accessibility | Desktop-equivalent shortcuts and visible focus |

### Explicit non-goals for the first release

- cloud storage, accounts, collaboration, analytics, or a backend;
- OCR;
- editing text inside Form XObjects, patterns, or other recursively reused
  content;
- reshaping arbitrary pre-existing ink;
- validation of certificate trust;
- silent font substitution;
- pixel-identical UI parity with WinUI.

These match the desktop application's conservative behavior. The web version
must report unsupported edits instead of pretending an edit was successful.

## 4. Licensing decision gate

Use the official `mupdf` JavaScript/TypeScript package, which wraps MuPDF in
WebAssembly. It is available under AGPL-3.0 or a commercial Artifex license.
The license covers both the JavaScript wrapper and the WASM binary.

Before public deployment, choose one:

1. license the web application under AGPL-3.0 and satisfy its source and
   distribution requirements; or
2. obtain an Artifex commercial license and retain the desired application
   license.

Do not assume that the desktop application's MuPDF.NET Community License or
the repository's MIT license automatically covers MuPDF.js distribution.
Record the decision in `LICENSE`, `THIRD-PARTY-NOTICES.md`, the About dialog,
and the deployed site footer before release.

## 5. Proposed architecture

```text
Browser main thread
  React UI
  ├─ file intake and download
  ├─ virtualized page/thumbnails layout
  ├─ canvas/image page surfaces
  ├─ SVG/HTML interaction overlays
  ├─ dialogs, status, keyboard handling
  └─ app/session state
          │ typed Comlink/RPC messages
          ▼
Dedicated PDF Web Worker
  ├─ MuPDF.js + WebAssembly document
  ├─ rendering and search
  ├─ PDF object/content stream access
  ├─ ported text inspector/rewriter
  ├─ annotation/signature mutations
  ├─ edit delta journal
  └─ save to Uint8Array
```

Keep all MuPDF objects in one dedicated worker. This prevents rendering and
stream parsing from blocking React, avoids transferring native/WASM handles,
and gives the document a single owner. Transfer only plain typed data and
`ArrayBuffer`/`Uint8Array` payloads across the boundary.

### Technology choices

- React + TypeScript + Vite
- `mupdf` for WebAssembly parsing, rendering, PDF object access, annotations,
  password handling, and saving
- Comlink or a small typed RPC layer for worker calls
- `@tanstack/react-virtual` for continuous page and thumbnail virtualization
- Zustand or React reducer/context for UI/session state
- Vitest for domain and worker unit tests
- Playwright for browser workflows
- ESLint and TypeScript strict mode
- GitHub Actions and GitHub Pages

Do not use PDF.js and MuPDF.js together for the first implementation. One
engine avoids mismatched text geometry, coordinate transforms, annotation
appearance, and rendering. PDF.js remains a fallback only if a measured
MuPDF.js rendering problem justifies the extra complexity.

## 6. Suggested repository layout

```text
src/
  app/
    App.tsx
    commands.ts
    keyboard.ts
    session-store.ts
  components/
    CommandBar/
    DocumentViewport/
    PageSurface/
    ThumbnailSidebar/
    SearchBar/
    SignatureDialog/
    dialogs/
  domain/
    geometry.ts
    pdf-models.ts
    coordinate-converter.ts
    undo-redo.ts
    text-utilities.ts
  pdf/
    client.ts
    protocol.ts
    worker.ts
    engine.ts
    render-cache.ts
    content-stream/
      tokenizer.ts
      interpreter.ts
      rewriter.ts
      font-encoding.ts
  styles/
  test/
public/
  samples/
tests/
  unit/
  integration/
  e2e/
.github/workflows/
  ci.yml
  pages.yml
```

`domain/` should have no React or MuPDF imports. This keeps the most reusable
desktop logic independently testable.

## 7. Engine contract

Create a TypeScript equivalent of the desktop `IPdfDocumentEngine` before
building the UI:

```ts
interface PdfDocumentEngine {
  open(bytes: ArrayBuffer, password?: string): Promise<PdfDocumentInfo>;
  close(): Promise<void>;
  getPageInfos(): Promise<PdfPageInfo[]>;
  renderPage(request: RenderPageRequest): Promise<RenderedPage>;
  inspectText(page: number): Promise<PdfTextRun[]>;
  search(query: string): Promise<SearchResult[]>;
  applyTextEdit(request: TextEditRequest): Promise<TextEditResult>;
  applyTextMoves(request: TextMovesRequest): Promise<TextMoveResult>;
  applyContentDelta(delta: ContentStreamDelta, useAfter: boolean): Promise<void>;
  inspectSignatures(page: number): Promise<SignatureDelta[]>;
  addSignature(placement: SignaturePlacement): Promise<SignatureDelta>;
  moveSignature(request: SignatureMoveRequest): Promise<SignatureDelta>;
  removeSignature(delta: SignatureDelta): Promise<void>;
  restoreSignature(delta: SignatureDelta): Promise<SignatureDelta>;
  save(): Promise<Uint8Array>;
}
```

The worker protocol must version its request/response shapes and return
structured error codes rather than serialized exception strings.

## 8. Content-stream port

This is the critical path. Port behavior, not C# syntax.

1. Port `PdfTokenScanner` and the text/graphics state interpreter to strict
   TypeScript over `Uint8Array`.
2. Preserve the same tracked operators and state: `Tf`, `Tm`, `Td`, `TD`,
   `T*`, `Tc`, `Tw`, `Tz`, `Ts`, `Tr`, color state, `q`/`Q`, `cm`, `Tj`,
   `TJ`, and quote operators.
3. Resolve each page's inherited resources and `/Contents`, including a single
   stream or array of streams.
4. Use MuPDF.js `PDFObject.readStream()` for decoded stream bytes and
   `PDFObject.writeStream()` for replacement bytes.
5. Identify a run using page number, stream object number, operator occurrence,
   string index, geometry, font resource, and original bytes. Never rely on
   extracted text alone.
6. Reuse the existing font resource only when every replacement character can
   be encoded safely.
7. Port WinAnsi and common `ToUnicode` `bfchar`/`bfrange` parsing and subset
   coverage checks.
8. Preserve unrelated bytes and surrounding graphics state.
9. Represent undo/redo as exact before/after decoded content-stream byte
   arrays plus the indirect object number.
10. Reinspect and rerender the changed page after every mutation.

The browser must never implement text replacement by painting a white
rectangle over the old text.

### Replacement font differences in a browser

The desktop app can search installed Windows fonts. A normal static web app
cannot enumerate local font files. For the web version:

- the exact existing embedded font path remains the default;
- if it cannot encode the replacement, offer a user-selected `.ttf` or `.otf`
  file through a file picker;
- keep that font in memory for the current session only;
- embed it only after an explicit appearance-change warning;
- do not identify a CSS/system font as an exact PDF font match.

## 9. Rendering, layout, and memory

- Render in the worker to RGBA or PNG and transfer the result to the main
  thread. Benchmark both before choosing.
- Use device-pixel-ratio-aware rendering while keeping CSS layout in PDF
  points multiplied by zoom.
- Maintain separate thumbnail and interactive render queues.
- Cancel or discard stale render generations after zoom, close, or rapid
  scrolling.
- Keep high-resolution renders only for the visible page neighborhood.
- Use a byte-budgeted LRU cache. Begin with a conservative 128 MiB default and
  tune using the 200-page fixture.
- Revoke every object URL and explicitly destroy every MuPDF.js object.
- Do not transfer the original document buffer repeatedly.
- Warn before loading a file above a tested size threshold; do not impose an
  arbitrary permanent limit until browser measurements exist.

## 10. Coordinate and interaction model

Port `CoordinateConverter` and its tests first. Keep edit geometry in PDF
coordinates and convert only at the overlay boundary. Cover:

- bottom-left PDF origin versus top-left DOM origin;
- crop-box offsets;
- 0/90/180/270-degree page rotation;
- zoom;
- device pixel ratio;
- page-local scrolling and pointer coordinates.

Use one overlay per rendered page:

- SVG rectangles/quads for search and selection;
- an HTML input for in-place text editing;
- SVG paths for staged signatures;
- pointer capture for drag, marquee selection, move, and resize.

Pointer Events provide a single mouse, touch, and pen path. Preserve keyboard
commit/cancel behavior: Enter commits and Escape cancels.

## 11. Save and privacy behavior

- Keep the source `File`/`ArrayBuffer` and the live MuPDF document in memory.
- Do not write document bytes, thumbnails, search text, signatures, or
  passwords to local storage, IndexedDB, logs, crash services, or analytics.
- Default download name: `<stem>_edited.pdf`, then let the browser resolve
  duplicates.
- Use `showSaveFilePicker()` only as progressive enhancement. GitHub Pages
  must still work through Blob download in Firefox and Safari.
- Preserve the desktop warning that editing a digitally signed document
  invalidates the signature.
- Disable PDF JavaScript execution, embedded-file launch, and automatic
  external navigation.
- Add a strict Content Security Policy appropriate for the WASM worker and
  self-host all production assets.

## 12. Delivery phases

### Phase 0 — licensing and feasibility spike

Deliver:

- documented AGPL/commercial decision;
- minimal Vite app loading MuPDF.js in a dedicated worker;
- open, password prompt, render, search, mutate one known content stream,
  save, download, and reopen;
- proof that the embedded-font fixture can change `Account ID` to `Client ID`
  while remaining searchable;
- source-file hash proof that the upload is not modified.

Exit gate: the saved fixture reopens successfully, only the intended stream
changes, and the result is visually equivalent outside the edited region.

### Phase 1 — viewer shell

Deliver:

- upload, drag/drop, close, error states;
- continuous virtualized pages and thumbnails;
- page navigation, zoom, fit width/page, pan;
- password handling;
- render cancellation and LRU cache;
- responsive desktop/tablet layout and keyboard navigation.

Exit gate: the 200-page mixed-size fixture can be scrolled forward and
backward repeatedly without unbounded memory growth or a frozen UI.

### Phase 2 — search and inspection

Deliver:

- structured text inspection and editable/unsupported classification;
- search UI, overlays, result navigation;
- coordinate conversion for all rotations and crop boxes;
- text hit testing and selection overlay.

Exit gate: search and hit testing match expected fixture coordinates at
multiple zoom levels and rotations.

### Phase 3 — text edit and move

Deliver:

- ported tokenizer, interpreter, encoding maps, and exact stream rewrite;
- inline text editor and overflow warning;
- single and marquee multi-run move;
- replacement-font upload path;
- signed-document confirmation;
- byte-delta undo/redo.

Exit gate: all supported desktop fixtures retain searchability and pass
before/after visual-region comparisons; unsupported fixtures are refused with
specific messages.

### Phase 4 — signatures

Deliver:

- signature drawing dialog using Pointer Events;
- trimming and aspect-ratio preservation;
- staged placement, drag, resize, commit;
- Ink annotation save, inspect, move, remove, restore;
- signature command undo/redo.

Exit gate: a reopened download contains vector ink with the expected bounds
and strokes; no raster signature image is introduced.

### Phase 5 — production hardening and Pages deployment

Deliver:

- complete fixture and browser test matrix;
- accessibility pass;
- CSP, privacy statement, legal notices, About dialog;
- bundle and WASM caching strategy;
- GitHub Actions CI;
- GitHub Pages deployment with relative asset paths and `.nojekyll`;
- release checklist and documented browser support.

Exit gate: CI builds from a clean checkout and Playwright passes on Chromium,
Firefox, and WebKit before deployment.

## 13. Test strategy

Reuse the PDFs under `../pdf-edit/samples/Generated`. Copy only redistributable
fixtures into the web test setup or generate them in CI with the sibling
fixture generator.

### Unit tests

- geometry and inverse coordinate conversion;
- crop and rotation cases;
- tokenizer escape, hex, array, dictionary, comment, and malformed input;
- text-state interpretation;
- WinAnsi and ToUnicode maps;
- exact replacement and move byte deltas;
- overflow and glyph coverage;
- undo/redo saved/dirty cursor behavior;
- signature trimming and bounds;
- output naming and error mapping.

### Worker integration tests

- open valid, malformed, encrypted, and wrong-password files;
- render every fixture;
- inspect/search/edit/move/save/reopen;
- add/move/remove/restore vector ink;
- preserve bookmarks, links, metadata, page order, and unrelated annotations;
- warn on signed PDFs;
- verify unsupported scans, outlines, Type 3, and Form XObject text;
- compare hashes of the original upload before and after;
- compare rendered pixels outside the intended edit region.

### Browser end-to-end tests

- upload and drag/drop;
- password dialog;
- scroll, zoom, fit, navigate, and thumbnail selection;
- search next/previous;
- edit text and move selected runs;
- signature draw/place/move/undo/redo;
- download and parse the downloaded PDF;
- keyboard-only workflow;
- light/dark theme and responsive layout;
- worker failure and out-of-memory recovery messaging.

## 14. CI and deployment

Use two workflows:

`ci.yml`

- install with a committed lockfile using `npm ci`;
- type-check, lint, unit tests, production build;
- Playwright tests on the supported browser matrix;
- upload test reports on failure.

`pages.yml`

- run only after CI succeeds on `main`;
- build with the GitHub Pages base path;
- upload `dist` through the official Pages artifact action;
- deploy through `actions/deploy-pages`;
- set minimal `pages: write` and `id-token: write` permissions.

Prefer the official GitHub Pages actions over pushing generated files to a
`gh-pages` branch.

## 15. Principal risks and mitigations

| Risk | Mitigation |
| --- | --- |
| MuPDF.js license conflicts with intended distribution | Make licensing Phase 0, before implementation |
| Browser cannot enumerate installed fonts | Require explicit user font upload for replacement-font mode |
| WASM blocks UI or leaks memory | Single worker ownership, explicit `destroy()`, transferables, LRU budgets |
| Extracted runs do not map uniquely to stream operators | Use occurrence/string/stream IDs plus original bytes and geometry |
| Large documents exhaust mobile/browser memory | Virtualization, dual queues, cancellation, compressed cache, tested warnings |
| Browser save behavior differs | Blob download baseline; File System Access as enhancement |
| Signed/encrypted documents change semantics on save | Match desktop warnings and test reopen/permissions explicitly |
| A broad rewrite damages unrelated content | Byte-local deltas and visual/hash comparisons on every fixture |
| Desktop and web implementations drift | Shared behavioral fixture manifest and parity checklist in both repositories |

## 16. Definition of done

The web version is complete when:

- it is served as static assets from GitHub Pages;
- all processing is local and verified by a no-network editing test;
- every in-scope desktop command has a tested browser equivalent;
- supported text is changed in the original content stream and remains
  searchable after reopening;
- signatures remain vector Ink annotations;
- undo/redo and dirty/save state are correct;
- original uploaded bytes are never overwritten;
- generated downloads reopen in MuPDF and an independent PDF parser;
- the fixture, stress, accessibility, and three-browser CI matrices pass;
- legal notices and the chosen MuPDF licensing path are complete.

## 17. Recommended first implementation slice

Do not start by recreating the full WinUI toolbar. Start with the Phase 0
vertical slice:

1. scaffold React/Vite/TypeScript and CI;
2. load MuPDF.js in a worker;
3. upload the embedded-font fixture;
4. render page 1;
5. locate the exact `/Contents` stream and `Account ID` operator;
6. port the minimum tokenizer/interpreter needed to replace it safely;
7. write the stream, save to a buffer, and download;
8. reopen the generated bytes, search for `Client ID`, and render a
   before/after comparison.

That slice resolves the architecture's highest-risk question before investing
in the complete interface.
