<template>
  <div class="view">
    <header class="head">
      <h1>设置</h1>
      <p class="dim">改动即时生效，悬浮条会在下一句话时用上新的值，不需要重启。</p>
    </header>

    <!-- ── 输出 ────────────────────────────────────────────────────────────── -->
    <div class="section-title">识别结果去哪</div>
    <div class="card">
      <div class="field">
        <div class="label">
          <b>输出方式</b>
          <span>直接输入 = 复制到剪贴板后向当前窗口发送一次真实的 Ctrl+V。悬浮条不抢焦点，所以文字会落在你原本在打字的地方。</span>
        </div>
        <div class="control">
          <select v-model="s.outputMode" class="select" @change="save('outputMode')">
            <option value="type">直接输入到光标处</option>
            <option value="clipboard">仅复制到剪贴板</option>
            <option value="none">只记录，不输出</option>
          </select>
        </div>
      </div>
      <div class="field">
        <div class="label">
          <b>用完还回剪贴板</b>
          <span>粘贴完成后把你原来复制的内容放回去。默认开——输入法不该顺手吃掉你的剪贴板。</span>
        </div>
        <div class="control right"><button class="switch" :class="{ on: s.restoreClipboard }" @click="toggle('restoreClipboard')"></button></div>
      </div>
      <div class="field">
        <div class="label">
          <b>输入后自动回车</b>
          <span>适合微信、飞书这类"说完就发"的场景。写文档时请关掉。</span>
        </div>
        <div class="control right"><button class="switch" :class="{ on: s.pressEnterAfterType }" @click="toggle('pressEnterAfterType')"></button></div>
      </div>
      <div class="field">
        <div class="label">
          <b>句间补空格</b>
          <span>连续两句英文之间自动加一个空格；中文标点结尾时不加。</span>
        </div>
        <div class="control right"><button class="switch" :class="{ on: s.appendSpace }" @click="toggle('appendSpace')"></button></div>
      </div>
    </div>

    <!-- ── 快捷键 ──────────────────────────────────────────────────────────── -->
    <div class="section-title">全局快捷键</div>
    <div class="card">
      <div v-for="k in HOTKEYS" :key="k.key" class="field">
        <div class="label">
          <b>{{ k.label }}</b>
          <span v-if="hotkeyError?.key === k.key" class="bad-text">{{ hotkeyError.text }}</span>
          <span v-else>{{ k.hint }}</span>
        </div>
        <div class="control">
          <button class="input hotkey" :class="{ capturing: capturing === k.key }" @click="startCapture(k.key)">
            {{ capturing === k.key ? '按下新的组合键…' : (s[k.key] || '未设置') }}
          </button>
        </div>
      </div>
      <div v-if="hotkeysFailed.length" class="field">
        <div class="label bad-text">
          <b>有快捷键没能注册</b>
          <span>
            {{ hotkeysFailed.join('、') }} —— 被别的程序占用了，按下不会有任何反应。换一个组合键即可。
          </span>
        </div>
      </div>
    </div>

    <!-- ── 麦克风与断句 ────────────────────────────────────────────────────── -->
    <div class="section-title">麦克风与断句</div>
    <div class="card">
      <div class="field">
        <div class="label"><b>输入设备</b><span>留空使用系统默认。</span></div>
        <div class="control">
          <select v-model="s.micDeviceId" class="select" @change="save('micDeviceId')">
            <option value="">系统默认</option>
            <option v-for="dv in devices" :key="dv.deviceId" :value="dv.deviceId">{{ dv.label || dv.deviceId.slice(0, 8) }}</option>
          </select>
        </div>
      </div>

      <div class="field">
        <div class="label">
          <b>灵敏度</b>
          <span>声音要比环境底噪高出多少才算"开始说话"。房间和麦克风不同，最佳值也不同——所以下面给了实时预览，别靠猜。</span>
        </div>
        <div class="control">
          <select v-model="s.asrSensitivity" class="select" @change="save('asrSensitivity')">
            <option value="high">高（安静房间 / 小声说话）</option>
            <option value="medium">中（默认）</option>
            <option value="low">低（嘈杂环境 / 近距离麦）</option>
          </select>
        </div>
      </div>

      <div class="field stack">
        <div class="row">
          <span class="dim small">实时预览：说一句话，看竖线右边是不是亮起来</span>
          <span class="spacer"></span>
          <button class="btn sm" @click="previewOn ? stopPreview() : startPreview()">{{ previewOn ? '停止' : '开始预览' }}</button>
        </div>
        <div class="pv-track">
          <div class="pv-fill" :class="{ hot: previewHot }" :style="{ width: previewPct + '%' }"></div>
          <div class="pv-mark" :style="{ left: thresholdPct + '%' }"></div>
        </div>
      </div>

      <div class="field">
        <div class="label">
          <b>断句静音时长</b>
          <span>停顿超过这个时间就认为一句话说完了。中文逗号停顿 300–500ms，句子间通常 1000ms 以上。</span>
        </div>
        <div class="control row">
          <input v-model.number="s.asrSilenceMs" type="range" min="400" max="2000" step="50" class="range" @change="save('asrSilenceMs')" />
          <span class="tnum dim val">{{ s.asrSilenceMs }}ms</span>
        </div>
      </div>
    </div>

    <!-- ── 声纹 ────────────────────────────────────────────────────────────── -->
    <div class="section-title">声纹校验</div>
    <div class="card">
      <div class="field">
        <div class="label">
          <b>只认我的声音</b>
          <span>
            电视、视频、旁边同事说话都会被麦克风听见。能量和频谱分不出人（实测几乎完全重叠），声纹向量可以——这是唯一真正管用的那道闸。
            录制 3 段各 3 秒，取平均。
          </span>
        </div>
        <div class="control right">
          <button class="switch" :class="{ on: s.voiceprintEnabled }" :disabled="!hasVoiceprint" @click="toggle('voiceprintEnabled')"></button>
        </div>
      </div>
      <div class="field">
        <div class="label">
          <b>{{ hasVoiceprint ? '已登记声纹' : '尚未登记' }}</b>
          <span>{{ enrollHint || (hasVoiceprint ? '如果换了麦克风或经常被误挡，重新录一次会更准。' : '开启上面的开关前需要先录一次。') }}</span>
        </div>
        <div class="control row">
          <button class="btn sm" :disabled="enrolling" @click="enroll">
            {{ enrolling ? `录制中 ${enrollDone}/3` : hasVoiceprint ? '重新录制' : '录制声纹' }}
          </button>
          <button v-if="hasVoiceprint && !enrolling" class="btn sm ghost" @click="clearVoiceprint">清除</button>
        </div>
      </div>
      <div class="field">
        <div class="label">
          <b>判定阈值</b>
          <span>余弦相似度低于此值即判为他人。实测同一人 0.59–0.86，不同人 0.05–0.42，0.5 正落在中间的空档里。调高更严格，也更容易误挡自己。</span>
        </div>
        <div class="control row">
          <input v-model.number="s.voiceprintThreshold" type="range" min="0.3" max="0.8" step="0.01" class="range" @change="save('voiceprintThreshold')" />
          <span class="tnum dim val">{{ Number(s.voiceprintThreshold).toFixed(2) }}</span>
        </div>
      </div>
    </div>

    <!-- ── 会议 ────────────────────────────────────────────────────────────── -->
    <div class="section-title">会议模式</div>
    <div class="card">
      <div class="field">
        <div class="label">
          <b>会议中同时录系统声音</b>
          <span>
            远程会议里对方的声音是从你的扬声器出来的，而麦克风开着回声消除——它的全部工作就是把扬声器从麦克风信号里减掉。
            所以只靠麦克风的逐字稿，天生缺了对话的另一半。打开后会议期间额外录一路系统播放的声音，单独断句、单独分说话人，
            并且永远不会被标成「我」。只在会议中生效：听写时把视频里的话打进你的文档，正是声纹校验存在的理由。
            <template v-if="!isWin">当前系统不支持（仅 Windows）。</template>
          </span>
        </div>
        <div class="control right">
          <button class="switch" :class="{ on: s.systemAudioInMeetings && isWin }"
                  :disabled="!isWin" @click="toggle('systemAudioInMeetings')"></button>
        </div>
      </div>
      <div class="field">
        <div class="label">
          <b>会议中忽略声纹校验</b>
          <span>默认开。会议的重点恰恰是别人在说什么，开着声纹只会得到一份缺了所有对方发言的独白。</span>
        </div>
        <div class="control right"><button class="switch" :class="{ on: s.meetingBypassVoiceprint }" @click="toggle('meetingBypassVoiceprint')"></button></div>
      </div>
      <div class="field">
        <div class="label">
          <b>区分说话人</b>
          <span>用同一份声纹向量给每段话贴上「我 / 说话人1 / 说话人2」。分不开同时说话的重叠语音，但正常会议 3–5 人足够可读——这也是让 AI 直接开稿的前提。</span>
        </div>
        <div class="control right"><button class="switch" :class="{ on: s.meetingDiarize }" @click="toggle('meetingDiarize')"></button></div>
      </div>
      <div class="field">
        <div class="label">
          <b>说话人聚类阈值</b>
          <span>调低 = 更容易把两个人并成一个；调高 = 同一个人可能被拆成两个。后者一眼就能看出来并改名，所以默认偏高。</span>
        </div>
        <div class="control row">
          <input v-model.number="s.meetingDiarizeThreshold" type="range" min="0.35" max="0.8" step="0.01" class="range" @change="save('meetingDiarizeThreshold')" />
          <span class="tnum dim val">{{ Number(s.meetingDiarizeThreshold).toFixed(2) }}</span>
        </div>
      </div>
    </div>

    <!-- ── Webhook ─────────────────────────────────────────────────────────── -->
    <div class="section-title">逐字稿推送 (Webhook)</div>
    <div class="card">
      <div class="field">
        <div class="label">
          <b>启用推送</b>
          <span>会议结束时把整份逐字稿 POST 到你的地址，用来接自动化开稿流程（n8n / Dify / Coze / 自建服务都行）。</span>
        </div>
        <div class="control right"><button class="switch" :class="{ on: s.webhookEnabled }" @click="toggle('webhookEnabled')"></button></div>
      </div>
      <div class="field stack">
        <div class="label"><b>接收地址</b><span>http/https 均可。</span></div>
        <input v-model="s.webhookUrl" class="input mono" placeholder="https://example.com/hooks/kuaishuo" @change="save('webhookUrl')" />
      </div>
      <div class="field stack">
        <div class="label">
          <b>签名密钥（可选）</b>
          <span>
            填了就会带 <code class="mono">X-Kuaishuo-Signature: sha256=…</code>，签的是
            <code class="mono">`${timestamp}.${rawBody}`</code>，同时带 <code class="mono">X-Kuaishuo-Timestamp</code>。
            服务端拒收几分钟以外的时间戳即可防重放。
          </span>
        </div>
        <input v-model="s.webhookSecret" class="input mono" type="password" placeholder="留空则不签名" @change="save('webhookSecret')" />
      </div>
      <div class="field">
        <div class="label"><b>包含逐字段落</b><span>关掉只发整段文本和 markdown，体积小很多。</span></div>
        <div class="control right"><button class="switch" :class="{ on: s.webhookIncludeSegments }" @click="toggle('webhookIncludeSegments')"></button></div>
      </div>
      <div class="field">
        <div class="label"><b>会议结束自动推送</b><span>关掉就只能在「会议」页手动点推送。</span></div>
        <div class="control right"><button class="switch" :class="{ on: s.webhookAutoOnEnd }" @click="toggle('webhookAutoOnEnd')"></button></div>
      </div>
      <div class="field">
        <div class="label">
          <b>连通性测试</b>
          <span>发一条格式完全相同、event 为 <code class="mono">meeting.test</code> 的真实请求，顺便验证你那边的解析。{{ outboxCount ? `当前有 ${outboxCount} 条待重试。` : '' }}</span>
        </div>
        <div class="control row">
          <button class="btn sm" :disabled="testing || !s.webhookUrl" @click="testWebhook">{{ testing ? '发送中…' : '发送测试' }}</button>
          <button v-if="outboxCount" class="btn sm ghost" @click="flushOutbox">立即重试</button>
        </div>
      </div>
      <div v-if="testResult" class="field">
        <div class="label" :class="testResult.ok ? 'ok-text' : 'bad-text'">
          <b>{{ testResult.ok ? `成功 · HTTP ${testResult.status}` : `失败 · ${testResult.error}` }}</b>
          <span v-if="testResult.response" class="mono">{{ testResult.response }}</span>
        </div>
      </div>
    </div>

    <!-- ── 会议归属：列表接口 ──────────────────────────────────────────────── -->
    <div class="section-title">会议归属 · 列表接口</div>
    <div class="card">
      <div class="field">
        <div class="label">
          <b>开始录制前选择会议</b>
          <span>
            配好之后，「会议」页点开始录制会先让你选这场录的是哪个会，录下来的内容就带着它所属项目的 ID 推给后端。
            不配也能用——只是后端收到的会议无法归位。
          </span>
        </div>
        <div class="control right"><button class="switch" :class="{ on: s.projectsEnabled }" @click="toggle('projectsEnabled')"></button></div>
      </div>
      <div class="field stack">
        <div class="label"><b>列表地址（GET）</b><span>返回会议或项目列表的接口。需要鉴权就在下面加请求头。</span></div>
        <input v-model="s.projectsUrl" class="input mono" placeholder="https://example.com/api/meetings" @change="save('projectsUrl')" />
      </div>

      <HeaderEditor :model="s.projectsHeaders" hint="常见的是一个 Authorization。" @update="saveHeaders('projectsHeaders', $event)" />

      <div class="field">
        <div class="label">
          <b>{{ shapeArrays.length ? '重新拉取' : '测试拉取' }}</b>
          <span>
            请求一次你的接口，把返回里所有能当列表用的地方找出来，下面直接选就行——不用自己数 JSON 层级，
            也不会因为手打错一个字段名而得到一个空列表。
          </span>
        </div>
        <div class="control row">
          <button class="btn sm" :disabled="fetchingProjects || !s.projectsUrl" @click="testProjects">{{ fetchingProjects ? '拉取中…' : '测试拉取' }}</button>
        </div>
      </div>

      <div v-if="projectsResult && !projectsResult.ok" class="field">
        <div class="label bad-text">
          <b>拉取失败</b>
          <span>{{ projectsResult.error }}</span>
        </div>
      </div>

      <template v-else-if="shapeArrays.length">
        <div class="field stack">
          <div class="label">
            <b>哪个是会议列表</b>
            <span>从你的返回里找到 {{ shapeArrays.length }} 处数组。选中后下面会跟着变。</span>
          </div>
          <select v-model="pickItemsPath" class="select mono" @change="onPickArray">
            <option v-for="a in shapeArrays" :key="a.path" :value="a.path">
              {{ a.path || '(根就是数组)' }} — {{ a.count }} 条 · {{ a.fields.length }} 个字段
            </option>
          </select>
        </div>

        <div class="field stack">
          <div class="label">
            <b>字段对应</b>
            <span>每一项后面括号里是你返回中的真实取值，照着选就行。</span>
          </div>
          <div class="mapgrid">
            <label>
              <span>ID（唯一标识）</span>
              <select v-model="s.projectsIdField" class="select mono" @change="saveField('projectsIdField')">
                <option v-for="f in fieldOptions" :key="f.path" :value="f.path">{{ f.path }}（{{ f.sample }}）</option>
              </select>
            </label>
            <label>
              <span>名称（显示给你看的）</span>
              <select v-model="s.projectsNameField" class="select mono" @change="saveField('projectsNameField')">
                <option value="">— 用 ID 代替 —</option>
                <option v-for="f in fieldOptions" :key="f.path" :value="f.path">{{ f.path }}（{{ f.sample }}）</option>
              </select>
            </label>
            <label>
              <span>项目 ID（推送时带上的）</span>
              <select v-model="s.projectsProjectIdField" class="select mono" @change="saveField('projectsProjectIdField')">
                <option value="">— 就用上面的 ID —</option>
                <option v-for="f in fieldOptions" :key="f.path" :value="f.path">{{ f.path }}（{{ f.sample }}）</option>
              </select>
            </label>
            <label>
              <span>分组（可选）</span>
              <select v-model="s.projectsGroupField" class="select mono" @change="saveField('projectsGroupField')">
                <option value="">— 不分组 —</option>
                <option v-for="f in fieldOptions" :key="f.path" :value="f.path">{{ f.path }}（{{ f.sample }}）</option>
              </select>
            </label>
          </div>
        </div>
      </template>
      <div v-if="projectsResult" class="field stack">
        <div class="label" :class="projectsResult.ok && projectsResult.items.length ? 'ok-text' : 'bad-text'">
          <b>{{ projectsSummary }}</b>
          <span v-if="projectsResult.reason">{{ projectsResult.reason }}</span>
          <span v-else-if="projectsResult.error">{{ projectsResult.error }}</span>
        </div>
        <ul v-if="projectsResult.items?.length" class="preview-list mono">
          <li v-for="it in projectsResult.items.slice(0, 5)" :key="it.id">
            <b>{{ it.name }}</b>
            <span class="dim">id={{ it.id }} · projectId={{ it.projectId }}<template v-if="it.group"> · {{ it.group }}</template></span>
          </li>
        </ul>
      </div>
    </div>

    <!-- ── 会议归属：推送接口 ──────────────────────────────────────────────── -->
    <div class="section-title">会议归属 · 推送接口</div>
    <div class="card">
      <div class="field">
        <div class="label">
          <b>启用推送</b>
          <span>
            这个接口收两种事件：<code class="mono">meeting.segment</code>（每识别出一句就推一次，实时）和
            <code class="mono">meeting.completed</code>（会议结束推一份完整记录）。选了会议就带
            <code class="mono">project</code> 块，没选就整块不出现。
          </span>
        </div>
        <div class="control right"><button class="switch" :class="{ on: s.projectPushEnabled }" @click="toggle('projectPushEnabled')"></button></div>
      </div>
      <div class="field stack">
        <div class="label"><b>接收地址（POST）</b><span>两种事件都发到这一个地址，用 <code class="mono">event</code> 字段区分。</span></div>
        <input v-model="s.projectPushUrl" class="input mono" placeholder="https://example.com/api/kuaishuo/ingest" @change="save('projectPushUrl')" />
      </div>
      <div class="field stack">
        <div class="label"><b>签名密钥（可选）</b><span>和上面的 Webhook 同一套签名方案，服务端可以共用校验代码。</span></div>
        <input v-model="s.projectPushSecret" class="input mono" type="password" placeholder="留空则不签名" @change="save('projectPushSecret')" />
      </div>

      <HeaderEditor :model="s.projectPushHeaders" hint="会和签名头一起发出去。" @update="saveHeaders('projectPushHeaders', $event)" />

      <div class="field">
        <div class="label">
          <b>实时逐句推送</b>
          <span>
            一场一小时的会大约 300–600 次请求。失败会快速重试两次，然后放弃并计数——这一路丢了不要紧，
            结束时的完整记录会补齐，那一份是持久重投的。关掉就只发结束时那一份。
          </span>
        </div>
        <div class="control right"><button class="switch" :class="{ on: s.projectPushSegments }" @click="toggle('projectPushSegments')"></button></div>
      </div>
      <div class="field">
        <div class="label"><b>会议结束推完整记录</b><span>和 Webhook 的 payload 结构一样，多一个 project 块。</span></div>
        <div class="control right"><button class="switch" :class="{ on: s.projectPushOnEnd }" @click="toggle('projectPushOnEnd')"></button></div>
      </div>
      <div class="field">
        <div class="label">
          <b>连通性测试</b>
          <span>发一条真实的 <code class="mono">meeting.segment</code>，也就是你那边之后会收到几百次的那种。</span>
        </div>
        <div class="control row">
          <button class="btn sm" :disabled="pushTesting || !s.projectPushUrl" @click="testProjectPush">{{ pushTesting ? '发送中…' : '发送测试' }}</button>
        </div>
      </div>
      <div v-if="pushResult" class="field">
        <div class="label" :class="pushResult.ok ? 'ok-text' : 'bad-text'">
          <b>{{ pushResult.ok ? `成功 · HTTP ${pushResult.status}` : `失败 · ${pushResult.error}` }}</b>
          <span v-if="pushResult.response" class="mono">{{ pushResult.response }}</span>
        </div>
      </div>
    </div>

    <!-- ── 模型 ────────────────────────────────────────────────────────────── -->
    <div class="section-title">本地模型</div>
    <div class="card">
      <div v-if="!asr.bundled" class="field">
        <div class="label">
          <b>启动后自动下载</b>
          <span>识别模型是这个 app 唯一的核心资产，所以默认在启动几秒后就在后台拉下来。关掉的话，等待会挪到你第一次按下麦克风的时候。</span>
        </div>
        <div class="control right"><button class="switch" :class="{ on: s.autoDownloadModel }" @click="toggle('autoDownloadModel')"></button></div>
      </div>
      <div class="field">
        <div class="label">
          <b>语音识别 · SenseVoice-Small</b>
          <span>
            <template v-if="asr.bundled">随安装包内置，装完即可用，识别全程离线、不联网。</template>
            <template v-else>{{ asr.modelOnDisk ? '已就绪，识别全程离线。' : '约 228MB，首次使用时自动下载。' }}</template>
            <template v-if="asrProgress.stage && asrProgress.stage !== 'ready' && asrProgress.stage !== 'idle'">
              　{{ asrProgress.message }} {{ Math.round((asrProgress.progress || 0) * 100) }}%
            </template>
          </span>
        </div>
        <div class="control row">
          <!-- A bundled model is not the user's to fetch or to reclaim: it came
               with the installer and deleting it would leave the app unable to
               find something it is still shipping. -->
          <span v-if="asr.bundled" class="tag ok">已内置</span>
          <button v-else-if="!asr.modelOnDisk" class="btn sm primary" :disabled="downloading" @click="downloadModel">下载</button>
          <button v-else class="btn sm ghost" @click="clearModel">删除模型</button>
        </div>
      </div>
      <div class="field">
        <div class="label">
          <b>声纹模型 · 3D-Speaker CAM++</b>
          <span>
            <template v-if="asr.bundled && asr.speakerModelOnDisk">随安装包内置。声纹校验和会议分人都靠它。</template>
            <template v-else>{{ asr.speakerModelOnDisk ? '已就绪。' : '约 28MB，开启声纹校验或会议区分说话人时自动下载。' }}</template>
          </span>
        </div>
        <div class="control right">
          <span class="tag" :class="asr.speakerModelOnDisk ? 'ok' : ''">
            {{ !asr.speakerModelOnDisk ? '未安装' : (asr.bundled ? '已内置' : '已安装') }}
          </span>
        </div>
      </div>
    </div>

    <!-- ── 关于 ────────────────────────────────────────────────────────────── -->
    <div class="section-title">悬浮条</div>
    <div class="card">
      <div class="field">
        <div class="label">
          <b>距任务栏高度</b>
          <span>
            悬浮条底边到任务栏顶边的距离。拖动时条子会跟着走，看着调就行。
            量的是你看得见的那条，不是窗口边缘——窗口底下还有一段透明的地方留给投影。
          </span>
        </div>
        <div class="control row">
          <input v-model.number="s.overlayBottomGap" type="range" min="0" max="200" step="1"
                 class="range" @input="save('overlayBottomGap')" />
          <span class="tnum dim val">{{ s.overlayBottomGap }}px</span>
        </div>
      </div>
      <div class="field">
        <div class="label">
          <b>回到默认位置</b>
          <span>水平居中，高度回到 15px。换了显示器或者不小心拖丢了就点这个。</span>
        </div>
        <div class="control row">
          <button class="btn sm" @click="resetOverlayPos">复位</button>
        </div>
      </div>
    </div>

    <!-- ── 关于 ────────────────────────────────────────────────────────────── -->
    <div class="section-title">其他</div>
    <div class="card">
      <div class="field">
        <div class="label"><b>开机自动启动</b><span>以隐藏方式启动，只有托盘图标和悬浮条。</span></div>
        <div class="control right"><button class="switch" :class="{ on: s.launchAtLogin }" @click="toggle('launchAtLogin')"></button></div>
      </div>
      <div class="field">
        <div class="label">
          <b>版本与路径</b>
          <span class="mono">v{{ info.version }} · Electron {{ info.electron }} · {{ info.injector }}</span>
          <span class="mono path">{{ info.dataDir }}</span>
        </div>
        <div class="control row">
          <button class="btn sm ghost" @click="openData">打开目录</button>
          <button class="btn sm ghost" @click="reset">恢复默认设置</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useSettings, updateSettings, resetSettings } from '../../core/settings.js'
