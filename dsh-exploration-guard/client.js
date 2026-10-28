// dsh-exploration-guard — Client half (browser).
// 注册到 settings.section：读/写宿主 /exploration-guard/api/config。
// 手写客户端模块（无构建）：走 DSH 的 client-modules 握手 window.__ModuleLoader__.load。
window.__ModuleLoader__.load({
  id: 'dsh-exploration-guard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = '/exploration-guard/api/config';

    const STR = {
      zh: {
        title: '探索熔断',
        subtitle: '连续若干 step 没有推进任务节点时，先拦非进度工具，再只留记录与求助。',
        enabled: '启用',
        soft: '软阈值（step）',
        hard: '硬阈值（step）',
        noTask: '无任务清单时',
        noTaskCount: '同样计时',
        noTaskSkip: '不计时',
        resetOnIdle: '等待 Owner 时清零',
        save: '保存',
        saving: '保存中…',
        saved: '已保存（即时生效）',
        failed: '保存失败',
        loading: '读取中…',
        softHint: '距上次任务进展超过这么多步，开始否决非进度工具。',
        hardHint: '超过这么多步后只允许更新任务/目标或向 Owner 求助。',
        file: '存储',
      },
      en: {
        title: 'Exploration Brake',
        subtitle: 'When N loop steps pass without advancing a task node, non-progress tools are denied; then only recording and asking stay open.',
        enabled: 'Enabled',
        soft: 'Soft threshold (steps)',
        hard: 'Hard threshold (steps)',
        noTask: 'With no task list',
        noTaskCount: 'Count as no progress',
        noTaskSkip: "Don't count",
        resetOnIdle: 'Reset while waiting for Owner',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved (applies immediately)',
        failed: 'Save failed',
        loading: 'Loading…',
        softHint: 'Steps since the last task advance before non-progress tools are denied.',
        hardHint: 'Beyond this many steps only task/goal updates and asking the Owner are allowed.',
        file: 'Stored at',
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
      card: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '18px 20px', border: '1px solid var(--dsh-color-border, rgba(127,127,127,.25))', borderRadius: '12px', background: 'var(--dsh-color-surface, transparent)' },
      head: { display: 'flex', flexDirection: 'column', gap: '4px' },
      title: { fontSize: '15px', fontWeight: 600 },
      sub: { fontSize: '12px', lineHeight: 1.5, opacity: 0.72 },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' },
      label: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '13px' },
      hint: { fontSize: '11px', opacity: 0.6 },
      input: { width: '92px', padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--dsh-color-border, rgba(127,127,127,.35))', background: 'transparent', color: 'inherit', fontSize: '13px' },
      select: { padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--dsh-color-border, rgba(127,127,127,.35))', background: 'transparent', color: 'inherit', fontSize: '13px' },
      toggle: { padding: '6px 14px', borderRadius: '999px', border: '1px solid var(--dsh-color-border, rgba(127,127,127,.35))', background: 'transparent', color: 'inherit', fontSize: '12px', cursor: 'pointer', minWidth: '64px' },
      footer: { display: 'flex', alignItems: 'center', gap: '12px', justifyContent: 'space-between' },
      save: { padding: '7px 18px', borderRadius: '9px', border: '1px solid var(--dsh-color-accent, #247bbf)', background: 'var(--dsh-color-accent, #247bbf)', color: '#fff', fontSize: '13px', cursor: 'pointer' },
      status: { fontSize: '12px', opacity: 0.7 },
      file: { fontSize: '11px', opacity: 0.5, wordBreak: 'break-all' },
    };

    function Panel() {
      const lang = pickLocale();
      const t = STR[lang];
      const [config, setConfig] = React.useState(null);
      const [status, setStatus] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [file, setFile] = React.useState('');

      React.useEffect(function () {
        let alive = true;
        fetch(API, { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json(); })
          .then(function (body) {
            if (!alive || !body || !body.config) return;
            setConfig(body.config);
            setFile(body.file || '');
          })
          .catch(function () { if (alive) setStatus(t.failed); });
        return function () { alive = false; };
      }, []);

      function patch(key, value) {
        setConfig(function (prev) { return Object.assign({}, prev, { [key]: value }); });
      }

      function save() {
        if (!config) return;
        setBusy(true);
        setStatus(t.saving);
        fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(config),
        })
          .then(function (r) { return r.json(); })
          .then(function (body) {
            if (body && body.config) setConfig(body.config);
            if (body && body.file) setFile(body.file);
            setStatus(body && body.ok ? t.saved : t.failed);
          })
          .catch(function () { setStatus(t.failed); })
          .then(function () { setBusy(false); });
      }

      if (!config) return h('div', { style: C.card }, h('div', { style: C.title }, t.title), h('div', { style: C.sub }, status || t.loading));

      return h('div', { style: C.card },
        h('div', { style: C.head },
          h('div', { style: C.title }, t.title),
          h('div', { style: C.sub }, t.subtitle)),

        h('div', { style: C.row },
          h('div', { style: C.label }, h('span', null, t.enabled)),
          h('button', {
            style: Object.assign({}, C.toggle, config.enabled ? { borderColor: 'var(--dsh-color-accent, #247bbf)', color: 'var(--dsh-color-accent, #247bbf)' } : {}),
            onClick: function () { patch('enabled', !config.enabled); },
          }, config.enabled ? 'ON' : 'OFF')),

        h('div', { style: C.row },
          h('div', { style: C.label }, h('span', null, t.soft), h('span', { style: C.hint }, t.softHint)),
          h('input', {
            style: C.input, type: 'number', min: 1, max: 500, value: String(config.softSteps),
            onChange: function (event) { patch('softSteps', Number(event.target.value)); },
          })),

        h('div', { style: C.row },
          h('div', { style: C.label }, h('span', null, t.hard), h('span', { style: C.hint }, t.hardHint)),
          h('input', {
            style: C.input, type: 'number', min: 1, max: 500, value: String(config.hardSteps),
            onChange: function (event) { patch('hardSteps', Number(event.target.value)); },
          })),

        h('div', { style: C.row },
          h('div', { style: C.label }, h('span', null, t.noTask)),
          h('select', {
            style: C.select, value: config.noTaskMode,
            onChange: function (event) { patch('noTaskMode', event.target.value); },
          },
            h('option', { value: 'count' }, t.noTaskCount),
            h('option', { value: 'skip' }, t.noTaskSkip))),

        h('div', { style: C.row },
          h('div', { style: C.label }, h('span', null, t.resetOnIdle)),
          h('button', {
            style: Object.assign({}, C.toggle, config.resetOnIdle ? { borderColor: 'var(--dsh-color-accent, #247bbf)', color: 'var(--dsh-color-accent, #247bbf)' } : {}),
            onClick: function () { patch('resetOnIdle', !config.resetOnIdle); },
          }, config.resetOnIdle ? 'ON' : 'OFF')),

        h('div', { style: C.footer },
          h('span', { style: C.status }, status),
          h('button', { style: Object.assign({}, C.save, busy ? { opacity: 0.6 } : {}), disabled: busy, onClick: save }, busy ? t.saving : t.save)),

        file ? h('div', { style: C.file }, t.file + ' ' + file) : null);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', function () {
          ctx.slots.register(
            { name: 'settings.section', id: 'exploration-guard', order: 640, label: (pickLocale() === 'zh' ? '探索熔断' : 'Exploration Brake') },
            function () { return h(Panel); });
        });
      },
    };
  },
});
