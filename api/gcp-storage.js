import { storageRuntime, verifyFirebaseBearer } from "./shared/gcpDataRuntime.js";

const MAX_OBJECT_BYTES = 25 * 1024 * 1024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const STORAGE_ACTOR_UID = /^[A-Za-z0-9_~.-]{1,128}$/;

export function normalizeObjectPath(value, { allowEmpty = false } = {}) {
  const path = String(value ?? "").replace(/^\/+/, "");
  if (allowEmpty && !path) return "";
  if (
    (!allowEmpty && !path) ||
    path.length > 1024 ||
    path.includes("\\") ||
    CONTROL_CHARACTER.test(path) ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw Object.assign(new Error("Invalid object path."), { status: 400, code: "INVALID_OBJECT_PATH" });
  }
  return path;
}

export function actorObjectPath(uid, value, options) {
  if (!STORAGE_ACTOR_UID.test(uid) || uid === "." || uid === "..") {
    throw Object.assign(new Error("Invalid storage actor."), { status: 401, code: "AUTH_INVALID" });
  }
  let path = normalizeObjectPath(value, options);
  if (!path) return `${uid}/`;
  if (path.startsWith(`${uid}/`)) path = path.slice(uid.length + 1);
  return `${uid}/${normalizeObjectPath(path)}`;
}

function objectPath(req) {
  const prefix = "/api/gcp/storage/";
  const pathname = String(req.path || req.url || "").split("?")[0];
  let parts = [];
  try {
    parts = pathname.startsWith(prefix) ? pathname.slice(prefix.length).split("/").map(decodeURIComponent) : [];
  } catch {
    throw Object.assign(new Error("Invalid object path."), { status: 400, code: "INVALID_OBJECT_PATH" });
  }
  return { bucket: parts.shift() || "", object: parts.join("/") };
}

export default async function handler(req, res) {
  try {
    const actor = await verifyFirebaseBearer(req.headers.authorization);
    const runtime = storageRuntime();
    if (req.method === "PUT") {
      const target = objectPath(req);
      const bytes = Buffer.isBuffer(req.body) ? req.body : null;
      if (!bytes || bytes.length === 0 || bytes.length > MAX_OBJECT_BYTES) {
        return res.status(413).json({ error: { code: "INVALID_OBJECT_BODY", message: "Invalid object body." } });
      }
      const object = actorObjectPath(actor.uid, target.object);
      const file = runtime.bucket(target.bucket).file(object);
      await file.save(bytes, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: req.headers["content-type"] || "application/octet-stream", metadata: { firebaseUid: actor.uid } } });
      return res.status(201).json({ data: { path: object.slice(actor.uid.length + 1) } });
    }
    if (req.method === "GET") {
      const target = objectPath(req);
      const object = actorObjectPath(actor.uid, target.object);
      const bucket = runtime.bucket(target.bucket);
      const [metadata] = await bucket.file(object).getMetadata();
      const size = Number(metadata.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OBJECT_BYTES) {
        return res.status(413).json({ error: { code: "OBJECT_TOO_LARGE", message: "Object is too large." } });
      }
      const [bytes] = await bucket.file(object, { generation: metadata.generation }).download();
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Type", metadata.contentType || "application/octet-stream");
      res.setHeader("Content-Length", String(bytes.length));
      return res.status(200).send(bytes);
    }
    if (req.method === "POST") {
      const { bucket, path = "", options = {} } = req.body || {};
      const prefix = actorObjectPath(actor.uid, path, { allowEmpty: true });
      const requestedLimit = options.limit === undefined ? 100 : Number(options.limit);
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 1000) {
        return res.status(400).json({ error: { code: "INVALID_LIST_LIMIT", message: "Invalid list limit." } });
      }
      const [files] = await runtime.bucket(bucket).getFiles({ prefix, maxResults: requestedLimit, autoPaginate: false });
      return res.status(200).json({ data: files.map((file) => ({ name: file.name.slice(actor.uid.length + 1), metadata: file.metadata })) });
    }
    if (req.method === "DELETE") {
      const { bucket, paths } = req.body || {};
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) return res.status(400).json({ error: { code: "INVALID_DELETE", message: "Invalid object list." } });
      const objects = [...new Set(paths.map((path) => actorObjectPath(actor.uid, path)))];
      await Promise.all(objects.map((path) => runtime.bucket(bucket).file(path).delete({ ignoreNotFound: true })));
      return res.status(200).json({ data: objects.map((path) => path.slice(actor.uid.length + 1)) });
    }
    return res.status(405).json({ error: { code: "METHOD_NOT_ALLOWED", message: "Unsupported method." } });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    return res.status(status).json({ error: { code: error?.code || "GCP_STORAGE_ERROR", message: status >= 500 ? "GCP storage service unavailable." : error.message } });
  }
}