import { openMicTap, createFloorTracker, frameDb, attackDbFor } from '../../core/voiceVad.js'
import { transcribeDetailed, resampleTo16k, ensureSpeakerModel, ensureAsrModel, getAsrStatus, onAsrProgress, clearAsrModel } from '../../core/asr.js'
import HeaderEditor from '../../components/HeaderEditor.vue'

const { settings: s } = useSettings()

// Read at the point of use, never written back into settings.json. A profile
// copied from a Mac to a Windows machine must not arrive with the feature
// silently switched off because it was unavailable where it was last opened.
const isWin = window.kuaishuo.platform === 'win32'

// 悬浮条上已经没有"开始"按钮了：要说话的时候去用鼠标找一个按钮，是所有
// 开始方式里最慢的一种，等你找到了那句话也忘了。三个键对应三种意图。
const HOTKEYS = [
  {
    key: 'hotkeyPushToTalk',
    label: '临时录音（按住说）',
    hint: '按住不放，说完松手就停。快按一下则只听一句，说完自动停——因为试快捷键的人总是先点一下。',
  },
  {
    key: 'hotkeyToggle',
    label: '一直录音（开关）',
    hint: '按一次开始，再按一次停。适合口述一整段。',
  },
  {
    key: 'hotkeyMeeting',
    label: '打开会议页',
    hint: '跳到控制台的会议页开始录。会议要先选归属，选归属需要一个能打字的窗口，所以不在悬浮条上开。',
  },
  { key: 'hotkeyMute',   label: '暂停 / 恢复',  hint: '临时静音：麦克风保持开着，但不识别、不输入。' },
  { key: 'hotkeyPanel',  label: '打开控制台',   hint: '' },
]

