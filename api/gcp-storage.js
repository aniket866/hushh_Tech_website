import { storageRuntime, verifyFirebaseBearer } from "./shared/gcpDataRuntime.js";

function objectPath(req) {
  const prefix = "/api/gcp/storage/";
  const pathname = String(req.path || req.url || "").split("?")[0];
  const parts = pathname.startsWith(prefix) ? pathname.slice(prefix.length).split("/").map(decodeURIComponent) : [];
  return { bucket: parts.shift() || "", object: parts.join("/") };
}

export default async function handler(req, res) {
  try {
    const actor = await verifyFirebaseBearer(req.headers.authorization);
    const runtime = storageRuntime();
    if (req.method === "PUT") {
      const target = objectPath(req);
      if (!target.object || target.object.includes("..")) return res.status(400).json({ error: { code: "INVALID_OBJECT_PATH", message: "Invalid object path." } });
      const file = runtime.bucket(target.bucket).file(`${actor.uid}/${target.object}`);
      await file.save(req.body, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: req.headers["content-type"] || "application/octet-stream", metadata: { firebaseUid: actor.uid } } });
      return res.status(201).json({ data: { path: target.object } });
    }
    if (req.method === "POST") {
      const { bucket, path = "", options = {} } = req.body || {};
      const prefix = `${actor.uid}/${String(path).replace(/^\/+/, "")}`;
      const [files] = await runtime.bucket(bucket).getFiles({ prefix, maxResults: Math.min(Number(options.limit) || 100, 1000), autoPaginate: false });
      return res.status(200).json({ data: files.map((file) => ({ name: file.name.slice(actor.uid.length + 1), metadata: file.metadata })) });
    }
    if (req.method === "DELETE") {
      const { bucket, paths } = req.body || {};
      if (!Array.isArray(paths) || paths.length > 100) return res.status(400).json({ error: { code: "INVALID_DELETE", message: "Invalid object list." } });
      await Promise.all(paths.map((path) => runtime.bucket(bucket).file(`${actor.uid}/${String(path).replace(/^\/+/, "")}`).delete({ ignoreNotFound: true })));
      return res.status(200).json({ data: paths });
    }
    return res.status(405).json({ error: { code: "METHOD_NOT_ALLOWED", message: "Unsupported method." } });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    return res.status(status).json({ error: { code: error?.code || "GCP_STORAGE_ERROR", message: status >= 500 ? "GCP storage service unavailable." : error.message } });
  }
}
