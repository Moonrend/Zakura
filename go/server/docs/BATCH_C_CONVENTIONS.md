# 批次 C：runtime SQL→GORM 转换规范

目标包：`go/server/internal/runtime`（module `github.com/Moonrend/Zakura/go/server`，工作目录 `/opt/zakura-dev/Zakura/go/server`）。

连接层：`appdeps.Dependencies.Gorm`（*gorm.DB），打开时用
`gorm.Config{NamingStrategy: schema.NamingStrategy{NoLowerCase: true}}`。
SQLite 与 PostgreSQL 共用同一 gorm 句柄；占位符一律用 `?`（gorm 驱动自行处理），
**不再** 需要 `s.q()` / `Rebind`。

## 已转换参考样例（务必先读，保持同风格）

- `internal/runtime/network.go`（`nodeAgg` 聚合、`mesh` Take、RowsAffected 用法）
- `internal/runtime/zakurabot_app.go`（Table+Joins+Select 扫描、Exec 造 binding）
- `internal/runtime/skills.go`（Raw 多表 JOIN 扫描 + column tag）
- `internal/runtime/workspace.go` / `workspace_misc.go`（已转换的 handler 模式）

## 转换规则（逐条等价改写，语义不变）

1. **只改 SQL 存取**：`s.deps.DB.QueryContext/QueryRowContext/ExecContext` + `s.q(...)`
   → `s.deps.Gorm.WithContext(ctx)` 链式调用；handler 侧用 `h.deps.Gorm`。
   查询语句照抄列名/条件/ORDER BY，不重构逻辑。
2. **扫描 struct 必须全部字段带 tag**：`gorm:"column:xxx"`（NoLowerCase 策略下
   无 tag 会静默扫成零值）。每个结果 struct 的每个导出字段都要有 column tag。
3. **聚合/表达式列必须加别名**：`SUM(x) AS x`、`COUNT(*) AS total`，别名与字段
   tag 对应。
4. **时间戳列是 TEXT（RFC3339Nano）**：gorm 扫描目标（带 column tag 的 struct 字段）
   **不要用 `flexibleTime`** —— `flexibleTime.Scan` 是指针接收者，gorm schema 解析时
   用**值类型**判断 Scanner，识别不到就会把它当 relation 处理，直接报
   `invalid field found for struct ...: define a valid foreign key for relations or
   implement the Valuer/Scanner interface`。正确做法：扫成 `string` 字段（tag 照加），
   转换处用 `parseTime(s)`（`automation.go` 中已有，支持 RFC3339Nano/RFC3339/
   `2006-01-02 15:04:05`）解析成 `time.Time`。`flexibleTime` 仅可用于
   database/sql 位置参数扫描（`rows.Scan(&c, &u flexibleTime)` —— 传入的是指针，
   database/sql 能正确调用 `(*flexibleTime).Scan`），这类位置扫描随 Phase 5 收敛。
5. **NotFound 语义**：`sql.ErrNoRows` → `errors.Is(err, gorm.ErrRecordNotFound)`，
   映射保持不变（原来返回 ErrNotFound 的仍返回 ErrNotFound；handler 里
   `statusErr(w, ErrNotFound)` 的照旧）。
6. **RowsAffected**：`gorm.DB` 结果的 `.RowsAffected` 字段（不是方法）。
   `res := g.Where(...).Delete(&models.X{}); res.RowsAffected == 0` 语义同前。
7. **写操作**：优先 `.Table("x").Create(map[string]any{...})` / `.Updates` /
   `.Delete` / `.Model(&models.X{}).Where(...).Update...`；动态拼 SET 列的 UPDATE
   可以继续拼 SQL 后用 `.Exec(sql, args...)`（等价即可）。ON CONFLICT/upsert
   等方言特化语句如果不确定等价，**保留 gorm.Raw/Exec 原语句**（逃生舱，Phase 5 再收敛），
   但把 `s.q(` 换成直接字符串。
8. **InTx 事务块（`appdeps.InTx(ctx, s.deps.DB, func(tx *sql.Tx)...`）整段跳过不改**，
   块内的 `tx.ExecContext/tx.QueryRowContext` 保持原样（Phase 4 处理）。
   `*sql.Tx` 类型引用与 `database/sql` import 因此必须保留。
9. **JSON 列**：原来 `SELECT config_json` 扫到 string 再 `json.RawMessage(...)`
   的模式照搬（扫描字段 string + tag，转换后再包 RawMessage）。
10. **NULL 列**：保持原来的 `*string`/`sql.NullString` 语义（gorm 扫描支持指针字段）。
11. **布尔列**：SQLite/PG 都是 INTEGER 0/1，扫到 bool 没问题（gorm 驱动已处理）。
12. **事务外不要引入新依赖**；不新增文件；不改路由、不改 JSON 响应形状、不改测试。
13. **守卫**：`Take` 单条语义（原来 QueryRowContext 的）用 `.Take(&row)`；列表用
    `.Find(&rows)`；`LIMIT`/`OFFSET` 照抄。

## 验证（批次进行中）

- 只允许 `gofmt -l` 检查自己改的文件、`gofmt -e` 校验语法；**不要**运行
  `go build`/`go test`（其它文件正被并行修改，会误报）。
- 结束时报告：每条 SQL 的转换方式一览（转成 gorm 链式 / 保留 Raw 逃生舱+原因 /
  InTx 块保留条数），以及任何不确定点。
