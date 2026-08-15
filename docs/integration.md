# 快说 · 会议归属与实时推送 集成文档

> 给需要对接的后端平台。读完这一份就能实现，不需要看客户端代码。
>
> 协议版本 `specVersion: "1.0"`

---

## 1. 这是什么

**快说**是一个跑在用户电脑本地的语音转写工具。语音识别全程在本机完成（SenseVoice / sherpa-onnx），**音频永远不出这台机器**——发给你的只有识别之后的文字。

它的会议模式会把一场会录成逐字稿，自动区分说话人。本文档描述的集成让这份逐字稿**能够归位到你平台上的某个项目**，并且**在会议进行中就实时送达**，而不是等散会。

你需要提供两个 HTTP 接口：

| | 接口 | 方向 | 作用 |
|---|---|---|---|
| **A** | 会议列表 | 快说 → 你（GET） | 用户开始录制前，从这里拉一份列表来选「这场录的是哪个会」 |
| **B** | 内容推送 | 快说 → 你（POST） | 每识别出一句实时推一次；会议结束再推一份完整记录 |

两个接口**都是可选的**，各自独立：

- 只配 B，不配 A → 照常推送，但每条消息都不带项目信息，你无法区分会议归属。
- 都配 → 用户开录前必须先选，之后每条消息都带 `project` 块。
- 都不配 → 快说就是个纯本地工具，不联网。

### 一次完整的会议长什么样

```
用户在控制台点「开始记录」
        │
        ├─► GET  接口A                          ← 你返回可选的会议/项目列表
        │        用户从列表里选一个
        │
        ├─► POST 接口B  event=meeting.segment   ← 第 1 句话（说完就到，通常 1~3 秒内）
        ├─► POST 接口B  event=meeting.segment   ← 第 2 句话
        ├─► POST 接口B  event=meeting.segment   ← …每句一次，严格按说出的顺序
        │
用户点「结束」
        └─► POST 接口B  event=meeting.completed ← 完整逐字稿 + 统计 + 说话人名单
```

---

## 2. 接口 A：会议列表（GET）

### 请求

```http
GET {你配置的地址}
Accept: application/json
{用户在设置里配置的自定义请求头，通常是 Authorization}
```

- 无 query 参数、无 body。
- 超时 **15 秒**。
- 需要鉴权就让用户在客户端「请求头」里填 `Authorization: Bearer xxx` 之类，会原样带上。

### 响应

**返回什么结构都可以。** 客户端不假设任何形状，由用户在设置里配置几条「点路径」把列表挖出来——因为每家平台的包装都不一样，写死任何一种就等于只支持一家。

要求只有三条：
1. HTTP **2xx**（非 2xx 一律视为失败）
2. body 是合法 **JSON**
3. 能通过配置的路径找到一个**数组**

配置项（用户在快说设置里填，你只需要告诉他们该填什么）：

| 配置项 | 含义 | 留空时 |
|---|---|---|
| 列表路径 | 到数组的点路径，如 `data.list` | 响应的根本身就是数组 |
| ID 字段 | 每项的唯一 id | 必填 |
| 名称字段 | 显示给用户看的名字 | 回退用 ID |
| **项目 ID 字段** | **推送时要带的项目 id**，支持嵌套如 `project.id` | **回退用 ID 字段** |
| 分组字段 | 选择列表里的分组标题，如 `project.name` | 不分组 |

> **「项目 ID 字段」留空即回退到 ID**，所以两种设计都能直接对接：
> - 你返回的是**项目列表** → 留空，项目 id 就是每项的 id
> - 你返回的是**会议列表、每个挂着所属项目** → 填 `project.id` 之类

### 例子

你返回：

```json
{
  "code": 0,
  "data": {
    "list": [
      { "meetingId": "m-1001", "meetingName": "周会", "project": { "id": "p-88", "name": "快说" } },
      { "meetingId": "m-1002", "meetingName": "技术评审", "project": { "id": "p-90", "name": "另一个项目" } }
    ]
  }
}
```

用户这样配：

```
列表路径      data.list
ID 字段       meetingId
名称字段      meetingName
项目 ID 字段  project.id
分组字段      project.name
```

用户在选择框里看到按 `快说` / `另一个项目` 分组的两条，选中「周会」之后，后续每条推送都会带：

```json
"project": { "id": "p-88", "name": "周会", "meetingId": "m-1001" }
```

### 约束与容错

