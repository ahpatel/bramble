/// <reference types="chrome" />

import type { VaultCrypto } from "@core/wasm";
// The VaultCrypto surface is declared once in @core/wasm; this loader only owns the
// extension-specific instantiation (loading the bundle via chrome.runtime.getURL).
import { api } from "./platform-api";

export type { VaultCrypto };

let cached: Promise<VaultCrypto> | null = null;

/** Lazily imports and instantiates the WASM crypto module, caching the singleton. */
export function loadWasm(): Promise<VaultCrypto> {
	if (cached) return cached;
	cached = (async () => {
		const wasmModule = await import(
			/* @vite-ignore */ chrome.runtime.getURL("wasm/vault_crypto.js")
		);
		// The object form is the non-deprecated wasm-bindgen API; passing the URL positionally
		// logs "using deprecated parameters for the initialization function".
		await wasmModule.default({
			module_or_path: api.runtime.getURL("wasm/vault_crypto_bg.wasm"),
		});
		return wasmModule as VaultCrypto;
	})();
	return cached;
}
