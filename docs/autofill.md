# Autofill

How stored credentials reach a web page: the index, hostname matching, the fill
model, and the corner prompt for capturing new logins. Types and the adapter
contract are in `packages/core/src/adapters/autofill.ts`; the page-side logic is
in `content-script.ts`; matching and the dedupe decision live in `background.ts`.
Field detection (which page inputs are what) is its own doc:
[field-detection.md](field-detection.md).

## The index

When the vault unlocks, the popup pushes a searchable **index** of logins and
cards to the background service worker (`setIndex`), so autofill works while the
popup is closed. The index is cleared on lock. It is decrypted plaintext and is
held in background memory only, never persisted (see [storage.md](storage.md)).

- **Logins** are matched to a page by hostname. Each login carries the list of
  hostnames it is registered against, derived from its URLs at index-build time
  with empty or unparseable URLs dropped. One login can cover many sites.
- **Cards** are not tied to a hostname. Every stored card is offered on any
  detected payment form.
- **Notes and SSH keys** never participate in autofill.
- **Tags** are not in the index at all. They organise a vault; they say nothing about
  which credential belongs to a page, so indexing them would only copy organisational
  metadata into background memory for no matching benefit.
- **Archived entries** are excluded, passkeys included. Archiving is how a user
  retires a credential without deleting it, so an archived entry must not be
  offered, matched, or counted anywhere in the fill path.

The archived rule has to be written three times, because three places build an
index and only one of them consumes the others' work:

1. `core/vault/autofill-index.ts` (`toAutofillIndex`), the projection every view
   pushes. It also feeds the iOS credential provider through `setIndex`, so
   filtering here removes archived entries from the OS QuickType and passkey
   identity stores as well.
2. `clients/extension/background/autofill-index.ts` (`hydrateIndexForOwner`),
   which rebuilds from the vault file when no view has pushed an index.
3. `clients/mobile/android/.../VaultReader.kt` (`readLogins`, `readPasskeys`),
   which reads the vault file directly through uniffi and never sees the
   TypeScript index at all.

Passkey lookup and placement are filtered once, in `core/vault/passkey.ts`
(`findPasskeys`, `loginsCoveringRpId`), which covers the extension's WebAuthn
provider on both deliveries.

A content-script `query` says which field kinds the page exposes (`hasLogin`,
`hasCard`, `hasOtp`), so the background only returns the relevant lists. Query
summaries and selected fill payloads return only on that initiating runtime
request's one-shot response channel. They are never later addressed to a tab or
frame: a frame can navigate and retain its frame id while its document changes.
The content script keeps each selection as a one-shot intent bound to the exact
field it was picked from. Lock-state changes, pagehide (including bfcache), a
hidden or unfocused page, trusted user interaction, replacement fields, and
extension teardown cancel that intent. The optional 50 ms auto-submit continuation
is similarly bound to the same live password field and rechecks for CAPTCHAs.

## Hostname matching and subdomain policy

`hostnameMatches` (background) returns true when the page hostname matches any of
a login's registered hostnames under that entry's **subdomain match** policy:

- `etld1` (default): the registrable domain and all its subdomains. The boundary
  is the full Public Suffix List **including its private section**, so tenants of
  shared hosts (`alice.github.io`, `x.vercel.app`, `y.pages.dev`) are separate
  sites. tldts leaves the private section out by default, which collapsed every
  tenant to `github.io` and offered one tenant's login to all the others
  (GHSA-rf5w-r5j3-6wmf).
