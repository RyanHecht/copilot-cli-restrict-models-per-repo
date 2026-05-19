#!/usr/bin/env node
// Copilot CLI userPromptSubmitted hook: blocks prompts that would use a
// restricted model in a restricted git repo.
//
// Input  (stdin, JSON): { sessionId, timestamp, cwd, prompt }
// Output (stdout, JSON): { decision: "block", reason: "..." } to deny
//                        (anything else / empty to allow)
//
// "Current model" is resolved with this precedence:
//   1. payload.model        — once copilot-agent-runtime adds it to hook input
//   2. $COPILOT_MODEL       — BYOK env var
//   3. ~/.copilot/config.json  → "model"
//   4. ~/.copilot/settings.json → "model"
//
// On any internal error we ALLOW (fail-open) so a bad policy file or a
// transient git failure never bricks the CLI for the user.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.COPILOT_PLUGIN_ROOT || resolve(HERE, "..");
const POLICY_PATH = join(PLUGIN_ROOT, "policy.json");

/** Print stdout JSON and exit 0. Empty object = "allow, no changes". */
function allow() {
    process.stdout.write("{}");
    process.exit(0);
}

function block(reason) {
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
    process.exit(0);
}

function debug(msg) {
    if (process.env.RESTRICT_MODELS_DEBUG) {
        process.stderr.write(`[restrict-models-per-repo] ${msg}\n`);
    }
}

async function readStdin() {
    return new Promise((res) => {
        let buf = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c) => (buf += c));
        process.stdin.on("end", () => res(buf));
        // If stdin is a TTY (e.g. running manually) end immediately.
        if (process.stdin.isTTY) res("");
    });
}

function safeJSONParse(s) {
    try {
        return JSON.parse(s);
    } catch {
        return undefined;
    }
}

function readJSONFile(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
}

/** Resolve the model name the upcoming prompt will use. */
function resolveCurrentModel(payload) {
    if (payload && typeof payload.model === "string" && payload.model.trim()) {
        return payload.model.trim();
    }
    if (process.env.COPILOT_MODEL && process.env.COPILOT_MODEL.trim()) {
        return process.env.COPILOT_MODEL.trim();
    }
    const copilotDir = join(homedir(), ".copilot");
    // config.json takes precedence over settings.json (matches UserSettings.load).
    for (const file of ["config.json", "settings.json"]) {
        const cfg = readJSONFile(join(copilotDir, file));
        if (cfg && typeof cfg.model === "string" && cfg.model.trim()) {
            return cfg.model.trim();
        }
    }
    return undefined;
}

/** Run `git -C <cwd> remote -v` and return every unique remote URL. */
function getRemoteURLs(cwd) {
    try {
        const r = spawnSync("git", ["-C", cwd, "remote", "-v"], {
            encoding: "utf8",
            timeout: 2000,
        });
        if (r.status !== 0) return [];
        const urls = new Set();
        for (const line of r.stdout.split(/\r?\n/)) {
            // Format: "<name>\t<url> (fetch|push)"
            const m = line.match(/^\S+\s+(\S+)\s+\((?:fetch|push)\)$/);
            if (m) urls.add(m[1]);
        }
        return [...urls];
    } catch {
        return [];
    }
}

/**
 * Normalize a git remote URL for matching.
 *   git@github.com:org/repo.git           → github.com/org/repo
 *   ssh://git@github.com/org/repo.git     → github.com/org/repo
 *   https://github.com/org/repo.git       → github.com/org/repo
 *   https://user:tok@gitlab.com/x/y.git   → gitlab.com/x/y
 *   /abs/path/to/local.git                → /abs/path/to/local
 * Result is host + path, lowercase host, no scheme, no userinfo, no trailing ".git".
 */
