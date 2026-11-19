// 測試用載入器：直接讀 TodoMaster.html 裡的 <script>，在 Node 的 vm 沙箱中執行（免建置、免安裝套件）。
// 瀏覽器 API（document / localStorage / window …）以最小的假物件代替；DOMContentLoaded 不會觸發，
// 所以不會真的 new TodoApp() 或連網。測試只拿純函式與 TodoApp.prototype 上的方法來用。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML_PATH = path.join(__dirname, '..', 'TodoMaster.html');

// 任何屬性、任何呼叫都回傳自己的「萬用假物件」，讓頂層的 document.querySelectorAll(...).forEach(...) 之類不會出錯
function makeStub() {
    const fn = function () { return stub; };
    const stub = new Proxy(fn, {
        get(_t, prop) {
            if (prop === Symbol.toPrimitive) return () => '';
            if (prop === Symbol.iterator) return function* () {};
            if (prop === 'forEach') return () => {};
            if (prop === 'length') return 0;
            if (prop === 'then') return undefined;   // 避免被當成 Promise
            return stub;
        },
        set() { return true; },
        apply() { return stub; },
        construct() { return stub; }
    });
    return stub;
}

function makeLocalStorage() {
    const m = new Map();
    return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: k => { m.delete(k); },
        clear: () => m.clear()
    };
}

// 要匯出給測試用的名稱（class / const 宣告不會掛到 globalThis，需另外匯出）
const EXPORTS = [
    'TodoApp', 'SyncError', 'SYNC_TOMBSTONE_MS',
    'localDateStr', 'addDaysToDate', 'dateAtMidnight', 'isPurgeableTask',
    'stableStringify', 'taskContentFp', 'stateDigest', 'normalizeState', 'normalizeCatalog',
    'mergeCatalog', 'resolveTagName', 'applyTagRenames',
    'getRecurMode', 'nextRecurringId', 'diffTaskFields',
    'detectConflicts', 'mergeFieldValue', 'mergeTaskFields', 'resolveConflictTask', 'mergeStates',
    'encodeSetupPayload', 'decodeSetupPayload'
];

function loadApp() {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    if (scripts.length === 0) throw new Error('TodoMaster.html 裡找不到 <script>');

    const stub = makeStub();
    const sandbox = {
        console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
        TextEncoder, TextDecoder, URL, URLSearchParams, crypto: globalThis.crypto,
        btoa: s => Buffer.from(s, 'binary').toString('base64'),
        atob: s => Buffer.from(s, 'base64').toString('binary'),
        localStorage: makeLocalStorage(), sessionStorage: makeLocalStorage(),
        document: stub, navigator: stub, location: stub, history: stub,
        matchMedia: () => stub, fetch: () => Promise.reject(new Error('測試中不連網')),
        addEventListener: () => {}, removeEventListener: () => {}
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    const ctx = vm.createContext(sandbox);

    // 各段 <script> 依序執行；同一個 context 共用頂層 const/class（與瀏覽器相同）
    scripts.forEach((src, i) => vm.runInContext(src, ctx, { filename: `TodoMaster.html#script${i + 1}` }));

    const missing = EXPORTS.filter(n => vm.runInContext(`typeof ${n}`, ctx) === 'undefined');
    if (missing.length) throw new Error(`TodoMaster.html 裡找不到：${missing.join(', ')}（函式被改名或移除了？）`);
    return vm.runInContext(`({ ${EXPORTS.join(', ')} })`, ctx);
}

// 建立一個「不跑 constructor」的 TodoApp：只有資料欄位，畫面與雲端相關的動作都是空的。
// notifications 收集 showNotification 的訊息，方便斷言。
function makeApp(lib, tasks = []) {
    const app = Object.create(lib.TodoApp.prototype);
    Object.assign(app, {
        tasks, tags: [], overdueLossLog: [], deletedTasks: {},
        catalog: lib.normalizeCatalog(null), cloud: null,
        _fpMap: new Map(), _metaFp: '', notifications: []
    });
    app.showNotification = msg => app.notifications.push(msg);
    app.updateUI = () => {};
    app._persist = () => {};
    app._rebuildFingerprints();
    return app;
}

module.exports = { loadApp, makeApp };