- `exact`: that exact hostname only, and, for a saved URL that names a port, only
  that port (issue #131).
- `subdomain`: this domain plus its subdomains.

The query hostname is derived from the **verified message sender**
(`sender.origin` / `sender.url` / `sender.tab.url`), not from the message body, so
a content script cannot request matches for a different domain.

### Ports under `exact`

Several services on one local host (`nas.local:5000` and `nas.local:9000`, or
`192.168.1.10:8080` and `:9000`) each want their own login. Under `exact`, a saved
URL with an explicit port matches only a page served on that port; one without a
port matches the host on any port, as before. Default ports are no port:
`https://nas.local:443` reads the same as `https://nas.local`, and a page with no
port is compared on its scheme's default (80 or 443). `etld1` and `subdomain`
ignore ports.
This is Bitwarden's "Host" match detection per login, and a Bitwarden import that
used Host (or any non-default mode) already lands on `exact` with its URLs intact.

Every import also lands a login on `exact` when its one website names a port and
the source file left the mode unset (issue #145), whichever format it came from:
the file importers, KeePass `.kdbx` and credential exchange all return through
`summarize` in `import/shared.ts`. Bitwarden's global "Default URI match detection"
is not in its export, so a vault set to Host there arrives unset. A login with
several websites stays on the default, since `exact` would narrow the others too;
an app link doesn't count as one. A mode the file did choose is kept, and
Bramble's own `.bramble` restore is left alone. Entries imported before this keep
`etld1`; re-importing doesn't fix them, since dedup holds the same login back.

There is no separate mode for it on purpose: `subdomainMatch` is persisted and
synced, so a new enum value would be a format change that released clients reject.
The port rides the index instead (`LoginIndexEntry.ports`, lined up with
`hostnames` by `loginHosts`), which the extension holds in memory only. A URL
saved without a scheme (`nas.local:5000`) is read as https (`withScheme` in
`util/url.ts`), so it gets its host and port like any other; `URL` alone takes
`nas.local` for the scheme and finds no host at all.

Every page-side caller passes the page's port: the content-script query and fill
authorization, the corner prompt's dedupe and update check (the port is stashed
with the capture), and the popup's matches for the current tab. `AUTOFILL_FIND`
takes a hostname only, so it never offers a port-pinned login. Not port-aware:
the locked-state hint (an eTLD+1 hint only), the desktop app's link query and
panel fill check (`index_store.rs` `query`, `socket.rs` `spotlight_request_fill`,
which compare bare hostnames), and both mobile providers. Android's
`AutofillService` gets `webDomain` with no port, and the iOS provider normalizes
the service identifier to a bare host; both also ignore `subdomainMatch`, so on
mobile two logins on one host are still offered together.

### App URIs are not web hosts

An entry's URL list can contain identifiers for a mobile app rather than a
website. Bramble never writes these, but importers carry them through verbatim:
`androidapp://com.example` is Bitwarden's convention, `android://<cert-hash>@com.example`
is Google Password Manager's. `isAppUri` recognises them and `extractHostname`
returns empty for them, so they stay out of the match index and out of the
persisted known-hostname registry.

Before that, the package name was indexed as if it were a hostname:
`androidapp://se.skanetrafiken.washington` became the "host"
`se.skanetrafiken.washington`, which `registrableDomain` reduced to
`skanetrafiken.washington`. That could never match a page, but it was stored,
persisted and counted toward the locked-state "you probably have a login here"
hint (issue #46).

The browser match index still ignores them; what changed is the Android **native**
matcher: the entry's `androidapp://` / `android://` app ids are projected and a
native-app caller matches by **exact package equality** (the "fill and save" flow
records such a URI on a confirmed pick; see docs/mobile-port.md). An
`android://<hash>@<package>` URL additionally pins the signing cert, and browsers
off the trusted list get no package matching at all. Unchanged: a package is never
reversed into a domain, other platforms' schemes are not Android identities, and the
extension and iOS provider never see app URIs.

### Why a package name is never turned into a domain

Reversing a package name looks like it would fix cross-platform matching:
`se.skanetrafiken.washington` reverses to `washington.skanetrafiken.se`, whose
registrable domain is `skanetrafiken.se`, which is correct here. It is not sound.
`com.google.android.youtube` reverses to `google.com`, not `youtube.com`, and
nothing stops an app from choosing a package name in someone else's namespace.

Android already declines the equivalent inference in the other direction, with a
written rationale in `StructureParser.kt`: `webDomain` is attacker-controllable
and the package name is not a web identity, so a non-browser caller gets no
host-based auto-match at all and the user opens the full searchable list instead.
Deriving domains from packages in the extension would put the browser in the
position of trusting a binding the mobile app refuses to trust.

Digital Asset Links (`https://<domain>/.well-known/assetlinks.json`) is the
standard way to make the binding authoritative, and was considered and rejected
for now: it needs a network fetch per domain from the extension, which leaks
which sites the user holds entries for, and it exists to enable *silent*
matching, which is the part Android declined.

### Planned: offer the link instead of inferring it

Not built. When an entry holds an app URI whose reversed package resolves to a
real registrable domain, the entry editor should offer to add that website —
"this entry came from an Android app that looks like skanetrafiken.se, add it?"
— rather than matching on it silently. One click writes an ordinary `https://`
URL and the existing matcher takes over, with no new matching path, no network
call, and the guess visible to the person who can confirm it. `appIdFromUri`
exists for this and has no other caller.

## The fill model: secrets fetched only on explicit pick

A single login match does **not** auto-inject the password on page load. Doing so
would put the password in the DOM where scripts on a cross-registered domain
could read it. Instead:

1. On focusing a candidate field, the dropdown shows the matching entries
   (`query` returns only summaries: name plus a username or masked `•••• 1234`).
   Typing into the username field narrows the list to entries whose saved
   username matches; a value the field already held before the user typed
   (a page pre-fill, an autofocus default) does not count as a search.
2. The user picks one.
3. Only then does the page-bound `AUTOFILL_SELECT` response return the actual
   secrets for that entry.

Cards always used this safer pattern; logins and OTP codes follow it too. The one exception is
"Open website" in the vault, where choosing the login is the pick: see
[launch-and-fill.md](launch-and-fill.md).

The pick must be a **trusted gesture**: the dropdown's `mousedown` handler bails
on `event.isTrusted === false`. Without this, page script could dispatch a
synthetic `mousedown` at a dropdown row to drive `fetchFill` and read the filled
value back. It matters most for cards, which are offered on every site (not
hostname-scoped), so any page could otherwise have silently exfiltrated every
stored card. The capture listeners gate on `isTrusted` for the same reason.

The background re-checks the pick as defense-in-depth (`authorizeFill`): on
`AUTOFILL_SELECT` it resolves the chosen entry and, **for a login**, requires
`hostnameMatches` against the *verified sender* before returning secrets on the
same request's response channel, so a
leaked or guessed entry id can't be filled on a non-matching site. Cards are
deliberately exempt (site-agnostic by design); their only barrier is the
trusted-gesture gate above, plus the visibility/anti-overlay checks that arrive
with the iframe UI. The adapter's request/response path (`AUTOFILL_FIND` /
`AUTOFILL_FETCH`, used by the popup) trusts the hostname in its body, so it is
restricted to **extension-origin senders**: a content script must use the
sender-verified `AUTOFILL_QUERY`/`AUTOFILL_SELECT` pair instead.

Per-login overrides ride on the summary: `autofillEnabled = false` means the
content script must not silently single-match auto-fill (the user must pick from
the dropdown), and `autoSubmit` means submit the form after filling. Auto-submit
is suppressed when an interactive captcha is present (see
[field-detection.md](field-detection.md)).

TOTP codes are computed in the background; only the resulting digits are filled,
never the seed. See [totp.md](totp.md).

## Reaching the list: quiet by default

`pref.autofillTrigger` (Settings -> General -> **When you click a login field**) chooses how the
picker is reached. It is device-scoped because the background reads it on every query, including
while the vault is locked.

| mode | on focus, hover, or typing | what is drawn |
| --- | --- | --- |
| `icon` (default) | nothing opens | a bramble berry inside the field, with the match count, plus a username completion |
| `focus` | the list opens | the same mark, with the list as before |
| `shortcut` | nothing | nothing; the browser command fills and the pick chip confirms it |

The pre-icon `auto` value still found in storage from an older build reads as `focus`, not as the
new default: an existing user who chose click-to-open keeps it.

The mark is a closed-shadow host pinned to the field (`content/affordance.ts`). One host carries
the mark, the completion, the one-time hint and the pick chip, so there is one rAF tracker and one
teardown. It has **no fill path**: a click only calls the same `showFor` the focus path uses, and a
fill still needs a trusted click inside the picker or the browser command. A locked vault is the
one branch: the mark opens the unlock pop-out directly instead of drawing the locked row, which is
the focus-mode path. `pointer-events: none`
on the host and `auto` on the 26px button keeps the rest of the field clickable. Chromium paints
its own key/eye icons at the inline end, so the mark is inset 30px there; Firefox has no in-field
icon and uses 8px. A site can add its own clear or reveal-password control at that same spot once
the field has a value. The mark hit-tests its centre and steps left in 26px increments until the
spot belongs to the field or to our own host, and the 26px click zone follows the same inset. A
control sitting under the mark would otherwise take the click, which is what made the second pick
on a filled field do nothing.

The mark is the Bramble berry drawn in the field's own ink, not a fixed black: it stays legible on
a light or a dark field. Its centre carries the number of entries the field would list (cards or
one-time codes on those fields, logins otherwise), capped at `9+`; a generated password, an alias,
or a locked vault has no entry count and leaves the centre plain. The number is drawn inside the
closed shadow root, so the page cannot read how many accounts match it.

The entry name is never a tooltip under the input. On a pick, the mark grows a small chip to its
left with the entry name, holds it for 2s, then scrolls it into the berry over another 2s and hides.
The chip borrows the field's ink and font, so it reads as part of the form. A keyboard cycle uses
the same chip without the 2s slide: a short hold and a 160ms fade, because the cycle is a repeated
shortcut. With `prefers-reduced-motion` the 2s read is kept but the exit is a 200ms fade in place.

The mark's 26px zone stays live on the field itself, not only on the host element. A click in
that zone opens the field's list even when the host is not over it at that instant: the menu is
collapsing over the field, or the pointer has just arrived. This is what makes the filled password
field's mark work immediately after the username menu closes, instead of the click only focusing
the field.

While a menu is open it can cover the next field's mark. A click on the left half of that mark
switches the menu to the field instead of picking the row under the pointer. The row's own "Open
in Bramble" button sits over the mark's right half, so only the left half means switch; the button
keeps the rest of its hit area. The content script maps the click from the iframe to the page and
checks the field under it, so the switch works in both the iframe and shadow renderers.

The mark and chip use the field's inline end (`inset-inline-end`), not a physical side. On an RTL
field the mark sits at the left, the chip slides in from the left with `-100%`, and the mark-zone
hit test mirrors. The chip drops its 124px value reserve below 240px, so at 200% zoom it overlays
the value for its 2s confirmation instead of collapsing to a few pixels.

The mark is not a tab stop: Tab keeps its native focus move. A keyboard user opens the same menu
with `Alt+ArrowDown` on a candidate field. While the mark is up the field carries
`aria-haspopup="listbox"` and `aria-expanded`, and the highlighted row is announced through a
persistent visually hidden live region. `Ctrl`/`Cmd`+`Enter` on a highlighted row opens its details,
so the row's secondary action is not pointer-only. The menu is drawn in an iframe (or a closed
shadow root), so `aria-activedescendant` cannot reference its rows across that boundary; the live
region is the announcement path, and `aria-expanded` carries the open/closed state.