const devices = ref([])
const info = ref({ version: '…', electron: '', dataDir: '', injector: '' })
const asr = ref({ modelOnDisk: false, speakerModelOnDisk: false, bundled: false })
const asrProgress = ref({ stage: 'idle', progress: 0, message: '' })
const downloading = ref(false)
const testing = ref(false)
const testResult = ref(null)
const outboxCount = ref(0)

function save(key) { updateSettings({ [key]: s.value[key] }) }
function toggle(key) { updateSettings({ [key]: !s.value[key] }) }
/** HeaderEditor owns its own row state and hands back a finished object. */
function saveHeaders(key, obj) { updateSettings({ [key]: obj }) }

// ---- Project binding ---------------------------------------------------------

const fetchingProjects = ref(false)
const projectsResult = ref(null)
const pushTesting = ref(false)
const pushResult = ref(null)

// The failure this wording exists for: the request succeeded, the array was
// found, and every row was skipped because the id field is wrong. Reporting
// "成功" there would send someone looking at their server logs for an hour.
const projectsSummary = computed(() => {
  const r = projectsResult.value
  if (!r) return ''
  if (!r.ok) return `拉取失败 · ${r.error}`
  const n = r.items?.length || 0
  if (!n) return '请求成功，但一条都没解析出来'
  return `解析出 ${n} 条${r.skipped ? `（另有 ${r.skipped} 条被跳过）` : ''}`
})

