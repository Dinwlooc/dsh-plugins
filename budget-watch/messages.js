// 模型面文案集中处：这些字符串会作为工具输出/错误进入上下文，是最常被优化的部分。
// 改文案只改这里；index.js 不再内联。占位符用 {name}，由 render() 一次性替换。
export const MESSAGES = Object.freeze({
    warnThreshold: '[budget-watch] Used: {used} tokens. Prepare to wrap up.',
    warnAccelerate:
        '[budget-watch] 已用 {used} tok（≥60%）。压缩步数：合并调用、减少探索、能问 Owner 就别猜。',
    warnStop:
        '[budget-watch] 预算已用尽（≥100%）。停止文件输出工作：先向 Owner 报告现状与剩余事项，等新预算。',
    statusUnregistered:
        '[budget-watch] 未登记预算，本会话累计 {total} tok；发放后调用 budget_register(tokens=...)。',
    statusRegistered: '[budget-watch] granted={granted} used={used} remaining={remaining} pct={pct}',
    statusWarning: 'warn: {warnings}',
    errSessionIdInvalid: 'sessionId 非法：只允许字母、数字与 . _ : -',
    errNoSession: '当前调用没有归属会话，无法定位预算账本（并行会话请显式传 sessionId）。',
    defaultRatesWarning: 'defaultRates invalid — falling back to flash rates',
    // 自动补发只在「连续两轮没登记」时出现：说清它是什么，免得模型误以为是新一轮 Owner 发放。
    autoRegistered: '[budget-watch] 连续 {rounds} 轮没有新的预算登记，已自动登记 granted={granted}（从当前示数重计）。',
    panelStep:
        '[budget-watch] 单步折算消耗已达冷启动的 {pct}%。压缩步数：合并调用、减少探索、多问 Owner。',
    panelStop:
        '[budget-watch] 单步折算消耗已达冷启动的 {pct}%。停止文件输出工作，先向 Owner 报告现状与剩余事项。',
    pricesDropped: 'prices: dropped {dropped} invalid row(s)',
});

/** 渲染一条模型面文案：单次替换全部占位符。 */
export function render(template, values) {
    return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}
