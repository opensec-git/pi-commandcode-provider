import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  createReapCaptureFromEnv,
  REAP_CAPTURE_SCHEMA_VERSION,
  ReapCaptureStore,
} from "../src/reap-capture.ts"
import { makeContext, makeModel } from "./helpers.ts"

async function withTempDirectory(run: (path: string) => Promise<void>): Promise<void> {
  const path = await mkdtemp(join(tmpdir(), "commandcode-reap-"))
  try {
    await run(path)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
}

describe("REAP request capture", () => {
  it("is always enabled and uses a home-directory default", () => {
    const capture = createReapCaptureFromEnv({
      COMMANDCODE_REAP_CAPTURE: "0",
      COMMANDCODE_REAP_CAPTURE_REQUIRED: "0",
    })
    assert.match(capture.rootDir, /[\\/]\.pi[\\/]reap-capture$/)
    const overridden = createReapCaptureFromEnv({
      COMMANDCODE_REAP_CAPTURE_DIR: "/mounted/reap",
    })
    assert.equal(overridden.rootDir, "/mounted/reap")
  })

  it("stores an atomic replay bundle without authentication credentials", async () => {
    await withTempDirectory(async (rootDir) => {
      const store = new ReapCaptureStore({
        rootDir,
        env: {
          COMMANDCODE_REAP_RUN_ID: "run-7",
          COMMANDCODE_REAP_REPOSITORY: "owner/repo",
          PI_BG_DELEGATE_TASK_ID: "task-3",
        },
        now: () => new Date("2026-09-28T12:00:00.000Z"),
        uuid: () => "request-uuid",
        cwd: () => "/work/repo",
      })
      const model = makeModel({ id: "deepseek-v4-flash", api: "openai-completions" })
      const context = makeContext()
      const capture = await store.begin({
        model,
        context,
        options: {
          apiKey: "must-not-be-written",
          sessionId: "pi-session-1",
          maxTokens: 8192,
          headers: {
            Authorization: "Bearer must-not-be-written",
            Cookie: "must-not-be-written",
            "Content-Type": "application/json",
            "X-Session-Id": "safe-session",
          },
          onPayload: (payload) => ({ wrapped: payload }),
        },
      })
      capture.recordTransport("provider")

      const body = JSON.stringify({ model: model.id, messages: [{ role: "user", content: "hi" }] })
      const options = capture.wrapOptions({
        apiKey: "must-not-be-written",
        sessionId: "pi-session-1",
        headers: { Authorization: "Bearer must-not-be-written" },
        onPayload: (payload) => ({ wrapped: payload }),
        fetch: async () =>
          new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "set-cookie": "must-not-be-written",
              "x-request-id": "upstream-42",
            },
          }),
      })
      const payload = await options.onPayload?.({ original: true }, model)
      assert.deepEqual(payload, { wrapped: { original: true } })
      const response = await options.fetch?.(
        "https://provider.example/v1/chat?token=must-not-be-written&mode=test",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer must-not-be-written",
            "Content-Type": "application/json",
            "X-Session-Id": "safe-session",
          },
          body,
        },
      )
      assert.ok(response)
      const responseBody = await response.text()
      assert.match(responseBody, /\[DONE\]/)

      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "hello" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop" as const,
        timestamp: 1,
      }
      capture.observeEvent({ type: "start", partial: message })
      capture.observeEvent({ type: "done", reason: "stop", message })
      await capture.finalize("completed")

      const requestDir = join(rootDir, "requests", capture.requestId)
      assert.deepEqual(await readdir(join(rootDir, ".inflight")), [])
      assert.ok((await stat(join(requestDir, "COMMITTED"))).isFile())
      assert.equal((await stat(requestDir)).mode & 0o777, 0o700)
      assert.equal((await stat(join(requestDir, "context.json"))).mode & 0o777, 0o600)

      const manifest = JSON.parse(await readFile(join(requestDir, "manifest.json"), "utf8"))
      assert.equal(manifest.schema_version, REAP_CAPTURE_SCHEMA_VERSION)
      assert.equal(manifest.status, "completed")
      assert.equal(manifest.transport, "provider")
      assert.equal(manifest.attempts, 1)
      assert.equal(manifest.run_id, "run-7")
      assert.equal(manifest.repository, "owner/repo")
      assert.equal(manifest.delegate_task_id, "task-3")

      const savedOptions = await readFile(join(requestDir, "options.json"), "utf8")
      assert.doesNotMatch(savedOptions, /must-not-be-written/)
      assert.doesNotMatch(savedOptions, /apiKey/)
      assert.match(savedOptions, /authorization/)
      assert.match(savedOptions, /cookie/)
      const savedPayload = JSON.parse(await readFile(join(requestDir, "payload.json"), "utf8"))
      assert.deepEqual(savedPayload, { wrapped: { original: true } })

      const attemptDir = join(requestDir, "attempts", "0001")
      assert.equal(await readFile(join(attemptDir, "request.body.bin"), "utf8"), body)
      assert.equal(await readFile(join(attemptDir, "response.body.bin"), "utf8"), responseBody)
      const requestMetadata = await readFile(join(attemptDir, "request.json"), "utf8")
      assert.doesNotMatch(requestMetadata, /must-not-be-written/)
      assert.match(requestMetadata, /token=%5BREDACTED%5D/)
      assert.match(requestMetadata, /safe-session/)
      const responseMetadata = await readFile(join(attemptDir, "response.json"), "utf8")
      assert.doesNotMatch(responseMetadata, /set-cookie.*must-not-be-written/)
      assert.match(responseMetadata, /upstream-42/)

      const events = (await readFile(join(requestDir, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      assert.equal(events[0].type, "start")
      assert.equal("partial" in events[0], false)
      assert.equal(events[1].type, "done")
      const normalized = JSON.parse(
        await readFile(join(requestDir, "normalized-response.json"), "utf8"),
      )
      assert.equal(normalized.content[0].text, "hello")

      const complete = JSON.parse(
        await readFile(join(attemptDir, "response.complete.json"), "utf8"),
      )
      assert.equal(complete.state, "complete")
      assert.equal(complete.body_bytes, Buffer.byteLength(responseBody))

      const allFiles = await readdir(requestDir, { recursive: true })
      for (const file of allFiles) {
        if ((await stat(join(requestDir, file))).isFile()) {
          const contents = await readFile(join(requestDir, file))
          assert.equal(contents.includes(Buffer.from("must-not-be-written")), false, file)
        }
      }
    })
  })

  it("marks failed and aborted requests distinctly", async () => {
    await withTempDirectory(async (rootDir) => {
      const store = new ReapCaptureStore({ rootDir })
      const failed = await store.begin({ model: makeModel(), context: makeContext() })
      await failed.finalize("failed", new Error("upstream failed"))
      assert.ok((await stat(join(rootDir, "requests", failed.requestId, "FAILED"))).isFile())

      const aborted = await store.begin({ model: makeModel(), context: makeContext() })
      await aborted.finalize("aborted", new Error("cancelled"))
      assert.ok((await stat(join(rootDir, "requests", aborted.requestId, "ABORTED"))).isFile())
    })
  })
})
