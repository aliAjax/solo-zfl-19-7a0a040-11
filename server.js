const http = require("http");
const { readFile, writeFile, rename, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3019);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");

const initialData = {
  tunes: [
    {
      id: "tune_demo",
      title: "雨后圆舞曲",
      composer: "匿名",
      stripSpec: {
        widthMm: 70,
        scale: "20音",
        tempoBpm: 82,
        paperType: "半透明纸带"
      },
      createdAt: new Date().toISOString()
    }
  ],
  sections: [
    {
      id: "section_demo_1",
      tuneId: "tune_demo",
      startBeat: 1,
      endBeat: 32,
      laneRange: "1-10",
      checked: true,
      note: "开头主题已试奏"
    },
    {
      id: "section_demo_2",
      tuneId: "tune_demo",
      startBeat: 33,
      endBeat: 64,
      laneRange: "4-18",
      checked: false,
      note: "副歌段等待校对"
    }
  ],
  issues: [
    {
      id: "issue_demo",
      tuneId: "tune_demo",
      sectionId: "section_demo_2",
      type: "漏孔",
      beat: 41,
      lane: 12,
      description: "第41拍高音孔漏打",
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    }
  ],
  punchJobs: []
};

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "PATCH /sections/:id/check",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /punch-jobs",
  "POST /punch-jobs",
  "GET /punch-jobs/:id",
  "GET /punch-jobs/:id/plan",
  "GET /punch-jobs/:id/progress",
  "POST /punch-jobs/:id/reports",
  "POST /punch-jobs/:id/cancel"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeDb(initialData);
  }
}

async function readDb() {
  await ensureDb();
  const data = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (!Array.isArray(data.punchJobs)) data.punchJobs = [];
  return data;
}

