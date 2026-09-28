# Docker setup for repository REAP runs

This guide describes the storage and launch contract for running Pi inside Docker while capturing
all first-pass data required for a later teacher-forced REAP replay. It does not prescribe a
particular Pi image, agent package set, or DAST environment. Install this provider and the required
Pi packages in the image using the harness's normal package mechanism.

The important invariants are:

- mount the intended repository at Pi's actual working directory;
- use a unique run ID and capture directory for each repository run;
- persist both REAP bundles and Pi sessions outside the container;
- keep capture fail-closed; and
- use only bundles marked `COMMITTED` during replay.

## Required and recommended storage

| Container path            | Persist?             | Purpose                                                                                                                                                  |
| ------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/workspace`              | Repository-dependent | The exact repository checkout Pi analyzes. Pi must start with this as its working directory.                                                             |
| `/data/reap`              | **Required**         | Exact provider requests, responses, stream events, hashes, and replay receipts. This is the required first-pass input for REAP.                          |
| `/data/sessions`          | **Recommended**      | Parent and child Pi session JSONL, including assistant messages, tool calls, and tool results. Used to audit request coverage and subagent lineage.      |
| `/data/pi-agent`          | Recommended          | Pi settings, installed package state, and `/login` credentials. Protect this path as secret-bearing state.                                               |
| `/data/home`              | Optional             | Persistent home-directory state needed by the selected Pi packages.                                                                                      |
| `/tmp/pi-subagents-<uid>` | No                   | Convenience `.output` copies produced by the subagents package. They are not required for REAP when child sessions and provider captures are persistent. |

The host directories backing `/data/reap`, `/data/sessions`, `/data/pi-agent`, and `/data/home`
must survive container removal. Do not store capture data only in the container's writable layer.

The provider writes capture directories with mode `0700` and capture files with mode `0600`. A
container running as root can therefore create host bind mounts that are not directly readable by an
unprivileged host account. Choose a consistent container UID/GID or access the data through a trusted
container; do not weaken permissions on sensitive captures merely for convenience.

## Compose contract

The following fragment shows the relevant settings. Replace the image and provider installation
steps with the repository harness's own setup. Do not bake API keys or Pi credentials into the image.

```yaml
services:
  agent:
    image: your-pi-image:local
    stdin_open: true
    tty: true
    working_dir: /workspace
    environment:
      HOME: /data/home
      PI_CODING_AGENT_DIR: /data/pi-agent
      PI_CODING_AGENT_SESSION_DIR: /data/sessions
      COMMANDCODE_REAP_CAPTURE: "1"
      COMMANDCODE_REAP_CAPTURE_REQUIRED: "1"
      COMMANDCODE_REAP_CAPTURE_DIR: /data/reap
      COMMANDCODE_REAP_RUN_ID: ${REAP_RUN_ID:?set REAP_RUN_ID}
      COMMANDCODE_REAP_REPOSITORY: ${REAP_REPOSITORY:?set REAP_REPOSITORY}
      COMMANDCODE_REAP_CAPTURE_ORIGIN: docker-pi
    volumes:
      - ${TARGET_REPOSITORY_PATH:?set TARGET_REPOSITORY_PATH}:/workspace
      - ./.state/runs/${REAP_RUN_ID}/reap:/data/reap
      - ./.state/runs/${REAP_RUN_ID}/sessions:/data/sessions
      - ./.state/pi-agent:/data/pi-agent
      - ./.state/home:/data/home
```

Keep the run-specific REAP and session directories separate. Reusing one unlabeled directory for
several test and repository sessions makes later dataset assembly ambiguous even when every request
was captured correctly.

The Pi agent directory is intentionally shared in this example so `/login` and installed package
state survive between runs. It contains credentials and must not be archived with the calibration
dataset. If runs require stronger isolation, give each run a separate Pi agent directory and perform
authentication through the harness's secret-management flow.

## Start one repository run

Use an immutable or recorded repository commit and a unique run identifier:

```bash
export TARGET_REPOSITORY_PATH=/absolute/path/to/repository
export REAP_REPOSITORY=owner/repository
export REAP_RUN_ID=owner-repository-2026-09-28-001

