/**
 * 连接器 —— Client 半边（纯管理面板）
 *
 * 定位：这里**不提供手动查询**。连接器是给智能体用的，查询/执行都在对话里完成；
 * 面板只负责「把连接配好、测通、看清楚它能做什么」。
 *
 * 所以界面只有两块：
 *   左：按类别分组的连接清单（搜索、全部测试、新建）
 *   右：连接详情（属性摘要 + 智能体可用动作 + 连通性）或 编辑表单
 *
 * 视觉沿用 macOS 设置面板那一套：系统蓝单强调色、填充式控件、发丝线、iOS 开关。
 */

window.__ModuleLoader__.load({
  id: '@local/ws-connections',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/wsconn/api'
    const NS = 'ws-conn'

    /* ------------------------------------------------------------------ */
    /* 图标                                                                */
    /* ------------------------------------------------------------------ */

    const PATHS = {
      plug: 'M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v5',
      close: 'M6 6l12 12M18 6L6 18',
      plus: 'M12 4.2v15.6M4.2 12h15.6',
      search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
      database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3ZM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
      bolt: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z',
      server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
      globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.4 3.8 5.4 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3Z',
      chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12Z',
      wave: 'M3 12h2l2-6 3 12 3-9 2 5h6',
      check: 'M4 12.5 9 17.5 20 6.5',
      trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
      edit: 'M4 20h4l10-10-4-4L4 16v4ZM14 6l4 4',
      refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
      copy: 'M9 9h10v11H9zM5 15V4h10',
      chevron: 'M9 6l6 6-6 6',
      terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M13 15h4',
      key: 'M14 7a4 4 0 1 1-3.5 5.9L4 19v-3h2v-2h2v-2h2l1.5-1.5',
      alert: 'M12 8v5M12 17h.01M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
      layers: 'M12 3 3 8l9 5 9-5-9-5ZM3 13l9 5 9-5',
      send: 'M4 12 21 4l-7 17-3-7-7-2Z',
      sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z',
      download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
      upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
      more: 'M5 12a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0M10.6 12a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0M16.2 12a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0',
    }

    function Glyph({ name, size = 16, color = 'currentColor', stroke = 1.6 }) {
      const d = PATHS[name] ?? PATHS.plug
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: color,
          strokeWidth: stroke,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block', flexShrink: 0 },
        },
        h('path', { d }),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 文案                                                                */
    /* ------------------------------------------------------------------ */

    const DICT = {
      zh: {
        panelLabel: '连接器',
        title: '连接器',
        subtitle: '给智能体用的连接池',
        search: '搜索连接',
        close: '关闭',
        cancel: '取消',
        save: '保存',
        saving: '保存中',
        edit: '编辑',
        remove: '删除',
        deleteConfirm: '确定删除这个连接？',
        test: '测试',
        testing: '测试中',
        testAll: '全部测试',
        add: '新建连接',
        empty: '还没有连接',
        emptyHint: '数据库、服务器、接口、消息机器人，都可以加进来。加好之后在对话里让智能体查就行。',
        emptySelection: '从左侧选择一个连接',
        emptySelectionHint: '这里不提供手动查询，查询请直接在对话里跟智能体说。',
        name: '连接名',
        namePlaceholder: '例如 prod-mysql',
        kind: '类型',
        basic: '基本信息',
        auth: '认证',
        advanced: '高级',
        keepSecret: '留空则沿用已保存的值',
        envHint: '推荐填环境变量名，密钥不进配置文件',
        tested: '可达',
        untested: '未测试',
        failed: '失败',
        saved: '已保存',
        deleted: '已删除',
        refresh: '刷新',
        copy: '复制',
        copied: '已复制',
        required: '必填',
        readonly: '只读',
        writable: '可写',
        loading: '加载中',
        loadFailed: '读取配置失败',
        connection: '连接信息',
        secret: '密钥',
        secretSet: '已配置',
        secretEnv: '环境变量',
        secretNone: '未设置',
        allowWriteOn: '允许写（需调用时再确认）',
        allowWriteOff: '只读',
        endpoint: '地址',
        copyPrompt: '复制示例提问',
      },
      en: {
        panelLabel: 'Connectors',
        title: 'Connectors',
        subtitle: 'Connections the agent can use',
        search: 'Search connections',
        close: 'Close',
        cancel: 'Cancel',
        save: 'Save',
        saving: 'Saving',
        edit: 'Edit',
        remove: 'Delete',
        deleteConfirm: 'Delete this connection?',
        test: 'Test',
        testing: 'Testing',
        testAll: 'Test all',
        add: 'New connection',
        empty: 'No connections yet',
        emptyHint: 'Databases, servers, APIs and chat bots all live here. Once added, just ask the agent.',
        emptySelection: 'Pick a connection',
        emptySelectionHint: 'There is no manual console here — ask the agent instead.',
        name: 'Name',
        namePlaceholder: 'e.g. prod-mysql',
        kind: 'Kind',
        basic: 'General',
        auth: 'Authentication',
        advanced: 'Advanced',
        keepSecret: 'Leave blank to keep the saved value',
        envHint: 'Prefer an env var name so secrets stay out of config',
        tested: 'reachable',
        untested: 'untested',
        failed: 'failed',
        saved: 'Saved',
        deleted: 'Deleted',
        refresh: 'Refresh',
        copy: 'Copy',
        copied: 'Copied',
        required: 'required',
        readonly: 'read-only',
        writable: 'writable',
        loading: 'Loading',
        loadFailed: 'Could not load configuration',
        connection: 'Connection',
        secret: 'Secret',
        secretSet: 'configured',
        secretEnv: 'env var',
        secretNone: 'not set',
        allowWriteOn: 'writes allowed (still confirmed per call)',
        allowWriteOff: 'read-only',
        endpoint: 'Endpoint',
        copyPrompt: 'Copy example prompt',
      },
    }

    let translate = null
    function t(key) {
      if (translate !== null) {
        try {
          const value = translate(key)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        } catch {
          /* 回退到内置词典 */
        }
      }
      return DICT.zh[key] ?? key
    }

    /* ------------------------------------------------------------------ */
    /* 类别                                                                */
    /* ------------------------------------------------------------------ */

    const CATEGORY = {
      database: { label: '数据库', icon: 'database', tint: '#0a84ff' },
      cache: { label: '缓存', icon: 'bolt', tint: '#ff453a' },
      server: { label: '服务器', icon: 'server', tint: '#30d158' },
      api: { label: '接口', icon: 'globe', tint: '#5e5ce6' },
      search: { label: '搜索', icon: 'wave', tint: '#ff9f0a' },
      message: { label: '消息', icon: 'chat', tint: '#bf5af2' },
      agent: { label: 'DSH 节点', icon: 'plug', tint: '#00c7be' },
      other: { label: '其它', icon: 'layers', tint: '#8e8e93' },
    }

    const KIND_ICON = {
      postgres: 'database',
      mysql: 'database',
      sqlite: 'database',
      redis: 'bolt',
      ssh: 'terminal',
      http: 'globe',
      tcp: 'server',
      elasticsearch: 'wave',
      dingtalk: 'chat',
      feishu: 'chat',
      wecom: 'chat',
      slack: 'chat',
      telegram: 'send',
      webhook: 'globe',
    }

    function categoryOf(manifest) {
      return CATEGORY[manifest?.category] ?? CATEGORY.other
    }

    /* ------------------------------------------------------------------ */
    /* 设计令牌                                                            */
    /* ------------------------------------------------------------------ */

    const T = {
      bg: 'var(--dsw-alias-bg-base, #ffffff)',
      layer1: 'var(--dsw-alias-bg-layer-1, #f5f5f7)',
      layer2: 'var(--dsw-alias-bg-layer-2, #ebebf0)',
      border: 'var(--dsw-alias-border-l1, rgba(0,0,0,.09))',
      border2: 'var(--dsw-alias-border-l2, rgba(0,0,0,.16))',
      text: 'var(--dsw-alias-label-primary, #1d1d1f)',
      dim: 'var(--dsw-alias-label-secondary, #6e6e73)',
      ok: 'var(--dsw-alias-state-success-primary, #34c759)',
      bad: 'var(--dsw-alias-state-error-primary, #ff3b30)',
      warn: 'var(--dsw-alias-state-warn-primary, #ff9f0a)',
      // 宿主 --dsw-alias-brand-primary 是中性色（深色下近白），不能当强调色用
      accent: '#0a84ff',
    }

    const CSS = `
      .wsc-root{--wsc-radius-sheet:20px;--wsc-radius-card:14px;
        --wsc-ease:cubic-bezier(.32,.72,0,1);
        --wsc-fill:color-mix(in srgb, ${T.text} 6%, transparent);
        --wsc-fill-strong:color-mix(in srgb, ${T.text} 10%, transparent);
        --wsc-hair:color-mix(in srgb, ${T.text} 11%, transparent);
        font:400 13px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei",sans-serif;
        color:${T.text};-webkit-font-smoothing:antialiased;letter-spacing:-.006em;}
      .wsc-root *,.wsc-root *::before,.wsc-root *::after{box-sizing:border-box;}
      .wsc-root ::-webkit-scrollbar{width:10px;height:10px;}
      .wsc-root ::-webkit-scrollbar-thumb{background:color-mix(in srgb,${T.text} 16%,transparent);
        border-radius:999px;border:3px solid transparent;background-clip:content-box;}
      .wsc-root ::-webkit-scrollbar-track{background:transparent;}
      .wsc-root button,.wsc-root input,.wsc-root textarea,.wsc-root select{font-family:inherit;}

      .wsc-backdrop{position:fixed;inset:0;z-index:960;display:flex;align-items:center;justify-content:center;
        background:rgba(0,0,0,.34);backdrop-filter:blur(3px) saturate(120%);
        animation:wsc-fade .22s var(--wsc-ease);}
      .wsc-sheet{display:flex;flex-direction:column;width:min(1060px,94vw);height:min(720px,88vh);
        background:${T.bg};border:1px solid ${T.border};border-radius:var(--wsc-radius-sheet);
        box-shadow:0 24px 70px rgba(0,0,0,.28),0 2px 8px rgba(0,0,0,.10);overflow:hidden;
        animation:wsc-rise .30s var(--wsc-ease);}
      @keyframes wsc-fade{from{opacity:0}to{opacity:1}}
  .wsc-peer-card{position:fixed;right:20px;bottom:20px;width:320px;z-index:2147483000;
  pointer-events:auto;border:1px solid var(--wsc-hair);border-radius:12px;background:${T.layer1};
  color:${T.text};box-shadow:0 10px 30px rgba(0,0,0,.28);padding:12px 14px;
  font-size:12.5px;line-height:1.6;animation:wsc-peer-in .2s var(--wsc-ease);}
  .wsc-peer-head{display:flex;align-items:baseline;gap:8px;}
  .wsc-peer-title{font-weight:600;}
  .wsc-peer-time{margin-left:auto;color:${T.dim};font-size:11px;}
  .wsc-peer-close{border:0;background:transparent;color:${T.dim};cursor:pointer;
  font-size:15px;line-height:1;padding:0 2px;}
  .wsc-peer-close:hover{color:${T.text};}
  .wsc-peer-line{margin-top:6px;word-break:break-all;}
  .wsc-peer-tag{font-weight:600;}
  @keyframes wsc-peer-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}

      @keyframes wsc-rise{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
      @media (prefers-reduced-motion:reduce){.wsc-backdrop,.wsc-sheet{animation:none}}

      .wsc-titlebar{display:flex;align-items:center;gap:14px;padding:16px 18px 14px 20px;
        border-bottom:1px solid var(--wsc-hair);flex-shrink:0;
        background:color-mix(in srgb,${T.bg} 92%,${T.layer1});}
      .wsc-appicon{display:grid;place-items:center;width:38px;height:38px;border-radius:10px;
        background:linear-gradient(150deg,color-mix(in srgb,${T.accent} 92%,#fff 8%),
        color-mix(in srgb,${T.accent} 62%,#000 38%));
        box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 3px 10px color-mix(in srgb,${T.accent} 34%,transparent);}
      .wsc-titles{display:flex;flex-direction:column;gap:1px;min-width:0;}
      .wsc-h1{font-size:15px;font-weight:590;letter-spacing:-.015em;line-height:1.3;}
      .wsc-h1-sub{font-size:11.5px;color:${T.dim};line-height:1.35;}
      .wsc-titlebar-spacer{flex:1;}

      .wsc-search{display:flex;align-items:center;gap:7px;height:30px;padding:0 11px;
        border-radius:8px;background:var(--wsc-fill);border:1px solid transparent;
        transition:border-color .16s var(--wsc-ease),background .16s var(--wsc-ease);}
      .wsc-search:focus-within{background:${T.bg};border-color:color-mix(in srgb,${T.accent} 60%,transparent);
        box-shadow:0 0 0 3px color-mix(in srgb,${T.accent} 18%,transparent);}
      .wsc-search input{width:150px;border:0;outline:0;background:transparent;color:${T.text};font-size:12.5px;}
      .wsc-search input::placeholder{color:color-mix(in srgb,${T.dim} 86%,transparent);}

      .wsc-iconbtn{display:grid;place-items:center;width:30px;height:30px;border:0;border-radius:8px;
        background:transparent;color:${T.dim};cursor:pointer;
        transition:background .16s var(--wsc-ease),color .16s var(--wsc-ease),transform .12s var(--wsc-ease);}
      .wsc-iconbtn:hover{background:var(--wsc-fill);color:${T.text};}
      .wsc-iconbtn:active{transform:scale(.94);}
      .wsc-iconbtn.round{border-radius:999px;background:var(--wsc-fill);}

      .wsc-body{display:flex;flex:1;min-height:0;}

      .wsc-side{width:272px;flex-shrink:0;display:flex;flex-direction:column;min-height:0;
        border-right:1px solid var(--wsc-hair);background:${T.layer1};}
      .wsc-side-head{display:flex;align-items:center;justify-content:space-between;padding:14px 14px 8px;gap:8px;}
      .wsc-side-title{font-size:11px;font-weight:600;letter-spacing:.055em;text-transform:uppercase;color:${T.dim};}
      .wsc-side-actions{display:flex;gap:4px;}
      .wsc-side-list{flex:1;overflow-y:auto;padding:2px 10px 14px;}
      .wsc-group{font-size:11px;font-weight:600;letter-spacing:.045em;
        color:color-mix(in srgb,${T.dim} 88%,transparent);padding:14px 8px 5px;text-transform:uppercase;}
      .wsc-row{display:flex;align-items:center;gap:10px;width:100%;padding:7px 9px;border:0;
        border-radius:9px;background:transparent;color:${T.text};text-align:left;cursor:pointer;
        transition:background .14s var(--wsc-ease);}
      .wsc-row:hover{background:var(--wsc-fill);}
      .wsc-row[data-active="true"]{background:color-mix(in srgb,${T.accent} 13%,transparent);}
      .wsc-row[data-active="true"] .wsc-row-name{color:color-mix(in srgb,${T.accent} 72%,${T.text} 28%);}
      .wsc-row-icon{display:grid;place-items:center;width:26px;height:26px;border-radius:7px;flex-shrink:0;
        background:color-mix(in srgb,currentColor 12%,transparent);}
      .wsc-row-body{display:flex;flex-direction:column;min-width:0;flex:1;}
      .wsc-row-name{font-size:12.5px;font-weight:510;letter-spacing:-.008em;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .wsc-row-meta{font-size:11px;color:${T.dim};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .wsc-dot{width:6px;height:6px;border-radius:999px;flex-shrink:0;
        background:color-mix(in srgb,${T.dim} 45%,transparent);}
      .wsc-dot[data-state="ok"]{background:${T.ok};box-shadow:0 0 0 3px color-mix(in srgb,${T.ok} 18%,transparent);}
      .wsc-dot[data-state="bad"]{background:${T.bad};box-shadow:0 0 0 3px color-mix(in srgb,${T.bad} 18%,transparent);}
      .wsc-dot[data-state="busy"]{background:${T.warn};animation:wsc-blink 1s infinite;}
      @keyframes wsc-blink{0%,100%{opacity:.35}50%{opacity:1}}
      .wsc-side-foot{padding:10px 14px;border-top:1px solid var(--wsc-hair);font-size:11px;color:${T.dim};}

      .wsc-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;background:${T.bg};}
      .wsc-main-scroll{flex:1;overflow-y:auto;padding:22px 26px 26px;}

      .wsc-detail-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;}
      .wsc-detail-icon{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;
        background:color-mix(in srgb,currentColor 12%,transparent);flex-shrink:0;}
      .wsc-detail-title{font-size:22px;font-weight:590;letter-spacing:-.022em;line-height:1.2;margin:0 0 3px;}
      .wsc-detail-sub{display:flex;align-items:center;gap:8px;font-size:12px;color:${T.dim};flex-wrap:wrap;}
      .wsc-detail-actions{display:flex;gap:7px;margin-left:auto;align-items:center;}

      .wsc-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border-radius:999px;
        font-size:11px;font-weight:510;background:var(--wsc-fill);color:${T.dim};white-space:nowrap;}
      .wsc-chip[data-tone="ok"]{background:color-mix(in srgb,${T.ok} 15%,transparent);color:color-mix(in srgb,${T.ok} 78%,${T.text} 22%);}
      .wsc-chip[data-tone="bad"]{background:color-mix(in srgb,${T.bad} 15%,transparent);color:color-mix(in srgb,${T.bad} 78%,${T.text} 22%);}
      .wsc-chip[data-tone="accent"]{background:color-mix(in srgb,${T.accent} 15%,transparent);color:${T.accent};}

      .wsc-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;
        padding:0 13px;border-radius:999px;border:1px solid transparent;background:var(--wsc-fill);
        color:${T.text};font-size:12.5px;font-weight:510;cursor:pointer;white-space:nowrap;
        transition:background .16s var(--wsc-ease),transform .12s var(--wsc-ease),filter .16s var(--wsc-ease);}
      .wsc-btn:hover{background:var(--wsc-fill-strong);}
      .wsc-btn:active{transform:scale(.975);}
      .wsc-btn[data-variant="primary"]{background:${T.accent};color:#fff;
        box-shadow:0 1px 2px color-mix(in srgb,${T.accent} 40%,transparent);}
      .wsc-btn[data-variant="primary"]:hover{filter:brightness(1.06);background:${T.accent};}
      .wsc-btn[data-variant="danger"]{background:color-mix(in srgb,${T.bad} 14%,transparent);color:${T.bad};}
      .wsc-btn[data-variant="danger"]:hover{background:${T.bad};color:#fff;}
      .wsc-btn[data-variant="ghost"]{background:transparent;color:${T.dim};}
      .wsc-btn[data-variant="ghost"]:hover{background:var(--wsc-fill);color:${T.text};}
      .wsc-btn:disabled{opacity:.45;cursor:default;transform:none;}

      .wsc-card{border:1px solid var(--wsc-hair);border-radius:var(--wsc-radius-card);
        background:${T.bg};overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04);margin-bottom:14px;}
      .wsc-card-head{display:flex;align-items:center;gap:10px;padding:11px 14px;
        border-bottom:1px solid var(--wsc-hair);background:color-mix(in srgb,${T.layer1} 55%,transparent);}
      .wsc-card-title{font-size:12.5px;font-weight:560;letter-spacing:-.006em;}
      .wsc-card-body{padding:12px 14px;}
      .wsc-card-hint{font-size:11.5px;color:${T.dim};line-height:1.5;}

      .wsc-kv{display:flex;align-items:flex-start;gap:14px;padding:7px 0;
        border-bottom:1px solid var(--wsc-hair);font-size:12.5px;}
      .wsc-kv:last-child{border-bottom:0;}
      .wsc-kv-key{width:104px;flex-shrink:0;color:${T.dim};}
      .wsc-kv-val{flex:1;min-width:0;word-break:break-all;}

      .wsc-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
        gap:9px;padding:48px 24px;text-align:center;}
      .wsc-empty-icon{display:grid;place-items:center;width:56px;height:56px;border-radius:16px;
        background:var(--wsc-fill);color:color-mix(in srgb,${T.dim} 90%,transparent);margin-bottom:2px;}
      .wsc-empty-title{font-size:14px;font-weight:560;letter-spacing:-.01em;}
      .wsc-empty-hint{font-size:12px;color:${T.dim};max-width:320px;line-height:1.5;}

      .wsc-form-head{display:flex;align-items:center;gap:10px;margin-bottom:16px;}
      .wsc-form-title{font-size:20px;font-weight:590;letter-spacing:-.02em;}
      .wsc-section{margin-bottom:16px;}
      .wsc-section-title{font-size:11px;font-weight:600;letter-spacing:.055em;text-transform:uppercase;
        color:${T.dim};padding:0 2px 7px;}
      .wsc-fieldset{border:1px solid var(--wsc-hair);border-radius:var(--wsc-radius-card);
        background:${T.bg};overflow:hidden;}
      .wsc-field{display:flex;align-items:center;justify-content:space-between;gap:14px;
        min-height:46px;padding:8px 14px;border-bottom:1px solid var(--wsc-hair);}
      .wsc-field:last-child{border-bottom:0;}
      .wsc-field-label{font-size:12.5px;font-weight:480;min-width:104px;flex-shrink:0;}
      .wsc-field-label span{color:${T.bad};margin-left:2px;}
      .wsc-field-body{flex:1;display:flex;flex-direction:column;align-items:flex-end;gap:3px;min-width:0;}
      .wsc-field-hint{font-size:10.5px;color:${T.dim};line-height:1.4;text-align:right;max-width:320px;}
      .wsc-input,.wsc-select{height:30px;padding:0 10px;width:100%;max-width:320px;border-radius:8px;
        border:1px solid transparent;background:var(--wsc-fill);color:${T.text};font-size:12.5px;
        outline:0;transition:border-color .16s var(--wsc-ease),box-shadow .16s var(--wsc-ease),background .16s var(--wsc-ease);}
      .wsc-input:focus,.wsc-select:focus{background:${T.bg};
        border-color:color-mix(in srgb,${T.accent} 62%,transparent);
        box-shadow:0 0 0 3px color-mix(in srgb,${T.accent} 16%,transparent);}
      .wsc-input::placeholder{color:color-mix(in srgb,${T.dim} 78%,transparent);}
  .wsc-textarea{height:auto;min-height:110px;max-width:none;padding:9px 11px;line-height:1.6;
  resize:vertical;font-family:inherit;}
  .wsc-routes{display:flex;flex-direction:column;gap:6px;margin-bottom:8px;}
  .wsc-route{display:grid;grid-template-columns:22px 1.5fr 1fr 1.2fr 30px;gap:6px;align-items:center;}
  .wsc-route-default{display:flex;align-items:center;justify-content:center;}
  .wsc-route-id{display:flex;flex-direction:column;gap:2px;min-width:0;}
  .wsc-route-title{font-size:10.5px;color:${T.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .wsc-route input[type="radio"]{accent-color:${T.accent};width:14px;height:14px;cursor:pointer;}
  .wsc-routes-empty{font-size:11.5px;color:${T.dim};padding:2px 0 4px;}
  .wsc-addrow{border:1px dashed var(--wsc-hair);border-radius:8px;background:transparent;color:${T.dim};
  font:inherit;font-size:12px;padding:6px 10px;cursor:pointer;width:100%;text-align:left;}
  .wsc-addrow:hover{color:${T.text};border-color:${T.border2};}

      .wsc-switch{position:relative;width:42px;height:25px;border-radius:999px;border:0;padding:0;
        background:color-mix(in srgb,${T.text} 16%,transparent);cursor:pointer;flex-shrink:0;
        transition:background .22s var(--wsc-ease);}
      .wsc-switch::after{content:"";position:absolute;top:2px;left:2px;width:21px;height:21px;
        border-radius:999px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.28);
        transition:transform .22s var(--wsc-ease);}
      .wsc-switch[data-on="true"]{background:${T.ok};}
      .wsc-switch[data-on="true"]::after{transform:translateX(17px);}
  .wsc-switch[data-size="sm"]{width:30px;height:18px;flex-shrink:0;}
  .wsc-switch[data-size="sm"]::after{width:14px;height:14px;top:2px;left:2px;}
  .wsc-switch[data-size="sm"][data-on="true"]::after{transform:translateX(12px);}
  .wsc-row-main{display:flex;align-items:center;gap:10px;flex:1;min-width:0;border:0;
  background:transparent;color:inherit;font:inherit;text-align:left;padding:0;cursor:pointer;}
  .wsc-row[data-disabled="true"] .wsc-row-name{color:${T.dim};}
      .wsc-kindgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;padding:2px 0 4px;}
      .wsc-kindcard{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:10px;
        border:1px solid transparent;background:var(--wsc-fill);cursor:pointer;text-align:left;color:${T.text};
        transition:background .16s var(--wsc-ease),box-shadow .16s var(--wsc-ease),transform .12s var(--wsc-ease);}
      .wsc-kindcard:hover{background:var(--wsc-fill-strong);}
      .wsc-kindcard:active{transform:scale(.985);}
      .wsc-kindcard[data-on="true"]{background:color-mix(in srgb,${T.accent} 14%,transparent);
        box-shadow:inset 0 0 0 1.5px color-mix(in srgb,${T.accent} 55%,transparent);}
      .wsc-kindcard-name{font-size:12px;font-weight:510;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .wsc-foot{display:flex;align-items:center;gap:8px;padding:10px 0 0;}
      .wsc-foot-spacer{flex:1;}

      .wsc-banner{display:flex;align-items:flex-start;gap:8px;margin-bottom:14px;padding:9px 12px;
        border-radius:10px;background:color-mix(in srgb,${T.bad} 12%,transparent);color:${T.bad};
        font-size:12px;line-height:1.5;word-break:break-word;}
      .wsc-banner[data-tone="ok"]{background:color-mix(in srgb,${T.ok} 13%,transparent);
        color:color-mix(in srgb,${T.ok} 78%,${T.text} 22%);}

      .wsc-toast{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:1200;
        display:flex;align-items:center;gap:7px;height:34px;padding:0 15px;border-radius:999px;
        background:color-mix(in srgb,${T.text} 90%,transparent);color:${T.bg};font-size:12.5px;font-weight:500;
        box-shadow:0 8px 26px rgba(0,0,0,.30);animation:wsc-toast .26s var(--wsc-ease);}

  .wsc-confirm{position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.38);pointer-events:auto;animation:wsc-fade .16s var(--wsc-ease);}
  .wsc-confirm-card{width:min(360px,calc(100% - 32px));background:${T.bg};border:1px solid var(--wsc-hair);
  border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.28);padding:16px;display:flex;flex-direction:column;gap:10px;}
  .wsc-confirm-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;}
  .wsc-confirm-body{font-size:12px;color:${T.dim};line-height:1.65;word-break:break-all;}
  .wsc-confirm-name{font-weight:600;color:${T.text};}
  .wsc-confirm-meta{margin-top:4px;color:${T.dim};}
  .wsc-confirm-hint{margin-top:8px;color:${T.dim};opacity:.85;}
  .wsc-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px;}
  @keyframes wsc-fade{from{opacity:0}to{opacity:1}}

      @keyframes wsc-toast{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translate(-50%,0)}}

      .wsc-menu{position:fixed;z-index:1100;min-width:190px;padding:5px;border-radius:10px;
        background:${T.bg};border:1px solid var(--wsc-hair);
        box-shadow:0 16px 40px rgba(0,0,0,.26),0 2px 8px rgba(0,0,0,.12);
        animation:wsc-menu-in .13s var(--wsc-ease);}
      @keyframes wsc-menu-in{from{opacity:0;transform:translateY(-3px) scale(.99)}to{opacity:1;transform:none}}
      .wsc-menu-item{display:flex;align-items:center;gap:9px;width:100%;height:28px;padding:0 9px;
        border:0;border-radius:6px;background:transparent;color:${T.text};font-size:12.5px;
        text-align:left;cursor:pointer;}
      .wsc-menu-item:hover{background:${T.accent};color:#fff;}
      .wsc-menu-item[data-danger="true"]:hover{background:${T.bad};color:#fff;}
      .wsc-menu-sep{height:1px;margin:4px 7px;background:var(--wsc-hair);}

      .wsc-skel{height:34px;border-radius:9px;background:var(--wsc-fill);
        animation:wsc-pulse 1.3s ease-in-out infinite;margin-bottom:8px;}
      @keyframes wsc-pulse{0%,100%{opacity:.5}50%{opacity:.95}}
      @media (max-width:920px){.wsc-side{width:216px;}.wsc-search input{width:110px;}}
    `

    /* ------------------------------------------------------------------ */
    /* 数据层                                                              */
    /* ------------------------------------------------------------------ */

    async function request(path, init) {
      const response = await fetch(API + path, {
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      const raw = await response.text()
      let payload = {}
      if (raw.trim() !== '') {
        try {
          payload = JSON.parse(raw)
        } catch {
          throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）`)
        }
      }
      if (!response.ok || payload?.error) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

    function ellipsis(text, max = 300) {
      const value = `${text ?? ''}`
      return value.length > max ? `${value.slice(0, max)}…` : value
    }

    const FALLBACK_KINDS = [
      {
        kind: 'postgres',
        label: 'PostgreSQL',
        category: 'database',
        defaultPort: 5432,
        fields: [
          { name: 'host', label: '主机', type: 'text', required: true },
          { name: 'port', label: '端口', type: 'number' },
          { name: 'database', label: '库名', type: 'text' },
          { name: 'user', label: '用户', type: 'text' },
          { name: 'passwordEnv', label: '密码环境变量', type: 'text' },
          { name: 'password', label: '密码', type: 'password' },
          { name: 'allowWrite', label: '允许写语句', type: 'boolean' },
        ],
        actions: [{ id: 'query', label: '执行 SQL', params: [{ name: 'sql', type: 'text', required: true }] }],
      },
      {
        kind: 'mysql',
        label: 'MySQL',
        category: 'database',
        defaultPort: 3306,
        fields: [
          { name: 'host', label: '主机', type: 'text', required: true },
          { name: 'port', label: '端口', type: 'number' },
          { name: 'database', label: '库名', type: 'text' },
          { name: 'user', label: '用户', type: 'text' },
          { name: 'passwordEnv', label: '密码环境变量', type: 'text' },
          { name: 'password', label: '密码', type: 'password' },
          { name: 'allowWrite', label: '允许写语句', type: 'boolean' },
        ],
        actions: [{ id: 'query', label: '执行 SQL', params: [{ name: 'sql', type: 'text', required: true }] }],
      },
      {
        kind: 'redis',
        label: 'Redis',
        category: 'cache',
        defaultPort: 6379,
        fields: [
          { name: 'host', label: '主机', type: 'text', required: true },
          { name: 'port', label: '端口', type: 'number' },
          { name: 'db', label: '库编号', type: 'number' },
          { name: 'passwordEnv', label: '密码环境变量', type: 'text' },
          { name: 'password', label: '密码', type: 'password' },
          { name: 'allowDangerous', label: '允许危险命令', type: 'boolean' },
        ],
        actions: [{ id: 'exec', label: '执行命令', params: [{ name: 'command', type: 'text', required: true }] }],
      },
      {
        kind: 'ssh',
        label: 'SSH',
        category: 'server',
        defaultPort: 22,
        fields: [
          { name: 'host', label: '主机', type: 'text', required: true },
          { name: 'port', label: '端口', type: 'number' },
          { name: 'user', label: '用户', type: 'text' },
          { name: 'passwordEnv', label: '密码环境变量', type: 'text' },
          { name: 'password', label: '密码', type: 'password' },
          { name: 'keyPath', label: '私钥路径', type: 'text' },
          { name: 'allowDestructive', label: '允许破坏性命令', type: 'boolean' },
        ],
        actions: [{ id: 'exec', label: '执行命令', params: [{ name: 'command', type: 'text', required: true }] }],
      },
      {
        kind: 'http',
        label: 'HTTP',
        category: 'api',
        fields: [
          { name: 'baseUrl', label: '基础地址', type: 'text', required: true },
          { name: 'tokenEnv', label: 'Token 环境变量', type: 'text' },
          { name: 'token', label: 'Token', type: 'password' },
        ],
        actions: [{ id: 'request', label: '发请求', params: [{ name: 'path', type: 'text' }] }],
      },
      {
        kind: 'tcp',
        label: 'TCP',
        category: 'server',
        fields: [
          { name: 'host', label: '主机', type: 'text', required: true },
          { name: 'port', label: '端口', type: 'number', required: true },
        ],
        actions: [],
      },
    ]

    function manifestsOf(state) {
      const list = Array.isArray(state?.kinds) ? state.kinds : []
      return list.length > 0 ? list : FALLBACK_KINDS
    }

    const manifestFor = (kinds, kind) => kinds.find((item) => item.kind === kind) ?? null

    /** 给用户的示例提问：直接复制到对话里就能让智能体干活。 */
    function examplePrompt(conn, manifest) {
      const name = conn.name
      switch (manifest?.category ?? 'other') {
        case 'database':
          return `用 ${name} 查一下：`
        case 'cache':
          return `用 ${name} 看一下这个 key：`
        case 'server':
          return `在 ${name} 上执行：`
        case 'message':
          return `用 ${name} 发一条消息：`
        case 'search':
          return `用 ${name} 搜一下：`
        case 'api':
          return `用 ${name} 请求这个接口：`
        default:
          return `用 ${name} 帮我查一下：`
      }
    }

    /* ------------------------------------------------------------------ */
    /* 基础组件                                                            */
    /* ------------------------------------------------------------------ */

    function Button({ variant = 'plain', icon, children, busy, ...rest }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'wsc-btn',
          'data-variant': variant,
          disabled: rest.disabled || busy,
          ...rest,
        },
        icon ? h(Glyph, { name: icon, size: 13 }) : null,
        children,
      )
    }

    function IconButton({ icon, title, size = 15, round, ...rest }) {
      return h(
        'button',
        { type: 'button', className: `wsc-iconbtn${round ? ' round' : ''}`, title, 'aria-label': title, ...rest },
        h(Glyph, { name: icon, size }),
      )
    }

    function Switch({ on, onChange, label, size }) {
      return h('button', {
        type: 'button',
        className: 'wsc-switch',
        'data-on': on ? 'true' : 'false',
        role: 'switch',
        'aria-checked': on,
        'aria-label': label,
        'data-size': size,
        onClick: () => onChange(!on),
      })
    }

    function normalizeRouteValue(value) {
      if (Array.isArray(value)) {
        return value.map((row) => ({
          id: typeof row?.id === 'string' ? row.id : '',
          label: typeof row?.label === 'string' ? row.label : '',
          purpose: typeof row?.purpose === 'string' ? row.purpose : '',
          default: row?.default === true,
        }))
      }
      if (typeof value !== 'string') return []
      return value
        .split(/\r?\n/)
        .map((raw) => raw.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .map((line) => {
          const isDefault = line.startsWith('*')
          const parts = (isDefault ? line.slice(1) : line).split('|').map((part) => part.trim())
          return {
            id: parts[0] ?? '',
            label: parts[1] ?? '',
            purpose: parts[2] ?? '',
            default: isDefault,
          }
        })
        .filter((row) => row.id !== '')
    }

    function RouteTable({ value, sessions, onChange }) {
      const rows = Array.isArray(value) ? value : []
      const setRow = (index, patch) => onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
      const removeRow = (index) => onChange(rows.filter((_, i) => i !== index))
      const addRow = () => onChange([...rows, { id: '', label: '', purpose: '', default: rows.length === 0 }])
      const makeDefault = (index) => onChange(rows.map((row, i) => ({ ...row, default: i === index })))

      const titleOf = (id) => {
        const found = (sessions ?? []).find((item) => item.sessionId === id)
        return found === undefined ? '' : found.title ?? ''
      }

      const input = (row, index, key, placeholder, extra = {}) =>
        h('input', {
          className: 'wsc-input',
          value: row[key] ?? '',
          placeholder,
          list: key === 'id' ? 'wsconn-session-list' : undefined,
          title: key === 'id' ? titleOf(row.id) : undefined,
          onChange: (event) => setRow(index, { [key]: event.target.value }),
          style: { maxWidth: 'none', ...(extra.style ?? {}) },
        })

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'wsc-routes' },
          rows.length === 0
            ? h('div', { className: 'wsc-routes-empty' }, '还没有会话——下面点「添加会话」，填本机的 sessionId')
            : null,
          rows.map((row, index) =>
            h(
              'div',
              { key: index, className: 'wsc-route' },
              h(
                'label',
                { className: 'wsc-route-default', title: '默认会话（不指定 sessionId 时投给它）' },
                h('input', {
                  type: 'radio',
                  name: 'wsconn-route-default',
                  checked: row.default === true,
                  onChange: () => makeDefault(index),
                }),
              ),
              h(
                'div',
                { className: 'wsc-route-id' },
                input(row, index, 'id', '选择或输入 sessionId', { style: { fontFamily: 'ui-monospace, monospace' } }),
                h('div', { className: 'wsc-route-title' }, titleOf(row.id) || '—'),
              ),
              input(row, index, 'label', '名称，如 闲聊'),
              input(row, index, 'purpose', '用途，如 兜底任务'),
              h(
                'button',
                { type: 'button', className: 'wsc-iconbtn', title: '删除这一行', onClick: () => removeRow(index) },
                h(Glyph, { name: 'trash', size: 13 }),
              ),
            ),
          ),
        ),
        h('datalist', { id: 'wsconn-session-list' },
          (sessions ?? []).map((item) =>
            h(
              'option',
              { key: item.sessionId, value: item.sessionId },
              `${item.title || '(无标题)'} · ${new Date(item.updatedAt).toLocaleString()}${item.blank ? ' · 空会话' : item.running ? ' · 运行中' : ''} · ${item.sessionId.slice(0, 14)}…`,
            ),
          ),
        ),
        h(
          'button',
          { type: 'button', className: 'wsc-addrow', onClick: addRow },
          '＋ 添加会话',
        ),
      )
    }

    function ConfirmDelete({ conn, onCancel, onConfirm }) {
      const [busy, setBusy] = useState(false)
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onCancel()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onCancel])

      const confirm = async () => {
        setBusy(true)
        try {
          await onConfirm()
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        {
          className: 'wsc-confirm',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onCancel()
          },
        },
        h(
          'div',
          { className: 'wsc-confirm-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': '删除连接' },
          h('div', { className: 'wsc-confirm-title' }, h(Glyph, { name: 'alert', size: 15, color: T.bad }), '删除连接'),
          h(
            'div',
            { className: 'wsc-confirm-body' },
            '确定删除 ',
            h('span', { className: 'wsc-confirm-name' }, conn.name),
            ' 吗？',
            conn.endpoint ? h('div', { className: 'wsc-confirm-meta' }, conn.endpoint) : null,
            h('div', { className: 'wsc-confirm-hint' }, '配置会从 profile 里移除，密码 / Token 一并删除，不能撤销。'),
          ),
          h(
            'div',
            { className: 'wsc-confirm-actions' },
            h(Button, { onClick: onCancel, children: '取消' }),
            h(Button, { variant: 'danger', busy, onClick: confirm, children: busy ? '删除中…' : '删除' }),
          ),
        ),
      )
    }

    function Banner({ tone = 'bad', children }) {
      return h(
        'div',
        { className: 'wsc-banner', 'data-tone': tone },
        h(Glyph, { name: tone === 'bad' ? 'alert' : 'check', size: 14 }),
        h('span', { style: { flex: 1 } }, children),
      )
    }

    function EmptyState({ icon = 'plug', title, hint, action }) {
      return h(
        'div',
        { className: 'wsc-empty' },
        h('div', { className: 'wsc-empty-icon' }, h(Glyph, { name: icon, size: 24 })),
        h('div', { className: 'wsc-empty-title' }, title),
        hint ? h('div', { className: 'wsc-empty-hint' }, hint) : null,
        action ? h('div', { style: { marginTop: 6 } }, action) : null,
      )
    }

    function Field({ label, hint, required, children }) {
      return h(
        'div',
        { className: 'wsc-field' },
        h('div', { className: 'wsc-field-label' }, label, required ? h('span', null, '*') : null),
        h(
          'div',
          { className: 'wsc-field-body' },
          children,
          hint ? h('div', { className: 'wsc-field-hint' }, hint) : null,
        ),
      )
    }

    function ContextMenu({ x, y, items, onClose }) {
      const ref = useRef(null)

      useEffect(() => {
        const onDown = (event) => {
          if (ref.current !== null && ref.current.contains(event.target)) return
          onClose()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('mousedown', onDown, true)
        window.addEventListener('keydown', onKey)
        window.addEventListener('resize', onClose)
        return () => {
          window.removeEventListener('mousedown', onDown, true)
          window.removeEventListener('keydown', onKey)
          window.removeEventListener('resize', onClose)
        }
      }, [onClose])

      const height = Math.min(items.length * 30 + 12, 320)
      const left = Math.max(8, Math.min(x, (window.innerWidth || 1280) - 200 - 8))
      const top = Math.max(8, Math.min(y, (window.innerHeight || 800) - height - 8))

      return h(
        'div',
        { ref, className: 'wsc-menu', style: { left, top } },
        items
          .filter((item) => item !== null && item !== undefined)
          .map((item, index) =>
            item.separator === true
              ? h('div', { key: `sep-${index}`, className: 'wsc-menu-sep' })
              : h(
                  'button',
                  {
                    key: item.id ?? `item-${index}`,
                    type: 'button',
                    className: 'wsc-menu-item',
                    'data-danger': item.danger === true ? 'true' : 'false',
                    onClick: () => {
                      onClose()
                      item.onSelect?.()
                    },
                  },
                  h(Glyph, { name: item.icon ?? 'chevron', size: 13 }),
                  h('span', { style: { flex: 1 } }, item.label),
                ),
          ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 连接详情（纯管理，不执行）                                            */
    /* ------------------------------------------------------------------ */

    function Detail({ conn, manifest, status, onToast, onTest, onEdit, onRemove, onToggle }) {
      const cat = categoryOf(manifest)
      const [testing, setTesting] = useState(false)
      const state = status?.[conn.name]
      const secretFields = manifest?.secretFields ?? []

      const runTest = async () => {
        setTesting(true)
        try {
          await onTest(conn)
        } finally {
          setTesting(false)
        }
      }

      // 右栏只放连接信息：属性看这里，改就走「编辑」
      const rows = []
      rows.push(['类型', manifest?.label ?? conn.kind])
      if (conn.endpoint) rows.push([t('endpoint'), conn.endpoint])
      for (const field of manifest?.fields ?? []) {
        if (secretFields.includes(field.name) || field.type === 'password') continue
        if (field.name.endsWith('Env')) continue
        const value = conn[field.name]
        if (value === undefined || value === null || value === '') continue
        if (typeof value === 'boolean') {
          rows.push([field.label ?? field.name, value ? t('allowWriteOn') : '否'])
          continue
        }
        if (field.name === 'allowWrite') continue
        rows.push([field.label ?? field.name, `${value}`])
      }
      if (manifest?.category === 'database') {
        rows.push([
          '读写',
          conn.allowWrite === true ? h('span', { className: 'wsc-chip', 'data-tone': 'bad' }, t('writable')) : t('readonly'),
        ])
      }
      const secret = conn.hasPassword
        ? t('secretSet')
        : conn.hasToken
          ? t('secretSet')
          : conn.passwordEnv
            ? `${t('secretEnv')} ${conn.passwordEnv}`
            : conn.tokenEnv
              ? `${t('secretEnv')} ${conn.tokenEnv}`
              : t('secretNone')
      rows.push([t('secret'), secret])
      if (conn.notes !== undefined)
        rows.push([
          '说明',
          h('span', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.6 } }, conn.notes),
        ])

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'wsc-detail-head' },
          h(
            'span',
            { className: 'wsc-detail-icon', style: { color: cat.tint } },
            h(Glyph, { name: KIND_ICON[conn.kind] ?? cat.icon, size: 22, stroke: 1.7 }),
          ),
          h(
            'div',
            { style: { minWidth: 0 } },
            h('h2', { className: 'wsc-detail-title' }, conn.name),
            h(
              'div',
              { className: 'wsc-detail-sub' },
              h('span', null, manifest?.label ?? conn.kind),
              conn.endpoint ? h('span', null, '·') : null,
              conn.endpoint
                ? h(
                    'span',
                    { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 } },
                    conn.endpoint,
                  )
                : null,
              state
                ? h(
                    'span',
                    { className: 'wsc-chip', 'data-tone': state.state === 'ok' ? 'ok' : state.state === 'bad' ? 'bad' : 'plain' },
                    state.state === 'busy' ? t('testing') : state.state === 'ok' ? t('tested') : t('failed'),
                  )
                : null,
              conn.disabled === true
                ? h('span', { className: 'wsc-chip', 'data-tone': 'bad' }, '已禁用')
                : null,
            ),
          ),
          h(
            'div',
            { className: 'wsc-detail-actions' },
            h(Button, { icon: 'wave', busy: testing, onClick: runTest, children: testing ? t('testing') : t('test') }),
            h(Button, { icon: 'edit', onClick: () => onEdit(conn), children: t('edit') }),
            h(Button, { variant: 'danger', icon: 'trash', onClick: () => onRemove(conn), children: t('remove') }),
          ),
        ),

        state && state.detail ? h(Banner, { tone: state.state === 'ok' ? 'ok' : 'bad' }, ellipsis(state.detail, 400)) : null,

        h(
          'div',
          { className: 'wsc-card' },
          h(
            'div',
            { className: 'wsc-card-head' },
            h(Glyph, { name: 'layers', size: 14, color: T.dim }),
            h('span', { className: 'wsc-card-title' }, t('connection')),
          ),
          h(
            'div',
            { className: 'wsc-card-body' },
            rows.map(([key, value], index) =>
              h(
                'div',
                { key: `${key}-${index}`, className: 'wsc-kv' },
                h('div', { className: 'wsc-kv-key' }, key),
                h('div', { className: 'wsc-kv-val' }, value),
              ),
            ),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 表单                                                               */
    /* ------------------------------------------------------------------ */

    function buildForm(conn, manifest) {
      const form = { name: conn?.name ?? '', kind: conn?.kind ?? manifest?.kind ?? '' }
      for (const field of manifest?.fields ?? []) {
        const value = conn?.[field.name]
        if (field.type === 'routes') {
          form[field.name] = normalizeRouteValue(value)
          continue
        }
        form[field.name] =
          typeof value === 'boolean' ? value : value === undefined || value === null ? '' : String(value)
      }
      if (manifest?.defaultPort !== undefined && form.port === '') form.port = String(manifest.defaultPort)
      return form
    }

    function Form({ conn, kinds, onCancel, onSaved, onToast }) {
      const isNew = !conn
      const [kind, setKind] = useState(conn?.kind ?? kinds[0]?.kind ?? 'postgres')
      const manifest = manifestFor(kinds, kind)
      const [form, setForm] = useState(() => ({ ...buildForm(conn, manifest), notes: conn?.notes ?? '' }))
      const [busy, setBusy] = useState(false)
      const [testing, setTesting] = useState(false)
      const [error, setError] = useState(null)
      const [test, setTest] = useState(null)
      const [sessions, setSessions] = useState([])

      useEffect(() => {
        let alive = true
        request('/sessions')
          .then((payload) => {
            if (alive) setSessions(Array.isArray(payload?.sessions) ? payload.sessions : [])
          })
          .catch(() => {
            if (alive) setSessions([])
          })
        return () => {
          alive = false
        }
      }, [])

      useEffect(() => {
        setForm((prev) => ({
          ...buildForm(conn, manifestFor(kinds, kind)),
          notes: prev.notes ?? conn?.notes ?? '',
        }))
        setTest(null)
      }, [kind])

      const setValue = (name, value) => setForm((prev) => ({ ...prev, [name]: value }))

      const payload = () => {
        const body = { name: `${form.name ?? ''}`.trim(), kind }
    body.notes = `${form.notes ?? ''}`.trim()
        for (const field of manifest?.fields ?? []) {
          const raw = form[field.name]
          if (field.type === 'routes') {
            const rows = (Array.isArray(raw) ? raw : [])
              .filter((row) => `${row?.id ?? ''}`.trim() !== '')
              .map((row) => ({
                id: `${row.id}`.trim(),
                label: `${row.label ?? ''}`.trim(),
                purpose: `${row.purpose ?? ''}`.trim(),
                default: row.default === true,
              }))
            if (rows.length > 0) body.routes = rows
            continue
          }
          if (field.type === 'boolean') {
            if (raw === true) body[field.name] = true
            continue
          }
          const text = `${raw ?? ''}`.trim()
          if (text === '') continue
          body[field.name] = field.type === 'number' ? Number(text) : text
        }
        return body
      }

      const runTest = async () => {
        setTesting(true)
        setError(null)
        setTest(null)
        try {
          const connection = payload()
          const response = isNew
            ? await post('/test', { name: connection.name || 'draft', connection })
            : await post('/test', { name: conn.name, connection })
          setTest(response)
        } catch (err) {
          setTest({ ok: false, error: `${err?.message ?? err}` })
        } finally {
          setTesting(false)
        }
      }

      const save = async () => {
        setBusy(true)
        setError(null)
        try {
          const connection = payload()
          if (connection.name === '') throw new Error(`${t('name')} ${t('required')}`)
          const response = await post('/connection', {
            action: isNew ? 'add' : 'update',
            name: isNew ? connection.name : conn.name,
            connection,
          })
          onToast(response?.message ?? t('saved'))
          await onSaved(isNew ? connection.name : conn.name)
        } catch (err) {
          setError(`${err?.message ?? err}`)
        } finally {
          setBusy(false)
        }
      }

      const allFields = manifest?.fields ?? []
      const claimed = new Set()
      const take = (predicate) => {
        const picked = []
        for (const field of allFields) {
          if (claimed.has(field.name)) continue
          if (!predicate(field)) continue
          claimed.add(field.name)
          picked.push(field)
        }
        return picked
      }
      const GENERAL = ['host', 'port', 'database', 'user', 'baseUrl', 'webhook', 'file', 'botToken', 'chatId', 'db', 'path']
      const groups = [
        { key: 'general', title: t('basic'), fields: take((f) => GENERAL.includes(f.name)) },
        { key: 'auth', title: t('auth'), fields: take((f) => /password|secret|token|key/i.test(f.name)) },
        { key: 'advanced', title: t('advanced'), fields: take((f) => /allow|timeout|ssl|tls|verify|db|chat|channel/i.test(f.name)) },
        { key: 'more', title: '其它', fields: take(() => true) },
      ]

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'wsc-form-head' },
          h('div', { className: 'wsc-form-title' }, isNew ? t('add') : conn.name),
          h('span', { style: { flex: 1 } }),
          test
            ? h(
                'span',
                { className: 'wsc-chip', 'data-tone': test.ok ? 'ok' : 'bad' },
                test.ok ? t('tested') : t('failed'),
              )
            : null,
          h(Button, { icon: 'wave', busy: testing, onClick: runTest, children: testing ? t('testing') : t('test') }),
        ),
        error ? h(Banner, null, error) : null,
        test
          ? h(Banner, { tone: test.ok ? 'ok' : 'bad' }, ellipsis(test.ok ? test.detail ?? '' : test.error ?? '', 400))
          : null,

        h(
          'div',
          { className: 'wsc-section' },
          h('div', { className: 'wsc-section-title' }, t('kind')),
          ['agent', 'database', 'cache', 'server', 'api', 'search', 'message', 'other'].map((categoryKey) => {
            const items = kinds.filter((item) => {
              const key = typeof item.category === 'string' ? item.category : 'other'
              return (CATEGORY[key] === undefined ? 'other' : key) === categoryKey
            })
            if (items.length === 0) return null
            return h(
              'div',
              { key: categoryKey, className: 'wsc-kindgroup' },
              h('div', { className: 'wsc-group' }, CATEGORY[categoryKey]?.label ?? categoryKey),
              h(
                'div',
                { className: 'wsc-kindgrid' },
                items.map((item) => {
                  const cat = categoryOf(item)
                  return h(
                    'button',
                    {
                      key: item.kind,
                      type: 'button',
                      className: 'wsc-kindcard',
                      'data-on': item.kind === kind ? 'true' : 'false',
                      onClick: () => setKind(item.kind),
                      title: cat.label,
                    },
                    h(Glyph, { name: KIND_ICON[item.kind] ?? cat.icon, size: 15, color: cat.tint }),
                    h('span', { className: 'wsc-kindcard-name' }, item.label ?? item.kind),
                  )
                }),
              ),
            )
          }),
        ),

        h(
          'div',
          { className: 'wsc-section' },
          h('div', { className: 'wsc-section-title' }, t('name')),
          h(
            'div',
            { className: 'wsc-fieldset' },
            h(
              Field,
              { label: t('name'), required: true },
              h('input', {
                className: 'wsc-input',
                value: form.name ?? '',
                placeholder: t('namePlaceholder'),
                onChange: (event) => setValue('name', event.target.value),
              }),
            ),
          ),
        ),

        h(
          'div',
          { className: 'wsc-section' },
          h('div', { className: 'wsc-section-title' }, '附加信息（智能体可见）'),
          h(
            'div',
            { className: 'wsc-fieldset' },
            h(
              Field,
              { label: '说明', hint: '比如常用目录、会话 id 是干什么的、注意事项' },
              h('textarea', {
                className: 'wsc-input wsc-textarea',
                rows: 6,
                value: form.notes ?? '',
                placeholder: '例如：\n常用目录 /data/app/logs\n会话 session-xxx 用于前端联调',
                onChange: (event) => setValue('notes', event.target.value),
                style: { resize: 'vertical', padding: '7px 9px', lineHeight: 1.5, fontFamily: 'inherit' },
              }),
            ),
          ),
        ),

        groups
          .filter((group) => group.fields.length > 0)
          .map((group) =>
            h(
              'div',
              { key: group.key, className: 'wsc-section' },
              h('div', { className: 'wsc-section-title' }, group.title),
              h(
                'div',
                { className: 'wsc-fieldset' },
                group.fields.map((field) => {
                  const value = form[field.name]
                  const hint =
                    field.hint ??
                    (/Env$/.test(field.name) ? t('envHint') : undefined) ??
                    (field.type === 'password' && !isNew ? t('keepSecret') : undefined)
                  if (field.type === 'boolean') {
                    return h(
                      Field,
                      { key: field.name, label: field.label ?? field.name, hint },
                      h(Switch, {
                        on: value === true,
                        label: field.label ?? field.name,
                        onChange: (next) => setValue(field.name, next),
                      }),
                    )
                  }
                  if (field.type === 'routes') {
                    return h(
                      Field,
                      { key: field.name, label: field.label ?? field.name, hint, required: field.required },
                      h(RouteTable, {
                        value: Array.isArray(form[field.name]) ? form[field.name] : [],
                        sessions,
                        onChange: (next) => setValue(field.name, next),
                      }),
                    )
                  }
                  if (field.type === 'textarea') {
                    return h(
                      Field,
                      { key: field.name, label: field.label ?? field.name, hint, required: field.required },
                      h('textarea', {
                        className: 'wsc-input wsc-textarea',
                        rows: 4,
                        value: value ?? '',
                        placeholder: field.placeholder ?? '',
                        onChange: (event) => setValue(field.name, event.target.value),
                      }),
                    )
                  }
                  if (Array.isArray(field.options) && field.options.length > 0) {
                    return h(
                      Field,
                      { key: field.name, label: field.label ?? field.name, hint, required: field.required },
                      h(
                        'select',
                        {
                          className: 'wsc-select',
                          value: value ?? '',
                          onChange: (event) => setValue(field.name, event.target.value),
                        },
                        field.options.map((option) => {
                          const id = typeof option === 'string' ? option : option.value
                          const label = typeof option === 'string' ? option : option.label
                          return h('option', { key: id, value: id }, label)
                        }),
                      ),
                    )
                  }
                  return h(
                    Field,
                    { key: field.name, label: field.label ?? field.name, hint, required: field.required },
                    h('input', {
                      className: 'wsc-input',
                      type: field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text',
                      value: value ?? '',
                      placeholder: field.placeholder ?? '',
                      onChange: (event) => setValue(field.name, event.target.value),
                    }),
                  )
                }),
              ),
            ),
          ),

        h(
          'div',
          { className: 'wsc-foot' },
          h(Button, { variant: 'ghost', onClick: onCancel, children: t('cancel') }),
          h('span', { className: 'wsc-foot-spacer' }),
          h(Button, { variant: 'primary', busy, onClick: save, children: busy ? t('saving') : t('save') }),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 面板                                                                */
    /* ------------------------------------------------------------------ */

    function Panel({ onClose }) {
      const [state, setState] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [selected, setSelected] = useState(null)
      const [editing, setEditing] = useState(null) // { conn } | { conn: null } | null
      const [query, setQuery] = useState('')
      const [status, setStatus] = useState({})
      const [toast, setToast] = useState(null)
      const [menu, setMenu] = useState(null)
      const searchRef = useRef(null)

      const notify = useCallback((message) => {
        setToast(message)
        window.setTimeout(() => setToast((current) => (current === message ? null : current)), 2200)
      }, [])

      const load = useCallback(async () => {
        try {
          const payload = await request('/state')
          setState(payload)
          setError(null)
          return payload
        } catch (err) {
          setError(`${err?.message ?? err}`)
          return null
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const kinds = useMemo(() => manifestsOf(state), [state])
      const connections = state?.connections ?? []

      const testOne = useCallback(async (conn) => {
        setStatus((prev) => ({ ...prev, [conn.name]: { state: 'busy' } }))
        try {
          const response = await post('/test', { name: conn.name })
          setStatus((prev) => ({
            ...prev,
            [conn.name]: response.ok
              ? { state: 'ok', detail: response.detail }
              : { state: 'bad', detail: response.error },
          }))
        } catch (err) {
          setStatus((prev) => ({ ...prev, [conn.name]: { state: 'bad', detail: `${err?.message ?? err}` } }))
        }
      }, [])

      const testAll = useCallback(async () => {
        for (const conn of connections) await testOne(conn)
      }, [connections, testOne])

      const fileRef = useRef(null)

      const exportConfig = useCallback(async () => {
        try {
          const response = await fetch('/wsconn/api/export')
          const payload = await response.json()
          if (!response.ok) throw new Error(payload?.error ?? `导出失败（${response.status}）`)
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = `connector-${new Date().toISOString().slice(0, 10)}.json`
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
          notify(`已导出 ${payload?.connections?.length ?? 0} 个连接（含密码，注意保管）`)
        } catch (err) {
          notify(`导出失败：${err?.message ?? err}`)
        }
      }, [notify])

      const importFile = useCallback(
        async (event) => {
          const file = event.target?.files?.[0]
          if (event.target) event.target.value = ''
          if (file === undefined) return
          try {
            const payload = JSON.parse(await file.text())
            const result = await post('/import', { ...payload, mode: 'merge' })
            const failed = result?.errors?.length ?? 0
            notify(
              `导入完成：新增 ${result?.added?.length ?? 0}，更新 ${result?.updated?.length ?? 0}${failed > 0 ? `，失败 ${failed}` : ''}`,
            )
            if (failed > 0) console.warn('[ws-connections] 导入失败项', result.errors)
            await load()
          } catch (err) {
            notify(`导入失败：${err?.message ?? err}`)
          }
        },
        [load, notify],
      )

      const toggleConnection = useCallback(
        async (conn, nextDisabled) => {
          const disabled = typeof nextDisabled === 'boolean' ? nextDisabled : conn.disabled !== true
          try {
            await post('/connection', { action: 'toggle', name: conn.name, disabled })
            notify(`${disabled ? '已禁用' : '已启用'} · ${conn.name}`)
            await load()
          } catch (err) {
            notify(`${err?.message ?? err}`)
          }
        },
        [load, notify],
      )

      const [confirmDelete, setConfirmDelete] = useState(null)

      const requestRemove = useCallback((conn) => setConfirmDelete(conn), [])

      const removeConnection = useCallback(
        async (conn) => {
          try {
            await post('/connection', { action: 'delete', name: conn.name })
            notify(`${t('deleted')} · ${conn.name}`)
            setSelected((current) => (current === conn.name ? null : current))
            await load()
          } catch (err) {
            notify(`${err?.message ?? err}`)
          }
        },
        [load, notify],
      )

      useEffect(() => {
        const onKey = (event) => {
          const meta = event.metaKey || event.ctrlKey
          if (event.key === 'Escape') {
            if (menu !== null) {
              setMenu(null)
              return
            }
            if (editing !== null) {
              setEditing(null)
              return
            }
            onClose()
          }
          if (meta && event.key.toLowerCase() === 'k') {
            event.preventDefault()
            searchRef.current?.focus()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [editing, menu, onClose])

      const filtered = useMemo(() => {
        const text = query.trim().toLowerCase()
        if (text === '') return connections
        return connections.filter((conn) =>
          [conn.name, conn.kind, conn.endpoint].some((field) => `${field ?? ''}`.toLowerCase().includes(text)),
        )
      }, [connections, query])

      const grouped = useMemo(() => {
        const map = new Map()
        for (const conn of filtered) {
          const key = manifestFor(kinds, conn.kind)?.category ?? 'other'
          if (!map.has(key)) map.set(key, [])
          map.get(key).push(conn)
        }
        const order = ['agent', 'database', 'cache', 'server', 'search', 'api', 'message', 'other']
        return order.filter((key) => map.has(key)).map((key) => ({ key, items: map.get(key) }))
      }, [filtered, kinds])

      const current = connections.find((conn) => conn.name === selected) ?? null
      const manifest = current === null ? null : manifestFor(kinds, current.kind)

      const sidebar = h(
        'aside',
        { className: 'wsc-side' },
        h(
          'div',
          { className: 'wsc-side-head' },
          h('span', { className: 'wsc-side-title' }, `${connections.length} 个连接`),
          h(
            'div',
            { className: 'wsc-side-actions' },
            h('input', {
              type: 'file',
              accept: 'application/json,.json',
              style: { display: 'none' },
              ref: fileRef,
              onChange: importFile,
            }),
            h(IconButton, { icon: 'wave', title: t('testAll'), size: 15, onClick: testAll }),
            h(IconButton, { icon: 'download', title: '导出配置（JSON，含密码）', size: 15, onClick: exportConfig }),
            h(IconButton, { icon: 'upload', title: '导入配置（JSON 文件）', size: 15, onClick: () => fileRef.current?.click() }),
            h(IconButton, { icon: 'plus', title: t('add'), size: 15, onClick: () => setEditing({ conn: null }) }),
          ),
        ),
        h(
          'div',
          { className: 'wsc-side-list' },
          loading
            ? [0, 1, 2, 3].map((index) => h('div', { key: index, className: 'wsc-skel' }))
            : grouped.map((group) =>
                h(
                  'div',
                  { key: group.key },
                  h('div', { className: 'wsc-group' }, CATEGORY[group.key]?.label ?? group.key),
                  group.items.map((conn) => {
                    const itemManifest = manifestFor(kinds, conn.kind)
                    const cat = categoryOf(itemManifest)
                    return h(
                      'div',
                      {
                        key: conn.name,
                        className: 'wsc-row',
                        'data-active': conn.name === selected ? 'true' : 'false',
                        'data-disabled': conn.disabled === true ? 'true' : 'false',
                        onContextMenu: (event) => {
                          event.preventDefault()
                          setMenu({ x: event.clientX, y: event.clientY, conn })
                        },
                      },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'wsc-row-main',
                          onClick: () => {
                            setSelected(conn.name)
                            setEditing(null)
                          },
                        },
                        h(
                          'span',
                          { className: 'wsc-row-icon', style: { color: conn.disabled === true ? T.dim : cat.tint } },
                          h(Glyph, { name: KIND_ICON[conn.kind] ?? cat.icon, size: 14 }),
                        ),
                        h(
                          'span',
                          { className: 'wsc-row-body' },
                          h('span', { className: 'wsc-row-name' }, conn.name),
                          h('span', { className: 'wsc-row-meta' }, itemManifest?.label ?? conn.kind),
                        ),
                      ),
                      h(Switch, {
                        on: conn.disabled !== true,
                        size: 'sm',
                        label: `启用 ${conn.name}`,
                        onChange: (next) => toggleConnection(conn, !next),
                      }),
                    )
                  }),
                ),
              ),
          !loading && connections.length === 0
            ? h('div', { style: { padding: '18px 10px' } }, h('div', { className: 'wsc-empty-hint' }, t('emptyHint')))
            : null,
        ),
        h('div', { className: 'wsc-side-foot' }, h('span', null, `${kinds.length} 种类型可连`)),
      )

      let main
      if (editing !== null) {
        main = h(Form, {
          conn: editing.conn ?? null,
          kinds,
          onToast: notify,
          onCancel: () => setEditing(null),
          onSaved: async (name) => {
            await load()
            setEditing(null)
            setSelected(name)
          },
        })
      } else if (current !== null) {
        main = h(Detail, {
          conn: current,
          manifest,
          status,
          onToast: notify,
          onTest: testOne,
          onEdit: (conn) => setEditing({ conn }),
          onRemove: requestRemove,
          onToggle: toggleConnection,
        })
      } else {
        main = h(EmptyState, {
          icon: 'plug',
          title: connections.length === 0 ? t('empty') : t('emptySelection'),
          hint: connections.length === 0 ? t('emptyHint') : t('emptySelectionHint'),
          action: h(Button, {
            variant: 'primary',
            icon: 'plus',
            onClick: () => setEditing({ conn: null }),
            children: t('add'),
          }),
        })
      }

      const menuItems =
        menu === null
          ? []
          : [
              { id: 'props', icon: 'edit', label: t('edit'), onSelect: () => setEditing({ conn: menu.conn }) },
              { id: 'test', icon: 'wave', label: t('test'), onSelect: () => testOne(menu.conn) },
              {
                id: 'copy',
                icon: 'copy',
                label: t('copyPrompt'),
                onSelect: () => {
                  navigator.clipboard?.writeText(examplePrompt(menu.conn, manifestFor(kinds, menu.conn.kind))).catch(() => {})
                  notify(t('copied'))
                },
              },
              { separator: true },
              { id: 'delete', icon: 'trash', label: t('remove'), danger: true, onSelect: () => requestRemove(menu.conn) },
            ]

      return h(
        'div',
        { className: 'wsc-backdrop', onMouseDown: (event) => event.target === event.currentTarget && onClose() },
        h(
          'div',
          { className: 'wsc-root wsc-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('title') },
          h(
            'header',
            { className: 'wsc-titlebar' },
            h('div', { className: 'wsc-appicon' }, h(Glyph, { name: 'plug', size: 20, color: '#fff', stroke: 1.7 })),
            h(
              'div',
              { className: 'wsc-titles' },
              h('div', { className: 'wsc-h1' }, t('title')),
              h('div', { className: 'wsc-h1-sub' }, `${connections.length} 个连接 · 查询交给智能体`),
            ),
            h('span', { className: 'wsc-titlebar-spacer' }),
            h(
              'label',
              { className: 'wsc-search' },
              h(Glyph, { name: 'search', size: 13, color: T.dim }),
              h('input', {
                ref: searchRef,
                value: query,
                placeholder: t('search'),
                onChange: (event) => setQuery(event.target.value),
              }),
            ),
            h(IconButton, { icon: 'refresh', title: t('refresh'), onClick: load }),
            h(IconButton, { icon: 'close', title: t('close'), round: true, onClick: onClose }),
          ),
          error
            ? h('div', { style: { padding: '10px 20px 0' } }, h(Banner, null, `${t('loadFailed')}：${error}`))
            : null,
          h(
            'div',
            { className: 'wsc-body' },
            sidebar,
            h(
              'section',
              { className: 'wsc-main' },
              h(
                'div',
                { className: 'wsc-main-scroll' },
                loading && state === null
                  ? [0, 1, 2].map((index) => h('div', { key: index, className: 'wsc-skel', style: { height: 60 } }))
                  : main,
              ),
            ),
          ),
        ),
        menu !== null ? h(ContextMenu, { x: menu.x, y: menu.y, items: menuItems, onClose: () => setMenu(null) }) : null,
        toast ? h('div', { className: 'wsc-toast' }, h(Glyph, { name: 'check', size: 14 }), toast) : null,
        confirmDelete !== null
          ? h(ConfirmDelete, {
              conn: confirmDelete,
              onCancel: () => setConfirmDelete(null),
              onConfirm: async () => {
                const target = confirmDelete
                setConfirmDelete(null)
                await removeConnection(target)
              },
            })
          : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* 输入区入口                                                          */
    /* ------------------------------------------------------------------ */

    const ui = {
      open: false,
      listeners: new Set(),
      set(patch) {
        Object.assign(ui, patch)
        for (const listener of [...ui.listeners]) {
          try {
            listener()
          } catch {
            /* 单个订阅者出错不影响其它 */
          }
        }
      },
      subscribe(listener) {
        ui.listeners.add(listener)
        return () => ui.listeners.delete(listener)
      },
    }

    function ComposerButton() {
      const [count, setCount] = useState(null)
      const [hover, setHover] = useState(false)

      useEffect(() => {
        let alive = true
        request('/state')
          .then((payload) => {
            if (alive) setCount((payload?.connections ?? []).length)
          })
          .catch(() => {
            if (alive) setCount(null)
          })
        return () => {
          alive = false
        }
      }, [])

      const title = `${t('panelLabel')}${count === null ? '' : ` · ${count}`}`
      return h(
        'button',
        {
          type: 'button',
          title,
          'aria-label': title,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onClick: () => ui.set({ open: true }),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 26,
            padding: '0 8px',
            border: '1px solid ' + (hover ? T.border : 'transparent'),
            borderRadius: 8,
            background: hover ? T.layer2 : 'transparent',
            color: hover ? T.text : T.dim,
            font: 'inherit',
            fontSize: 11,
            cursor: 'pointer',
            lineHeight: 1,
            transition: 'background .16s cubic-bezier(.32,.72,0,1),color .16s,border-color .16s',
          },
        },
        h(Glyph, { name: 'plug', size: 15 }),
        typeof count === 'number' && count > 0 ? h('span', null, String(count)) : null,
      )
    }

    function PeerToasts() {
      const [items, setItems] = useState([])
      const [hidden, setHidden] = useState(false)
      const [stamp, setStamp] = useState('')

      useEffect(() => {
        let alive = true
        let cursor = 0
        let hideTimer = null
        const tick = async () => {
          try {
            const data = await request(`/peer/events?since=${cursor}`)
            if (!alive || !Array.isArray(data?.events) || data.events.length === 0) return
            cursor = typeof data.cursor === 'number' ? data.cursor : cursor
            setItems((prev) => [...prev, ...data.events].slice(-4))
            setHidden(false)
            setStamp(new Date().toTimeString().slice(0, 5))
            if (hideTimer) clearTimeout(hideTimer)
            hideTimer = setTimeout(() => {
              if (alive) setHidden(true)
            }, 45000)
          } catch {
            /* 插件没起来时静默 */
          }
        }
        const timer = setInterval(tick, 5000)
        tick()
        return () => {
          alive = false
          clearInterval(timer)
          if (hideTimer) clearTimeout(hideTimer)
        }
      }, [])

      if (items.length === 0 || hidden) return null

      const labelOf = (kind) => (kind === 'received' ? '收到' : kind === 'done' ? '完成' : '失败')
      const colorOf = (kind) => (kind === 'done' ? T.ok : kind === 'failed' ? T.bad : T.accent)

      return h(
        'div',
        { className: 'wsc-peer-card' },
        h(
          'div',
          { className: 'wsc-peer-head' },
          h('span', { className: 'wsc-peer-title' }, '连接器 · 跨机任务'),
          h('span', { className: 'wsc-peer-time' }, stamp),
          h(
            'button',
            { type: 'button', className: 'wsc-peer-close', title: '关闭', onClick: () => setHidden(true) },
            '×',
          ),
        ),
        items.map((item) =>
          h(
            'div',
            { key: item.id, className: 'wsc-peer-line' },
            h('span', { className: 'wsc-peer-tag', style: { color: colorOf(item.kind) } }, `[${labelOf(item.kind)}]`),
            ` ${item.from} · ${item.text || item.sessionId || ''}`,
          ),
        ),
      )
    }

    function Overlay() {
      const [, bump] = useState(0)
      useEffect(() => ui.subscribe(() => bump((value) => value + 1)), [])
      return h(
        React.Fragment,
        null,
        ui.open ? h(Panel, { onClose: () => ui.set({ open: false }) }) : null,
        h(PeerToasts),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            ctx.locale.register(NS, 'zh', DICT.zh)
            ctx.locale.register(NS, 'en', DICT.en)
            const bound = ctx.locale.bind(NS)
            translate = (key) => bound(key)
          }
        } catch {
          translate = null
        }

        try {
          const styles = require('styles')
          if (styles && typeof styles.insert === 'function') styles.insert(CSS)
        } catch {
          try {
            const style = document.createElement('style')
            style.textContent = CSS
            document.body.appendChild(style)
          } catch {
            /* 忽略 */
          }
        }

        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'wsconn', order: 10, label: () => t('panelLabel') },
            ComposerButton,
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'wsconn-dialog', order: 245 }, Overlay),
        )
      },
    }
  },
})