function normalizeRemoteURL(raw) {
    if (!raw) return "";
    let s = String(raw).trim();
    // git@host:path  →  host/path
    const scp = s.match(/^(?:[\w._-]+@)?([\w.-]+):(.+)$/);
    if (scp && !/^[a-zA-Z]+:\/\//.test(s) && !s.startsWith("/")) {
        s = `${scp[1].toLowerCase()}/${scp[2]}`;
    } else if (/^[a-zA-Z]+:\/\//.test(s)) {
        try {
            const u = new URL(s);
            s = `${u.host.toLowerCase()}${u.pathname}`;
        } catch {
            // fall through, use s as-is
        }
    }
    // Strip leading slashes and trailing .git
    s = s.replace(/^\/+/, "").replace(/\.git$/i, "");
    // Collapse duplicate slashes
    s = s.replace(/\/{2,}/g, "/");
    return s;
}

/**
 * Convert a glob pattern (supporting `*` and `?`) to a case-insensitive RegExp
 * anchored at both ends. Plain (no-wildcard) patterns become a literal match.
 */
function globToRegex(pattern) {
    const normalized = normalizeRemoteURL(pattern);
    // For matching purposes we apply the same normalization to both the pattern
    // and the candidate so users can list ssh-style URLs in policy.json and have
    // them match https-style remotes and vice versa.
    let re = "";
    for (const ch of normalized) {
        if (ch === "*") re += ".*";
        else if (ch === "?") re += ".";
        else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`, "i");
}

/** Same idea for model patterns — no URL normalization. */
function modelGlobToRegex(pattern) {
    let re = "";
    for (const ch of String(pattern).trim()) {
        if (ch === "*") re += ".*";
        else if (ch === "?") re += ".";
        else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`, "i");
}

function loadPolicy() {
    const policy = readJSONFile(POLICY_PATH);
    if (!policy || !Array.isArray(policy.rules)) {
        debug(`no policy.json at ${POLICY_PATH} (or no .rules array); allowing.`);
        return { rules: [] };
    }
    return policy;
}

async function main() {
    const stdin = await readStdin();
    const payload = safeJSONParse(stdin) || {};
    const cwd = payload.cwd || process.cwd();

    const policy = loadPolicy();
    if (policy.rules.length === 0) return allow();

    const model = resolveCurrentModel(payload);
    if (!model) {
        debug("could not resolve current model; allowing.");
        return allow();
    }

    const remotes = getRemoteURLs(cwd).map(normalizeRemoteURL).filter(Boolean);
    if (remotes.length === 0) {
        debug(`no git remotes for cwd=${cwd}; allowing.`);
        return allow();
    }

    debug(`model=${model} remotes=${JSON.stringify(remotes)}`);

    for (const rule of policy.rules) {
        const modelPatterns = Array.isArray(rule.models) ? rule.models : [];
        const repoPatterns = Array.isArray(rule.repos) ? rule.repos : [];
        if (modelPatterns.length === 0 || repoPatterns.length === 0) continue;

        const modelHit = modelPatterns.find((p) => modelGlobToRegex(p).test(model));
        if (!modelHit) continue;

        const repoRegexes = repoPatterns.map((p) => ({ p, re: globToRegex(p) }));
        const repoHit = remotes
            .flatMap((r) => repoRegexes.filter(({ re }) => re.test(r)).map(({ p }) => ({ remote: r, pattern: p })))
            .at(0);
        if (!repoHit) continue;

        const why = rule.description ? ` (${rule.description})` : "";
        return block(
            `restrict-models-per-repo: model "${model}" matches restricted pattern "${modelHit}" and ` +
                `git remote "${repoHit.remote}" matches restricted pattern "${repoHit.pattern}"${why}.\n` +
                `Switch model with /model, or run this prompt in a different repository.`,
        );
    }

    return allow();
}

main().catch((err) => {
    // Fail open on unexpected errors — never deny a prompt because the hook crashed.
    debug(`unexpected error: ${err?.stack || err}`);
    allow();
});
