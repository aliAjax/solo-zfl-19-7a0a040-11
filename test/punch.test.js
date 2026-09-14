const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PORT = 4100 + Math.floor(Math.random() * 500);
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

async function startServer() {
  serverProcess = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(PORT), DB_FILE: dbFile },
    stdio: "ignore"
  });
  await waitForServer();
}

async function stopServer() {
  if (!serverProcess) return;
  const proc = serverProcess;
  serverProcess = null;
  proc.kill();
  await new Promise((resolve) => proc.once("exit", resolve));
}

async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function createJob(overrides = {}) {
  const res = await api("POST", "/punch-jobs", {
    tuneId: "tune_demo",
    pins: [1, 2, 3, 4],
    maxPunchesPerStroke: 2,
    holes: [{ lane: 1, position: 1 }],
    ...overrides
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

const report = (jobId, body) => api("POST", `/punch-jobs/${jobId}/reports`, body);
const progress = (jobId) => api("GET", `/punch-jobs/${jobId}/progress`);

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-test-"));
  dbFile = path.join(tmpDir, "db.json");
  await startServer();
});

after(async () => {
  await stopServer();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("现有接口保持不变", async () => {
  const health = await api("GET", "/health");
  assert.equal(health.status, 200);
  for (const route of ["GET /tunes", "POST /tunes", "GET /tunes/:id/progress", "PATCH /issues/:id/status"]) {
    assert.ok(health.body.routes.includes(route), `缺少原有路由 ${route}`);
  }

  const tunes = await api("GET", "/tunes");
  assert.equal(tunes.status, 200);
  assert.ok(Array.isArray(tunes.body.data));

  const progressRes = await api("GET", "/tunes/tune_demo/progress");
  assert.equal(progressRes.status, 200);
  assert.equal(progressRes.body.data.tuneId, "tune_demo");

  const issue = await api("POST", "/issues", {
    tuneId: "tune_demo",
    sectionId: "section_demo_2",
    type: "错孔",
    beat: 45,
    lane: 9,
    description: "回归验证:原有接口仍可用"
  });
  assert.equal(issue.status, 201);
  const patched = await api("PATCH", `/issues/${issue.body.data.id}/status`, { status: "resolved" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.status, "resolved");
});

test("计划:最少步数、行程升序、轨号有序、孔位去重", async () => {
  const job = await createJob({
    conflictPairs: [[1, 2]],
    holes: [
      { lane: 2, position: 5 },
      { lane: 1, position: 5 },
      { lane: 3, position: 5 },
      { lane: 1, position: 5 }, // 重复孔,应去重
      { lane: 4, position: 2 },
      { lane: 2, position: 9 },
      { lane: 3, position: 9 }
    ]
  });

  assert.equal(job.totalHoles, 6, "重复孔位应被去重");
  assert.deepEqual(
    job.steps.map((s) => ({ seq: s.seq, position: s.position, lanes: s.lanes })),
    [
      { seq: 1, position: 2, lanes: [4] },
      { seq: 2, position: 5, lanes: [1, 3] },
      { seq: 3, position: 5, lanes: [2] },
      { seq: 4, position: 9, lanes: [2, 3] }
    ]
  );

  // 不变量:行程单调不降(纸带单向)、每步不超上限、每孔恰好出现一次
  const positions = job.steps.map((s) => s.position);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  const punched = job.steps.flatMap((s) => s.lanes.map((lane) => `${lane}:${s.position}`));
  assert.equal(new Set(punched).size, punched.length);
  assert.equal(punched.length, job.totalHoles);
  for (const step of job.steps) assert.ok(step.lanes.length <= job.maxPunchesPerStroke);
});

test("计划:互不冲突时步数等于 ceil(孔数/上限)", async () => {
  const job = await createJob({
    maxPunchesPerStroke: 2,
    holes: [1, 2, 3, 4, 5].map((lane) => ({ lane, position: 3 })),
    pins: [1, 2, 3, 4, 5]
  });
  assert.equal(job.steps.length, 3);
  assert.deepEqual(job.steps[0].lanes, [1, 2]);
  assert.deepEqual(job.steps[2].lanes, [5]);
});

test("冲突:同一行程内冲突轨不共存,全冲突时一轨一步", async () => {
  const job = await createJob({
    maxPunchesPerStroke: 3,
    conflictPairs: [
      [1, 2],
      [2, 3],
      [1, 3]
    ],
    holes: [
      { lane: 1, position: 1 },
      { lane: 2, position: 1 },
      { lane: 3, position: 1 }
    ]
  });
  assert.equal(job.steps.length, 3, "三轨两两冲突必须分三步");
  for (const step of job.steps) assert.equal(step.lanes.length, 1);
  assert.deepEqual(job.steps.map((s) => s.lanes[0]), [1, 2, 3], "步数相同按轨号排序");
});

test("校验:无冲针轨、空孔位、非法上限均被拒绝", async () => {
  const noPin = await api("POST", "/punch-jobs", {
    tuneId: "tune_demo",
    pins: [1],
    maxPunchesPerStroke: 1,
    holes: [{ lane: 9, position: 1 }]
  });
  assert.equal(noPin.status, 400);
  assert.match(noPin.body.error, /冲针/);

  const empty = await api("POST", "/punch-jobs", {
    tuneId: "tune_demo",
    pins: [1],
    maxPunchesPerStroke: 1,
    holes: []
  });
  assert.equal(empty.status, 400);

  const badLimit = await api("POST", "/punch-jobs", {
    tuneId: "tune_demo",
    pins: [1],
    maxPunchesPerStroke: 0,
    holes: [{ lane: 1, position: 1 }]
  });
  assert.equal(badLimit.status, 400);

  const noTune = await api("POST", "/punch-jobs", {
    tuneId: "tune_missing",
    pins: [1],
    maxPunchesPerStroke: 1,
    holes: [{ lane: 1, position: 1 }]
  });
  assert.equal(noTune.status, 404);
});

test("幂等:重复回报返回原进度且不改状态", async () => {
  const job = await createJob({
    holes: [
      { lane: 1, position: 1 },
      { lane: 2, position: 2 }
    ]
  });

  const first = await report(job.id, { seq: 1, result: "ok" });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.completedSteps, 1);
  assert.equal(first.body.data.nextSeq, 2);

  const dup = await report(job.id, { seq: 1, result: "ok" });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.deduplicated, true);
  assert.deepEqual(dup.body.data, first.body.data, "重复回报必须返回原进度");

  const after = await progress(job.id);
  assert.equal(after.body.data.completedSteps, 1, "重复回报不得改变进度");
});

test("乱序:缺步、跳步、不存在步骤、冲突回报都报错且不改状态", async () => {
  const job = await createJob({
    holes: [
      { lane: 1, position: 1 },
      { lane: 2, position: 2 },
      { lane: 3, position: 3 }
    ]
  });
  await report(job.id, { seq: 1 });

  const gap = await report(job.id, { seq: 3 });
  assert.equal(gap.status, 409);
  assert.match(gap.body.error, /缺步/);

  const unknown = await report(job.id, { seq: 99 });
  assert.equal(unknown.status, 409);
  assert.match(unknown.body.error, /不存在/);

  const conflictPosition = await report(job.id, { seq: 2, position: 99 });
  assert.equal(conflictPosition.status, 409);
  assert.match(conflictPosition.body.error, /冲突/);

  const conflictLanes = await report(job.id, { seq: 2, lanes: [9] });
  assert.equal(conflictLanes.status, 409);
  assert.match(conflictLanes.body.error, /冲突/);

  const batchGap = await report(job.id, { reports: [{ seq: 2 }, { seq: 4 }] });
  assert.equal(batchGap.status, 409);

  const badResult = await report(job.id, { seq: 2, result: "maybe" });
  assert.equal(badResult.status, 400);

  const missingJob = await report("punch_missing", { seq: 1 });
  assert.equal(missingJob.status, 404);

  const now = await progress(job.id);
  assert.equal(now.body.data.completedSteps, 1, "错误回报不得改变状态");
  assert.equal(now.body.data.nextSeq, 2);
});

test("重试:失败步骤进度不变,可从原进度重试并成功", async () => {
  const job = await createJob({
    holes: [
      { lane: 1, position: 1 },
      { lane: 2, position: 2 }
    ]
  });

  const failed = await report(job.id, { seq: 1, result: "failed" });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.data.failedSteps, 1);
  assert.equal(failed.body.data.completedSteps, 0);
  assert.equal(failed.body.data.nextSeq, 1, "失败后进度保持原样");

  const retry = await report(job.id, { seq: 1, result: "ok" });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.completedSteps, 1);
  assert.equal(retry.body.data.nextSeq, 2);

  const done = await report(job.id, { seq: 2 });
  assert.equal(done.body.data.status, "completed");
  assert.equal(done.body.data.percent, 100);
});

