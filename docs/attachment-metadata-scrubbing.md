# Scrubbing metadata from attachments (planned)

Files carry more than their content. A phone photo of a passport records where and when it was
taken and on which phone, and its embedded thumbnail can show the uncropped original. A PDF or a
Word file names its author, their company and the software they used. Inside the vault that is
encrypted like everything else, but an attachment leaves the vault whenever it is opened, shared or
saved, and whatever it carries goes with it. Settings → Security → Attachments → "Scrub metadata"
removes those details when a file is attached, so nothing identifying is stored in the first place.

Builds on [file-attachments.md](file-attachments.md); read its "FileSealer seam" and "The
extension" sections first.

## What the setting does

- **`pref.scrubFileMetadata`, synced, default on.** A synced setting rides the vault's encrypted
  payload, so turning it off on the phone turns it off for that vault everywhere (see
  [synced-settings.md](synced-settings.md)). Attaching only happens behind an unlock, so the
  locked-vault rule doesn't stop it being synced. On by default for the reason Block screenshots
  is (see [screen-capture-blocking.md](screen-capture-blocking.md)): what a password manager's
  attachments are (ID scans, statements, contracts) rarely needs its GPS fix, and a protection
  people have to find first protects few of them.
- **It applies when a file is attached**, from every place that attaches: an entry's Attach a file
  and the vault list's menu (#260). (The data model allows standalone Files items, but no screen
  attaches one yet; whichever does will go through `useAttach` and get this for free.) It changes
  nothing already in the
  vault, and it is not applied to files that arrive another way: imports (from another password
  manager or a `.bramble` file), moving an attachment to another vault, backups and restores, and
  sync. Those bring
  a file across exactly as it was, because they are copies of something the user already holds,
  not new files.
- **A file with nothing to remove is stored byte for byte as picked.**
- **The original file is never touched.** The desktop seals from the user's own file by path; the
  scrubbed copy is written to the cache, sealed, and deleted.

### The row

```
┌ 📎 Attachments ──────────────────────────────────────┐
│ ⌫  Scrub metadata                             [ on ] │
│    Removes location, device and author details      │
│    from files you attach.                            │
└──────────────────────────────────────────────────────┘
```

A section of its own in the Security tab, between the Security card and Rotate vault key. Shown
where this device can attach files (`useAttach().available`), so Firefox without a desktop link
doesn't show a switch for something it cannot do. Icons: `Paperclip` for the section (the attach
button's own), `Eraser` for the row.

### When metadata is kept

Some files can't be scrubbed without damaging them. Those are attached unchanged, and the attach
says so in one line under the button, where its errors already appear. It is a notice, not an
error: the file is attached.

| Case | Line |
|---|---|
| A signed PDF or Office document. Any change to the file breaks the signature, and a broken signature is worse than metadata. | Metadata kept: the file is signed. |
| An encrypted PDF. Its metadata is encrypted with it, and rewriting it means removing the encryption. | Metadata kept: the file is encrypted. |
| A supported type that doesn't parse, or whose scrubbed copy fails the check below. | Metadata kept: couldn't read the file. |
| A type known to carry metadata that Bramble doesn't scrub yet (TIFF, camera RAW, MP3, legacy `.doc`/`.xls`, SVG). | Metadata kept: this file type isn't supported yet. |

From the vault list's menu, which reports through toasts, the line is an info toast after the
"Attached" one.

Anything else (text, keys, certificates, archives, unknown bytes) has no embedded metadata to
speak of and attaches silently.

## Approaches considered

1. **One scrubber in Rust, run where the seal already runs.** (Chosen.) Every target already seals
   in Rust next to the file's bytes: the desktop shell from a path, the phones through uniffi from
   a spooled path, the extension's crypto host from IndexedDB through wasm. A scrubber beside the
   sealer keeps the attachments rule that file bytes never cross an IPC or FFI boundary, and gives
   one implementation with one test suite for five targets.
2. **A TypeScript scrubber in `packages/core`** (EXIF, PDF and ZIP libraries from npm). It would
   pull every attachment through the webview: on the desktop the bytes never enter it today, and
   the bridges are the 0.5 MB/s cliff file-attachments.md designs around. It also adds three
   parsers of hostile input to the UI bundle.