A pick also ends the typed-filter session. The field now holds the chosen username, so clicking the
mark again lists every login for the site rather than filtering down to the entry just filled;
typing in the field starts a new filter.

The first time the mark appears on an install, a one-time hint says what it is ("Saved logins for
this site", "Locked: click to unlock and fill"). The content script reports that it was shown;
the background owns `pref.autofillIconHintSeen` and stops sending `hint` after that, so the hint
cannot follow the user from site to site and a page that never draws it cannot suppress it
elsewhere.

### Inline username completion

In `icon` mode, the best matching login's username is painted as ghost text after what the user has
typed. It is username-only by construction: the password field never gets a completion, because a
completion there would reveal the password's length and characters. It appears only while the
username field is focused, the caret is at the end of the value, and a saved username starts with
the typed text. The ghost lives in the mark's closed shadow root, so the page cannot read which
account is being suggested.

Tab is deliberately not involved: it keeps its native focus move. Enter accepts the completion:
the whole login for that entry is fetched through `AUTOFILL_SELECT` and filled, so the completion is
a selection gesture rather than a half-done pick. The password is never written from the ghost
itself; it comes from the same hostname-authorized fill path as a click. (Earlier builds wrote only
the username, which read as half an action: the user had chosen the entry and still had to fetch
the password.)

With the menu open and a username typed, Enter takes the top filtered login and fills both fields.
An arrow-highlighted row wins on Enter; an empty or page-prefilled field keeps Enter as the form's
submit, so a credential is not filled just by focusing.

With the menu closed, Enter takes the visible completion. On an empty field the ghost is the whole
suggested username, so Enter fills that login; on a non-empty field the value must have come from
the user's own typing. A value the page pre-filled (or the browser's own autofill wrote) does not
turn the submit key into a Bramble fill.

A fully typed username that exactly matches a saved login also fills on Enter. There is no ghost in
that case (the value is not a strict prefix of itself), but the value is already a selection. The
fill is skipped when the password field holds a value, so a typed or browser-filled password keeps
Enter as the form's submit.

### The adaptive skin

The menu used to be a 16px-radius white card on every site, which read as an extension floating
over the page rather than part of the form. `content/skin.ts` reads the anchor field's computed
style and returns a small `DropdownSkin`:

- **radius**: clamped to 16px; a pill-shaped field is capped at 10 so the menu is not a lozenge.
- **surface**: the field's effective background (walking ancestors through a transparent field),
  **lifted** toward the popover: 72% white for a light field, 22% of an elevated grey for a dark
  one. Borrowing the field's exact fill made the menu read as another form control - on a grey SaaS
  field it looked flat - while the radius, border and font still make it belong to the form.
- **ink**: the field's text colour, with a 4.5:1 contrast floor against the lifted surface.
- **muted**: a softer ink for the username, badge and row actions, still at 4.5:1 against the
  lifted surface. A fixed theme grey broke on a dark field under a light OS.
- **border**: the field's border colour when it has a visible one; otherwise the renderer derives
  a hairline from the ink.
- **font**: the field's family only. Size, weight and colour stay ours, so a tiny or huge page font
  cannot shrink or blow up the menu.
- **dark / compact**: for shadow strength, `color-scheme` and row height.

The monogram is one treatment, tinted from the field's own ink, the way the vault list draws its
avatars. A per-entry colour palette put nine fixed hues on a menu that otherwise borrows the site's
palette; the initials already identify the row, so colour only competed with the name.

Every colour is parsed and re-serialized and every length is clamped before it reaches a
declaration, so a page can make its own menu ugly but cannot inject CSS through it. `skinKey` is
part of the render cache key, so a theme switch that changes the field repaints. The skin itself is
cached for a second per field: it costs several computed-style reads and a canvas colour parse, and
a render happens on every keystroke that changes the filtered list.

In the quiet mode the menu is the one-line compact layout: a 30px monogram, the entry name and the
username on one line, 62px rows (a 64px first-paint estimate) and generous padding. In `focus` mode the two-line row with the
40px avatar stays, except on a field shorter than 38px. The keyboard legend is deliberately gone:
the arrow/Enter path still works, and the shortcut is documented in Settings rather than as `↑↓ ⏎
esc` chrome in the menu. A fresh open gets a 160ms unfold; a filtered re-render does not, so typing
in a field never replays the animation.

### Last used here

A successful login fill remembers the entry for its **registrable domain** in
`autofill.loginCarry` in `chrome.storage.session`. The next query for that site returns it as
`carriedLoginId`, and the content script moves it to the head of the filtered list and marks the row
"Used here" (a text badge in normal rows; a dot with the same title in the compact one, where the
words would crowd out the name). The card carry is the same idea per tab (see "The card the tab already used"); the
login carry is per site because a login is used again across visits and tabs.

Initials come from grapheme clusters and skip Jr/Sr suffixes; a nameless entry uses its
username, or "Saved login" when both are empty.

Security and lifetime:

- The stored value is `{site: {vaultId, entryId, at}}`: an opaque entry id and the site's
  registrable domain, never a username, password, or entry name. Session storage is memory-only and
  cleared when the browser closes; it is not written to disk, and content scripts cannot read it.
- The background returns the id only when it is already one of the logins in that hostname's query
  response (`result.logins.some(...)`), so a carry can change the order and the badge of a row,
  never what is offered. A page cannot read the query response or the menu.
- It is scoped to the active vault (`vaultId`) and cleared with the index on lock. The map is capped
  at 100 sites (oldest write evicted) and expires after 30 days; the browser session usually ends
  first.
- A menu pick refreshes the query after the fill so the next open leads with the picked login. A
  rapid keyboard cycle does **not** refresh (`selectMatch(..., { refresh: false })`): reordering the
  list under the cycle would make the next press repeat the entry just filled. The carry is still
  recorded and lands on the next natural query.

The mark's ghost completion and the cycle both read the same ordered list, so the username preview
and the first shortcut press also start with the site's last-used login.

### Placement and height

The menu opens below the field unless the space there is smaller than the menu and the space above
is larger, in which case it flips above; the entrance animation follows the direction. The first
frame uses an estimated height (the row count and the compact/normal row height), so a field near
the bottom does not flash below and then jump.

The mark and picker hosts are `position: absolute` children of `<body>`, so their translate counts
from their containing block's origin, not the viewport. Usually that is the document origin minus
the scroll offset, but a page that positions `<html>` or `<body>` (a dialog scroll lock, a fixed
body, a transformed wrapper) moves it. `host-offset.ts` probes the origin with an untranslated 0x0
box beside the host, and the mark, the local picker and the relay host all place themselves through
it. Without the probe, USPS's scroll-locked login page drew the menu about 120px to the right of
the fields.

The menu is also capped to the larger of the two gaps, not just the design's 380px. A menu taller
than both the space above and below used to stay below at its full height and clip against the
window edge; now it draws at the cap and scrolls inside itself, so the bottom border and the last
row are always reachable. The cap is recomputed on every position frame and sent to the iframe when
the viewport changes.

The menu adapts to its own width with container queries, so 200% zoom does not turn the entry
name into a single character. Below 320px the carried badge collapses to its dot; below 260px the
compact row stacks the name over the username; below 220px the avatar is hidden. At 200% zoom on a
320px screen the menu is ~152px wide and the name still gets ~66px, with the open action reachable.

