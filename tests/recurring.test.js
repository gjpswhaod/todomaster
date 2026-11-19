// 迴圈任務的日期計算與「下一次」建立（createNextRecurringTask 等）
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, makeApp } = require('./load-app');

const lib = loadApp();
const plain = v => JSON.parse(JSON.stringify(v));

// 已完成的迴圈任務（completedDate ＝ 實際完成日）
function doneTask(id, { date, completedDate, interval = 7, mode, ...extra } = {}) {
    return {
        id, title: id, date, completed: true, completedDate, completedAt: `${completedDate}T09:00:00.000Z`,
        estimatedTime: '30min', category: 'career', tags: [],
        recurring: { enabled: true, interval, completedCount: 0, ...(mode ? { mode } : {}), ...(extra.recurring || {}) },
        ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'recurring'))
    };
}
function complete(app, t) {
    app.createNextRecurringTask(app.getTaskById(t.id));
    return app;
}
const nextOf = (app, t) => plain(app.tasks.find(x => x.id === lib.nextRecurringId(t)) || null);

test.describe('addDaysToDate', () => {
    test('跨月、跨年、閏年、負數', () => {
        assert.equal(lib.addDaysToDate('2026-01-31', 1), '2026-02-01');
        assert.equal(lib.addDaysToDate('2026-12-30', 3), '2027-01-02');
        assert.equal(lib.addDaysToDate('2028-02-28', 1), '2028-02-29');
        assert.equal(lib.addDaysToDate('2027-02-28', 1), '2027-03-01');
        assert.equal(lib.addDaysToDate('2026-03-01', -1), '2026-02-28');
        assert.equal(lib.addDaysToDate('2026-11-19', 0), '2026-11-19');
    });

    test('有日光節約時間的時區也不會差一天', () => {
        const saved = process.env.TZ;
        try {
            for (const tz of ['America/New_York', 'Europe/London', 'Australia/Sydney']) {
                process.env.TZ = tz;
                assert.equal(lib.addDaysToDate('2026-03-07', 1), '2026-03-08', tz);
                assert.equal(lib.addDaysToDate('2026-03-07', 7), '2026-03-14', tz);
                assert.equal(lib.addDaysToDate('2026-10-31', 1), '2026-11-01', tz);
                assert.equal(lib.addDaysToDate('2026-04-04', 1), '2026-04-05', tz);
            }
        } finally {
            if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
        }
    });
});

test.describe('getRecurMode / nextRecurringId', () => {
    test('模式：明確設定優先；舊資料的 groupDelayMode 次之；否則群組＝fixed、獨立＝auto', () => {
        assert.equal(lib.getRecurMode({ recurring: { mode: 'fixed' } }), 'fixed');
        assert.equal(lib.getRecurMode({ recurring: {}, groupDelayMode: 'auto', groupId: 'g' }), 'auto');
        assert.equal(lib.getRecurMode({ recurring: {}, groupId: 'g' }), 'fixed');
        assert.equal(lib.getRecurMode({ recurring: {} }), 'auto');
        assert.equal(lib.getRecurMode({ recurring: { mode: '亂填' } }), 'auto');
    });

    test('id 固定為 系列根 id ~ 第幾次', () => {
        assert.equal(lib.nextRecurringId({ id: 'root', recurring: {} }), 'root~1');
        assert.equal(lib.nextRecurringId({ id: 'root~3', seriesId: 'root', recurring: { completedCount: 3 } }), 'root~4');
    });
});

test.describe('獨立迴圈任務的下一次日期', () => {
    test('依完成日順延（auto）：下一次＝完成日＋間隔', () => {
        const t = doneTask('w', { date: '2026-11-10', completedDate: '2026-11-12', interval: 3, mode: 'auto' });
        const n = nextOf(complete(makeApp(lib, [t]), t), t);
        assert.equal(n.date, '2026-11-15');
        assert.equal(n.recurring.completedCount, 1);
        assert.equal(n.seriesId, 'w');
        assert.equal(n.completed, false);
    });

    test('依原定排程（fixed）：下一次＝基準日＋間隔，晚完成不影響', () => {
        const t = doneTask('r', { date: '2026-11-13', completedDate: '2026-11-16', interval: 7, mode: 'fixed', recurring: { anchorDate: '2026-11-12' } });
        const n = nextOf(complete(makeApp(lib, [t]), t), t);
        assert.equal(n.date, '2026-11-19');
        assert.equal(n.recurring.anchorDate, '2026-11-19');
    });

    test('fixed 沒有 anchorDate 時以任務日期為基準', () => {
        const t = doneTask('r', { date: '2026-11-13', completedDate: '2026-11-16', interval: 7, mode: 'fixed' });
        assert.equal(nextOf(complete(makeApp(lib, [t]), t), t).date, '2026-11-20');
    });

    test('下一次已存在（另一台建立過／取消完成又完成）就不重複建立', () => {
        const t = doneTask('d', { date: '2026-11-10', completedDate: '2026-11-10', interval: 1 });
        const app = makeApp(lib, [t, { id: 'd~1', title: 'd', date: '2026-11-11' }]);
        complete(app, t);
        assert.equal(app.tasks.filter(x => x.id === 'd~1').length, 1);
        assert.equal(app.getTaskById('d').recurringCreated, true);
    });

    test('暫停中完成：下一次維持不限期，且不受結束日期限制', () => {
        const t = doneTask('p', { date: '9999-12-31', completedDate: '2026-11-10', interval: 2, paused: { date: '2026-11-01', current: true }, recurring: { untilDate: '2026-11-05' } });
        const n = nextOf(complete(makeApp(lib, [t]), t), t);
        assert.equal(n.date, '9999-12-31');
        assert.equal(n.recurring.anchorDate, null);
        assert.equal(n.paused.current, true);
    });
});

