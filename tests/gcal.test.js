// v8.0.0 連動 Google 日曆（單向：日曆 → TDM）與日曆視圖的迴圈預估
'use strict';
process.env.TZ = 'Asia/Taipei';   // 活動時間換算成本地日期／時刻，固定用台灣時區
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, makeApp } = require('./load-app');

const lib = loadApp();
const plain = v => JSON.parse(JSON.stringify(v));
const cfg = { category: 'life' };
const FROM = '2026-11-20', TO = '2026-12-31';
const timed = (id, start, end, extra = {}) => ({ id, status: 'confirmed', summary: id, updated: '2026-11-26T00:00:00.000Z',
    start: { dateTime: start }, end: { dateTime: end }, ...extra });

test.describe('gcalEventToFields', () => {
    test('有時刻的活動：日期、時刻、預計時間', () => {
        const f = lib.gcalEventToFields(timed('a', '2026-11-27T09:00:00+08:00', '2026-11-27T10:30:00+08:00'));
        assert.equal(f.date, '2026-11-27');   // 測試以 TZ=Asia/Taipei 執行
        assert.equal(f.time, '09:00');
        assert.equal(f.estimatedTime, '30plus');
        assert.equal(f.blocks, 3);
        assert.equal(lib.gcalEventToFields(timed('b', '2026-11-27T09:00:00+08:00', '2026-11-27T09:25:00+08:00')).estimatedTime, '30min');
    });
    test('全天活動：不計時；說明欄 HTML 轉純文字並附地點', () => {
        const f = lib.gcalEventToFields({ id: 'c', summary: '', start: { date: '2026-11-28' }, end: { date: '2026-11-29' },
            description: '第一行<br>第二行 &amp; <b>粗體</b>', location: '台大醫院' });
        assert.equal(f.title, '（無標題活動）');
        assert.equal(f.date, '2026-11-28');
        assert.equal(f.time, null);
        assert.equal(f.estimatedTime, 'non-continuous');
        assert.equal(f.description, '第一行\n第二行 & 粗體\n📍 台大醫院');
    });
});

test.describe('gcalApply', () => {
    const ev1 = timed('e1', '2026-11-27T09:00:00+08:00', '2026-11-27T10:00:00+08:00');
    test('新增 → 重跑不重複 → 日曆修改覆蓋 TDM', () => {
        const app = makeApp(lib, []);
        assert.deepEqual(plain(app.gcalApply('primary', [ev1], FROM, TO, cfg)), { added: 1, updated: 0, removed: 0 });
        const id = lib.gcalTaskId('primary', 'e1');
        assert.equal(app.getTaskById(id).category, 'life');
        assert.deepEqual(plain(app.gcalApply('primary', [ev1], FROM, TO, cfg)), { added: 0, updated: 0, removed: 0 });
        // TDM 內改名不影響日曆，也不會被同一版活動蓋回
        app.getTaskById(id).title = '我改的名字';
        app.gcalApply('primary', [ev1], FROM, TO, cfg);
        assert.equal(app.getTaskById(id).title, '我改的名字');
        // 日曆改時間 → 覆蓋
        const moved = { ...ev1, summary: '改期', updated: '2026-11-26T05:00:00.000Z', start: { dateTime: '2026-11-28T14:00:00+08:00' }, end: { dateTime: '2026-11-28T14:30:00+08:00' } };
        assert.equal(app.gcalApply('primary', [moved], FROM, TO, cfg).updated, 1);
        const t = app.getTaskById(id);
        assert.equal(t.title, '改期');
        assert.equal(t.date, '2026-11-28');
        assert.equal(t.time, '14:00');
        assert.equal(t.estimatedTime, '30min');
    });
    test('日曆刪除活動 → 移除未完成的任務；已完成的保留', () => {
        const ev2 = timed('e2', '2026-11-29T09:00:00+08:00', '2026-11-29T10:00:00+08:00');
        const app = makeApp(lib, []);
        app.gcalApply('primary', [ev1, ev2], FROM, TO, cfg);
        app.getTaskById(lib.gcalTaskId('primary', 'e2')).completed = true;
        assert.equal(app.gcalApply('primary', [], FROM, TO, cfg).removed, 1);
        assert.deepEqual(app.tasks.map(t => t.id), [lib.gcalTaskId('primary', 'e2')]);
    });
    test('在 TDM 刪除後不再匯入，除非日曆之後又修改', () => {
        const app = makeApp(lib, []);
        const id = lib.gcalTaskId('primary', 'e1');
        app.deletedTasks[id] = Date.parse('2026-11-26T03:00:00.000Z');
        assert.equal(app.gcalApply('primary', [ev1], FROM, TO, cfg).added, 0);
        assert.equal(app.gcalApply('primary', [{ ...ev1, updated: '2026-11-26T04:00:00.000Z' }], FROM, TO, cfg).added, 1);
    });
    test('不動其他日曆或一般任務', () => {
        const app = makeApp(lib, [{ id: 'mine', title: 'x', date: '2026-11-27', completed: false }]);
        app.gcalApply('work@example.com', [ev1], FROM, TO, cfg);
        app.gcalApply('primary', [], FROM, TO, cfg);
        assert.equal(app.tasks.length, 2);
    });
});

