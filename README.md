# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

SQLite 优先使用系统 `sqlite3` CLI；若环境中没有该命令，自动回退到
`sql.js`（WASM）并在每次写操作后落盘到 `data/app.db`。

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

## 补妆复核流程

解决“同剧目补妆后色差、只看偶头编号直到登台才发现两只武生色调不同”的问题。
补妆不再直接恢复可演出，必须经过“初判 → 满四小时另一人复看”两步。

代码按三个业务文件拆分：

| 文件 | 职责 |
| --- | --- |
| `makeupRoutes.js` | 请求入口：HTTP 路由、参数校验、装配偶头主档服务 |
| `makeupRules.js` | 判定：剧目色号标准、批次过期、试灯偏差、复看资格（纯函数） |
| `makeupArchive.js` | 档案：复核档案/油漆批次表读写、旧结论留档失效、偶头状态联动 |

### 状态流转

1. 化妆师油漆时登记 `偶头、剧目、行当、色号、批次、干燥分钟、试灯值、补妆人`。
2. 系统初判，命中任一条即转 **待复检**，否则为 **待复看**：
   - 色号不符合剧目（+行当）标准；
   - 油漆批次已过期（到期当天即过期）或批次色号与登记色号不符；
   - 试灯值相对剧目基准偏差 **超过 2 级**。
3. **另一名化妆师**（不得与补妆人同一人）在干燥 **满 240 分钟** 后复看：
   - 通过：档案置「已通过」，偶头恢复 **可演出**；
   - 不通过：维持 **待复检**。
4. 同一偶头再次补妆时，若 **色号或批次发生变化**，旧结论（含已通过）
   立即置「已失效」并完整留档（原值、原批次、复看人都保留）；同色同批的
   未结档案置「已覆盖」留档。待复检/待复看期间偶头一律不可演出。

### 接口

- `POST /api/makeupReviews` 补妆登记（自动初判）
  ```json
  {
    "puppetHeadId": "head-seed-2",
    "play": "火焰山", "role": "武生",
    "colorNo": "WH-12", "batch": "P2026-01",
    "dryMinutes": 30, "lampValue": 3,
    "painter": "陈妆"
  }
  ```
- `POST /api/makeupReviews/:id/recheck` 复看结论
  ```json
  { "reviewer": "林妆", "pass": true, "dryMinutes": 240, "note": "无色差" }
  ```
- `GET /api/makeupReviews?status=&puppetHeadId=&active=1` 当前档案
- `GET /api/makeupReviews/archive` 历史留档（失效/覆盖/通过的原值）
- `GET /api/paintBatches` / `POST /api/paintBatches` 油漆批次档案
- `GET /api/makeupStandards?play=火焰山` 剧目色号与试灯基准（只读）

登记后可通过 `GET /api/puppetHeads/:id/timeline` 看到补妆登记、复看结论等
事件，偶头主档状态随复核流程自动联动。

SQLite数据库文件会在首次启动时创建到`data/app.db`。