// 先写临时文件再原子重命名:并发读永远不会遇到写了一半的文件
let writeCounter = 0;
async function writeDb(data) {
  const tmp = `${DB_FILE}.${process.pid}.${writeCounter++}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, DB_FILE);
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) {
    const error = new Error("曲目不存在");
    error.status = 404;
    throw error;
  }
  return tune;
}

function buildProgress(db, tuneId) {
  findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0
  };
}

// ---------- 打孔执行编排 ----------

const PUNCH_RESULT_OK = new Set(["ok", "success", "completed", "done"]);
const PUNCH_RESULT_FAILED = new Set(["failed", "failure", "error"]);

// 所有打孔任务的写操作串行化:并行回报不会重复执行,也不会跳过步骤
let punchQueue = Promise.resolve();
function withPunchLock(fn) {
  const run = punchQueue.then(() => fn());
  punchQueue = run.catch(() => {});
  return run;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function toLane(value, field) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw httpError(400, `${field}必须是正整数轨号`);
  }
  return value;
}

function toPosition(value, field) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw httpError(400, `${field}必须是非负整数行程`);
  }
  return value;
}

function findPunchJob(db, jobId) {
  const job = db.punchJobs.find((item) => item.id === jobId);
  if (!job) throw httpError(404, "打孔任务不存在");
  return job;
}

function buildConflictMap(conflictPairs) {
  const map = new Map();
  for (const [a, b] of conflictPairs) {
    if (!map.has(a)) map.set(a, new Set());
    if (!map.has(b)) map.set(b, new Set());
    map.get(a).add(b);
    map.get(b).add(a);
  }
  return map;
}

function lanesConflict(conflictMap, a, b) {
  return conflictMap.has(a) && conflictMap.get(a).has(b);
}

// 在 g 个分组内按轨号升序首次适配回溯,结果确定:同一步数下轨号小的优先进入靠前的行程
function assignLanes(lanes, index, groups, conflictMap, maxPerStroke) {
  if (index === lanes.length) return groups.map((group) => [...group]);
  const lane = lanes[index];
  for (const group of groups) {
    if (group.length >= maxPerStroke) continue;
    if (group.some((other) => lanesConflict(conflictMap, lane, other))) continue;
    group.push(lane);
    const result = assignLanes(lanes, index + 1, groups, conflictMap, maxPerStroke);
    if (result) return result;
    group.pop();
    if (group.length === 0) break; // 空组互相等价,剪枝
  }
  return null;
}

// 单个行程位置的最少分组:从下限递增尝试,第一个可行解即最少冲压步数
function minStrokeGroups(lanes, conflictMap, maxPerStroke) {
  const sorted = [...lanes].sort((a, b) => a - b);
  if (!sorted.length) return [];
  const lowerBound = Math.max(1, Math.ceil(sorted.length / maxPerStroke));
  for (let g = lowerBound; g <= sorted.length; g++) {
    const groups = Array.from({ length: g }, () => []);
    const result = assignLanes(sorted, 0, groups, conflictMap, maxPerStroke);
    if (result) return result.filter((group) => group.length > 0);
  }
  return sorted.map((lane) => [lane]); // 不可达:单孔一组必然可行
}

// 生成冲压计划:纸带单向前进(行程升序),同一行程内冲突轨不共存,每孔只出现一次
function buildPunchPlan(holes, conflictPairs, maxPerStroke) {
  const conflictMap = buildConflictMap(conflictPairs);
  const byPosition = new Map();
  for (const hole of holes) {
    if (!byPosition.has(hole.position)) byPosition.set(hole.position, []);
    byPosition.get(hole.position).push(hole.lane);
  }
  const positions = [...byPosition.keys()].sort((a, b) => a - b);
  const steps = [];
  for (const position of positions) {
    for (const group of minStrokeGroups(byPosition.get(position), conflictMap, maxPerStroke)) {
      steps.push({ seq: steps.length + 1, position, lanes: group, status: "pending", failureCount: 0 });
    }
  }
  return steps;
}

function punchProgress(job) {
  const totalSteps = job.steps.length;
  const completedSteps = job.steps.filter((step) => step.status === "done").length;
  const failedSteps = job.steps.filter((step) => step.status === "failed").length;
  const releasedSteps = job.steps.filter((step) => step.status === "released").length;
  return {
    jobId: job.id,
    tuneId: job.tuneId,
    status: job.status,
    totalSteps,
    completedSteps,
    failedSteps,
    releasedSteps,
    nextSeq: job.nextSeq > totalSteps ? null : job.nextSeq,
    percent: totalSteps ? Math.round((completedSteps / totalSteps) * 100) : 100
  };
}

function normalizeReports(body) {
  if (body && body.reports !== undefined && !Array.isArray(body.reports)) {
    throw httpError(400, "reports 必须是数组");
  }
  const list = Array.isArray(body && body.reports) ? body.reports : [body];
  if (!list.length) throw httpError(400, "回报内容不能为空");
  return list.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw httpError(400, `第 ${index + 1} 条回报格式错误`);
    if (typeof item.seq !== "number" || !Number.isInteger(item.seq) || item.seq < 1) {
      throw httpError(400, `第 ${index + 1} 条回报的 seq 必须是正整数`);
    }
    const seq = item.seq;
    const rawResult = String(item.result === undefined ? "ok" : item.result).toLowerCase();
    let result;
    if (PUNCH_RESULT_OK.has(rawResult)) result = "ok";
    else if (PUNCH_RESULT_FAILED.has(rawResult)) result = "failed";
    else throw httpError(400, `第 ${index + 1} 条回报的 result 只能是 ok 或 failed`);
    const report = { seq, result };
    if (item.position !== undefined) {
      report.position = toPosition(item.position, `第 ${index + 1} 条回报的行程`);
    }
    if (item.lanes !== undefined) {
      if (!Array.isArray(item.lanes) || !item.lanes.length) throw httpError(400, `第 ${index + 1} 条回报的 lanes 必须是非空数组`);
      report.lanes = item.lanes.map((lane) => toLane(lane, "回报轨号")).sort((a, b) => a - b);
    }
    return report;
  });
}

async function handleCreatePunchJob(req, res) {
  const body = await parseBody(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "请求体必须是包含 tuneId、holes、pins、maxPunchesPerStroke 的JSON对象");
  }
  required(body, ["tuneId", "holes", "pins", "maxPunchesPerStroke"]);
  return withPunchLock(async () => {
    const db = await readDb();
    findTune(db, body.tuneId);

    if (!Array.isArray(body.pins) || !body.pins.length) throw httpError(400, "pins 必须是非空轨号数组");
    const pins = [...new Set(body.pins.map((pin) => toLane(pin, "冲针轨号")))].sort((a, b) => a - b);
    const pinSet = new Set(pins);

    const maxPerStroke = body.maxPunchesPerStroke;
    if (typeof maxPerStroke !== "number" || !Number.isInteger(maxPerStroke) || maxPerStroke < 1) {
      throw httpError(400, "maxPunchesPerStroke 必须是正整数");
    }

    if (!Array.isArray(body.holes) || !body.holes.length) throw httpError(400, "holes 必须是非空孔位数组");
    const seen = new Set();
    const holes = [];
    for (const raw of body.holes) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw httpError(400, "孔位必须是包含 lane 和 position 的对象");
      }
      const lane = toLane(raw.lane, "孔位轨号");
      const position = toPosition(raw.position, "孔位行程");
      if (!pinSet.has(lane)) throw httpError(400, `轨 ${lane} 没有可用冲针`);
      const key = `${lane}:${position}`;
      if (seen.has(key)) continue; // 同一孔不能重复:去重
      seen.add(key);
      holes.push({ lane, position });
    }
    holes.sort((a, b) => a.position - b.position || a.lane - b.lane);

    if (body.conflictPairs !== undefined && !Array.isArray(body.conflictPairs)) {
      throw httpError(400, "conflictPairs 必须是轨号对数组");
    }
    const conflictPairs = (body.conflictPairs ?? []).map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) throw httpError(400, "conflictPairs 必须是轨号对数组");
      const a = toLane(pair[0], "冲突轨号");
      const b = toLane(pair[1], "冲突轨号");
      if (a === b) throw httpError(400, "冲突轨对的两个轨号不能相同");
      return [a, b];
    });

    const steps = buildPunchPlan(holes, conflictPairs, maxPerStroke);
    const now = new Date().toISOString();
    const job = {
      id: makeId("punch"),
      tuneId: body.tuneId,
      pins,
      maxPunchesPerStroke: maxPerStroke,
      conflictPairs,
      holes,
      totalHoles: holes.length,
      steps,
      status: "pending",
      nextSeq: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      cancelledAt: null
    };
    db.punchJobs.push(job);
    await writeDb(db);
    return send(res, 201, { data: { ...job, progress: punchProgress(job) } });
  });
}

// 重复回报判定:步骤已执行过(已完成;或已失败步骤再次回报相同失败结果)
function isDuplicateReport(job, report) {
  const step = job.steps[report.seq - 1];
  if (!step) return false;
  if (report.seq < job.nextSeq) return true;
  return report.seq === job.nextSeq && step.status === "failed" && report.result === "failed";
}

async function handlePunchReport(req, res, jobId) {
  const body = await parseBody(req);
  const reports = normalizeReports(body);
  return withPunchLock(async () => {
    const db = await readDb();
    const job = findPunchJob(db, jobId);
    const totalSteps = job.steps.length;

    // 所报步骤必须存在
    for (const report of reports) {
      if (report.seq > totalSteps) throw httpError(409, `步骤 ${report.seq} 不存在,任务共 ${totalSteps} 步`);
    }

    // 任何回报只要与计划不符(行程/轨位)都是冲突错误——包括已执行步骤的再次回报
    for (const report of reports) {
      const step = job.steps[report.seq - 1];
      if (report.position !== undefined && report.position !== step.position) {
        throw httpError(409, `回报与计划冲突:步骤 ${report.seq} 的行程应为 ${step.position},收到 ${report.position}`);
      }
      if (report.lanes !== undefined && JSON.stringify(report.lanes) !== JSON.stringify(step.lanes)) {
        throw httpError(409, `回报与计划冲突:步骤 ${report.seq} 的轨位应为 [${step.lanes.join(",")}]`);
      }
    }

    // 重复回报:全部指向已执行步骤 → 返回原进度,不改状态(失败次数不重复累计)
    if (reports.every((report) => isDuplicateReport(job, report))) {
      return send(res, 200, { data: punchProgress(job), deduplicated: true, message: "重复回报,返回当前进度" });
    }

    if (job.status === "cancelled") throw httpError(409, "任务已取消,后续步骤已释放");
    if (job.status === "completed") throw httpError(409, "任务已完成");

    // 连续性校验:必须从 nextSeq 开始连续;任何错误都不改状态
    let expected = job.nextSeq;
    let failedSeen = false;
    for (const report of reports) {
      if (isDuplicateReport(job, report)) throw httpError(409, `步骤 ${report.seq} 已执行,属于乱序回报`);
      if (failedSeen) throw httpError(409, "失败步骤之后的步骤不能在同一批次回报");
      if (report.seq < expected) throw httpError(409, `步骤 ${report.seq} 已执行,属于乱序回报`);
      if (report.seq > expected) throw httpError(409, `缺步:期望步骤 ${expected},收到 ${report.seq}`);
      if (report.result === "failed") failedSeen = true;
      expected += 1;
    }

    const now = new Date().toISOString();
    for (const report of reports) {
      const step = job.steps[report.seq - 1];
      if (report.result === "ok") {
        step.status = "done";
        step.completedAt = now;
        job.nextSeq = report.seq + 1;
      } else {
        step.status = "failed"; // 进度不变,失败步骤可从原进度重试
        step.failureCount = (step.failureCount || 0) + 1;
        step.lastFailedAt = now;
      }
    }
    if (job.nextSeq > totalSteps) {
      job.status = "completed";
      job.completedAt = now;
    } else {
      job.status = "in_progress";
    }
    job.updatedAt = now;
    await writeDb(db);
    return send(res, 200, { data: punchProgress(job), applied: reports.length });
  });
}

async function handlePunchCancel(req, res, jobId) {
  return withPunchLock(async () => {
    const db = await readDb();
    const job = findPunchJob(db, jobId);
    if (job.status === "cancelled") {
      return send(res, 200, { data: { ...job, progress: punchProgress(job) }, message: "任务已处于取消状态" });
    }
    if (job.status === "completed") throw httpError(409, "任务已完成,无法取消");
    const now = new Date().toISOString();
    job.status = "cancelled";
    job.cancelledAt = now;
    job.updatedAt = now;
    for (const step of job.steps) {
      if (step.status !== "done") step.status = "released"; // 取消释放后续步骤
    }
    await writeDb(db);
    return send(res, 200, { data: { ...job, progress: punchProgress(job) } });
  });
}

async function handle(req, res) {
  const { pathname, searchParams } = parseUrl(req);
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
  }

  if (req.method === "GET" && pathname === "/tunes") {
    const tunes = db.tunes.map((tune) => ({ ...tune, progress: buildProgress(db, tune.id) }));
    return send(res, 200, { data: tunes });
  }

  if (req.method === "POST" && pathname === "/tunes") {
    const body = await parseBody(req);
    required(body, ["title", "stripSpec"]);
    const tune = {
      id: makeId("tune"),
      title: body.title,
      composer: body.composer || "",
      stripSpec: body.stripSpec,
      createdAt: new Date().toISOString()
    };
    db.tunes.push(tune);
    await writeDb(db);
    return send(res, 201, { data: tune });
  }

  const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
  if (tuneSectionsMatch && req.method === "GET") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId) });
  }

  if (tuneSectionsMatch && req.method === "POST") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    const body = await parseBody(req);
    required(body, ["startBeat", "endBeat", "laneRange"]);
    const section = {
      id: makeId("section"),
      tuneId,
      startBeat: Number(body.startBeat),
      endBeat: Number(body.endBeat),
      laneRange: body.laneRange,
      checked: Boolean(body.checked),
      note: body.note || ""
    };
    db.sections.push(section);
    await writeDb(db);
    return send(res, 201, { data: section });
  }

  const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
  if (uncheckedMatch && req.method === "GET") {
    const tuneId = uncheckedMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId && !item.checked) });
  }

  const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
  if (progressMatch && req.method === "GET") {
    return send(res, 200, { data: buildProgress(db, progressMatch[1]) });
  }

  const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (checkMatch && req.method === "PATCH") {
    const section = db.sections.find((item) => item.id === checkMatch[1]);
    if (!section) return send(res, 404, { error: "区间不存在" });
    const body = await parseBody(req);
    section.checked = body.checked !== undefined ? Boolean(body.checked) : true;
    section.note = body.note ?? section.note;
    await writeDb(db);
    return send(res, 200, { data: section });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const issues = db.issues.filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status));
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description"]);
    findTune(db, body.tuneId);
    const section = db.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
    if (!section) return send(res, 400, { error: "区间不存在或不属于该曲目" });
    const issue = {
      id: makeId("issue"),
      tuneId: body.tuneId,
      sectionId: body.sectionId,
      type: body.type,
      beat: body.beat === undefined ? null : Number(body.beat),
      lane: body.lane === undefined ? null : Number(body.lane),
      description: body.description,
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };
    db.issues.push(issue);
    await writeDb(db);
    return send(res, 201, { data: issue });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const issue = db.issues.find((item) => item.id === issueStatusMatch[1]);
    if (!issue) return send(res, 404, { error: "问题不存在" });
    const body = await parseBody(req);
    required(body, ["status"]);
    issue.status = body.status;
    issue.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
    issue.note = body.note ?? issue.note;
    await writeDb(db);
    return send(res, 200, { data: issue });
  }

  if (req.method === "POST" && pathname === "/punch-jobs") {
    return handleCreatePunchJob(req, res);
  }

  if (req.method === "GET" && pathname === "/punch-jobs") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const jobs = db.punchJobs
      .filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status))
      .map((job) => ({ ...job, progress: punchProgress(job) }));
    return send(res, 200, { data: jobs });
  }

  const punchPlanMatch = pathname.match(/^\/punch-jobs\/([^/]+)\/plan$/);
  if (punchPlanMatch && req.method === "GET") {
    const job = findPunchJob(db, punchPlanMatch[1]);
    return send(res, 200, { data: job.steps });
  }

  const punchProgressMatch = pathname.match(/^\/punch-jobs\/([^/]+)\/progress$/);
  if (punchProgressMatch && req.method === "GET") {
    const job = findPunchJob(db, punchProgressMatch[1]);
    return send(res, 200, { data: punchProgress(job) });
  }

  const punchReportMatch = pathname.match(/^\/punch-jobs\/([^/]+)\/reports$/);
  if (punchReportMatch && req.method === "POST") {
    return handlePunchReport(req, res, punchReportMatch[1]);
  }

  const punchCancelMatch = pathname.match(/^\/punch-jobs\/([^/]+)\/cancel$/);
  if (punchCancelMatch && req.method === "POST") {
    return handlePunchCancel(req, res, punchCancelMatch[1]);
  }

  const punchJobMatch = pathname.match(/^\/punch-jobs\/([^/]+)$/);
  if (punchJobMatch && req.method === "GET") {
    const job = findPunchJob(db, punchJobMatch[1]);
    return send(res, 200, { data: { ...job, progress: punchProgress(job) } });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
