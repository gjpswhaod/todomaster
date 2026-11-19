// 雲端同步的合併與衝突邏輯（TodoMaster.html 的 SYNC-CORE 區段）
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./load-app');

const lib = loadApp();
// vm 沙箱內建立的物件原型與這裡不同，比對前先轉成一般 JSON 物件
const plain = v => JSON.parse(JSON.stringify(v));
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 19, 12);   // 固定「現在」，讓刪除標記過期的判斷可重現

const task = (id, extra = {}) => ({ id, title: id, updatedAt: 1000, orderAt: 1000, order: 0, ...extra });
const state = (tasks, extra = {}) => ({ tasks, tags: [], overdueLossLog: [], deletedTasks: {}, ...extra });
const ids = s => plain(s.tasks.map(t => t.id));
const byId = (s, id) => plain(s.tasks.find(t => t.id === id));

test.describe('mergeStates：任務', () => {
    test('以 id 聯集；本機原順序在前、遠端新增的接在後面', () => {
        const out = lib.mergeStates(state([task('b'), task('a')]), state([task('c'), task('a')]), { now: NOW });
        assert.deepEqual(ids(out), ['b', 'a', 'c']);
    });

    test('同 id 取 updatedAt 較新者', () => {
        const L = state([task('a', { title: '本機', updatedAt: 2000 })]);
        const R = state([task('a', { title: '雲端', updatedAt: 1500 })]);
        assert.equal(byId(lib.mergeStates(L, R, { now: NOW }), 'a').title, '本機');
        assert.equal(byId(lib.mergeStates(R, L, { now: NOW }), 'a').title, '本機');
    });

    test('updatedAt 平手時取遠端（先上傳者）', () => {
        const L = state([task('a', { title: '本機' })]);
        const R = state([task('a', { title: '雲端' })]);
        assert.equal(byId(lib.mergeStates(L, R, { now: NOW }), 'a').title, '雲端');
    });

    test('排序（order/groupOrder）另以 orderAt 決定，不會被內容較新的一邊蓋掉', () => {
        const L = state([task('a', { title: '本機改名', updatedAt: 3000, orderAt: 1000, order: 1 })]);
        const R = state([task('a', { title: '舊名', updatedAt: 1000, orderAt: 5000, order: 9, groupOrder: 2 })]);
        const a = byId(lib.mergeStates(L, R, { now: NOW }), 'a');
        assert.equal(a.title, '本機改名');
        assert.equal(a.order, 9);
        assert.equal(a.groupOrder, 2);
        assert.equal(a.orderAt, 5000);
    });

    test('不修改輸入（純函式）', () => {
        const L = state([task('a', { updatedAt: 3000, orderAt: 1 })], { deletedTasks: { x: NOW - DAY } });
        const R = state([task('a', { orderAt: 9, order: 5 }), task('b')], { tags: ['t'] });
        const before = JSON.stringify([L, R]);
        lib.mergeStates(L, R, { now: NOW });
        assert.equal(JSON.stringify([L, R]), before);
    });
});

test.describe('mergeStates：刪除標記', () => {
    test('刪除晚於最後修改 → 維持刪除', () => {
        const L = state([], { deletedTasks: { a: NOW - 1000 } });
        const R = state([task('a', { updatedAt: NOW - 5000 })]);
        const out = lib.mergeStates(L, R, { now: NOW });
        assert.deepEqual(ids(out), []);
        assert.equal(out.deletedTasks.a, NOW - 1000);
    });

    test('刪除與修改同一時間 → 維持刪除', () => {
        const out = lib.mergeStates(state([], { deletedTasks: { a: 5000 } }), state([task('a', { updatedAt: 5000 })]), { now: 5000 });
        assert.deepEqual(ids(out), []);
    });

    test('刪除後另一台又編輯 → 任務復活、標記作廢', () => {
        const L = state([], { deletedTasks: { a: NOW - 5000 } });
        const R = state([task('a', { updatedAt: NOW - 1000 })]);
        const out = lib.mergeStates(L, R, { now: NOW });
        assert.deepEqual(ids(out), ['a']);
        assert.equal('a' in out.deletedTasks, false);
    });

    test('兩邊的刪除標記取聯集與較晚者；超過 30 天的丟棄', () => {
        const L = state([], { deletedTasks: { a: NOW - 2 * DAY, old: NOW - 31 * DAY } });
        const R = state([], { deletedTasks: { a: NOW - DAY, b: NOW - 3 * DAY } });
        const out = lib.mergeStates(L, R, { now: NOW });
        assert.deepEqual(plain(out.deletedTasks), { a: NOW - DAY, b: NOW - 3 * DAY });
    });
});

