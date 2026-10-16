import { validateToolArguments } from "@openclaw/llm-core/validation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { isRecord } from "../../utils.js";
import { getToolTerminalPresentation } from "../tool-terminal-presentation.js";
import { createCronTool } from "./cron-tool.js";

const gateway = vi.fn();
const job = {
  name: "reminder",
  schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
  payload: { kind: "agentTurn", message: "work" },
};
function execute(args: Record<string, unknown>) {
  return createCronTool(undefined, { callGatewayTool: gateway }).execute("cron", args);
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
function expectAdd(params: Record<string, unknown>) {
  expect(gateway).toHaveBeenCalledExactlyOnceWith(
    "cron.add",
    expect.anything(),
    expect.objectContaining(params),
  );
}

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  gateway.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("cron shorthand recovery", () => {
  it("presents list metadata without private job content", () => {
    const presentation = getToolTerminalPresentation(createCronTool());
    if (!presentation) {
      throw new Error("expected terminal presentation");
    }
    const result = {
      content: [],
      details: {
        total: 250,
        jobs: [{ id: "one", name: "private reminder", payload: { text: "secret" } }],
      },
    };
    expect(presentation({ action: "list" }, result)).toEqual({
      text: "Automations listed.\nCount: 250",
    });
    expect(presentation({ action: "add" }, result)).toBeUndefined();
  });

  it.each([
    {
      name: "script before agent-turn hints",
      input: {
        everyMs: 60_000,
        script: "return { notify: 'changed' }",
        timeoutSeconds: 30,
        toolBudget: 12,
      },
      expected: {
        payload: {
          kind: "script",
          script: "return { notify: 'changed' }",
          timeoutSeconds: 30,
          toolBudget: 12,
        },
      },
    },
    {
      name: "out-of-range timestamp for gateway validation",
      input: { atMs: 8_640_000_000_000_001, message: "report" },
      expected: { schedule: { kind: "at", at: 8_640_000_000_000_001 } },
    },
  ])("recovers $name", async ({ input, expected }) => {
    await execute({ action: "add", name: "reminder", ...input });
    expectAdd(expected);
  });

  it.each([
    { action: "add", kind: "on-exit", command: "pnpm build", cwd: "/repo", message: "rebuilt" },
  ])("rejects explicit or inferred on-exit shorthand on $action", async (args) => {
    await expect(execute(args)).rejects.toThrow(
      "automation on-exit schedules cannot be created or edited",
    );
    expect(gateway).not.toHaveBeenCalled();
  });

  it("loads the current revision before updating a flat trigger", async () => {
    gateway.mockResolvedValueOnce({
      id: "job",
      configRevision: "sha256:trigger",
      trigger: null,
      payload: { kind: "systemEvent", text: "before" },
    });
    const trigger = { script: "json({ fire: true })", once: false };
    await execute({ action: "update", jobId: "job", trigger });
    expect(gateway.mock.calls).toEqual([
      ["cron.get", expect.anything(), { id: "job" }],
      [
        "cron.update",
        expect.anything(),
        { id: "job", expectedConfigRevision: "sha256:trigger", patch: { trigger } },
      ],
    ]);
  });

  it("repairs recognized padded keys (#95407)", async () => {
    await execute({
      action: "add",
      job: {
        name: job.name,
        description: "Check-in",
        "schedule ": job.schedule,
        "payload ": job.payload,
        "sessionTarget ": "isolated",
        "enabled ": true,
      },
    });
    expectAdd({ ...job, description: "Check-in", sessionTarget: "isolated", enabled: true });
    for (const key of ["schedule ", "payload ", "sessionTarget ", "enabled "]) {
      expect(gateway.mock.calls[0]?.[2]).not.toHaveProperty(key);
    }
  });

  it("does not repair prototype keys (#95407)", async () => {
    await execute({
      action: "add",
      job: { ...job, "__proto__ ": { malicious: true }, "constructor ": "unrecognized" },
    });
    expectAdd({ "__proto__ ": { malicious: true }, "constructor ": "unrecognized" });
  });

  it("preserves canonical/padded conflicts for gateway rejection (#95407)", async () => {
    await execute({
      action: "add",
      job: {
        ...job,
        "schedule ": { kind: "every", everyMs: 60_000 },
        enabled: false,
        "enabled ": true,
      },
    });
    expectAdd({
      schedule: job.schedule,
      enabled: false,
      "schedule ": { kind: "every", everyMs: 60_000 },
      "enabled ": true,
    });
  });

  it("merges sibling dotted keys under one recovered object (#120616)", async () => {
    // The first field creates the payload object; the second meets that parent
    // and must continue into it instead of being kept as a literal key.
    await execute({
      action: "update",
      jobId: "job-dotted-siblings",
      "job.payload.message": "after",
      "job.payload.kind": "agentTurn",
    });

    const params = gateway.mock.calls[0]?.[2] as { patch?: Record<string, unknown> };
    expect(params.patch).toEqual({ payload: { kind: "agentTurn", message: "after" } });
  });

  it("keeps the explicit structured value authoritative over a conflicting dotted key (#120616)", async () => {
    // The explicit payload is a valid update on its own. Forwarding the extra
    // dotted key as well made the whole update fail a strict gateway patch, so
    // the canonical value stands and the redundant key is dropped.
    await execute({
      action: "update",
      jobId: "job-dotted-conflict",
      payload: { kind: "agentTurn", message: "before" },
      "job.payload.message": "after",
    });

    const params = gateway.mock.calls[0]?.[2] as { patch?: Record<string, unknown> };
    expect(params.patch).toHaveProperty("payload.message", "before");
    expect(params.patch).not.toHaveProperty("job.payload.message");
  });

  it("recovers quoted dotted job keys (#120616)", async () => {
    // The report includes literal quote characters around the dotted name.
    await execute({
      action: "update",
      jobId: "job-dotted-quoted",
      '"job.payload.message"': "after",
    });

    const params = gateway.mock.calls[0]?.[2] as { patch?: Record<string, unknown> };
    expect(params.patch).toEqual({ payload: { kind: "agentTurn", message: "after" } });
  });

  it("does not nest dotted keys rooted at a scalar cron field (#120616)", async () => {
    // Only object-typed cron fields are containers in the gateway schema, so a
    // dot inside a scalar such as a job name stays a plain unrecognized key
    // instead of being reshaped into a path.
    await expect(
      execute({
        action: "update",
        jobId: "job-dotted-name",
        "job.name": "nightly.report",
      }),
    ).rejects.toThrow("job required");
    expect(gateway).not.toHaveBeenCalled();
  });

  it("does not nest dotted keys that would reach Object.prototype (#120616)", async () => {
    await expect(
      execute({
        action: "update",
        jobId: "job-dotted-proto",
        "job.payload.__proto__.polluted": "yes",
      }),
    ).rejects.toThrow("job required");
    expect(gateway).not.toHaveBeenCalled();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

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
    const tool = createCronTool(
      { agentSessionKey: "agent:main:discord:channel:ops" },
      { callGatewayTool: callGatewayToolMock },
    );
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
    const tool = createCronTool(
      { creatorToolAllowlist: ["read", "cron"] },
      { callGatewayTool: callGatewayToolMock },
    );

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

  it("strips a scalar flat toolsAllow outside creator authority before dispatch", async () => {
    const tool = createCronTool(
      {
        creatorToolAllowlist: ["read", "cron"],
      },
      { callGatewayTool: callGatewayToolMock },
    );

    await tool.execute("call-flat-toolsallow-unavailable", {
      action: "add",
      everyMs: 3_600_000,
      message: "status summary",
      name: "FLATTEST-CAP-UNAVAILABLE",
      toolsAllow: "write",
    });

    const [method, , params] = firstGatewayToolCall<{
      payload?: { toolsAllow?: unknown };
    }>();
    expect(method).toBe("cron.add");
    expect(params.payload?.toolsAllow).toEqual([]);
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

  it("caps a JSON-encoded flat toolsAllow to creator authority before dispatch", async () => {
    const tool = createCronTool(
      { creatorToolAllowlist: ["read", "cron"] },
      { callGatewayTool: callGatewayToolMock },
    );

    await tool.execute("call-flat-toolsallow-json", {
      action: "add",
      everyMs: 3_600_000,
      message: "status summary",
      name: "FLATTEST-CAP-JSON",
      toolsAllow: '["read", "write"]',
    });

    const [method, , params] = firstGatewayToolCall<{
      payload?: { toolsAllow?: unknown };
    }>();
    expect(method).toBe("cron.add");
    expect(params.payload?.toolsAllow).toEqual(["read"]);
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
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

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
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });
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

      await tool.execute(`call-flat-stream-${mode}`, args);
      const [method, _gatewayOpts, params] = firstGatewayToolCall<{
        schedule?: unknown;
        mode?: unknown;
      }>();
      expect(method).toBe("cron.add");
      expect(params).not.toHaveProperty("mode");
      expect(params.schedule).toEqual(expectedSchedule);
    }
  });

  it("rejects conflicting flat add/update schedules without a Gateway write", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });
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
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

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
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

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
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

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
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

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
      const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });
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
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

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
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

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
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

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

describe("cron review regression boundaries", () => {
  it.each([
    {
      example: '{ "action":"add", "everyMs":300000, "message":"Check for urgent mail" }',
      method: "cron.add",
      expected: {
        schedule: { kind: "every", everyMs: 300000 },
        payload: { kind: "agentTurn", message: "Check for urgent mail" },
      },
    },
    {
      example:
        '{ "action":"add", "expr":"0 9 * * *", "tz":"Europe/London", "text":"Take a break" }',
      method: "cron.add",
      expected: {
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/London" },
        payload: { kind: "systemEvent", text: "Take a break" },
      },
    },
    {
      example: '{ "action":"update", "jobId":"existing-job-id", "enabled":false }',
      method: "cron.update",
      expected: { id: "existing-job-id", patch: { enabled: false } },
    },
  ])("executes the verbatim prompt example: $example", async ({ example, method, expected }) => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    expect(tool.description).toContain(example);
    const prepared = tool.prepareArguments?.(JSON.parse(example));
    const validated = validatePrepared(tool, prepared);
    await tool.execute("prompt-example", validated);
    expect(gateway).toHaveBeenCalledExactlyOnceWith(
      method,
      expect.anything(),
      expect.objectContaining(expected),
    );
  });

  it.each(["", "   "])("ignores blank flat fillers %j beside a nested job", async (blank) => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const args = {
      action: "add",
      job,
      at: blank,
      everyMs: blank,
      expr: blank,
      tz: blank,
      message: blank,
      name: blank,
      enabled: blank,
      sessionTarget: blank,
      toolsAllow: blank,
      text: blank,
    };
    const prepared = tool.prepareArguments?.(args);
    expect(prepared).toEqual({ action: "add", job });
    expect(args.tz).toBe(blank);
    expect(tool.prepareArguments?.(prepared)).toEqual(prepared);
    await tool.execute("nested-blank-fillers", validatePrepared(tool, prepared));
    expectAdd({ schedule: job.schedule, payload: job.payload });
  });

  it("accepts a nested at reminder with a blank schedule timezone", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const nested = {
      name: "stretch",
      sessionTarget: "main",
      schedule: { kind: "at", at: "2026-11-01T09:00:00Z", tz: "" },
      payload: { kind: "systemEvent", text: "stretch" },
    };
    const prepared = tool.prepareArguments?.({ action: "add", job: nested });
    expect(prepared).toEqual({ action: "add", job: nested });
    await tool.execute("nested-stretch-blank-tz", validatePrepared(tool, prepared));
    expectAdd({
      name: "stretch",
      sessionTarget: "main",
      schedule: { kind: "at", at: "2026-11-01T09:00:00.000Z" },
      payload: { kind: "systemEvent", text: "stretch" },
    });
    expect(gateway.mock.calls[0]?.[2].schedule).not.toHaveProperty("tz");
  });

  it("continues ignoring cosmetic flat name beside a nested job", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const args = { action: "add", name: "ignored flat name", job };
    expect(tool.prepareArguments?.(args)).toEqual(args);
    await tool.execute("nested-flat-name", validatePrepared(tool, args));
    expectAdd({ name: job.name, schedule: job.schedule, payload: job.payload });
  });

  it.each(["add", "update"])(
    "rejects an empty %s wrapper with no flat content before Gateway dispatch",
    async (action) => {
      const tool = createCronTool(undefined, { callGatewayTool: gateway });
      const prepared = tool.prepareArguments?.({ action, id: "job", job: {} });
      await expect(tool.execute("empty-wrapper", validatePrepared(tool, prepared))).rejects.toThrow(
        "job required",
      );
      expect(gateway).not.toHaveBeenCalled();
    },
  );

  it.each(["add", "update"])("recovers flat content from an empty %s wrapper", async (action) => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const prepared = tool.prepareArguments?.({
      action,
      id: "job",
      job: {},
      ...(action === "add" ? { everyMs: 60_000, text: "stretch" } : { enabled: false }),
    });
    expect(prepared).not.toHaveProperty("everyMs");
    expect(prepared).not.toHaveProperty("text");
    expect(prepared).not.toHaveProperty("enabled");
    const validated = validatePrepared(tool, prepared);
    expect(tool.prepareArguments?.(validated)).toEqual(prepared);
    await tool.execute("empty-flat-wrapper", validated);
    expect(gateway).toHaveBeenCalledTimes(1);
    if (action === "add") {
      expectAdd({
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "systemEvent", text: "stretch" },
      });
    } else {
      expect(gateway).toHaveBeenCalledWith("cron.update", expect.anything(), {
        id: "job",
        patch: { enabled: false },
      });
    }
  });

  it("ignores top-level wake mode beside a nested update", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const args = { action: "update", id: "job", mode: "now", job: { enabled: false } };
    const prepared = tool.prepareArguments?.(args);
    expect(prepared).toEqual(args);
    await tool.execute("nested-mode", validatePrepared(tool, prepared));
    expect(gateway).toHaveBeenCalledExactlyOnceWith("cron.update", expect.anything(), {
      id: "job",
      patch: { enabled: false },
    });
  });

  it("continues ignoring unadvertised aliases beside a nested job", async () => {
    const args = {
      action: "add",
      job,
      cron: "0 1 * * *",
      every: 123,
      atMs: 123,
      "payload.toolsAllow": ["write"],
    };
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    expect(tool.prepareArguments?.(args)).toEqual(args);
    await tool.execute("nested-aliases", args);
    expectAdd({ schedule: job.schedule, payload: job.payload });
  });

  it.each(["", "   "])("treats blank flat tz %j as absent through execute", async (tz) => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const prepared = tool.prepareArguments?.({
      action: "add",
      at: "2026-11-01T09:00:00Z",
      tz,
      text: "stretch",
    });
    await tool.execute("blank-tz", validatePrepared(tool, prepared));
    expectAdd({ schedule: { kind: "at", at: "2026-11-01T09:00:00.000Z" } });
  });

  it("normalizes stale nested at fields through the normal execute route", async () => {
    // Same stale schedule shape as src/cron/normalize.test.ts:STALE_AT_SCHEDULE.
    const schedule = {
      kind: "at",
      at: "2026-01-12T18:00:00Z",
      expr: "* * * * *",
      everyMs: 60_000,
      anchorMs: 123,
      tz: "UTC",
      staggerMs: 30_000,
    };
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const args = { action: "add", job: { ...job, schedule } };
    expect(tool.prepareArguments?.(args)).toEqual(args);
    await tool.execute("nested-stale-at", validatePrepared(tool, tool.prepareArguments?.(args)));
    expectAdd({ schedule: { kind: "at", at: "2026-01-12T18:00:00.000Z" } });
  });

  it("leaves nested agentTurn leftover text to normal normalization", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const args = {
      action: "add",
      job: { ...job, payload: { kind: "agentTurn", message: "work", text: "leftover" } },
    };
    expect(tool.prepareArguments?.(args)).toEqual(args);
    await tool.execute("nested-leftover-text", validatePrepared(tool, tool.prepareArguments?.(args)));
    expectAdd({ payload: { kind: "agentTurn", message: "work" } });
  });

  it("leaves nested reminder leftover message to normal normalization", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    const args = {
      action: "add",
      job: { ...job, payload: { kind: "systemEvent", text: "stretch", message: "leftover" } },
    };
    expect(tool.prepareArguments?.(args)).toEqual(args);
    await tool.execute("nested-leftover-message", validatePrepared(tool, tool.prepareArguments?.(args)));
    expectAdd({ payload: { kind: "systemEvent", text: "stretch" } });
  });

  it.each([false, true])(
    "rejects nested jobs with advertised flat timezone and restrictions (JSON=%s)",
    async (json) => {
      const nested = {
        schedule: { kind: "cron", expr: "0 9 * * *" },
        payload: { kind: "agentTurn", message: "work" },
      };
      const args = {
        action: "add",
        tz: "Europe/London",
        toolsAllow: '["read"]',
        job: json ? JSON.stringify(nested) : nested,
      };
      const tool = createCronTool(undefined, { callGatewayTool: gateway });
      const error = "Do not mix job with flat fields: tz, toolsAllow. Retry with job only, or remove job and send all intended settings as flat fields.";
      expect(() => tool.prepareArguments?.(args)).toThrow(error);
      await expect(tool.execute("nested-flat", args)).rejects.toThrow(error);
      expect(nested).not.toHaveProperty("schedule.tz");
      expect(nested).not.toHaveProperty("payload.toolsAllow");
      expect(gateway).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["at", "2026-11-01T09:00:00Z"],
    ["everyMs", 60_000],
    ["expr", "0 12 * * *"],
    ["tz", "UTC"],
    ["message", "work"],
    ["enabled", false],
    ["sessionTarget", "isolated"],
    ["toolsAllow", ["read"]],
    ["text", "stretch"],
  ] as const)("rejects advertised flat %s beside a nonempty job on add and update", async (field, value) => {
    const tool = createCronTool(undefined, { callGatewayTool: gateway });
    for (const action of ["add", "update"]) {
      const args = { action, id: "job", job, [field]: value };
      const error = `Do not mix job with flat fields: ${field}. Retry with job only, or remove job and send all intended settings as flat fields.`;
      expect(() => tool.prepareArguments?.(args)).toThrow(error);
      await expect(tool.execute("mixed-field", args)).rejects.toThrow(error);
    }
    expect(gateway).not.toHaveBeenCalled();
  });

  it.each(["at", "every", "cron"])(
    "rejects an incomplete %s add before any Gateway call",
    async (kind) => {
      await expect(execute({ action: "add", kind, message: "work" })).rejects.toThrow(
        "Add expr, at, or everyMs.",
      );
      expect(gateway).not.toHaveBeenCalled();
    },
  );

  it("rejects at plus tz with flat-field guidance before any Gateway call", async () => {
    await expect(
      execute({ action: "add", at: "2026-11-01T09:00:00Z", tz: "Europe/London", text: "work" }),
    ).rejects.toThrow("tz needs expr. Put the offset in at, or drop tz.");
    expect(gateway).not.toHaveBeenCalled();
  });

  it("recovers reminder text when message is blank", () => {
    const tool = createCronTool();
    const prepared = tool.prepareArguments?.({
      action: "add",
      everyMs: 60_000,
      message: "",
      text: "stretch",
    });
    expect(prepared).toMatchObject({ job: { payload: { kind: "systemEvent", text: "stretch" } } });
    expect(tool.prepareArguments?.(validatePrepared(tool, prepared))).toEqual(prepared);
  });

  it.each([
    ["agentTurn", false],
    ["systemEvent", false],
    ["agentTurn", true],
    ["systemEvent", true],
  ] as const)(
    "updates stored %s job end to end without changing kind (nested=%s)",
    async (kind, nested) => {
      gateway.mockResolvedValueOnce({
        configRevision: "rev",
        payload: { kind, ...(kind === "agentTurn" ? { message: "old" } : { text: "old" }) },
      });
      const tool = createCronTool(undefined, { callGatewayTool: gateway });
      const prepared = tool.prepareArguments?.({
        action: "update",
        id: "job",
        ...(nested ? { job: { payload: { text: "new" } } } : { text: "new" }),
      });
      expect(prepared).toMatchObject({ job: { payload: { text: "new" } } });
      expect(prepared).not.toHaveProperty("job.payload.kind");
      const validated = validatePrepared(tool, prepared);
      expect(tool.prepareArguments?.(validated)).toEqual(prepared);
      await tool.execute("text-edit", validated);
      expect(gateway.mock.calls).toEqual([
        ["cron.get", expect.anything(), { id: "job" }],
        [
          "cron.update",
          expect.anything(),
          {
            id: "job",
            expectedConfigRevision: "rev",
            patch: {
              payload: { kind, ...(kind === "agentTurn" ? { message: "new" } : { text: "new" }) },
            },
          },
        ],
      ]);
    },
  );

  it.each([false, true])(
    "rejects unreadable stored payload kind without a write (nested=%s)",
    async (nested) => {
      gateway.mockResolvedValueOnce({ configRevision: "rev", payload: {} });
      await expect(
        execute({
          action: "update",
          id: "job",
          ...(nested ? { job: { payload: { text: "new" } } } : { text: "new" }),
        }),
      ).rejects.toThrow("Cannot read whether the existing job is a reminder or task. No changes saved. Ask an administrator to inspect the existing job; do not recreate it.");
      expect(gateway).toHaveBeenCalledExactlyOnceWith("cron.get", expect.anything(), { id: "job" });
    },
  );

  it("rejects identical nested/flat timezone and restrictions", async () => {
    await expect(
      execute({
        action: "add",
        tz: "UTC",
        toolsAllow: ["read"],
        job: { ...job, payload: { ...job.payload, toolsAllow: ["read"] } },
      }),
    ).rejects.toThrow("Do not mix job with flat fields: tz, toolsAllow. Retry with job only, or remove job and send all intended settings as flat fields.");
    expect(gateway).not.toHaveBeenCalled();
  });

  it("rejects top-level text beside an explicit nested task", async () => {
    await expect(
      execute({
        action: "add",
        text: "new",
        job: { schedule: job.schedule, payload: { kind: "agentTurn" } },
      }),
    ).rejects.toThrow("Do not mix job with flat fields: text. Retry with job only, or remove job and send all intended settings as flat fields.");
    expect(gateway).not.toHaveBeenCalled();
  });

  it("guides an unambiguous schedule-less task before any Gateway call", async () => {
    await expect(execute({ action: "add", message: "work" })).rejects.toThrow(
      "Add expr, at, or everyMs.",
    );
    expect(gateway).not.toHaveBeenCalled();
  });

  it.each(["command", "script"])(
    "rejects a text-only edit to a stored %s without a write",
    async (kind) => {
      gateway.mockResolvedValueOnce({ configRevision: "rev", payload: { kind } });
      await expect(execute({ action: "update", id: "job", text: "new" })).rejects.toThrow(
        "Use text only to edit a reminder or task job.",
      );
      expect(gateway).toHaveBeenCalledExactlyOnceWith("cron.get", expect.anything(), { id: "job" });
    },
  );
});