// Everything the last fetch found in the response: which arrays could be the
// list, and what fields each of their items has. The dropdowns are built from
// this, so the user picks paths out of their own data instead of transcribing
// `data.list` and `project.id` into text boxes and getting an empty picker when
// a letter is wrong.
const shapeArrays = ref([])
const pickItemsPath = ref('')

const fieldOptions = computed(() => {
  const arr = shapeArrays.value.find((a) => a.path === pickItemsPath.value)
  const fields = arr ? [...arr.fields] : []
  // Keep a previously-saved path selectable even if this response doesn't
  // contain it — opening the page must never silently drop a working config.
  for (const saved of [s.value.projectsIdField, s.value.projectsNameField,
                       s.value.projectsProjectIdField, s.value.projectsGroupField]) {
    if (saved && !fields.some((f) => f.path === saved)) fields.push({ path: saved, sample: '已保存' })
  }
  return fields
})

/** Re-run the request with the current mapping so the preview stays honest. */
async function refreshProjectsPreview() {
  fetchingProjects.value = true
  try {
    const r = await window.kuaishuo.projects.test({
      url: s.value.projectsUrl,
      headers: s.value.projectsHeaders,
      itemsPath: s.value.projectsItemsPath,
      idField: s.value.projectsIdField,
      nameField: s.value.projectsNameField,
      projectIdField: s.value.projectsProjectIdField,
      groupField: s.value.projectsGroupField,
    })
    projectsResult.value = r
    if (Array.isArray(r.arrays)) shapeArrays.value = r.arrays
    return r
  } finally {
    fetchingProjects.value = false
  }
}