test.describe('mergeStates：標籤、目錄、逾期紀錄、清除', () => {
    test('標籤聯集，並套用改名／刪除紀錄（避免另一台用舊名把標籤帶回來）', () => {
        const catalog = { tagRenames: { 解剖: { to: '解剖學', at: NOW - DAY }, 廢棄: { to: null, at: NOW - DAY } } };
        const L = state([task('a', { tags: ['解剖', '廢棄', '生化'] })], { tags: ['生化'], catalog });
        const R = state([], { tags: ['解剖', '廢棄'] });
        const out = lib.mergeStates(L, R, { now: NOW });
        assert.deepEqual(plain(out.tags), ['生化', '解剖學']);
        assert.deepEqual(byId(out, 'a').tags, ['解剖學', '生化']);
    });

    test('逾期損失紀錄：同內容取兩邊出現次數較多者（保留合法重複、去除跨裝置重複）', () => {
        const rec = { date: '2026-11-18', taskId: 'a', minutes: 30, taskTitle: 'A' };
        const rec2 = { date: '2026-11-17', taskId: 'b', minutes: 10, taskTitle: 'B' };
        const out = lib.mergeStates(state([], { overdueLossLog: [rec, rec] }), state([], { overdueLossLog: [rec, rec2] }), { now: NOW });
        assert.equal(out.overdueLossLog.length, 3);
    });

    test('purgeCutoff：清掉完成超過期限的任務與舊紀錄', () => {
        const L = state([
            task('old', { completed: true, completedDate: '2026-09-01' }),
            task('recent', { completed: true, completedDate: '2026-11-01' }),
            task('open', { date: '2026-01-01' })
        ], { overdueLossLog: [{ date: '2026-09-01' }, { date: '2026-11-01' }] });
        const out = lib.mergeStates(L, state([]), { now: NOW, purgeCutoff: '2026-10-20' });
        assert.deepEqual(ids(out), ['recent', 'open']);
        assert.deepEqual(plain(out.overdueLossLog), [{ date: '2026-11-01' }]);
    });
});

test.describe('mergeStates：收斂性質', () => {
    const L = state([task('a', { updatedAt: 3000 }), task('b', { orderAt: 4000, order: 2 }), task('c')],
        { tags: ['x'], deletedTasks: { d: NOW - DAY } });
    const R = state([task('a', { title: 'R', updatedAt: 2000, orderAt: 9000, order: 7 }), task('b', { title: 'R', updatedAt: 1200 }), task('d', { updatedAt: NOW - 2 * DAY }), task('e')],
        { tags: ['y'] });

    test('交換本機與雲端，合併內容相同（無平手時）', () => {
        assert.equal(lib.stateDigest(lib.mergeStates(L, R, { now: NOW })), lib.stateDigest(lib.mergeStates(R, L, { now: NOW })));
    });

    test('冪等：合併結果再與自己合併不會改變', () => {
        const m = lib.mergeStates(L, R, { now: NOW });
        assert.equal(lib.stateDigest(lib.mergeStates(m, m, { now: NOW })), lib.stateDigest(m));
    });

    test('已被刪除的 d 不會被帶回來', () => {
        assert.equal(ids(lib.mergeStates(L, R, { now: NOW })).includes('d'), false);
    });
});