test("取消:释放后续步骤、拒绝后续回报、重复取消幂等", async () => {
  const job = await createJob({
    holes: [
      { lane: 1, position: 1 },
      { lane: 2, position: 2 },
      { lane: 3, position: 3 }
    ]
  });
  await report(job.id, { seq: 1 });

  const cancelled = await api("POST", `/punch-jobs/${job.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.status, "cancelled");
  assert.equal(cancelled.body.data.progress.completedSteps, 1, "已完成步骤保留");
  assert.equal(cancelled.body.data.progress.releasedSteps, 2, "后续步骤被释放");

  const plan = await api("GET", `/punch-jobs/${job.id}/plan`);
  assert.deepEqual(
    plan.body.data.map((s) => s.status),
    ["done", "released", "released"]
  );

  const afterCancel = await report(job.id, { seq: 2 });
  assert.equal(afterCancel.status, 409);
  assert.match(afterCancel.body.error, /取消/);

  const again = await api("POST", `/punch-jobs/${job.id}/cancel`);
  assert.equal(again.status, 200, "重复取消幂等");

  const state = await progress(job.id);
  assert.equal(state.body.data.completedSteps, 1);

  // 已完成任务不可取消
  const doneJob = await createJob({ holes: [{ lane: 1, position: 1 }] });
  await report(doneJob.id, { seq: 1 });
  const cancelDone = await api("POST", `/punch-jobs/${doneJob.id}/cancel`);
  assert.equal(cancelDone.status, 409);
});

test("重启:计划和进度一致,可继续回报与重试", async () => {
  const job = await createJob({
    holes: [
      { lane: 1, position: 1 },
      { lane: 2, position: 2 },
      { lane: 3, position: 3 }
    ]
  });
  await report(job.id, { seq: 1 });
  await report(job.id, { seq: 2, result: "failed" });

  const planBefore = await api("GET", `/punch-jobs/${job.id}/plan`);
  const progressBefore = await progress(job.id);
  assert.equal(progressBefore.body.data.completedSteps, 1);
  assert.equal(progressBefore.body.data.failedSteps, 1);

  await stopServer();
  await startServer();

  const planAfter = await api("GET", `/punch-jobs/${job.id}/plan`);
  const progressAfter = await progress(job.id);
  assert.deepEqual(planAfter.body.data, planBefore.body.data, "重启后计划一致");
  assert.deepEqual(progressAfter.body.data, progressBefore.body.data, "重启后进度一致");

  const retry = await report(job.id, { seq: 2, result: "ok" });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.nextSeq, 3);
  const finish = await report(job.id, { seq: 3 });
  assert.equal(finish.body.data.status, "completed");
});

test("并行:并发重复回报只执行一次,不重复不跳步", async () => {
  const job = await createJob({
    holes: [
      { lane: 1, position: 1 },
      { lane: 2, position: 2 },
      { lane: 3, position: 3 }
    ]
  });

  // 5 个并发相同回报:恰好应用一次
  const round1 = await Promise.all(Array.from({ length: 5 }, () => report(job.id, { seq: 1 })));
  assert.ok(round1.every((r) => r.status === 200));
  assert.equal(round1.filter((r) => !r.body.deduplicated).length, 1, "只能有一个回报真正执行");
  let now = await progress(job.id);
  assert.equal(now.body.data.completedSteps, 1);
  assert.equal(now.body.data.nextSeq, 2);

  // 再并发一轮下一步:仍然只前进一格,不跳步
  const round2 = await Promise.all(Array.from({ length: 3 }, () => report(job.id, { seq: 2 })));
  assert.ok(round2.every((r) => r.status === 200));
  now = await progress(job.id);
  assert.equal(now.body.data.completedSteps, 2);
  assert.equal(now.body.data.nextSeq, 3);

  // 并发中混入缺步回报:被拒绝且不改变状态
  const mixed = await Promise.all([report(job.id, { seq: 3 }), report(job.id, { seq: 99 })]);
  const statuses = mixed.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409]);
  now = await progress(job.id);
  assert.equal(now.body.data.completedSteps, 3);
  assert.equal(now.body.data.status, "completed");
});