The match list itself is capped at 50 rows. A site with 1,000 saved logins should not put 1,000
DOM rows in an iframe for a menu that shows six; typing narrows the list, and a "Keep typing to
narrow the list" note after the 50th row says why it ended. The query response is capped at 200
matches per kind before it leaves the background, so the structured clone and the per-keystroke
filter stay bounded as well. The width is also clamped to the viewport, so the 280px compact floor
yields at 200% zoom on a narrow screen.

The iframe's list is watched with a `ResizeObserver`. A webfont that arrives after the first paint,
a browser zoom, or a scrollbar appearing can change the list's height; without the observer the
parent keeps the pre-change height and the last row (or the bottom border) is cut off on exactly
the sites whose form fonts load late. The relayed host re-places itself on the same height report.

### Opening an entry from a row

Each match row carries a small "Open in Bramble" action (an external-link glyph at its trailing
edge). It shares one trailing slot with the "Used here" badge: at rest the badge shows and the
action stays out of sight; hovering the row, or moving the keyboard highlight onto it, swaps them.
The slot is one grid cell, so the row's right edge never moves and the text column never reflows.
A touch device has no hover to swap on, so both sit side by side there, always reachable. It is a
navigation, not a fill: the click posts `UI_OPEN_ENTRY` over the picker's private channel, the
content script checks the id against the rows it rendered and the picker's visibility, and then
asks the background to open the full Bramble window on `/vault/<entryId>`.

- The window is the existing pop-out (`popup.html?detached=1`) with a `POPOUT_OPEN` handoff path. If
  a pop-out is already open, the background focuses it and sends a `NAVIGATE` message instead of
  creating a second window; the app's router runs the route's own guards.
- Only an opaque entry id and a route travel. Nothing is filled and nothing is returned to the page.
  The row action lives in the isolated renderer, takes the same trusted-click/visibility gate as a
  pick, and a page cannot synthesize it.
- The action is on match rows only. The locked row and the suggestion/alias rows have no entry to
  open. `Ctrl/Cmd+Enter` on a highlighted row is the keyboard path to the same action; it uses the
  id the iframe reported for the highlight and the same rendered-id check as the click.

### The keyboard commands

Three manifest commands are relayed by the background. `autofill-cycle` and `autofill-cycle-back`
step through the list in the active tab; `fill-login` fills the page's login without opening the
list. `autofill-cycle` ships with `Alt+Shift+L` (`⌥⇧L` on macOS), `fill-login` with `Ctrl+Shift+L`
(`Command+Shift+L` on macOS), and the back command has no default, keeping the four-suggested-key
budget free for future commands. The user can rebind or clear any of them in the browser's
extension-shortcuts page; Settings reads the bound chord from `commands.getAll()` rather than
assuming it, and "Change" opens that page where the browser allows it.

A command is a genuine user gesture, so it fills directly instead of opening the list. Only the
frame with a focused candidate field acts; every other frame ignores the message, which is what
keeps a tab-wide message from filling a form nobody is looking at. The first press fills the first
entry, the next advances and wraps, and the sequence resets when the field or the match set changes
or after six seconds. The pick still goes through `AUTOFILL_SELECT`, so the background re-checks
the verified page origin before returning a login's secrets. A chip extends from the mark with
`2/3` and the entry name, then fades out, so cycling is never blind. The cycle's chip is the short
variant (800ms hold, 160ms fade) rather than the 2s pick animation.

`fill-login` chooses the login whose username starts with what is typed in the username field,
else whose name does, else the site's first. The background issues a one-shot, in-memory grant for
the tab, so this command also fills while **Autofill on web pages** is off; the grant is spent by
the fill, expires after 30 seconds, and dies with the session. Locked, the command opens the
unlock-only pop-out instead of asking the page for anything.

## The master switch

Settings -> General -> **Autofill on web pages** (extension only; mobile's autofill is
enabled in OS settings and desktop has no page of its own to fill). On by default.

Off means the content script draws nothing: not matches, not the "Vault locked" row,
not the generated-password suggestion. Two places enforce it, and the order matters:

- **The background** reads `pref.autofillEnabled` on every `AUTOFILL_QUERY` and every
  `AUTOFILL_SELECT`. A disabled query answers with empty lists and `disabled: true`; a
  disabled select answers `unavailable`, the same word every other refusal uses. A
  content script is not a trusted context, so what a page is told cannot depend on the
  page choosing to ask. The read sits *after* the session snapshot in `AUTOFILL_SELECT`,
  since nothing may await ahead of the locked-start check that rejects a lock/unlock ABA.
- **The content script** treats `disabled: true` as "stop asking": it drops whatever is
  on screen, forgets the cached result, and skips every subsequent query until the switch
  comes back. That is what suppresses the password suggestion, which needs no vault and
  would otherwise still be offered on a signup form.

Flipping the toggle pushes `AUTOFILL_ENABLED` to every tab (`shell.setAutofillEnabled`),
so a page that was already open loses its dropdown immediately, and gets it back without a
reload. The pref is what enforces the switch; the push only settles what is on screen.

The extension-page adapter path (`AUTOFILL_FIND` / `AUTOFILL_FETCH`) is deliberately
*not* gated: the switch is about what happens on a web page, not about the popup's own
view of the vault. Capturing new logins has its own toggle ("Offer to save logins"), and
`DESKTOP_FILL` is exempt as well: that is a credential the user picked in the desktop app,
aimed at this page, and silently dropping it would leave that action unexplained.

### The new-login row

A username field's matches end with a small **New login** link (#213), so a site that already
has logins can get another without leaving the page for the popup. Only on the username field,
where accounts are chosen, and only on a click: the arrow keys skip it, so Enter never opens a
window. It fills nothing: the link sends
`POPOUT_OPEN` with `reason: "new-login"`, and the background opens the create form at
`/vault/new/login` itself. A page names a reason, never a route. The form reads the site
from the tab behind the pop-out (`getCurrentTabOrigin`) and names the login after its host.
The row is in all three renderers: the iframe, the shadow fallback
(`content/html/dropdown-new-login.ts`, kept identical by `template-parity.test.ts`), and the
frame relay.

## When the content script looks at the page again

An SPA can swap a login form in without a navigation, so a `childList`
MutationObserver drives the re-query. It used to do so on every batch, which on a
page that rewrites itself continuously (YouTube, a feed, a video player) meant a
full page parse twice a second in every frame, plus one on every keystroke and
click, because each of those dropped the cached field model first. That is
issue #59. The policy now:

- **A batch is ignored unless it moves something field-shaped**: an `input`,
  `select`, `textarea`, `form`, `iframe`, or a custom element (which renders its
  own subtree, possibly into a shadow root this observer cannot see). Pages known
  to use shadow DOM skip the filter entirely, since their real churn is invisible
  here anyway.
- **Re-queries coalesce** into one pending timer, at most one per 500ms, and run
  outside the observer callback.
- **A hidden tab does not re-query.** Picture-in-picture keeps a backgrounded page
  busy; the deferred re-query runs when the tab is visible again.
- **Event handlers check the target before the model.** `couldBeCandidate()` is a
  type check on the element, so typing in a comment box or clicking a button costs
  nothing. Only a real input reaches the parse behind `isCandidate()`, and an
  input the model has never seen buys exactly one re-parse (a shadow root can
  attach with no mutation to observe).

One path deliberately opts out: a **desktop fill** (`DESKTOP_FILL`, see
[desktop-port.md](desktop-port.md)) re-reads the page before choosing its target. The user picked
that entry in the desktop app, so a model stale by one unobserved change - an input whose `type`
flipped to password, say - would answer "no field to fill" for something they explicitly asked
for. One deliberate action is worth one parse.