async function testProjects() {
  projectsResult.value = null
  const r = await refreshProjectsPreview()
  if (!r?.ok) return

  pickItemsPath.value = s.value.projectsItemsPath || ''
  const known = shapeArrays.value.some((a) => a.path === pickItemsPath.value)
  // Only guess when the saved mapping doesn't fit this response — re-testing a
  // working configuration must not quietly rewrite the user's choices.
  if (!known && r.guess) await applyGuess(r.guess)
}

async function applyGuess(guess) {
  pickItemsPath.value = guess.itemsPath
  await updateSettings({
    projectsItemsPath: guess.itemsPath,
    projectsIdField: guess.idField,
    projectsNameField: guess.nameField,
    projectsProjectIdField: guess.projectIdField,
    projectsGroupField: guess.groupField,
  })
  await refreshProjectsPreview()
}

/** A different array almost certainly means different fields, so re-guess. */
async function onPickArray() {
  const arr = shapeArrays.value.find((a) => a.path === pickItemsPath.value)
  if (!arr) return
  const guess = guessFor(arr)
  await applyGuess({ ...guess, itemsPath: arr.path })
}

/** Save one mapping field, then re-parse so the preview below reflects it. */
async function saveField(key) {
  await updateSettings({ [key]: s.value[key] })
  await refreshProjectsPreview()
}

