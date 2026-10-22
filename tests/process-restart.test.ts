import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/[a-zA-Z0-9_]+_test$/.test(new URL(databaseUrl).pathname)) {
  throw new Error("Process restart test requires a disposable *_test database");
}

test("real application process restart retains job/key and recovers polling without another submit (fake Worker)", async () => {
  const sql = new SQL(databaseUrl);
  await sql.unsafe("DROP TABLE IF EXISTS owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners CASCADE");
  const directory = await mkdtemp(join(tmpdir(), "studio-restart-"));
  const accountsFile = join(directory, "accounts.json");
  await writeFile(accountsFile, JSON.stringify([{ id: "test", label: "模拟账号", appId: "FAKE", appSecret: "FAKE", pat: "FAKE" }]));
  const workerId = randomUUID();
  let submissions = 0;
  let registrations = 0;
  let status = "queued";
  let failQuery = false;
  let workerInput: any;
  const worker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ capabilities: { jobLookupByIdempotencyKey: true } });
    if (path.startsWith("/v1/accounts/") && request.method === "PUT") { registrations++; return Response.json({ active: true }); }
    if (path === "/v1/jobs" && request.method === "POST") {
      submissions++; workerInput = await request.json();
      return Response.json({ id: workerId, input: workerInput, bodyHash: createHash("sha256").update(workerInput.body).digest("hex"), status, step: status });
    }
    if (path === `/v1/jobs/${workerId}`) {
      if (failQuery) return new Response("unavailable", { status: 503 });
      return Response.json({ id: workerId, input: workerInput, bodyHash: createHash("sha256").update(workerInput.body).digest("hex"), status, step: status === "succeeded" ? "done" : status,
        result: { publishResults: status === "succeeded" ? [{ account: "test", status: "success", external_id: "SIMULATED_RESTART_DRAFT" }] : [] } });
    }
    return new Response("missing", { status: 404 });
  } });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = reservation.port!;
  reservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const secret = randomUUID() + randomUUID();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const start = async () => {
    child = Bun.spawn([process.execPath, "run", "src/server/index.ts"], {
      env: { ...process.env, DATABASE_URL: databaseUrl, BOOTSTRAP_SECRET: secret, APP_ORIGIN: origin,
        IMPORT_ACCOUNTS_ONCE: "1", CREDENTIAL_ENCRYPTION_KEY: "ab".repeat(32),
        ACCOUNTS_FILE: accountsFile, PIPELINE_WORKER_URL: worker.url.origin, PIPELINE_WORKER_TOKEN: "FAKE_TOKEN", PUBLISHING_TEST_MODE: "fake-worker", PORT: String(port) },
      stdout: "ignore", stderr: "ignore",
    });
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch {}
      await Bun.sleep(50);
    }
    throw new Error("Application process failed to start");
  };
  let cookie = "";
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${origin}/api${path}`, { method,
      headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(response.ok).toBe(true);
    return response;
  };
  try {
    await start();
    const login = await request("/auth/login", "POST", { secret });
    cookie = login.headers.get("Set-Cookie")!.split(";")[0];
    const doc = await (await request("/documents", "POST", { title: "进程重启", body: "## 精确保留\n\n内容\n" })).json() as any;
    const job = await (await request("/jobs", "POST", { documentId: doc.id, revision: doc.revision, accountId: "test" })).json() as any;
    expect(job.status).toBe("queued"); expect(registrations).toBe(1);
    const [before] = await sql`SELECT idempotency_key FROM jobs WHERE id=${job.id}`;
    child!.kill(); await child!.exited;
    const pendingId = randomUUID();
    await sql`INSERT INTO jobs (id,owner_id,document_id,document_revision,account_id,idempotency_key,title,body,status,simulated)
      SELECT ${pendingId},owner_id,document_id,document_revision+1,account_id,${`studio:${pendingId}`},title,body,'submitting',true FROM jobs WHERE id=${job.id}`;
    await start();
    const restored = await (await request(`/documents/${doc.id}`)).json() as any;
    expect(restored.body).toBe(doc.body);
    const [after] = await sql`SELECT idempotency_key FROM jobs WHERE id=${job.id}`;
    expect(after.idempotency_key).toBe(before.idempotency_key);
    const [pending] = await sql`SELECT status,idempotency_key FROM jobs WHERE id=${pendingId}`;
    expect(pending.status).toBe("unknown"); expect(pending.idempotency_key).toBe(`studio:${pendingId}`);
    status = "running";
    expect((await (await request(`/jobs/${job.id}`)).json() as any).status).toBe("running");
    failQuery = true;
    expect((await (await request(`/jobs/${job.id}`)).json() as any).status).toBe("unknown");
    failQuery = false; status = "succeeded";
    const done = await (await request(`/jobs/${job.id}`)).json() as any;
    expect(done.status).toBe("succeeded"); expect(done.simulated).toBe(true);
    expect(done.draftMediaId).toBe("SIMULATED_RESTART_DRAFT"); expect(submissions).toBe(1);
  } finally {
    child?.kill(); if (child) await child.exited;
    worker.stop(true); await sql.close(); await rm(directory, { recursive: true });
  }
}, 15_000);