test.describe('迴圈終止', () => {
    test('重複次數：做滿就停，不再建立', () => {
        const t = doneTask('c', { date: '2026-11-10', completedDate: '2026-11-10', interval: 1, recurring: { repeatCount: 3, completedCount: 2 } });
        const app = complete(makeApp(lib, [t]), t);
        assert.equal(nextOf(app, t), null);
        assert.equal(app.getTaskById('c').recurring.completedCount, 3);
    });

    test('重複次數：還沒做滿時，依新日期重算預定結束日期', () => {
        // 共 5 次，這次是第 2 次 → 下一次是第 3 次，之後還有 2 次
        const t = doneTask('c', { date: '2026-11-10', completedDate: '2026-11-12', interval: 2, mode: 'auto', recurring: { repeatCount: 5, completedCount: 1, untilDate: '2026-11-18' } });
        const n = nextOf(complete(makeApp(lib, [t]), t), t);
        assert.equal(n.date, '2026-11-14');
        assert.equal(n.recurring.untilDate, '2026-11-18');
    });

    test('結束日期：下一次超過結束日就不建立；剛好等於結束日仍建立', () => {
        const over = doneTask('u', { date: '2026-11-10', completedDate: '2026-11-10', interval: 7, recurring: { untilDate: '2026-11-16' } });
        assert.equal(nextOf(complete(makeApp(lib, [over]), over), over), null);
        const edge = doneTask('u', { date: '2026-11-10', completedDate: '2026-11-10', interval: 7, recurring: { untilDate: '2026-11-17' } });
        assert.equal(nextOf(complete(makeApp(lib, [edge]), edge), edge).date, '2026-11-17');
    });
});

test.describe('群組迴圈', () => {
    const member = (id, date, groupOrder, interval = 2) => ({
        id, title: id, date, groupId: 'g', groupName: '解剖複習', groupOrder, completed: false,
        recurring: { enabled: true, interval, completedCount: 0 }
    });

    test('依原定排程：下一次接在群組最後一個未完成任務之後；順序重新編號、新任務放最後', () => {
        const done = { ...doneTask('a', { date: '2026-11-10', completedDate: '2026-11-13', interval: 2 }), groupId: 'g', groupName: '解剖複習', groupOrder: 1 };
        const app = makeApp(lib, [done, member('b', '2026-11-12', 5), member('c', '2026-11-14', 9)]);
        complete(app, done);
        const n = nextOf(app, done);
        assert.equal(n.date, '2026-11-16');
        assert.equal(n.groupId, 'g');
        assert.equal(n.groupName, '解剖複習');
        assert.deepEqual(['b', 'c', 'a~1'].map(id => app.getTaskById(id).groupOrder), [1, 2, 3]);
        assert.deepEqual(['b', 'c'].map(id => app.getTaskById(id).date), ['2026-11-12', '2026-11-14']);   // 其餘任務不動
    });

    test('依完成日順延：剩餘任務從「完成日＋間隔」起重新串接，下一次接在最後', () => {
        const done = { ...doneTask('a', { date: '2026-11-10', completedDate: '2026-11-13', interval: 2, mode: 'auto' }), groupId: 'g', groupOrder: 1 };
        const app = makeApp(lib, [done, member('b', '2026-11-12', 2), member('c', '2026-11-14', 3)]);
        complete(app, done);
        assert.deepEqual(['b', 'c'].map(id => app.getTaskById(id).date), ['2026-11-15', '2026-11-17']);
        assert.equal(nextOf(app, done).date, '2026-11-19');
    });

    test('updateGroupTaskDates（個別間隔）：以錨點任務為準前後推算', () => {
        const app = makeApp(lib, [
            { ...member('x', '2026-11-01', 1, 1), groupCycleMode: 'individual' },
            { ...member('y', '2026-11-20', 2, 3), groupCycleMode: 'individual' },
            { ...member('z', '2026-11-02', 3, 5), groupCycleMode: 'individual' }
        ]);
        app.updateGroupTaskDates('g', 'y');
        assert.deepEqual(['x', 'y', 'z'].map(id => app.getTaskById(id).date), ['2026-11-19', '2026-11-20', '2026-11-23']);
    });
});

test('兩台裝置各自完成同一個迴圈任務 → 合併後只有一份「下一次」', () => {
    const t = doneTask('s', { date: '2026-11-10', completedDate: '2026-11-10', interval: 7, mode: 'fixed' });
    const phone = complete(makeApp(lib, [structuredClone(t)]), t);
    const laptop = complete(makeApp(lib, [structuredClone(t)]), t);
    const merged = lib.mergeStates(phone._exportState(), laptop._exportState(), { now: Date.now() });
    const nexts = merged.tasks.filter(x => x.seriesId === 's');
    assert.equal(nexts.length, 1);
    assert.equal(nexts[0].id, 's~1');
    assert.equal(nexts[0].date, '2026-11-17');
});