`e2e/perf/page-blocking.mjs` is the harness for this: it reports main-thread
blocking time with and without the extension on a real page.

### The picker lets go of a field that has gone

An open picker is parked below its anchor field by a `requestAnimationFrame` loop
in `picker.ts`, because a `scroll` event is `composed: false` and never fires for a
scroll inside a shadow root or a nested modal scroller. The loop re-reads the
field's rect every frame, so it also sees the moment the field stops existing: an
SPA route change unmounts the login form, a second step replaces the first, a modal
closes. **A field that has gone measures 0x0 at the document origin**, which reads
to anything positioning against it as "the top-left corner of the page" - so the
loop used to leave the dropdown stranded up there, still offering entries for a
form that was no longer on screen. `anchorIsLive()` is the check (attached to this
document, occupying a box, and visible); failing it dismisses the picker instead
of repositioning it.

A **modal closing** is the same problem wearing four disguises, and only the first
two are answered by "is it attached and does it measure":

| the modal closes by | what the field looks like afterwards |
| --- | --- |
| unmounting | detached |
| `display: none` | attached, 0x0 at the document origin |
| `visibility: hidden` / `opacity: 0` | attached, laid out, styled invisible |
| collapsing with `overflow: hidden` | attached, laid out, and styled **visible** |

The third pair is what a transition-based modal leaves behind, and it is answered
by `checkVisibility({checkOpacity, checkVisibilityCSS})` — the same call
`isRendered` makes, shared as `isVisibleCss`. It has to answer for **ancestors**,
since what closed is the modal, not the field.

The fourth has no style to read: the field is fine, its ancestor has gone to
nothing and clipped it out of the picture. A **hit test at the field's own centre**
answers it (`anchorIsReachable`), and catches an overlay dropped on top of the
field for free. Three things make it safe:

- `elementFromPoint` answers with the **deepest** element at the point, so a field
  that is really there answers with itself or with an icon painted inside it.
  Accepting an *ancestor* would accept every clipped-away field there is, because
  `<body>` contains the field too.
- It runs on `field.getRootNode()`, not the document. For a field inside a shadow
  root the document's own hit test answers with the **host**, never the field, and
  would take the picker down on sight.
- It is skipped when the field's centre is outside the viewport, where there is
  nothing to hit. A field merely **scrolled** out of sight keeps its picker, which
  rides along with it as it always has.

It is rate-limited to ~150ms rather than run per frame: it forces a hit test, and a
dismissal does not need 60Hz. Where it is unavailable (jsdom, any engine without
CSSOM View) it fails open, the way `isVisibleCss` does without `checkVisibility` —
never dismiss on a question you cannot ask.

An `IntersectionObserver` looks like the tool for the clipping case and is not: a
**live** observer never fires when only an ancestor's clip changes, while a fresh
one on the identical page reports zero. `e2e/extension/picker-modal-close.spec.ts`
covers all four, plus the shadow-root and scrolled-away cases that the hit test
must not get wrong.

The relayed picker has no loop of its own (its rect is pushed from the field's
frame, see below), so the same check runs where that rect is taken: on
reposition, and in the MutationObserver, which is the only thing that notices a
route change when nothing scrolled.

`pagehide` takes the picker down too. bfcache freezes the DOM as it stands, and a
picker restored on the return trip would be showing a match set - and a lock
state - from before the trip.

## Writing a value into a field

`fill.ts` writes through the native `value` setter (so React's value tracker sees
a change) and then dispatches the events real input produces: `beforeinput` and
`input` as `InputEvent`s carrying the inserted text and an `inputType`, key
events around a single character, and `change`. A bare `new Event("input")`
carries none of that, and widgets that read `event.nativeEvent.data` rather than
the field's value ignore it.

**Segmented one-time-code widgets** get an extra ladder, because nothing in the
markup says which write a given widget accepts. `fillOtp` tries the code whole
in the first box (a `paste` event, then an `insertFromPaste`), then a character
per box, **checking after each attempt what the boxes actually hold** and
clearing them before falling through. A widget's own re-render overwrites
anything it didn't understand, so reading the boxes back is a truthful test.

Last comes the widget's hidden **mirror** input, if `splitOtpFields` found one:
it holds the assembled code for the form, and on widgets driven by it that write
is what makes the boxes show anything at all. It is never given a single
character, and never the empty string past the end of the code. Doing that was
the bug (see [field-detection.md](field-detection.md)).

Filling a segmented widget means focusing each box in turn, and `focus()` fires a
**trusted** `focusin`. `isFilling()` marks that window so the content script
doesn't read our own focus moves as the user's and reopen the dropdown on the box
it just filled.

### Choosing, not typing: the expiry dropdowns

`fillCard` writes the expiry through one writer that handles a text box and a `<select>` alike.
For a select it tries the card's month and year against each option's `value` first and its
visible text second, widest form first: month "04" then "4", year "2030" then "30", so
`<option value="04">04 - April</option>` and `<option value="7">7</option>` both resolve. If no
option matches, **nothing is written**. A select holding a value it never offered reads as the
placeholder to the form and shows the user no error, which is worse than leaving it alone.
`input` and `change` are both dispatched, since a form's own validation listens for the latter.

### Card and custom fills never write into a hidden field

`fillCard` and `fillCustomFields` skip any field `isRendered` rejects. A form that
hides a box has taken it out of the flow, and filling it anyway can put a secret
somewhere the page never asked for one. The case that prompted the rule: the
Semafone capture frame (see [field-detection.md](field-detection.md)) tokenises
the PAN only, but keeps a `display:none` cvc box whose submit handler still
appends `sf.req.card.securityCode` when it holds a value — so filling it would
send a CVV in a request that was not collecting one. It also stops us feeding the
`data-honeypot-field` inputs Shopify ships alongside its real card number, which
carry genuine `cc-*` tokens and are visually hidden.

`fillForm` is deliberately **not** subject to this. A two-step login can keep its
password field in the DOM but hidden on the identifier step, and filling it there
is the point: the value is waiting when step two renders. The exposure that
motivates the card rule doesn't apply, because a login form isn't assembling a
request out of boxes it has disabled.

`autoFilledFields` carries the other half of the write policy. A value **we**
wrote is off-limits to auto-fill (so a re-query can't re-clobber a field the user
cleared) and fair game for an explicit pick (so choosing a second card in the
dropdown replaces the first rather than silently doing nothing). A value the
**user** typed is never clobbered by a custom-field fill, though an explicit pick
does overwrite the login and card fields — that is what choosing an entry means.

When the vault is locked, the query result still carries `hasPotentialMatch`
(derived by checking known hostnames against the page's registrable domain
without decrypting the index), enough to show a "locked, unlock to autofill" hint
without exposing data.

## Capturing a submitted credential

