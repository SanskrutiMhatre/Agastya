# Editor parity with the original Agastya editor

The original (`jss-agastya source code/Agastya_V.01/frontend/src/components/editor`, `extensions/`,
kept locally and never copied: decisions.md PV3) was read for behaviour. "Original" says
what it did; **soon** means the original showed the item as "not implemented yet".
Status: **Done** (this editor does it), **Better** (does it, a defect of the original
avoided), **Partial**, **Gap**. Decisions PV1-PV24 give the details.

| Area | Original | Here | Status |
|---|---|---|---|
| Views | Design, Tags, XML | Design, Tags, Split (page or tags beside the XML), XML | Done |
| Tag display | all tags / text tags only / containers only; attributes; hide `<x>` tags | tags on/off; attributes; hide `<x>` tags (shown again in one click) | Partial (no "text only" / "containers only") |
| Side panels | XML, PDF preview, table of contents | Split XML, Preview PDF, Outline | Done |
| Save, unsaved, undo, redo, print | buttons, Ctrl+S/Z/Y/P | buttons, menu, Ctrl+S/Z/Y/P; print of the page alone | Done |
| Format XML | re-indent everything | re-indent element-only content; text and mixed content untouched | Better |
| Validate | XSD from the toolbar; BREX **soon** | XSD then BREX, Ctrl+Shift+V, findings on their elements | Better |
| Live checks | no ICN, missing graphic, no target, unresolved ref, empty title, empty container | no ICN, ICN not declared, ref to a missing id, duplicate id, empty title; missing artwork shown on the figure | Partial (no "empty container") |
| Bold, italic, underline | toolbar, Ctrl+B/I/U | toolbar, Format menu, Ctrl+B/I/U; also verbatim, sub/superscript, clear | Done |
| Lists | numbered, bulleted; Tab/Shift+Tab; Enter next item; Enter on empty item exits | same | Done |
| Sections | Ctrl+Alt+1, sub-section Ctrl+Alt+2, demote/promote Tab, Shift+Enter sibling | same; promote keeps reading order | Better |
| Steps | Ctrl+Alt+S; Tab/Shift+Tab nest | same | Done |
| Paragraph | Ctrl+Alt+P; Enter in a title | same | Done |
| Warning, caution, note | toolbar, Ctrl+Alt+W/C/N | toolbar, menu, keys; placed where the schema allows | Better |
| Block after / before | Ctrl+Enter, Ctrl+Shift+Enter | same, and in the context menu | Done |
| Clickable gap between blocks | gap cursor | block after/before and the palette reach every position | Partial |
| "/" element palette with filter | yes | yes, also Ctrl+/; places before and after | Done |
| Figure | insert with upload under an ICN | same, ICN declared in the DOCTYPE; Ctrl+Alt+G | Done |
| Table insert | rows, columns, header, id, title | same; Ctrl+Alt+T | Done |
| Rows and columns | insert/delete | insert/delete, also in tables with merged cells | Done |
| Merge cells | drag a range, merge right, merge down, split | Shift+click a range, merge right, merge down, split | Done |
| Cell alignment | align left/centre/right/inherit; valign top/middle/bottom | same, values from the schema | Done |
| Column widths | read colwidth; drag to resize | read colwidth; Column widths dialog | Partial (no dragging) |
| References | internal (type filter, find), data module (+ title, + issue), publication module, external | same | Done |
| Element menu | edit tag and attributes, add child, insert before/after, move into previous sibling, add another, hide tags, delete | attributes, insert (before/inside/after), block before/after, another of the kind, move up/down/into previous, demote/promote, delete (only when valid) | Done |
| Drag a block to another parent | yes | no (moves by menu and keys) | Gap |
| Breadcrumb | yes | element path in the Element panel | Done |
| Identification | read-only header with badges | header, and "Edit identification" | Better |
| Procedure requirements | drawn as the build's tables | same, cells edited in place | Done |
| Attribute ids, re-sequence figure/table/graphic/multimedia/hotspot ids | **soon** | done; references follow | Done |
| Re-sequence "custom element" ids | **soon** | not done (meaning unclear) | Gap |
| Validate on save/publish | **soon** | submission refuses invalid modules; saves keep drafts by design | Partial |
| Find and replace, word count | **soon** | done | Done |
| Track changes, accept/reject, check change, previous document, XML folder | **soon** | previous versions through History; the rest not done | Gap |
| Add support statement, add tools | **soon** | requirement cells are editable; no dedicated command | Gap |
| Spell checker, close in and show | **soon** | browser spell check on; no configuration | Gap |
| Help | S1000D docs, shortcuts, about: **soon** | keyboard shortcuts | Partial |

## Functional repair (each defect reproduced in the browser first)