- 最多取 **500** 条（选择器是给人看的，再多也没法选）。
- 取不到 id 的条目被跳过并计数；客户端设置页的「测试拉取」会显示「N 条里没有一条能取到 id」，方便排查映射配错。
- 接口挂了 / 超时 / 返回 HTML 登录页 → 客户端提示失败，并允许用户**不归属直接开录**。**列表接口不可用绝不会阻止用户录音。**

---

## 3. 接口 B：内容推送（POST）

一个地址收两种事件，用 body 里的 `event` 字段（以及 `X-Kuaishuo-Event` 头）区分。

### 请求头

```http
POST {你配置的地址}
Content-Type: application/json; charset=utf-8
User-Agent: kuaishuo/1.0.0
X-Kuaishuo-Event: meeting.segment          ← 与 body 的 event 一致
X-Kuaishuo-Delivery: 3f2b1c...             ← UUID，同一次投递的多次重试保持不变
X-Kuaishuo-Timestamp: 1786546586           ← Unix 秒
X-Kuaishuo-Signature: sha256=9a1f...       ← 仅当用户配置了密钥
{用户配置的自定义请求头}
```

> **`X-Kuaishuo-Delivery` 就是幂等键。** 重试用的是同一个值，请据此去重——网络超时后重试是正常路径，不是异常。

### 响应

- **2xx** = 成功。body 内容不解析，随便返回什么都行。
- **4xx** = 永久失败，**不会重试**（用于签名不对、路径不对、payload 拒收）。
- **5xx / 超时 / 连不上** = 临时失败，**会重试**（见下）。
- 超时 **20 秒**。

### 签名校验

配置了密钥时，签名算法：

```
signature = "sha256=" + HEX( HMAC-SHA256( secret, timestamp + "." + rawBody ) )
```

`timestamp` 是 `X-Kuaishuo-Timestamp` 的值（字符串），`rawBody` 是**原始请求体字节**——不要先反序列化再重新序列化，键顺序和空白会变。

时间戳绑进签名里是为了防重放：**建议拒收时间戳偏离当前时间几分钟以上的请求。**

Node.js：

```js
const crypto = require('crypto')

function verify(rawBody, headers, secret) {
  const ts = headers['x-kuaishuo-timestamp']
  const got = headers['x-kuaishuo-signature']
  if (!ts || !got) return false
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false      // 5 分钟
  const want = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')
  // 定长比较，避免计时侧信道
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))
}
```

Python：

```python
import hashlib, hmac, time

def verify(raw_body: bytes, headers, secret: str) -> bool:
    ts = headers.get('X-Kuaishuo-Timestamp')
    got = headers.get('X-Kuaishuo-Signature')
    if not ts or not got:
        return False
    if abs(time.time() - int(ts)) > 300:
        return False
    mac = hmac.new(secret.encode(), f'{ts}.'.encode() + raw_body, hashlib.sha256)
    return hmac.compare_digest('sha256=' + mac.hexdigest(), got)
```

---

## 4. 事件一：`meeting.segment`（实时逐句）

每识别出一句话推一次。

```json
{
  "event": "meeting.segment",
  "specVersion": "1.0",
  "meeting": {
    "id": "mt_20260812_211355_001",
    "title": "会议 2026/8/12 21:13:55",
    "startedAt": "2026-08-12T21:13:55.412+08:00"
  },
  "project": {
    "id": "p-88",
    "name": "周会",
    "meetingId": "m-1001"
  },
  "segment": {
    "i": 7,
    "at": "2026-08-12T21:15:27.903+08:00",
    "offsetMs": 92491,
    "durationMs": 1840,
    "speaker": "说话人1",
    "source": "system",
    "text": "这一版先不做灰度"
  },
  "source": {
    "app": "kuaishuo",
    "version": "1.0.0",
    "platform": "win32",
    "device": "DESKTOP-ABC123"
  }
}
```

### 字段含义

