// 模型面文案集中处：这些字符串会作为工具错误进入上下文，是最常被优化的部分。
// 改文案只改这里；index.js 不再内联。占位符用 {name}，由 render() 一次性替换。
// 计数口径（Owner 2026-10-31）：只按 step 计——一段 run_code 程序算一步，程序内多少次嵌套调用都不推进熔断。
export const MESSAGES = Object.freeze({
    softBlock:
        'Blocked: {steps} step(s) since the last completed todo (soft={soft}, completed={done}). '
        + 'Rewriting the list does not count. Honest ways out: mark a genuinely finished item completed, '
        + 'update_goal blocked, or ask the Owner.',
    hardBlock:
        'Blocked: {steps} step(s) since the last completed todo (hard={hard}, completed={done}). '
        + 'Only honest progress passes: mark a genuinely finished item completed, update_goal blocked, or ask the Owner '
        + '— never mark work complete just to unblock.',
    // 会话内首次越过软阈值：一次性长告警，等于在软档"软加载"插件提示词库；
    // 之后再越线只追加短提醒（ptcSoftNotice），不为重复的长文案每步付费。
    ptcFirstSoftNotice:
        'Progress warning: {steps} step(s) since the last completed todo (soft={soft}, hard={hard}, completed={done}). '
        + 'The program you just ran finished normally and run_code stays open. This is the first soft-threshold warning in this session, so read it once.\n'
        + 'Why it exists: exploration without a plan burns steps and ends at hard={hard} step(s), where run_code itself stops opening. '
        + 'The only way back is genuine progress, so every batch you line up after that point never starts. '
        + 'Expect it before it happens: plan before you explore and add the next concrete step as you learn, '
        + 'instead of wandering first and repairing the todo list only after a warning.\n'
        + 'Three honest resets: 1) todo_write with a genuinely finished item (a content signature not seen before); '
        + '2) update_goal to a terminal state (complete or blocked); 3) ask the Owner. Rewriting the same list does not count. '
        + 'Later steps above the soft threshold append the short reminder, not this text.',
    ptcSoftNotice:
        'Progress warning: {steps} step(s) since the last completed todo (soft={soft}, hard={hard}, completed={done}). '
        + 'The batch you just ran was not interrupted. run_code stays open until the hard threshold. '
        + 'Next step: mark a genuinely finished item completed, or ask the Owner. Rewriting the same list does not count.',
    ptcHardBlock:
        'Blocked: run_code is closed at the hard threshold ({steps} step(s), hard={hard}, completed={done}). '
        + 'A running program is never interrupted; this lock applies to starting a new one. '
        + 'Reopen it with genuine progress only: mark a finished item completed, update_goal blocked, or ask the Owner '
        + '— never mark work complete just to unblock.',
});

/** 渲染一条模型面文案：单次替换全部占位符。 */
export function render(template, values) {
    return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}
