import { useEffect, useMemo, useState } from "react";
import { decryptWithKey } from "../vault/sharing-crypto";
import type { SharingState } from "../vault/sharing-mutations";

/**
 * Decrypted collection labels by id, recomputed only when a collection's
 * ciphertext changes. The list rows and the detail's sharing chips both need
 * labels, and a per-render decrypt would cost one AES pass per row — so one
 * hook owns the cache.
 *
 * Failures fall back to the collection id: a label that can't be opened is a
 * display problem, never a reason to hide the row (the settings section made
 * the same call).
 */
export function useCollectionLabels(sharing: SharingState | null | undefined) {
	const [labels, setLabels] = useState<Record<string, string>>({});

	// The inputs a decrypt run needs, memoized so the effect below can list them
	// honestly: a decrypt storm costs one AES pass per row, so unrelated sharing
	// updates must not trigger one. A label whose ciphertext changed (rename)
	// re-decrypts; everything else is served from state.
	const collections = useMemo(() => sharing?.region.collections ?? [], [sharing]);
	const keys = useMemo(() => sharing?.collectionKeys ?? {}, [sharing]);

	useEffect(() => {
		let cancelled = false;
		void Promise.all(
			collections.map(async (c) => {
				const key = keys[c.id];
				if (!key) return [c.id, null] as const;
				try {
					return [c.id, await decryptWithKey(key, c.labelIv, c.labelCiphertext)] as const;
				} catch {
					return [c.id, null] as const;
				}
			}),
		).then((pairs) => {
			if (cancelled) return;
			const next: Record<string, string> = {};
			for (const [id, label] of pairs) {
				if (label !== null) next[id] = label;
			}
			setLabels(next);
		});
		return () => {
			cancelled = true;
		};
	}, [collections, keys]);

	return labels;
}