| 字段 | 类型 | 含义 |
|---|---|---|
| `meeting.id` | string | **快说本地**的会议 id，一场会内不变。用它把同一场会的所有 segment 串起来 |
| `meeting.title` | string | 会议标题，用户可改 |
| `meeting.startedAt` | string | 开始时间，**ISO 8601 带本地时区偏移**（不是 UTC `Z`） |
| `project` | object | **可能整个不存在**，见下 |
| `project.id` | string | 你的项目 id，来自接口 A 映射出的「项目 ID 字段」 |
| `project.name` | string? | 用户选中那一项的显示名。为空时不出现 |
| `project.meetingId` | string? | 用户选中那一项的 id（接口 A 的「ID 字段」）。为空时不出现 |
| `segment.i` | number | 这场会内的序号，**从 0 开始递增** |
| `segment.at` | string | 这句话说完的时刻 |
| `segment.offsetMs` | number | 相对会议开始的毫秒偏移，用来定位引用 |
| `segment.durationMs` | number | 这句音频的时长 |
| `segment.speaker` | string | 说话人标签，见下 |
| `segment.source` | string? | **只在值为 `"system"` 时出现**，表示这句来自系统声音（远程会议里对方的声音）。不出现 = 来自麦克风（房间里的人） |
| `segment.text` | string | 识别出的文字 |
| `source` | object | 哪台机器的哪个版本发出来的 |

> ### `project` 不存在意味着什么
>
> 用户没有配置接口 A，或者配置了但选择了「不归属」。这种情况下**整个 `project` 键不出现**——不是 `null`，也不是空对象。
>
> 请用「键在不在」来判断：`if ('project' in body)` / `if body.get('project')`。

### 说话人标签

`speaker` 是**字符串标签**，不是稳定 id：

- `我` — 已登记声纹的本人
- `说话人1` / `说话人2` / … — 按首次出现顺序编号
- `对方` — 关闭了「区分说话人」且这句来自系统声音时

用户可以在客户端把 `说话人1` 改名成 `张三`，改完**会同步重写这场会已有的所有段落**。所以：

- **同一场会内**，`speaker` 可以作为分组依据
- **跨会议**，同一个 `说话人1` 不代表同一个人

### 顺序与时序保证

- **严格按说出的顺序投递。** 客户端内部是一条串行链，第 N 句没有结果之前不会发第 N+1 句。你收到的 `segment.i` 一定是递增的（除非中间某句投递彻底失败，那一句会缺号）。
- 一句话说完到你收到，正常在 **1~3 秒**。
- **量级：一场一小时的会大约 300~600 次请求。** 请确保接口足够轻——它在用户说话的过程中被持续调用。

### 失败会怎样

实时这一路的重试是**短而有界**的：失败后 800ms 重试一次，再 2500ms 重试一次，仍然失败就**丢弃并计数**（客户端会显示「实时推送 42 成功 / 3 失败」）。

丢得起，是因为它不是最后一道保险：**逐字稿在识别出来的瞬间就已经落在用户本地磁盘上，会议结束时还会通过 `meeting.completed` 完整重推一次**（那一路是持久重投的）。

> 反过来说：**如果你只想要一份完整记录、不想被高频打扰，让用户在设置里关掉「实时逐句推送」即可**，只保留结束时的那一次。

---

## 5. 事件二：`meeting.completed`（结束时的完整记录）

会议结束时推一次，**在所有 `meeting.segment` 都投递完之后**。

```json
{
  "event": "meeting.completed",
  "specVersion": "1.0",
  "id": "mt_20260812_211355_001",
  "title": "会议 2026/8/12 21:13:55",
  "startedAt": "2026-08-12T21:13:55.412+08:00",
  "endedAt": "2026-08-12T22:04:11.007+08:00",
  "durationMs": 3015595,
  "source": { "app": "kuaishuo", "version": "1.0.0", "platform": "win32", "device": "DESKTOP-ABC123" },
  "stats": {
    "segments": 218,
    "chars": 9420,
    "speakers": 4,
    "speechMs": 1732000
  },
  "speakers": [
    { "id": "S1", "label": "我",      "segments": 96, "isOwner": true,  "channel": "mic" },
    { "id": "S2", "label": "说话人1", "segments": 61, "isOwner": false, "channel": "system" }
  ],
  "transcript": {
    "text": "我：我们先过一下进展\n说话人1：前端还差两个页面",
    "markdown": "# 会议 2026/8/12 21:13:55\n\n- 时间：…\n\n## 逐字稿\n\n**我** `00:00:12`　我们先过一下进展",
    "segments": [
      { "i": 0, "speaker": "我", "offsetMs": 12000, "durationMs": 1500, "at": "2026-08-12T21:14:07.412+08:00", "text": "我们先过一下进展" },
      { "i": 1, "speaker": "说话人1", "offsetMs": 21000, "durationMs": 2100, "at": "…", "source": "system", "text": "前端还差两个页面" }
    ]
  },
  "notes": "用户在客户端填的备注",
  "project": { "id": "p-88", "name": "周会", "meetingId": "m-1001" }
}
```

