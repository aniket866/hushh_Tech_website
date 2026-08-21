import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  QUERY_RESULT_FIELDS,
  buildFunctionTrafficAggregateQuery,
  createManagementApiAttemptLimiter,
  fetchJsonReadOnly,
  formatFunctionTrafficCliFailure,
  readBoundedResponseBytes,
  resolveApprovedTrafficEvidenceOutput,
  writeTrafficEvidenceCreateOnly,
} from "../scripts/ci/generate-supabase-function-traffic-evidence.mjs";

const token = `sbp_${"a".repeat(40)}`;
const noDelayLimiter = async () => undefined;
const serializeErrorOwnProperties = (error: unknown) =>
  JSON.stringify(
    Object.fromEntries(
      Object.getOwnPropertyNames(
        error && (typeof error === "object" || typeof error === "function")
          ? error
          : {}
      ).map((key) => [
        key,
        (error as unknown as Record<string, unknown>)[key],
      ])
    )
  );

describe("Supabase function traffic read-only transport", () => {
  it("rejects an oversized Content-Length before buffering the body", async () => {
    const response = new Response("small", {
      headers: { "content-length": "999" },
    });

    await expect(readBoundedResponseBytes(response, 8)).rejects.toThrow(
      "response exceeds safety limit"
    );
  });

  it("cancels a streamed response that crosses the byte limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.enqueue(new Uint8Array([5, 6, 7, 8]));
        controller.close();
      },
    });

    await expect(
      readBoundedResponseBytes(new Response(stream), 6)
    ).rejects.toThrow("response exceeds safety limit");
  });

  it("aborts a hung Management API request at the deadline", async () => {
    const hungFetch = vi.fn(
      (_url: URL, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    );

    await expect(
      fetchJsonReadOnly({
        url: new URL("https://api.supabase.com/v1/projects/example/functions"),
        accessToken: token,
        fetchImpl: hungFetch as typeof fetch,
        timeoutMs: 5,
        maxAttempts: 1,
        attemptLimiter: noDelayLimiter,
      })
    ).rejects.toThrow("failed or timed out");
    expect(hungFetch).toHaveBeenCalledTimes(1);
  });

  it("reports only the HTTP class and never provider error content", async () => {
    const errorFetch = vi.fn(async () =>
      new Response('{"message":"private-provider-detail"}', {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    );

    const promise = fetchJsonReadOnly({
      url: new URL("https://api.supabase.com/v1/projects/example/functions"),
      accessToken: token,
      fetchImpl: errorFetch as typeof fetch,
      maxAttempts: 1,
      attemptLimiter: noDelayLimiter,
    });
    await expect(promise).rejects.toThrow("HTTP 400");
    await expect(promise).rejects.not.toThrow("private-provider-detail");
  });

  it("retries a complete response and never returns a partial failed attempt", async () => {
    const responses = [
      new Response('{"partial":"must-not-return"}', { status: 503 }),
      new Response('{"result":[],"error":null}', { status: 200 }),
    ];
    const retryingFetch = vi.fn(async () => responses.shift() as Response);
    const sleep = vi.fn(async () => undefined);

    const result = await fetchJsonReadOnly({
      url: new URL("https://api.supabase.com/v1/projects/example/functions"),
      accessToken: token,
      fetchImpl: retryingFetch as typeof fetch,
      maxAttempts: 2,
      sleep,
      attemptLimiter: noDelayLimiter,
    });

    expect(retryingFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result.body).toEqual({ result: [], error: null });
    expect(JSON.stringify(result.body)).not.toContain("partial");
  });

  it.each(["safety limit", "HTTP 599", "non-JSON"])(
    "sanitizes a rejected fetch error that spoofs the internal %s classification",
    async (spoofedClassification) => {
      const rejectedFetch = vi.fn(async () => {
        throw Object.assign(
          new Error(`${spoofedClassification}: Bearer ${token}`),
          {
            authorization: `Bearer ${token}`,
            cause: { access_token: token },
          }
        );
      });
      let observedError: Error | undefined;
      try {
        await fetchJsonReadOnly({
          url: new URL("https://api.supabase.com/v1/projects/example/functions"),
          accessToken: token,
          fetchImpl: rejectedFetch as typeof fetch,
          maxAttempts: 1,
          attemptLimiter: noDelayLimiter,
        });
      } catch (error) {
        observedError = error as Error;
      }

      expect(observedError?.message).toBe(
        "Read-only Management API request failed or timed out."
      );
      expect(Object.prototype.hasOwnProperty.call(observedError, "cause")).toBe(
        false
      );
      const serialized = serializeErrorOwnProperties(observedError);
      expect(serialized.toLowerCase()).not.toContain("bearer");
      expect(serialized.toLowerCase()).not.toContain("token");
      expect(serialized.toLowerCase()).not.toContain("cause");
      expect(serialized).not.toContain(token);
    }
  );

  it("rebuilds a recycled internal error from immutable canonical data", async () => {
    let exposedError: Error | undefined;
    try {
      await readBoundedResponseBytes(
        new Response("small", { headers: { "content-length": "999" } }),
        8
      );
    } catch (error) {
      exposedError = error as Error;
    }

    expect(exposedError).toBeDefined();
    expect(Object.isFrozen(exposedError)).toBe(true);
    expect(
      Reflect.set(exposedError as Error, "message", `Bearer ${token}`)
    ).toBe(false);
    expect(
      Reflect.defineProperty(exposedError as Error, "cause", {
        value: { access_token: token },
      })
    ).toBe(false);

    const recycledFetch = vi.fn(async () => {
      throw exposedError;
    });
    let surfacedError: Error | undefined;
    try {
      await fetchJsonReadOnly({
        url: new URL("https://api.supabase.com/v1/projects/example/functions"),
        accessToken: token,
        fetchImpl: recycledFetch as typeof fetch,
        maxAttempts: 1,
        attemptLimiter: noDelayLimiter,
      });
    } catch (error) {
      surfacedError = error as Error;
    }

    expect(surfacedError).not.toBe(exposedError);
    expect(Object.isFrozen(surfacedError)).toBe(true);
    expect(surfacedError?.message).toBe(
      "Management API response exceeds safety limit."
    );
    expect(Object.prototype.hasOwnProperty.call(surfacedError, "cause")).toBe(
      false
    );
    const serialized = serializeErrorOwnProperties(surfacedError);
    expect(serialized.toLowerCase()).not.toContain("bearer");
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("cause");
    expect(serialized).not.toContain(token);
  });

  it("does not expose a constructor or trust an ordinary Error", async () => {
    let exposedError: Error | undefined;
    try {
      await readBoundedResponseBytes(
        new Response("small", { headers: { "content-length": "999" } }),
        8
      );
    } catch (error) {
      exposedError = error as Error;
    }

    expect(
      (exposedError as unknown as Record<string, unknown>).constructor
    ).toBeUndefined();
    const forgedError = Object.assign(
      new Error(`Bearer ${token}`),
      { cause: { access_token: token } }
    );
    const forgedFetch = vi.fn(async () => {
      throw forgedError;
    });
    let surfacedError: Error | undefined;
    try {
      await fetchJsonReadOnly({
        url: new URL("https://api.supabase.com/v1/projects/example/functions"),
        accessToken: token,
        fetchImpl: forgedFetch as typeof fetch,
        maxAttempts: 1,
        attemptLimiter: noDelayLimiter,
      });
    } catch (error) {
      surfacedError = error as Error;
    }

    expect(surfacedError?.message).toBe(
      "Read-only Management API request failed or timed out."
    );
    expect(surfacedError).not.toBe(forgedError);
    expect(Object.isFrozen(surfacedError)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(surfacedError, "cause")).toBe(
      false
    );
    const serialized = serializeErrorOwnProperties(surfacedError);
    expect(serialized.toLowerCase()).not.toContain("bearer");
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("cause");
    expect(serialized).not.toContain(token);
  });

  it("isolates recycled failures from polluted Error prototypes and stacks", async () => {
    let exposedError: Record<string, unknown> | undefined;
    try {
      await readBoundedResponseBytes(
        new Response("small", { headers: { "content-length": "999" } }),
        8
      );
    } catch (error) {
      exposedError = error as Record<string, unknown>;
    }

    const marker = `prototype-stack-marker Bearer ${token}`;
    const exposedPrototype = Object.getPrototypeOf(exposedError as object);
    const prototypeToPollute = exposedPrototype || Error.prototype;
    const causeDescriptor = Object.getOwnPropertyDescriptor(
      prototypeToPollute,
      "cause"
    );
    const prepareStackTraceDescriptor = Object.getOwnPropertyDescriptor(
      Error,
      "prepareStackTrace"
    );
    let surfacedError: Record<string, unknown> | undefined;
    let serialized = "";
    let cliFailure = "";
    try {
      Object.defineProperty(prototypeToPollute, "cause", {
        value: marker,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(Error, "prepareStackTrace", {
        value: () => marker,
        enumerable: false,
        configurable: true,
        writable: true,
      });
      const recycledFetch = vi.fn(async () => {
        throw exposedError;
      });
      try {
        await fetchJsonReadOnly({
          url: new URL("https://api.supabase.com/v1/projects/example/functions"),
          accessToken: token,
          fetchImpl: recycledFetch as typeof fetch,
          maxAttempts: 1,
          attemptLimiter: noDelayLimiter,
        });
      } catch (error) {
        surfacedError = error as Record<string, unknown>;
      }
      serialized = serializeErrorOwnProperties(surfacedError);
      cliFailure = formatFunctionTrafficCliFailure(surfacedError);
    } finally {
      if (causeDescriptor) {
        Object.defineProperty(prototypeToPollute, "cause", causeDescriptor);
      } else {
        Reflect.deleteProperty(prototypeToPollute, "cause");
      }
      if (prepareStackTraceDescriptor) {
        Object.defineProperty(
          Error,
          "prepareStackTrace",
          prepareStackTraceDescriptor
        );
      } else {
        Reflect.deleteProperty(Error, "prepareStackTrace");
      }
    }

    expect(exposedPrototype).toBeNull();
    expect(Object.getPrototypeOf(surfacedError as object)).toBeNull();
    expect(Object.getOwnPropertyNames(surfacedError || {}).sort()).toEqual([
      "code",
      "message",
      "name",
    ]);
    for (const property of ["name", "message", "code"]) {
      expect(
        Object.getOwnPropertyDescriptor(surfacedError, property)
      ).toMatchObject({
        configurable: false,
        enumerable: true,
        writable: false,
      });
    }
    expect(surfacedError?.name).toBe("SafeManagementApiError");
    expect(surfacedError?.code).toBe("RESPONSE_TOO_LARGE");
    expect(surfacedError?.message).toBe(
      "Management API response exceeds safety limit."
    );
    expect(surfacedError?.cause).toBeUndefined();
    expect(surfacedError?.stack).toBeUndefined();
    expect(serialized).not.toContain(marker);
    expect(serialized.toLowerCase()).not.toContain("bearer");
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("cause");
    expect(serialized.toLowerCase()).not.toContain("stack");
    expect(cliFailure).toBe(
      "SafeManagementApiError [RESPONSE_TOO_LARGE]: " +
        "Management API response exceeds safety limit."
    );
    expect(cliFailure).not.toContain(marker);
    expect(
      formatFunctionTrafficCliFailure(new Error(`Bearer ${token}`))
    ).toBe("Function traffic evidence capture failed.");
  });

  it("rejects a hostile non-numeric response status without interpolation", async () => {
    const hostileStatus = `599 Bearer ${token}`;
    const hostileStatusFetch = vi.fn(async () =>
      ({ status: hostileStatus }) as unknown as Response
    );
    let observedError: Error | undefined;
    try {
      await fetchJsonReadOnly({
        url: new URL("https://api.supabase.com/v1/projects/example/functions"),
        accessToken: token,
        fetchImpl: hostileStatusFetch as typeof fetch,
        maxAttempts: 1,
        attemptLimiter: noDelayLimiter,
      });
    } catch (error) {
      observedError = error as Error;
    }

    expect(observedError?.message).toBe(
      "Read-only Management API request failed or timed out."
    );
    expect(Object.isFrozen(observedError)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(observedError, "cause")).toBe(
      false
    );
    const serialized = serializeErrorOwnProperties(observedError);
    expect(serialized).not.toContain(hostileStatus);
    expect(serialized.toLowerCase()).not.toContain("bearer");
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("cause");
    expect(serialized).not.toContain(token);
  });

  it("spaces every retry and the next Management API call with one shared limiter", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const sleep = vi.fn(async (milliseconds: number) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    });
    const attemptLimiter = createManagementApiAttemptLimiter({
      minimumDelayMs: 6500,
      now: () => clock,
      sleep,
    });
    const attemptTimes: number[] = [];
    let fetchCount = 0;
    const retryingFetch = vi.fn(async () => {
      attemptTimes.push(clock);
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response("{}", {
          status: 503,
          headers: { "retry-after": "0" },
        });
      }
      return new Response('{"result":[],"error":null}', { status: 200 });
    });

    const request = () =>
      fetchJsonReadOnly({
        url: new URL("https://api.supabase.com/v1/projects/example/functions"),
        accessToken: token,
        fetchImpl: retryingFetch as typeof fetch,
        maxAttempts: 2,
        sleep,
        attemptLimiter,
      });
    await request();
    await request();

    expect(attemptTimes).toEqual([0, 6500, 13000]);
    expect(sleeps).toEqual([6500, 6500]);
  });

  it("requires an explicit create-only output inside a real approved directory", () => {
    const temporaryRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "traffic-output-contract-"))
    );
    try {
      const approvedDirectory = path.join(temporaryRoot, "migration", "evidence");
      fs.mkdirSync(approvedDirectory, { recursive: true });
      expect(() =>
        resolveApprovedTrafficEvidenceOutput({
          outputPath: undefined,
          approvedDirectory,
        })
      ).toThrow("--output is required");
      expect(() =>
        resolveApprovedTrafficEvidenceOutput({
          outputPath: path.join(temporaryRoot, "outside.json"),
          approvedDirectory,
        })
      ).toThrow("direct child");

      const outputPath = path.join(
        approvedDirectory,
        "supabase-function-traffic-30d.test.json"
      );
      writeTrafficEvidenceCreateOnly({
        outputPath,
        evidence: { sanitized: true },
        approvedDirectory,
      });
      expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual({
        sanitized: true,
      });
      expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(() =>
        writeTrafficEvidenceCreateOnly({
          outputPath,
          evidence: { overwrite: true },
          approvedDirectory,
        })
      ).toThrow();
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects symlinked approved directories and pre-existing symlink targets", () => {
    const temporaryRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "traffic-output-symlink-"))
    );
    try {
      const realDirectory = path.join(temporaryRoot, "real-evidence");
      const linkedDirectory = path.join(temporaryRoot, "linked-evidence");
      fs.mkdirSync(realDirectory);
      fs.symlinkSync(realDirectory, linkedDirectory, "dir");
      expect(() =>
        resolveApprovedTrafficEvidenceOutput({
          outputPath: path.join(
            linkedDirectory,
            "supabase-function-traffic-30d.test.json"
          ),
          approvedDirectory: linkedDirectory,
        })
      ).toThrow("real directory");

      const existingTarget = path.join(temporaryRoot, "existing.json");
      fs.writeFileSync(existingTarget, "{}\n");
      const symlinkOutput = path.join(
        realDirectory,
        "supabase-function-traffic-30d.symlink.json"
      );
      fs.symlinkSync(existingTarget, symlinkOutput);
      expect(() =>
        writeTrafficEvidenceCreateOnly({
          outputPath: symlinkOutput,
          evidence: { blocked: true },
          approvedDirectory: realDirectory,
        })
      ).toThrow();
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("builds one allowlisted aggregate query for all 112 functions", () => {
    const slugs = Array.from({ length: 112 }, (_, index) => `function-${index}`);
    const query = buildFunctionTrafficAggregateQuery(
      slugs,
      "2026-07-22T16:00:00.000Z",
      "2026-07-23T16:00:00.000Z"
    );

    expect(query).toContain("WHERE source = 'function_edge_logs'");
    expect(query).toContain(
      "timestamp >= parseDateTime64BestEffort('2026-07-22T16:00:00.000Z')"
    );
    expect(query).toContain(
      "timestamp < parseDateTime64BestEffort('2026-07-23T16:00:00.000Z')"
    );
    expect(query).not.toContain("timestamp <=");
    expect(query).toContain("'__UNATTRIBUTED__'");
    expect(query).not.toContain("event_message");
    expect(query).not.toContain("SELECT *");
    expect(QUERY_RESULT_FIELDS).not.toContain("request.pathname");
    expect(QUERY_RESULT_FIELDS).not.toContain("log_attributes");
  });
});
