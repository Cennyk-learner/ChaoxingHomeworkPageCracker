// ==UserScript==
// @name         学习通作业 LLM 自动答题助手（独立版）
// @namespace    ctf-chaoxing-homework-llm
// @version      1.0.4
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
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const D = document;

  // Tampermonkey/ScriptCat may inject scripts into Chaoxing iframes by default.
  // Running in frames creates duplicate floating panels and competing controllers.
  try {
    if (W.top !== W.self) return;
  } catch (_) {
    return;
  }
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

  function gmGet(key, def) {
    try {
      const v = GM_getValue(STORE + key);
      return v === undefined ? def : v;
    } catch (_) {
      const raw = localStorage.getItem(STORE + key);
      if (raw == null) return def;
      try { return JSON.parse(raw); } catch { return raw; }
    }
  }

  function gmSet(key, val) {
    try {
      GM_setValue(STORE + key, val);
    } catch (_) {
      localStorage.setItem(STORE + key, JSON.stringify(val));
    }
  }

  function getCfg() {
    return { ...DEFAULT_CFG, ...(gmGet('cfg', {}) || {}) };
  }

  function setCfg(cfg) {
    gmSet('cfg', { ...getCfg(), ...cfg });
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
          <div><label>每批题数</label><input id="cxllm-batchSize" type="number" min="1" max="30"></div>
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
      savePanelCfg();
      log('配置已保存', 'ok');
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
    setCfg({
      provider: v('cxllm-provider'),
      apiUrl: v('cxllm-apiUrl').trim(),
      apiKey: v('cxllm-apiKey').trim(),
      model: v('cxllm-model').trim(),
      batchSize: Math.max(1, Math.min(30, parseInt(v('cxllm-batchSize'), 10) || 8)),
      delayMs: Math.max(0, Math.min(10000, parseInt(v('cxllm-delayMs'), 10) || 900)),
      loopList: c('cxllm-loopList'),
      autoSave: c('cxllm-autoSave'),
      autoSubmit: c('cxllm-autoSubmit')
    });
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
      const em = el.querySelector('em[id-param],[id-param]');
      let label = (em?.getAttribute('id-param') || el.getAttribute('data') || '').trim();
      const txt = cleanText(el.innerHTML || el.innerText);
      const m = txt.match(/^\s*([A-H])(?:[.、\s]|$)/i);
      if (!label && m) label = m[1].toUpperCase();
      if (!/^[A-H]$/i.test(label)) label = String.fromCharCode(65 + idx);
      label = label.toUpperCase();
      let text = cleanText(el.innerText);
      text = text.replace(new RegExp(`^\\s*${escapeReg(label)}\\s*[.、．]?\\s*`, 'i'), '').trim();
      text = text.replace(/^([A-H])\s+/, '').trim();
      if (!text && el.getAttribute('val-param')) text = el.getAttribute('val-param') === 'true' ? '对' : '错';
      out.push({
        label,
        text,
        el,
        selected: () => isSelected(el),
        val: el.getAttribute('val-param') || ''
      });
    });
    return uniqBy(out, o => `${o.label}:${norm(o.text)}:${cssPath(o.el)}`);
  }

  function extractQuestions() {
    const roots = getQuestionRoots();
    const questions = [];
    roots.forEach((root, i) => {
      const options = extractOptionsFromRoot(root);
      const typeText = inferType(root);
      const question = titleText(root, options);
      if (!question || question.length < 2) return;
      let id = root.getAttribute('data-questionid') || root.getAttribute('qid') || '';
      const ansInput = Array.from(root.querySelectorAll('input[name*="answer"],input[id*="answer"]')).find(x => x.name || x.id);
      if (!id && ansInput) id = ansInput.name || ansInput.id;
      if (!id) id = String(i + 1);
      questions.push({ id: String(id), index: i + 1, root, typeText, question, options, inputs: textInputs(root) });
    });
    return uniqBy(questions, q => `${q.id}:${norm(q.question).slice(0, 80)}`);
  }

  function isSelected(el) {
    if (!el) return false;
    if (el.matches('input')) return !!el.checked;
    const cls = ` ${el.className || ''} `;
    if (/( cur | checked | selected | active | on | check_answer )/i.test(cls)) return true;
    const input = el.querySelector('input[type="radio"],input[type="checkbox"]');
    return !!input?.checked;
  }

  function clickOption(opt) {
    const el = opt.el;
    const target = el.querySelector('input[type="radio"],input[type="checkbox"]') || el;
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    target.click();
    target.dispatchEvent(new Event('change', { bubbles: true }));
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

  function applyAnswer(q, answer) {
    if (q.options.length) {
      const targets = findOptionByAnswer(q, answer);
      if (!targets.length) return false;
      const wanted = new Set(targets);
      if (q.typeText === '多选题') {
        for (const opt of q.options) {
          const should = wanted.has(opt);
          const selected = opt.selected();
          if (should !== selected) clickOption(opt);
        }
      } else {
        const opt = targets[0];
        if (!opt.selected()) clickOption(opt);
      }
      return true;
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
    let ok = 0, fail = 0;
    const allAnswers = [];
    for (let bi = 0; bi < batches.length; bi++) {
      if (!isRunning() && allowAfterAction) {
        log('运行已停止，退出答题', 'warn');
        break;
      }
      touchRunning(false);
      const batch = batches[bi];
      log(`调用模型：第 ${bi + 1}/${batches.length} 批（${batch.length} 题）`);
      let answers;
      try {
        answers = await askLLM(batch);
      } catch (e) {
        log(`模型调用失败：${e.message || e}`, 'error');
        fail += batch.length;
        continue;
      }
      allAnswers.push(...answers);
      const byId = new Map();
      answers.forEach((a, idx) => {
        const id = String(a.id ?? a.question_id ?? a.no ?? a.index ?? batch[idx]?.id ?? '');
        byId.set(id, a);
      });
      for (let i = 0; i < batch.length; i++) {
        const q = batch[i];
        const a = byId.get(q.id) || answers[i] || {};
        const ans = a.answer ?? a.answers ?? a.option ?? a.result ?? '';
        const done = applyAnswer(q, ans);
        if (done) {
          ok++;
          log(`#${q.index} ${q.typeText} => ${String(ans).slice(0, 80)}`, 'ok');
        } else {
          fail++;
          const optionInfo = q.options.map(o => `${o.label || '?'}:${o.text || o.val || ''}`).join(' | ');
          log(`#${q.index} 未能匹配答案：${String(ans).slice(0, 100)}；页面选项：${optionInfo}`, 'warn');
        }
        await sleep(cfg.delayMs);
      }
    }
    W.__cxllm_last_answers = allAnswers;
    log(`填题完成：成功 ${ok}，失败/未填 ${fail}`, fail ? 'warn' : 'ok');
    if (allowAfterAction) await afterAnswerAction();
    return true;
  }

  async function afterAnswerAction() {
    const cfg = getCfg();
    if (cfg.autoSubmit) {
      log('准备自动提交');
      await sleep(1200);
      submitWork();
      await sleep(5000);
      if (cfg.loopList) goBackListOrHistory();
      return;
    }
    if (cfg.autoSave) {
      log('准备自动保存/暂存');
      await sleep(1000);
      saveWork();
      await sleep(3000);
      if (cfg.loopList) goBackListOrHistory();
      return;
    }
    log('未开启自动保存/提交，已停留在当前页');
    setRunning(false);
  }

  function submitWork() {
    try { W.confirm = () => true; } catch (_) {}
    try { if (typeof W.submitCheckTimes === 'function') W.submitCheckTimes(); } catch (_) {}
    try { if (typeof W.escapeBlank === 'function') W.escapeBlank(); } catch (_) {}
    try {
      if (typeof W.submitAction === 'function') {
        W.submitAction();
        log('已调用 submitAction()', 'ok');
        return;
      }
    } catch (e) {
      log(`submitAction 调用异常：${e.message || e}`, 'warn');
    }
    clickByText(['提交', '确认提交', '交卷']);
  }

  function saveWork() {
    try {
      if (typeof W.noSubmit === 'function') {
        W.noSubmit();
        log('已调用 noSubmit()', 'ok');
        return;
      }
    } catch (e) {
      log(`noSubmit 调用异常：${e.message || e}`, 'warn');
    }
    clickByText(['暂时保存', '保存', '保存答案']);
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

  function findWorkTarget(row) {
    if (!row) return null;
    const clickable = Array.from(row.querySelectorAll('a[href],[onclick],button,[role="button"],.blue,.jobCount,.work,.work-name'))
      .filter(visible)
      .find(el => !el.closest(`#${PANEL_ID}`));
    return clickable || row;
  }

  function pushWorkCandidate(cands, row, preferredTarget = null) {
    if (!row || !visible(row)) return;
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

  function debugWorkList() {
    const bodyText = cleanText(D.body?.innerText || '');
    const works = collectUnfinishedWorks();
    log(`诊断：body含未交=${unfinishedText(bodyText)}，候选=${works.length}`, works.length ? 'ok' : 'warn');
    works.slice(0, 8).forEach((w, i) => {
      log(`候选#${i + 1}: ${w.text.replace(/\n/g, ' ').slice(0, 160)} | url=${w.url || 'none'}`);
    });
    if (!works.length) {
      const samples = Array.from(D.querySelectorAll('body *'))
        .filter(el => !el.closest(`#${PANEL_ID}`))
        .map(el => cleanText(el.innerText || el.textContent || ''))
        .filter(txt => txt && txt.length < 220 && (/未交|期末|作业|章节|模拟|多选|判断/.test(txt)))
        .slice(0, 12);
      samples.forEach((txt, i) => log(`样本文本#${i + 1}: ${txt.replace(/\n/g, ' ').slice(0, 180)}`, 'warn'));
    }
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

  function activateWorkCandidate(work) {
    if (work.url) {
      location.href = work.url;
      return;
    }
    const targets = uniqBy([work.el, work.row].filter(Boolean), cssPath);
    for (const target of targets) humanClick(target);
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
    log(`点击进入按钮：${cleanText(els[0].value || els[0].innerText)}`);
    markPendingContinue();
    els[0].click();
    return true;
  }

  async function enterNextWork() {
    if (clickStartButtonIfPresent()) return true;
    const works = await waitForUnfinishedWorks();
    if (!works.length) {
      log('未找到未交作业，连续模式结束', 'warn');
      setRunning(false);
      return false;
    }
    gmSet('listUrl', location.href);
    const w = works[0];
    log(`进入作业：${w.text.replace(/\n/g, ' ').slice(0, 120)}`);
    markPendingContinue();
    const a = w.el.matches?.('a') ? w.el : w.el.querySelector?.('a');
    if (a) a.removeAttribute('target');
    activateWorkCandidate(w);
    return true;
  }

  async function runController() {
    touchRunning(false);
    try { W.confirm = () => true; } catch (_) {}
    await sleep(800);
    const qs = extractQuestions();
    if (qs.length) {
      await answerCurrentPage(true);
      return;
    }
    if (clickStartButtonIfPresent()) return;
    await enterNextWork();
  }

  function autoBoot() {
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
    W.__chaoxingHomeworkLLM = {
      extractQuestions,
      answerCurrentPage,
      enterNextWork,
      getCfg,
      setCfg,
      start: async () => { setRunning(true); await runController(); },
      stop: () => setRunning(false)
    };
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
