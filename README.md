# restrict-models-per-repo

A Copilot CLI plugin (proof of concept) that blocks a user prompt before it is
sent to the model when **both**:

1. the current git repo's remote URL matches one of the configured restricted
   remote patterns, **and**
2. the currently selected model matches one of that rule's restricted model
   patterns.

The block happens in a `userPromptSubmitted` hook returning
`{"decision":"block","reason":"..."}`, so the prompt never reaches the model,
chat history, or transcript.

## Install (local PoC)

```bash
copilot plugin install ~/scratch/restrict-models-per-repo
```

…or, from anywhere, with the absolute path. You can also point Copilot CLI at
the plugin without installing via `--plugin-dir ~/scratch/restrict-models-per-repo`.

## Configure

Edit `policy.json` next to `plugin.json`:

```json
{
    "rules": [
        {
            "description": "Forbid Opus-class and GPT-5 models in the customer's monorepo.",
            "models": ["claude-opus-*", "gpt-5*"],
            "repos": [
                "https://github.com/example-org/secret-monorepo",
                "git@github.com:example-org/secret-monorepo.git",
                "https://gitlab.com/example-org/secret-*"
            ]
        }
    ]
}
```

- `models` and `repos` support `*` and `?` glob wildcards.
- `repos` entries are normalized to `host/path` (no scheme, no userinfo, no
  trailing `.git`) before matching, so an `https://…` pattern matches an
  `ssh://…` remote and vice versa. The plugin reads **every** remote on the
  repo (`git remote -v`), not just `origin`.
- Multiple rules are OR'd together; within a rule, model AND repo must both
  match for the prompt to be blocked.

## How "current model" is resolved

In precedence order:

1. `payload.model` from the hook input — **once `copilot-agent-runtime` adds
   `model` to the hook payload (planned)**. Today this field is not present.
2. `$COPILOT_MODEL` environment variable (BYOK / explicit override).
3. `~/.copilot/config.json` `"model"` field — what `/model` writes.
4. `~/.copilot/settings.json` `"model"` field — legacy fallback.

> **Known gap until #1 lands:** if a user starts Copilot CLI with
> `copilot --model X` and `X` differs from their persisted `/model` choice and
> they haven't set `$COPILOT_MODEL`, the hook will check against the persisted
> model instead of `X`. For Most environments this is fine; for strict
> enforcement, also set `COPILOT_MODEL` in the shell wrapper that launches
> Copilot CLI.

## Debug

Set `RESTRICT_MODELS_DEBUG=1` to log decisions to stderr. Hook stderr is
visible in the Copilot CLI debug log.

## Files

```
restrict-models-per-repo/
├── plugin.json            # plugin manifest, points hooks → ./hooks/hooks.json
├── policy.json            # restriction rules (edit this)
├── policy.schema.json     # JSON-schema reference for policy.json
├── hooks/
│   ├── hooks.json         # registers the userPromptSubmitted hook
│   └── check.mjs          # Node.js script that does the matching
└── README.md
```
