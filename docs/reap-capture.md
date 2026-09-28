# REAP replay capture

The provider can persist an opt-in, replay-grade record of each CommandCode model request. These
records let a later locally hosted copy of the same DeepSeek model reproduce the token sequence and
collect router/expert measurements without rerunning the Pi agent or its tools.

This feature records data on the Pi machine. It does not start a model, upload data, or use GPU
compute.

## Enable capture

```bash
export COMMANDCODE_REAP_CAPTURE=1
```

The default root is `~/.pi/reap-capture`. Set an explicit path when the capture should live on a
mounted volume:

```bash
export COMMANDCODE_REAP_CAPTURE_DIR=/mnt/reap/pi-commandcode
```

Capture is fail-closed by default: Pi receives an error instead of a successful terminal event when
a replay bundle cannot be committed. This is the recommended mode for a calibration run because it
prevents an apparently complete trajectory from having missing inference data.

For ordinary interactive use where inference is more important than capture completeness, opt into
best-effort behavior:

```bash
export COMMANDCODE_REAP_CAPTURE_REQUIRED=0
```

Best-effort failures are marked `FAILED` when enough of the bundle can still be written. Never use a
`FAILED` bundle as a complete calibration sample.

Optional lineage labels make later dataset assembly deterministic:

```bash
export COMMANDCODE_REAP_RUN_ID=calibration-2026-09-28
export COMMANDCODE_REAP_REPOSITORY=owner/repository
export COMMANDCODE_REAP_CAPTURE_ORIGIN=pi-vvah
export COMMANDCODE_REAP_PARENT_SESSION_ID=<parent-pi-session-id>
```

The provider also records `PI_BG_DELEGATE_TASK_ID` and `PI_BG_DELEGATE_ARTIFACT_DIR` when the
background delegate supplies them. The Pi `sessionId`, when present, is recorded independently.

## Bundle contract

The schema identifier is `opensec.commandcode-reap-capture.v1`. A logical Pi model request is first
written below `.inflight/` and then renamed atomically into `requests/`:

```text
~/.pi/reap-capture/
├── .inflight/
└── requests/
    └── <timestamp>_<request-uuid>/
        ├── manifest.json
        ├── context.json
        ├── options.json
        ├── payload.json
        ├── events.jsonl
        ├── normalized-response.json
        ├── COMMITTED
        └── attempts/
            └── 0001/
                ├── request.json
                ├── request.body.bin
                ├── response.json
                ├── response.body.bin
                └── response.complete.json
```

An upstream retry creates `0002`, `0003`, and so on. A Provider API request that selects the legacy
fallback remains one logical bundle but contains attempts from both transports; `manifest.json`
records the final selected transport.

The files have these roles:

| Artifact                   | Purpose                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `manifest.json`            | Schema, request/model identity, lineage, transport, timestamps, status, and attempt count     |
| `context.json`             | Pi system prompt, normalized message history, and tool definitions before provider conversion |
| `options.json`             | Non-secret generation controls such as maximum tokens, temperature, reasoning, and session ID |
| `payload.json`             | Final provider payload after all `onPayload` transformations                                  |
| `events.jsonl`             | Compact Pi stream events; repeated full partial messages are omitted from delta rows          |
| `normalized-response.json` | Final or last partial Pi assistant message                                                    |
| `request.body.bin`         | Exact serialized HTTP request body for this attempt                                           |
| `request.json`             | Sanitized URL/header metadata plus request byte length and SHA-256                            |
| `response.body.bin`        | Exact streamed HTTP response bytes as consumed by the provider                                |
| `response.json`            | Sanitized HTTP status/header metadata                                                         |
| `response.complete.json`   | Stream completion state plus response byte length and SHA-256                                 |

`COMMITTED` is the replay-eligibility marker. `ABORTED` and `FAILED` preserve useful diagnostic or
partial data but are not complete samples. A directory left in `.inflight` means the process exited
before finalization and must not be treated as committed.

Directories use mode `0700` and files use mode `0600`.

## Credential and data handling

The recorder never writes `apiKey`, abort signals, callbacks, Authorization values, cookies, router
tokens, or other non-allowlisted header values. Secret-like URL query values are replaced with
`[REDACTED]`; omitted header names are retained so protocol differences remain auditable.

The request and response bodies are intentionally exact. They contain prompts, source-code excerpts,
tool definitions and results, assistant reasoning/text, and possibly other sensitive repository data.
If a credential was itself pasted into a prompt or returned by a tool, it can therefore appear in the
exact body. Treat the capture root as sensitive, mount it only into trusted replay containers, and do
not commit it to Git.

## Local DeepSeek replay

The capture stores everything the provider can observe. It does **not** contain DeepSeek-internal
token IDs, router probabilities, selected expert IDs, expert output norms, or vocabulary logits,
because CommandCode does not expose those internals.

The second pass should:

1. Select only bundles containing `COMMITTED` and verify every recorded body hash.
2. Pin the exact local model and tokenizer revisions used for the coefficient campaign.
3. Reconstruct the conversation from `payload.json`/`context.json` and teacher-force the recorded
   assistant continuation from `normalized-response.json` rather than sampling a new answer.
4. Tokenize locally and record token IDs, positions, attention boundaries, router logits or
   probabilities, selected experts, expert output norms, and per-layer/per-expert accumulators.
5. Store the selected top-64 vocabulary token IDs and logits (plus log-sum-exp) at the chosen replay
   positions. Top-64 is a replay output, not a CommandCode capture artifact.
6. Keep raw accumulators and denominators so layer-normalized REAP scores, routing-frequency scores,
   expected-contribution scores, and alternative thresholds can be recomputed without another model
   pass.

The captured response fixes the semantic trajectory, but exact floating-point activations still
depend on the local model revision, tokenizer, inference implementation, dtype, tensor-parallel layout,
and determinism settings. Record those in the replay report.
