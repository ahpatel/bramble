/// <reference types="chrome" />

import { config } from "zod";

// Extension pages run under MV3 CSP, which forbids eval: zod v4 probes `new Function("")`
// for an optional fast path, the probe is caught and harmless, but the CSP report still
// lands in the console of every extension page (zod's own `jitless` flag exists for
// exactly this; see its util.js comment). Turn the probe off before any schema parses.
config({ jitless: true });

// Cross-browser WebExtension API handle. Firefox exposes the promise-based API as
// `browser`; Chrome exposes `chrome`. Use `globalThis.browser ?? chrome` (never a bare
// `browser`) so vitest under Node does not ReferenceError. Typed as `typeof chrome`:
// the codebase is promise-native and the surfaces used match Chrome's signatures.
const g = globalThis as typeof globalThis & {
	browser?: typeof chrome;
	chrome?: typeof chrome;
};
export const api: typeof chrome = (g.browser ?? g.chrome) as typeof chrome;
