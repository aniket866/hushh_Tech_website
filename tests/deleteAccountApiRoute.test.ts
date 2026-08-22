import { beforeEach, describe, expect, it, vi } from "vitest";

const createDeleteAccountAdminClientFromEnvMock = vi.fn();
const executeDeleteAccountMock = vi.fn();

vi.mock("../api/delete-account-service.js", () => ({
  createDeleteAccountAdminClientFromEnv: (...args) =>
    createDeleteAccountAdminClientFromEnvMock(...args),
  executeDeleteAccount: (...args) => executeDeleteAccountMock(...args),
}));

import deleteAccountHandler from "../api/delete-account.js";

const createResponse = () => {
  let statusCode = 200;
  let body;

  return {
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
};

describe("delete-account API route", () => {
  beforeEach(() => {
    createDeleteAccountAdminClientFromEnvMock.mockReset();
    executeDeleteAccountMock.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("rejects non-POST requests", async () => {
    const res = createResponse();

    await deleteAccountHandler({ method: "GET", headers: {} }, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: "Method not allowed" });
    expect(executeDeleteAccountMock).not.toHaveBeenCalled();
  });

  it("passes the auth header through to the delete-account service", async () => {
    createDeleteAccountAdminClientFromEnvMock.mockReturnValue({
      adminClient: { marker: "admin" },
      auditSecret: "audit-secret",
      storageAdapter: { marker: "gcs-storage" },
    });
    executeDeleteAccountMock.mockResolvedValue({
      status: 200,
      body: { success: true, deletedScopes: [], retainedScopes: [] },
    });

    const res = createResponse();
    await deleteAccountHandler(
      {
        method: "POST",
        headers: { authorization: "Bearer live-token" },
      },
      res
    );

    expect(executeDeleteAccountMock).toHaveBeenCalledWith({
      adminClient: { marker: "admin" },
      authHeader: "Bearer live-token",
      auditSecret: "audit-secret",
      storageAdapter: { marker: "gcs-storage" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      deletedScopes: [],
      retainedScopes: [],
    });
  });

  it("fails closed when the GCP admin client cannot be configured", async () => {
    createDeleteAccountAdminClientFromEnvMock.mockImplementation(() => {
      throw new Error("GCP server actor is not configured");
    });

    const res = createResponse();
    await deleteAccountHandler(
      {
        method: "POST",
        headers: { authorization: "Bearer user-token" },
      },
      res
    );

    expect(createDeleteAccountAdminClientFromEnvMock).toHaveBeenCalledTimes(1);
    expect(executeDeleteAccountMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: "Server configuration error",
      details: "GCP server actor is not configured",
    });
  });

  it("fails closed without invoking a legacy function when GCS storage is disabled", async () => {
    const disabledError = Object.assign(
      new Error("Delete-account storage is disabled until the GCP copy is reconciled."),
      { code: "GCP_DELETE_ACCOUNT_STORAGE_DISABLED" }
    );
    createDeleteAccountAdminClientFromEnvMock.mockImplementation(() => {
      throw disabledError;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = createResponse();
    await deleteAccountHandler(
      {
        method: "POST",
        headers: { authorization: "Bearer user-token" },
      },
      res
    );

    expect(createDeleteAccountAdminClientFromEnvMock).toHaveBeenCalledOnce();
    expect(executeDeleteAccountMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: "Account deletion is temporarily unavailable",
      details: "GCP_DELETE_ACCOUNT_STORAGE_DISABLED",
    });
  });

  it("preserves an authentication denial from the GCP deletion service", async () => {
    createDeleteAccountAdminClientFromEnvMock.mockReturnValue({
      adminClient: { marker: "admin" },
      auditSecret: "audit-secret",
      storageAdapter: { marker: "gcs-storage" },
    });
    executeDeleteAccountMock.mockResolvedValue({
      status: 401,
      body: { success: false, error: "Unauthorized" },
    });

    const res = createResponse();
    await deleteAccountHandler(
      {
        method: "POST",
        headers: {},
      },
      res
    );

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: "Unauthorized" });
  });
});