| Feature | Original | Before the repair | Root cause | Fix | Regression test |
|---|---|---|---|---|---|
| Enter in the middle of text | splits the block (ProseMirror split) | added an empty block after; the text after the caret stayed | the run passed only its text, never the caret offset | the run reports the caret; `splitBlock` moves the rest of the text node and every node after it (inline markup included) to the new block; titles split into a paragraph, bullets into a bullet | spec 13 "Enter splits at the caret"; unit "Enter in the middle" |
| Caret after Enter | at the start of the new block | at its end | `Range.collapse` argument inverted | `collapse(f === 'start')` | spec 13 (typing lands before the moved text) |
| Backspace at the start / Delete at the end | joins blocks; removes empty ones | did nothing; empty paragraphs piled up | not handled | `backspaceAtStart` removes an empty block or joins it to the one before (caret at the join); Delete joins the next; never where the model needs the block | spec 13 "Backspace removes…"; unit "Backspace at the start" |
| Ctrl+Z with the caret in text | undoes the last step | only the browser's own typing undo; structural edits stayed | the editor's history ignored keys from text boxes | a run with no typing pending hands Ctrl+Z / Ctrl+Y to the editor's history (typing is still undone by the browser first) | spec 13 (undo then redo of a split) |
| Row above/below in a table with merged cells | one cell per column (overlapped spans: a defect) | the same overlap: the table stopped being editable | rows were added without the occupancy grid | `addRowSpanned`: a span crossing the new row covers it; other columns get named cells | spec 13 "rows in a table with merged cells"; unit "rows in tables" |
| Delete a row with a cell spanning down | dropped that cell (a defect) | same: its content was lost, rows below shifted | as above | `deleteRowSpanned`: spans from above shrink; a spanning cell moves to the next row with its content; a body keeps a row | spec 13, unit |
| Tab in a table cell | next cell | demoted the section around the table; focus lost | Tab always meant demote | Tab / Shift+Tab move between cells | spec 13 "Tab moves through table cells" |
| Column widths in lengths | widths applied | only `n*` shown; `40mm` ignored, `1*` mis-scaled | proportions were not totalled | lengths shown as lengths, proportions as shares of their total | spec 13 "column widths" |
| "None" in requirements | (edited in XML) | no way to replace it in Design | no command for choice groups | "Replace with <…>" for empty elements, "Change to <…>" keeping content (bulleted ↔ numbered lists); nothing with content is ever replaced | spec 13 "duplicate, change into, replace"; unit |
| Duplicate | "Add another" only | the same | not implemented | Duplicate copies with content; ids in the copy made unique | spec 13, unit |
| Missing artwork | — | a DOM node swapped behind React's back (a crash when the figure was later removed) | `onError` replaced the `<img>` | an `Artwork` component with its own state | spec 13 (delete and undo, no page error) |
| Reference to a module not in the project | — | not reported | no check | live check on the reference pill and in Review, Live checks (content only; the BREX reference is outside by design) | spec 13; unit |
| Re-sequencing ids | — | said "references follow" | other modules' `referredFragment` cannot be updated from here | the message says so | spec 12 (wording) |
| Typing after a refused action | the caret stays | the focus was lost; everything typed after was dropped (seen on a real procedure) | the text box was released for the action and not given back when it was refused | the caret returns to where it was | spec 14 "an action that is refused" |
| Cell range after clicking a short cell | the range holds | cleared half a second later (seen on a real spanned table) | releasing Shift reported the cell's paragraph, counted as another selection | the range lives while the same cell is selected | spec 14 "a cell range survives" |
| Data module reference with its issue, typed straight after | inserted in order | the next keystrokes were lost while the dialog read the target | the dialog waited, then the insertion released the text box | inserted at once (title from the module list); the issue added when read, without touching the text box | spec 14 "typed straight after at full speed" |
| Ctrl+S right after a reference with its issue | (no issue lookup) | the save went out before the issue had been read: saved without it, then shown unsaved | the save did not know about the change still on its way | a save waits for background changes (at most 5 s), then saves the text that includes them | spec 14 "Ctrl+S pressed while a reference's issue is still being read" |
| Typing after Ctrl+S | the caret stays | the focus went to the page body; keys typed during and after the save were lost | the text box was left to commit its text and nothing took the focus back | the caret goes back where it was as soon as the text is committed | same spec 14 test |
| Missing artwork in the PDF | — | the build succeeded but a figure kept only its caption, a symbol left a gap | FOP draws an image it cannot find as nothing | a dashed "Artwork not available: <file>" box in its place (PV39) | spec 16; unit `fo-placeholders` |
| Symbols in text | (generic element) | shown as `<symbol>` tags | not drawn | drawn as artwork, or "missing"; flagged when undeclared | spec 14 "symbols in the text"; spec 15 |
| Typing after an action | the caret stays in the text | the focus went to the page body after table tools, references and formats: keys did nothing until a click | the active text box was released for the action and nothing took the focus back | the caret goes into what the action selects, or just after the inserted reference or format | spec 14 |
| Shortcuts with nothing focused | Ctrl+H and the rest work | Ctrl+H, Ctrl+P, Ctrl+Shift+V did nothing after a dialog or a button | the shortcuts listened on the page only | they also listen on the window when the focus is nowhere | spec 14 |
| Text after a reference at the end of a paragraph | a caret position after it | none: nowhere to click or type | no text node after the element, so no text box | an empty text box after a trailing inline element, wide enough to click; a click beside the text goes to its end | spec 14 |
| Enter in a new section's title | the paragraph after the title | a second, empty paragraph was left behind | Enter always inserted | an empty paragraph already there is used; the same for Ctrl+Enter | spec 14 |

Verified working without change (probed in the browser): menu formatting, Ctrl+B on just-typed text, drafts offered after a reload, Design / XML / Design consistency, the PDF preview after merged cells and splits, find and replace (one and all), a list changed between bulleted and numbered.

## Real modules

`AGASTYA_REAL_MODULES=/path/to/folder npx playwright test e2e/15-real-modules.spec.js` runs every module in the folder through import, Design, a typed edit, save, reopen, validation and the PDF build, and a table and a procedure through further edits. Last run: 24 real modules (S1000D 4.2, descriptive and procedural, with DOCTYPEs, entities, symbols, spanned tables and missing artwork), all passing.