test.describe('detectConflicts', () => {
    const base = { tasks: { a: task('a', { note: 'base' }) } };

    test('沒有基準（null）時不偵測', () => {
        assert.deepEqual(plain(lib.detectConflicts(state([task('a', { note: 'L' })]), state([task('a', { note: 'R' })]), null)), []);
    });

    test('兩邊都改、而且改得不一樣 → edit，fields 列出差異欄位', () => {
        const out = plain(lib.detectConflicts(state([task('a', { note: 'L' })]), state([task('a', { note: 'R', date: '2026-12-01' })]), base));
        assert.equal(out.length, 1);
        assert.equal(out[0].kind, 'edit');
        assert.deepEqual(out[0].fields, ['date', 'note']);
        assert.equal(out[0].title, 'a');
    });

    test('只有一邊改、兩邊改成一樣、只有排序不同 → 都不算衝突', () => {
        const same = task('a', { note: 'base' });
        assert.equal(lib.detectConflicts(state([task('a', { note: 'L' })]), state([same]), base).length, 0);
        assert.equal(lib.detectConflicts(state([task('a', { note: 'X' })]), state([task('a', { note: 'X' })]), base).length, 0);
        assert.equal(lib.detectConflicts(state([task('a', { note: 'base', order: 5, orderAt: 9 })]), state([same]), base).length, 0);
    });

    test('基準沒有、兩邊同 id 內容不同 → add', () => {
        const out = lib.detectConflicts(state([task('n', { note: 'L' })]), state([task('n', { note: 'R' })]), { tasks: {} });
        assert.equal(out[0].kind, 'add');
    });

    test('雲端刪除、本機有修改 → remote-deleted；本機刪除、雲端沒改 → 不算', () => {
        const rDel = lib.detectConflicts(state([task('a', { note: 'L' })]), state([], { deletedTasks: { a: 1 } }), base);
        assert.equal(rDel[0].kind, 'remote-deleted');
        assert.deepEqual(plain(rDel[0].fields), ['note']);
        assert.equal(lib.detectConflicts(state([], { deletedTasks: { a: 1 } }), state([task('a', { note: 'base' })]), base).length, 0);
        assert.equal(lib.detectConflicts(state([], { deletedTasks: { a: 1 } }), state([task('a', { note: 'R' })]), base)[0].kind, 'local-deleted');
    });

    test('依標題排序（字元碼順序）', () => {
        const b = { tasks: { x: task('x', { title: 'Beta', v: 0 }), y: task('y', { title: 'Alpha', v: 0 }) } };
        const L = state([task('x', { title: 'Beta', v: 1 }), task('y', { title: 'Alpha', v: 1 })]);
        const R = state([task('x', { title: 'Beta', v: 2 }), task('y', { title: 'Alpha', v: 2 })]);
        assert.deepEqual(plain(lib.detectConflicts(L, R, b).map(c => c.id)), ['y', 'x']);
    });
});

test.describe('交叉補充（mergeTaskFields / mergeFieldValue）', () => {
    test('只有一邊改的欄位，取那一邊（即使另一邊 updatedAt 較新）', () => {
        const b = task('a', { title: 'T', note: 'n0', date: '2026-11-01' });
        const l = task('a', { title: 'T', note: 'n0', date: '2026-11-05', updatedAt: 9000 });
        const r = task('a', { title: 'T', note: '雲端備註', date: '2026-11-01', updatedAt: 2000 });
        assert.deepEqual(plain(lib.mergeTaskFields(l, r, b)), { id: 'a', title: 'T', note: '雲端備註', date: '2026-11-05' });
    });

    test('兩邊都改同一欄位 → 取 updatedAt 較晚者', () => {
        const b = task('a', { note: 'n0' });
        assert.equal(lib.mergeTaskFields(task('a', { note: 'L', updatedAt: 9 }), task('a', { note: 'R', updatedAt: 5 }), b).note, 'L');
        assert.equal(lib.mergeTaskFields(task('a', { note: 'L', updatedAt: 5 }), task('a', { note: 'R', updatedAt: 5 }), b).note, 'R');
    });

    test('標籤：雙方新增的都保留，任一方移除的就移除', () => {
        const b = task('a', { tags: ['甲', '乙'] });
        const l = task('a', { tags: ['甲', '乙', '丙'] });      // 本機新增 丙
        const r = task('a', { tags: ['甲', '丁'], updatedAt: 2000 });   // 雲端移除 乙、新增 丁
        assert.deepEqual([...lib.mergeTaskFields(l, r, b).tags].sort(), ['丁', '丙', '甲']);
    });

    test('物件欄位（recurring）逐子欄位合併', () => {
        const rec = { enabled: true, interval: 7, completedCount: 0 };
        const b = task('a', { recurring: rec });
        const l = task('a', { recurring: { ...rec, interval: 3 }, updatedAt: 9 });
        const r = task('a', { recurring: { ...rec, completedCount: 2 }, updatedAt: 1 });
        assert.deepEqual(plain(lib.mergeTaskFields(l, r, b).recurring), { enabled: true, interval: 3, completedCount: 2 });
    });

    test('沒有基準：較新者為準，但空值由另一邊補上', () => {
        assert.equal(lib.mergeFieldValue('note', '', '舊備註', undefined, false, true), '舊備註');
        assert.equal(lib.mergeFieldValue('note', '新', '舊', undefined, false, true), '新');
    });
});