/** Same heuristics as the main process, for a pick that never leaves the page. */
function guessFor(arr) {
  const paths = arr.fields.map((f) => f.path)
  const pick = (re, extra = () => true) => paths.find((p) => re.test(p) && extra(p)) || ''
  const proj = /(project|proj|team|space|workspace|group)/i
  const idLike = /(^|\.)(id|uuid|guid|code|key|no)$/i
  const nameLike = /(^|\.)(name|title|label|subject)$/i
  const idField = pick(/^id$/i) || pick(idLike, (p) => !proj.test(p)) || paths[0] || 'id'
  const nameField = pick(nameLike, (p) => !proj.test(p))
  return {
    idField,
    nameField,
    projectIdField: pick(idLike, (p) => proj.test(p) && p !== idField),
    groupField: pick(nameLike, (p) => proj.test(p) && p !== nameField),
  }
}

async function testProjectPush() {
  pushTesting.value = true
  pushResult.value = null
  try {
    pushResult.value = await window.kuaishuo.projects.pushTest({
      url: s.value.projectPushUrl,
      secret: s.value.projectPushSecret,
      headers: s.value.projectPushHeaders,
    })
  } finally {
    pushTesting.value = false
  }
}

async function reset() {
  if (!confirm('恢复全部默认设置？（已录制的声纹也会被清除）')) return
  await resetSettings()
}

