// dsh-release-notes — Client half (browser).
// 会话视图页签「更新日志」（与 Chat / Trajectory / X-Ray 同一排，slot `conversation.view`）：
// 读宿主 /release-notes/api/report（GET，?force=1 跳过缓存）。
// 手写客户端模块（无构建）：走 DSH 的 client-modules 握手 window.__ModuleLoader__.load。
window.__ModuleLoader__.load({
  id: 'dsh-release-notes',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = '/release-notes/api/report';

    const STR = {
      zh: {
        title: '更新日志',
        subtitle: '只读：对比当前运行版本与已发布的 DSH 版本，列出两者之间的逐版更新点。',
        current: '当前',
        newest: '最新',
        behind: '落后',
        upToDate: '已是最新',
        unknown: '未知',
        versions: '个版本',
        refresh: '刷新',
        refreshing: '刷新中…',
        loading: '读取中…',
        failed: '读取失败',
        empty: '没有介于两者之间的版本。',
        cached: '缓存',
        noBullets: '（该版本没有条目）',
      },
      en: {
        title: 'Release Notes',
        subtitle: 'Read-only: compares the running build with published DSH releases and lists the notes between them.',
        current: 'current',
        newest: 'newest',
        behind: 'behind',
        upToDate: 'up to date',
        unknown: 'unknown',
        versions: 'versions',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        loading: 'Loading…',
        failed: 'Load failed',
        empty: 'No releases between them.',
        cached: 'cached',
        noBullets: '(no entries in this release)',
      },
    };

    function pickLocale() {
      try {
        const lang = (document.documentElement.getAttribute('lang') || navigator.language || 'en').toLowerCase();
        return lang.startsWith('zh') ? 'zh' : 'en';
      } catch {
        return 'en';
      }
    }

    const C = {
      view: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto', width: '100%', maxWidth: '920px', margin: '0 auto', padding: '16px 20px', boxSizing: 'border-box' },
      card: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '18px 20px', border: '1px solid var(--dsh-color-border, rgba(127,127,127,.25))', borderRadius: '12px', background: 'var(--dsh-color-surface, transparent)' },
      head: { display: 'flex', flexDirection: 'column', gap: '4px' },
      title: { fontSize: '15px', fontWeight: 600 },
      sub: { fontSize: '12px', lineHeight: 1.5, opacity: 0.72 },
      bar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '12px' },
      chip: { padding: '2px 8px', borderRadius: '999px', border: '1px solid var(--dsh-color-border, rgba(127,127,127,.35))', opacity: 0.85 },
      accent: { padding: '2px 8px', borderRadius: '999px', border: '1px solid var(--dsh-color-accent, #247bbf)', color: 'var(--dsh-color-accent, #247bbf)' },
      list: { display: 'flex', flexDirection: 'column', gap: '10px' },
      entry: { display: 'flex', flexDirection: 'column', gap: '4px' },
      tag: { fontSize: '13px', fontWeight: 600 },
      when: { fontSize: '11px', opacity: 0.6, marginLeft: '8px', fontWeight: 400 },
      bullet: { fontSize: '12px', lineHeight: 1.55, opacity: 0.86, paddingLeft: '14px', position: 'relative' },
      dot: { position: 'absolute', left: '4px', top: '0.62em', width: '3px', height: '3px', borderRadius: '50%', background: 'currentColor', opacity: 0.6 },
      footer: { display: 'flex', alignItems: 'center', gap: '12px', justifyContent: 'space-between' },
      status: { fontSize: '11px', opacity: 0.65 },
      button: { fontSize: '12px', padding: '6px 14px', borderRadius: '8px', border: '1px solid var(--dsh-color-border, rgba(127,127,127,.35))', background: 'transparent', color: 'inherit', cursor: 'pointer' },
    };

    function Panel() {
      const t = STR[pickLocale()];
      const [report, setReport] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(function (force) {
        setBusy(true);
        setError('');
        fetch(API + (force ? '?force=1' : ''), { headers: { accept: 'application/json' } })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (data) { setReport(data); })
          .catch(function (e) { setError(String((e && e.message) || e)); })
          .then(function () { setBusy(false); });
      }, []);

      React.useEffect(function () { load(false); }, [load]);

      const entries = report && Array.isArray(report.entries) ? report.entries : [];
      const behindText = report === null || report.newest === null ? '' : report.behind === 0 ? t.upToDate : report.behind + ' ' + t.versions;

      return h('div', { style: C.view },
        h('div', { style: C.card },
        h('div', { style: C.head },
          h('div', { style: C.title }, t.title),
          h('div', { style: C.sub }, t.sub)),

        report === null
          ? h('div', { style: C.status }, error !== '' ? t.failed + ' · ' + error : t.loading)
          : h('div', { style: C.bar },
              h('span', { style: C.chip }, t.current + ' ' + (report.current || t.unknown)),
              h('span', { style: C.chip }, t.newest + ' ' + (report.newest || t.unknown)),
              h('span', { style: report.behind === 0 ? C.chip : C.accent }, behindText),
              report.cached ? h('span', { style: C.chip }, t.cached) : null),

        report !== null && entries.length === 0 ? h('div', { style: C.status }, t.empty) : null,

        h('div', { style: C.list }, entries.map(function (entry) {
          return h('div', { key: entry.tag, style: C.entry },
            h('div', { style: C.tag }, entry.tag, h('span', { style: C.when }, entry.at || '')),
            entry.bullets.length === 0
              ? h('div', { style: C.status }, t.noBullets)
              : entry.bullets.map(function (bullet, index) {
                  return h('div', { key: index, style: C.bullet }, h('span', { style: C.dot }), bullet);
                }));
        })),

        h('div', { style: C.footer },
          h('span', { style: C.status }, error !== '' && report !== null ? t.failed + ' · ' + error : ''),
          h('button', {
            style: Object.assign({}, C.button, busy ? { opacity: 0.6 } : {}),
            disabled: busy,
            onClick: function () { load(true); },
          }, busy ? t.refreshing : t.refresh))));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', function () {
          function Panel() {
            var st = React.useState(null); var state = st[0]; var setState = st[1];
            var er = React.useState(null); var error = er[0]; var setError = er[1];
            React.useEffect(function () {
              var live = true;
              fetch('/api/release-notes/config', { headers: { accept: 'application/json' } })
                .then(function (r) { return r.json(); })
                .then(function (json) { if (live) setState(json); })
                .catch(function (e) { if (live) setError(String(e && e.message ? e.message : e)); });
              return function () { live = false; };
            }, []);
            function save(key, value) {
              fetch('/api/release-notes/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [key]: value }) })
                .then(function (r) { return r.json(); })
                .then(function (json) { if (json && json.ok === true) { setState(json); setError(null); } else setError(String(json && json.error ? json.error : 'save failed')); })
                .catch(function (e) { setError(String(e && e.message ? e.message : e)); });
            }
            if (state === null || state.ok !== true) return h('div', { className: 'rn-card' }, h('div', { className: 'rn-hint' }, error === null ? '读取中…' : error));
            return h('div', { className: 'rn-card' },
              h('div', { className: 'rn-title' }, '发布说明'),
              h('div', { className: 'rn-hint' }, '改动即时生效并写入 ~/.dsh/release-notes/config.json。'),
              error !== null ? h('div', { className: 'rn-err' }, error) : null,
              state.fields.map(function (f) {
                return h('div', { key: f.key, className: 'rn-row' },
                  h('div', { className: 'rn-label' }, h('span', null, f.label || f.key), f.hint ? h('span', { className: 'rn-hint' }, f.hint) : null),
                  h('input', { className: 'rn-input', type: 'number', defaultValue: state.values[f.key] === null ? '' : String(state.values[f.key]), onBlur: function (e) { save(f.key, Number(e.target.value)); } }));
              }));
          }
          ctx.slots.register({ name: 'settings.section', id: 'settings-release-notes', order: 660, label: '发布说明' }, function () { return h(Panel); });
        });

        // 与 Chat(0) / Trajectory(10) / X-Ray(20) 同一排的会话视图页签。
        ctx.slots.inject('conversation.view', function () {
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'release-notes',
              order: 30,
              label: function () { return pickLocale() === 'zh' ? '更新日志' : 'Release Notes'; },
            },
            function () { return h(Panel); });
        });
      },
    };
  },
});