3. **Re-encoding images** (decode, redraw, encode). Strips everything by construction, but every
   pixel of the picture itself is re-compressed and loses quality, color profiles go, it can't
   decode HEIC in a browser, and it does nothing for documents. (The chosen approach does drop
   a JPEG's optional HDR layer, below, but leaves the picture itself bit for bit.)
4. **Each OS's own media APIs** (ImageIO, ExifInterface). Five implementations with five different
   results, and no equivalent in a browser extension.

## The scrubber: `core-rust/src/scrub/`

VEK-free and I/O-free, like `files.rs`. One entry point:

```rust
pub fn plan(src: &[u8]) -> ScrubPlan

pub struct ScrubPlan { pub outcome: Outcome, pub edits: Vec<Edit> }
pub enum Edit { Keep { start: u64, len: u64 }, Insert(Vec<u8>) }
pub enum Outcome {
    Scrubbed,                 // edits produce the clean file
    Clean,                    // supported, nothing to remove; edits empty, use the original
    Kept(KeptReason),         // Signed | Encrypted | Unreadable | Unsupported; use the original
    NotApplicable,            // no embedded metadata to speak of; use the original
}
```

Across every binding the outcome is one string: `scrubbed`, `clean`, `not-applicable`,
`kept-signed`, `kept-encrypted`, `kept-unreadable`, `kept-unsupported`.

The input is the whole file in memory, at most `MAX_ATTACHMENT_BYTES`, and verifying (below)
materializes the scrubbed copy once more, so a scrub peaks at about twice the file's size. That is
bounded by the 90 MB limit and short-lived, unlike the seal, which never holds more than two chunks.

The format is sniffed from magic bytes, never from the name or MIME type, and the ZIP subtypes
from their contents (`[Content_Types].xml` for Office Open XML, a stored `mimetype` entry for
OpenDocument). An ordinary `.zip` is not an Office file and is left alone.

**Why an edit list rather than output bytes.** For every format except PDF a scrub is "drop these
spans, insert these few bytes", so the plan is a few dozen entries however large the file. The
extension turns it into a `Blob` built from slices of the original, which copies nothing, and the
native side streams it from the source file to the scrubbed copy. It also makes the most important
property structural: every byte outside a removed span is the original's, in order, so pixel data,
scan data, movie samples and page content can't change. A PDF rewrite is the exception and is one
`Insert` holding the rewritten file.

### Safety rules

- **Removed means erased.** Nothing removed may survive anywhere in the file's bytes, referenced or
  not, because "removes location" has to hold for someone running `strings` on the file. Where a
  format is edited in place (HEIC, MP4), a removed box keeps its size, becomes `free`, and has
  every payload byte zeroed; a removed metadata track's samples in `mdat` are zeroed too. The
  tests search every scrubbed fixture's bytes (decompressed, for ZIP entries and PDF streams) for
  the fixture's fake location, names and device, and find none.
- **Verify, or keep the original.** The scrubbed copy is planned again, and must come back `Clean`.
  ZIP-based files must also list the same entries with the same CRCs apart from the metadata parts
  and images rewritten on purpose; a PDF must have the same page count and byte-identical page
  content streams. Any failure is `Kept(Unreadable)`, and the original is attached.
- **No panics.** These are parsers of untrusted input. The module denies `clippy::indexing_slicing`,
  `unwrap_used`, `expect_used` and `panic`, and every length is checked arithmetic. A truncation
  and bit-flip sweep over every fixture must end in an outcome, never a panic. Native callers also
  run it inside `catch_unwind`, for the third-party parsers.
- **Signed and encrypted files are never rewritten.** Signed: a PDF with a `/ByteRange` signature
  dictionary or `/SigFlags`, an Office file with `_xmlsignatures/`, an OpenDocument file with
  `META-INF/documentsignatures.xml`. Encrypted: a PDF with `/Encrypt`.
- **Orientation survives.** A photo whose EXIF says "rotate 90°" would show sideways without it, so
  where EXIF is removed, a minimal EXIF holding only `Orientation` is written back when it wasn't 1.
  Nothing else in it.
- **The size limit holds.** A scrubbed copy over `MAX_ATTACHMENT_BYTES` (a PDF rewrite can grow) is
  discarded and the original attached, as `Kept(Unreadable)`.

### What each format loses

| Format | Removed | Kept |
|---|---|---|
| JPEG | EXIF (GPS, time, camera, serial numbers, embedded thumbnail), XMP and extended XMP, IPTC/Photoshop (APP13), Content Credentials (APP11), comments, APP3-APP15 other than the kept ones, MPF, and everything after the end-of-image marker (motion-photo video, HDR gain maps, Samsung's trailer) | Image data, JFIF density, ICC profile (APP2), Adobe APP14 (needed to decode CMYK), Orientation |
| PNG | `tEXt`, `zTXt`, `iTXt` (author, software, XMP), `eXIf`, `tIME`, `caBX` (Content Credentials), unknown ancillary chunks | Critical chunks, color and rendering chunks (`iCCP`, `sRGB`, `gAMA`, `cHRM`, `cICP`, `mDCv`, `cLLi`, `sBIT`, `bKGD`, `tRNS`, `pHYs`), APNG chunks, Orientation |
| WebP | Every chunk but the kept ones: `EXIF`, `XMP `, `C2PA` and unknown chunks, with the VP8X flags cleared and the RIFF size fixed | `VP8 `, `VP8L`, `VP8X`, `ALPH`, `ANIM`, `ANMF`, `ICCP`, Orientation |
| GIF | Comment extensions, application extensions other than looping (`NETSCAPE2.0`, `ANIMEXTS1.0`), which removes XMP | Everything else |
| HEIC, HEIF, AVIF | The `Exif` item's payload (replaced in place by an EXIF holding only Orientation, zero-padded to the same length), XMP `mime` items (replaced by an empty XMP packet, space-padded), and the Content Credentials `uuid` box (`D8FEC3D6-1B0E-483C-9297-5828877EC481`, freed and zeroed) | Everything else, byte for byte: no offset moves, so `iloc` stays valid. Rotation lives in `irot`/`imir`, and HDR gain maps and depth are image items, all untouched |
| MP4, MOV, M4A, 3GP | `udta` and `meta` boxes under `moov` and each `trak`, a top-level `meta` in a non-HEIF file, XMP and Content Credentials `uuid` boxes, and timed-metadata tracks (handler `meta`: an iPhone video's per-frame location), each renamed to `free` in place with its payload zeroed; that track's samples in `mdat`, found through its sample tables, zeroed; creation and modification times in `mvhd`, `tkhd` and `mdhd` zeroed | Every audio and video sample, every offset |
| PDF | The `/Info` dictionary, every `/Metadata` stream (document, pages, images), `/PieceInfo`, `/LastModified`, EXIF and other APP segments inside embedded JPEG images (`DCTDecode` streams, through the JPEG scrubber), and earlier revisions of an incrementally saved file. `/ID` is regenerated | Pages, fonts, forms, annotations, outlines, attached files. A PDF/A or PDF/UA file keeps a document XMP holding only its conformance identification (`pdfaid:part`, `pdfaid:conformance`, `pdfuaid:part`), uncompressed, and a PDF/A-1 file is written without object or xref streams, so it stays conformant |
| Office Open XML (`.docx`, `.xlsx`, `.pptx`) | `docProps/core.xml` (author, last modified by, dates, title, subject, keywords, revision, last printed), `docProps/app.xml` (company, manager, template, editing time, application), `docProps/custom.xml`, each emptied to its root element; image metadata in `*/media/*` and `docProps/thumbnail.*`; ZIP entry timestamps (set to 1980-01-01) and extra fields | Every other part, raw, without recompressing |
| OpenDocument (`.odt`, `.ods`, `.odp`) | `meta.xml` emptied to `<office:meta/>`; image metadata in `Pictures/` and `Thumbnails/`; ZIP timestamps and extra fields | `mimetype` first and stored, as the format requires; every other part, raw |

**Two losses that are chosen, not accidental.** A JPEG's HDR gain map and a motion photo's video
live after the end-of-image marker, described by MPF and XMP, and each carries metadata of its own.
Keeping them would mean scrubbing the secondary images and the video and rewriting the offsets
that describe them, for photos whose job in a vault is to show a document. So the picture stays
bit for bit and shows in standard range, and a motion photo becomes a still. **Content
Credentials** (C2PA, which recent phone cameras sign every photo with) are removed like any other
metadata: they record the device and the capture, and a scrub that edited around them would leave
a credential whose signature no longer matches, which is worse than none. The scrubbed photo looks
like one from a camera that never signed.

**Not removed, on purpose, and said so in the help article:** comment and tracked-change authors
inside Office and PDF documents, form values, and names inside a document's own text. Those are
content: removing them changes what the document says, which is a different feature (Word's
Document Inspector) from removing what the file says about itself.

### New dependencies

- `lopdf` (MIT), `default-features = false`, for the PDF rewrite. Parsing and re-serializing a PDF
  correctly is not a few hundred lines, and the verify step above guards against its mistakes. It
  is the heavy one: 0.47 brings `nom`, `brotli-decompressor`, `encoding_rs`, `getrandom` 0.4 and
  second majors of `aes`, `cbc` and `sha2` beside the crate's own. The newest release whose
  RustCrypto majors match the crate's is preferred if it has no open advisory; otherwise the
  duplicates are accepted. The size each binary gains (scrub wasm, desktop, the iOS app and its
  AutoFill extension, which link the same library) is measured and recorded when it lands.
- `zip` (MIT), `default-features = false, features = ["deflate-flate2"]`, reusing the `flate2`
  already in the crate for KDBX. `quick-xml` is already there too.

JPEG, PNG, WebP, GIF and ISOBMFF are walked by hand: each is a short loop over length-prefixed
segments, and owning it is what gives exact control over the keep lists and the edit list. No
image-decoding crate is added; nothing is decoded.

## Where it runs

`FileSealer.seal` takes `{ scrub: boolean }` and returns the outcome **beside** the sealed fields,
never inside them: `withSealedFiles` spreads `SealedFile` into the persisted `FileRecord`, so an
outcome placed there would be written into every vault. `useAttach` reads the pref and passes it;
imports and moves never set it.

### Desktop

`files_seal` gains `scrub`. When set, `ops::seal` plans from the picked file, writes the scrubbed
copy to `cache/open/<token>/plaintext`, the same swept folder `seal_bytes` uses for an import's
plaintext (cleared on every lock and at startup), seals from there, and removes the folder whatever
happens. `Clean`, `Kept` and `NotApplicable` seal straight from the picked path, as today.

### Phones

A uniffi `scrub_file(src_path, dst_path) -> ScrubOutcome` in core-rust's `ffi_exports`, exposed by
`NativeCrypto` on both platforms. The mobile sealer already spools the picked Blob to
`Cache/seal/<uuid>`; it scrubs that into `Cache/seal/<uuid>.clean`, seals the clean copy when there
is one, and its existing `finally` drops both. Same cache dir, same startup sweep, no new place for
plaintext to live.

### Extension (Chrome, and Firefox while linked)

`CRYPTO_FILE_SEAL` gains `scrub`. The crypto host reads the parked Blob, and when scrubbing, posts
it to a **dedicated Worker** (`scrub-worker.ts`) that loads a scrub-only wasm build, plans, and
posts the plan back. The host builds the scrubbed Blob from slices of the original and the plan's
inserted bytes, terminates the worker, and seals that Blob exactly as it seals today.

The worker, rather than the crypto host's own wasm, is the point, for three reasons:

- **A trap in a parser costs nothing.** A panic in wasm traps the instance, and the crypto
  instance's state can't be trusted after one. A scrubber running there would let one malformed
  PDF break every crypto operation until the host restarts. A worker that traps, errors or runs
  past its deadline is terminated and the file attached as `kept-unreadable`.
- **Hostile-file parsing never shares memory with a vault key**, and wasm memory never shrinks: a
  90 MB video copied into the crypto instance would keep it 90 MB larger for its lifetime.
  Terminating the worker frees all of it.
- **The crypto host stays responsive.** Parsing a large PDF can take seconds; sync and unlock keep
  being answered meanwhile.

The scrub-only wasm is built from the same crate with `--no-default-features --features
scrub-wasm`, by a second `wasm-pack` run into `public/wasm-scrub/`, so the scrubber's code lives
once in the repository, pinned by the one `Cargo.lock`. `lopdf` and `zip` are optional
dependencies behind a `scrub` feature that `native` and `scrub-wasm` turn on and the main `wasm`
build does not, so the crypto bundle the extension and the phones' webviews load doesn't grow.
Both wasm builds go through the reproducible-build flags (see
[reproducible-builds.md](reproducible-builds.md)).

## Testing

- **Rust, per format:** fixtures built in the test (synthesized segments, `zip` and `lopdf` writing
  their own inputs) plus a few real ones committed under `core-rust/tests/fixtures/scrub/`: an
  iPhone HEIC and MOV, a Pixel motion photo, a Samsung JPEG with its trailer, Word, Excel and
  LibreOffice documents, a scanner app's PDF with EXIF inside its images, a signed PDF and an
  encrypted one. Location and names in the fixtures are fake. Each test asserts what's gone, what
  stays, byte identity of everything outside removed spans, idempotence, and the outcome.
- **No-panic sweep** over every fixture, truncated at every length up to 4 KiB and with bit flips.
- **An independent check while developing:** `exiftool -a -G1` on each scrubbed fixture lists no
  location, device, author or date tags. It is a dev-time oracle, not a CI dependency.
- **Each target:** a desktop `ops::seal` test with `scrub`; an Android instrumented test through
  the real uniffi binding, like `FileSealInstrumentedTest`; a Playwright spec that attaches a photo
  with GPS in the extension, downloads it back, and finds no EXIF location, then repeats with the
  setting off and gets the file back byte for byte.

## Not in this design

- **Scrubbing files already in the vault.** It would reseal each one under a new hash and resync
  it to every device. A "Scrub existing attachments" action can come later on top of the same
  scrubber.
- **The types listed as kept above** (TIFF, RAW, MP3, legacy Office, SVG) and document content
  (comment authors and the like).
- **Showing which attachments were scrubbed.** No field is added to the sealed metadata.
