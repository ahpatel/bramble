// node --test scripts/release-watch.test.ts
//
// The desktop release watcher, driven by a scripted fake `gh` so the polling loop runs as written.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type Annotation,
	type Job,
	jobChanges,
	SIGNPATH_NOTICE,
	signpathLink,
	watchDesktopRelease,
} from "./release-watch.ts";

const REPO = "o/r";
const SINCE = "2026-10-20T10:00:00Z";
const LINK = "https://app.signpath.io/Web/org/SigningRequests/abc";

const job = (name: string, status: string, conclusion: string | null = null, id = 1): Job => ({
	name,
	status,
	conclusion,
	databaseId: id,
});

describe("signpathLink", () => {
	it("reads the link from the announcement", () => {
		const a: Annotation[] = [{ annotation_level: "notice", title: SIGNPATH_NOTICE, message: LINK }];
		assert.equal(signpathLink(a), LINK);
	});

	it("ignores other annotations, including the signing job's own warnings", () => {
		const a: Annotation[] = [
			{ annotation_level: "warning", title: "", message: "signature is present but…" },
			{ annotation_level: "notice", title: "Something else", message: "https://x" },
		];
		assert.equal(signpathLink(a), null);
	});
});

describe("jobChanges", () => {
	it("reports a job once per change, not once per poll", () => {
		const seen = new Map<string, string>();
		assert.deepEqual(jobChanges([job("Bump", "in_progress")], seen), ["  Bump: in progress"]);
		assert.deepEqual(jobChanges([job("Bump", "in_progress")], seen), []);
		assert.deepEqual(jobChanges([job("Bump", "completed", "success")], seen), ["  Bump: success"]);
	});

	it("says when a job is waiting on an approval", () => {
		assert.deepEqual(jobChanges([job("Publish", "waiting")], new Map()), [
			"  Publish: waiting for your approval",
		]);
	});
});

/** A fake `gh` answering from per-poll scripts, logging each call. */
function fakeGh(s: {
	release: { status: string; conclusion?: string; jobs: Job[] }[];
	signRuns?: { databaseId: number; createdAt: string }[];
	sign?: { status: string; jobs: Job[] }[];
	/** Annotations by poll index (of the signing run), for the started signing job. */
	annotations?: Annotation[][];
	failReleaseViews?: number;
}) {
	const calls: string[][] = [];
	let releasePolls = 0;
	let signPolls = 0;
	let failures = s.failReleaseViews ?? 0;
	const gh = (args: string[]): string => {
		calls.push(args);
		if (args[0] === "run" && args[1] === "view" && args[2] === "100") {
			if (failures > 0) {
				failures--;
				throw new Error("connection reset by peer");
			}
			const r = s.release[Math.min(releasePolls++, s.release.length - 1)];
			return JSON.stringify({ conclusion: null, ...r });
		}
		if (args[0] === "run" && args[1] === "list") return JSON.stringify(s.signRuns ?? []);
		if (args[0] === "run" && args[1] === "view") {
			const list = s.sign ?? [];
			return JSON.stringify(list[Math.min(signPolls++, list.length - 1)]);
		}
		if (args[0] === "api") {
			const list = s.annotations ?? [];
			return JSON.stringify(list[Math.min(signPolls - 1, list.length - 1)] ?? []);
		}
		throw new Error(`unexpected gh ${args.join(" ")}`);
	};
	return { gh, calls };
}

function watch(f: ReturnType<typeof fakeGh>, windows = true) {
	const lines: string[] = [];
	const conclusion = watchDesktopRelease(
		{ repo: REPO, runId: "100", since: SINCE, windows, pollMs: 0 },
		{ gh: f.gh, sleep: () => {}, log: (l) => lines.push(l) },
	);
	return { conclusion, lines, out: lines.join("\n") };
}

const running = { status: "in_progress", jobs: [job("Publish", "waiting")] };
const done = {
	status: "completed",
	conclusion: "success",
	jobs: [job("Publish", "completed", "success")],
};

describe("watchDesktopRelease", () => {
	it("prints the SignPath link once, as soon as the signing job announces it", () => {
		const notice: Annotation = {
			annotation_level: "notice",
			title: SIGNPATH_NOTICE,
			message: LINK,
		};
		const f = fakeGh({
			release: [running, running, running, done],
			signRuns: [{ databaseId: 7, createdAt: "2026-10-20T10:01:00Z" }],
			sign: [
				{ status: "in_progress", jobs: [job("Build (unsigned)", "in_progress", null, 1)] },
				{ status: "in_progress", jobs: [job("Sign with SignPath", "in_progress", null, 2)] },
				{ status: "in_progress", jobs: [job("Sign with SignPath", "in_progress", null, 2)] },
				{ status: "completed", jobs: [job("Sign with SignPath", "completed", "success", 2)] },
			],
			annotations: [[], [notice], [notice], [notice]],
		});
		const { conclusion, out } = watch(f);

		assert.equal(conclusion, "success");
		assert.equal(out.split(LINK).length - 1, 1, "the link is printed exactly once");
		assert.match(out, /windows: building in https:\/\/github.com\/o\/r\/actions\/runs\/7/);
		assert.match(out, /windows: Sign with SignPath: success/);
		assert.match(out, /Publish: waiting for your approval/);
	});

	it("does not look for a signing run when the release skips Windows", () => {
		const f = fakeGh({ release: [running, done] });
		watch(f, false);

		assert.ok(!f.calls.some((c) => c[1] === "list"), "no sign-windows lookup");
	});

	it("ignores a signing run older than this release", () => {
		const f = fakeGh({
			release: [running, done],
			signRuns: [{ databaseId: 6, createdAt: "2026-10-20T09:59:00Z" }],
		});
		const { out } = watch(f);

		assert.doesNotMatch(out, /windows: building/);
	});

	it("rides out dropped connections", () => {
		const f = fakeGh({ release: [running, done], failReleaseViews: 3 });

		assert.equal(watch(f, false).conclusion, "success");
	});

	it("gives up after ten failures in a row", () => {
		const f = fakeGh({ release: [running], failReleaseViews: 10 });

		assert.throws(() => watch(f, false), /connection reset/);
	});

	it("returns a failed release as failed", () => {
		const failed = { status: "completed", conclusion: "failure", jobs: [] };
		assert.equal(watch(fakeGh({ release: [failed] }), false).conclusion, "failure");
	});

	it("keeps following the release when the annotations cannot be read", () => {
		// A workflow token without checks: read gets a 403 here; the release must still finish.
		const f = fakeGh({
			release: [running, done],
			signRuns: [{ databaseId: 7, createdAt: "2026-10-20T10:01:00Z" }],
			sign: [{ status: "in_progress", jobs: [job("Sign with SignPath", "in_progress", null, 2)] }],
		});
		const gh = f.gh;
		f.gh = (args) => {
			if (args[0] === "api") throw new Error("HTTP 403");
			return gh(args);
		};

		assert.equal(watch(f).conclusion, "success");
	});
});
