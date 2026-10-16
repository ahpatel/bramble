#!/usr/bin/env node
// Delete the build-artifact folders that grow without bound: the core's Rust target, the desktop's
// Tauri target, and iOS DerivedData (about 54 GB together by October 2026). Each regenerates on its
// next build, which starts from scratch.
//
// The desktop's release/bundle stays. The app may be running from bundle/macos/Bramble.app, and the
// browsers' native-messaging manifests point at the bramble-proxy inside it, so removing it would
// break the extension's link to the desktop app.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statfsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Delete the artifact folders under `root`, keeping the desktop bundle; returns what was removed. */
export function nukeArtifacts(root: string): string[] {
	const removed: string[] = [];
	const remove = (path: string): void => {
		if (!existsSync(path)) return;
		rmSync(path, { recursive: true, force: true });
		removed.push(path);
	};

	remove(join(root, "packages/core-rust/target"));
	remove(join(root, "packages/platform-mobile/ios/DerivedData"));

	const target = join(root, "packages/platform-desktop/src-tauri/target");
	if (existsSync(target)) {
		for (const entry of readdirSync(target)) {
			if (entry !== "release") remove(join(target, entry));
		}
		const release = join(target, "release");
		if (existsSync(release)) {
			for (const entry of readdirSync(release)) {
				if (entry !== "bundle") remove(join(release, entry));
			}
		}
	}
	return removed;
}

/** A build writing into these folders right now, if any. */
function runningBuild(): string | null {
	if (process.platform === "win32") return null;
	const procs = execFileSync("ps", ["-axo", "comm"], { encoding: "utf8" });
	const hit = procs.split("\n").find((p) => /(^|\/)(cargo|rustc|xcodebuild|gradle)/i.test(p));
	return hit ? hit.trim() : null;
}

function freeBytes(): number {
	const s = statfsSync(ROOT);
	return s.bavail * s.bsize;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const build = runningBuild();
	if (build && !process.argv.includes("--force")) {
		console.error(`A build is running (${build}); not deleting under it. Rerun with --force.`);
		process.exit(1);
	}
	const before = freeBytes();
	const removed = nukeArtifacts(ROOT);
	for (const path of removed) console.log(`removed ${path.slice(ROOT.length + 1)}`);
	const freed = (freeBytes() - before) / 1024 ** 3;
	console.log(removed.length ? `freed ${freed.toFixed(1)} GB` : "nothing to remove");
}