describe("cron schedule updates", () => {
  it("preserves the timezone for flat expressions without leaking scheduleKind", async () => {
    gateway.mockResolvedValueOnce({
      id: "job-kind",
      configRevision: "sha256:test",
      schedule: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Shanghai" },
    });
    await execute({
      action: "update",
      id: "job-kind",
      expr: "0 8 * * *",
      scheduleKind: "cron",
    });
    expect(gateway.mock.calls).toEqual([
      ["cron.get", expect.anything(), { id: "job-kind" }],
      [
        "cron.update",
        expect.anything(),
        {
          id: "job-kind",
          expectedConfigRevision: "sha256:test",
          patch: { schedule: { expr: "0 8 * * *", kind: "cron", tz: "Asia/Shanghai" } },
        },
      ],
    ]);
  });

  it.each([
    { schedule: { kind: "cron", expr: "0 8 * * *", tz: "Europe/Paris" } },
    { schedule: { kind: "every", everyMs: 60_000 } },
    { name: "renamed" },
  ])(
    "updates explicit timezones and unrelated fields without reading the job: %j",
    async (patch) => {
      await execute({ action: "update", id: "job-fast-path", job: patch });
      expect(gateway).toHaveBeenCalledExactlyOnceWith("cron.update", expect.anything(), {
        id: "job-fast-path",
        patch,
      });
    },
  );

  it.each([
    { kind: "cron", expr: "0 7 * * *" },
    { kind: "every", everyMs: 60_000 },
  ])("does not invent a timezone when the stored schedule has none: %j", async (schedule) => {
    gateway.mockResolvedValueOnce({ id: "job-no-tz", configRevision: "sha256:test", schedule });
    const patch = { schedule: { kind: "cron", expr: "0 8 * * *" } };
    await execute({ action: "update", id: "job-no-tz", job: patch });
    expect(gateway.mock.calls).toEqual([
      ["cron.get", expect.anything(), { id: "job-no-tz" }],
      [
        "cron.update",
        expect.anything(),
        { id: "job-no-tz", expectedConfigRevision: "sha256:test", patch },
      ],
    ]);
  });
});
