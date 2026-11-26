// v8.0.0「每週內重複」：recurring.weekdays（0＝週日）
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, makeApp } = require('./load-app');

const lib = loadApp();
const plain = v => JSON.parse(JSON.stringify(v));
// 2026-11-23 是週一、11-25 週三、11-30 下週一
const MON = '2026-11-23', WED = '2026-11-25', NEXT_MON = '2026-11-30', NEXT_WED = '2026-12-02';
const rec = (extra = {}) => ({ enabled: true, interval: 7, weekdays: [1, 3], completedCount: 0, ...extra });

test.describe('nextRecurDate', () => {
    test('週期 7 天、勾一三：週三 → 下週一、週一 → 週三', () => {
        assert.equal(lib.nextRecurDate(WED, rec()), NEXT_MON);
        assert.equal(lib.nextRecurDate(MON, rec()), WED);
    });
    test('從沒勾的日子出發：找下一個勾選的星期', () => {
        assert.equal(lib.nextRecurDate('2026-11-26', rec()), NEXT_MON);   // 週四 → 下週一
        assert.equal(lib.nextRecurDate('2026-11-24', rec()), WED);        // 週二 → 週三
    });
    test('週期 14 天：同週內照常，跨週多跳一週', () => {
        const r = rec({ interval: 14 });
        assert.equal(lib.nextRecurDate(MON, r), WED);
        assert.equal(lib.nextRecurDate(WED, r), '2026-12-07');
    });
    test('只勾一天＝每週同一天；週日視為一週最後一天', () => {
        assert.equal(lib.nextRecurDate(MON, rec({ weekdays: [1] })), NEXT_MON);
        assert.equal(lib.nextRecurDate('2026-11-28', rec({ weekdays: [0, 6] })), '2026-11-29');   // 週六 → 週日
        assert.equal(lib.nextRecurDate('2026-11-29', rec({ weekdays: [0, 6], interval: 14 })), '2026-12-12');   // 週日 → 隔一週的週六
    });
    test('沒勾星期時維持「基準日＋間隔」', () => {
        assert.equal(lib.nextRecurDate(MON, { interval: 3 }), '2026-11-26');
        assert.equal(lib.nextRecurDate(MON, { interval: 3, weekdays: [] }), '2026-11-26');
    });
    test('次數與結束日互推', () => {
        assert.equal(lib.advanceRecurDate(MON, rec(), 3), NEXT_WED);
        assert.equal(lib.countRecurUntil(MON, rec(), NEXT_WED), 4);
        assert.equal(lib.countRecurUntil(MON, rec(), '2026-12-01'), 3);
    });
    test('顯示文字', () => {
        assert.equal(lib.recurLabel(rec()), '每週一、三');
        assert.equal(lib.recurLabel(rec({ interval: 14, weekdays: [0, 5] })), '每2週五、日');
        assert.equal(lib.recurLabel({ interval: 3 }), '每3天');
    });
});

test.describe('完成後建立下一次', () => {
    const done = (date, completedDate, extra = {}) => ({
        id: 't', title: 't', date, completed: true, completedDate, estimatedTime: '30min', category: 'career', tags: [],
        recurring: rec(extra)
    });
    test('依原定排程：週三完成 → 下週一；即使週四才完成也是下週一', () => {
        for (const cd of [WED, '2026-11-26']) {
            const t = done(WED, cd, { mode: 'fixed', anchorDate: WED });
            const app = makeApp(lib, [t]);
            app.createNextRecurringTask(t);
            const next = plain(app.tasks.find(x => x.id === 't~1'));
            assert.equal(next.date, NEXT_MON);
            assert.deepEqual(next.recurring.weekdays, [1, 3]);
            assert.equal(next.recurring.anchorDate, NEXT_MON);
        }
    });
    test('依完成日順延：週一的任務拖到週二才完成 → 週三', () => {
        const t = done(MON, '2026-11-24', { mode: 'auto' });
        const app = makeApp(lib, [t]);
        app.createNextRecurringTask(t);
        assert.equal(app.tasks.find(x => x.id === 't~1').date, WED);
    });
    test('重複次數：預定結束日依勾選星期推算', () => {
        const t = done(MON, MON, { mode: 'fixed', anchorDate: MON, repeatCount: 4 });
        const app = makeApp(lib, [t]);
        app.createNextRecurringTask(t);
        const next = app.tasks.find(x => x.id === 't~1');
        assert.equal(next.date, WED);
        assert.equal(next.recurring.untilDate, NEXT_WED);   // 一、三、一、三
    });
});
