// Squad / Debate / Adapter 的所有魔法数字、限额、prompt 版本号
// v0.44 抽出，便于一处调

export const SQUAD_LIMITS = {
  // CollaborationDispatcher
  defaultMaxIterations: 30,       // v0.52 10→30：QA 反复 reject 给充分迭代余量
  maxParallelBatches: 60,         // 兜底循环次数，防 PM 拆环（v0.52 20→60）
  // 任务计划解析
  maxRawJsonLength: 500000,       // v0.52 200K→500K
  // PM 拆任务
  minTasks: 1,
  maxTasks: 20,                   // v0.52 12→20：复杂项目可拆更多
};

// v0.52 debate 可配置大轮数（方案 B：R1→R2→R3 整组重复 N 次，再跑 R4）
export const DEBATE_LIMITS = {
  defaultMacroRounds: 2,
  minMacroRounds: 1,
  maxMacroRounds: 10,
};

export const ROOM_LIMITS = {
  injectMaxLen: 32000,             // v0.52 4000→16000→32000
  injectMaxCount: 50,              // v0.52 20→50
  membersMaxCount: 30,             // v0.52 20→30
  membersDisplayNameMax: 80,
  membersModelMax: 80,
  nameMax: 200,
  cwdMax: 1024,
  // ChatRoomStore.save debounce
  saveDebounceMs: 250,
  // v0.49 N-15 fix: SoloChatDispatcher conversation 上限
  chatConversationMax: 2000,       // v0.52 200→400→2000 持久化条数（极限）
  chatContextMaxTurns: 200,        // v0.52 40→80→200 喂给 LLM 的上下文条数（opus 200K tokens）
};

export const ADAPTER_TIMEOUTS = {
  claudeSpawn: 7200000,            // v0.52 2 小时：极限值
  codexSpawn: 7200000,
  geminiSpawn: 7200000,
  ccrSpawn: 7200000,
  ollamaChat: 3600000,             // v0.52 HTTP 1 小时
  minimaxChat: 3600000,
  geminiChat: 3600000,
  openaiCompatChat: 3600000,
  watcherJudge: 3600000,
};

// v0.52 单次 reply 内容上限（持久化截断阈值）
export const CONTENT_LIMITS = {
  maxReplyChars: 2 * 1024 * 1024,  // v0.52 极限 2 MB（rooms.json 单房 30 turn 上限 60MB 仍可控）
  maxTopicChars: 120000,           // v0.52 32K→120K 字（opus 200K tokens 上限）
  maxChatTextChars: 64000,         // v0.52 32K→64K 字
};

// v0.52 房间总量上限
export const SYSTEM_LIMITS = {
  maxRoomsTotal: 500,              // v0.52 200→500
  maxWsPayloadMb: 8,               // v0.52 1→8 MB（reply 2MB + json 包装能进来）
};

export const PROMPT_VERSIONS = {
  // v0.47 全面改造为 Anthropic 四要素结构（OBJECTIVE/OUTPUT FORMAT/TOOLS GUIDANCE/BOUNDARY）
  debate: 'v0.47-r4-anthropic',
  squad_pm: 'v0.47-pm-anthropic-2',     // 加边界：PM 不能限制 dev 输出框架
  squad_dev: 'v0.47-dev-anthropic',
  squad_qa: 'v0.47-qa-anthropic-2',     // 加引导：只审实现段，dev 固定框架不算多余
  squad_judge: 'v0.47-judge-anthropic',
  watcher: 'v0.47-watcher-anthropic',
};
