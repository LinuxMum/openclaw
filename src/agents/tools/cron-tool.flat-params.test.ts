import { validateToolArguments } from "@openclaw/llm-core/validation";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { isRecord } from "../../utils.js";
import { createCronTool } from "./cron-tool.js";
import * as gatewayModule from "./gateway.js";

const gateway = vi.fn();
function execute(args: Record<string, unknown>) {
  return createCronTool().execute("cron", args);
}
function validatePrepared(tool: ReturnType<typeof createCronTool>, prepared: unknown) {
  if (!isRecord(prepared)) {
    throw new Error("Expected prepared cron arguments to be an object");
  }
  return validateToolArguments(tool, {
    type: "toolCall",
    id: "cron-boundary",
    name: tool.name,
    arguments: prepared,
  });
}
beforeEach(() => {
  const gatewaySpy = vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(gateway);
  onTestFinished(() => gatewaySpy.mockRestore());
  setRuntimeConfigSnapshot({});
  gateway.mockReset().mockResolvedValue({ ok: true });
});

afterEach(clearRuntimeConfigSnapshot);

describe("cron flat preparation boundary", () => {
  const callGatewayToolMock = gateway;
  function firstGatewayToolCall<TParams>(): [string, unknown, TParams] {
    const call = gateway.mock.calls[0];
    if (!call) {
      throw new Error("expected Gateway call");
    }
    return call as [string, unknown, TParams];
  }
  it("binds recovered agentTurn jobs to the creating conversation by default", async () => {
    const tool = createCronTool({ agentSessionKey: "agent:main:discord:channel:ops" });
    await tool.execute("call-flat-session-key", {
      action: "add",
      sessionKey: "agent:main:telegram:group:-100123:topic:99",
      schedule: { kind: "at", at: new Date(123).toISOString() },
      message: "do stuff",
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      sessionKey?: string;
      sessionTarget?: string;
    }>();
    expect(method).toBe("cron.add");
    expect(params.sessionTarget).toBe("current");
    expect(params.sessionKey).toBe("agent:main:discord:channel:ops");
  });

  it("prepares flat add and update calls before schema validation", () => {
    const tool = createCronTool();
    const flatAdd = {
      action: "add",
      job: "truncated",
      name: "daily summary",
      expr: "0 9 * * *",
      tz: "Europe/London",
      message: "Send the summary",
    };
    const preparedAdd = tool.prepareArguments?.(flatAdd);

    expect(preparedAdd).toMatchObject({
      action: "add",
      job: {
        name: "daily summary",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/London" },
        payload: { kind: "agentTurn", message: "Send the summary" },
      },
    });
    expect(tool.prepareArguments?.(preparedAdd)).toEqual(preparedAdd);
    expect(
      tool.prepareArguments?.({
        action: "update",
        jobId: "job-123",
        enabled: false,
        everyMs: 300_000,
      }),
    ).toMatchObject({
      action: "update",
      jobId: "job-123",
      job: { enabled: false, schedule: { kind: "every", everyMs: 300_000 } },
    });
  });

  it.each([
    {
      caseName: "one-shot reminder",
      args: {
        action: "add",
        message:
          "Create a cron job named exactly FLATTEST-1 that reminds me to stretch at 2026-08-16T21:29:19Z.",
        name: "FLATTEST-1",
        sessionTarget: "current",
        text: "remind me to stretch at 2026-08-16T21:29:19Z",
      },
    },
    {
      caseName: "recurring reminder",
      args: {
        action: "add",
        message:
          "Create a cron job named exactly FLATTEST-2 that runs every 5 minutes and asks me if I'm still working.",
        name: "FLATTEST-2",
        sessionTarget: "current",
        text: "Are you still working?",
      },
    },
  ])("rejects an ambiguous weak-model $caseName call", ({ args }) => {
    const tool = createCronTool();

    expect(() => tool.prepareArguments?.(args)).toThrow(
      "Send only text (reminder) or only message (task).",
    );
  });

  it('accepts "current" on a corrected weak-model flat add', () => {
    const tool = createCronTool();

    expect(
      tool.prepareArguments?.({
        action: "add",
        name: "FLATTEST-2",
        sessionTarget: "current",
        text: "Are you still working?",
        everyMs: 300_000,
      }),
    ).toMatchObject({
      job: {
        name: "FLATTEST-2",
        sessionTarget: "current",
        schedule: { kind: "every", everyMs: 300_000 },
      },
    });
  });

  it("keeps wake text out of cron job preparation", () => {
    const tool = createCronTool();
    const wake = { action: "wake", text: "check now", mode: "now" };

    expect(tool.prepareArguments?.(wake)).toEqual(wake);
  });

  it("normalizes scalar payload array hints and remains idempotent", () => {
    const tool = createCronTool();
    const prepared = tool.prepareArguments?.({
      action: "add",
      everyMs: 60_000,
      message: "Run the report",
      toolsAllow: " read ",
      fallbacks: " openai/gpt-5-mini ",
    });

    expect(prepared).toMatchObject({
      job: {
        payload: {
          kind: "agentTurn",
          toolsAllow: ["read"],
          fallbacks: ["openai/gpt-5-mini"],
        },
      },
    });
    expect(tool.prepareArguments?.(prepared)).toEqual(prepared);
  });

  it("repairs a scalar flat toolsAllow before schema validation", () => {
    const tool = createCronTool();
    const prepared = tool.prepareArguments?.({
      action: "add",
      everyMs: 3_600_000,
      job: "truncated",
      message: "status summary",
      name: "FLATTEST-9",
      text: "status summary",
      toolsAllow: "read",
    });

    expect(prepared).toMatchObject({
      job: {
        name: "FLATTEST-9",
        schedule: { kind: "every", everyMs: 3_600_000 },
        payload: {
          kind: "agentTurn",
          message: "status summary",
          toolsAllow: ["read"],
        },
      },
    });
    expect(tool.prepareArguments?.(prepared)).toEqual(prepared);
  });

  it("caps an allowed scalar flat toolsAllow to creator authority before dispatch", async () => {
    const tool = createCronTool({ creatorToolAllowlist: ["read", "cron"] });

    await tool.execute("call-flat-toolsallow-allowed", {
      action: "add",
      everyMs: 3_600_000,
      message: "status summary",
      name: "FLATTEST-CAP-ALLOWED",
      toolsAllow: "read",
    });

    const [method, , params] = firstGatewayToolCall<{
      payload?: { toolsAllow?: unknown };
    }>();
    expect(method).toBe("cron.add");
    expect(params.payload?.toolsAllow).toEqual(["read"]);
  });

  it("rejects a scalar flat toolsAllow outside creator authority without a Gateway write", async () => {
    const tool = createCronTool({
      creatorToolAllowlist: ["read", "cron"],
    });

    await expect(
      tool.execute("call-flat-toolsallow-unavailable", {
        action: "add",
        everyMs: 3_600_000,
        message: "status summary",
        name: "FLATTEST-CAP-UNAVAILABLE",
        toolsAllow: "write",
      }),
    ).rejects.toThrow('Requested automation tool "write" cannot be carried');

    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("decodes JSON-encoded flat array hints instead of wrapping them", () => {
    const tool = createCronTool();
    const prepared = tool.prepareArguments?.({
      action: "add",
      everyMs: 3_600_000,
      message: "status summary",
      name: "FLATTEST-JSON",
      toolsAllow: '["read"]',
      fallbacks: '["openai/gpt-5-mini", "openai/gpt-5.4"]',
    });

    expect(prepared).toMatchObject({
      job: {
        payload: {
          kind: "agentTurn",
          toolsAllow: ["read"],
          fallbacks: ["openai/gpt-5-mini", "openai/gpt-5.4"],
        },
      },
    });
    expect(tool.prepareArguments?.(prepared)).toEqual(prepared);
  });

  it("rejects a JSON-encoded flat toolsAllow outside creator authority without a Gateway write", async () => {
    const tool = createCronTool({ creatorToolAllowlist: ["read", "cron"] });

    await expect(
      tool.execute("call-flat-toolsallow-json", {
        action: "add",
        everyMs: 3_600_000,
        message: "status summary",
        name: "FLATTEST-CAP-JSON",
        toolsAllow: '["read", "write"]',
      }),
    ).rejects.toThrow('Requested automation tool "write" cannot be carried');

    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("wraps bracketed strings that are not JSON arrays as a single entry", () => {
    const tool = createCronTool();
    const prepared = tool.prepareArguments?.({
      action: "add",
      everyMs: 60_000,
      message: "Run the report",
      toolsAllow: "[read",
    }) as { job?: { payload?: { toolsAllow?: unknown } } };

    expect(prepared.job?.payload?.toolsAllow).toEqual(["[read"]);
  });

  it("preserves blank capability hints for main to treat as unspecified", () => {
    const tool = createCronTool();
    const prepared = tool.prepareArguments?.({
      action: "add",
      job: {
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { message: "Run the report", toolsAllow: "" },
      },
    }) as { job?: { payload?: { toolsAllow?: unknown } } };

    expect(prepared.job?.payload?.toolsAllow).toBe("");
  });

  it("rejects non-stream top-level mode on flat add and update calls", () => {
    const tool = createCronTool();

    for (const action of ["add", "update"] as const) {
      for (const mode of ["now", "next-heartbeat"] as const) {
        expect(() => tool.prepareArguments?.({ action, mode })).toThrow(
          '"mode" is only valid for action="wake"',
        );
      }
    }
    for (const args of [
      { action: "add", everyMs: 3_600_000, message: "Run the report", mode: "line" },
      { action: "add", expr: "0 9 * * *", message: "Run the report", mode: "match" },
      { action: "update", id: "job-1", mode: "line" },
    ] as const) {
      expect(() => tool.prepareArguments?.(args)).toThrow('"mode" is only valid for action="wake"');
    }

    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("preserves unadvertised flat stream recovery without leaking wake mode", async () => {
    const tool = createCronTool();
    for (const mode of ["line", "match"] as const) {
      callGatewayToolMock.mockClear();
      // Stream fields are deliberately absent from the ten-field advertised
      // flat contract. Keep accepting this pre-existing recoverable shape so
      // the mode guard does not regress compatibility providers that emit it.
      const args = {
        action: "add",
        kind: "stream",
        command: ["node", "events.mjs"],
        mode,
        ...(mode === "match" ? { match: "^ready:" } : {}),
        message: "handle events",
      };
      const expectedSchedule = {
        kind: "stream",
        command: ["node", "events.mjs"],
        mode,
        ...(mode === "match" ? { match: "^ready:" } : {}),
      };

      const prepared = tool.prepareArguments?.(args) as Record<string, unknown>;
      expect(prepared).not.toHaveProperty("mode");
      expect(prepared.job).toMatchObject({
        schedule: expectedSchedule,
        payload: { kind: "agentTurn", message: "handle events" },
      });

      await expect(tool.execute(`call-flat-stream-${mode}`, args)).rejects.toThrow(
        "automation stream commands require the creator turn",
      );
      expect(callGatewayToolMock).not.toHaveBeenCalled();
    }
  });

  it("rejects conflicting flat add/update schedules without a Gateway write", async () => {
    const tool = createCronTool();
    const conflictingUpdate = {
      action: "update",
      jobId: "job-recurring",
      at: "2026-09-01T09:00:00Z",
      everyMs: 300_000,
    } as const;

    for (const args of [
      { action: "add", name: "S1", at: "2026-09-01T09:00:00Z", everyMs: 300_000, message: "x" },
      {
        action: "add",
        name: "S2",
        at: "2026-09-01T09:00:00Z",
        atMs: 1_800_000_000_000,
        message: "x",
      },
      { action: "add", name: "S3", everyMs: 300_000, expr: "0 * * * *", message: "x" },
      conflictingUpdate,
    ] as const) {
      expect(() => tool.prepareArguments?.(args)).toThrow("Send only one of at, everyMs, or expr.");
    }

    await expect(
      tool.execute("call-flat-schedule-conflict-update", conflictingUpdate),
    ).rejects.toThrow("Send only one of at, everyMs, or expr.");
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("rejects conflicting flat schedule kind on update before Gateway dispatch", async () => {
    const tool = createCronTool();

    for (const args of [
      { action: "update", jobId: "job-recurring", kind: "at", everyMs: 300_000 },
      { action: "update", jobId: "job-recurring", kind: "every", at: "2026-09-01T09:00:00Z" },
      { action: "update", jobId: "job-recurring", kind: "cron", everyMs: 300_000 },
    ] as const) {
      await expect(tool.execute(`call-flat-kind-conflict-${args.kind}`, args)).rejects.toThrow(
        args.kind === "every"
          ? "Use everyMs without at."
          : args.kind === "cron"
            ? "Use expr without everyMs."
            : "Use at without everyMs.",
      );
    }

    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("rejects conflicting flat scheduleKind alias before Gateway dispatch", async () => {
    const tool = createCronTool();

    await expect(
      tool.execute("call-flat-schedule-kind-conflict", {
        action: "update",
        jobId: "job-recurring",
        scheduleKind: "every",
        at: "2026-09-01T09:00:00Z",
      }),
    ).rejects.toThrow("Use everyMs without at.");
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("accepts a matching flat schedule kind on update", async () => {
    const tool = createCronTool();

    await tool.execute("call-flat-kind-every", {
      action: "update",
      jobId: "job-recurring",
      kind: "every",
      everyMs: 300_000,
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{ patch?: unknown }>();
    expect(method).toBe("cron.update");
    expect(params.patch).toMatchObject({ schedule: { kind: "every", everyMs: 300_000 } });
  });

  it("rejects flat schedule updates carrying no complete schedule before Gateway dispatch", async () => {
    const tool = createCronTool();

    for (const key of [
      "cwd",
      "match",
      "batchMs",
      "maxBatchBytes",
      "exact",
      "staggerMs",
      "anchorMs",
    ] as const) {
      await expect(
        tool.execute(`call-flat-empty-schedule-${key}`, {
          action: "update",
          jobId: "job-recurring",
          [key]:
            key === "exact" ? true : key.endsWith("Bytes") || key.endsWith("Ms") ? 100 : "unused",
        }),
      ).rejects.toThrow("Send a complete expr, at, or everyMs schedule.");
    }

    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it.each(["UTC", "Europe/London"])(
    "rejects flat tz %s without a cron expression before Gateway dispatch",
    async (tz) => {
      const tool = createCronTool();
      const args = { action: "add", tz, message: "test" };
      const error = "tz needs expr. Put the offset in at, or drop tz.";
      expect(() => tool.prepareArguments?.(args)).toThrow(error);
      await expect(tool.execute("flat-tz-only", args)).rejects.toThrow(error);
      expect(callGatewayToolMock).not.toHaveBeenCalled();
    },
  );

  it("accepts a cron schedule object with a top-level timezone on add", () => {
    const tool = createCronTool();

    const prepared = tool.prepareArguments?.({
      action: "add",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      tz: "UTC",
      message: "test",
    }) as { job?: { schedule?: unknown } };

    expect(prepared.job?.schedule).toEqual({ kind: "cron", expr: "0 9 * * *", tz: "UTC" });
  });

  it("infers a cron schedule object kind before accepting top-level timezone on add", () => {
    const tool = createCronTool();

    const prepared = tool.prepareArguments?.({
      action: "add",
      schedule: { expr: "0 9 * * *" },
      tz: "UTC",
      message: "test",
    }) as { job?: { schedule?: unknown } };

    expect(prepared.job?.schedule).toEqual({ kind: "cron", expr: "0 9 * * *", tz: "UTC" });
  });

  it("rejects top-level timezone with a non-cron schedule on add", () => {
    const tool = createCronTool();

    expect(() =>
      tool.prepareArguments?.({
        action: "add",
        everyMs: 3_600_000,
        tz: "UTC",
        message: "test",
      }),
    ).toThrow();
  });

  it.each(["add", "update"])(
    "rejects differing message/text on %s before any Gateway call",
    async (action) => {
      await expect(
        execute({ action, id: "job", everyMs: 300_000, message: "do the thing", text: "stray" }),
      ).rejects.toThrow("Send only text (reminder) or only message (task).");
      expect(gateway).not.toHaveBeenCalled();
    },
  );

  it("recovers a complete flat cron schedule update", async () => {
    const tool = createCronTool();

    await tool.execute("call-flat-cron-update", {
      action: "update",
      jobId: "job-123",
      cron: "15 8 * * 1-5",
      tz: "America/Los_Angeles",
      staggerMs: 30_000,
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      id?: string;
      patch?: { schedule?: unknown };
    }>();
    expect(method).toBe("cron.update");
    expect(params.id).toBe("job-123");
    expect(params.patch?.schedule).toEqual({
      kind: "cron",
      expr: "15 8 * * 1-5",
      tz: "America/Los_Angeles",
      staggerMs: 30_000,
    });
  });

  it("rejects incomplete flat schedule updates before Gateway dispatch", async () => {
    const tool = createCronTool();

    // The Gateway validates schedule as a complete discriminated union, so a
    // partial patch is rejected there rather than merged into the stored job.
    await expect(
      tool.execute("call-flat-tz-only-update", {
        action: "update",
        jobId: "job-123",
        tz: "Europe/London",
      }),
    ).rejects.toThrow("tz needs expr. Put the offset in at, or drop tz.");

    for (const args of [
      { action: "update", jobId: "job-123", kind: "cron", tz: "Europe/London" },
      { action: "update", jobId: "job-123", kind: "at" },
      { action: "update", jobId: "job-123", kind: "every" },
    ] as const) {
      await expect(tool.execute(`call-flat-incomplete-${args.kind}`, args)).rejects.toThrow(
        "Send a complete expr, at, or everyMs schedule.",
      );
    }

    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("accepts a complete flat cron schedule update with a timezone", async () => {
    const tool = createCronTool();

    await tool.execute("call-flat-expr-tz-update", {
      action: "update",
      jobId: "job-123",
      expr: "0 9 * * *",
      tz: "Europe/London",
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      patch?: { schedule?: unknown };
    }>();
    expect(method).toBe("cron.update");
    expect(params.patch?.schedule).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
      tz: "Europe/London",
    });
  });

  it("prepares dotted payload siblings before schema validation and remains idempotent", () => {
    const tool = createCronTool();
    const prepared = tool.prepareArguments?.({
      action: "update",
      jobId: "job-dotted",
      "job.payload.message": "after",
      "job.payload.kind": "agentTurn",
    });
    expect(prepared).toMatchObject({
      job: { payload: { kind: "agentTurn", message: "after" } },
    });
    expect(validatePrepared(tool, prepared)).toMatchObject({
      job: { payload: { kind: "agentTurn", message: "after" } },
    });
    expect(tool.prepareArguments?.(prepared)).toEqual(prepared);
  });

  it.each([undefined, null, {}, [], "truncated"])(
    "rejects an unrecoverable update job (%j) before any Gateway call",
    async (invalidJob) => {
      await expect(execute({ action: "update", jobId: "job", job: invalidJob })).rejects.toThrow(
        "job required",
      );
      expect(gateway).not.toHaveBeenCalled();
    },
  );
});