function openData() { window.kuaishuo.app.openPath('data') }

async function resetOverlayPos() {
  await updateSettings({ overlayBottomGap: 15 })
  await window.kuaishuo.overlay.reposition()
  await window.kuaishuo.overlay.show()
}

// ---- Hotkey capture ---------------------------------------------------------

const capturing = ref('')
const hotkeyError = ref(null)   // { key, text } while a capture was refused
// Combinations another application holds. Registering one is best-effort and
// failing is silent at the OS level, so without this the key just does nothing
// and there is nowhere to find out why.
const hotkeysFailed = ref([])

function startCapture(key) {
  capturing.value = key
  hotkeyError.value = null
  const onKey = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') { finish(null); return }
    // A bare letter would swallow that key system-wide. Require a modifier.
    const mods = []
    if (e.ctrlKey) mods.push('Control')
    if (e.altKey) mods.push('Alt')
    if (e.shiftKey) mods.push('Shift')
    if (e.metaKey) mods.push('Super')
    const base = normalizeKey(e)
    if (!base || !mods.length) return
    finish([...mods, base].join('+'))
  }
  const finish = (accel) => {
    window.removeEventListener('keydown', onKey, true)
    capturing.value = ''
    if (!accel) return
    // A global shortcut belongs to whoever registers it first, so two settings
    // holding the same combination doesn't do two things — it silently deletes
    // one of them. The store enforces that, which means an accepted-looking
    // save would just snap back. Say why instead.
    const clash = HOTKEYS.find((h) => h.key !== key && s.value[h.key] === accel)
    if (clash) {
      hotkeyError.value = { key, text: `${accel} 已经被「${clash.label}」占用了` }
      return
    }
    hotkeyError.value = null
    updateSettings({ [key]: accel })
  }
  window.addEventListener('keydown', onKey, true)
}

function normalizeKey(e) {
  const k = e.key
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(k)) return ''
  if (k === ' ') return 'Space'
  if (k.length === 1) return k.toUpperCase()
  const map = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc' }
  return map[k] || k
}

// ---- Sensitivity preview ----------------------------------------------------
// Shares openMicTap + createFloorTracker with the live dictation path on
// purpose. A preview that re-implements the threshold maths would show a number
// the recogniser doesn't actually use, and the user would tune against a lie.

const previewOn = ref(false)
const previewDb = ref(-90)
const previewFloor = ref(-60)
let previewMic = null

const DB_MIN = -70
const DB_MAX = -10
const toPct = (db) => Math.max(0, Math.min(100, ((db - DB_MIN) / (DB_MAX - DB_MIN)) * 100))
const previewPct = computed(() => toPct(previewDb.value))
const thresholdPct = computed(() => toPct(previewFloor.value + attackDbFor(s.value.asrSensitivity)))
const previewHot = computed(() => previewDb.value > previewFloor.value + attackDbFor(s.value.asrSensitivity))

async function startPreview() {
  if (previewOn.value) return
  const floor = createFloorTracker()
  try {
    previewMic = await openMicTap({
      deviceId: s.value.micDeviceId,
      onFrame: (data) => {
        const db = frameDb(data)
        previewDb.value = db
        previewFloor.value = floor.push(db)
      },
    })
    previewOn.value = true
  } catch (err) {
    alert(`打不开麦克风：${err.message}`)
  }
}

async function stopPreview() {
  previewOn.value = false
  previewDb.value = -90
  const m = previewMic
  previewMic = null
  if (m) { try { await m.close() } catch {} }
}

// ---- Voiceprint enrolment ---------------------------------------------------
// Three takes averaged. One take captures whatever that sentence happened to
// sound like; averaging pulls the embedding toward the speaker and away from the
// particular words, which is what keeps the user from being rejected later for
// saying something with different phonetics.

const ENROLL_TAKES = 3
const ENROLL_SECS = 3
const enrolling = ref(false)
const enrollDone = ref(0)
const enrollHint = ref('')
let cancelEnroll = false

const hasVoiceprint = computed(() => !!s.value.voiceprint?.length)

async function enroll() {
  if (enrolling.value) return
  await stopPreview()
  enrolling.value = true
  cancelEnroll = false
  enrollDone.value = 0
  enrollHint.value = '正在准备声纹模型…'
  try {
    await ensureAsrModel({ preloadWorker: false })
    await ensureSpeakerModel()
    const takes = []
    for (let i = 0; i < ENROLL_TAKES && !cancelEnroll; i++) {
      enrollHint.value = `第 ${i + 1} 段：请正常说话 3 秒（说什么都行）`
      const pcm = await recordSeconds(ENROLL_SECS)
      if (cancelEnroll) break
      enrollHint.value = '处理中…'
      const { embedding } = await transcribeDetailed(pcm, 16000, { withEmbedding: true })
      if (embedding?.length) { takes.push(embedding); enrollDone.value = takes.length }
    }
    if (cancelEnroll) { enrollHint.value = ''; return }
    if (takes.length < 2) { enrollHint.value = '录制失败，请检查麦克风后重试。'; return }
    // Mean embedding, then L2-normalise so cosine against it behaves.
    const dim = takes[0].length
    const mean = new Array(dim).fill(0)
    for (const v of takes) for (let i = 0; i < dim; i++) mean[i] += v[i] / takes.length
    let norm = 0
    for (const v of mean) norm += v * v
    norm = Math.sqrt(norm) || 1
    await updateSettings({ voiceprint: mean.map((v) => v / norm), voiceprintEnabled: true })
    enrollHint.value = '录制完成，声纹校验已开启。'
    refreshAsr()
  } catch (err) {
    enrollHint.value = err?.message || String(err)
  } finally {
    enrolling.value = false
  }
}

