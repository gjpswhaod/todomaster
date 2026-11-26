// v8.0.1 自動壓縮：完成超過 3 天的任務
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, makeApp } = require('./load-app');

const lib = loadApp();
const today = lib.localDateStr();
const ago = n => lib.addDaysToDate(today, -n);
const done = (id, n, extra = {}) => ({ id, title: id, date: ago(n), completed: true, completedDate: ago(n), estimatedTime: '30min', category: 'career', tags: [], actualTime: 20, ...extra });

test('只壓縮完成超過 3 天的任務，保留日曆對應', () => {
    const app = makeApp(lib, [
        done('d4', 4, { gcal: { calendarId: 'primary', eventId: 'e', updated: 'u' } }),
        done('d3', 3), done('d0', 0),
        { id: 'open', title: 'open', date: ago(10), completed: false },
        done('sub', 5, { parentId: 'open' })
    ]);
    assert.equal(app.autoCompress(), 1);
    const byId = id => app.tasks.find(t => t.id === id);
    assert.equal(byId('d4').compressed, true);
    assert.equal(byId('d4').plannedTime, 30);
    assert.equal(byId('d4').gcal.eventId, 'e');
    assert.equal(byId('d3').compressed, undefined);
    assert.equal(byId('d0').compressed, undefined);
    assert.equal(byId('sub').compressed, undefined);
    assert.equal(app.autoCompress(), 0);   // 再跑一次不重複壓縮
});
