import { useLingui } from "@lingui/react/macro";
import { Users } from "lucide-react";
import { Button } from "../components/ui/button";

/**
 * The sharing counterpart of TagsDetail: one tappable chip per collection the
 * entry is shared through, each filtering the vault list via an `@collection`
 * token. The owner reads it as "these people can see this"; a member reads it
 * as "this came from here, and it can be taken away" — the row's honesty note
 * already says the second part, so the chips stay neutral here.
 */
export function CollectionsDetail({
	collections,
	onSelect,
}: {
	collections: string[];
	onSelect(name: string): void;
}) {
	const { t } = useLingui();
	if (collections.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1.5">
			{collections.map((name) => (
				<Button
					key={name}
					variant="link"
					size="none"
					onClick={() => onSelect(name)}
					aria-label={t`Show entries in ${name}`}
					className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-border"
				>
					<Users className="w-3 h-3 shrink-0" />
					{name}
				</Button>
			))}
		</div>
	);
}
