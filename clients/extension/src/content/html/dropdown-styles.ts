import { html } from "../template";

// Colours reference the local --tp-* tokens defined below, never literals. The tokens mirror the
// @vault/theme scale (packages/theme/theme.css); the on-page UI has no Bramble app shell to read a
// `.dark` class, so light/dark follows the OS via prefers-color-scheme until the anchor field's
// own skin (set inline on .tp-dropdown) overrides it. A square field gets a square menu; a dark
// field gets a dark menu. Keep the defaults in sync with the iframe renderer (autofill-ui.ts).
export const dropdownStyles = html`
		<style>
			:host {
				display: block;
				color-scheme: light dark;
				--tp-surface: #ffffff; /* --popover */
				--tp-foreground: oklch(20.5% 0 0); /* --popover-foreground */
				--tp-muted: oklch(52% 0 0); /* --muted-foreground */
				--tp-border: oklch(87% 0 0); /* --border */
				--tp-primary: oklch(20.5% 0 0); /* --primary */
				--tp-on-primary: #ffffff; /* --primary-foreground */
				--tp-radius: 12px;
				--tp-row-radius: 8px;
				--tp-font-family:
					-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
				--tp-font-size: 13px;
				--tp-shadow: 0 12px 32px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.08);
			}
			@media (prefers-color-scheme: dark) {
				:host {
					--tp-surface: oklch(26.9% 0 0);
					--tp-foreground: oklch(97% 0 0);
					--tp-muted: oklch(70.8% 0 0);
					--tp-border: oklch(37.1% 0 0);
					--tp-primary: oklch(97% 0 0);
					--tp-on-primary: oklch(20.5% 0 0);
					--tp-shadow:
						0 16px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06);
				}
			}
			.tp-dropdown {
				background: var(--tp-surface);
				border: 1px solid var(--tp-border);
				border-radius: var(--tp-radius);
				box-shadow: var(--tp-shadow);
				font-family: var(--tp-font-family);
				font-size: var(--tp-font-size);
				color: var(--tp-foreground);
				text-align: left;
				letter-spacing: normal;
				text-transform: none;
				font-style: normal;
				text-indent: 0;
				max-height: 320px;
				overflow-y: auto;
				margin: 0;
				padding: 4px;
				box-sizing: border-box;
			}
			.tp-dropdown.tp-enter {
				animation: tp-enter 150ms cubic-bezier(0.2, 0, 0, 1);
				transform-origin: top center;
			}
			@keyframes tp-enter {
				from {
					opacity: 0;
					transform: translateY(-4px) scale(0.985);
				}
			}
			.tp-item {
				padding: 8px 10px;
				cursor: pointer !important;
				display: flex;
				align-items: center;
				gap: 10px;
				border-radius: var(--tp-row-radius);
				transition: background 0.12s ease;
			}
			.tp-item:hover,
			.tp-item.tp-active {
				background: color-mix(in oklab, var(--tp-foreground) 8%, transparent);
			}
			.tp-item.tp-active {
				background: color-mix(in oklab, var(--tp-foreground) 12%, transparent);
			}
			.tp-avatar {
				width: 30px;
				height: 30px;
				border-radius: 8px;
				display: flex;
				align-items: center;
				justify-content: center;
				font-size: 12px;
				font-weight: 700;
				color: #fff;
				flex-shrink: 0;
				letter-spacing: 0.3px;
				box-shadow:
					inset 0 1px 0 rgba(255, 255, 255, 0.18),
					inset 0 -1px 0 rgba(0, 0, 0, 0.14);
			}
			.tp-avatar-locked {
				background: color-mix(in oklab, var(--tp-foreground) 10%, transparent);
				color: var(--tp-muted);
			}
			.tp-avatar-locked svg {
				width: 18px;
				height: 18px;
			}
			.tp-text {
				display: flex;
				flex-direction: column;
				min-width: 0;
				flex: 1;
			}
			.tp-name {
				font-weight: 600;
				font-size: calc(var(--tp-font-size) + 1px);
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				color: var(--tp-foreground);
				line-height: 1.3;
			}
			.tp-user {
				color: var(--tp-muted);
				font-size: var(--tp-font-size);
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				margin-top: 1px;
				line-height: 1.3;
			}
			.tp-badge {
				margin-left: auto;
				flex-shrink: 0;
				font-size: 10px;
				font-weight: 600;
				letter-spacing: 0.2px;
				padding: 2px 7px;
				border-radius: 999px;
				color: var(--tp-muted);
				background: color-mix(in oklab, var(--tp-foreground) 10%, transparent);
			}
			.tp-launch {
				margin-left: auto;
				flex-shrink: 0;
				display: flex;
				align-items: center;
				color: var(--tp-muted);
				transition: color 0.12s ease;
			}
			.tp-item:hover .tp-launch {
				color: var(--tp-foreground);
			}
			.tp-new-login {
				display: flex;
				align-items: center;
				gap: 6px;
				width: 100%;
				padding: 6px 12px;
				border: 0;
				border-top: 1px solid var(--tp-border);
				background: none;
				color: var(--tp-muted);
				font: inherit;
				font-size: 12px;
				text-align: left;
				cursor: pointer;
			}
			.tp-new-login:hover {
				color: var(--tp-foreground);
			}
			.tp-avatar-suggest {
				background: var(--tp-primary);
				color: var(--tp-on-primary);
			}
			.tp-avatar-suggest svg {
				width: 18px;
				height: 18px;
			}
			.tp-suggest-pw {
				font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
				font-size: calc(var(--tp-font-size) + 1px);
				letter-spacing: 0.4px;
			}
			.tp-regenerate {
				margin-left: auto;
				flex-shrink: 0;
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
				transition: background 0.12s ease, color 0.12s ease;
			}
			.tp-regenerate:hover {
				background: color-mix(in oklab, var(--tp-foreground) 12%, transparent);
				color: var(--tp-foreground);
			}
			@media (prefers-reduced-motion: reduce) {
				.tp-dropdown.tp-enter {
					animation: none;
				}
				.tp-item,
				.tp-regenerate {
					transition: none;
				}
			}
		</style>
	`;