test.describe('依使用者選擇解決衝突（resolve）', () => {
    const b = task('a', { note: 'n0', date: '2026-11-01' });
    const l = task('a', { note: 'L', date: '2026-11-01', updatedAt: NOW - 10, orderAt: 1, order: 1 });
    const r = task('a', { note: 'n0', date: '2026-11-09', updatedAt: NOW - 20, orderAt: 2, order: 2 });
    const L = state([l]), R = state([r]);
    const conf = { a: { base: b } };

    test('local / remote：整份取一邊，updatedAt 蓋成比雙方都新（下一輪不會被蓋回去）', () => {
        const lo = byId(lib.mergeStates(L, R, { now: NOW, resolve: { mode: 'local', byId: conf } }), 'a');
        assert.equal(lo.note, 'L');
        assert.equal(lo.date, '2026-11-01');
        assert.ok(lo.updatedAt > NOW);
        const ro = byId(lib.mergeStates(L, R, { now: NOW, resolve: { mode: 'remote', byId: conf } }), 'a');
        assert.equal(ro.note, 'n0');
        assert.equal(ro.date, '2026-11-09');
    });

    test('fields：交叉補充兩邊的修改；排序仍依 orderAt', () => {
        const fo = byId(lib.mergeStates(L, R, { now: NOW, resolve: { mode: 'fields', byId: conf } }), 'a');
        assert.equal(fo.note, 'L');
        assert.equal(fo.date, '2026-11-09');
        assert.equal(fo.order, 2);
    });

    test('newest：等同預設的較晚者為準', () => {
        const out = lib.mergeStates(L, R, { now: NOW, resolve: { mode: 'newest', byId: conf } });
        assert.equal(lib.stateDigest(out), lib.stateDigest(lib.mergeStates(L, R, { now: NOW })));
    });

    test('選了被刪除的一邊 → 寫入比所有時間都新的刪除標記', () => {
        const out = lib.mergeStates(state([l]), state([], { deletedTasks: { a: NOW - 5 } }),
            { now: NOW, resolve: { mode: 'remote', byId: conf } });
        assert.deepEqual(ids(out), []);
        assert.ok(out.deletedTasks.a > NOW);
    });

    test('選了修改的一邊 → 任務保留、刪除標記移除', () => {
        const out = lib.mergeStates(state([l]), state([], { deletedTasks: { a: NOW - 5 } }),
            { now: NOW, resolve: { mode: 'local', byId: conf } });
        assert.deepEqual(ids(out), ['a']);
        assert.equal('a' in out.deletedTasks, false);
    });
});

test.describe('名稱目錄與標籤改名', () => {
    test('mergeCatalog：各鍵取 at 較晚者；過期的改名紀錄丟棄', () => {
        const a = { groups: { g1: { name: '舊', at: 1 } }, tagRenames: { x: { to: 'y', at: NOW - 31 * DAY } } };
        const b = { groups: { g1: { name: '新', at: 2 }, g2: { name: 'B', at: 1 } }, tagRenames: { p: { to: 'q', at: NOW } } };
        const out = plain(lib.mergeCatalog(a, b, NOW));
        assert.equal(out.groups.g1.name, '新');
        assert.equal(out.groups.g2.name, 'B');
        assert.deepEqual(Object.keys(out.tagRenames), ['p']);
    });

    test('resolveTagName：鏈式改名、刪除、循環保護', () => {
        const r = { a: { to: 'b' }, b: { to: 'c' }, d: { to: null }, e: { to: 'f' }, f: { to: 'e' }, g: { to: 'g' } };
        assert.equal(lib.resolveTagName('a', r), 'c');
        assert.equal(lib.resolveTagName('d', r), null);
        assert.ok(['e', 'f'].includes(lib.resolveTagName('e', r)));
        assert.equal(lib.resolveTagName('g', r), 'g');
        assert.equal(lib.resolveTagName('z', r), 'z');
    });
});

test.describe('normalizeState（遠端 state.json／匯入備份檔）', () => {
    test('缺 tasks 或版本比 App 新 → 丟出 SyncError', () => {
        assert.throws(() => lib.normalizeState({}), e => e.kind === 'format');
        assert.throws(() => lib.normalizeState({ tasks: [], schema: 999 }), e => e.kind === 'schema');
    });

    test('過濾無效的任務、標籤與刪除標記', () => {
        const out = plain(lib.normalizeState({ tasks: [{ id: 'a' }, null, { title: '沒 id' }], tags: ['t', 3], deletedTasks: { x: 1, y: 'bad' } }));
        assert.deepEqual(out.tasks, [{ id: 'a' }]);
        assert.deepEqual(out.tags, ['t']);
        assert.deepEqual(out.deletedTasks, { x: 1 });
    });
});