`capture.ts` decides *when* a typed password counts as submitted. Every path
starts from the same buffer: a trusted `input` on a `type=password` field records
the value (our own `fillField` dispatches are untrusted and don't count).

Two commit policies, because they face opposite constraints:

- **Native `submit`, and Enter inside a password field**: emit **synchronously**.
  These usually precede a full page navigation, which destroys the content
  script, so anything deferred would be lost.
- **A click on a submit control** (`<button>` / `<input type=submit|image|button>`):
  **arm, don't emit.** Formless SPA logins fire no `submit` event at all, so the
  click is the only signal. The credential is snapshotted at click time, because
  by the time we commit the form is gone and there is nothing left to read. The
  commit waits for that password field to stop being rendered, which is the
  evidence the login actually went through. A failed login leaves the field on
  screen and the attempt expires unsaved after `ARM_WINDOW_MS`.

Arming is narrow on purpose. Sites put secondary actions right beside the
password field (skanetrafiken's "Glömt lösenord?" is a `<span role="button">`,
its show-password toggle is a `role="checkbox"` label), and arming on those risks
offering to save a password that was never submitted. Role-based pseudo-buttons
are therefore excluded; relaxing that is safe only because the commit gate, not
the arm gate, is what prevents the prompt.

While armed, the commit condition is polled (`ARM_POLL_MS`, bounded by the arm
window) rather than left to the MutationObserver, which only watches `childList`
and would miss a form hidden by a class on an ancestor. `hashchange`/`popstate`
also drive a check; `history.pushState` fires no event and cannot be patched from
a content script's isolated world, so it is not a signal we can use.

Re-typing the password disarms any pending attempt, which is the ordinary
retry-after-failure path. A legacy fallback still fires when a password field
vanishes within 1500ms of the last keystroke, covering submits driven by
mechanisms none of the above observe.

"Stops being rendered" is the load-bearing wording, and it is not the same as
"is removed". Verified against skanetrafiken's own application, replayed from a
HAR recording (`e2e/hars/`): on a successful login it swaps in the account view
and leaves the password input **connected to the document at 0x0**. A gate keyed
on detachment alone never fires there, which is also why the legacy fallback,
whose check is a bare `input[type=password]` selector with no visibility filter,
could not have saved on that site even inside its window.

## The corner prompt

When the user submits a login form with credentials Bramble does not have, or
that differ from what it has stored, the content script renders an in-page
top-right card offering to save or update.

- The **background owns the dedupe decision**; the content script just renders the
  kind it is handed (`save-login` or `update-login`).
- Each capture gets a `promptId` UUID that rides the round-trip back on the
  response. A stale prompt (vault locked then unlocked, page restored from
  bfcache) cannot commit, because its id no longer matches the live stash.
- An `update-login` prompt lists candidate logins whose stored password differs
  from the submitted one. More than one candidate shows a radio group.
- On `save`, an unambiguous single update-candidate is upgraded to an update;
  multiple candidates mean the user explicitly chose "Save", so it stays a new
  entry (supports multiple accounts on one site).

When the vault is locked the background cannot dedupe (no index). The card's
primary button becomes "Unlock & save" and the response action becomes
`save-unlock-first`, which routes through the popup unlock flow. The capture is
stashed per registrable domain in `chrome.storage.session`; if the page navigates
away before the prompt is shown, the next page picks the stash back up. The
commit itself goes through the background, which writes directly to
`chrome.storage.local` (headless, no gesture; see [storage.md](storage.md)).

### Suppressing the browser's own dropdown, without blinding ourselves

While the picker is anchored to a field it writes `autocomplete="off"` on it, so
the browser's native dropdown doesn't render on top of ours, and restores the
original the moment the anchor moves.

That write is skipped for a field declaring `one-time-code`, because on a
segmented widget that token is often the only thing marking the boxes, and
detection's strongest rung is a query for it. Overwriting it took the anchor out
of the model at the next re-parse (our own host insertion triggers one), so
`currentTargetKind` came back null and the pick was refused: the dropdown opened,
the row was there, and clicking it did nothing. Cloudflare's 2FA form is the case
that showed it, and `e2e/extension/totp-segmented-fill.spec.ts` is what holds it.
Nothing is lost by skipping: a desktop browser has no stored one-time code to
offer, so there was no native dropdown to get out of the way of.

The general rule the incident leaves behind: **do not write over an attribute
detection reads**. The same hazard sits under `autocomplete="username"` on an
identifier-first page, where the token can be the only signal; that one still
suppresses, and would need the same treatment if it ever bites.

It bit a second time in a different shape: not detection reading the attribute,
but a **decision re-read after the write**. `new-password` is the token that
scores a signup, so classifying save-vs-update at the moment the user clicks the
suggestion scored a form that no longer described itself, and the signup's "save"
became an "update". Both decisions a suggestion carries -- the password and
whether accepting it creates a login -- are now settled together in
`maybeSuggest`, which runs before the picker anchors, and cached on the field.
Regenerating swaps the password and keeps the classification.

The corollary to the rule above, then: **anything derived from an attribute the
picker suppresses must be computed before it anchors, not on the pick.** Unit
tests cannot see this, because they mock the picker and it never performs the
write; `e2e/extension/suggest-password.spec.ts` is what caught it and what holds
it.

## UI isolation: extension-origin iframe and closed shadow DOM

The **match dropdown** renders in a cross-origin **iframe** served from the
extension origin (`autofill-ui.html`, a `web_accessible_resource`), injected by
the content script (`autofill-ui.ts` is the iframe document). This is a true
origin boundary: the page cannot read the iframe's DOM
(`iframe.contentDocument === null`), reach its rows, or synthesize a trusted
click inside it. Entry ids and row text live only inside the iframe, never in a
page-readable surface. Content-script-injected web-accessible-resource iframes are
exempt from the host page's `frame-src` CSP, so this works even on strict-CSP
sites; the one header that blocks it is `Cross-Origin-Embedder-Policy:
require-corp`, where the readiness handshake times out and the content script
falls back to the closed-shadow dropdown.

The shadow (COEP) fallback carries the same list semantics and keyboard path as the iframe:
`role="listbox"` on the list, `role="option"`/`aria-selected` on the rows, the `tp-more` note as
the list's description, and Arrow/Enter/Escape navigation. A COEP e2e opens the fallback and fills
from the keyboard.

The **in-field mark** is deliberately not an iframe: it has to sit inside the field's own box, and
it holds no rows, ids or secrets. It is a page-DOM host with a closed shadow root
(`host.shadowRoot === null`), so the page cannot read the mark, the username completion or the chip
text. A page can cover it or remove it, which costs the user an affordance, never a fill: the mark
only opens the list, and the list's own origin boundary and trusted-click gate are unchanged.

The iframe holds **no secrets**. It receives only summaries (name + masked
secondary) over `postMessage` and reports the user's pick back; the fill still
happens in the content script against the real page inputs, and the background
returns secrets only to the initiating content script's original request.

The iframe sits in the page's DOM, so `window.parent` is the **page's** window,
which the content script shares. A check on the parent's source and origin cannot
tell the content script from the page's own script, and once trusted that way the
iframe obeyed whoever posted to it: a page could focus the field itself (script
focus is a trusted focusin), take the iframe's window off any message it posted
back, and send `UI_KEY` ArrowDown + Enter to fill with no click
(GHSA-mvjj-4qqq-xr7h). So the window carries only a handshake, and everything
else rides a **private `MessageChannel`**:

- The iframe posts `AUTOFILL_UI_READY` to the page origin. The content script
  takes it only when `event.source === iframe.contentWindow` **and** the origin is
  on the extension's url scheme (both browser-set), and answers with
  `UI_CONNECT`, transferring one end of a fresh channel, pinned to READY's origin -
  **not** to `runtime.getURL()`'s. Under Chromium's manifest `use_dynamic_url`,
  getURL hands a content script a per-session GUID origin while the document it
  loads reports the extension's static origin, so pinning to the src origin drops
  the hand-over and the picker silently falls back to the shadow renderer.
- The iframe adopts the **first** port it is handed, acks `UI_CONNECTED` on it,
  and from then on ignores the window entirely. Rows and keys arrive, and picks
  and heights leave, only on that port. The content script counts the iframe
  ready on the ack, not on READY.
- A page that wins the race to hand over its own port gets the iframe's answers
  on its port and the content script hears nothing, so the worst it gets is a dead
  picker; the readiness timeout then falls back to the shadow renderer.
- The content script also honors a `UI_PICK` only for an entry id it rendered.

Because the page controls the host element's geometry, `pickIsTrustworthy()`
runs a **pick-time visibility check** before honoring a pick, on both renderers:
the host must be on-screen, legibly sized, opaque, visible, unclipped, and not
overlaid (`elementFromPoint` at its center must resolve to the host). Opacity is
the effective one: the host's own times every ancestor's, `filter: opacity()`
included, because neither inherits into the host's computed style. Other
ancestor filters are allowed (Dark Reader's filter mode inverts every page's
root). This blocks a clickjacking page that hides/moves/overlays the picker to
coax a real click - the case that matters being cards, which are offered on every
site.

### Relayed placement: hosted-fields checkouts

A card input on a hosted-fields checkout (Shopify, Stripe Elements, Braintree,
Adyen) lives in a cross-origin iframe sized to the input itself; Shopify's is 47px
tall with `scrolling="no"`. A picker mounted in that document is positioned below
the field, and therefore below the frame's viewport, and an iframe cannot paint
outside its own box. The field was always detected; there was simply nowhere to
draw, so nothing appeared at all.

The fix splits **who owns the element** from **who owns the conversation**:

- The **top frame** creates, parks, sizes and destroys the iframe element
  (`relay-host.ts`). It never sees summaries or picks.
- The **field's frame** keeps the channel with the UI document
  (`relay-client.ts`), exactly as a non-relayed picker does. It still calls
  `AUTOFILL_SELECT` on its own verified background channel and fills its own
  inputs, so the secret path is unchanged and no background message types were
  added.

Which fields may relay:

- **Cards relay from every frame.** Cards are offered on every site, so the top page learns
  nothing from a hosted card picker beyond how many cards there are and whether the vault is
  locked.
- **Logins relay only from a same-site frame.** The top page can read a picker it hosts off its
  own DOM (it appears, it has a height), which for a sign-in frame from another site would say
  whether the user has logins saved for that site. Same-site is decided by the background from
  the browser's account of the sender (`sameSiteAsTop`, eTLD+1 including the private PSL section,
  and the scheme), never by the content script. A cross-site sign-in frame keeps its picker
  inside it, even when that frame is too short to show it.
