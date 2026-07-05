// ==UserScript==
// @name         学习通作业 LLM 自动答题助手（独立版）
// @namespace    ctf-chaoxing-homework-llm
// @version      1.0.19
// @description  独立完成学习通/超星作业页面题目抓取、Codex/OpenAI兼容或Claude接口答题、自动填选、可选保存/提交。
// @author       Moyin/Codex
// @run-at       document-end
// @match        *://*.chaoxing.com/*
// @match        *://*.edu.cn/*
// @match        *://*.nbdlib.cn/*
// @match        *://*.hnsyu.net/*
// @match        *://*.ac.cn/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

(() => {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const D = document;
  const IS_TOP = (() => {
    try { return W.top === W.self; } catch (_) { return true; }
  })();
  const BRIDGE = 'cxllm-homework-bridge-v1';

  const STORE = 'cxllm_hw_';
  const PANEL_ID = 'cxllm-panel';
  const DEFAULT_CFG = {
    provider: "responses",
    apiUrl: '',
    apiKey: '',
    model: 'gpt-4.1',
    batchSize: 8,
    delayMs: 900,
    autoSubmit: false,
    autoSave: false,
    loopList: true,
    autoRun: false,
    maxTokens: 2200,
    temperature: 0
  };

  const TYPE_MAP = {
    '0': '单选题',
    '1': '多选题',
    '2': '填空题',
    '3': '判断题',
    '4': '简答题',
    '5': '论述题',
    single: '单选题',
    multi: '多选题',
    judge: '判断题',
    blank: '填空题',
    text: '简答题'
  };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function readLocalValue(key, def) {
    const raw = localStorage.getItem(STORE + key);
    if (raw == null) return def;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  function gmGet(key, def) {
    try {
      const v = GM_getValue(STORE + key);
      if (v !== undefined) return v;
    } catch (_) { /* fall through */ }
    return readLocalValue(key, def);
  }

  function gmSet(key, val) {
    try { GM_setValue(STORE + key, val); } catch (_) { /* keep local mirror */ }
    try { localStorage.setItem(STORE + key, JSON.stringify(val)); } catch (_) {}
  }

  function parseStoredCfg(raw) {
    if (!raw) return {};
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) || {}; } catch { return {}; }
    }
    return typeof raw === 'object' ? raw : {};
  }

  function getCfg() {
    // cfg_json 是跨页面兜底：部分脚本管理器/跨子域场景下对象型 GM_setValue 会不稳定。
    const byJson = parseStoredCfg(gmGet('cfg_json', ''));
    const byObj = parseStoredCfg(gmGet('cfg', {}));
    return { ...DEFAULT_CFG, ...byObj, ...byJson };
  }

  function setCfg(cfg) {
    const merged = { ...getCfg(), ...cfg };
    gmSet('cfg', merged);
    gmSet('cfg_json', JSON.stringify(merged));
  }

  const RUN_TTL_MS = 10 * 60 * 1000;

  function getRunState() {
    const state = gmGet('runState', null);
    if (!state || typeof state !== 'object') {
      return { active: false, token: '', startedAt: 0, updatedAt: 0 };
    }
    return {
      active: !!state.active,
      pendingContinue: !!state.pendingContinue,
      token: String(state.token || ''),
      startedAt: Number(state.startedAt || 0),
      updatedAt: Number(state.updatedAt || 0)
    };
  }

  function isFreshRunState(state = getRunState()) {
    return !!state.active && Date.now() - state.updatedAt <= RUN_TTL_MS;
  }

  function isRunning() {
    return isFreshRunState();
  }

  function shouldAutoContinue() {
    const state = getRunState();
    return !!state.pendingContinue && isFreshRunState(state);
  }

  function touchRunning(pendingContinue = false) {
    const state = getRunState();
    if (!state.active) return;
    state.pendingContinue = !!pendingContinue;
    state.updatedAt = Date.now();
    gmSet('runState', state);
    gmSet('running', false); // clear legacy boolean state from v1.0.0
  }

  function markPendingContinue() {
    touchRunning(true);
  }

  function setRunning(v) {
    const now = Date.now();
    if (v) {
      gmSet('runState', {
        active: true,
        pendingContinue: false,
        token: `${now}-${Math.random().toString(36).slice(2)}`,
        startedAt: now,
        updatedAt: now
      });
    } else {
      const state = getRunState();
      gmSet('runState', { ...state, active: false, pendingContinue: false, updatedAt: now });
    }
    gmSet('running', false); // clear legacy boolean state from v1.0.0
  }

  function nowTime() {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(n => String(n).padStart(2, '0')).join(':');
  }

  function cleanText(input) {
    const tmp = D.createElement('div');
    tmp.innerHTML = String(input || '')
      .replace(/<img[^>]+src=["']?([^"'\s>]+)[^>]*>/gi, ' [图片:$1] ');
    return (tmp.textContent || tmp.innerText || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\r\f\v]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .replace(/[（]/g, '(')
      .replace(/[）]/g, ')')
      .replace(/[【]/g, '[')
      .replace(/[】]/g, ']')
      .trim();
  }

  function norm(s) {
    return cleanText(s)
      .toLowerCase()
      .replace(/[，。；：、“”‘’！？,.!?:;"'`~\s\-_()[\]{}<>]/g, '');
  }

  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest(`#${PANEL_ID}`)) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function uniqBy(arr, keyFn) {
    const seen = new Set();
    const out = [];
    for (const item of arr) {
      const k = keyFn(item);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
    return out;
  }

  function log(msg, level = 'info') {
    const line = `[${nowTime()}] ${msg}`;
    console.log('[CX-LLM]', line);
    const box = D.querySelector('#cxllm-log');
    if (box) {
      const div = D.createElement('div');
      div.textContent = line;
      div.style.color = level === 'error' ? '#ff6b6b' : level === 'ok' ? '#69db7c' : level === 'warn' ? '#ffd43b' : '#dbe4ff';
      box.appendChild(div);
      while (box.children.length > 120) box.removeChild(box.firstChild);
      box.scrollTop = box.scrollHeight;
    }
  }

  function mountPanel() {
    if (D.getElementById(PANEL_ID)) return;
    const cfg = getCfg();
    const panel = D.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <style>
        #${PANEL_ID}{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:360px;
          font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",Arial,sans-serif;
          color:#e7f5ff;background:#17212f;border:1px solid #4dabf7;border-radius:12px;
          box-shadow:0 12px 34px rgba(0,0,0,.35);overflow:hidden}
        #${PANEL_ID}.mini{width:210px}
        #${PANEL_ID}.mini .cxllm-body{display:none}
        #${PANEL_ID} .cxllm-head{display:flex;align-items:center;justify-content:space-between;
          padding:9px 12px;background:#1c2b3a;cursor:move;font-weight:700}
        #${PANEL_ID} .cxllm-body{padding:10px 12px}
        #${PANEL_ID} label{display:block;margin:6px 0 3px;color:#a5d8ff}
        #${PANEL_ID} input,#${PANEL_ID} select{box-sizing:border-box;width:100%;border:1px solid #49657d;
          border-radius:7px;background:#0b1420;color:#f8f9fa;padding:6px 8px;outline:none}
        #${PANEL_ID} input[type=checkbox][hidden]{display:none!important}
        #${PANEL_ID} .row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
        #${PANEL_ID} .cxllm-toggles{display:flex;flex-direction:column;gap:6px;margin:8px 0 2px}
        #${PANEL_ID} .cxllm-toggle{display:flex;align-items:center;gap:7px;width:100%;padding:0!important;
          border:0!important;background:transparent!important;color:#cfe8ff!important;text-align:left!important;
          cursor:pointer!important;font:inherit!important;box-shadow:none!important;user-select:none}
        #${PANEL_ID} .cxllm-toggle:hover{color:#ffffff!important}
        #${PANEL_ID} .cxllm-switch{position:relative;display:inline-block;flex:0 0 auto;width:18px;height:18px;
          border:1px solid #74c0fc;border-radius:50%;background:#0b1420;box-sizing:border-box}
        #${PANEL_ID} .cxllm-toggle.on .cxllm-switch{background:#228be6;border-color:#74c0fc}
        #${PANEL_ID} .cxllm-toggle.on .cxllm-switch::after{content:'✓';position:absolute;left:3px;top:-3px;
          color:#fff;font-size:16px;font-weight:700}
        #${PANEL_ID} .btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
        #${PANEL_ID} button{border:0;border-radius:7px;padding:7px 10px;cursor:pointer;color:#fff;background:#228be6}
        #${PANEL_ID} button.gray{background:#495057}
        #${PANEL_ID} button.green{background:#2f9e44}
        #${PANEL_ID} button.red{background:#e03131}
        #${PANEL_ID} .tip{margin-top:7px;color:#91a7bb;font-size:12px}
        #${PANEL_ID} #cxllm-log{margin-top:8px;height:145px;overflow:auto;background:#0b1420;border-radius:8px;
          padding:7px;border:1px solid #2b3d50;font-family:Consolas,monospace;font-size:12px}
      </style>
      <div class="cxllm-head">
        <span>学习通作业 LLM</span>
        <span>
          <button class="gray" id="cxllm-mini" style="padding:2px 7px">—</button>
        </span>
      </div>
      <div class="cxllm-body">
        <label>接口类型</label>
        <select id="cxllm-provider">
          <option value="responses">OpenAI / Codex Responses API</option>
          <option value="openai">OpenAI 兼容 Chat Completions</option>
          <option value="claude">Claude Messages API</option>
        </select>
        <label>调用 URL（可填 base URL 或完整 endpoint）</label>
        <input id="cxllm-apiUrl" placeholder="如 https://api.openai.com/v1 或 https://api.anthropic.com">
        <label>API Key</label>
        <input id="cxllm-apiKey" type="password" placeholder="sk-...">
        <label>模型名</label>
        <input id="cxllm-model" placeholder="如 gpt-4.1 / claude-3-5-sonnet-latest">
        <div class="row">
          <div><label>每批题数</label><input id="cxllm-batchSize" type="number" min="1" max="100"></div>
          <div><label>填题间隔(ms)</label><input id="cxllm-delayMs" type="number" min="0" max="10000"></div>
        </div>
        <div class="cxllm-toggles">
          <input id="cxllm-loopList" type="checkbox" hidden>
          <button type="button" class="cxllm-toggle" data-input="cxllm-loopList" aria-pressed="false"><span class="cxllm-switch"></span><span>从作业列表连续进入未交作业</span></button>
          <input id="cxllm-autoSave" type="checkbox" hidden>
          <button type="button" class="cxllm-toggle" data-input="cxllm-autoSave" aria-pressed="false"><span class="cxllm-switch"></span><span>答完后自动暂存/保存</span></button>
          <input id="cxllm-autoSubmit" type="checkbox" hidden>
          <button type="button" class="cxllm-toggle" data-input="cxllm-autoSubmit" aria-pressed="false"><span class="cxllm-switch"></span><span>答完后自动提交</span></button>
        </div>
        <div class="btns">
          <button class="green" id="cxllm-save">保存配置</button>
          <button id="cxllm-start">开始</button>
          <button class="gray" id="cxllm-once">只答当前页</button>
          <button class="gray" id="cxllm-debug-list">诊断列表</button>
          <button class="red" id="cxllm-stop">停止</button>
        </div>
        <div class="tip">先保存 URL / Key / 模型；在作业列表点“开始”会自动进入未交作业，在题目页会抓题、调用模型并填选。</div>
        <div id="cxllm-log"></div>
      </div>`;
    D.documentElement.appendChild(panel);

    const setVal = (id, val) => { const el = D.getElementById(id); if (el) el.value = val ?? ''; };
    const syncToggle = id => {
      const el = D.getElementById(id);
      const btn = panel.querySelector(`.cxllm-toggle[data-input="${id}"]`);
      if (!el || !btn) return;
      btn.classList.toggle('on', !!el.checked);
      btn.setAttribute('aria-pressed', String(!!el.checked));
    };
    const setChk = (id, val) => {
      const el = D.getElementById(id);
      if (el) el.checked = !!val;
      syncToggle(id);
    };
    D.getElementById('cxllm-provider').value = cfg.provider;
    setVal('cxllm-apiUrl', cfg.apiUrl);
    setVal('cxllm-apiKey', cfg.apiKey);
    setVal('cxllm-model', cfg.model);
    setVal('cxllm-batchSize', cfg.batchSize);
    setVal('cxllm-delayMs', cfg.delayMs);
    setChk('cxllm-loopList', cfg.loopList);
    setChk('cxllm-autoSave', cfg.autoSave);
    setChk('cxllm-autoSubmit', cfg.autoSubmit);

    panel.querySelectorAll('.cxllm-toggle').forEach(btn => {
      btn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const id = btn.getAttribute('data-input');
        const input = D.getElementById(id);
        if (!input) return;
        input.checked = !input.checked;
        syncToggle(id);
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });

    D.getElementById('cxllm-save').onclick = () => {
      const saved = savePanelCfg();
      log(`配置已保存：每批题数=${saved.batchSize}，填题间隔=${saved.delayMs}ms`, 'ok');
    };
    D.getElementById('cxllm-start').onclick = async () => {
      savePanelCfg();
      setRunning(true);
      log('已启动');
      await runController();
    };
    D.getElementById('cxllm-once').onclick = async () => {
      savePanelCfg();
      log('开始只答当前页');
      await answerCurrentPage(false);
    };
    D.getElementById('cxllm-debug-list').onclick = () => debugWorkList();
    D.getElementById('cxllm-stop').onclick = () => {
      setRunning(false);
      log('已停止', 'warn');
    };
    D.getElementById('cxllm-mini').onclick = () => panel.classList.toggle('mini');

    dragPanel(panel);
  }

  function savePanelCfg() {
    const v = id => D.getElementById(id)?.value ?? '';
    const c = id => !!D.getElementById(id)?.checked;
    const cfg = {
      provider: v('cxllm-provider'),
      apiUrl: v('cxllm-apiUrl').trim(),
      apiKey: v('cxllm-apiKey').trim(),
      model: v('cxllm-model').trim(),
      batchSize: Math.max(1, Math.min(100, parseInt(v('cxllm-batchSize'), 10) || 8)),
      delayMs: Math.max(0, Math.min(10000, parseInt(v('cxllm-delayMs'), 10) || 900)),
      loopList: c('cxllm-loopList'),
      autoSave: c('cxllm-autoSave'),
      autoSubmit: c('cxllm-autoSubmit')
    };
    setCfg(cfg);
    return { ...getCfg(), ...cfg };
  }

  function dragPanel(panel) {
    const head = panel.querySelector('.cxllm-head');
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    head.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    D.addEventListener('mousemove', e => {
      if (!dragging) return;
      panel.style.left = `${Math.max(0, ox + e.clientX - sx)}px`;
      panel.style.top = `${Math.max(0, oy + e.clientY - sy)}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    D.addEventListener('mouseup', () => { dragging = false; });
  }

  function buildEndpoint(cfg) {
    const base = (cfg.apiUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('请先填写调用 URL');
    if (cfg.provider === 'claude') {
      return /\/v1\/messages$/i.test(base) ? base : `${base}/v1/messages`;
    }
    if (cfg.provider === "responses") {
      return /\/responses$/i.test(base) ? base : `${base}/responses`;
    }
    return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  }

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      const fn = typeof GM_xmlhttpRequest === 'function'
        ? GM_xmlhttpRequest
        : (typeof GM !== 'undefined' && GM.xmlHttpRequest);
      if (!fn) {
        fetch(opts.url, {
          method: opts.method || 'GET',
          headers: opts.headers || {},
          body: opts.data,
          credentials: 'omit'
        }).then(async r => resolve({ status: r.status, responseText: await r.text() })).catch(reject);
        return;
      }
      const ret = fn({
        ...opts,
        timeout: opts.timeout || 60000,
        onload: resolve,
        onerror: reject,
        ontimeout: () => reject(new Error('请求超时'))
      });
      if (ret && typeof ret.then === 'function') ret.then(resolve).catch(reject);
    });
  }

  function promptForBatch(batch) {
    const payload = batch.map(q => ({
      id: q.id,
      type: q.typeText,
      question: q.question,
      options: q.options.map(o => ({ label: o.label, text: o.text }))
    }));
    return [
      '请完成下面的学习通作业题。只返回 JSON，不要 Markdown，不要解释。',
      '返回格式必须是：{"answers":[{"id":"题目id","answer":"选项字母或答案文本","confidence":0.0到1.0}]}',
      '规则：单选题 answer 填一个大写字母；多选题填升序字母串如 "ACD"；判断题必须按给出的选项返回对应字母；填空/简答题返回简洁答案文本。',
      '如果不确定，也要根据题干和选项给出最可能答案。',
      '',
      JSON.stringify(payload, null, 2)
    ].join('\n');
  }

  async function askLLM(batch) {
    const cfg = getCfg();
    if (!cfg.apiKey) throw new Error('请先填写 API Key');
    if (!cfg.model) throw new Error('请先填写模型名');
    const endpoint = buildEndpoint(cfg);
    const prompt = promptForBatch(batch);
    let body;
    let headers;
    if (cfg.provider === 'claude') {
      headers = {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        "anthropic-dangerous-direct-browser-access": "true",
      };
      body = {
        model: cfg.model,
        max_tokens: Number(cfg.maxTokens) || 2200,
        temperature: Number(cfg.temperature) || 0,
        system: '你是只输出 JSON 的选择题/判断题答题助手。',
        messages: [{ role: 'user', content: prompt }]
      };
    } else if (cfg.provider === "responses") {
      headers = {
        "content-type": "application/json",
        "authorization": `Bearer ${cfg.apiKey}`
      };
      body = {
        model: cfg.model,
        input: [
          { role: "system", content: "你是只输出 JSON 的选择题/判断题答题助手。" },
          { role: "user", content: prompt }
        ]
      };
    } else {
      headers = {
        'content-type': 'application/json',
        'authorization': `Bearer ${cfg.apiKey}`
      };
      body = {
        model: cfg.model,
        temperature: Number(cfg.temperature) || 0,
        messages: [
          { role: 'system', content: '你是只输出 JSON 的选择题/判断题答题助手。' },
          { role: 'user', content: prompt }
        ]
      };
    }
    const res = await gmRequest({
      method: 'POST',
      url: endpoint,
      headers,
      data: JSON.stringify(body),
      timeout: 90000
    });
    if (res.status && (res.status < 200 || res.status >= 300)) {
      throw new Error(`接口 HTTP ${res.status}: ${String(res.responseText || '').slice(0, 500)}`);
    }
    const json = JSON.parse(res.responseText);
    const text = cfg.provider === "claude"
      ? (json.content || []).map(x => x.text || "").join("\n")
      : cfg.provider === "responses"
        ? (json.output_text || (json.output || []).flatMap(o => o.content || []).map(c => c.text || c.output_text || "").join("\n"))
        : (json.choices?.[0]?.message?.content || json.choices?.[0]?.text || "");
    return parseAnswerJson(text);
  }

  function parseAnswerJson(text) {
    let s = String(text || '').trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim();
    const tries = [s];
    const objMatch = s.match(/\{[\s\S]*\}/);
    const arrMatch = s.match(/\[[\s\S]*\]/);
    if (objMatch) tries.push(objMatch[0]);
    if (arrMatch) tries.push(arrMatch[0]);
    for (const t of tries) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed.answers)) return parsed.answers;
        if (Array.isArray(parsed.data)) return parsed.data;
      } catch (_) { /* continue */ }
    }
    throw new Error(`模型未返回可解析 JSON: ${s.slice(0, 500)}`);
  }

  function getQuestionRoots() {
    const selectors = [
      '.Py-mian1',
      '.TiMu',
      '.newTiMu',
      '.questionLi',
      '.question-item',
      '.quesItem',
      '.paper_question',
      '.mark_item',
      '.subject-item',
      '[data-questionid]'
    ];
    let roots = [];
    for (const sel of selectors) {
      roots.push(...Array.from(D.querySelectorAll(sel)).filter(visible));
    }
    roots = roots.filter(el => {
      const txt = cleanText(el.innerText);
      return txt.length > 5 && (/(单选题|多选题|判断题|填空题|简答题|论述题)/.test(txt) || el.querySelector('input[id^="answertype"]'));
    });

    if (!roots.length) {
      const titleNodes = Array.from(D.querySelectorAll('div,p,h1,h2,h3,h4,span'))
        .filter(visible)
        .filter(el => {
          const t = cleanText(el.innerText);
          return t.length > 8 && t.length < 900 && /(^|\d+[.、．]\s*)[\[(]?(单选题|多选题|判断题|填空题|简答题|论述题)[\])]*/.test(t);
        });
      for (const title of titleNodes) {
        let n = title;
        for (let depth = 0; n && depth < 8; depth++, n = n.parentElement) {
          if (extractOptionsFromRoot(n).length >= 2 || textInputs(n).length) {
            roots.push(n);
            break;
          }
        }
      }
    }
    return uniqBy(roots, el => cssPath(el)).filter(root => {
      const t = cleanText(root.innerText);
      return t && t.length < 8000;
    });
  }

  function cssPath(el) {
    if (!el || !el.parentElement) return '';
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 6) {
      let p = n.tagName.toLowerCase();
      if (n.id) { p += `#${n.id}`; parts.unshift(p); break; }
      const siblings = Array.from(n.parentElement?.children || []).filter(x => x.tagName === n.tagName);
      if (siblings.length > 1) p += `:nth-of-type(${siblings.indexOf(n) + 1})`;
      parts.unshift(p);
      n = n.parentElement;
    }
    return parts.join('>');
  }

  function inferType(root) {
    const typeInput = Array.from(root.querySelectorAll('input[id^="answertype"]')).find(x => x.value != null);
    if (typeInput && TYPE_MAP[typeInput.value]) return TYPE_MAP[typeInput.value];
    const txt = cleanText(root.innerText);
    const m = txt.match(/[(\[]?\s*(单选题|多选题|判断题|填空题|简答题|论述题)\s*[)\]]?/);
    if (m) return m[1];
    const opts = extractOptionsFromRoot(root);
    if (opts.length === 2 && opts.some(o => /^(对|正确|true)$/i.test(norm(o.text))) && opts.some(o => /^(错|错误|false)$/i.test(norm(o.text)))) {
      return '判断题';
    }
    if (opts.length > 1) return '单选题';
    return '简答题';
  }

  function titleText(root, options) {
    const titleSelectors = [
      '.Py-m1-title',
      '.Zy_TItle',
      '.mark_name',
      '.question-title',
      '.ques-title',
      '.subject-title',
      '.stem',
      '[class*="title"]'
    ];
    let raw = '';
    for (const sel of titleSelectors) {
      const el = Array.from(root.querySelectorAll(sel)).find(visible);
      if (el) {
        const t = cleanText(el.innerHTML || el.innerText);
        if (t.length > raw.length) raw = t;
      }
    }
    if (!raw) {
      const txt = cleanText(root.innerText);
      const lines = txt.split('\n').map(x => x.trim()).filter(Boolean);
      raw = lines.find(x => /(单选题|多选题|判断题|填空题|简答题|论述题)/.test(x)) || lines[0] || txt;
      if (raw.length > 700) {
        raw = txt;
        for (const o of options) {
          const re = new RegExp(`\\b${escapeReg(o.label)}[.、\\s]*${escapeReg(o.text)}`, 'g');
          raw = raw.replace(re, ' ');
        }
      }
    }
    raw = raw
      .replace(/^\s*\d{1,4}\s*[.、．]\s*/g, '')
      .replace(/^\s*[(\[]?\s*(单选题|多选题|判断题|填空题|简答题|论述题)\s*[)\]]?\s*/g, '')
      .replace(/\s*满分[:：]\s*\d+(\.\d+)?\s*/g, ' ')
      .replace(/\s*共\s*\d+\s*题\s*/g, ' ');
    return cleanText(raw);
  }

  function escapeReg(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function textInputs(root) {
    return Array.from(root.querySelectorAll('textarea,input[type="text"],input:not([type])'))
      .filter(visible)
      .filter(el => !/搜索|search|keyword/i.test(el.name || el.id || el.placeholder || ''));
  }


  function optionTextForLabel(typeText, label) {
    const l = String(label || '').toUpperCase();
    if (typeText === '判断题') {
      if (l === 'A') return '对';
      if (l === 'B') return '错';
    }
    return '';
  }

  function questionKey(q) {
    const ids = [];
    if (q?.id) ids.push(q.id);
    const root = q?.root || q;
    if (root?.querySelectorAll) {
      const inputs = Array.from(root.querySelectorAll('input[name*="answer"],input[id*="answer"],input[id^="answertype"]'));
      for (const input of inputs) ids.push(input.name || input.id || '');
      const liIds = Array.from(root.querySelectorAll('li[id-param][val-param],.answerList li[id-param]'))
        .map(li => li.getAttribute('id-param'))
        .filter(Boolean);
      const uniq = [...new Set(liIds)];
      if (uniq.length === 1) ids.push(uniq[0]);
    }
    for (const raw of ids) {
      const s = String(raw || '').trim();
      if (!s) continue;
      const cleaned = s.replace(/^(answer|check|type|answertype)/i, '');
      if (/^\d{3,}$/.test(cleaned)) return cleaned;
      const m = s.match(/(?:answer|check|type|answertype)(\d{3,})/i) || s.match(/\b(\d{5,})\b/);
      if (m) return m[1];
    }
    return '';
  }

  function optionLabelFromElement(el) {
    if (!el) return '';
    const attrNames = ['data-option', 'data-label', 'option', 'data'];
    const idp = String(el.getAttribute?.('id-param') || '').trim().toUpperCase();
    if (/^[A-H]$/.test(idp)) return idp;
    for (const name of attrNames) {
      const v = String(el.getAttribute?.(name) || '').trim().toUpperCase();
      if (/^[A-H]$/.test(v)) return v;
    }
    const child = Array.from(el.querySelectorAll?.('[id-param],em,span,i,b') || [])
      .find(x => {
        const a = String(x.getAttribute?.('id-param') || '').trim().toUpperCase();
        const t = cleanText(x.innerText || x.textContent || '').trim().toUpperCase();
        return /^[A-H]$/.test(a) || /^[A-H]$/.test(t);
      });
    if (child) {
      const a = String(child.getAttribute?.('id-param') || '').trim().toUpperCase();
      if (/^[A-H]$/.test(a)) return a;
      const t = cleanText(child.innerText || child.textContent || '').trim().toUpperCase();
      if (/^[A-H]$/.test(t)) return t;
    }
    const txt = cleanText(el.innerText || el.textContent || el.value || '');
    const m = txt.match(/^\s*([A-H])(?:[.、．\s]|$)/i);
    return m ? m[1].toUpperCase() : '';
  }

  function optionTextFromElement(el, label = '') {
    if (!el) return '';
    const a = Array.from(el.querySelectorAll?.('a') || []).map(x => cleanText(x.innerText || x.textContent || '')).find(Boolean);
    let text = a || cleanText(el.innerText || el.textContent || el.value || '');
    const l = String(label || optionLabelFromElement(el) || '').toUpperCase();
    if (l) text = text.replace(new RegExp(`^\\s*${escapeReg(l)}\\s*[.、．]?\\s*`, 'i'), '');
    return cleanText(text);
  }

  function chaoxingOptionLis(scope) {
    const root = scope?.querySelectorAll ? scope : D;
    const raw = Array.from(root.querySelectorAll('li[id-param][val-param],.answerList li[id-param],.Zy_ulTop li[id-param],.optionUl li[id-param],.options li[id-param]'));
    return uniqBy(raw, cssPath)
      .filter(el => !el.closest(`#${PANEL_ID}`))
      .filter(visible)
      .filter(el => {
        const label = optionLabelFromElement(el);
        const val = String(el.getAttribute('val-param') || '').toLowerCase();
        return /^[A-H]$/.test(label) || /^(true|false|0|1)$/.test(val);
      });
  }

  function findChaoxingOptionLi(q, label, text = '') {
    const root = q?.root || D;
    const l = String(label || '').toUpperCase();
    if (!/^[A-H]$/.test(l)) return null;
    const wantedText = cleanText(text || optionTextForLabel(q?.typeText, l));
    const key = questionKey(q);
    const scopes = uniqBy([root, D].filter(Boolean), el => el === D ? 'document' : cssPath(el));
    const cands = [];
    for (const scope of scopes) cands.push(...chaoxingOptionLis(scope));
    const scored = uniqBy(cands, cssPath).map(li => {
      const liKey = String(li.getAttribute('id-param') || '').trim();
      const liLabel = optionLabelFromElement(li);
      const liVal = String(li.getAttribute('val-param') || '').toLowerCase();
      const liText = optionTextFromElement(li, liLabel);
      const keyKnown = !!(key && liKey);
      const keyMatch = keyKnown && liKey === key;
      if (keyKnown && !keyMatch) return null;
      let matched = false;
      let score = 100;
      if (root?.contains?.(li)) score -= 20;
      if (keyMatch) score -= 50;
      if (liLabel === l) { score -= 45; matched = true; }
      const wt = norm(wantedText);
      const lt = norm(liText);
      if (wt && lt && wt === lt) { score -= 30; matched = true; }
      if (wt && lt && (lt.includes(wt) || wt.includes(lt))) { score -= 12; matched = true; }
      if (q?.typeText === '判断题' || /^(对|错|正确|错误)$/.test(wantedText)) {
        if (l === 'A' && /^(true|1)$/.test(liVal)) { score -= 40; matched = true; }
        if (l === 'B' && /^(false|0)$/.test(liVal)) { score -= 40; matched = true; }
      }
      if (!matched) return null;
      score += Math.min(cleanText(li.innerText || li.textContent || '').length / 10, 15);
      return { li, score };
    }).filter(Boolean);
    scored.sort((a, b) => a.score - b.score);
    return scored[0]?.li || null;
  }

  function findSmallClickable(el, stopRoot) {
    let n = el;
    let best = el;
    for (let depth = 0; n && depth < 6 && n !== stopRoot?.parentElement; depth++, n = n.parentElement) {
      if (!visible(n)) continue;
      best = n;
      if (n.matches?.('li,label,a,button,[onclick],[role="button"],[val-param]')) return n;
      const txt = cleanText(n.innerText || n.textContent || '');
      if (txt.length > 0 && txt.length <= 20) best = n;
    }
    return best;
  }

  function findOptionElementInRoot(root, label, text = '') {
    if (!root) return null;
    const l = String(label || '').toUpperCase();
    const chaoxingLi = findChaoxingOptionLi({ root, typeText: '' }, l, text);
    if (chaoxingLi) return chaoxingLi;
    const exact = [];
    const nodes = Array.from(root.querySelectorAll('li,label,a,button,span,div,em,[id-param],[val-param]'))
      .filter(el => !el.closest(`#${PANEL_ID}`))
      .filter(visible);
    for (const el of nodes) {
      const idp = String(el.getAttribute('id-param') || el.getAttribute('data') || '').toUpperCase();
      const val = String(el.getAttribute('val-param') || '').toLowerCase();
      const elLabel = optionLabelFromElement(el);
      const txt = cleanText(el.innerText || el.textContent || el.value || '');
      if (idp === l || elLabel === l) exact.push(el);
      if (text && norm(txt) === norm(text)) exact.push(el);
      if (text && new RegExp(`(^|\\s)${escapeReg(l)}\\s*[.、．]?\\s*${escapeReg(text)}($|\\s)`, 'i').test(txt)) exact.push(el);
      if (l === 'A' && /^(true|1)$/.test(val)) exact.push(el);
      if (l === 'B' && /^(false|0)$/.test(val)) exact.push(el);
    }
    const picked = exact
      .map(el => findSmallClickable(el, root))
      .filter(Boolean)
      .sort((a, b) => cleanText(a.innerText || a.textContent || '').length - cleanText(b.innerText || b.textContent || '').length)[0];
    return picked || null;
  }

  function inlineOptionsFromText(root, typeText) {
    const txt = cleanText(root?.innerText || root?.textContent || '');
    const out = [];
    if (typeText === '判断题' || /A\s*(对|正确|是|true)\s*B\s*(错|错误|否|false)/i.test(txt)) {
      const pairs = [
        ['A', (/A\s*(正确|对|是|true)/i.exec(txt) || [])[1] || '对'],
        ['B', (/B\s*(错误|错|否|false)/i.exec(txt) || [])[1] || '错']
      ];
      for (const [label, text] of pairs) {
        const el = findOptionElementInRoot(root, label, text) || root;
        out.push({ label, text, el, root, selected: () => isSelected(el), val: label === 'A' ? 'true' : 'false', synthetic: true });
      }
      return out;
    }
    const re = /(?:^|\s)([A-H])\s*[.、．]?\s*([^A-H\n]{1,80})(?=\s+[A-H]\s*[.、．]?\s|$)/g;
    let m;
    while ((m = re.exec(txt))) {
      const label = m[1].toUpperCase();
      const text = cleanText(m[2]);
      if (!text || /^(单选题|多选题|判断题)$/.test(text)) continue;
      const el = findOptionElementInRoot(root, label, text) || root;
      out.push({ label, text, el, root, selected: () => isSelected(el), val: '', synthetic: true });
    }
    return uniqBy(out, o => `${o.label}:${norm(o.text)}`);
  }

  function extractOptionsFromRoot(root) {
    const raw = [];
    const selectors = [
      '.answerList li',
      '.Zy_ulTop li',
      '.optionUl li',
      '.options li',
      'ul li',
      '[id-param][val-param]',
      '[id-param] li',
      '.option',
      '.answer'
    ];
    for (const sel of selectors) {
      raw.push(...Array.from(root.querySelectorAll(sel)));
    }
    const optionEls = uniqBy(raw, cssPath).filter(visible).filter(el => {
      const t = cleanText(el.innerText);
      if (!t || t.length > 600) return false;
      if (el.closest('#cxllm-log')) return false;
      if (el.hasAttribute('id-param') || el.hasAttribute('val-param')) return true;
      if (el.querySelector('em[id-param],[id-param],input[type="radio"],input[type="checkbox"]')) return true;
      return /^\s*[A-H][.、\s]/i.test(t) || /^(对|错|正确|错误)\s*$/i.test(t);
    });
    const out = [];
    optionEls.forEach((el, idx) => {
      const em = el.matches?.('em[id-param],[id-param]') ? el : el.querySelector('em[id-param],[id-param]');
      let label = (em?.getAttribute('id-param') || el.getAttribute('data') || '').trim();
      const txt = cleanText(el.innerHTML || el.innerText);
      const m = txt.match(/^\s*([A-H])(?:[.、\s]|$)/i);
      if (!/^[A-H]$/i.test(label)) label = optionLabelFromElement(el);
      if (!label && m) label = m[1].toUpperCase();
      if (!/^[A-H]$/i.test(label)) label = String.fromCharCode(65 + idx);
      label = label.toUpperCase();
      let text = optionTextFromElement(el, label) || cleanText(el.innerText);
      text = text.replace(new RegExp(`^\\s*${escapeReg(label)}\\s*[.、．]?\\s*`, 'i'), '').trim();
      text = text.replace(/^([A-H])\s+/, '').trim();
      if (!text && el.getAttribute('val-param')) text = el.getAttribute('val-param') === 'true' ? '对' : '错';
      out.push({
        label,
        text,
        el,
        root,
        selected: () => isSelected(el),
        val: el.getAttribute('val-param') || ''
      });
    });
    const normal = uniqBy(out, o => `${o.label}:${norm(o.text)}:${cssPath(o.el)}`);
    return normal.length ? normal : inlineOptionsFromText(root, inferType(root));
  }

  function extractQuestions() {
    const roots = getQuestionRoots();
    const questions = [];
    roots.forEach((root, i) => {
      const typeText = inferType(root);
      let options = extractOptionsFromRoot(root);
      if (!options.length) options = inlineOptionsFromText(root, typeText);
      const question = titleText(root, options);
      if (!question || question.length < 2) return;
      let id = root.getAttribute('data-questionid') || root.getAttribute('qid') || '';
      const ansInput = Array.from(root.querySelectorAll('input[name*="answer"],input[id*="answer"]')).find(x => x.name || x.id);
      if (!id && ansInput) id = ansInput.name || ansInput.id;
      if (!id) id = String(i + 1);
      questions.push({ id: String(id), index: i + 1, root, typeText, question, options, inputs: textInputs(root) });
    });
    const unique = uniqBy(questions, q => `${q.id}:${norm(q.question).slice(0, 80)}`);
    unique.forEach((q, idx) => {
      q.index = idx + 1;
      q.nextRoot = unique[idx + 1]?.root || null;
    });
    return unique;
  }

  function isSelected(el) {
    if (!el) return false;
    if (el.matches?.('input')) return !!el.checked;
    const cls = ` ${el.className || ''} `;
    if (/( cur | checked | selected | active | on | check_answer | chosen | current )/i.test(cls)) return true;
    if (el.getAttribute?.('aria-checked') === 'true' || el.getAttribute?.('aria-selected') === 'true') return true;
    const input = el.querySelector?.('input[type="radio"],input[type="checkbox"]');
    const markedChild = el.querySelector?.('.cur,.checked,.selected,.active,.on,.check_answer,.chosen,.current,[aria-checked="true"],[aria-selected="true"]');
    if (markedChild) return true;
    return !!input?.checked;
  }

  function answerStateSignature(root) {
    if (!root) return '';
    const inputs = Array.from(root.querySelectorAll('input,textarea,select'))
      .map(el => `${el.tagName}:${el.type || ''}:${el.name || ''}:${el.id || ''}:${!!el.checked}:${el.value || ''}`)
      .join('|');
    const marked = Array.from(root.querySelectorAll('.cur,.checked,.selected,.active,.on,.chosen,.current,[aria-checked="true"],[aria-selected="true"]'))
      .filter(el => !el.closest(`#${PANEL_ID}`))
      .map(el => `${cssPath(el)}:${el.className || ''}`)
      .join('|');
    return `${inputs}##${marked}`;
  }

  function optionClickTargets(opt, q) {
    const root = q?.root || opt.root || opt.el;
    const label = String(opt.label || '').toUpperCase();
    const text = cleanText(opt.text || '');
    const candidates = [];
    const add = el => {
      if (!el || !visible(el) || el.closest?.(`#${PANEL_ID}`)) return;
      candidates.push(el);
      let n = el;
      for (let i = 0; n && i < 5 && n !== root.parentElement; i++, n = n.parentElement) {
        if (!visible(n) || n.closest?.(`#${PANEL_ID}`)) continue;
        candidates.push(n);
        if (n.matches?.('li,label,a,button,[onclick],[role="button"],[val-param]')) break;
      }
    };
    const preciseLi = findChaoxingOptionLi(q, label, text);
    add(preciseLi);
    if (!preciseLi) visualOptionClickTargets(q, label, text).forEach(add);
    add(opt.el);
    if (root?.querySelectorAll) {
      const nodes = Array.from(root.querySelectorAll('input,li,label,a,button,span,div,em,[id-param],[val-param]'))
        .filter(el => !el.closest(`#${PANEL_ID}`))
        .filter(visible);
      for (const el of nodes) {
        const idp = String(el.getAttribute('id-param') || el.getAttribute('data') || '').toUpperCase();
        const val = String(el.getAttribute('val-param') || '').toLowerCase();
        const elLabel = optionLabelFromElement(el);
        const txt = cleanText(el.innerText || el.textContent || el.value || '');
        if (idp === label || elLabel === label) add(el.closest?.('li[id-param],li,label') || el);
        if (txt === label || (text && txt === text)) add(el);
        if (text && new RegExp(`(^|\\s)${escapeReg(label)}\\s*[.、．]?\\s*${escapeReg(text)}($|\\s)`, 'i').test(txt)) add(el);
        if (q?.typeText === '判断题' && label === 'A' && /^(true|1)$/.test(val)) add(el);
        if (q?.typeText === '判断题' && label === 'B' && /^(false|0)$/.test(val)) add(el);
      }
    }
    return uniqBy(candidates, cssPath)
      .sort((a, b) => {
        const score = el => {
          let s = cleanText(el.innerText || el.textContent || '').length;
          if (el.matches?.('li[id-param],li[val-param]')) s -= 120;
          if (el.matches?.('label,button,a,[onclick],[role="button"]')) s -= 60;
          if (el.matches?.('em,span,i,b') && !el.matches?.('[onclick]')) s += 40;
          return s;
        };
        return score(a) - score(b);
      });
  }

  function optionVerticalBounds(q) {
    const rootRect = q?.root?.getBoundingClientRect?.();
    const nextRect = q?.nextRoot?.getBoundingClientRect?.();
    const top = rootRect ? rootRect.top - 8 : -Infinity;
    let bottom = nextRect ? nextRect.top - 6 : (rootRect ? rootRect.bottom + 260 : Infinity);
    if (rootRect && (!Number.isFinite(bottom) || bottom <= top + 60)) bottom = rootRect.bottom + 260;
    return { top, bottom };
  }

  function optionContainerAround(el, label, text) {
    let best = el;
    const wantText = norm(text || '');
    for (let n = el, depth = 0; n && depth < 7; depth++, n = n.parentElement) {
      if (!visible(n) || n.closest?.(`#${PANEL_ID}`)) continue;
      const r = n.getBoundingClientRect();
      const t = cleanText(n.innerText || n.textContent || '');
      if (r.height > 0 && r.height <= 90 && r.width > 0 && r.width <= 900 && t.length <= 140) {
        best = n;
        const nt = norm(t);
        if ((!wantText || nt.includes(wantText)) && (t.includes(label) || optionLabelFromElement(n) === label)) break;
      }
    }
    return best;
  }

  function findVisualOptionByPosition(q, label, text = '') {
    if (!q?.root) return null;
    const l = String(label || '').toUpperCase();
    const wantText = cleanText(text || optionTextForLabel(q.typeText, l));
    const wantNorm = norm(wantText);
    const { top, bottom } = optionVerticalBounds(q);
    const rootRect = q.root.getBoundingClientRect?.();
    const nodes = Array.from(D.querySelectorAll('li,label,button,a,span,div,em,i,b'))
      .filter(el => !el.closest(`#${PANEL_ID}`))
      .filter(visible)
      .map(el => ({ el, rect: el.getBoundingClientRect(), txt: cleanText(el.innerText || el.textContent || el.value || '') }))
      .filter(x => x.rect.top >= top && x.rect.top < bottom && x.rect.height > 0 && x.rect.height <= 100 && x.rect.width > 0 && x.txt.length > 0 && x.txt.length <= 160);
    const scored = [];
    for (const item of nodes) {
      const elLabel = optionLabelFromElement(item.el);
      const nt = norm(item.txt);
      let matched = false;
      let score = 1000;
      if (item.txt.trim().toUpperCase() === l || elLabel === l) { matched = true; score -= 520; }
      if (wantNorm && nt === wantNorm) { matched = true; score -= 420; }
      if (wantNorm && nt && (nt.includes(wantNorm) || wantNorm.includes(nt))) { matched = true; score -= 160; }
      if (!matched) continue;
      const target = optionContainerAround(item.el, l, wantText);
      const tr = target.getBoundingClientRect();
      const tt = cleanText(target.innerText || target.textContent || '');
      const ttn = norm(tt);
      if (tt.includes(l) || optionLabelFromElement(target) === l) score -= 120;
      if (wantNorm && ttn.includes(wantNorm)) score -= 90;
      if (rootRect) {
        score += Math.abs(tr.top - rootRect.bottom) / 3;
        if (tr.left < rootRect.left - 80) score += 80;
        if (tr.left > rootRect.left + 1200) score += 80;
      }
      score += Math.min(tt.length, 80);
      scored.push({ target, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored[0]?.target || null;
  }

  function elementFromCenter(el, dx = 0, dy = 0) {
    const r = el?.getBoundingClientRect?.();
    if (!r) return null;
    const x = Math.max(1, Math.min(W.innerWidth - 1, r.left + r.width / 2 + dx));
    const y = Math.max(1, Math.min(W.innerHeight - 1, r.top + r.height / 2 + dy));
    return D.elementFromPoint(x, y);
  }

  function visualOptionClickTargets(q, label, text = '') {
    const l = String(label || '').toUpperCase();
    const wantText = cleanText(text || optionTextForLabel(q?.typeText, l));
    const wantNorm = norm(wantText);
    const { top, bottom } = optionVerticalBounds(q);
    const found = [];
    const pushAround = el => {
      if (!el || !visible(el) || el.closest?.(`#${PANEL_ID}`)) return;
      const container = optionContainerAround(el, l, wantText);
      found.push(el, container, el.parentElement, container?.parentElement, elementFromCenter(el), elementFromCenter(container));
      const er = el.getBoundingClientRect?.();
      if (er) found.push(D.elementFromPoint(Math.max(1, er.left + 8), Math.max(1, er.top + er.height / 2)));
      const cr = container?.getBoundingClientRect?.();
      if (cr) found.push(D.elementFromPoint(Math.max(1, cr.left + 24), Math.max(1, cr.top + cr.height / 2)));
    };
    pushAround(findChaoxingOptionLi(q, l, wantText));
    pushAround(findVisualOptionByPosition(q, l, wantText));
    const nodes = Array.from(D.querySelectorAll('li,label,button,a,span,div,em,i,b'))
      .filter(el => !el.closest(`#${PANEL_ID}`))
      .filter(visible)
      .map(el => ({ el, rect: el.getBoundingClientRect(), txt: cleanText(el.innerText || el.textContent || el.value || '') }))
      .filter(x => x.rect.top >= top && x.rect.top < bottom && x.rect.height > 0 && x.rect.height <= 100 && x.rect.width > 0 && x.txt.length > 0 && x.txt.length <= 160)
      .map(x => {
        const nt = norm(x.txt);
        let score = 100;
        if (x.txt.trim().toUpperCase() === l || optionLabelFromElement(x.el) === l) score -= 80;
        if (wantNorm && nt === wantNorm) score -= 70;
        if (wantNorm && nt && (nt.includes(wantNorm) || wantNorm.includes(nt))) score -= 25;
        score += Math.min(x.txt.length, 80);
        return { ...x, score };
      })
      .filter(x => x.score < 100)
      .sort((a, b) => a.score - b.score)
      .slice(0, 6);
    nodes.forEach(x => pushAround(x.el));
    return uniqBy(found.filter(Boolean).filter(el => visible(el) && !el.closest?.(`#${PANEL_ID}`)), cssPath);
  }

  function optionAnswerValue(q, opt) {
    const label = String(opt?.label || '').toUpperCase();
    const val = String(opt?.el?.getAttribute?.('val-param') || opt?.val || '').toLowerCase();
    if (/^(true|false|0|1)$/.test(val)) return val;
    if (q?.typeText === '判断题') {
      if (label === 'A') return 'true';
      if (label === 'B') return 'false';
    }
    return label || cleanText(opt?.text || '');
  }

  function setNativeValue(el, value) {
    try {
      const proto = el instanceof W.HTMLTextAreaElement ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      if (el._valueTracker) el._valueTracker.setValue('');
    } catch (_) {
      el.value = value;
    }
  }

  function setNativeChecked(el, checked) {
    try {
      const setter = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, 'checked')?.set;
      if (setter) setter.call(el, checked);
      else el.checked = checked;
      if (el._valueTracker) el._valueTracker.setValue(String(!checked));
    } catch (_) {
      el.checked = checked;
    }
  }

  function dispatchInputChange(el) {
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
    try { el.dispatchEvent(new Event('blur', { bubbles: true })); } catch (_) {}
  }

  function markVisualPicked(q, opt, target) {
    if (!target) return false;
    const picked = optionContainerAround(target, String(opt?.label || '').toUpperCase(), opt?.text || '') || target;
    if (q?.typeText !== '多选题' && !q?.__cxllmForceMulti) {
      const { top, bottom } = optionVerticalBounds(q);
      Array.from(D.querySelectorAll('[data-cxllm-picked="1"],.cur,.selected,.active,.checked,.on'))
        .filter(el => !el.closest(`#${PANEL_ID}`))
        .filter(el => {
          const r = el.getBoundingClientRect?.();
          return r && r.top >= top && r.top < bottom;
        })
        .forEach(el => {
          if (el === picked || picked.contains?.(el)) return;
          el.classList.remove('cur', 'selected', 'active', 'checked', 'on');
          el.removeAttribute('data-cxllm-picked');
          el.style.background = '';
          Array.from(el.querySelectorAll?.('[data-cxllm-picked-dot="1"]') || []).forEach(dot => {
            dot.removeAttribute('data-cxllm-picked-dot');
            dot.style.background = '';
            dot.style.borderColor = '';
            dot.style.color = '';
          });
          if (el.getAttribute('aria-checked') === 'true') el.setAttribute('aria-checked', 'false');
        });
    }
    picked.classList.add('cur', 'selected');
    picked.setAttribute('data-cxllm-picked', '1');
    picked.setAttribute('aria-checked', 'true');
    try {
      picked.style.background = '#eef6ff';
      const label = String(opt?.label || '').toUpperCase();
      const smalls = Array.from(picked.querySelectorAll?.('*') || [])
        .filter(visible)
        .filter(el => {
          const r = el.getBoundingClientRect();
          const t = cleanText(el.innerText || el.textContent || '');
          return t === label || (r.width >= 18 && r.width <= 42 && r.height >= 18 && r.height <= 42 && t.length <= 2);
        })
        .slice(0, 3);
      for (const el of smalls) {
        el.setAttribute('data-cxllm-picked-dot', '1');
        el.style.background = '#2f80ed';
        el.style.borderColor = '#2f80ed';
        el.style.color = '#fff';
      }
    } catch (_) {}
    return true;
  }

  function answerInputsForQuestion(q) {
    const answerScopes = uniqBy([q?.root, q?.root?.parentElement, q?.root?.parentElement?.parentElement].filter(Boolean), cssPath);
    const key = questionKey(q);
    let answerInputs = uniqBy(answerScopes.flatMap(scope => Array.from(scope.querySelectorAll?.('input[name*="answer"],input[id*="answer"],textarea[name*="answer"]') || [])), cssPath)
      .filter(el => !/^answertype/i.test(el.id || '') && !/type/i.test(el.name || ''));
    if (key) {
      answerInputs = answerInputs.filter(el => String(el.name || el.id || '').includes(key));
    } else if (answerInputs.length > 1 && q?.root?.contains) {
      answerInputs = answerInputs.filter(el => q.root.contains(el));
    }
    return answerInputs;
  }

  function setQuestionAnswerValue(q, value) {
    let changed = false;
    for (const input of answerInputsForQuestion(q)) {
      setNativeValue(input, String(value || ''));
      dispatchInputChange(input);
      changed = true;
    }
    return changed;
  }

  function optionTargetFor(q, opt) {
    const label = String(opt?.label || '').toUpperCase();
    return findChaoxingOptionLi(q, label, opt?.text) || findVisualOptionByPosition(q, label, opt?.text) || (opt?.el && opt.el !== q?.root ? opt.el : null);
  }

  function fullMultiAnswerValue(targets) {
    return [...new Set(targets.map(o => String(o?.label || '').toUpperCase()).filter(Boolean))]
      .sort()
      .join('');
  }

  function forceSetAnswer(q, opt) {
    const label = String(opt?.label || '').toUpperCase();
    if (!label) return false;
    const target = optionTargetFor(q, opt);
    let changed = false;
    const value = optionAnswerValue(q, { ...opt, el: target || opt?.el });

    const inputScopes = uniqBy([target, target?.parentElement].filter(Boolean), cssPath);
    for (const scope of inputScopes) {
      const inputs = Array.from(scope.querySelectorAll?.('input[type="radio"],input[type="checkbox"]') || []);
      for (const input of inputs) {
        setNativeChecked(input, true);
        input.setAttribute('checked', 'checked');
        dispatchInputChange(input);
        changed = true;
      }
    }

    for (const input of answerInputsForQuestion(q)) {
      if (q?.typeText === '多选题' || q?.__cxllmForceMulti) {
        const oldVal = String(input.value || '').replace(/[^A-H]/gi, '').toUpperCase();
        const merged = [...new Set(`${oldVal}${label}`.split('').filter(Boolean))].sort().join('');
        setNativeValue(input, merged);
      } else {
        setNativeValue(input, value);
      }
      dispatchInputChange(input);
      changed = true;
    }

    if (target) {
      markVisualPicked(q, opt, target);
      // 多选自定义控件常常没有真实 input；只要找到了目标，也要把该项视觉选中并参与后续确认。
      if (q?.typeText === '多选题' || q?.__cxllmForceMulti) changed = true;
    }
    return changed;
  }

  function dispatchClick(el, opts = {}) {
    if (opts.scroll) {
      try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
    }
    try { el.focus?.({ preventScroll: true }); } catch (_) { try { el.focus?.(); } catch (__) {} }
    const rect = el.getBoundingClientRect?.();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: W,
      clientX: rect ? rect.left + rect.width / 2 : 0,
      clientY: rect ? rect.top + rect.height / 2 : 0,
      screenX: rect ? rect.left + rect.width / 2 + W.screenX : 0,
      screenY: rect ? rect.top + rect.height / 2 + W.screenY : 0,
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true
    };
    for (const type of ['mouseover', 'mousemove', 'pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        const Evt = type.startsWith('pointer') && typeof W.PointerEvent === 'function' ? W.PointerEvent : W.MouseEvent;
        el.dispatchEvent(new Evt(type, eventInit));
      } catch (_) {}
    }
    try { el.click?.(); } catch (_) {}
    try { W.jQuery?.(el).trigger?.('click'); } catch (_) {}
    try { W.$?.(el).trigger?.('click'); } catch (_) {}
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
  }

  function optionValueConfirmed(q, opt) {
    const root = q?.root || opt?.root || opt?.el;
    if (!root?.querySelectorAll) return false;
    const label = String(opt?.label || '').toUpperCase();
    const values = new Set([label, String(opt?.val || '').toLowerCase(), String(opt?.el?.getAttribute?.('val-param') || '').toLowerCase(), norm(opt?.text || '')].filter(Boolean));
    if (q?.typeText === '判断题') {
      if (label === 'A') ['true', '1', '对', '正确'].forEach(v => values.add(v));
      if (label === 'B') ['false', '0', '错', '错误'].forEach(v => values.add(v));
    }
    const scopes = uniqBy([root, root.parentElement, root.parentElement?.parentElement].filter(Boolean), cssPath);
    const key = questionKey(q);
    let inputs = uniqBy(scopes.flatMap(scope => Array.from(scope.querySelectorAll?.('input[name*="answer"],input[id*="answer"],textarea,input[type="radio"],input[type="checkbox"]') || [])), cssPath)
      .filter(el => !/^answertype/i.test(el.id || ''));
    if (key) {
      inputs = inputs.filter(el => {
        const name = String(el.name || el.id || '');
        return !name || name.includes(key) || el.closest?.('[data-cxllm-picked="1"],.cur,.selected');
      });
    }
    return inputs.some(input => {
      if (input.matches?.('input[type="radio"],input[type="checkbox"]')) {
        return input.checked && (values.has(String(input.value || '').toLowerCase()) || values.has(norm(input.value || '')));
      }
      const v = cleanText(input.value || '');
      const vu = v.toUpperCase().replace(/[^A-H]/g, '');
      if ((q?.typeText === '多选题' || q?.__cxllmForceMulti) && label && vu.includes(label)) return true;
      return v && (values.has(v.toUpperCase()) || values.has(v.toLowerCase()) || values.has(norm(v)));
    });
  }

  function optionConfirmed(q, opt, target) {
    const concrete = findChaoxingOptionLi(q, opt?.label, opt?.text) || findVisualOptionByPosition(q, opt?.label, opt?.text) || opt?.el;
    return optionValueConfirmed(q, { ...opt, el: concrete }) || isSelected(concrete) || isSelected(opt?.el) || isSelected(target);
  }

  function optionUiConfirmed(q, opt, target) {
    const concrete = findChaoxingOptionLi(q, opt?.label, opt?.text) || findVisualOptionByPosition(q, opt?.label, opt?.text) || opt?.el;
    return isSelected(concrete) || isSelected(opt?.el) || isSelected(target);
  }

  async function ensureQuestionVisible(q) {
    const root = q?.root;
    if (!root?.getBoundingClientRect) return;
    const r = root.getBoundingClientRect();
    const topLimit = 92;
    const bottomLimit = Math.max(220, W.innerHeight - 120);
    if (r.top < topLimit || r.top > bottomLimit || r.bottom < topLimit || r.bottom > W.innerHeight + 260) {
      try { root.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
      await sleep(120);
    }
  }

  async function clickOption(opt, q, opts = {}) {
    const root = q?.root || opt.root || opt.el;
    const concrete = findChaoxingOptionLi(q, opt.label, opt.text);
    if (concrete) opt = { ...opt, el: concrete, val: concrete.getAttribute?.('val-param') || opt.val, selected: () => isSelected(concrete) };
    const confirm = opts.ignoreAnswerValue ? optionUiConfirmed : optionConfirmed;
    if (confirm(q, opt, opt.el)) return true;
    const before = answerStateSignature(root);
    const targets = optionClickTargets(opt, q);
    for (const target of targets) {
      dispatchClick(target);
      for (let i = 0; i < 2; i++) {
        await sleep(30);
        if (confirm(q, opt, target)) return true;
      }
      const after = answerStateSignature(root);
      if (after && after !== before && confirm(q, opt, target)) return true;
    }
    // 兜底：部分新版学习通页面把选项做成自定义组件，普通 click 不改变 DOM。
    // 这里写入真实 radio/checkbox/answer 字段，并补一个纯展示用的选中态，避免“填上了但看不出来”。
    if (forceSetAnswer(q, opt)) {
      await sleep(80);
      if (optionConfirmed(q, opt, opt.el)) return true;
    }
    return false;
  }

  function parseLabels(answer) {
    const raw = String(answer || '').trim();
    const compact = raw.toUpperCase().replace(/[，、；;,\s|]+/g, '');
    if (/^[A-H]+$/.test(compact)) return [...new Set(compact.split(''))];
    const m = raw.match(/(?:答案|选项|answer|ans|为|是)?\s*[:：]?\s*([A-H](?:[\s,，、;；和及]*[A-H])*)/i);
    if (m && m[1]) {
      const s = m[1].toUpperCase().replace(/[，、；;,\s和及]+/g, '');
      if (/^[A-H]+$/.test(s)) return [...new Set(s.split(''))];
    }
    return [];
  }

  function optionByLabel(q, label) {
    const normalized = String(label || '').trim().toUpperCase();
    const exact = q.options.find(o => String(o.label || '').trim().toUpperCase() === normalized);
    if (exact) return exact;
    if (/^[A-H]$/.test(normalized)) {
      const idx = normalized.charCodeAt(0) - 65;
      if (idx >= 0 && idx < q.options.length) return q.options[idx];
      const text = optionTextForLabel(q.typeText, normalized);
      const el = findOptionElementInRoot(q.root, normalized, text);
      if (el) return { label: normalized, text, el, root: q.root, selected: () => isSelected(el), val: normalized === 'A' ? 'true' : 'false', synthetic: true };
    }
    return null;
  }

  function findOptionByAnswer(q, answer) {
    const labels = parseLabels(answer);
    if (labels.length) return labels.map(l => optionByLabel(q, l)).filter(Boolean);

    const a = norm(answer);
    if (q.typeText === '判断题') {
      const positive = /^(对|正确|是|true|t|yes|y|√)$/i.test(a) || /(正确|对的|true)/i.test(String(answer));
      const negative = /^(错|错误|否|false|f|no|n|×|x)$/i.test(a) || /(错误|错的|false)/i.test(String(answer));
      if (positive || negative) {
        return q.options.filter(o => {
          const ot = norm(o.text || o.val);
          return positive
            ? /^(对|正确|true)$/.test(ot)
            : /^(错|错误|false)$/.test(ot);
        });
      }
    }
    const exact = q.options.find(o => norm(o.text) === a);
    if (exact) return [exact];
    const contains = q.options.filter(o => {
      const ot = norm(o.text);
      return ot && (a.includes(ot) || ot.includes(a));
    });
    return contains;
  }

  async function applyAnswer(q, answer) {
    if (q.options.length) {
      const targets = findOptionByAnswer(q, answer);
      if (!targets.length) return false;
      let changed = false;
      const multiMode = q.typeText === '多选题' || targets.length > 1;
      if (multiMode) {
        q.__cxllmForceMulti = true;
        // 多选必须逐个真实点击；点击完成后再写入整题隐藏答案，避免预写值导致后续选项被误判为已选。
        const fullValue = fullMultiAnswerValue(targets);
        let allOk = true;
        for (const opt of targets) {
          const target = optionTargetFor(q, opt);
          const already = optionUiConfirmed(q, opt, target || opt.el) || opt.selected?.();
          const ok = already || await clickOption(opt, q, { ignoreAnswerValue: true });
          if (ok && target) markVisualPicked(q, opt, target);
          changed = ok || changed;
          if (!ok) allOk = false;
          await sleep(40);
        }
        setQuestionAnswerValue(q, fullValue);
        delete q.__cxllmForceMulti;
        // 多选题只做补选，不自动取消，避免误删用户/页面已有选择。
        return allOk;
      } else {
        changed = await clickOption(targets[0], q);
      }
      return changed;
    }
    const labels = parseLabels(answer);
    if (labels.length) {
      const targets = labels.map(l => optionByLabel(q, l)).filter(Boolean);
      if (targets.length) {
        let ok = false;
        for (const target of targets) ok = (await clickOption(target, q)) || ok;
        return ok;
      }
    }
    if (q.inputs.length) {
      for (const input of q.inputs) {
        input.value = String(answer || '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }
    return false;
  }

  function runPooled(items, limit, worker) {
    const resolvers = new Array(items.length);
    const promises = items.map((_, i) => new Promise(resolve => { resolvers[i] = resolve; }));
    let cursor = 0;
    async function workerLoop() {
      while (cursor < items.length) {
        const i = cursor++;
        try {
          resolvers[i](await worker(items[i], i));
        } catch (e) {
          resolvers[i]({ __error: e });
        }
      }
    }
    const n = Math.min(limit, items.length) || 0;
    for (let k = 0; k < n; k++) workerLoop();
    return promises;
  }

  function startModelProgress(label) {
    const started = Date.now();
    let ticks = 0;
    log(`${label}：已发送请求，等待模型思考...`);
    const timer = setInterval(() => {
      ticks++;
      const sec = Math.round((Date.now() - started) / 1000);
      log(`${label}：模型思考中 ${sec}s${'.'.repeat(ticks % 4)}`);
    }, 8000);
    return extra => {
      clearInterval(timer);
      const sec = ((Date.now() - started) / 1000).toFixed(1);
      log(`${label}：模型返回，用时 ${sec}s${extra ? `，${extra}` : ''}`, 'ok');
    };
  }

  function questionRangeText(batch) {
    if (!batch.length) return '';
    return `#${batch[0].index}-#${batch[batch.length - 1].index}`;
  }

  async function answerCurrentPage(allowAfterAction = true) {
    const cfg = getCfg();
    const questions = extractQuestions();
    if (!questions.length) {
      log('当前页未识别到题目', 'warn');
      return false;
    }
    log(`识别到 ${questions.length} 题`);
    const batches = [];
    for (let i = 0; i < questions.length; i += cfg.batchSize) {
      batches.push(questions.slice(i, i + cfg.batchSize));
    }
    let ok = 0, fail = 0, aborted = false;
    const allAnswers = [];
    for (let bi = 0; bi < batches.length; bi++) {
      if (!isRunning() && allowAfterAction) {
        log('运行已停止，退出答题', 'warn');
        aborted = true;
        break;
      }
      touchRunning(false);
      const batch = batches[bi];
      const label = `模型思考：第 ${bi + 1}/${batches.length} 批（${questionRangeText(batch)}，${batch.length} 题）`;
      const stopProgress = startModelProgress(label);
      let answers;
      try {
        answers = await askLLM(batch);
        stopProgress(`收到 ${answers.length} 个答案`);
      } catch (e) {
        stopProgress('请求失败');
        log(`模型调用失败：${e.message || e}`, 'error');
        fail += batch.length;
        continue;
      }
      allAnswers.push(...answers);
      log(`开始填题：第 ${bi + 1}/${batches.length} 批（${questionRangeText(batch)}）`);
      const byId = new Map();
      answers.forEach((a, idx) => {
        const id = String(a.id ?? a.question_id ?? a.no ?? a.index ?? batch[idx]?.id ?? '');
        byId.set(id, a);
      });
      for (let i = 0; i < batch.length; i++) {
        if (!isRunning() && allowAfterAction) {
          log('运行已停止，退出当前批次', 'warn');
          aborted = true;
          break;
        }
        const q = batch[i];
        const a = byId.get(q.id) || answers[i] || {};
        const ans = a.answer ?? a.answers ?? a.option ?? a.result ?? '';
        await ensureQuestionVisible(q);
        const done = await applyAnswer(q, ans);
        if (done) {
          ok++;
          log(`#${q.index} ${q.typeText} => ${String(ans).slice(0, 80)}`, 'ok');
        } else {
          fail++;
          const optionInfo = q.options.map(o => `${o.label || '?'}:${o.text || o.val || ''}`).join(' | ');
          const matched = q.options.length && findOptionByAnswer(q, ans).length;
          const reason = matched ? '已匹配但页面未确认选中' : '未能匹配答案';
          log(`#${q.index} ${reason}：${String(ans).slice(0, 100)}；页面选项：${optionInfo}`, 'warn');
        }
        if ((i + 1) % 10 === 0 || i === batch.length - 1) {
          log(`填题进度：第 ${bi + 1}/${batches.length} 批 ${i + 1}/${batch.length}，累计成功 ${ok}，失败 ${fail}`);
        }
        await sleep(cfg.delayMs);
      }
      if (aborted) break;
    }
    W.__cxllm_last_answers = allAnswers;
    log(`填题完成：成功 ${ok}，失败/未填 ${fail}`, fail ? 'warn' : 'ok');
    if (allowAfterAction) {
      if (aborted) {
        log('运行被中途停止，已阻止自动提交/保存，请手动检查后再操作。', 'error');
        setRunning(false);
      } else if (fail > 0) {
        log('存在未确认选中的题目，已阻止自动提交，请检查后手动提交或重试。', 'error');
        setRunning(false);
      } else {
        await afterAnswerAction();
      }
    }
    return true;
  }

  async function afterAnswerAction() {
    const cfg = getCfg();
    if (cfg.autoSubmit) {
      log('准备自动提交');
      await sleep(1000);
      const submitted = await submitWork();
      await sleep(2500);
      if (submitted && cfg.loopList) {
        log('提交链路已执行，返回列表继续扫描');
        goBackListOrHistory();
      } else {
        log('提交链路未确认完成，已停留当前页，避免触发离页提示。', submitted ? 'warn' : 'error');
        setRunning(false);
      }
      return;
    }
    if (cfg.autoSave) {
      log('准备自动保存/暂存');
      await sleep(1000);
      const saved = await saveWork();
      await sleep(2500);
      if (saved && cfg.loopList) goBackListOrHistory();
      else setRunning(false);
      return;
    }
    log('未开启自动保存/提交，已停留在当前页');
    setRunning(false);
  }

  function disableLeavePrompt() {
    const clearOne = win => {
      try { win.onbeforeunload = null; } catch (_) {}
      try { win.onunload = null; } catch (_) {}
      try { win.document?.body?.removeAttribute?.('onbeforeunload'); } catch (_) {}
      try { win.document?.body?.removeAttribute?.('onunload'); } catch (_) {}
    };
    clearOne(W);
    try { clearOne(W.top); } catch (_) {}
  }

  function looksLikeSubmitDone() {
    const txt = cleanText(D.body?.innerText || '');
    return /(提交成功|已提交|提交完成|作业已提交|待批阅|查看结果|已完成)/.test(txt)
      || /selectWorkQuestionYiPiYue|workResult|workAnswer/i.test(location.href);
  }

  async function clickSubmitConfirm(timeoutMs = 8000) {
    const started = Date.now();
    const selectors = [
      '.cx_alert-blue',
      '.layui-layer-btn0',
      '.layui-layer-btn a',
      '.el-message-box__btns button',
      '.el-button--primary',
      '.ant-modal-confirm-btns button',
      '.modal-footer button',
      '.dialog button,.dialog a,.pop button,.pop a,.cx_alert button,.cx_alert a'
    ];
    while (Date.now() - started < timeoutMs) {
      disableLeavePrompt();
      if (looksLikeSubmitDone()) return true;
      const bySelector = selectors.flatMap(sel => Array.from(D.querySelectorAll(sel)));
      const byText = Array.from(D.querySelectorAll('button,a,span,div,input[type="button"],input[type="submit"]'));
      const candidates = uniqBy([...bySelector, ...byText], cssPath)
        .filter(visible)
        .filter(el => !el.closest?.(`#${PANEL_ID}`))
        .map(el => ({
          el,
          text: cleanText(el.value || el.innerText || el.textContent || ''),
          cls: String(el.className || ''),
          ctx: String(el.closest?.('[class]')?.className || '') + ' ' + String(el.parentElement?.className || '')
        }))
        .filter(x => {
          const modalish = /cx_alert|layui|modal|dialog|pop|message|layer|confirm|btn/i.test(`${x.cls} ${x.ctx}`);
          if (/cx_alert-blue|layui-layer-btn0|el-button--primary/.test(x.cls)) return true;
          if (x.text === '提交' && !modalish) return false; // 排除页面右上角常驻提交按钮，避免误判二次确认
          return /^(确定|确认|确认提交|提交|继续提交|我知道了|知道了)$/.test(x.text)
            || /确认提交|确定提交|继续提交/.test(x.text);
        });
      if (candidates.length) {
        const picked = candidates.sort((a, b) => {
          const score = x => (/^(确定|确认|确认提交|继续提交)$/.test(x.text) ? 0 : 20) + Math.min(x.text.length, 30);
          return score(a) - score(b);
        })[0];
        humanClick(picked.el);
        dispatchClick(picked.el);
        log(`已点击提交确认：${picked.text || picked.cls}`, 'ok');
        await sleep(1200);
        if (looksLikeSubmitDone()) return true;
        return true;
      }
      await sleep(300);
    }
    return looksLikeSubmitDone();
  }

  async function submitWork() {
    disableLeavePrompt();
    try { W.confirm = () => true; } catch (_) {}
    try { W.top.confirm = () => true; } catch (_) {}
    try { W.alert = msg => log(`页面 alert：${String(msg || '').slice(0, 120)}`, 'warn'); } catch (_) {}
    try { if (typeof W.submitCheckTimes === 'function') W.submitCheckTimes(); } catch (e) { log(`submitCheckTimes 异常：${e.message || e}`, 'warn'); }
    try { if (typeof W.escapeBlank === 'function') W.escapeBlank(); } catch (e) { log(`escapeBlank 异常：${e.message || e}`, 'warn'); }
    let triggered = false;
    try {
      if (typeof W.submitAction === 'function') {
        W.submitAction();
        triggered = true;
        log('已调用 submitAction()', 'ok');
      }
    } catch (e) {
      log(`submitAction 调用异常：${e.message || e}`, 'warn');
    }
    if (!triggered) triggered = clickByText(['提交', '确认提交', '交卷']);
    const confirmed = await clickSubmitConfirm(triggered ? 9000 : 4000);
    disableLeavePrompt();
    if (confirmed) log('提交确认链路已执行', 'ok');
    else log('未检测到提交确认按钮/成功状态', 'warn');
    return confirmed;
  }

  async function saveWork() {
    disableLeavePrompt();
    try {
      if (typeof W.noSubmit === 'function') {
        W.noSubmit();
        log('已调用 noSubmit()', 'ok');
        await sleep(800);
        disableLeavePrompt();
        return true;
      }
    } catch (e) {
      log(`noSubmit 调用异常：${e.message || e}`, 'warn');
    }
    const clicked = clickByText(['暂时保存', '保存', '保存答案']);
    await sleep(800);
    disableLeavePrompt();
    return clicked;
  }

  function clickByText(words) {
    const els = Array.from(D.querySelectorAll('button,a,div,span,input[type="button"],input[type="submit"]'))
      .filter(visible)
      .filter(el => {
        const t = cleanText(el.value || el.innerText);
        return words.some(w => t === w || t.includes(w));
      });
    if (!els.length) {
      log(`没有找到按钮：${words.join('/')}`, 'warn');
      return false;
    }
    els[0].click();
    log(`已点击：${cleanText(els[0].value || els[0].innerText)}`, 'ok');
    return true;
  }

  function goBackListOrHistory() {
    const listUrl = gmGet('listUrl', '');
    markPendingContinue();
    if (listUrl) {
      log('返回作业列表继续扫描');
      location.href = listUrl;
    } else {
      log('未记录列表页，执行 history.back()');
      history.back();
    }
  }

  function workUrlFrom(el) {
    if (!el) return '';
    const a = el.matches?.('a[href]') ? el : el.querySelector?.('a[href*="work"],a[href*="workId"],a[href*="dowork"]');
    const href = a?.getAttribute('href') || '';
    if (href && !/^javascript:/i.test(href)) return new URL(href, location.href).href;
    const onclick = el.getAttribute?.('onclick') || a?.getAttribute?.('onclick') || '';
    const m = onclick.match(/https?:\/\/[^'")\s]+|\/[^'")\s]+(?:work|dowork|workId)[^'")\s]*/i);
    if (m) return new URL(m[0], location.href).href;
    return '';
  }

  function workKeywordText(txt) {
    return /(作业|测试|练习|模拟|判断|单选|多选|期末|章节|导论|第[一二三四五六七八九十\d]+章)/.test(txt);
  }

  function unfinishedText(txt) {
    return /(未交|未提交|未完成|未做|待做|待完成|待提交|未答)/.test(txt)
      && !/(已交|已提交|已完成|已批阅|提交成功)/.test(txt);
  }

  function rowLikeText(txt) {
    return txt && txt.length >= 4 && txt.length < 1600 && unfinishedText(txt) && workKeywordText(txt)
      && !/智能分析|大雅相似度/.test(txt);
  }

  function directClickableCount(el) {
    if (!el || !el.querySelectorAll) return 0;
    return Array.from(el.querySelectorAll('a[href],[onclick],button,[role="button"],[tabindex]'))
      .filter(visible).length;
  }

  function closestRow(el) {
    const candidates = [];
    let n = el;
    for (let depth = 0; n && depth < 16; depth++, n = n.parentElement) {
      if (n.closest?.(`#${PANEL_ID}`)) break;
      if (n.querySelector?.(`#${PANEL_ID}`)) continue;
      const txt = cleanText(n.innerText || n.textContent || '');
      if (!rowLikeText(txt)) continue;
      const r = n.getBoundingClientRect();
      const unfinishedCount = (txt.match(/未交|未提交|未完成|未做|待做|待完成|待提交|未答/g) || []).length;
      let score = depth * 8 + Math.min(txt.length / 20, 60) + Math.max(0, unfinishedCount - 1) * 35;
      if (r.height > 0 && r.height <= 180) score -= 35;
      if (r.width >= 300) score -= 15;
      if (directClickableCount(n)) score -= 10;
      candidates.push({ el: n, score, txt });
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0]?.el || el;
  }

  function isBadWorkClickText(txt) {
    return !txt || /^(作业|考试|未交|未提交|未完成|已完成|已交|已提交|剩余|筛选)$/.test(txt) || txt.length < 2;
  }

  function findWorkTarget(row) {
    if (!row) return null;
    const all = Array.from(row.querySelectorAll('a[href],[onclick],button,[role="button"],[tabindex],.jobCount,.work,.work-name,.title,.name,span,div'))
      .filter(el => !el.closest(`#${PANEL_ID}`))
      .filter(visible);
    const scored = all.map(el => {
      const txt = cleanText(el.value || el.innerText || el.textContent || '');
      const cls = String(el.className || '');
      const tag = el.tagName.toLowerCase();
      let score = 100;
      if (isBadWorkClickText(txt)) score += 80;
      if (/作业|测试|练习|模拟|判断|单选|多选|期末|章节|导论|第[一二三四五六七八九十\d]+章/.test(txt)) score -= 80;
      if (el.matches('a[href],[onclick],button,[role="button"],[tabindex]')) score -= 45;
      if (/work|job|title|name|item|task/i.test(cls)) score -= 25;
      if (/blue|icon|tag|status|label/i.test(cls) || txt === '作业') score += 45;
      if (tag === 'span' || tag === 'div') score += 5;
      score += Math.min(txt.length / 4, 60);
      return { el, score, txt };
    }).filter(x => !isBadWorkClickText(x.txt) || x.score < 100);
    scored.sort((a, b) => a.score - b.score);
    return scored[0]?.el || row;
  }

  function pushWorkCandidate(cands, row, preferredTarget = null) {
    if (!row || !visible(row)) return;
    if (row.closest?.(`#${PANEL_ID}`) || row.querySelector?.(`#${PANEL_ID}`)) return;
    const txt = cleanText(row.innerText || row.textContent || '');
    if (!rowLikeText(txt)) return;
    const target = preferredTarget || findWorkTarget(row);
    if (!target) return;
    cands.push({ el: target, row, text: txt, url: workUrlFrom(target) || workUrlFrom(row) });
  }

  function collectUnfinishedWorks() {
    const cands = [];
    const clickables = Array.from(D.querySelectorAll(
      'a[href*="work"],a[href*="workId"],a[href*="dowork"],[onclick*="work"],[onclick*="Work"],[onclick*="workId"],[onclick*="dowork"]'
    )).filter(visible);
    for (const el of clickables) {
      pushWorkCandidate(cands, closestRow(el), el);
    }

    const statusLeaves = Array.from(D.querySelectorAll('body *'))
      .filter(el => !el.closest(`#${PANEL_ID}`))
      .filter(el => {
        const txt = cleanText(el.innerText || el.textContent || '');
        return txt.length > 0 && txt.length < 180 && unfinishedText(txt);
      });
    for (const leaf of statusLeaves) {
      pushWorkCandidate(cands, closestRow(leaf));
    }

    const textWalker = D.createTreeWalker(D.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest(`#${PANEL_ID}`)) return NodeFilter.FILTER_REJECT;
        const txt = cleanText(node.nodeValue || '');
        if (!txt || (!unfinishedText(txt) && !workKeywordText(txt))) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = textWalker.nextNode())) {
      pushWorkCandidate(cands, closestRow(node.parentElement));
    }

    const broadRows = Array.from(D.querySelectorAll('body li,body tr,body div,body section,body article'))
      .filter(el => !el.closest(`#${PANEL_ID}`))
      .filter(visible)
      .filter(el => rowLikeText(cleanText(el.innerText || el.textContent || '')));
    for (const row of broadRows) {
      pushWorkCandidate(cands, closestRow(row));
    }

    return uniqBy(cands, c => c.url || cssPath(c.row)).sort((a, b) => a.text.length - b.text.length);
  }

  async function debugWorkList() {
    const bodyText = cleanText(D.body?.innerText || '');
    const works = collectUnfinishedWorks();
    log(`诊断(top)：body含未交=${unfinishedText(bodyText)}，候选=${works.length}`, works.length ? 'ok' : 'warn');
    works.slice(0, 8).forEach((w, i) => {
      log(`top候选#${i + 1}: ${w.text.replace(/\n/g, ' ').slice(0, 160)} | url=${w.url || 'none'}`);
    });
    const frameResults = IS_TOP ? await requestFrames('debug-list', {}, 2500) : [];
    frameResults.forEach((res, idx) => {
      log(`诊断(frame#${idx + 1})：href=${res.href || 'unknown'}，body含未交=${res.bodyHasUnfinished}，候选=${res.works?.length || 0}`, res.works?.length ? 'ok' : 'warn');
      (res.works || []).slice(0, 8).forEach((w, i) => {
        log(`frame#${idx + 1}候选#${i + 1}: ${String(w.text || '').replace(/\n/g, ' ').slice(0, 160)} | url=${w.url || 'none'}`);
      });
    });
    if (!works.length && !frameResults.some(r => r.works?.length)) {
      const samples = Array.from(D.querySelectorAll('body *'))
        .filter(el => !el.closest(`#${PANEL_ID}`))
        .map(el => cleanText(el.innerText || el.textContent || ''))
        .filter(txt => txt && txt.length < 220 && (/未交|期末|作业|章节|模拟|多选|判断/.test(txt)))
        .slice(0, 12);
      samples.forEach((txt, i) => log(`top样本文本#${i + 1}: ${txt.replace(/\n/g, ' ').slice(0, 180)}`, 'warn'));
    }
  }

  function summarizeWorksForBridge() {
    return collectUnfinishedWorks().slice(0, 12).map(w => ({
      text: w.text,
      url: w.url || ''
    }));
  }

  function setupFrameBridge() {
    W.addEventListener('message', async ev => {
      const msg = ev.data;
      if (!msg || msg.bridge !== BRIDGE || msg.kind !== 'command') return;
      const reply = data => {
        try {
          ev.source?.postMessage({ bridge: BRIDGE, id: msg.id, kind: 'result', ...data }, '*');
        } catch (_) {}
      };
      if (msg.type === 'debug-list') {
        const bodyText = cleanText(D.body?.innerText || '');
        reply({ href: location.href, bodyHasUnfinished: unfinishedText(bodyText), works: summarizeWorksForBridge() });
      } else if (msg.type === 'click-unfinished') {
        reply({ href: location.href, clicked: clickUnfinishedFilter() });
      } else if (msg.type === 'enter-next') {
        const beforeWorks = collectUnfinishedWorks();
        const first = beforeWorks[0] || null;
        const clicked = await enterNextWork({ stopOnMiss: false, frameFallback: false, clickFilter: true });
        reply({
          href: location.href,
          clicked,
          targetUrl: first?.url || '',
          targetText: first?.text || '',
          works: summarizeWorksForBridge()
        });
      }
    });
  }

  async function waitForUnfinishedWorks(timeoutMs = 10000) {
    const started = Date.now();
    let logged = false;
    while (Date.now() - started <= timeoutMs) {
      const works = collectUnfinishedWorks();
      if (works.length) return works;
      if (!logged) {
        log('等待作业列表加载/渲染...', 'warn');
        logged = true;
      }
      await sleep(700);
    }
    return [];
  }

  function humanClick(el) {
    if (!el || !visible(el)) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: W }));
    }
    return true;
  }

  function clickUnfinishedFilter() {
    const controls = Array.from(D.querySelectorAll('label,span,div,a,button,input,[role="radio"],[role="button"]'))
      .filter(el => !el.closest(`#${PANEL_ID}`))
      .filter(visible)
      .filter(el => {
        const txt = cleanText(el.value || el.innerText || el.textContent || el.getAttribute('aria-label') || '');
        return txt === '未完成' || /(^|\s)未完成($|\s)/.test(txt);
      });
    for (const el of controls) {
      const target = el.closest('label') || el;
      humanClick(target);
      const input = target.querySelector?.('input[type="radio"],input[type="checkbox"]')
        || el.querySelector?.('input[type="radio"],input[type="checkbox"]')
        || (el.previousElementSibling?.matches?.('input') ? el.previousElementSibling : null)
        || (el.nextElementSibling?.matches?.('input') ? el.nextElementSibling : null);
      if (input) humanClick(input);
      log('已点击“未完成”筛选');
      return true;
    }
    return false;
  }

  function frameWindows() {
    if (!IS_TOP) return [];
    return Array.from(D.querySelectorAll('iframe'))
      .map(f => f.contentWindow)
      .filter(Boolean);
  }

  function requestFrames(type, payload = {}, timeoutMs = 3500) {
    const frames = frameWindows();
    if (!frames.length) return Promise.resolve([]);
    return new Promise(resolve => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const results = [];
      const onMessage = ev => {
        const data = ev.data;
        if (!data || data.bridge !== BRIDGE || data.id !== id || data.kind !== 'result') return;
        results.push(data);
      };
      W.addEventListener('message', onMessage);
      for (const frame of frames) {
        try { frame.postMessage({ bridge: BRIDGE, id, kind: 'command', type, payload }, '*'); } catch (_) {}
      }
      setTimeout(() => {
        W.removeEventListener('message', onMessage);
        resolve(results);
      }, timeoutMs);
    });
  }

  function neutralizeTargets(root) {
    if (!root) return;
    if (root.matches?.('a[target]')) root.removeAttribute('target');
    if (root.querySelectorAll) root.querySelectorAll('a[target]').forEach(a => a.removeAttribute('target'));
  }

  function activateWorkCandidate(work) {
    if (work.url) {
      location.href = work.url;
      return true;
    }
    neutralizeTargets(work.row);
    neutralizeTargets(work.el);
    const titleTarget = findWorkTarget(work.row);
    const targets = uniqBy([titleTarget, work.el, work.row].filter(Boolean), cssPath);
    let clicked = false;
    for (const target of targets) clicked = humanClick(target) || clicked;
    return clicked;
  }

  function clickStartButtonIfPresent() {
    const words = ['开始答题', '开始做题', '开始作答', '继续答题', '继续作答', '进入答题', '做作业', '立即开始'];
    const els = Array.from(D.querySelectorAll('button,a,div,span,input[type="button"]'))
      .filter(visible)
      .filter(el => {
        const t = cleanText(el.value || el.innerText);
        return t.length < 30 && words.some(w => t.includes(w));
      });
    if (!els.length) return false;
    neutralizeTargets(els[0]);
    log(`点击进入按钮：${cleanText(els[0].value || els[0].innerText)}`);
    markPendingContinue();
    els[0].click();
    return true;
  }


  function ensureUnfinishedListView() {
    if (!/\/work\/list/i.test(location.pathname)) return false;
    const url = new URL(location.href);
    if (url.searchParams.get('status') === '-1') return false;
    url.searchParams.set('status', '-1');
    log('切换到“未完成”作业列表');
    markPendingContinue();
    location.href = url.href;
    return true;
  }

  async function enterNextWork(options = {}) {
    const { stopOnMiss = true, frameFallback = IS_TOP, clickFilter = true } = options;
    if (clickFilter) {
      const clickedFilter = clickUnfinishedFilter();
      if (clickedFilter) await sleep(900);
      if (IS_TOP) await requestFrames('click-unfinished', {}, 1200);
    }
    if (clickStartButtonIfPresent()) return true;
    const works = await waitForUnfinishedWorks();
    if (!works.length && frameFallback) {
      const frameResults = await requestFrames('enter-next', {}, 5000);
      const hit = frameResults.find(r => r.clicked);
      if (hit) {
        const targetUrl = hit.targetUrl || hit.works?.[0]?.url || '';
        log(`iframe已处理作业：${(hit.targetText || hit.works?.[0]?.text || hit.href || '').replace(/\n/g, ' ').slice(0, 120)}`, targetUrl ? 'ok' : 'warn');
        markPendingContinue();
        if (targetUrl) {
          log('使用 iframe 返回的作业 URL 在顶层跳转', 'ok');
          location.href = targetUrl;
        }
        return true;
      }
    }
    if (!works.length) {
      log('未找到未交作业，连续模式结束', 'warn');
      if (stopOnMiss) setRunning(false);
      return false;
    }
    gmSet('listUrl', location.href);
    const w = works[0];
    log(`进入作业：${w.text.replace(/\n/g, ' ').slice(0, 120)}`);
    markPendingContinue();
    const a = w.el.matches?.('a') ? w.el : w.el.querySelector?.('a');
    if (a) a.removeAttribute('target');
    const beforeHref = location.href;
    const activated = activateWorkCandidate(w);
    if (!w.url && activated) {
      await sleep(1200);
      if (location.href === beforeHref && !extractQuestions().length) {
        log('已点击作业行/标题，但当前框架还未跳转；如仍停留列表，请点“诊断列表”发候选信息。', 'warn');
      }
    }
    return true;
  }

  let controllerBusy = false;

  async function runController() {
    if (controllerBusy) {
      log('已有一个运行实例在执行，忽略本次触发', 'warn');
      return;
    }
    controllerBusy = true;
    try {
      touchRunning(false);
      try { W.confirm = () => true; } catch (_) {}
      await sleep(800);
      if (ensureUnfinishedListView()) return;
      const qs = extractQuestions();
      if (qs.length) {
        await answerCurrentPage(true);
        return;
      }
      if (clickStartButtonIfPresent()) return;
      await enterNextWork();
    } finally {
      controllerBusy = false;
    }
  }

  function debugQuestion(index = 1, doCopy = false) {
    const q = extractQuestions()[Number(index) - 1];
    if (!q) return null;
    const key = questionKey(q);
    const scopes = uniqBy([q.root, q.root?.parentElement, q.root?.parentElement?.parentElement].filter(Boolean), cssPath);
    const labels = q.options.length ? q.options.map(o => o.label).filter(Boolean) : ['A', 'B', 'C', 'D'];
    const candidates = [];
    for (const label of labels) {
      const text = q.options.find(o => o.label === label)?.text || optionTextForLabel(q.typeText, label);
      visualOptionClickTargets(q, label, text).slice(0, 12).forEach(el => {
        const r = el.getBoundingClientRect?.();
        candidates.push({
          label,
          tag: el.tagName,
          cls: String(el.className || '').slice(0, 120),
          text: cleanText(el.innerText || el.textContent || el.value || '').slice(0, 120),
          attrs: ['id','name','class','onclick','id-param','val-param','data','data-value','role','aria-checked'].map(a => [a, el.getAttribute?.(a)]).filter(x => x[1] != null).slice(0, 12),
          rect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null,
          html: String(el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 260),
          path: cssPath(el)
        });
      });
    }
    let inputs = uniqBy(scopes.flatMap(scope => Array.from(scope.querySelectorAll?.('input,textarea,select') || [])), cssPath)
      .filter(el => {
        const name = String(el.name || el.id || '');
        return !key || name.includes(key) || /^answertype/i.test(el.id || '') || /^answertype/i.test(el.name || '');
      })
      .slice(0, 40)
      .map(el => ({
        tag: el.tagName,
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        value: String(el.value || '').slice(0, 120),
        checked: !!el.checked,
        html: String(el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 220),
        path: cssPath(el)
      }));
    const data = { id: q.id, index: q.index, type: q.typeText, question: q.question, key, options: q.options.map(o => ({ label: o.label, text: o.text, val: o.val, el: String(o.el?.outerHTML || '').replace(/\s+/g, ' ').slice(0, 220) })), candidates, inputs };
    console.log('[CX-LLM] debugQuestion', data);
    if (doCopy) {
      const text = JSON.stringify(data, null, 2);
      try { navigator.clipboard?.writeText(text); log('debugQuestion 已复制到剪贴板', 'ok'); } catch (_) {}
      return text;
    }
    return data;
  }

  async function testClickQuestion(index = 1, label = 'A') {
    const q = extractQuestions()[Number(index) - 1];
    if (!q) return false;
    const labels = parseLabels(label);
    if (labels.length > 1) {
      const ok = await applyAnswer(q, labels.join(''));
      const data = debugQuestion(index);
      console.log('[CX-LLM] testClickQuestion result', { ok, data });
      return ok;
    }
    const opt = optionByLabel(q, label) || { label, text: optionTextForLabel(q.typeText, label), root: q.root, el: q.root };
    const ok = await clickOption(opt, q);
    const data = debugQuestion(index);
    console.log('[CX-LLM] testClickQuestion result', { ok, data });
    return ok;
  }

  function exposeApi() {
    W.__chaoxingHomeworkLLM = {
      extractQuestions,
      answerCurrentPage,
      enterNextWork,
      debugWorkList,
      debugQuestion,
      testClickQuestion,
      getCfg,
      setCfg,
      start: async () => { setRunning(true); await runController(); },
      stop: () => setRunning(false)
    };
  }

  function autoBoot() {
    setupFrameBridge();
    exposeApi();
    if (!IS_TOP) {
      if (shouldAutoContinue()) {
        setTimeout(runController, 1200);
      }
      return;
    }

    mountPanel();
    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('学习通作业 LLM：开始', async () => {
          setRunning(true);
          await runController();
        });
        GM_registerMenuCommand('学习通作业 LLM：停止', () => setRunning(false));
      }
    } catch (_) {}
    if (shouldAutoContinue()) {
      log('检测到刚刚的页面跳转，自动继续');
      setTimeout(runController, 1500);
    } else if (getRunState().active && !isRunning()) {
      setRunning(false);
      log('已清理过期运行状态', 'warn');
    }
  }

  if (D.readyState === 'loading') {
    D.addEventListener('DOMContentLoaded', autoBoot, { once: true });
  } else {
    autoBoot();
  }
})();
