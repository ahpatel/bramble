import { html } from "../template";

// Colours reference the local --tp-* tokens defined below, never literals. The tokens mirror the
// @vault/theme scale (packages/theme/theme.css); the on-page UI has no Bramble app shell to read a
// `.dark` class, so light/dark follows the OS via prefers-color-scheme. Keep values in sync with
// theme.css. The iframe renderer (autofill-ui.ts) carries a byte-identical copy for its flat bundle.
//
// The picker also takes a skin from the anchor field (content/skin.ts): --tp-radius, --tp-surface,
// --tp-foreground, --tp-border and --tp-font are overwritten per render so a square bank login and
// a pill-shaped SaaS sign-in each get a menu that belongs to them. The surface is the field's
// surface lifted toward the popover, not the field's fill: a menu painted in the field's own grey
// reads as another form control rather than something floating above it.
export const dropdownStyles = html`
		<style>
			:host {
				display: block;
				color-scheme: light dark;
				--tp-surface: #ffffff; /* --popover */
				--tp-foreground: oklch(20.5% 0 0); /* --popover-foreground */
				--tp-muted: oklch(55.6% 0 0); /* --muted-foreground */
				--tp-border: oklch(87% 0 0); /* --border */
				--tp-radius: 16px;
				--tp-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
			}
			@media (prefers-color-scheme: dark) {
				:host {
					--tp-surface: oklch(26.9% 0 0);
					--tp-foreground: oklch(97% 0 0);
					--tp-muted: oklch(70.8% 0 0);
					--tp-border: oklch(37.1% 0 0);
				}
			}
			.tp-dropdown {
				container-type: inline-size;
				background: var(--tp-surface);
				border: 1px solid var(--tp-border);
				border-radius: var(--tp-radius);
				box-shadow:
					0 20px 48px -22px rgba(0, 0, 0, 0.38),
					0 3px 10px rgba(0, 0, 0, 0.06);
				font-family: var(--tp-font);
				font-size: 13px;
				color: var(--tp-foreground);
				text-align: left;
				letter-spacing: normal;
				text-transform: none;
				font-style: normal;
				text-indent: 0;
				/* The content script lowers this to the larger viewport gap; 380px is the design cap
				   and the value used when no position has been written yet. */
				max-height: var(--tp-max-height, 380px);
				overflow-y: auto;
				margin: 0;
				padding: 4px;
				box-sizing: border-box;
				transform-origin: top center;
			}
			.tp-dropdown.tp-dark {
				box-shadow:
					0 24px 56px -20px rgba(0, 0, 0, 0.72),
					0 3px 10px rgba(0, 0, 0, 0.28);
			}
			.tp-dropdown.tp-animate {
				animation: tp-unfold 0.16s cubic-bezier(0.2, 0.8, 0.2, 1) both;
			}
			:host(.tp-above) .tp-dropdown {
				transform-origin: bottom center;
			}
			:host(.tp-above) .tp-dropdown.tp-animate {
				animation-name: tp-unfold-up;
			}
			.tp-item {
				box-sizing: border-box;
				padding: 8px 10px;
				cursor: pointer !important;
				display: flex;
				align-items: center;
				gap: 10px;
				border-radius: max(0px, calc(var(--tp-radius) - 4px));
				transition: background 0.1s ease;
			}
			@media (hover: hover) and (pointer: fine) {
				.tp-item:hover {
					background: color-mix(in oklab, var(--tp-foreground) 7%, transparent);
				}
			}
			/* One monogram treatment, tinted from the field's own ink: the avatar the vault list
			   draws. A per-entry colour put nine fixed hues on a menu that otherwise borrows the
			   site's palette, and the initials already identify the row. */
			.tp-avatar {
				width: 40px;
				height: 40px;
				border-radius: 11px;
				display: flex;
				align-items: center;
				justify-content: center;
				font-size: 15px;
				font-weight: 700;
				color: var(--tp-muted);
				background: color-mix(in oklab, var(--tp-foreground) 8%, transparent);
				flex-shrink: 0;
			}
			.tp-avatar-locked svg {
				width: 20px;
				height: 20px;
			}
			.tp-text {
				display: flex;
				flex-direction: column;
				min-width: 0;
				flex: 1;
			}
			.tp-name {
				font-weight: 600;
				font-size: 15px;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				color: var(--tp-foreground);
				line-height: 1.3;
				unicode-bidi: plaintext;
			}
			/* Comfortable rows give the title the full row and let it take a second line when it
			   needs one, so a distinguishing suffix is not the part that gets clipped. */
			.tp-item:not(.tp-item-compact) .tp-name {
				white-space: normal;
				display: -webkit-box;
				-webkit-line-clamp: 2;
				-webkit-box-orient: vertical;
				overflow-wrap: anywhere;
			}
			.tp-user {
				color: var(--tp-muted);
				font-size: 13px;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				margin-top: 2px;
				line-height: 1.3;
				unicode-bidi: plaintext;
			}
			.tp-badge {
				font-size: 11px;
				font-weight: 500;
				letter-spacing: 0.2px;
				padding: 3px 8px;
				border-radius: 999px;
				color: var(--tp-foreground);
				background: color-mix(in oklab, var(--tp-foreground) 7%, transparent);
				transition: opacity 0.08s ease;
			}
			/* The trailing slot. The carried badge and the open action share one cell and swap on
			   hover or row highlight, the way the vault list's rows do, so the right edge never
			   moves. Touch has no hover to swap on, so both stay visible there. */
			.tp-trail {
				margin-inline-start: auto;
				flex-shrink: 0;
				display: grid;
				place-items: center end;
			}
			.tp-trail > * {
				grid-area: 1 / 1;
			}
			.tp-item:hover .tp-badge,
			.tp-item.tp-active .tp-badge {
				opacity: 0;
			}
			/* Compact rows are one line: a text badge ("Hier verwendet", 102px) leaves the name
			   almost nothing at 320px. A dot keeps the meaning (and the title/accessible text)
			   without stealing the width; normal rows keep the words. */
			.tp-item-compact .tp-badge {
				width: 8px;
				height: 8px;
				padding: 0;
				border-radius: 999px;
				font-size: 0;
				color: transparent;
				background: var(--tp-muted);
			}
			.tp-open {
				display: flex;
				align-items: center;
				justify-content: center;
				width: 28px;
				height: 28px;
				padding: 0;
				border: 0;
				border-radius: 7px;
				background: transparent;
				color: var(--tp-muted);
				cursor: pointer !important;
				opacity: 0;
				pointer-events: none;
				transition: opacity 0.1s ease, background 0.12s ease, color 0.12s ease;
			}
			.tp-open:focus-visible {
				opacity: 1;
				pointer-events: auto;
				color: var(--tp-foreground);
			}
			.tp-item:hover .tp-open,
			.tp-item.tp-active .tp-open {
				opacity: 1;
				pointer-events: auto;
				transition-delay: 0.04s;
			}
			@media (hover: hover) and (pointer: fine) {
				.tp-item:hover .tp-open {
					color: var(--tp-foreground);
				}
				.tp-open:hover {
					background: color-mix(in oklab, var(--tp-foreground) 10%, transparent);
				}
			}
			@media (hover: none) {
				.tp-trail {
					display: flex;
					align-items: center;
					gap: 4px;
				}
				.tp-badge,
				.tp-open {
					opacity: 1;
				}
				.tp-open {
					pointer-events: auto;
				}
			}
			.tp-open svg {
				width: 15px;
				height: 15px;
			}
			.tp-launch {
				margin-left: auto;
				flex-shrink: 0;
				display: flex;
				align-items: center;
				color: var(--tp-muted);
				transition: color 0.12s ease;
			}
			@media (hover: hover) and (pointer: fine) {
				.tp-item:hover .tp-launch {
					color: var(--tp-foreground);
				}
			}
			.tp-avatar-suggest {
				background: var(--tp-foreground);
				color: var(--tp-surface);
			}
			.tp-avatar-suggest svg {
				width: 20px;
				height: 20px;
			}
			.tp-suggest-pw {
				font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
				font-size: 14px;
				letter-spacing: 0.5px;
			}
			/* The note under a capped list. Not a row: no hover, no key target. */
			.tp-more {
				padding: 6px 10px 4px;
				text-align: center;
				font-size: 11px;
				line-height: 1.3;
				color: var(--tp-muted);
			}
			.tp-regenerate {
				margin-left: auto;
				flex-shrink: 0;
				display: flex;
				align-items: center;
				justify-content: center;
				width: 32px;
				height: 32px;
				padding: 0;
				border: 0;
				border-radius: 8px;
				background: transparent;
				color: var(--tp-muted);
				cursor: pointer !important;
				transition: background 0.12s ease, color 0.12s ease;
			}
			@media (hover: hover) and (pointer: fine) {
				.tp-regenerate:hover {
					background: color-mix(in oklab, var(--tp-foreground) 12%, transparent);
					color: var(--tp-foreground);
				}
			}
			/* Compact: one line per entry, with a small monogram so the row still reads as Bramble.
			   The old avatar-less version was faster to scan but felt like a debug list. */
			.tp-item-compact {
				padding: 8px 10px;
				gap: 8px;
				min-height: 54px;
			}
			.tp-avatar-compact {
				width: 30px;
				height: 30px;
				font-size: 11px;
				border-radius: clamp(6px, calc(var(--tp-radius) - 2px), 10px);
			}
			.tp-text-compact {
				flex-direction: row;
				align-items: baseline;
				gap: 0;
			}
			.tp-text-compact .tp-name {
				font-size: 13.5px;
			}
			.tp-text-compact .tp-user {
				font-size: 12px;
				margin: 0;
				min-width: 0;
			}
			.tp-text-compact .tp-user::before {
				content: "·";
				margin: 0 6px;
				opacity: 0.55;
			}
			.tp-text-compact .tp-user:empty::before {
				content: none;
			}
			.tp-compact .tp-item-compact + .tp-item-compact {
				margin-top: 2px;
			}
			@keyframes tp-unfold {
				from {
					opacity: 0;
					transform: translateY(-6px) scale(0.985);
				}
				to {
					opacity: 1;
					transform: none;
				}
			}
			@keyframes tp-unfold-up {
				from {
					opacity: 0;
					transform: translateY(6px) scale(0.985);
				}
				to {
					opacity: 1;
					transform: none;
				}
			}
			@media (prefers-reduced-motion: reduce) {
				.tp-dropdown.tp-animate {
					animation: none;
				}
			}
			@media (forced-colors: active) {
				.tp-dropdown {
					background: Canvas;
					border-color: CanvasText;
					box-shadow: none;
				}
				.tp-item { color: CanvasText; }
				.tp-item.tp-active { outline: 2px solid Highlight; outline-offset: -2px; }
				.tp-badge {
					--tp-badge-dot-bg: CanvasText;
					background: Canvas;
					color: CanvasText;
					border: 1px solid CanvasText;
				}
			}
			/* The menu can be as narrow as 152px at 200% zoom on a 320px screen. The avatar and
			   the text badge are the first things to go: the entry name is the identifier. */
			@container (max-width: 320px) {
				.tp-badge {
					width: 8px;
					height: 8px;
					padding: 0;
					border-radius: 999px;
					font-size: 0;
					color: transparent;
					background: var(--tp-badge-dot-bg, var(--tp-muted));
				}
			}
			@container (max-width: 260px) {
				.tp-text-compact { flex-direction: column; align-items: stretch; }
				.tp-text-compact .tp-user { margin-top: 2px; }
				.tp-text-compact .tp-user::before { content: none; }
			}
			@container (max-width: 220px) {
				.tp-item { padding: 8px; gap: 8px; }
				.tp-avatar { display: none; }
			}
		</style>
	`;