- **No host upstairs falls back here.** If the top frame never brings the UI up (COEP blocks it
  there, or no content script runs there) within two seconds, the frame stops asking for the
  rest of the page's life and draws its own picker, when it has room for one.

Geometry walks up the frame tree in `frame-relay.ts`, each hop adding its frame
element's box plus border and padding. A hop is honoured only when `event.source`
is the `contentWindow` of a frame element in that document, which a script in that
frame cannot impersonate. **Only geometry and an opaque relay id travel this way**:
every hop is a `message` event on a window the page shares with us, so summaries,
entry ids and secrets must never ride it.

The relayed rect is bounded but **not clamped to the child's box**: a picker for a
47px frame has to extend outside it. Ownership is the boundary instead. The UI
announces its relay id to every frame in the tab, so the relay chain records which
frame opened each id and rejects an anchor or withdrawal from any other frame; a
sibling that learns the id cannot move or close another frame's picker.

The **UI announces itself** and the field's frame **pins the announcement whose
`event.origin` is one of our own extension origins**. That check is the whole trust
boundary, so it must never be relaxed to a bare `chrome-extension://` scheme test,
which any installed extension would pass.

The handshake runs in that direction and not the other because `window.frames`
exposes only *document-tree* child browsing contexts, and the host parks the UI
inside a **closed shadow root**, which puts it in a shadow tree. The field's frame
therefore cannot reach the UI by index at all: `window.top.length` counts 1, not 2.
The UI can still walk outward from `window.top`, so it does the announcing. This
was found by e2e, not by reasoning, and reversing it keeps the closed shadow root
without weakening anything, since the pin was always decided by origin rather than
by who spoke first.
A content script cannot use `runtime.getURL()` for this: under `use_dynamic_url`
that returns a per-session GUID origin while the document reports the static
`chrome-extension://<id>`. `ext-origin.ts` accepts both, since both are ours.

Four checks carry the security of the relayed path, all in `relay-client.ts`:

1. The UI window is pinned from a probe reply on one of our origins, and never
   rebinds.
2. Summaries are posted to that pinned window with an exact `targetOrigin`, never
   `"*"`.
3. An inbound message is honoured only when `event.source` **and** `event.origin`
   both match the pinned peer.
4. A pick must name an entry we actually rendered.

Check 4 exists because the UI document is reachable by anything in the tab, so it
is treated as untrusted plumbing rather than a trusted peer. A page that posts rows
into it can relabel what is on screen (which it could equally do with its own DOM),
but it cannot name an entry we did not offer, cannot make a pick reach us from
anywhere but the pinned window, and cannot produce a pick at all without a genuine
user click inside the UI document.

The anti-clickjacking guard moves with the element. Because the pick never passes
through the top frame, `pickIsTrustworthy()` cannot run at pick time, so
`relay-host.ts` evaluates the same conditions continuously on its rAF loop and
destroys the host the moment it stops being legible. That is prevention rather than
detection, and the page cannot suppress it: the verdict comes from computed style
the top frame reads itself, not from any message.

Keyboard nav works without moving focus off the page field: when the iframe is
open, the content script forwards only Up/Down/Enter/Escape to it as `UI_KEY`
(never characters). The iframe moves a highlight, which gates Enter - with a
highlight, Enter picks that row; without one, Enter falls through so the form
submits normally. The non-relayed content script tracks the gate itself from the
renders and arrows it sent (the iframe applies them in order on the port), not
from the iframe's `UI_HIGHLIGHT`: that report lands a round trip late and lost
the race to a quick Enter. The relayed path still gates on `UI_HIGHLIGHT`.

### The card the tab already used

Because each frame fills only its own inputs, a per-field hosted-fields checkout
asks once per box: the number frame, then the expiry frame, then the CVV frame,
each offering every stored card with nothing marking the one just used. Picking a
different card in the second frame is how a Visa number ends up beside another
card's CVV.

So a successful card fill leaves a **carry** in the background: `{owner, tabId,
entryId, expiresAt}`, in memory, good for five minutes. The next query from that
tab gets it back as `carriedCardId`, and the content script moves that card to the
head of the list and marks it ("Used here"). The pick that lands in the next frame
is then the same card by default rather than whatever sorts first.

Focusing a card field therefore **always re-asks**, where every other kind paints
from the cache alone. Nothing happens in the CVV frame while the number is filled
next door, so its cached answer is the one it took at load, and the carry would
never reach the frame that needs it most. The dropdown paints from cache
immediately and the refresh repaints it; `renderKey` carries the carried id, so an
unchanged answer is a no-op rather than a flicker. `card-carry.spec.ts` fails on
the stale list without it.

What it deliberately is not: a fill. Nothing is pushed to a frame, and the carry
is an id the same response already carries in `cards`, so a frame that never asked
learns nothing and the rule that query results are never tab-addressed still
holds. The badge is ordering and a label only, never the keyboard highlight:
taking that would make Enter fill a card on a form where Enter submits (see the
Enter gate above).

The carry is bound to the session that created it (`autofillSessionOwner`), so a
lock, a vault switch or a lock/unlock ABA drops it; `tabs.onUpdated` with a url
and `tabs.onRemoved` drop it when the page leaves under it; and it is scoped to
one tab, so a checkout in another tab never sees it.

