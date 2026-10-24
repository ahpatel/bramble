import { Trans, useLingui } from "@lingui/react/macro";
import { GitMerge } from "lucide-react";
import { type ReactNode, useState } from "react";
import { usePlatform } from "../../../context/PlatformContext";
import type { ConflictChoice, ConflictVersion, Entry } from "../../../hooks/useVault";
import type { EntryConflict } from "../../../sync";
import { formatDateTime } from "../../../util/format-date";
import { Button } from "../../components/ui/button";
import { getEntryMode } from "../../entry-modes";

interface ConflictBannerProps {
	/** The displayed version. */
	entry: Entry;
	conflict: EntryConflict;
	/** The sibling versions, decrypted on demand. */
	onReadVersions: () => Promise<ConflictVersion[]>;
	onResolve: (choice: ConflictChoice) => Promise<void>;
	onDelete: () => Promise<void>;
}

/**
 * Sync kept more than one version of this entry, or a delete nobody's edit saw, and the user
 * chooses. See docs/sync-conflicts.md.
 */
export function ConflictBanner({
	entry,
	conflict,
	onReadVersions,
	onResolve,
	onDelete,
}: ConflictBannerProps) {
	const { t } = useLingui();
	const [versions, setVersions] = useState<ConflictVersion[] | null>(null);
	const [busy, setBusy] = useState(false);

	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		try {
			await action();
		} finally {
			setBusy(false);
		}
	};
	const deleteButton = (
		<Button variant="destructive" size="sm" disabled={busy} onClick={() => void run(onDelete)}>
			<Trans>Delete it</Trans>
		</Button>
	);

	return (
		<div
			className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm"
			role="status"
		>
			<div className="flex items-start gap-2.5">
				<GitMerge className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-500" />
				<div className="min-w-0 flex-1 space-y-1">
					{conflict.versions > 0 && (
						<p>
							<Trans>This entry was changed on two devices before they synced.</Trans>
						</p>
					)}
					{conflict.deleted && (
						<p>
							<Trans>
								This entry was deleted on one device and changed on another before they synced.
							</Trans>
						</p>
					)}
					<div className="flex flex-wrap gap-2 pt-1">
						{conflict.versions > 0 ? (
							versions === null && (
								<Button
									variant="secondary"
									size="sm"
									disabled={busy}
									onClick={() => void run(async () => setVersions(await onReadVersions()))}
								>
									<Trans>Compare versions</Trans>
								</Button>
							)
						) : (
							<>
								<Button
									variant="secondary"
									size="sm"
									disabled={busy}
									onClick={() => void run(() => onResolve({ kind: "keep" }))}
								>
									<Trans>Keep it</Trans>
								</Button>
								{deleteButton}
							</>
						)}
					</div>
				</div>
			</div>

			{versions && (
				<div className="mt-3 space-y-3">
					<VersionCard
						title={t`The version shown`}
						saved={entry.updatedAt}
						entry={entry}
						actions={
							<Button
								variant="secondary"
								size="sm"
								disabled={busy}
								onClick={() => void run(() => onResolve({ kind: "keep" }))}
							>
								<Trans>Keep this one</Trans>
							</Button>
						}
					/>
					{versions.map((v) => (
						<VersionCard
							key={`${v.hlc.wall}:${v.hlc.counter}:${v.hlc.node}`}
							title={t`The other version`}
							saved={v.hlc.wall}
							entry={{ ...v.data, id: entry.id } as Entry}
							actions={
								<>
									<Button
										variant="secondary"
										size="sm"
										disabled={busy}
										onClick={() => void run(() => onResolve({ kind: "use", hlc: v.hlc }))}
									>
										<Trans>Use this one</Trans>
									</Button>
									<Button
										variant="secondary"
										size="sm"
										disabled={busy}
										onClick={() => void run(() => onResolve({ kind: "keepBoth", hlc: v.hlc }))}
									>
										<Trans>Keep both</Trans>
									</Button>
								</>
							}
						/>
					))}
					{conflict.deleted && <div className="flex justify-end">{deleteButton}</div>}
				</div>
			)}
		</div>
	);
}

/** One version, rendered by its mode's own detail body. Copying here is not a use of the entry. */
function VersionCard({
	title,
	saved,
	entry,
	actions,
}: {
	title: string;
	saved: number | undefined;
	entry: Entry;
	actions: ReactNode;
}) {
	const { t } = useLingui();
	const { clipboard } = usePlatform();
	const [copied, setCopied] = useState<string | null>(null);
	const Detail = getEntryMode(entry.type).Detail;
	const copy = async (label: string, value: string) => {
		try {
			await clipboard.copy(value);
			setCopied(label);
		} catch {
			// Clipboard write can fail when the document isn't focused. Best-effort.
		}
	};

	return (
		<div className="rounded-lg border border-border/50 bg-card/50 p-3 space-y-2">
			<div className="flex items-baseline justify-between gap-2">
				<p className="font-medium text-foreground">{title}</p>
				{saved !== undefined && (
					<p className="text-[10px] text-muted-foreground">{t`Saved ${formatDateTime(saved)}`}</p>
				)}
			</div>
			<Detail entry={entry} copied={copied} copy={copy} />
			<div className="flex flex-wrap justify-end gap-2">{actions}</div>
		</div>
	);
}