### ⚠️ 与 `meeting.segment` 的两处不同，请注意

1. **会议 id 在顶层 `id`，不是 `meeting.id`。** 这个事件的结构早于本次集成（它同时也是快说通用 Webhook 的格式），为了不破坏已有对接方而保留原样。关联两个事件时：`completed.id === segment.meeting.id`。
2. `transcript.segments` 里**没有** `text` 之外的 `meeting` 包装，字段名与 `segment` 对象一致。

### 字段含义

| 字段 | 含义 |
|---|---|
| `id` | 会议 id，对应 `meeting.segment` 里的 `meeting.id` |
| `durationMs` | 会议总时长（含沉默） |
| `stats.speechMs` | 实际有人说话的毫秒数（不含沉默），可以据此算会议密度 |
| `stats.words` | **可能不存在**，只在客户端算出了词数时出现 |
| `speakers[].label` | 与段落里的 `speaker` 字符串一一对应 |
| `speakers[].isOwner` | 是否是本机用户本人 |
| `speakers[].channel` | `mic`（房间里）或 `system`（远端）。**系统声音的说话人永远不会是 `isOwner`** |
| `transcript.text` | 纯文本逐字稿，`说话人：内容` 一行一轮 |
| `transcript.markdown` | 带时间戳的 Markdown，可以直接丢给 LLM 开稿 |
| `transcript.segments` | 结构化段落。用户可关闭「包含逐字段落」来省流量，**关掉时这个键不存在** |
| `notes` | 用户填的会议备注 |
| `project` | 同 `meeting.segment`，**不归属时整个不存在** |

### 失败会怎样

这一份**不能丢**，所以走持久化重投队列：立即投一次，失败后按 **30 秒 → 2 分钟 → 10 分钟 → 30 分钟 → 2 小时** 重试，共 5 次覆盖约 3 小时。**队列写在磁盘上，客户端重启后继续投。**

4xx 立刻放弃（重试也只会得到同样的结果）。

---

## 6. 连通性测试

客户端设置页有两个测试按钮，你在联调时会先收到它们：

| 按钮 | 你会收到 |
|---|---|
| 列表接口「测试拉取」 | 一次普通的 GET，并把**按映射解析出来的前 5 条**显示给用户看 |
| 推送接口「发送测试」 | 一条**真实的 `meeting.segment`**，`meeting.id` 为 `mt_test`，`project.id` 为 `test-project` |

推送测试发的是真事件而不是 ping，就是为了让你那边的解析路径真的跑一遍。如果你需要区分，用 `meeting.id === "mt_test"` 过滤。

---

## 7. 实现清单

**接口 A**
- [ ] GET，返回 2xx + JSON
- [ ] 校验 `Authorization`（或你选的自定义头）
- [ ] 告诉用户五个映射字段该怎么填
- [ ] 列表控制在几十条量级（最多 500）

**接口 B**
- [ ] POST，读取**原始 body 字节**后再校验签名
- [ ] 校验 `X-Kuaishuo-Signature` 与时间戳新鲜度
- [ ] 用 `X-Kuaishuo-Delivery` 做**幂等去重**
- [ ] 按 `event` 分发 `meeting.segment` / `meeting.completed`
- [ ] 用「`project` 键存不存在」判断归属，不要假设它一定在
- [ ] 成功返回 2xx；**参数错误返回 4xx（不重试），自身故障返回 5xx（会重试）**
- [ ] 接口做轻：一小时的会有几百次调用
- [ ] 关联两个事件：`completed.id === segment.meeting.id`

**容易踩的坑**
- 时间戳是**带本地偏移**的 ISO 8601（`+08:00`），不是 UTC `Z`。当成 UTC 解析会差 8 小时。
- `project`、`project.name`、`project.meetingId`、`segment.source`、`stats.words`、`transcript.segments` 都是**条件字段**，不存在是正常状态，不是错误。
- 签名针对原始字节。反序列化后重新 `JSON.stringify` 再签，一定对不上。
- `speaker` 是可变的显示标签，不是稳定 id；跨会议不要拿它当人。

---

## 8. 隐私

- 音频**不出用户的机器**。识别在本地完成，发给你的只有文字。
- 只有用户明确配置了地址，才会有任何网络请求。
- 用户可以只开结束推送、关掉实时推送；也可以关掉「包含逐字段落」，只发汇总文本。
    