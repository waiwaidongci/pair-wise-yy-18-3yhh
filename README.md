# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

SQLite数据库文件会在首次启动时创建到`data/app.db`。

## 补妆复核流程

同剧目补妆的色差控制：登记即判定，不合格先转待复检；干燥满四小时后由另一名化妆师复看，通过才恢复可演出。

代码按职责分三个业务文件：

- `repaint/routes.js` — 请求入口（登记、复看、变更、查询）
- `repaint/judgment.js` — 判定规则（纯函数）
- `repaint/archive.js` — 档案（补妆单与留档持久化、偶头档案联动）

剧目色号标准、油漆批次有效期、干燥阈值（240分钟）、试灯偏差上限（2级）配置在 `project.config.js` 的 `repaint` 段。

### 接口

- `POST /api/repaint/requests` 补妆登记：偶头、剧目、色号、批次、干燥分钟、试灯值、登记人。色号不符合剧目标准、批次过期或试灯偏差超过2级时，状态为`待复检`，否则为`待复看`；登记后偶头转为`修补中`不可演出。
- `POST /api/repaint/requests/:id/review` 复看：须为另一名化妆师且干燥满240分钟，`pass:true` 后状态`已通过`，偶头恢复`可演出`；不通过转回`待复检`。
- `POST /api/repaint/requests/:id/change` 变更：更换色号或批次会让旧结论失效，原值留档后重新判定；`已通过`的补妆单不可再变更。
- `GET /api/repaint/requests?status=待复检` 按状态/偶头/剧目查询。
- `GET /api/repaint/requests/:id/archives` 查看全部留档（登记判定、复看结论、变更失效原值）。