The **corner prompt** (save/update) still renders in a **closed shadow root**
(`attachShadow({ mode: "closed" })`): `host.shadowRoot` is `null`, page CSS can't
reach in, and the captured username/password in its inputs aren't page-readable.
This is defense-in-depth, not a hard origin boundary (the host lives in page
light DOM, so a site can tell a prompt exists). Note the captured credential is
one the user just submitted to the page's own form, so that origin already holds
it; the boundary guards against incidental exposure, not a page-unknown secret.

## Threat model: what the fill path defends against

Two attacks a hostile page could mount to steal credentials through autofill, and
the layered defenses that stop them. Cards are the prize in both, because cards
are offered on **every** site (not hostname-scoped), so any page can list and try
to exfiltrate them.

**1. Silent (zero-click) exfiltration.** A page tries to drive a fill with no
user interaction, then reads the injected value back out of its own form. It
might dispatch a synthetic `mousedown` at a dropdown row, or post a forged
`UI_PICK` to the content script. This is the worst case: just visiting the page
would leak data, no social engineering needed. Stopped by three independent
layers:

- the dropdown's `mousedown` handler bails on `event.isTrusted === false`, so a
  synthetic event can't pick (the capture listeners gate the same way);
- the dropdown renders in a cross-origin iframe the page can neither read nor
  dispatch events into;
- picks reach the content script only over the private channel handed to the
  iframe, and the iframe takes rows and keys only from that channel, so a page's
  own `postMessage` can neither pick nor drive the picker into picking (see "UI
  isolation"; `picker-iframe.spec.ts` runs the page script from
  GHSA-mvjj-4qqq-xr7h).

**2. Clickjacking (UI redress).** The page can't fake a click, so it tricks the
user into a *real* one. It makes the dropdown invisible (`opacity`), tiny, or
off-anchor, or covers it, and lines a row up under something the user means to
click (a play button, a cookie banner). The click is genuine and lands in the
iframe, so every other defense passes, but the user never knew they were filling
a credential and the page reads it back. Stopped by `pickIsTrustworthy()`, which
honors a pick only when the host is actually visible to the user: on-screen,
legibly sized, opaque (counting ancestors), unclipped, and not overlaid
(`elementFromPoint` at its center resolves to the host). It runs on the shadow
fallback too, which a page can force by keeping the iframe from loading.

Two more gates apply to **clicks** only. Keyboard picks (↓ then Enter in the
focused field, or the cycle command) are deliberate and skip both:

- **Early clicks.** A click is dropped until the picker has sat still for 500 ms,
  and the clock restarts whenever it appears, un-hides or moves. A page that can
  open the picker (script focus) or move its field can otherwise put it under a
  click the user is already making, a double-click lure being the classic.
- **Browser-vouched visibility (Chromium).** Hit testing skips an overlay with
  `pointer-events: none`, so a decoy painted over the picker passes
  `elementFromPoint` while the user's click goes straight through it to a row.
  The iframe watches itself with IntersectionObserver v2 (`trackVisibility`) and
  refuses clicks unless the browser reports it unobscured, unfiltered and
  opaque. A refused click shows "Use ↓ and Enter to fill on this page". It also
  refuses under any filter on the page root, so with Dark Reader's filter mode
  clicks don't fill in Chromium and the keyboard does.

Firefox has no `trackVisibility`, so a static `pointer-events: none` decoy is
still open there; putting the picker in the top layer (`popover`) is the
candidate fix. `picker-iframe.spec.ts` runs the decoy in Chromium.

**Blast-radius containment.** If a fill is somehow triggered anyway,
`authorizeFill` (background) still requires a **login** to match the verified
page origin before secrets are returned, so a login can't be filled on a site it
isn't registered for. Cards are deliberately site-agnostic and have no such
backstop, so the visibility guard above is their main protection, which is why it
matters most for them.

These are defense-in-depth, not guarantees: clickjacking in particular is an arms
race, and the visibility heuristics catch the obvious cases (hidden, tiny,
overlaid) rather than every clever partial overlay.

## Password generation

The login form's generator (`randomPassword` in `app/entry-modes/login.tsx`)
produces a 16-character password from an 88-character set. Because 88 does not
divide 256, `byte % n` would over-represent the first `256 % n` characters, so it
**rejection-samples**: only bytes in the largest multiple-of-n slice of `[0, 256)`
are accepted, giving every position equal probability. Bytes are drawn in 16-byte
chunks to amortise the `getRandomValues` call; worst-case expected rejection rate
at n=88 is about 12.5%.

The content script carries its own copy of the same algorithm
(`content/password-gen.ts`, 20 characters) for the signup suggestion below, since
it is a flat bundle with no cross-package runtime imports.

## Suggesting a strong password on signup and password change

When the user focuses a password field that looks like account creation or a
password rotation (see [field-detection.md](field-detection.md), "Signup
detection"), the dropdown shows a **generated-password row** above any matches: the
suggested password previewed as its first six and last four characters in monospace, with a "Use
suggested password" caption and a
regenerate button. Both renderers carry it (`content/html/dropdown-suggest.ts` for
the shadow fallback, `suggestRow` in `autofill-ui.ts` for the iframe), navigable by
keyboard like any other row.

The suggestion is generated **in the content script** and passed to the iframe as
render data, never fetched from the vault. Choosing it (`UI_USE_SUGGESTED`, gated
by the same anti-clickjacking `pickIsTrustworthy` check as a secret pick):

1. fills the new-password field and any confirm sibling (`fillPasswordFields`,
   which records the value so a later real submit won't re-prompt), leaving a
   change form's current-password box for the user, and
2. fires a `CORNER_PROMPT_CAPTURE` with whatever username/email the user already
   typed plus the generated password, reusing the entire corner-prompt save path
   above (including the navigation-surviving stash).

The corner prompt's own dedupe then decides the rest: on a signup form (no matching
login) it offers **Save**; on a change-password form (an existing login for the
site) it offers **Update**, and `commitCornerUpdate` rotates the password on the
chosen entry. Because a change form has no username field the capture's username is
empty, so the update **keeps the entry's existing username** rather than blanking
it. The row is offered only on an empty field, and never on the current-password
field itself.

### The rest of an account-creation form offers nothing

A signup form is where the user is **inventing** a credential, so the fields around
that password box have nothing to fill. Existing matches on the email field are
clutter, and while the vault is locked the row is worse than clutter: it offers a
window and a master password to fill a form that fills nothing. Both are now
suppressed (`isCreationField`), leaving the generated-password row as the only thing
the picker says on a signup form.

`isAccountCreationForm` answers this for the password field; its neighbours cannot
ask it, since there is nothing in an email box that says "signup".
`isOnAccountCreationForm` puts the question to the form's own new-password field
instead. The verdict is cached per field, for the reason the suggestion is: the
picker rewrites its anchor's `autocomplete` to suppress the native dropdown, so a
form re-read after it has anchored no longer describes itself. Caching also keeps
the scoring off the per-keystroke path, since `input` re-decides what to show.

A signup split across steps has no password box to score, so it is judged on a
**confirm-email pair** instead: a form that asks for the email twice. That is the
only signal safe enough to act on there. A two-step *login*'s email screen is a
signup's email screen minus one field, and the page-level signals cannot tell them
apart — a `/signin` route with a "Create account" link scores like a signup — while
getting it wrong silently kills autofill on the screen where it is worth the most.
`e2e/extension/signup-picker.spec.ts` guards every suppression case with the
two-step login screen it must not swallow.

`src/dev/dropdown-break.html` is a dev-only harness for the menu's worst-case data. It is not a build input and does not ship.
