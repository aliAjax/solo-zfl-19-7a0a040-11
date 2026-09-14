# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间和试奏问题。

## 启动

```bash
PORT=3019 node server.js
```

## 主要接口

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`

## 打孔执行编排

- `POST /punch-jobs` — 创建打孔任务并生成冲压计划
- `GET /punch-jobs?tuneId=&status=` — 任务列表(含进度)
- `GET /punch-jobs/:id` — 任务详情
- `GET /punch-jobs/:id/plan` — 冲压计划(步骤列表)
- `GET /punch-jobs/:id/progress` — 执行进度
- `POST /punch-jobs/:id/reports` — 执行回报(单步或批量)
- `POST /punch-jobs/:id/cancel` — 取消任务,释放后续步骤

### 计划规则

- 入参:`tuneId`、`holes`(目标孔位 `[{lane, position}]`)、`pins`(可用冲针轨号)、`maxPunchesPerStroke`(单次冲压上限)、可选 `conflictPairs`(冲突轨对)
- 纸带单向前进:步骤按行程 position 升序;同一孔位去重,不会重复打孔
- 同一行程内冲突轨不同时触发,每步冲针数不超过上限
- 计划使用最少冲压步数;步数相同时按轨号、行程排序(结果确定)

### 回报规则

- 只接受从 `nextSeq` 开始的连续步骤;批量回报放在 `reports` 数组中
- 重复回报:返回 `200` 与原进度(`deduplicated: true`),不改状态;失败步骤的重复失败回报不重复计数
- 缺步、乱序、与计划冲突的回报:返回 `409` 及明确错误,不改状态;已执行步骤的再次回报若行程/轨位与计划冲突同样返回 `409`
- `result: "failed"`:步骤标记失败、进度不变,可从原进度重试
- 回报可携带 `position`/`lanes` 与计划交叉校验
- 并行回报串行处理,不会重复执行或跳过步骤;重启后计划与进度一致

### 参数校验

- `conflictPairs` 必须是轨号对数组(可缺省),否则返回 `400` 且不创建任务
- `lane`/`position`/`seq`/`maxPunchesPerStroke` 必须是 JSON 数值类型:空值、布尔、字符串一律 `400`,不做强转
- 非法入参在写入前拒绝,原有数据保持不变

### 示例

```bash
# 创建任务:轨1/2冲突,单次最多冲2针
curl -X POST http://127.0.0.1:3019/punch-jobs \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","pins":[1,2,3],"maxPunchesPerStroke":2,"conflictPairs":[[1,2]],
       "holes":[{"lane":1,"position":5},{"lane":2,"position":5},{"lane":3,"position":5}]}'

# 回报第1步成功 / 失败重试 / 取消
curl -X POST http://127.0.0.1:3019/punch-jobs/<jobId>/reports -d '{"seq":1,"result":"ok"}' -H 'Content-Type: application/json'
curl -X POST http://127.0.0.1:3019/punch-jobs/<jobId>/reports -d '{"seq":2,"result":"failed"}' -H 'Content-Type: application/json'
curl -X POST http://127.0.0.1:3019/punch-jobs/<jobId>/cancel
```

## 测试

```bash
node --test test/
```

覆盖:计划生成、冲突轨、幂等回报、乱序拒绝、失败重试、取消释放、重启一致、并行回报,以及原有接口回归。

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔"}'
```
