# dsh-honey-guard

[DeepSeek Harness](https://github.com/) (DSH) 的蜜罐脱敏插件——在敏感值离开你的机器之前，把它们换成结构合法的假值（Honey-Token），模型、会话文件、日志里见到的全是假货。

## 它做什么

**全自动，装上即生效**：插件挂载 DSH 的 `agent/pre-step` 与 `tools/post-execute` 事件，对每一条出站消息（用户输入、模型思考、工具调用参数）做模式扫描，命中即替换：

| 检测器 | 识别 |
| --- | --- |
| `sk-` + 48 位 | OpenAI / DeepSeek 类 key |
| `AKIA` + 16 位 | AWS Access Key ID |
| `ghp_` / `github_pat_` | GitHub token |
| `Bearer ` 后长 token | 请求头凭证 |
| `-----BEGIN PRIVATE KEY-----` | PEM 私钥 |

替换是**确定性的**：同一会话内同一真实值永远映射到同一蜜罐（模型不会看到两个名字），跨会话不可关联（两份脱敏记录无法被外部比对出用了同一凭证）。蜜罐结构合法——模型拿到 `sk-` 开头的假 key 不会起疑，只会得到一次正常的认证失败。

## 显式还原与手动标记

入站自动还原是**刻意不做**的：还原出的真值下一轮就会被模型再次看到，等于白脱敏。还原与扩展标记走显式工具：

| 工具 | 用途 |
| --- | --- |
| `honey_mark` | 把检测器认不出的值（内部 token、私有 key 格式）标记为敏感 |
| `honey_restore` | 把蜜罐还原成真实值写回会话记录——用户可见，模型不可见（下一轮重新脱敏） |
| `honey_stats` | 值安全的聚合统计（映射数 / 替换数 / 还原数 / 金丝雀状态） |

另有 **Canary Trap**：每个会话惰性注册一个永不参与替换的"死蜜罐"，在其他会话的文本里出现即告警——说明有记录被跨会话搬运。

## 日志

默认只走 `ctx.logger`：dsh-desktop 对 `info` 级没有任何 UI 或文件出口，只有 `warn`（金丝雀命中、装配失败）会以系统通知弹出。想在机器上留下逐条记录，打开落盘开关：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: honey-guard
  name: dsh-honey-guard
  config:
    logFile: true
    logFileMaxMb: 5   # 超过这个大小滚一份 .1
```

之后每次替换都会往 `~/.dsh/honey-guard/substitutions.jsonl` 追加一行 JSON：

```json
{"time":"2026-10-27T01:00:00.000Z","surface":"pre-step","total":2,"hits":{"openai_key":1,"custom":1}}
{"time":"2026-10-27T01:00:03.000Z","surface":"tool ops_bash","canary":"AKIA…","sourceScope":"agent-1","currentScope":"agent-2"}
```

字段只有 surface、类别计数和金丝雀 id——**真实值与蜜罐全文都不写**，与日志同一条值安全约定。插件启动时另写一行 `"surface":"activate"`，用来证明这一轮它确实被装配上了。目录不可写时落盘静默停用，不影响脱敏本身。

## 安装

```powershell
dsh plugin --profile desktop add "file:<本项目路径>"
```

或手动放入 profile 的 `node_modules` 并在 `dsh.profile.bundles` 登记。构建与校验：

```powershell
pnpm install
pnpm run check   # typecheck + vitest + tsdown build
```

## 架构要点

- **Admission-time 替换**：出站脱敏发生在消息进入会话之前（`agent/pre-step` 返回的批次即入会内容），因此会话文件从源头就是蜜罐。
- **区间合并替换**：检测器区间与手动标记区间先对原文合并（重叠跳过、长值优先），再一次性 cursor 拼接——蜜罐永不进入被扫描文本。
- **每会话独立映射**：`WeakMap<agent, scope>` 按 agent 对象分桶，被回收自动清理；映射表纯内存，不落盘。
- **值安全**：日志、统计、审计事件（`honey/restored`）均不含真实值或蜜罐值。

## License

MIT
