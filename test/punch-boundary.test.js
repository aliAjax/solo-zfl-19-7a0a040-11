const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PORT = 4700 + Math.floor(Math.random() * 250);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = path.join(__dirname, "..", "server.js");

let tmpDir;
let dbFile;
let serverProcess;

async function waitForServer(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("服务启动超时");
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-boundary-"));
  dbFile = path.join(tmpDir, "db.json");
  serverProcess = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(PORT), DB_FILE: dbFile },
    stdio: "ignore"
  });
  await waitForServer();
});

after(async () => {
  if (serverProcess) {
    serverProcess.kill();
    await new Promise((resolve) => serverProcess.once("exit", resolve));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

const report = (jobId, body) => api("POST", `/punch-jobs/${jobId}/reports`, body);
const progress = (jobId) => api("GET", `/punch-jobs/${jobId}/progress`);
const plan = (jobId) => api("GET", `/punch-jobs/${jobId}/plan`);
const jobCount = async () => (await api("GET", "/punch-jobs")).body.data.length;

async function createJob(overrides = {}) {
  const res = await api("POST", "/punch-jobs", {
    tuneId: "tune_demo",
    pins: [1, 2, 3],
    maxPunchesPerStroke: 2,
    holes: [
      { lane: 1, position: 1 },
      { lane: 2, position: 2 }
    ],
    ...overrides
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

test("入参:conflictPairs 不是数组时返回参数错误且不创建任务", async () => {
  const before = await jobCount();
  for (const bad of ["1-2", 5, true, { lanes: [1, 2] }]) {
    const res = await api("POST", "/punch-jobs", {
      tuneId: "tune_demo",
      pins: [1, 2],
      maxPunchesPerStroke: 2,
      holes: [{ lane: 1, position: 1 }],
      conflictPairs: bad
    });
    assert.equal(res.status, 400, `conflictPairs=${JSON.stringify(bad)}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.error, /conflictPairs/);
  }
  // 轨对内部非法同样拒绝
  for (const badPairs of [[1], [["1", 2]], [[1, 1]], [["a", "b"]], [null]]) {
    const res = await api("POST", "/punch-jobs", {
      tuneId: "tune_demo",
      pins: [1, 2],
      maxPunchesPerStroke: 2,
      holes: [{ lane: 1, position: 1 }],
      conflictPairs: badPairs
    });
    assert.equal(res.status, 400, `conflictPairs=${JSON.stringify(badPairs)}: ${JSON.stringify(res.body)}`);
  }
  assert.equal(await jobCount(), before, "非法 conflictPairs 不得创建任务");

  // 控制组:合法与缺省 conflictPairs 正常创建
  const ok = await api("POST", "/punch-jobs", {
    tuneId: "tune_demo",
    pins: [1, 2],
    maxPunchesPerStroke: 2,
    holes: [
      { lane: 1, position: 1 },
      { lane: 2, position: 1 }
    ],
    conflictPairs: [[1, 2]]
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.steps.length, 2, "冲突轨必须分步");
  const absent = await api("POST", "/punch-jobs", {
    tuneId: "tune_demo",
    pins: [1, 2],
    maxPunchesPerStroke: 2,
    holes: [{ lane: 1, position: 1 }]
  });
  assert.equal(absent.status, 201);
});

test("入参:孔位行程为空值、布尔或字符串时拒绝且保持原数据", async () => {
  const before = await jobCount();
  for (const badPosition of [null, true, false, "5", "", "abc", 1.5, -1]) {
    const res = await api("POST", "/punch-jobs", {
      tuneId: "tune_demo",
      pins: [1, 2],
      maxPunchesPerStroke: 2,
      holes: [{ lane: 1, position: badPosition }]
    });
    assert.equal(res.status, 400, `position=${JSON.stringify(badPosition)}: ${JSON.stringify(res.body)}`);
  }
  // 缺字段、非对象孔位
  for (const badHole of [{ lane: 1 }, { position: 1 }, null, "x", [1, 2]]) {
    const res = await api("POST", "/punch-jobs", {
      tuneId: "tune_demo",
      pins: [1, 2],
      maxPunchesPerStroke: 2,
      holes: [badHole]
    });
    assert.equal(res.status, 400, `hole=${JSON.stringify(badHole)}: ${JSON.stringify(res.body)}`);
  }
  // 轨号同样不得被强转
  for (const badLane of [null, true, "2", 0, -1, 1.5]) {
    const res = await api("POST", "/punch-jobs", {
      tuneId: "tune_demo",
      pins: [1, 2],
      maxPunchesPerStroke: 2,
      holes: [{ lane: badLane, position: 1 }]
    });
    assert.equal(res.status, 400, `lane=${JSON.stringify(badLane)}: ${JSON.stringify(res.body)}`);
  }
  // pins 与 maxPunchesPerStroke 同类边界
  for (const [field, value] of [
    ["pins", [1, "2"]],
    ["pins", [true]],
    ["maxPunchesPerStroke", "2"],
    ["maxPunchesPerStroke", true],
    ["maxPunchesPerStroke", 0],
    ["maxPunchesPerStroke", 1.5]
  ]) {
    const res = await api("POST", "/punch-jobs", {
      tuneId: "tune_demo",
      pins: [1, 2],
      maxPunchesPerStroke: 2,
      holes: [{ lane: 1, position: 1 }],
      [field]: value
    });
    assert.equal(res.status, 400, `${field}=${JSON.stringify(value)}: ${JSON.stringify(res.body)}`);
  }
  assert.equal(await jobCount(), before, "非法入参不得创建任务、不得改动原数据");

  // 控制组:position 0 是合法起点
  const ok = await api("POST", "/punch-jobs", {
    tuneId: "tune_demo",
    pins: [1],
    maxPunchesPerStroke: 1,
    holes: [{ lane: 1, position: 0 }]
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.steps[0].position, 0);
});

test("回报:失败步骤重复回报返回原状态且不重复计数", async () => {
  const job = await createJob();

  const first = await report(job.id, { seq: 1, result: "failed" });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.failedSteps, 1);
  assert.equal(first.body.data.nextSeq, 1);

  // 再次回报同样的失败:幂等,不重复累计
  const again = await report(job.id, { seq: 1, result: "failed" });
  assert.equal(again.status, 200);
  assert.equal(again.body.deduplicated, true);
  assert.deepEqual(again.body.data, first.body.data, "重复失败回报必须返回原状态");

  // 携带一致行程/轨位的重复失败回报同样幂等
  const withDetail = await report(job.id, { seq: 1, result: "failed", position: 1, lanes: [1] });
  assert.equal(withDetail.status, 200);
  assert.equal(withDetail.body.deduplicated, true);

  const planAfter = await plan(job.id);
  assert.equal(planAfter.body.data[0].failureCount, 1, "失败次数不得重复累计");
  assert.equal(planAfter.body.data[0].status, "failed");

  // 重复失败回报若与计划冲突仍是 409
  const conflict = await report(job.id, { seq: 1, result: "failed", position: 99 });
  assert.equal(conflict.status, 409);

  // 重试仍然可用:从原进度继续
  const retry = await report(job.id, { seq: 1, result: "ok" });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.nextSeq, 2);
  assert.equal(retry.body.data.failedSteps, 0);
});

test("回报:已完成步骤的冲突回报返回409且不改状态", async () => {
  const job = await createJob();
  const done = await report(job.id, { seq: 1, result: "ok" });
  assert.equal(done.body.data.completedSteps, 1);

  // 行程冲突
  const badPosition = await report(job.id, { seq: 1, position: 99 });
  assert.equal(badPosition.status, 409);
  assert.match(badPosition.body.error, /冲突/);

  // 轨位冲突
  const badLanes = await report(job.id, { seq: 1, lanes: [2] });
  assert.equal(badLanes.status, 409);
  assert.match(badLanes.body.error, /冲突/);

  // 状态未被改变
  const now = await progress(job.id);
  assert.equal(now.body.data.completedSteps, 1);
  assert.equal(now.body.data.nextSeq, 2);
  const planAfter = await plan(job.id);
  assert.equal(planAfter.body.data[0].status, "done");

  // 与计划一致的重复回报仍然幂等
  const consistent = await report(job.id, { seq: 1, position: 1, lanes: [1] });
  assert.equal(consistent.status, 200);
  assert.equal(consistent.body.deduplicated, true);
  const bare = await report(job.id, { seq: 1 });
  assert.equal(bare.status, 200);
  assert.equal(bare.body.deduplicated, true);
});

test("回报:边界类型被拒绝且不改状态", async () => {
  const job = await createJob();
  for (const bad of [
    { seq: "1" },
    { seq: true },
    { seq: null },
    { seq: 1.5 },
    { seq: 0 },
    { seq: 1, position: "1" },
    { seq: 1, position: true },
    { seq: 1, lanes: "1" },
    { seq: 1, result: "maybe" }
  ]) {
    const res = await report(job.id, bad);
    assert.equal(res.status, 400, `${JSON.stringify(bad)}: ${JSON.stringify(res.body)}`);
  }
  const badBatch = await report(job.id, { reports: "not-an-array" });
  assert.equal(badBatch.status, 400);

  const now = await progress(job.id);
  assert.equal(now.body.data.completedSteps, 0, "非法回报不得改变状态");
  assert.equal(now.body.data.nextSeq, 1);
});

test("入参:conflictPairs 为 null 按非数组拒绝,缺省字段正常创建", async () => {
  const before = await jobCount();
  const nullRes = await api("POST", "/punch-jobs", {
    tuneId: "tune_demo",
    pins: [1, 2],
    maxPunchesPerStroke: 2,
    holes: [{ lane: 1, position: 1 }],
    conflictPairs: null
  });
  assert.equal(nullRes.status, 400, JSON.stringify(nullRes.body));
  assert.match(nullRes.body.error, /conflictPairs/);
  assert.equal(await jobCount(), before, "null 冲突轨约束不得创建任务、不得写入数据");

  // 缺少 conflictPairs 字段仍正常创建
  const missing = await api("POST", "/punch-jobs", {
    tuneId: "tune_demo",
    pins: [1, 2],
    maxPunchesPerStroke: 2,
    holes: [
      { lane: 1, position: 1 },
      { lane: 2, position: 1 }
    ]
  });
  assert.equal(missing.status, 201, "缺少 conflictPairs 字段应正常创建");
  assert.deepEqual(missing.body.data.conflictPairs, []);
  assert.equal(missing.body.data.steps.length, 1, "无冲突约束时同行程可合并");
});

test("入参:请求体整体为 null 或非对象时返回参数错误且不创建任务", async () => {
  const before = await jobCount();
  for (const bad of [null, [1, 2], "text", 5, true]) {
    const res = await api("POST", "/punch-jobs", bad);
    assert.equal(res.status, 400, `body=${JSON.stringify(bad)}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.error, "应返回明确的参数错误信息");
  }
  assert.equal(await jobCount(), before, "非法请求体不得创建任务、不得写入数据");
});

test("并行:并发重复失败回报只计一次失败", async () => {
  const job = await createJob();
  const results = await Promise.all(Array.from({ length: 5 }, () => report(job.id, { seq: 1, result: "failed" })));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(results.filter((r) => !r.body.deduplicated).length, 1, "只应有一条回报真正生效");

  const planAfter = await plan(job.id);
  assert.equal(planAfter.body.data[0].failureCount, 1, "并发失败回报不得重复计数");
  const now = await progress(job.id);
  assert.equal(now.body.data.failedSteps, 1);
  assert.equal(now.body.data.nextSeq, 1);
});