async function recordSeconds(secs) {
  const chunks = []
  const mic = await openMicTap({ deviceId: s.value.micDeviceId, onFrame: (d) => chunks.push(d) })
  await new Promise((r) => setTimeout(r, secs * 1000))
  const rate = mic.sampleRate
  await mic.close()
  let n = 0
  for (const c of chunks) n += c.length
  const all = new Float32Array(n)
  let off = 0
  for (const c of chunks) { all.set(c, off); off += c.length }
  return resampleTo16k(all, rate)
}

async function clearVoiceprint() {
  await updateSettings({ voiceprint: null, voiceprintEnabled: false })
  enrollHint.value = ''
}

// ---- Models -----------------------------------------------------------------

async function refreshAsr() {
  const st = await window.kuaishuo.asr.status()
  if (st) asr.value = st
}

async function downloadModel() {
  downloading.value = true
  try {
    await ensureAsrModel({ preloadWorker: false })
    await refreshAsr()
  } finally {
    downloading.value = false
  }
}

async function clearModel() {
  if (!confirm('删除已下载的识别模型？下次使用时会重新下载 228MB。')) return
  await clearAsrModel()
  await refreshAsr()
}

// ---- Webhook ----------------------------------------------------------------

async function testWebhook() {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await window.kuaishuo.webhook.test({ url: s.value.webhookUrl, secret: s.value.webhookSecret })
  } finally {
    testing.value = false
    refreshOutbox()
  }
}

async function refreshOutbox() {
  outboxCount.value = (await window.kuaishuo.webhook.outbox()).length
}

async function flushOutbox() {
  await window.kuaishuo.webhook.flush()
  await refreshOutbox()
}

// ---- Lifecycle --------------------------------------------------------------

let unsubProgress = null
let unsubHotkeys = null

onMounted(async () => {
  info.value = await window.kuaishuo.app.info()
  refreshAsr()
  refreshOutbox()
  unsubProgress = onAsrProgress((p) => {
    asrProgress.value = p
    if (p?.stage === 'ready') refreshAsr()
  })
  unsubHotkeys = window.kuaishuo.app.onHotkeysFailed((list) => { hotkeysFailed.value = list || [] })
  try {
    // Labels are empty until the page has held a mic permission at least once;
    // that's fine — the deviceIds still work, and the first enrolment fills
    // them in for good.
    devices.value = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  } catch { /* no devices, no list */ }
})

// Leaving the page must release the mic — an OS recording indicator left lit
// because a settings tab was closed is exactly the kind of thing that makes
// people distrust an app.
onBeforeUnmount(() => {
  cancelEnroll = true
  stopPreview()
  try { unsubProgress?.() } catch {}
  try { unsubHotkeys?.() } catch {}
})
</script>

<style scoped>
.view { padding: 26px 28px 60px; max-width: 860px; }
.head h1 { font-size: 19px; font-weight: 600; margin: 0 0 6px; }
.head p { margin: 0 0 4px; font-size: 12.5px; }

.control.right { display: flex; justify-content: flex-end; }
.control.row { display: flex; align-items: center; gap: 10px; justify-content: flex-end; }
.val { width: 54px; text-align: right; font-size: 12px; flex: none; }
.small { font-size: 11.5px; }
.path { margin-top: 3px; word-break: break-all; }
.ok-text b { color: var(--accent); }
.bad-text b { color: var(--danger); }

/* Response-mapping fields. Two columns so five short inputs don't become five
   full-width rows that read as five unrelated settings. */
.mapgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; }
.mapgrid label { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.mapgrid label > span { color: var(--text-3); font-size: 12px; }

/* What the test button parsed. Showing the mapped result rather than the raw
   response is the point — the raw body is what the user already has. */
.preview-list { list-style: none; margin: 0; padding: 8px 10px; border-radius: var(--radius-sm);
                background: var(--bg-inset); display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.preview-list li { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.preview-list li > span { word-break: break-all; }

code { background: var(--bg-inset); padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }

.hotkey { text-align: left; cursor: pointer; font-size: 12.5px; }
.hotkey.capturing { border-color: var(--accent); color: var(--accent); }

.range {
  flex: 1;
  accent-color: var(--accent);
  height: 4px;
  background: var(--bg-inset);
  border-radius: 2px;
}

/* Level meter for the sensitivity preview. The tick is where "that's speech"
   begins — the crossing is the thing the eye should catch, so it sits on top of
   the fill rather than beside it. */
.pv-track {
  position: relative;
  height: 8px;
  border-radius: 999px;
  background: var(--bg-inset);
  overflow: visible;
}
.pv-fill {
  height: 100%;
  border-radius: 999px;
  background: #4b5563;
  /* Short transition only — a level meter that lags stops being a level meter. */
  transition: width 0.06s linear, background 0.12s;
}
.pv-fill.hot { background: var(--accent); }
.pv-mark {
  position: absolute;
  top: -3px; bottom: -3px;
  width: 2px;
  border-radius: 1px;
  background: var(--text);
  opacity: 0.6;
  transition: left 0.18s ease;
}
</style>
