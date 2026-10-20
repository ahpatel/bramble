// Follows a desktop release AND the sign-windows.yml run it starts, a line per change, printing the
// SignPath approval link once announced. `gh run watch` sees only the first run, so it would sit
// silent through the one step that waits on you outside GitHub. See docs/release-signing.md.

export interface Job {
	name: string;
	status: string;
	conclusion: string | null;
	databaseId: number;
}

export interface Annotation {
	annotation_level: string;
	title: string;
	message: string;
}

/** The notice sign-windows.yml raises once its request is submitted. Must match the workflow. */
export const SIGNPATH_NOTICE = "Approve in SignPath";

const SIGN_WORKFLOW = "sign-windows.yml";

/** The approval link the signing job announced, or null until it has. */
export function signpathLink(annotations: Annotation[]): string | null {
	const notice = annotations.find(
		(a) => a.annotation_level === "notice" && a.title === SIGNPATH_NOTICE,
	);
	return notice?.message.trim() || null;
}

function describe(job: Job): string {
	if (job.status === "completed") return job.conclusion ?? "completed";
	// A job held at an environment's required reviewers.
	if (job.status === "waiting") return "waiting for your approval";
	return job.status.replace("_", " ");
}

/** One line per job whose state moved since `seen`, which is updated to match. */
export function jobChanges(jobs: Job[], seen: Map<string, string>, prefix = ""): string[] {
	const lines: string[] = [];
	for (const job of jobs) {
		const now = describe(job);
		if (seen.get(job.name) === now) continue;
		seen.set(job.name, now);
		lines.push(`  ${prefix}${job.name}: ${now}`);
	}
	return lines;
}

/** `gh` with these arguments, returning stdout; throws when it fails. */
export type Gh = (args: string[]) => string;

/** The link any started job of a signing run announced, or null. Throws if GitHub won't say. */
export function findLink(repo: string, jobs: Job[], gh: Gh): string | null {
	for (const job of jobs.filter((j) => j.status !== "queued")) {
		const annotations = JSON.parse(
			gh(["api", `repos/${repo}/check-runs/${job.databaseId}/annotations`]),
		) as Annotation[];
		const link = signpathLink(annotations);
		if (link) return link;
	}
	return null;
}

export interface WatchOptions {
	repo: string;
	runId: string;
	/** When the release was dispatched: tells its signing run apart from older ones. */
	since: string;
	/** Whether this release builds Windows at all. */
	windows: boolean;
	pollMs?: number;
}

export interface WatchDeps {
	gh: Gh;
	sleep(ms: number): void;
	log(line: string): void;
}

/** Follow the release until it finishes, and return its conclusion. */
export function watchDesktopRelease(o: WatchOptions, deps: WatchDeps): string {
	const pollMs = o.pollMs ?? 30_000;
	const json = <T>(args: string[]): T => JSON.parse(deps.gh(args)) as T;
	const seen = new Map<string, string>();
	const seenWindows = new Map<string, string>();
	let signRun: string | null = null;
	let signDone = false;
	let link: string | null = null;
	let failures = 0;

	for (;;) {
		let release: { status: string; conclusion: string | null; jobs: Job[] } | null = null;
		try {
			release = json([
				"run",
				"view",
				o.runId,
				"--repo",
				o.repo,
				"--json",
				"status,conclusion,jobs",
			]);
			failures = 0;
		} catch (e) {
			// A dropped connection is ordinary over hours; only a run of them gives up.
			if (++failures >= 10) throw e;
		}
		if (release) for (const line of jobChanges(release.jobs, seen)) deps.log(line);

		if (o.windows && !signDone) {
			try {
				if (!signRun) {
					const runs = json<{ databaseId: number; createdAt: string }[]>([
						"run",
						"list",
						"--repo",
						o.repo,
						"--workflow",
						SIGN_WORKFLOW,
						"--event",
						"workflow_dispatch",
						"--limit",
						"5",
						"--json",
						"databaseId,createdAt",
					]);
					const mine = runs
						.filter((r) => r.createdAt >= o.since)
						.sort((a, b) => b.databaseId - a.databaseId)[0];
					if (mine) {
						signRun = String(mine.databaseId);
						deps.log(`  windows: building in https://github.com/${o.repo}/actions/runs/${signRun}`);
					}
				}
				if (signRun) {
					const sign = json<{ status: string; jobs: Job[] }>([
						"run",
						"view",
						signRun,
						"--repo",
						o.repo,
						"--json",
						"status,jobs",
					]);
					for (const line of jobChanges(sign.jobs, seenWindows, "windows: ")) deps.log(line);
					if (!link) {
						link = findLink(o.repo, sign.jobs, deps.gh);
						if (link)
							deps.log(`\n  windows: approve the signing request in SignPath now:\n    ${link}\n`);
					}
					if (sign.status === "completed") signDone = true;
				}
			} catch {
				// A courtesy: the release run decides the outcome, and it waits on this one anyway.
			}
		}

		if (release?.status === "completed") return release.conclusion ?? "unknown";
		deps.sleep(pollMs);
	}
}