docker compose up -d agent
docker compose exec agent git -C /workspace rev-parse HEAD
docker compose exec agent pi
```

Before submitting the first prompt, confirm that the printed commit is the intended checkout. Pi
inherits `/workspace` from the service's `working_dir`; starting Pi from a shell in another directory
captures that other working directory instead.

For an already-running generic container, set the run labels on the new Pi process and select its
working directory explicitly:

```bash
docker compose exec \
  -e COMMANDCODE_REAP_CAPTURE=1 \
  -e COMMANDCODE_REAP_CAPTURE_REQUIRED=1 \
  -e COMMANDCODE_REAP_CAPTURE_DIR=/data/reap \
  -e COMMANDCODE_REAP_RUN_ID="$REAP_RUN_ID" \
  -e COMMANDCODE_REAP_REPOSITORY="$REAP_REPOSITORY" \
  -e COMMANDCODE_REAP_CAPTURE_ORIGIN=docker-pi \
  -w /workspace \
  agent pi
```

Environment changes do not alter a Pi process that is already running. Exit the old Pi process and
start a new one for a differently labeled repository run; do not reuse an interactive process whose
working directory or capture labels are wrong.

## What must exist after the run

The essential replay input is:

```text
/data/reap/
├── .inflight/
└── requests/
    └── <request-id>/
        ├── manifest.json
        ├── context.json
        ├── options.json
        ├── payload.json
        ├── events.jsonl
        ├── normalized-response.json
        ├── COMMITTED
        └── attempts/0001/
            ├── request.json
            ├── request.body.bin
            ├── response.json
            ├── response.body.bin
            └── response.complete.json
```

Every model call in the parent and subagent sessions passes through the provider independently and
receives its own request bundle. For coefficient replay, retain every relevant bundle containing
`COMMITTED`. Do not treat `FAILED`, `ABORTED`, or a directory left under `.inflight` as a complete
sample.

`/data/sessions` is not a substitute for `/data/reap`: session JSONL preserves the semantic Pi and
tool trajectory, while the REAP bundle preserves the final model-visible payload and exact transport
bytes. Persist both so the run can be reconciled before spending GPU compute.

## End-of-run acceptance checks

Perform these checks while the container is still available:

1. Every intended Pi assistant response ID has exactly one matching
   `normalized-response.json.responseId`.
2. Every assistant tool-call ID has exactly one matching tool-result ID in the same Pi session.
3. Every accepted bundle contains `COMMITTED`, has manifest status `completed`, and has no missing
   required file.
4. Recomputed SHA-256 hashes and byte lengths for `request.body.bin` and `response.body.bin` match
   `request.json` and `response.complete.json`.
5. Each manifest has the expected `run_id`, `repository`, `cwd`, model, and Pi `session_id`.
6. No unexpected prior test session shares the repository run ID or run-specific capture directory.

Useful inventory commands that do not perform model inference are:

```bash
docker compose exec agent sh -lc \
  'find /data/reap/requests -mindepth 2 -maxdepth 2 -name COMMITTED -type f | wc -l'

docker compose exec agent sh -lc \
  'find /data/reap/.inflight -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l'

docker compose exec agent sh -lc \
  'for file in /data/reap/requests/*/manifest.json; do
     jq -r "[.run_id, .repository, .cwd, .model, .session_id, .status] | @tsv" "$file"
   done | sort -u'
```

An open interactive Pi process can be idle at a completed turn and later produce more requests. Take
the final acceptance snapshot only after the intended run is finished, or record the exact session
and request cutoff used by the replay dataset.

## Temporary subagent outputs

The `opensec-pi-subagents` package can write human-readable `.output` files below a path such as
`/tmp/pi-subagents-<uid>/...`. These files are useful for debugging but are not required for REAP
when all of the following are true:

- child Pi session JSONL is persisted under `/data/sessions`;
- all child model calls have committed bundles under `/data/reap/requests`; and
- an end-of-run audit confirms response-ID and tool-call/result coverage.

Mount the temporary directory only if the canonical archive specifically requires those rendered
convenience copies. Their absence does not prevent teacher-forced replay or coefficient generation.

## Boundary of the first-pass capture

The Docker capture contains everything this remote provider can observe. It does not contain local
DeepSeek router probabilities, selected expert IDs, expert norms, internal token IDs, or top-64
vocabulary logits. Generate those once during the instrumented local-model replay and write them to
the canonical replay store together with model, tokenizer, dtype, runtime, and hardware provenance.