test.describe('日曆視圖：迴圈預估', () => {
    test('獨立迴圈（每週一三）與每 3 天、次數上限', () => {
        const app = makeApp(lib, [
            { id: 'w', title: 'w', date: '2026-11-23', completed: false, estimatedTime: '30min', category: 'career',
              recurring: { enabled: true, interval: 7, weekdays: [1, 3], mode: 'fixed', anchorDate: '2026-11-23', completedCount: 0 } },
            { id: 'd', title: 'd', date: '2026-11-26', completed: false, estimatedTime: '10min', category: 'career',
              recurring: { enabled: true, interval: 3, mode: 'fixed', completedCount: 0, repeatCount: 3 } }
        ]);
        const p = app.projectRecurrences('2026-11-23', '2026-12-06');
        const at = d => plain((p.get(d) || []).map(x => `${x.task.id}#${x.n}`));
        assert.deepEqual(at('2026-11-25'), ['w#2']);
        assert.deepEqual(at('2026-11-30'), ['w#3']);
        assert.deepEqual(at('2026-11-29'), ['d#2']);
        assert.deepEqual(at('2026-12-02'), ['w#4', 'd#3']);
        assert.deepEqual(at('2026-12-05'), []);   // d 只做 3 次：11-26、11-29、12-02
    });
    test('下一次已建立就不重複預估', () => {
        const app = makeApp(lib, [
            { id: 'd', title: 'd', date: '2026-11-26', completed: false, recurring: { enabled: true, interval: 3, mode: 'fixed', completedCount: 0 } },
            { id: 'd~1', title: 'd', date: '2026-11-29', completed: false, recurring: { enabled: true, interval: 3, mode: 'fixed', completedCount: 1 } }
        ]);
        const p = app.projectRecurrences('2026-11-26', '2026-12-02');
        assert.equal((p.get('2026-11-29') || []).length, 0);
        assert.deepEqual(plain((p.get('2026-12-02') || []).map(x => x.task.id)), ['d~1']);
    });
    test('群組依順序輪流', () => {
        const g = (id, date, order) => ({ id, title: id, date, completed: false, groupId: 'G', groupOrder: order,
            recurring: { enabled: true, interval: 2, completedCount: 0 } });
        const app = makeApp(lib, [g('A', '2026-11-26', 1), g('B', '2026-11-28', 2)]);
        const p = app.projectRecurrences('2026-11-26', '2026-12-04');
        assert.deepEqual(plain(['2026-11-30', '2026-12-02', '2026-12-04'].map(d => (p.get(d) || []).map(x => x.task.id).join())), ['A', 'B', 'A']);
    });
});
